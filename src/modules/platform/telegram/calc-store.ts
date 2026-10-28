import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Context, MiddlewareFn, Transformer } from 'grammy';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { logger } from '../logger';
import type { AmendBase } from '../../wms/calc/amend-types';
import type { CalcSection } from '../../wms/calc/intake';
import type { IntakeState } from './calc-intake';
import { bootedAtSec, currentUpdateId, isBacklog } from './lifecycle';
import { quietHour, sendText } from './send';

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
  warned: boolean;
  confirmWarned: boolean;
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
  warned: false,
  confirmWarned: false,
  ready: false,
  probe: null,
  hook: null,
});

const key = (chatId: bigint | number | string) => String(chatId);

/**
 * Does 0138's table exist? (#472.) Code ahead of the migration is today's
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
    aiUsed: false,
    images: [],
    imagesSkipped: 0,
    promptMessageId: null,
    ai: opts.ai ?? false,
    hasCertificate: true,
    route: null,
    totalsAsked: false,
    askingTotalsFor: null,
    totalsAnswer: { weightKg: null, volumeM3: null, at: { material: 0, files: 0 } },
    routeAnswer: null,
    askingIndex: null,
    round: 0,
    reasked: false,
    lineDone: [],
    lineAnswers: [],
    offers: [],
    ambiguousTotals: [],
    invoiceGoods: [],
    pdfs: [],
    sheetTexts: [],
    invoiceTexts: [],
    pendingInvoice: null,
    aiGoods: null,
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

/**
 * The live collection for a chat, or nothing — expiry is checked on read.
 *
 * `atMs`: the moment the question is asked FOR (`intakeMomentOf`). An entry
 * found expired is handed to `expireIntake`, the one end path the sweep
 * shares, which says «⌛ … o‘chirildi» once (durability-12 a).
 */
export function activeIntake(chatId: bigint, atMs: number = Date.now()): IntakeState | null {
  const state = store.collections.get(key(chatId));
  if (!state) return null;
  if (expiredAt(state, atMs)) {
    expireIntake(chatId, state);
    return null;
  }
  return state;
}

/**
 * Is the collection empty — nothing sent, no customer named? Such a one is
 * neither reminded nor said goodbye to: there is nothing to lose.
 */
export function intakeIsEmpty(state: IntakeState): boolean {
  return (
    state.material.length === 0 &&
    state.fileCount === 0 &&
    state.answers.length === 0 &&
    state.clientHintRaw.trim() === ''
  );
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

async function sayEnded(chatId: bigint, state: IntakeState): Promise<void> {
  const { SECTION_LABEL } = await import('../../wms/calc/intake');
  const { intakeClientSummary } = await import('./calc-intake');
  const text = intakeEndedText(state, SECTION_LABEL, intakeClientSummary(state.clientHintRaw));
  const sent = await sendText({ chatId, text, silent: quietHour() });
  if (!sent.ok) logger.warn({ chatId: String(chatId), status: sent.status }, '[calc-intake] end line refused');
}

/** §2.7's goodbye, pure. `client` = `intakeClientSummary(clientHintRaw)`. */
export function intakeEndedText(
  state: Pick<IntakeState, 'section' | 'amend'>,
  sections: Record<CalcSection, string>,
  client: string | null,
): string {
  if (state.amend) {
    return (
      `⌛ Qo‘shimcha 24 soat ichida yuborilmadi va o‘chirildi: ➕ ${state.amend.cardLabel}. ` +
      'Kerak bo‘lsa ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni qayta bosing.'
    );
  }
  return (
    `⌛ Hisoblatish 24 soat ichida tugatilmadi va o‘chirildi: ${sections[state.section]} · ${client ?? 'mijoz hali yozilmagan'}. ` +
    'Kerak bo‘lsa «🧮 Hisoblatish» dan qaytadan boshlang.'
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
 */
export function collectionSurvived(chatId: bigint | number): boolean {
  const state = activeIntake(BigInt(chatId));
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
  if (isBacklog(msg.date) && msg.date < Math.floor(state.openedAt / 1000)) return 'pass';
  if (msg.replyTo !== null && state.ownMessageIds.includes(msg.replyTo)) return 'take';
  if (!intakeHolds(state, msg.date * 1000)) return 'pass';
  return 'take';
}

/**
 * Pure: is the pressed message one of this collection's own — the one that
 * opened it, or one it drew since (`ownMessageIds`)? A press from an older
 * collection's message, a crash-redelivered «✖️ Bekor qilish» included,
 * changes nothing (durability-2).
 *
 * A press that names no message cannot be judged and acts on what is live,
 * as before: Telegram always sends the message a bot's inline button sat on,
 * so only a test's stand-in ctx reaches that branch.
 */
export function ownsPress(state: IntakeState, pressedMessageId: number | null): boolean {
  if (pressedMessageId === null) return true;
  return pressedMessageId === state.openedBy || state.ownMessageIds.includes(pressedMessageId);
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
  p.from = minOf(p.from, currentUpdateId());
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
      const ok = await p.inFlight;
      if (!p.dirty) return ok;
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
        // Kept DIRTY and retried by the next timer, never dropped
        // (durability-10): «log once and forget» lost a seller's change at the
        // next deploy with its update already confirmed. One line per process.
        p.dirty = true;
        p.from = minOf(p.from, p.writingFrom);
        p.writingFrom = null;
        p.firstAt ??= Date.now();
        if (!store.sealed) arm(k, p, INTAKE_WRITE_MAX_MS);
        if (!store.warned) logger.warn({ err, chatId: k }, '[calc-intake] collection not written to the table');
        store.warned = true;
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
  const json = JSON.stringify(rest);
  if (json.length > LARGE_STATE_BYTES) {
    logger.warn({ chatId: k, bytes: json.length }, '[calc-intake] large collection');
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

/**
 * The lowest update id whose collection change is not yet written, or null.
 * The stop asks it after the flush and, while that update's batch is still
 * being handled, confirms only through the update before it (durability-10);
 * an update of an ended batch is already confirmed and is logged lost (K15).
 */
export function oldestUnwrittenUpdate(): number | null {
  let oldest: number | null = null;
  for (const p of store.pending.values()) {
    if (p.dirty) oldest = minOf(oldest, p.from);
    oldest = minOf(oldest, p.writingFrom);
  }
  return oldest;
}

/**
 * After the stop's flush: this process writes no more rows (durability-1). An
 * update still running here past the stop's budget is unconfirmed and goes to
 * the new process; its late effect must never overwrite the row that process
 * hydrated.
 */
export function sealIntakeWrites(): void {
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
    return prev(method, payload, signal);
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
  const candidates = rows.filter((r) => !store.collections.has(r.chat_id) && r.state && typeof r.state === 'object');
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
  if (ended.size > 0) {
    await db.execute(sql`
      DELETE FROM telegram_calc_intakes
       WHERE note_id IN (${sql.join([...ended].map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  let loaded = 0;
  for (const row of candidates) {
    if (ended.has(row.note_id) || store.collections.has(row.chat_id)) continue;
    const state = { ...row.state, expires: row.state.touchedAt + INTAKE_TTL_MS };
    store.collections.set(row.chat_id, state);
    loaded += 1;
  }
  for (const add of untold) await resendSave(add);
  return loaded;
}

/** What the hydrate hears about an addition saved but never told (wms, intake-ended.ts). */
export interface UntoldAmendment {
  noteId: string;
  requestId: string;
  submission: unknown;
}

/**
 * Hydrate keeps an add collection whose amendment was written but never told,
 * and sends its save job again with the job's own options — the redelivery
 * finds the row (`duplicate`) and redoes only what is missing (§9.5). No
 * `singletonKey`: pg-boss 10.4.2 dedupes only on a non-standard queue; a
 * duplicate job is harmless for the same reason.
 */
async function resendSave(add: UntoldAmendment): Promise<void> {
  const chat = [...store.collections].find(([, s]) => s.noteId === add.noteId);
  if (!chat) return;
  const [chatKey, state] = chat;
  const jobId = randomUUID();
  try {
    const { enqueue } = await import('../jobs/boss');
    const { JOB_CALC_AMEND_SAVE } = await import('./calc-amend');
    const token = state.saving?.token ?? randomUUID();
    await enqueue(
      JOB_CALC_AMEND_SAVE,
      {
        chatId: chatKey,
        staffId: state.staffId,
        requestId: add.requestId,
        noteId: add.noteId,
        submission: add.submission,
        amendmentId: null,
        savingToken: token,
      },
      { id: jobId, expireInSeconds: 120, retryLimit: 3 },
    );
    updateIntake(BigInt(chatKey), { saving: { token, at: Date.now(), jobId } }, { quiet: true });
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
  store.warned = false;
  store.confirmWarned = false;
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
