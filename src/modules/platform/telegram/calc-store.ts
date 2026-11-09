import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { Context, MiddlewareFn, Transformer } from 'grammy';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { logger } from '../logger';
import type { AmendBase } from '../../wms/calc/amend-types';
import type { CalcSection } from '../../wms/calc/intake';
import type { IntakeState } from './calc-intake';
import { foldPendingInvoice } from './file-goods';
import { bootedAtSec, currentUpdateId, isBacklog, lastDoneUpdateId } from './lifecycle';
import { quietHour, sendText, type SendResult } from './send';

/**
 * The «Hisoblatish» collections, as the bot holds them — MOVED out of
 * calc-intake.ts (docs/SAKKIZ-R3.md K3), which re-exports the four calls every
 * importer used — and made to outlive the process (P1, his 1.8 c: «tugallanmagan
 * hisoblatish 24 soat kutsin»).
 *
 * MEMORY STAYS THE READER, the 0130 idiom (`waits.ts`): every read on the
 * ladder stays synchronous, and one process polls, so memory is authoritative
 * while it lives; the table `telegram_calc_intakes` only has to outlive it. A
 * collection is the whole state — material, answers, files' ids, up to
 * megabytes — so where a wait appends a write per change, a collection's write
 * is DEBOUNCED per chat (performance-2): after a second of quiet, at most five
 * seconds after the first unwritten change, and before grammy confirms the
 * batch that made it (`flushBeforeConfirm`, the lead's ruling L1). The write
 * takes whatever memory holds at that moment — an UPSERT, or a DELETE when the
 * chat has none.
 *
 * Two clocks, both from the seller's last action (`touchedAt`): the collection
 * WAITS 24 hours, but HOLDS the chat for only 30 minutes. A parked collection
 * takes no free text, file or contact, so lookups, notes, tasks and the
 * assistant work again; its own buttons, a reply to one of its messages and
 * «▶️ Davom etamiz» bring it back (regression-1).
 */

/** How long a collection lives without the seller (his 1.8 c). */
export const INTAKE_TTL_MS = 24 * 3_600_000;
/** How long without his action the collection still HOLDS the chat — the old TTL. */
export const HOLD_MS = 30 * 60_000;
/** When the sweep reminds a quiet collection «davom etamizmi?». */
export const REMIND_AFTER_MS = 2 * 3_600_000;
/** A collection's write waits this long for quiet… */
export const INTAKE_WRITE_QUIET_MS = 1_000;
/** …and never longer than this after its first unwritten change. */
export const INTAKE_WRITE_MAX_MS = 5_000;
/** How long grammy's next `getUpdates` waits for the store before it confirms a batch (L1). */
export const INTAKE_CONFIRM_FLUSH_MS = 2_000;
/** How long a job's read waits for this process's hydrate (durability-9). */
export const INTAKE_HYDRATE_WAIT_MS = 10_000;
/** A state this large is said in the log; it is written anyway (§17 measures the worst case). */
const LARGE_STATE_BYTES = 2 * 1024 * 1024;
/** `ownMessageIds` keeps the newest this many. */
const OWN_KEPT = 40;
/**
 * The first minutes after boot, while the backlog is still being applied:
 * the sweep ends nothing (calc-intake-sweep.ts), and a read with no moment of
 * its own ends nothing either — an answer written before the 24 hours ran out
 * may still be on its way (durability-12 c).
 */
export const BOOT_GRACE_MS = 2 * 60_000;
/** How many sweep ticks a goodbye whose send may yet succeed is tried again. */
export const UNSAID_TRIES = 12;
/**
 * Postgres refusing the ROW itself, not the moment: a malformed value (22P02,
 * 22P05), a CHECK (23514), a UNIQUE (23505). The same statement is refused
 * every time, so it is never retried.
 */
const REFUSED_FOR_GOOD = new Set(['22P02', '22P05', '23514', '23505']);

/**
 * A job asked for the store before this process restored it (durability-9) —
 * thrown so pg-boss re-delivers instead of completing on an empty memory.
 */
export class IntakesNotReady extends Error {
  constructor() {
    super('calc intakes not hydrated');
    this.name = 'IntakesNotReady';
  }
}

/** One chat's unwritten change, and the write that carries it. */
interface Pending {
  timer: ReturnType<typeof setTimeout> | null;
  /** When the first change since the last write was made — the 5 s ceiling counts from it. */
  firstAt: number | null;
  dirty: boolean;
  /** The lowest update whose change is not yet in a write (none for a job's change). */
  from: number | null;
  /** The write in flight, and the lowest update it carries. */
  inFlight: Promise<boolean> | null;
  writingFrom: number | null;
}

interface IntakeStore {
  collections: Map<string, IntakeState>;
  pending: Map<string, Pending>;
  durable: boolean;
  sealed: boolean;
  hydrated: boolean;
  waiters: (() => void)[];
  writeCount: number;
  /** Chats whose failed write was logged — once per chat, so one bad chat never hides another. */
  warnedChats: Set<string>;
  confirmWarned: boolean;
  /**
   * Every update below this was confirmed by a `getUpdates` grammy sent
   * through `flushBeforeConfirm` — a change of one of them, still unwritten,
   * can no longer be held back by the stop (P1 review ADV-1).
   */
  confirmedBelow: number;
  /** Goodbyes whose send may yet succeed — the sweep's next ticks try them (`retryUnsaid`). */
  unsaid: Unsaid[];
  ready: boolean;
  /** Tests: a stand-in for the readiness probe, and a hook run before each statement. */
  probe: (() => Promise<boolean>) | null;
  hook: ((chatId: string) => Promise<void>) | null;
}

/**
 * On `globalThis`, like `globalForBoss` / `globalForBot`: the pg-boss jobs and
 * the poller in the app process must read ONE map whatever chunk imports this
 * module, and the timers and the seal must be the same ones the stop flushes.
 */
const globalForIntakes = globalThis as unknown as { calcIntakes?: IntakeStore };
const store: IntakeStore = (globalForIntakes.calcIntakes ??= {
  collections: new Map(),
  pending: new Map(),
  durable: false,
  sealed: false,
  hydrated: false,
  waiters: [],
  writeCount: 0,
  warnedChats: new Set(),
  confirmWarned: false,
  confirmedBelow: 0,
  unsaid: [],
  ready: false,
  probe: null,
  hook: null,
});

const key = (chatId: bigint | number | string) => String(chatId);

/**
 * Does 0139's table exist? (#472.) Code ahead of the migration is today's
 * memory-only store: no write, no throw. Caches TRUE only, so the store comes
 * back the moment the migration lands (`redelivery-ready.ts`'s shape).
 */
export async function intakeTableReady(): Promise<boolean> {
  if (store.probe) return store.probe();
  if (store.ready) return true;
  try {
    const rows = await db.execute<{ ok: boolean }>(sql`
      SELECT to_regclass('public.telegram_calc_intakes') IS NOT NULL AS ok`);
    store.ready = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[calc-intake] durable table not checked');
    return false;
  }
  return store.ready;
}

// ---------------------------------------------------------------------------
// The update a collector change belongs to.
// ---------------------------------------------------------------------------

/**
 * The incoming MESSAGE an update carries, while its handlers run — what
 * «every 'take' writes `takenUpTo` in the same patch as its effect» (§6.2.8)
 * needs, and the chat a sent message was sent into. Carried through every
 * await of the handler, like the lifecycle's update id.
 */
const messageScope = new AsyncLocalStorage<{ chat: string; messageId: number | null }>();

/**
 * One middleware, right after the lifecycle guard (bot.ts):
 *  - the handlers run inside the scope above, so a non-quiet `updateIntake`
 *    made while handling a message advances `takenUpTo` to that message IN
 *    THE SAME PATCH as the effect — the row carries both or neither, so a
 *    write lost in a crash is redone and a write that landed is never
 *    applied twice (durability-1, regression-6). A press has no incoming
 *    message and advances nothing.
 *  - every message the bot sends into this chat with a collector button
 *    (`c:` callback data) while a collection lives joins its own messages
 *    (§6.2.9) — the prompt, the summary or table, an offer, an invoice
 *    question, an echo — through the update's own api, so the press gate
 *    (`ownsPress`) knows every message the collection drew, whichever file
 *    drew it. A send outside grammy (the sweep's reminder, a job's
 *    delivery) notes its own id.
 */
export function collectorScope(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chat = ctx.chat?.id;
    if (chat === undefined) return next();
    ctx.api.config.use(ownMessageRecorder(BigInt(chat)));
    await messageScope.run({ chat: key(chat), messageId: ctx.message?.message_id ?? null }, next);
  };
}

/**
 * Run `fn` as no message's effect: a non-quiet patch inside it is still the
 * seller's action (the clocks slide) but takes nothing (`takenUpTo`). For a
 * door that OPENS a collection for a message whose answer it applies only
 * afterwards — the add door's reply or file (review dur-1): the opening's own
 * writes (the table's stage, its standing) took the reply before its answer
 * was written, so a flush in the table's send, a restart and the redelivered
 * reply was 'seen' and dropped in silence. Outside a message: just `fn`.
 */
export function notTaking<T>(fn: () => Promise<T>): Promise<T> {
  const scope = messageScope.getStore();
  return scope ? messageScope.run({ chat: scope.chat, messageId: null }, fn) : fn();
}

function hasCollectorButton(markup: unknown): boolean {
  const rows = (markup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) =>
      Array.isArray(row) &&
      row.some((b) => typeof (b as { callback_data?: unknown })?.callback_data === 'string' &&
        (b as { callback_data: string }).callback_data.startsWith('c:')),
  );
}

function ownMessageRecorder(chatId: bigint): Transformer {
  return async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method !== 'sendMessage' || !res.ok) return res;
    const body = payload as { chat_id?: unknown; reply_markup?: unknown };
    if (String(body.chat_id) !== key(chatId) || !hasCollectorButton(body.reply_markup)) return res;
    const sent = (res as { result?: { message_id?: unknown } }).result?.message_id;
    if (typeof sent === 'number' && store.collections.has(key(chatId))) noteOwnMessage(chatId, sent);
    return res;
  };
}

// ---------------------------------------------------------------------------
// The collections.
// ---------------------------------------------------------------------------

export function startIntake(
  chatId: bigint,
  section: CalcSection,
  opts: { ai?: boolean; staffId: string; amend?: AmendBase | null; openedBy?: number | null },
): IntakeState {
  const now = Date.now();
  const state: IntakeState = {
    section,
    stage: 'client',
    noteId: uuidv4(),
    staffId: opts.staffId,
    openedAt: now,
    touchedAt: now,
    remindedAt: null,
    takenUpTo: 0,
    openedBy: opts.openedBy ?? null,
    ownMessageIds: [],
    amend: opts.amend ?? null,
    seed: null,
    seededFrom: null,
    doorHint: null,
    askedSeqs: null,
    conflicts: [],
    saving: null,
    standingAtOpen: null,
    offersMessageId: null,
    repliedTaken: [],
    tableMessageId: null,
    tableHash: null,
    analysingAt: null,
    analysingJob: null,
    readingSaidDead: false,
    pendingReply: null,
    echoes: [],
    clientHintRaw: '',
    material: [],
    fileCount: 0,
    facts: {},
    steps: [],
    notes: [],
    fileNotes: [],
    aiUsed: false,
    images: [],
    imagesSkipped: 0,
    promptMessageId: null,
    ai: opts.ai ?? false,
    hasCertificate: true,
    route: null,
    totalsAnswer: { weightKg: null, volumeM3: null, at: { material: 0, files: 0 } },
    fileTotals: null,
    routeAnswer: null,
    lineAnswers: [],
    offers: [],
    ambiguousTotals: [],
    invoiceGoods: [],
    pdfs: [],
    sheetTexts: [],
    invoiceTexts: [],
    pendingInvoice: null,
    aiGoods: null,
    goodsFiles: [],
    clientAskedWith: null,
    usages: [],
    aiFailure: null,
    analysing: null,
    answers: [],
    reaskedGroup: null,
    expires: now + INTAKE_TTL_MS,
  };
  store.collections.set(key(chatId), state);
  markDirty(key(chatId));
  return state;
}

/** Has the collection run out at `atMs` — 24 hours since the seller's last action. */
function expiredAt(state: IntakeState, atMs: number): boolean {
  return state.touchedAt + INTAKE_TTL_MS <= atMs;
}

/**
 * The moment a collector question is asked FOR: a backlog message's WRITTEN
 * date, else now — the 0130 rule that judges a wait by the message's date,
 * so an answer written at 23 h 50 m and processed at 24 h 10 m still belongs
 * to its collection (durability-12 c). The ladder passes it to `activeIntake`.
 */
export function intakeMomentOf(messageDateSec: number): number {
  return isBacklog(messageDateSec) ? messageDateSec * 1000 : Date.now();
}

/** Is this process still inside the boot's grace — the backlog possibly not yet applied? */
function inBootGrace(): boolean {
  const boot = bootedAtSec();
  return boot > 0 && Date.now() - boot * 1000 < BOOT_GRACE_MS;
}

/**
 * The live collection for a chat, or nothing — expiry is checked on read.
 *
 * `atMs`: the moment the question is asked FOR (`intakeMomentOf`). An entry
 * found expired is handed to `expireIntake`, the one end path the sweep
 * shares, which says «⌛ … o‘chirildi» once (durability-12 a).
 *
 * A read with no moment of its own (a door, a press, the backlog's presence
 * question) in the boot's grace answers «none» and leaves the end to the
 * sweep: the backlog is still being applied, and a later message of it
 * written before the 24 hours ran out still belongs to the collection — an
 * end said at NOW would have taken it away first. A message's own moment
 * ends it at once: Telegram hands the backlog over in order, so nothing
 * written earlier is still to come.
 */
export function activeIntake(chatId: bigint, atMs?: number): IntakeState | null {
  const state = store.collections.get(key(chatId));
  if (!state) return null;
  if (expiredAt(state, atMs ?? Date.now())) {
    if (atMs !== undefined || !inBootGrace()) expireIntake(chatId, state);
    return null;
  }
  return state;
}

/**
 * Is the collection empty — nothing the SELLER sent, no customer he named?
 * Such a one is neither reminded nor said goodbye to, and a door that would
 * replace it asks nothing: there is nothing to lose.
 *
 * Judged by what he did (review PF-9): an add collection opened by ➕ carries
 * its card's label in `clientHintRaw` (`doorHint`), which is no reason to
 * remind him at 2 h and say «⌛ … o‘chirildi» at 24 h about a press he made
 * and left. His row answers, conflict choices and totals answers are content
 * — the ones a button writes reach no `answers` line. So is a certificate
 * answer that differs from the one the collection opened with (a seeded
 * collection's «📄 Sertifikat», fix review FR-10): it changes the duty.
 */
export function intakeIsEmpty(state: IntakeState): boolean {
  const hint = state.clientHintRaw.trim();
  return (
    (state.certificateAtOpen == null || state.hasCertificate === state.certificateAtOpen) &&
    state.material.length === 0 &&
    state.fileCount === 0 &&
    state.answers.length === 0 &&
    state.lineAnswers.length === 0 &&
    state.conflicts.every((c) => c.choice === null) &&
    state.totalsAnswer.weightKg === null &&
    state.totalsAnswer.volumeM3 === null &&
    (hint === '' || hint === (state.doorHint ?? '').trim())
  );
}

/**
 * Nothing new was collected since what the table shows: since the last
 * reading (`readMark`, docs/IKKI-ESHIK.md §1.4 — «➕ Yana ma’lumot» and
 * nothing sent leaves the read table standing on every collection, review
 * PC-ADV-6), or, before any reading, on a collection that carries rows of its
 * own — an add collection's stored rows, a seeded one's returned rows (review
 * PF-8): its table is what there is to read. One home for «Bo‘ldi» (back to
 * the table, calc-read `pressAnalyse`), the save guard, the echo (fix review
 * W-11: after «➕ Yana ma’lumot» and nothing sent, the save said «Yangi
 * ma’lumot hali o‘qilmagan» about nothing) and the table's «⬇️» marker.
 */
export function nothingNewToRead(
  state: Pick<IntakeState, 'amend' | 'seed' | 'material' | 'fileCount' | 'readMark'>,
): boolean {
  const mark = state.readMark ?? null;
  if (mark) return state.material.length <= mark.material && state.fileCount <= mark.files;
  return (state.amend !== null || state.seed !== null) && state.material.length === 0 && state.fileCount === 0;
}

/**
 * End an expired collection — the ONE end path, shared by a read that finds
 * it expired and the sweep. The entry goes first (memory, then the row), so
 * the sweep and a read can never both say it; then, unless the collection was
 * empty, «⌛ … o‘chirildi» is sent by chat id, off the ladder. Only the
 * collection it was handed: a newer one in the same chat is not this one's to
 * end.
 */
export function expireIntake(chatId: bigint, state: IntakeState): void {
  const live = store.collections.get(key(chatId));
  if (!live || live.noteId !== state.noteId) return;
  store.collections.delete(key(chatId));
  markDirty(key(chatId));
  if (intakeIsEmpty(live)) return;
  void sayEnded(chatId, live).catch((err: unknown) => logger.warn({ err }, '[calc-intake] end line not sent'));
}

/**
 * The row's DELETE is written BEFORE the line: a process killed between the
 * two would otherwise hydrate the row again on its next boot and say the end
 * a second time. A flush that fails still sends — memory has already let the
 * collection go, and a line never said is worse than one said twice.
 */
async function sayEnded(chatId: bigint, state: IntakeState): Promise<void> {
  const { SECTION_LABEL } = await import('../../wms/calc/intake');
  const { intakeClientSummary } = await import('./calc-intake');
  const text = intakeEndedText(state, SECTION_LABEL, intakeClientSummary(state.clientHintRaw));
  await flushIntakeWrites(chatId);
  await sayOrRetry({ chatId, text });
}

interface Unsaid {
  chatId: bigint;
  text: string;
  replyMarkup?: unknown;
  tries: number;
}

/**
 * Say a message nothing else remembers — the ⌛ end line, a resumed landing's
 * ✅ — its collection gone or about to go. A failure that may pass (a 429,
 * the token down, no answer) keeps it for the sweep's next ticks
 * (`retryUnsaid`, at most UNSAID_TRIES); a refusal for good (400/403: the bot
 * blocked, no such chat) is logged and dropped. `silent` is the hour of the
 * attempt, the bot's one night.
 */
export async function sayOrRetry(msg: { chatId: bigint; text: string; replyMarkup?: unknown }): Promise<SendResult> {
  const sent = await sendText({ ...msg, silent: quietHour() });
  if (!sent.ok) {
    if (!sent.permanent) store.unsaid.push({ ...msg, tries: 1 });
    logger.warn({ chatId: String(msg.chatId), status: sent.status, kept: !sent.permanent }, '[calc-intake] goodbye not sent');
  }
  return sent;
}

/** One sweep tick's second try of every goodbye still unsaid; answers how many went out. */
export async function retryUnsaid(): Promise<number> {
  const due = store.unsaid.splice(0);
  let said = 0;
  for (const msg of due) {
    const sent = await sendText({ chatId: msg.chatId, text: msg.text, replyMarkup: msg.replyMarkup, silent: quietHour() });
    if (sent.ok) said += 1;
    else if (!sent.permanent && msg.tries + 1 < UNSAID_TRIES) store.unsaid.push({ ...msg, tries: msg.tries + 1 });
    else logger.warn({ chatId: String(msg.chatId), status: sent.status }, '[calc-intake] goodbye given up');
  }
  return said;
}

/**
 * The refusal's pointer to «➕» (docs/IKKI-ESHIK.md §2.5): the AI door's words
 * name its AI answer, which carries a «➕» and takes a reply; the plain door
 * gets no AI answer, so its words name only the ✅'s own «➕». A NULL door
 * (a request from before the doors) keeps the AI door's — today's — words.
 */
export function addPointerWords(door: 'plain' | 'ai' | null): string {
  return door === 'plain'
    ? 'Qo‘shimcha bo‘lsa — «✅ Saqlandi» xabari ostidagi «➕ Shu so‘rovga qo‘shish» ni bosing. Yangi hisob — «🧮 Hisoblatish».'
    : 'Qo‘shimcha bo‘lsa — ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni bosing, yoki AI javobiga reply qilib yozing. Yangi hisob — «🧮 Hisoblatish».';
}

/**
 * §2.7's goodbye, pure. `client` = `intakeClientSummary(clientHintRaw)`. An
 * add collection's points at «➕» by its request's door (docs/IKKI-ESHIK.md
 * §2.5): a plain request has no AI answer to press it under.
 */
export function intakeEndedText(
  state: Pick<IntakeState, 'section' | 'amend' | 'ai' | 'seed'>,
  sections: Record<CalcSection, string>,
  client: string | null,
): string {
  if (state.amend) {
    return (
      `⌛ Qo‘shimcha 24 soat ichida yuborilmadi va o‘chirildi: ➕ ${state.amend.cardLabel}. ` +
      (state.amend.door === 'plain'
        ? addPointerWords('plain')
        : 'Kerak bo‘lsa ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni qayta bosing.')
    );
  }
  // A first collection is restarted from the door it came in by: the two
  // doors are distinct now (review PC-SPEC-10).
  const door = state.ai && state.seed === null ? '«🤖 AI rastamojka»' : '«🧮 Hisoblatish»';
  return (
    `⌛ Hisoblatish 24 soat ichida tugatilmadi va o‘chirildi: ${sections[state.section]} · ${client ?? 'mijoz hali yozilmagan'}. ` +
    `Kerak bo‘lsa ${door} dan qaytadan boshlang.`
  );
}

/** Pure: does the collection hold the chat at `atMs` (not parked)? */
export function intakeHolds(state: IntakeState, atMs: number): boolean {
  return atMs - state.touchedAt < HOLD_MS;
}

/**
 * The live collection when it HOLDS the chat now, else null. Asked by every
 * door that refuses beside a collection (task draft, zametka «Yangi», 💬, a
 * shared contact) and by the orphan guard: a parked collection refuses none
 * of them.
 */
export function holdingIntake(chatId: bigint): IntakeState | null {
  const state = activeIntake(chatId);
  return state && intakeHolds(state, Date.now()) ? state : null;
}

/**
 * `quiet`: a bookkeeping write (a message id, the job's settle, the
 * reminder's mark) — it does not slide the clocks and does not clear the
 * reminder. Every other patch is the seller's action: `touchedAt` slides (so
 * a parked collection holds again) and `remindedAt` clears (so the next idle
 * stretch is reminded once more). A patch made while a message is being
 * handled takes that message (`takenUpTo`) in the same patch.
 *
 * Memory as it stands, never an expiry judgement: whoever holds the
 * collection asked `activeIntake` at the moment that counts (a backlog
 * message's own date), and a collection is ended only through
 * `expireIntake` or `endIntake`.
 */
export function updateIntake(
  chatId: bigint,
  patch: Partial<IntakeState>,
  opts: { quiet?: boolean } = {},
): IntakeState | null {
  const state = store.collections.get(key(chatId));
  if (!state) return null;
  let next: IntakeState = { ...state, ...patch };
  if (!opts.quiet) {
    const now = Date.now();
    next = { ...next, touchedAt: now, remindedAt: null };
    const scope = messageScope.getStore();
    if (scope && scope.chat === key(chatId) && scope.messageId !== null) {
      next = { ...next, takenUpTo: Math.max(next.takenUpTo, scope.messageId) };
    }
  }
  next.expires = next.touchedAt + INTAKE_TTL_MS;
  store.collections.set(key(chatId), next);
  markDirty(key(chatId));
  return next;
}

export function endIntake(chatId: bigint): void {
  if (!store.collections.delete(key(chatId))) return;
  markDirty(key(chatId));
}

/**
 * The job's read: waits for this process's hydrate, then MEMORY only — never
 * the table, which after hydration could resurrect a collection whose DELETE
 * is still pending or failed, and the next write would UPSERT it back
 * (performance-7). Not hydrated in time, or no bot in this process →
 * `IntakesNotReady`, so pg-boss re-delivers instead of completing on an empty
 * memory (durability-9).
 */
export async function loadIntake(chatId: bigint): Promise<IntakeState | null> {
  if (!(await intakesHydrated(INTAKE_HYDRATE_WAIT_MS))) throw new IntakesNotReady();
  return activeIntake(chatId);
}

/** Does this process run the bot at all — the two exits `startTelegramBot` takes before it hydrates. */
function botRunsHere(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN) && process.env.TELEGRAM_POLLING !== '0';
}

/**
 * Resolves true once this process's `hydrateIntakes()` has finished; false
 * at `timeoutMs`, or at once when this process runs no bot (no token,
 * `TELEGRAM_POLLING=0`) — nothing here will ever hydrate. pg-boss starts its
 * workers before the bot hydrates (instrumentation-node.ts), which is the
 * window a job waits through.
 */
export function intakesHydrated(timeoutMs: number): Promise<boolean> {
  if (store.hydrated) return Promise.resolve(true);
  if (!botRunsHere()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    store.waiters.push(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The hydrate is over — called by bot.ts whether it succeeded or failed, since
 * after a failed one memory is the only truth this process has.
 */
export function markIntakesHydrated(): void {
  store.hydrated = true;
  for (const wake of store.waiters.splice(0)) wake();
}

/**
 * Memory as it stands, no expiry judged — the sweep re-reading a chat after
 * its awaits, to act on what is there NOW and never on its snapshot.
 */
export function peekIntake(chatId: bigint): IntakeState | null {
  return store.collections.get(key(chatId)) ?? null;
}

/**
 * Every collection in memory, for the sweep — the expired ones included: the
 * sweep is what ends them with their line (rule 13).
 */
export function liveIntakes(): ReadonlyArray<readonly [bigint, IntakeState]> {
  return [...store.collections].map(([chat, state]) => [BigInt(chat), state] as const);
}

/**
 * A live collection that was opened before this process booted — restored by
 * the hydrate, so what the person typed into the outage has somewhere to go
 * (backlog.ts's sentence loses «Hisoblatish» for that chat alone). One opened
 * by a late press after boot is not a survivor.
 *
 * `atMs`: the backlog message's own moment (`intakeMomentOf`) — alive when it
 * was WRITTEN is what decides, never alive now (durability-12 c).
 */
export function collectionSurvived(chatId: bigint | number, atMs?: number): boolean {
  const state = activeIntake(BigInt(chatId), atMs);
  return state !== null && state.openedAt < bootedAtSec() * 1000;
}

export interface IntakeMessage {
  /** Seconds, Telegram's. */
  date: number;
  messageId: number;
  /** The bot message this one replies to, when it is a reply to the bot. */
  replyTo: number | null;
}

/**
 * Does this message belong to the collection, and was it applied already?
 * Pure; the ONE verdict the text, file and voice doors share (§6.2.8):
 *  1. at or below `takenUpTo` → 'seen': applied before a crash, or by the old
 *     process before its flush — dropped in silence;
 *  1b. the message that OPENED it (`openedBy`) → 'take' (fix review fdur-2):
 *     a crash between the open and its effect redelivers it as backlog, dated
 *     in the second before `openedAt` whenever the open crossed a second —
 *     rule 2 called it written before the collection and the file was lost
 *     under the «kept» sentence. A press-opened collection's `openedBy` is a
 *     bot message, which no incoming message carries;
 *  2. a backlog message written before the collection opened → 'pass': it
 *     cannot have been written for it (a collection a late press opened takes
 *     no backlog, I20b);
 *  3. a reply to one of its own messages → 'take', parked or not;
 *  4. parked at the message's own date → 'pass' (a backlog message is judged
 *     by when it was WRITTEN: a collection holding then takes it);
 *  5. else 'take'.
 */
export function intakeTakes(state: IntakeState, msg: IntakeMessage): 'take' | 'seen' | 'pass' {
  if (msg.messageId <= state.takenUpTo) return 'seen';
  if (state.openedBy !== null && msg.messageId === state.openedBy) return 'take';
  if (isBacklog(msg.date) && msg.date < Math.floor(state.openedAt / 1000)) return 'pass';
  if (msg.replyTo !== null && state.ownMessageIds.includes(msg.replyTo)) return 'take';
  if (!intakeHolds(state, msg.date * 1000)) return 'pass';
  return 'take';
}

/**
 * Pure: is the pressed message one of this collection's own — the one that
 * opened it, one of the three it keeps live for its whole life (the table,
 * the prompt, the offers, edited in place), or one it drew since
 * (`ownMessageIds`)? A press from an older collection's message, a
 * crash-redelivered «✖️ Bekor qilish» included, changes nothing
 * (durability-2). The three are asked by name because `ownMessageIds` keeps
 * only the newest forty: on a long invoice the echoes the table draws would
 * push the table itself out, and its «✅ Tasdiqlash» would read «eskirgan».
 *
 * A press that names no message cannot be judged and acts on what is live,
 * as before: Telegram always sends the message a bot's inline button sat on,
 * so only a test's stand-in ctx reaches that branch.
 */
export function ownsPress(state: IntakeState, pressedMessageId: number | null): boolean {
  if (pressedMessageId === null) return true;
  return (
    pressedMessageId === state.openedBy ||
    pressedMessageId === state.tableMessageId ||
    pressedMessageId === state.promptMessageId ||
    pressedMessageId === state.offersMessageId ||
    state.ownMessageIds.includes(pressedMessageId)
  );
}

/** Join a message this collection sent to its own (`ownMessageIds`, last 40), quietly. */
export function noteOwnMessage(chatId: bigint, messageId: number): void {
  // Memory as it stands: a bookkeeping note is never the moment that ends a collection.
  const state = store.collections.get(key(chatId));
  if (!state) return;
  if (state.ownMessageIds.includes(messageId)) return;
  const own = [...state.ownMessageIds, messageId].slice(-OWN_KEPT);
  updateIntake(chatId, { ownMessageIds: own }, { quiet: true });
}

// ---------------------------------------------------------------------------
// The durable row.
// ---------------------------------------------------------------------------

/** Production only (startTelegramBot, beside `setDurableWaits`); a test file opts in. Off = memory only. */
export function setDurableIntakes(on: boolean): void {
  store.durable = on;
}

/** Whether the durable store is switched on in this process. */
export function durableIntakes(): boolean {
  return store.durable;
}

function pendingOf(k: string): Pending {
  let p = store.pending.get(k);
  if (!p) {
    p = { timer: null, firstAt: null, dirty: false, from: null, inFlight: null, writingFrom: null };
    store.pending.set(k, p);
  }
  return p;
}

const minOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

function arm(k: string, p: Pending, delayMs: number): void {
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    p.timer = null;
    void writeChat(k);
  }, Math.max(0, delayMs));
  p.timer.unref?.();
}

/**
 * The chat changed: write it after a second of quiet, at the latest five
 * seconds after its first unwritten change (performance-2 — one full-state
 * UPSERT per message was a write per forwarded photo). After the seal the
 * change is still recorded; `writeChat` is the one place that refuses to
 * write it.
 */
function markDirty(k: string): void {
  if (!store.durable) return;
  const p = pendingOf(k);
  p.dirty = true;
  // Only an update still being handled can be held back: a `void`
  // continuation that outlived its update (the reading started by a press)
  // runs under that update's id long after grammy confirmed it, and naming
  // it would make the stop hold back a whole batch already handled (P1 review ADV-1).
  // Such a change is a job's — it names no update.
  const update = currentUpdateId();
  if (update !== null && update > lastDoneUpdateId()) p.from = minOf(p.from, update);
  const now = Date.now();
  p.firstAt ??= now;
  arm(k, p, Math.min(INTAKE_WRITE_QUIET_MS, p.firstAt + INTAKE_WRITE_MAX_MS - now));
}

/**
 * Write one chat now (its timer cancelled), after the write already in
 * flight — one statement per chat at a time, in order. True = what memory
 * held is in the row; false = sealed, or the write failed (the chat stays
 * dirty and its timer retries).
 */
async function writeChat(k: string): Promise<boolean> {
  const p = store.pending.get(k);
  if (!p) return true;
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  for (;;) {
    if (p.inFlight) {
      // Another caller's write. Its answer is this caller's only when nothing
      // newer is pending: the caller that started it may already have begun
      // the NEXT write (for a change this caller saw) the moment it settled —
      // `dirty` is false again then, and answering here would say «written»
      // about a row that does not hold that change yet.
      const awaited = p.inFlight;
      const ok = await awaited;
      if (!ok) return false;
      if (!p.dirty && (p.inFlight === null || p.inFlight === awaited)) return true;
      continue;
    }
    if (!p.dirty) return true;
    if (store.sealed) return false;
    p.dirty = false;
    p.firstAt = null;
    p.writingFrom = p.from;
    p.from = null;
    const run = writeRow(k).then(
      () => {
        p.writingFrom = null;
        if (!p.dirty && !p.timer && store.pending.get(k) === p) store.pending.delete(k);
        return true;
      },
      (err: unknown) => {
        const code = pgCodeOf(err);
        if (code !== null && REFUSED_FOR_GOOD.has(code)) {
          // The table refuses the ROW, and would refuse it at every retry —
          // re-sent every five seconds and before every getUpdates for a day.
          // Let it go: memory stays the reader, the update holds nothing
          // back, and the next change of this chat is tried afresh.
          p.writingFrom = null;
          if (!p.dirty && !p.timer && store.pending.get(k) === p) store.pending.delete(k);
          if (!store.warnedChats.has(`refused:${k}`)) {
            logger.warn({ err, chatId: k, code }, '[calc-intake] collection refused by the table — not retried');
          }
          store.warnedChats.add(`refused:${k}`);
          return false;
        }
        // Kept DIRTY and retried by the next timer, never dropped
        // (durability-10): «log once and forget» lost a seller's change at the
        // next deploy with its update already confirmed. One line per chat.
        p.dirty = true;
        p.from = minOf(p.from, p.writingFrom);
        p.writingFrom = null;
        p.firstAt ??= Date.now();
        if (!store.sealed) arm(k, p, INTAKE_WRITE_MAX_MS);
        if (!store.warnedChats.has(k)) logger.warn({ err, chatId: k }, '[calc-intake] collection not written to the table');
        store.warnedChats.add(k);
        return false;
      },
    );
    p.inFlight = run;
    const ok = await run;
    if (p.inFlight === run) p.inFlight = null;
    // A failure is the timer's to retry, never this loop's.
    if (!ok || !p.dirty) return ok;
  }
}

/** Postgres's SQLSTATE of a failed statement — drizzle may wrap the driver's error (db/errors.ts's idiom). */
function pgCodeOf(err: unknown): string | null {
  const pg = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = pg?.code ?? pg?.cause?.code;
  return typeof code === 'string' ? code : null;
}

/** A NUL, or half of a surrogate pair: what `jsonb` refuses in a string (22P02). */
const UNSTORABLE = /\\u0000|\\ud[89a-f][0-9a-f]{2}/i;

/**
 * The state as jsonb will take it. A sheet's text is cut at 300 characters
 * (goods-file.ts), which can halve an emoji, and a UTF-16 file read without
 * its BOM carries NULs; `JSON.stringify` writes both as escapes the jsonb
 * input refuses, and one such string would keep the whole collection out of
 * the table. Only then is the state written again with each string mended —
 * the NUL dropped, a lone half replaced — so the stored text is the same
 * words. Paired surrogates are written as characters, never as escapes, so
 * the test finds only what needs mending (or a literal backslash text, which
 * merely takes the slower path).
 */
function storableJson(state: Partial<IntakeState>): string {
  const json = JSON.stringify(state);
  if (!UNSTORABLE.test(json)) return json;
  return JSON.stringify(state, (_key, value: unknown) =>
    typeof value === 'string' ? value.replace(/\u0000/g, '').toWellFormed() : value,
  );
}

/** The row for whatever memory holds NOW — an UPSERT, or a DELETE when the chat has none. */
async function writeRow(k: string): Promise<void> {
  if (!(await intakeTableReady())) return;
  if (store.hook) await store.hook(k);
  const state = store.collections.get(k);
  store.writeCount += 1;
  if (!state) {
    await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id = ${k}::bigint`);
    return;
  }
  // `expires` is derived (touchedAt + 24 h), never stored.
  const rest: Partial<IntakeState> = { ...state };
  delete rest.expires;
  const json = storableJson(rest);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > LARGE_STATE_BYTES) {
    logger.warn({ chatId: k, bytes }, '[calc-intake] large collection');
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  await db.execute(sql`
    INSERT INTO telegram_calc_intakes (chat_id, staff_id, note_id, state, opened_at, touched_at, expires_at)
    VALUES (${k}::bigint, ${state.staffId}::uuid, ${state.noteId}::uuid, ${json}::jsonb,
            ${iso(state.openedAt)}::timestamptz, ${iso(state.touchedAt)}::timestamptz,
            ${iso(state.touchedAt + INTAKE_TTL_MS)}::timestamptz)
    ON CONFLICT (chat_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, note_id = EXCLUDED.note_id,
      state = EXCLUDED.state, opened_at = EXCLUDED.opened_at, touched_at = EXCLUDED.touched_at,
      expires_at = EXCLUDED.expires_at`);
}

/**
 * Write what is dirty now: with `chatId`, THAT chat's pending write only, and
 * the answer speaks for that chat alone (performance-10: a press never waits
 * on another chat's megabytes, and one chat's refused row never fails another
 * chat's reading); without it, every chat (the stop, grammy's confirm, tests).
 * False = the store is sealed or a write failed.
 */
export async function flushIntakeWrites(chatId?: bigint): Promise<boolean> {
  if (!store.durable) return true;
  if (store.sealed) return false;
  if (chatId !== undefined) return writeChat(key(chatId));
  const results = await Promise.all([...store.pending.keys()].map((k) => writeChat(k)));
  return results.every(Boolean);
}

/** The lowest update naming an unwritten change, among those `confirmed` (below the offset grammy sent) or not. */
function unwrittenUpdate(confirmed: boolean): number | null {
  let oldest: number | null = null;
  const take = (n: number | null) => {
    if (n !== null && (n < store.confirmedBelow) === confirmed) oldest = minOf(oldest, n);
  };
  for (const p of store.pending.values()) {
    if (p.dirty) take(p.from);
    take(p.writingFrom);
  }
  return oldest;
}

/**
 * The lowest update id whose collection change is not yet written, or null.
 * The stop asks it after the flush and, while that update's batch is still
 * being handled, confirms only through the update before it (durability-10);
 * an update of an ended batch is already confirmed and is logged lost (K15).
 *
 * Never one grammy has ALREADY confirmed through `flushBeforeConfirm` (a
 * write that failed or outran the bound before the next `getUpdates`): the
 * stop's own confirm cannot take it back, and holding back «the update before
 * it» would only hand the next process a whole batch handled here — every
 * reply and forward of it a second time. Such a change is lost and is said so
 * when the store is sealed.
 */
export function oldestUnwrittenUpdate(): number | null {
  return unwrittenUpdate(false);
}

/**
 * After the stop's flush: this process writes no more rows (durability-1). An
 * update still running here past the stop's budget is unconfirmed and goes to
 * the new process; its late effect must never overwrite the row that process
 * hydrated. A change whose update Telegram had already confirmed is lost here
 * — the next process could not have hydrated it either — and is logged.
 */
export function sealIntakeWrites(): void {
  if (!store.sealed) {
    const lost = unwrittenUpdate(true);
    if (lost !== null) {
      logger.warn({ update: lost }, '[calc-intake] a change whose update Telegram already confirmed was never written — lost');
    }
  }
  store.sealed = true;
  for (const p of store.pending.values()) {
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
  }
}

/**
 * The lead's ruling L1 (§6.2.2): grammy confirms a batch with the
 * `getUpdates` that follows it, at once — so a change left to the 1 s timer
 * would belong to an update Telegram has already dropped, and the stop could
 * no longer hold it back. ONE transformer on the bot's api makes that call
 * wait for the store: every dirty chat is written first, once per batch,
 * whichever writer made it dirty (the collector, a press, a contact, a reply).
 *
 * Bounded, and never a stop of the poll: a flush that fails or runs out of
 * time is logged once and the call goes ahead — memory keeps the chat dirty,
 * its timer retries, and a stop that comes first logs the change lost.
 * Blocking the poll would stop the whole bot, the cabinet and the staff side,
 * for a database blip. A sealed store (the stop's own confirm) passes at once.
 * Every other method passes straight through.
 */
export function flushBeforeConfirm(): Transformer {
  return async (prev, method, payload, signal) => {
    if (method === 'getUpdates' && store.durable && !store.sealed && store.pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        flushIntakeWrites().then((ok) => (ok ? 'written' : 'failed')),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), INTAKE_CONFIRM_FLUSH_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (outcome !== 'written' && !store.sealed && !store.confirmWarned) {
        store.confirmWarned = true;
        logger.warn({ outcome }, '[calc-intake] a batch confirmed before its collection was written — the timer retries');
      }
    }
    const res = await prev(method, payload, signal);
    // Telegram has dropped every update below the offset this call carried:
    // an unwritten change of one of them can no longer be held back.
    const offset = (payload as { offset?: unknown } | undefined)?.offset;
    if (method === 'getUpdates' && res.ok && typeof offset === 'number') {
      store.confirmedBelow = Math.max(store.confirmedBelow, offset);
    }
    return res;
  };
}

/**
 * A stored row as THIS release reads it (docs/IKKI-ESHIK.md §1.3): the ONE
 * place an older collection's shape is brought forward, run on every row the
 * hydrate restores, before it is put in memory. Pure.
 *
 *  - the fields 0140's round added get their empty values — a row written
 *    before them has no `fileTotals` (null), no `fileNotes` ([]) and no
 *    `goodsFiles` ([]); a stored value always wins over the default;
 *  - a collection opened before his 1a may still hold a question no release
 *    asks any more (§1.1): a second Excel waiting for «qo‘shilsin yoki
 *    o‘rniga?» (`pendingInvoice`) is resolved by the rule a new one meets
 *    (`foldPendingInvoice` — compared row by row, its decisions in
 *    `fileNotes`), an open «boshqa zavodmi?» (`aiGoods: 'ask'`) becomes the
 *    add path, and a stored row's conflict nobody answered is the VED's.
 *    `'context'` and `'add'` stay — 'context' was the seller's own answer.
 *    After the hydrate nothing is pending, so «Bo‘ldi» is refused for no file.
 */
export function migrateIntakeState(row: IntakeState): IntakeState {
  const base: IntakeState = {
    ...row,
    fileTotals: row.fileTotals ?? null,
    fileNotes: Array.isArray(row.fileNotes) ? row.fileNotes : [],
    goodsFiles: Array.isArray(row.goodsFiles) ? row.goodsFiles : [],
  };
  const resolved: IntakeState = base.pendingInvoice ? { ...base, ...foldPendingInvoice(base) } : base;
  return {
    ...resolved,
    aiGoods: resolved.aiGoods === 'ask' ? 'add' : resolved.aiGoods,
    conflicts: Array.isArray(resolved.conflicts)
      ? resolved.conflicts.map((c) => (c.choice === null ? { ...c, choice: 'ved' as const } : c))
      : resolved.conflicts,
  };
}

/**
 * Restore the durable collections before the first `getUpdates`. Every row
 * that ran out less than 24 hours ago is loaded too, so the sweep ends it WITH
 * its line (durability-12 b); memory wins where it already holds a chat. A
 * collection whose job has landed is over and its row goes
 * (`endedCollections`, wms); a landing cut off between its note and its
 * request is KEPT, and the sweep finishes it (durability-3); an addition that
 * was saved but never told is kept and its save job sent again.
 */
export async function hydrateIntakes(): Promise<number> {
  await flushIntakeWrites();
  if (!store.durable || !(await intakeTableReady())) return 0;
  const rows = (await db.execute(sql`
    SELECT chat_id::text AS chat_id, note_id::text AS note_id, state
      FROM telegram_calc_intakes
     WHERE expires_at > now() - interval '24 hours'`)) as unknown as {
    chat_id: string;
    note_id: string;
    state: IntakeState;
  }[];
  // Memory wins: a chat it holds, or one with a write still pending (an end
  // whose DELETE has not landed — a late hydrate must never raise it again).
  const candidates = rows.filter(
    (r) => !store.collections.has(r.chat_id) && !store.pending.has(r.chat_id) && r.state && typeof r.state === 'object',
  );
  let ended = new Set<string>();
  let untold: UntoldAmendment[] = [];
  try {
    const { endedCollections } = await import('../../wms/calc/intake-ended');
    ({ ended, untold } = await endedCollections(
      candidates.map((r) => ({ noteId: r.note_id, amend: r.state.amend != null })),
    ));
  } catch (err) {
    // Kept rather than dropped: a landed collection kept is one more ✅ from
    // the sweep (its landing converges by note), a kept one dropped is lost.
    logger.warn({ err }, '[calc-intake] ended collections not checked — every row is kept');
  }
  let loaded = 0;
  for (const row of candidates) {
    if (ended.has(row.note_id) || store.collections.has(row.chat_id)) continue;
    const state = { ...migrateIntakeState(row.state), expires: row.state.touchedAt + INTAKE_TTL_MS };
    store.collections.set(row.chat_id, state);
    loaded += 1;
  }
  // The ended rows go AFTER the kept ones are in memory, in their own try: a
  // cleanup that fails costs a row left over (the next hydrate drops it, a
  // landed one the sweep ends with its ✅), never the restore itself.
  if (ended.size > 0) {
    try {
      await db.execute(sql`
        DELETE FROM telegram_calc_intakes
         WHERE note_id IN (${sql.join([...ended].map((id) => sql`${id}::uuid`), sql`, `)})`);
    } catch (err) {
      logger.warn({ err, ended: ended.size }, '[calc-intake] ended collections not deleted — the next hydrate drops them');
    }
  }
  for (const add of untold) await resendSave(add);
  return loaded;
}

/**
 * The boot's hydrate, patient with a database that is a moment late (its own
 * container recreated in the same deploy): tried again after `retryMs`, and
 * only then handed back as a failure — after which polling starts on memory
 * alone, as before, while it is tried every `lateMs` in the background until
 * it answers (or the store is sealed). A late load is the same load: memory
 * and a pending write win, so a collection the seller started or ended since
 * boot is never raised over; every one his chat left untouched comes back,
 * instead of lying in the table until the NEXT deploy raises it, a day old.
 * `run` is the hydrate itself (bot.ts passes `hydrateIntakes`).
 */
export async function hydrateWithRetry(
  run: () => Promise<number>,
  opts: { retryMs?: readonly number[]; lateMs?: number } = {},
): Promise<number> {
  const retryMs = opts.retryMs ?? [500, 1_500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= retryMs.length) {
        lateHydrate(run, opts.lateMs ?? 30_000);
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs[attempt]));
  }
}

function lateHydrate(run: () => Promise<number>, lateMs: number): void {
  const timer = setTimeout(() => {
    if (store.sealed) return;
    run().then(
      (n) => logger.info({ loaded: n }, '[calc-intake] collections restored late'),
      () => lateHydrate(run, lateMs),
    );
  }, lateMs);
  timer.unref?.();
}

/** What the hydrate hears about an addition saved but never told (wms, intake-ended.ts). */
export interface UntoldAmendment {
  noteId: string;
  requestId: string;
  submission: unknown;
}

/**
 * Hydrate keeps an add collection whose amendment was written but never told,
 * and sends its save job again — through the add door's own re-enqueue
 * (calc-amend.ts `requeueAmendSave`, the one home of the save job's shape and
 * options), with the submission the row records. The redelivery finds the row
 * (`duplicate`) and redoes only what is missing (§9.5). No `singletonKey`:
 * pg-boss 10.4.2 dedupes only on a non-standard queue; a duplicate job is
 * harmless for the same reason.
 */
async function resendSave(add: UntoldAmendment): Promise<void> {
  const chat = [...store.collections].find(([, s]) => s.noteId === add.noteId);
  if (!chat) return;
  const [chatKey, state] = chat;
  try {
    const { requeueAmendSave } = await import('./calc-amend');
    if (!(await requeueAmendSave(BigInt(chatKey), state, { submission: add.submission }))) {
      logger.warn({ noteId: add.noteId }, '[calc-intake] untold addition not sent again');
    }
  } catch (err) {
    logger.warn({ err, noteId: add.noteId }, '[calc-intake] untold addition not sent again');
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

/** Tests: a restart, as far as this store is concerned — memory, timers, the seal and the hydrate. */
export function __forgetIntakeMemory(): void {
  for (const p of store.pending.values()) if (p.timer) clearTimeout(p.timer);
  store.collections.clear();
  store.pending.clear();
  store.sealed = false;
  store.hydrated = false;
  store.waiters.splice(0);
  store.warnedChats.clear();
  store.confirmWarned = false;
  store.confirmedBelow = 0;
  store.unsaid.splice(0);
}

/** Tests: the goodbyes waiting for the sweep's next tick. */
export function __unsaidCount(): number {
  return store.unsaid.length;
}

/** Tests: how many statements were SENT to the table (0 while durable is off or not ready). */
export function __intakeWriteCount(): number {
  return store.writeCount;
}

/** Tests: the readiness probe's answer (null = ask the database). */
export function __setIntakeTableProbe(probe: (() => Promise<boolean>) | null): void {
  store.probe = probe;
}

/** Tests: run before each statement — a write made to hang (await a gate) or to fail (throw). */
export function __setIntakeWriteHook(hook: ((chatId: string) => Promise<void>) | null): void {
  store.hook = hook;
}
