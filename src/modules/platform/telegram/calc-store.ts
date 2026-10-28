import { v4 as uuidv4 } from 'uuid';
import type { AmendBase } from '../../wms/calc/amend-types';
import type { CalcSection } from '../../wms/calc/intake';
import type { IntakeState } from './calc-intake';
import { isBacklog } from './lifecycle';

/**
 * The «Hisoblatish» collections, as the bot holds them — MOVED out of
 * calc-intake.ts (docs/SAKKIZ-R3.md K3), which re-exports the four calls every
 * importer used.
 *
 * The signatures below are frozen for the round: P1 makes the collection
 * outlive a restart BEHIND them (a durable row, the 24 h clock, parking), and
 * every caller already speaks to that shape. Each K body is today's memory
 * store or an inert answer, so the bot behaves exactly as before.
 */

/** How long a collection lives without the seller. K: today's 30 minutes. P1: 24 h. */
export const INTAKE_TTL_MS = 30 * 60_000;
/** How long without his action the collection still HOLDS the chat. K: = INTAKE_TTL_MS. P1: 30 * 60_000. */
export const HOLD_MS = INTAKE_TTL_MS;
/** When the sweep reminds a quiet collection (P1). Unread in K. */
export const REMIND_AFTER_MS = 2 * 3_600_000;

/**
 * A job asked for the store before this process restored it (P1: durability-9)
 * — thrown so pg-boss re-delivers instead of completing on an empty memory.
 * Nothing throws it in K.
 */
export class IntakesNotReady extends Error {
  constructor() {
    super('calc intakes not hydrated');
    this.name = 'IntakesNotReady';
  }
}

const collections = new Map<string, IntakeState>();

const key = (chatId: bigint) => String(chatId);

/** P1's switch for the durable row; K only remembers it. */
let durable = false;

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
  collections.set(key(chatId), state);
  return state;
}

/**
 * The live collection for a chat, or nothing — expiry is checked on read.
 *
 * `atMs`: the moment the question is asked FOR — the ladder passes a backlog
 * message's written date, so a message written before the clock ran out still
 * finds its collection (P1, durability-12 c). An entry found expired is handed
 * to `expireIntake`, the one end path the sweep shares. K: `atMs` ignored.
 */
export function activeIntake(chatId: bigint, _atMs?: number): IntakeState | null {
  const state = collections.get(key(chatId));
  if (!state) return null;
  if (state.expires <= Date.now()) {
    expireIntake(chatId, state);
    return null;
  }
  return state;
}

/**
 * End an expired collection — the ONE end path, shared by a read that finds it
 * expired and the sweep (P1 says «⌛ … o‘chirildi» once, from here). K: the
 * entry is deleted in silence, as a read always did. Only the collection it was
 * handed: a newer one in the same chat is not this one's to end.
 */
export function expireIntake(chatId: bigint, state: IntakeState): void {
  const live = collections.get(key(chatId));
  if (live && live.noteId === state.noteId) collections.delete(key(chatId));
}

/** Pure: does the collection hold the chat at `atMs` (not parked, P1)? K: true. */
export function intakeHolds(_state: IntakeState, _atMs: number): boolean {
  return true;
}

/**
 * The live collection when it HOLDS the chat now, else null. Asked by every
 * door that refuses beside a collection (task draft, zametka «Yangi», 💬, a
 * shared contact) and by the orphan guard. K: `activeIntake`.
 */
export function holdingIntake(chatId: bigint): IntakeState | null {
  return activeIntake(chatId);
}

/**
 * `quiet`: a bookkeeping write (a message id, the job's settle, the
 * reminder's mark) — it does not slide the clock (P1). K accepts and ignores
 * it: today every patch slides.
 */
export function updateIntake(
  chatId: bigint,
  patch: Partial<IntakeState>,
  _opts?: { quiet?: boolean },
): IntakeState | null {
  const state = activeIntake(chatId);
  if (!state) return null;
  const now = Date.now();
  const next = { ...state, ...patch, touchedAt: now, expires: now + INTAKE_TTL_MS };
  collections.set(key(chatId), next);
  return next;
}

export function endIntake(chatId: bigint): void {
  collections.delete(key(chatId));
}

/**
 * The job's read. P1: awaits `intakesHydrated`, then MEMORY only — never the
 * table, which after hydration could resurrect a collection whose DELETE is
 * still pending (performance-7); not hydrated in time → `IntakesNotReady`
 * (durability-9). K: `activeIntake`.
 */
export async function loadIntake(chatId: bigint): Promise<IntakeState | null> {
  return activeIntake(chatId);
}

/**
 * Resolves true once this process's `hydrateIntakes()` has finished; false at
 * `timeoutMs`, or at once when this process runs no bot (P1). K: true.
 */
export async function intakesHydrated(_timeoutMs: number): Promise<boolean> {
  return true;
}

/** Every live collection, for the sweep. */
export function liveIntakes(): ReadonlyArray<readonly [bigint, IntakeState]> {
  const now = Date.now();
  return [...collections]
    .filter(([, state]) => state.expires > now)
    .map(([chat, state]) => [BigInt(chat), state] as const);
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
 * 'take' = apply it (P1: and advance `takenUpTo` in the same patch); 'seen' =
 * it was applied before (a redelivery) — the ladder drops it silently; 'pass'
 * = not this collection's — the ladder goes on.
 *
 * K: today's rule, the three `!late` checks the ladder carried — no collector
 * THIS process opened takes a backlog message (Q5 a), because every one of
 * them was opened after boot and the message was written before it.
 */
export function intakeTakes(_state: IntakeState, msg: IntakeMessage): 'take' | 'seen' | 'pass' {
  return isBacklog(msg.date) ? 'pass' : 'take';
}

/**
 * Pure: is the pressed message one of this collection's own (opening, prompt,
 * table, echoes, reminder, pause notice)? P1 decides; K: true.
 */
export function ownsPress(_state: IntakeState, _pressedMessageId: number | null): boolean {
  return true;
}

/** Join a message this collection sent to its own (`ownMessageIds`, last 40), quietly. */
export function noteOwnMessage(chatId: bigint, messageId: number): void {
  const state = activeIntake(chatId);
  if (!state) return;
  const own = [...state.ownMessageIds.filter((id) => id !== messageId), messageId].slice(-40);
  updateIntake(chatId, { ownMessageIds: own }, { quiet: true });
}

/** P1's switch (bot.ts, beside `setDurableWaits`). K: stores the flag. */
export function setDurableIntakes(on: boolean): void {
  durable = on;
}

/** Whether the durable store is switched on in this process (K: only the flag). */
export function durableIntakes(): boolean {
  return durable;
}

/**
 * Write what is dirty now: with `chatId`, THAT chat's pending write only
 * (performance-10); without it, every chat (the stop, tests). False = the store
 * is sealed or that write failed (P1). K: nothing is ever dirty — true at once.
 */
export async function flushIntakeWrites(_chatId?: bigint): Promise<boolean> {
  return true;
}

/**
 * The lowest update id whose collection change is not yet written, or null.
 * The stop confirms only through the update before it (P1, durability-10).
 * K: null.
 */
export function oldestUnwrittenUpdate(): number | null {
  return null;
}

/** After the stop's flush: this process writes no more rows (P1). K: no-op. */
export function sealIntakeWrites(): void {}

/** Restore the durable collections before the first `getUpdates` (P1). K: none. */
export async function hydrateIntakes(): Promise<number> {
  return 0;
}
