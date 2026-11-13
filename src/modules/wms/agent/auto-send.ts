import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  agentAutoChats,
  agentAutoConfig,
  agentAutoVerdicts,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  notifications,
  tgAccounts,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { sendsSilently } from '../../platform/notifications/night';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithRoles } from '../../platform/notifications/service';
import { actorGrants } from '../../platform/rbac/authorize';
import { getSetting } from '../../platform/settings/service';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { listenerIsCurrent, readGuard } from '../crm/account-guard';
import { AUTO_DISARM_WORDS, autoTakeBackable } from './auto-card';
import { AUTO_SEND_CATEGORIES } from './auto-categories';
import { estimateUnnamed } from './auto-money';
import { estimatesStand } from './estimate-check';
import { tariffUnconfirmed } from './tariff-watch';
import { autoVerdict, type AutoGateInput, type AutoLedgerLine, type AutoRefusal, type AutoToolCall } from './auto-gate';
import { cardDigest, digestBody } from './card';
import { agentAutoReady, agentFullP1Ready, agentRunning, disarmAutoInTx, mayRunAgent, readAgentConfig, type AutoDisarmReason } from './config';
import type { DecideRefusal } from './decide';
import type { NewDraft } from './drafts';
import { readSendCaps } from './send-caps';
import { sendWindowFor } from './send-window';
import { sendsToday } from './today';
import { CATEGORIES } from './tools';
import type { AnswerMark, DraftPolicyJson } from './types';
import { answerStale } from './owner-answer';

/**
 * «O'zi yuborish» — the impure side of auto-send (docs/AI-SOTUVCHI.md §18.3,
 * his answer of 2026-11-11: «ozi javob beraversin men bergan tasdiq kop kutib
 * qolmasin» — no proof cell, no holdback, every other ⭐ stands).
 *
 * A LAYER over shadow, never a mode: the agent stays 'shadow', and a reply the
 * gate admits goes by a MACHINE PRESS of the same ✅ (`decideDraft(…, {auto})`)
 * after a hold he can ⏸ — then the existing pump, so every check a human press
 * runs runs again and there is no second send path.
 *
 *  - The plan (`autoPlanFor`) is computed by the INBOUND run only, after the
 *    policy, and written by `createDraft` inside its own transaction, beside the
 *    draft, before the card is rendered — the first card already carries the
 *    timer. One row per reply draft while 0145 exists: eligible with its due
 *    time, or not with every reason (the rehearsal record).
 *  - The press (`pressDueAutos`) is the minute sweep's: claim the due rows,
 *    judge again on FRESH facts, press through `decideDraft`.
 *  - A person's own decision on the draft stops a waiting auto
 *    (`stopAutoForPerson`, called by every non-auto `decideDraft`); a row
 *    already being pressed is left to the draft's own compare-and-set.
 *  - Off, a forced off and a new owner disarm inside their own transactions
 *    (config `disarmAutoInTx`); three step-downs disarm by themselves, with an
 *    alarm. Re-arming is always his press.
 *
 * Every reader and writer asks `agentAutoReady()` first.
 */

// ── the configuration ───────────────────────────────────────────────────────

export interface AutoConfig {
  armed: boolean;
  armedAt: Date | null;
  armedBy: string | null;
  holdSec: number;
  /** Auto presses a Tashkent day may hold — null = no cap (0148, his «7 chegara qoyma»). */
  perDay: number | null;
  maxChars: number;
  minConfidence: number;
  categories: string[];
  disarmedAt: Date | null;
  disarmReason: string | null;
}

function toAutoConfig(row: typeof agentAutoConfig.$inferSelect): AutoConfig {
  return {
    armed: row.armedAt !== null,
    armedAt: row.armedAt,
    armedBy: row.armedBy,
    holdSec: row.holdSec,
    perDay: row.perDay,
    maxChars: row.maxChars,
    // numeric comes back as text; the CHECK keeps it in [0.5, 1].
    minConfidence: Number(row.minConfidence),
    categories: row.categories ?? [],
    disarmedAt: row.disarmedAt,
    disarmReason: row.disarmReason,
  };
}

/** The auto layer's singleton, or null when 0145 has not landed. */
export async function readAutoConfig(handle: Db | Tx = db): Promise<AutoConfig | null> {
  if (!(await agentAutoReady())) return null;
  const [row] = await handle.select().from(agentAutoConfig).where(eq(agentAutoConfig.id, 1));
  return row ? toAutoConfig(row) : null;
}

/**
 * His price act (spec SPEC-P1-v2 §1.2): `price` ticked among the kinds AND the layer armed. While it holds, the
 * flight's PRICE may go by itself — the run's avia rule stops asking him about every quoted flight, and the head
 * and the avia tool tell the model to quote the price alone. Off (or 0145 not landed), every word is today's.
 */
export function priceActArmedOf(auto: Pick<AutoConfig, 'armed' | 'categories'> | null): boolean {
  return auto?.armed === true && auto.categories.includes('price');
}

/** `priceActArmedOf` over the stored row — read once per run. */
export async function priceActArmed(): Promise<boolean> {
  return priceActArmedOf(await readAutoConfig());
}

// ── the facts ───────────────────────────────────────────────────────────────

/** What the gate reads of a draft — a stored row, or the one the run is about to write. */
export interface AutoDraftShape {
  managerUserId: string;
  peerId: bigint;
  runId: string | null;
  clientId: string | null;
  leadId: string | null;
  anchorTgMessageId: bigint;
  kind: string;
  status: string;
  finalBody: string | null;
  proposedBody: string | null;
  blocked: boolean;
  needsOwner: boolean;
  category: string | null;
  language: string | null;
  /** numeric(3,2) comes back as text; the run's own is a number. */
  confidence: string | number | null;
  policy: unknown;
  actions: unknown;
}

type ToolCall = AutoToolCall;

/**
 * The run's stored tool calls as the gate reads them. The estimate flag is the one the run stored beside each call
 * (spec §1.1); a call stored before 0148 carries none and reads as a PRICED estimate — failing closed: such a
 * draft also has no stored estimates, and the money clause refuses it.
 */
export function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is { name: unknown; ok: unknown; estimate?: unknown } => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      ok: t.ok === true,
      estimate: typeof t.estimate === 'boolean' ? t.estimate : true,
    }));
}

/** The stored ledger as the gate reads it: who vouched for each line — absent fields (a line before 0148) are null. */
function ledgerLinesOf(raw: unknown): AutoLedgerLine[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({ kind: str(e.kind) ?? '', origin: str(e.origin), tool: str(e.tool), role: str(e.role) }));
}

function confidenceOf(raw: string | number | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

/** The Tashkent day `now` falls in, from its start — the day the per-day cap counts. */
function dayStartOf(now: Date): Date {
  return tashkentDayStart(tashkentDay(now));
}

/**
 * Replies of this account still counting down — waiting, or claimed by the sweep — on a draft that is still the
 * chat's live reply (a row whose draft the chat retired waits only for the sweep to call it gone). Each is a press
 * the day already owes: the scheduling counts them toward the cap and the day's sends (fix pass A, C8). Never the
 * chat being drafted: its live reply is the one the new draft supersedes (one live draft per chat, drafts
 * `createDraft`).
 */
async function autoQueued(managerUserId: string, exceptPeer: bigint): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentAutoVerdicts)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentAutoVerdicts.draftId))
    .where(
      and(
        eq(agentAutoVerdicts.managerUserId, managerUserId),
        inArray(agentAutoVerdicts.state, ['waiting', 'pressing']),
        eq(agentDrafts.status, 'pending'),
        ne(agentAutoVerdicts.peerId, exceptPeer),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Auto presses on this account since the Tashkent day began. */
export async function autoPressedToday(managerUserId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentAutoVerdicts)
    .where(
      and(
        eq(agentAutoVerdicts.managerUserId, managerUserId),
        eq(agentAutoVerdicts.state, 'pressed'),
        gte(agentAutoVerdicts.pressedAt, dayStartOf(now)),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Auto replies in a row in this chat (§18.3: at most 2): the presses since the
 * last thing a PERSON did here — a draft he decided himself (his ✅, ✏️, ❌,
 * 🙋; never one the machine pressed), his ✍️ answer to the AI's question (spec
 * SPEC-P1-v2 §2.2 — the redraft's plan is judged before `createDraft` stamps
 * the question decided, so the answer itself is what counts), or a message of
 * his own (his phone, the CRM; never the AI's send and never the account's
 * Business robot, `auto_sent`).
 */
async function autoStreak(managerUserId: string, peerId: bigint): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    WITH person AS (
      SELECT greatest(
        (SELECT max(d.decided_at) FROM agent_drafts d
          WHERE d.manager_user_id = ${managerUserId}::uuid AND d.peer_id = ${String(peerId)}::bigint
            AND d.decided_by IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM agent_auto_verdicts v WHERE v.draft_id = d.id AND v.state = 'pressed')),
        (SELECT max((d.policy->'ownerAnswer'->>'at')::timestamptz) FROM agent_drafts d
          WHERE d.manager_user_id = ${managerUserId}::uuid AND d.peer_id = ${String(peerId)}::bigint
            AND d.policy ? 'ownerAnswer'),
        (SELECT max(m.sent_at) FROM tg_messages m
           LEFT JOIN tg_message_flags f ON f.message_id = m.id
          WHERE m.manager_user_id = ${managerUserId}::uuid AND m.peer_id = ${String(peerId)}::bigint
            AND m.direction = 'out' AND f.deleted_at IS NULL AND coalesce(f.auto_sent, false) = false
            AND NOT EXISTS (SELECT 1 FROM agent_outbox o
                             WHERE o.manager_user_id = m.manager_user_id AND o.tg_message_id = m.tg_message_id))
      ) AS at
    )
    SELECT count(*)::int AS n FROM agent_auto_verdicts v, person
     WHERE v.manager_user_id = ${managerUserId}::uuid AND v.peer_id = ${String(peerId)}::bigint
       AND v.state = 'pressed' AND (person.at IS NULL OR v.pressed_at > person.at)`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Did the customer's burst — his lines since our last message, up to the one
 * the draft answers — carry a photo, a voice note or a file? (§18.3: a message
 * that came with one never goes by itself.) Read from the stored chat, the
 * context's own measure (`has_media`), at the scheduling and at the press.
 */
async function burstHadMedia(d: Pick<AutoDraftShape, 'managerUserId' | 'peerId' | 'anchorTgMessageId'>): Promise<boolean> {
  const rows = await db.execute<{ media: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM tg_messages m
        LEFT JOIN tg_message_flags f ON f.message_id = m.id
       WHERE m.manager_user_id = ${d.managerUserId}::uuid AND m.peer_id = ${String(d.peerId)}::bigint
         AND m.direction = 'in' AND m.has_media AND f.deleted_at IS NULL
         AND m.tg_message_id <= ${String(d.anchorTgMessageId)}::bigint
         AND m.tg_message_id > coalesce((
           SELECT max(o.tg_message_id) FROM tg_messages o
             LEFT JOIN tg_message_flags of2 ON of2.message_id = o.id
            WHERE o.manager_user_id = ${d.managerUserId}::uuid AND o.peer_id = ${String(d.peerId)}::bigint
              AND o.direction = 'out' AND of2.deleted_at IS NULL
              AND o.tg_message_id < ${String(d.anchorTgMessageId)}::bigint), 0)
    ) AS media`);
  return rows[0]?.media === true;
}

/**
 * The gate's input, read from the database — at the scheduling (`tools` from
 * the run in hand: its ledger row is settled only after the draft is written)
 * and again at the press, where the run's stored `tool_calls` are read.
 * `at` is when the reply would go: the due time, or the press's own moment.
 *
 * `scheduling`: the replies still counting down are presses the day already
 * owes — counted into the cap and spent from the day's sends (fix pass A,
 * C8). At the press they are not: the row being pressed is one of them, and so
 * may be the rest of the sweep's batch. And the three facts the ✅ itself asks
 * (the send switch, the listener, the day's sends) are judged at the
 * scheduling only: at the press the ✅ asks them on its own clock.
 */
export async function autoFactsFor(
  d: AutoDraftShape,
  opts: { at: Date; now: Date; tools?: readonly ToolCall[]; config?: AutoConfig | null; scheduling?: boolean },
): Promise<AutoGateInput> {
  const auto = opts.config === undefined ? await readAutoConfig() : opts.config;
  const agent = await readAgentConfig();
  const policy = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  const actions = Array.isArray(d.actions) ? (d.actions as { type?: unknown }[]) : [];
  let tools: readonly ToolCall[] = opts.tools ?? [];
  if (opts.tools === undefined && d.runId) {
    const [run] = await db.select({ toolCalls: agentRuns.toolCalls }).from(agentRuns).where(eq(agentRuns.id, d.runId));
    tools = toolCallsOf(run?.toolCalls);
  }
  const [acc] = await db
    .select({ id: tgAccounts.id, work: tgAccounts.workAccount })
    .from(tgAccounts)
    .where(eq(tgAccounts.managerUserId, d.managerUserId));
  const queued = opts.scheduling ? await autoQueued(d.managerUserId, d.peerId) : 0;
  // The ✅'s own refusals that are already facts at the scheduling (decide `decideDraft`): a card must never count
  // down to them. At the press the ✅ asks them itself.
  const sends = opts.scheduling
    ? await sendsToday(d.managerUserId, agent?.startedAt ?? null, opts.now, (await readSendCaps()).dayCap)
    : null;
  const guard = opts.scheduling && acc ? await readGuard(acc.id) : null;
  const [off] = await db
    .select({ offUntil: agentAutoChats.offUntil })
    .from(agentAutoChats)
    .where(and(eq(agentAutoChats.managerUserId, d.managerUserId), eq(agentAutoChats.peerId, d.peerId)));
  // His 🙋 and a mute, read NOW (final check): the run read them before its model call, and a 🙋 pressed during
  // that call — on the chat's previous card — reaches the reply it writes only here.
  const [conv] = await db
    .select({ humanUntil: agentConversations.humanUntil, mutedAt: agentConversations.mutedAt })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, d.managerUserId), eq(agentConversations.peerId, d.peerId)));
  const memory = policy.memory;
  const fromAnswer = answerMarkOf(policy.fromAnswer);
  const estimates = Array.isArray(memory?.estimates) ? memory.estimates : [];
  // The machine's words carry the machine's figures; his own (✏️) are never auto-pressed anyway.
  const quoted = estimates.length > 0 && d.finalBody === null;
  return {
    config: {
      armed: auto?.armed === true,
      categories: auto?.categories ?? [],
      maxChars: auto?.maxChars ?? 0,
      minConfidence: auto?.minConfidence ?? 1,
      // NULL is «no cap» and stays NULL (0148): a fallback to a number here would refuse every reply for ever
      // while typecheck stays green. No row at all is `not_armed` above.
      perDay: auto ? auto.perDay : null,
    },
    agentOn: agentRunning(agent) && agent.ownerUserId === d.managerUserId,
    draft: {
      kind: d.kind,
      status: d.status,
      ownText: d.finalBody !== null,
      blocked: d.blocked,
      needsOwner: d.needsOwner,
      warnings: Array.isArray(policy.warnings) ? policy.warnings.length : 0,
      notes: Array.isArray(policy.notes) ? policy.notes.length : 0,
      actionTypes: actions.map((a) => (typeof a?.type === 'string' ? a.type : '?')),
      category: d.category,
      language: d.language,
      body: digestBody(d),
      confidence: confidenceOf(d.confidence),
      ledger: ledgerLinesOf(policy.ledger),
      hasEstimate: memory?.hasEstimate === true,
      estimatesStored: Array.isArray(memory?.estimates) && memory.estimates.length > 0,
      rail: memory?.rail === true,
      customerLocale: memory?.customerLocale ?? null,
    },
    tools,
    money: {
      unnamed: memory ? unnamedOf(digestBody(d), memory) : false,
      // The stored figures priced again NOW (§1.3) — at the scheduling and again at the press, with the function the
      // send step asks: a tariff edit or a new avia rate during the hold never lets the old figure out by itself.
      moved: quoted ? (await estimatesStand(estimates, opts.now)) === 'estimate_moved' : false,
      // The China column written since his last ✅ on it (§1.6) — asked of a TRUCK figure only: the flight is his rate.
      tariffUnconfirmed: quoted && estimates.some((e) => e?.tool === 'yolkira_estimate') ? await tariffUnconfirmed(opts.now) : false,
      // The customer named another city or region (§1.8), read by the run over the whole window. A memory that does
      // not say (none such carries estimates) reads as named.
      foreignDestination: quoted ? memory?.foreignDestination !== false : false,
      // His ✍️ answer behind this redraft (spec §2.2, `policy.fromAnswer`): another customer named in it — read by the
      // run that wrote the redraft — and the customer writing again after the line his question answered, read NOW.
      ownerPersonal: (fromAnswer?.personal.length ?? 0) > 0,
      answerStale: fromAnswer ? await answerStaleOf(d, fromAnswer) : false,
    },
    burstMedia: await burstHadMedia(d),
    chat: {
      hasOwner: d.clientId !== null || d.leadId !== null,
      prospect: (await sendWindowFor(d)) === 'agent_lead',
      offUntil: off?.offUntil ?? null,
      humanUntil: conv?.humanUntil ?? null,
      muted: conv?.mutedAt != null,
    },
    workAccount: acc?.work === true,
    at: opts.at,
    now: opts.now,
    streak: await autoStreak(d.managerUserId, d.peerId),
    pressedToday: (await autoPressedToday(d.managerUserId, opts.now)) + queued,
    budgetLeft: sends ? sends.ceiling - sends.used - queued : null,
    sendingEnabled: opts.scheduling ? (await getSetting('tg_sending_enabled')) === true : null,
    listenerCurrent: opts.scheduling ? listenerIsCurrent(guard, opts.now) : null,
  };
}

/** The stored `fromAnswer` as the gate reads it; a malformed one reads as personal (fails closed). */
function answerMarkOf(raw: unknown): AnswerMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Partial<AnswerMark>;
  const personal = Array.isArray(m.personal) ? m.personal.filter((b): b is string => typeof b === 'string') : ['?'];
  return {
    questionDraftId: typeof m.questionDraftId === 'string' ? m.questionDraftId : '',
    questionAnchor: typeof m.questionAnchor === 'string' && /^\d+$/u.test(m.questionAnchor) ? m.questionAnchor : '0',
    personal,
  };
}

/** `answerStale` for a redraft — one that cannot be read is stale (fails closed): the redraft waits for his eye. */
async function answerStaleOf(d: Pick<AutoDraftShape, 'managerUserId' | 'peerId'>, mark: AnswerMark): Promise<boolean> {
  try {
    return await answerStale(d.managerUserId, d.peerId, BigInt(mark.questionAnchor));
  } catch (err) {
    logger.warn({ err }, '[agent] auto: the answered question’s chat not read');
    return true;
  }
}

/** `estimateUnnamed` over a stored memory — one a reader cannot parse names nothing (fails closed). */
function unnamedOf(body: string, memory: NonNullable<Partial<DraftPolicyJson>['memory']>): boolean {
  try {
    return estimateUnnamed(body, { sources: memory.sources ?? [], estimates: memory.estimates ?? null, askedMode: memory.askedMode ?? null });
  } catch (err) {
    logger.warn({ err }, '[agent] auto: the quote’s load not read');
    return true;
  }
}

// ── the plan, at the scheduling ─────────────────────────────────────────────

/** What the inbound run hands `createDraft`: the verdict, its reasons, and — eligible — when it goes. */
export interface AutoPlan {
  eligible: boolean;
  reasons: AutoRefusal[];
  category: string | null;
  confidence: number | null;
  /** `cardDigest` of the body and actions — the press passes it, so an edited card refuses. */
  digest: string;
  dueAt: Date | null;
  /** The hold it was scheduled with (`hold_sec`) — what `countdownMayRide` measures an old card copy by. */
  holdSec: number;
}

/**
 * The draft the run is about to write, as the gate reads a draft — the row
 * `createDraft` will insert (drafts `draftFromRun`): pending, none of his words,
 * the lead only when no client holds the chat.
 */
export function autoShapeOf(n: NewDraft): AutoDraftShape {
  return {
    managerUserId: n.managerUserId,
    peerId: n.peerId,
    runId: n.runId,
    clientId: n.clientId,
    leadId: n.clientId ? null : n.leadId,
    anchorTgMessageId: n.anchorTgMessageId,
    kind: n.kind,
    status: 'pending',
    finalBody: null,
    proposedBody: n.body,
    blocked: n.blocked,
    needsOwner: n.needsOwner,
    category: n.category,
    language: n.language,
    confidence: n.confidence,
    policy: n.policy,
    actions: n.actions,
  };
}

/**
 * The plan for a reply the inbound run is about to write — or null when 0145
 * has not landed, and null (logged) when it could not be computed: a plan is
 * never a reason for the draft to fail.
 */
export async function autoPlanFor(input: { draft: AutoDraftShape; tools: readonly ToolCall[]; now: Date }): Promise<AutoPlan | null> {
  try {
    const config = await readAutoConfig();
    if (!config) return null;
    // Stored as `createDraft` stores them: a category outside the seven is 'other', the confidence to cents.
    const category = input.draft.category && (CATEGORIES as readonly string[]).includes(input.draft.category) ? input.draft.category : 'other';
    const draft: AutoDraftShape = { ...input.draft, category, confidence: confidenceOf(input.draft.confidence) };
    const dueAt = new Date(input.now.getTime() + config.holdSec * 1000);
    const verdict = autoVerdict(await autoFactsFor(draft, { at: dueAt, now: input.now, tools: input.tools, config, scheduling: true }));
    return {
      eligible: verdict.eligible,
      reasons: verdict.reasons,
      category,
      confidence: confidenceOf(draft.confidence),
      digest: cardDigest(digestBody(draft), Array.isArray(draft.actions) ? draft.actions : []),
      dueAt: verdict.eligible ? dueAt : null,
      holdSec: config.holdSec,
    };
  } catch (err) {
    logger.error({ err, peer: String(input.draft.peerId) }, '[agent] auto plan not computed');
    return null;
  }
}

/**
 * What a card knows of its auto press — the seam the card's words read
 * (`renderDraftCardFull`'s `auto`). Null: no row, or a row the gate refused at
 * the scheduling (an ordinary card).
 */
export interface AutoCardState {
  state: 'waiting' | 'pressing' | 'pressed' | 'stopped' | 'refused' | 'gone';
  dueAt: Date | null;
  /** The press's refusal code(s), or why it stopped. */
  outcome: string | null;
  reasons: string[];
  feedback: 'bad' | null;
}

function cardStateOf(row: Pick<typeof agentAutoVerdicts.$inferSelect, 'state' | 'dueAt' | 'outcome' | 'reasons' | 'feedback'>): AutoCardState | null {
  if (row.state === null) return null;
  return {
    state: row.state as AutoCardState['state'],
    dueAt: row.dueAt,
    outcome: row.outcome,
    reasons: row.reasons ?? [],
    feedback: row.feedback === 'bad' ? 'bad' : null,
  };
}

/** The draft's auto state for its card, or null (no row, an ineligible one, or 0145 not landed). */
export async function autoCardStateFor(draftId: string): Promise<AutoCardState | null> {
  if (!(await agentAutoReady())) return null;
  const [row] = await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  return row ? cardStateOf(row) : null;
}

/** `autoCardStateFor` for a page of cards in ONE query (web-page `webDrafts`) — absent = the ordinary card. */
export async function autoCardStatesFor(draftIds: readonly string[]): Promise<Map<string, AutoCardState>> {
  const out = new Map<string, AutoCardState>();
  if (draftIds.length === 0 || !(await agentAutoReady())) return out;
  const rows = await db.select().from(agentAutoVerdicts).where(inArray(agentAutoVerdicts.draftId, [...draftIds]));
  for (const row of rows) {
    const state = cardStateOf(row);
    if (state) out.set(row.draftId, state);
  }
  return out;
}

/**
 * Did this copy of a card arrive with a sound (the second check)? The staff drain sends an AI card SILENTLY in the
 * quiet hour, by its own run's clock, and records which on the copy (`rang`, notifications `shownStamp`); an edit
 * rings nothing and never rewrites it. A copy sent before the drain recorded it is judged by the drain's own rule
 * (`sendsSilently`) at the moment its row says it was sent; one never sent has not rung.
 */
export function copyRang(copy: { sentAt: Date | null; payload: unknown }): boolean {
  if (copy.sentAt === null) return false;
  const payload = typeof copy.payload === 'object' && copy.payload !== null ? (copy.payload as Record<string, unknown>) : {};
  if (typeof payload.rang === 'boolean') return payload.rang;
  return !sendsSilently('AgentDraft', payload, copy.sentAt);
}

/**
 * May a reply that counts down ride this copy of the chat's card — re-pointed at it and edited in place (the
 * final check)? Telegram rings for a message and never for an edit, and the hold is his time to read the card: a
 * copy that rang hours ago sits far up his bot chat, and an edit of it would start a countdown nothing told him of.
 * So only a copy not yet sent (its send is the drain's, after a scheduling the gate judged in the day — the second
 * check) or one that RANG within one hold before the reply was written (`copyRang`: a copy the drain sent silently
 * at 07:59 never rang); anything else — an older copy, a silent one, a send of no known time, one that never
 * reached him — gives the reply a card of its own (`createDraft`), and the old copy is closed. A reply that does not
 * count down rides any copy, as every card always has (one card per customer, fit-9). The press asks `copyRang` of
 * the copy again (`pressOne`): a send already in flight when the reply was written is decided by the drain alone.
 */
export function countdownMayRide(
  copy: { status: string; sentAt: Date | null; payload: unknown },
  plan: Pick<AutoPlan, 'dueAt' | 'holdSec'>,
): boolean {
  if (copy.status === 'pending' || copy.status === 'sending') return true;
  if (copy.status !== 'sent' || copy.sentAt === null || plan.dueAt === null || !copyRang(copy)) return false;
  const writtenAt = plan.dueAt.getTime() - plan.holdSec * 1000;
  return copy.sentAt.getTime() >= writtenAt - plan.holdSec * 1000;
}

/**
 * The verdict row, written by `createDraft` INSIDE its transaction right after
 * the draft — in a savepoint, so a refused insert costs the plan and never the
 * draft. Returns the card's state (null for an ineligible plan or a failure).
 */
export async function recordAutoVerdictInTx(
  tx: Tx,
  draft: { id: string; managerUserId: string; peerId: bigint },
  plan: AutoPlan,
): Promise<AutoCardState | null> {
  try {
    const [row] = await tx.transaction(async (sp) =>
      sp
        .insert(agentAutoVerdicts)
        .values({
          draftId: draft.id,
          managerUserId: draft.managerUserId,
          peerId: draft.peerId,
          eligible: plan.eligible,
          reasons: plan.reasons,
          category: plan.category,
          confidence: plan.confidence === null ? null : plan.confidence.toFixed(2),
          digest: plan.digest,
          state: plan.eligible ? 'waiting' : null,
          dueAt: plan.eligible ? plan.dueAt : null,
        })
        .returning(),
    );
    return row ? cardStateOf(row) : null;
  } catch (err) {
    logger.error({ err, draftId: draft.id }, '[agent] auto verdict not written');
    return null;
  }
}

// ── the press ───────────────────────────────────────────────────────────────

/** A row being pressed for longer than this died with its sweep (a deploy, a kill). */
export const AUTO_RECLAIM_MS = 5 * 60_000;
/** Rows one sweep presses — the minute's share, never a burst. */
export const AUTO_PRESS_BATCH = 20;
/**
 * A card that has not reached his Telegram yet is asked about again this much later (fix pass A, C4) — the sweep's
 * own minute: the hold starts the moment it lands, and a slower look would hold a delivered reply past its hold.
 */
export const AUTO_UNSEEN_RECHECK_MS = 60_000;

async function refreshCard(draftId: string, now?: Date): Promise<void> {
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId, [], now ? { now } : {});
  } catch (err) {
    logger.warn({ err, draftId }, '[agent] auto card not refreshed');
  }
}

/** The holder as `decideDraft` reads a decider — his roles and grants, read now. */
async function holderActor(userId: string) {
  const grants = await actorGrants(userId);
  return { id: userId, roles: grants.roles, permissions: grants.permissions };
}

/** Did the machine's press approve this draft? Its approval's audit row says `via: 'auto'`. */
async function approvedByAuto(draftId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM audit_log
                    WHERE entity_type = 'agent_draft' AND entity_id = ${draftId}::uuid
                      AND after->>'status' = 'approved' AND after->>'via' = 'auto') AS ok`);
  return rows[0]?.ok === true;
}

/**
 * A row left 'pressing' — its sweep died, or threw after the draft moved —
 * settled from the draft itself: approved by the machine's press → pressed;
 * approved by HIS press → stopped as his; still pending → waiting again (the
 * next sweep presses it, judged afresh); anything else → gone. A row a stop
 * moved meanwhile is no longer 'pressing', and nothing here revives it.
 */
async function settleFromDraft(draftId: string, now: Date): Promise<void> {
  const [d] = await db
    .select({ status: agentDrafts.status, decidedBy: agentDrafts.decidedBy, decidedAt: agentDrafts.decidedAt })
    .from(agentDrafts)
    .where(eq(agentDrafts.id, draftId));
  const pressing = and(eq(agentAutoVerdicts.draftId, draftId), eq(agentAutoVerdicts.state, 'pressing'));
  if (d?.status === 'approved' && (await approvedByAuto(draftId))) {
    await db.update(agentAutoVerdicts).set({ state: 'pressed', pressedAt: d.decidedAt ?? now }).where(pressing);
  } else if (d?.status === 'approved') {
    await db.update(agentAutoVerdicts).set({ state: 'stopped', outcome: 'owner_send', stoppedAt: d.decidedAt ?? now, stoppedBy: d.decidedBy }).where(pressing);
  } else if (d?.status === 'pending') {
    await db.update(agentAutoVerdicts).set({ state: 'waiting', claimedAt: null }).where(pressing);
  } else {
    await db.update(agentAutoVerdicts).set({ state: 'gone', outcome: d?.status ?? 'deleted' }).where(pressing);
  }
}

/**
 * Since when his Telegram has shown THIS draft's card — or null: never yet (fix
 * pass A, C4). The staff drain stamps `shown` beside `tg` when it sends the
 * card, and a successful edit re-stamps it when the card's row was re-pointed
 * at a newer draft (card-io `refreshAgentCard`, notifications'
 * after-send correction). A row re-pointed here whose edit did not land still
 * shows the PREVIOUS draft: its `shown` names that one, and this answers null.
 */
export async function cardShownAt(draftId: string, managerUserId: string): Promise<Date | null> {
  return (await cardOnScreen(draftId, managerUserId))?.at ?? null;
}

/**
 * `cardShownAt` and whether the copy showing it RANG (`copyRang`, the second check) — the press counts down only
 * on a card that arrived with a sound. Null: the card is not on his screen yet.
 */
export async function cardOnScreen(draftId: string, managerUserId: string): Promise<{ at: Date; rang: boolean } | null> {
  const [row] = await db
    .select({ at: sql<string | null>`${notifications.payload}->'shown'->>'at'`, sentAt: notifications.sentAt, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, 'AgentDraft'),
        eq(notifications.userId, managerUserId),
        eq(notifications.status, 'sent'),
        sql`${notifications.payload}->>'draftId' = ${draftId}`,
        sql`${notifications.payload}->'shown'->>'draftId' = ${draftId}`,
        sql`${notifications.payload} ? 'tg'`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  const at = row?.at ? new Date(row.at) : null;
  if (!row || !at || !Number.isFinite(at.getTime())) return null;
  return { at, rang: copyRang(row) };
}

/**
 * The press waits for the card (fix pass A, C4): due again when the card has
 * been on his screen a whole hold, or — never shown yet — asked again in a
 * minute, the row saying so («unseen», the card's words). Only a row still
 * 'pressing' moves: a ⏸ that landed meanwhile stands. The card is redrawn —
 * its time is the new one — and a redraw that put THIS draft on his screen
 * right now (an edit that landed) starts the hold from that moment at once.
 */
async function deferForCard(d: { id: string; managerUserId: string }, shownAt: Date | null, holdSec: number, now: Date): Promise<void> {
  const pressing = and(eq(agentAutoVerdicts.draftId, d.id), eq(agentAutoVerdicts.state, 'pressing'));
  if (shownAt) {
    await db
      .update(agentAutoVerdicts)
      .set({ state: 'waiting', claimedAt: null, dueAt: new Date(shownAt.getTime() + holdSec * 1000), outcome: null })
      .where(pressing);
    await refreshCard(d.id, now);
    return;
  }
  await db
    .update(agentAutoVerdicts)
    .set({ state: 'waiting', claimedAt: null, dueAt: new Date(now.getTime() + AUTO_UNSEEN_RECHECK_MS), outcome: 'unseen' })
    .where(pressing);
  await refreshCard(d.id, now);
  const landed = await cardShownAt(d.id, d.managerUserId);
  if (!landed) return;
  const moved = await db
    .update(agentAutoVerdicts)
    .set({ dueAt: new Date(landed.getTime() + holdSec * 1000), outcome: null })
    .where(and(eq(agentAutoVerdicts.draftId, d.id), eq(agentAutoVerdicts.state, 'waiting'), eq(agentAutoVerdicts.outcome, 'unseen')))
    .returning({ id: agentAutoVerdicts.draftId });
  if (moved.length > 0) await refreshCard(d.id, now);
}

type PressOutcome = 'pressed' | 'refused' | 'gone' | 'deferred' | 'stopped';

/**
 * One claimed row: the row and the draft read afresh, the gate asked afresh,
 * the card asked whether it reached him a hold ago, then the same ✅ a person
 * presses — whose approval checks the layer and the row again INSIDE its own
 * transaction (decide `auto`): a ⏸, a disarm or «Shaxsiy» that lands first
 * makes this press lose, whenever it lands.
 */
async function pressOne(row: { draftId: string; digest: string | null }, now: Date): Promise<PressOutcome> {
  const where = and(eq(agentAutoVerdicts.draftId, row.draftId), eq(agentAutoVerdicts.state, 'pressing'));
  // A stop that landed after the claim (⏸, a disarm): nothing to press. The approval's own check is the guard;
  // this only spares the work.
  const [held] = await db.select({ state: agentAutoVerdicts.state }).from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, row.draftId));
  if (held?.state !== 'pressing') return 'stopped';
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, row.draftId));
  if (!d || d.status !== 'pending') {
    await db.update(agentAutoVerdicts).set({ state: 'gone', outcome: d?.status ?? 'deleted' }).where(where);
    if (d) await refreshCard(d.id);
    return 'gone';
  }
  const config = await readAutoConfig();
  const verdict = autoVerdict(await autoFactsFor(d, { at: now, now, config }));
  // A card too long to show its whole reply draws no ✅ (card-io `renderDraftCardFull`): what a person may
  // not press from it, the machine does not press either — said as «too long», the reply being the part cut.
  if (verdict.eligible) {
    const { renderDraftCardFull } = await import('./card-io');
    if (renderDraftCardFull(d, null).tooLong) verdict.reasons.push('too_long');
    verdict.eligible = verdict.reasons.length === 0;
  }
  // The card on his screen — and whether it arrived with a sound (the second check). A copy the drain sent in the
  // quiet hour rang nothing: a countdown on it would run his ⏸ window on a message nothing announced, and nothing
  // rings it again in the morning. So it is a night card — his to decide — whatever the clock says now.
  const card = await cardOnScreen(d.id, d.managerUserId);
  if (verdict.eligible && card && !card.rang) {
    verdict.reasons.push('night');
    verdict.eligible = false;
  }
  if (!verdict.eligible) {
    await db
      .update(agentAutoVerdicts)
      .set({ state: 'refused', reasons: verdict.reasons, outcome: verdict.reasons.join(',').slice(0, 300) })
      .where(where);
    await refreshCard(d.id);
    return 'refused';
  }
  // The hold is his time to read the card: it runs from the card reaching his Telegram, never from the draft
  // being written — a paused bot queue, a re-pointed card whose edit did not land, would make it zero.
  const shownAt = card?.at ?? null;
  const holdSec = config?.holdSec ?? 120;
  if (!shownAt || shownAt.getTime() + holdSec * 1000 > now.getTime()) {
    await deferForCard(d, shownAt, holdSec, now);
    return 'deferred';
  }
  const { decideDraft } = await import('./decide');
  // A machine press: no actor in the audit row (nobody pressed), `via: 'auto'` in its `after`; the
  // decider is the holder, so `decided_by` and the action replay read the person whose account speaks.
  // The verdict becomes 'pressed' INSIDE the approval, as its last statement (decide `auto`).
  const r = await decideDraft(await holderActor(d.managerUserId), d.id, 'send', { digest: row.digest, auto: true, autoAt: now }, { actorId: null });
  if (r.ok) {
    await refreshCard(d.id);
    return 'pressed';
  }
  const code: DecideRefusal = r.code;
  // Lost to a stop inside the approval: the stop already wrote the row (and redrew the card).
  if (code === 'auto_stopped') return 'stopped';
  await db
    .update(agentAutoVerdicts)
    .set(code === 'not_live' ? { state: 'gone', outcome: code } : { state: 'refused', outcome: (r.detail ? `${code}:${r.detail}` : code).slice(0, 300) })
    .where(where);
  await refreshCard(d.id);
  return code === 'not_live' ? 'gone' : 'refused';
}

/**
 * The minute sweep's auto step (jobs `agentSweep`): reclaim what a dead sweep
 * left 'pressing', claim the due rows (`FOR UPDATE SKIP LOCKED`, so two sweeps
 * at once press each row once), and press each in its due order — never
 * throwing out of the sweep for one row. Returns how many it pressed.
 */
export async function pressDueAutos(now: Date = new Date()): Promise<number> {
  if (!(await agentAutoReady())) return 0;
  const stale = await db
    .select({ draftId: agentAutoVerdicts.draftId })
    .from(agentAutoVerdicts)
    .where(and(eq(agentAutoVerdicts.state, 'pressing'), sql`${agentAutoVerdicts.claimedAt} < ${new Date(now.getTime() - AUTO_RECLAIM_MS).toISOString()}::timestamptz`));
  for (const s of stale) {
    await settleFromDraft(s.draftId, now).catch((err: unknown) => logger.warn({ err, draftId: s.draftId }, '[agent] auto reclaim failed'));
  }
  const claimed = await db.execute<{ draft_id: string; digest: string | null; due_at: string }>(sql`
    UPDATE agent_auto_verdicts SET state = 'pressing', claimed_at = ${now.toISOString()}::timestamptz
     WHERE draft_id IN (
       SELECT draft_id FROM agent_auto_verdicts
        WHERE state = 'waiting' AND due_at <= ${now.toISOString()}::timestamptz
        ORDER BY due_at
        LIMIT ${AUTO_PRESS_BATCH}
        FOR UPDATE SKIP LOCKED)
       AND state = 'waiting'
    RETURNING draft_id::text, digest, due_at::text`);
  // RETURNING follows no ORDER BY: the batch is pressed in its due order, the earliest first.
  const batch = [...claimed].sort((x, y) => new Date(x.due_at).getTime() - new Date(y.due_at).getTime());
  let pressed = 0;
  for (const row of batch) {
    try {
      if ((await pressOne({ draftId: row.draft_id, digest: row.digest }, now)) === 'pressed') pressed += 1;
    } catch (err) {
      logger.error({ err, draftId: row.draft_id }, '[agent] auto press failed');
      await settleFromDraft(row.draft_id, now).catch(() => undefined);
    }
  }
  if (batch.length > 0) logger.info({ claimed: batch.length, pressed }, '[agent] auto presses');
  return pressed;
}

/**
 * Why the machine's press lost INSIDE its own approval (decide `auto`, fix pass A, C2/C5): a stop, a disarm — or
 * his 🙋 on the chat (`taken_over`, the final check: `autoChatTakenInTx`).
 */
export type AutoPressLoss = 'auto_stopped' | 'auto_disarmed' | 'taken_over';

/**
 * The machine's ✅, checked as the FIRST statements of its approval transaction
 * (decide `decideDraft` with `auto`): the layer's row taken FOR SHARE — alone,
 * never through a join (#1585) — and still armed, and the account still a
 * work number. FOR SHARE first is the lock order every disarm keeps («off»,
 * `forceAgentOff`, `setAutoArmed`, a step-down, «Shaxsiy raqam»: the layer's
 * row before the verdicts, the outbox and the drafts), so a disarm that took
 * the row first makes this press lose, and one that comes after waits for the
 * approval to commit — and finds its verdict 'pressed'.
 */
export async function autoPressStandsInTx(tx: Tx, managerUserId: string): Promise<AutoPressLoss | null> {
  const [config] = await tx.select({ armedAt: agentAutoConfig.armedAt }).from(agentAutoConfig).where(eq(agentAutoConfig.id, 1)).for('share');
  if (!config?.armedAt) return 'auto_disarmed';
  const [acc] = await tx.select({ work: tgAccounts.workAccount }).from(tgAccounts).where(eq(tgAccounts.managerUserId, managerUserId));
  return acc?.work === true ? null : 'auto_disarmed';
}

/**
 * His 🙋 on the chat, read INSIDE the machine's approval (the final check) — after the draft's own row is locked
 * FOR UPDATE, the conversation's row FOR SHARE, alone (#1585). `takeChatInTx` retires the chat's live drafts
 * BEFORE it upserts this row, so a 🙋 that retires this draft has taken the draft's lock first and this press
 * finds the draft moved; one that comes after waits on the draft and finds the reply queued (its withdrawal takes
 * it back). What only this read catches is a takeover written beside a draft it never retired — the gate read the
 * chat a moment before, the approval reads it now. The draft before the conversation, as `takeChatInTx` locks
 * them: never the reverse, or the two wait on each other.
 */
export async function autoChatTakenInTx(tx: Tx, managerUserId: string, peerId: bigint, now: Date = new Date()): Promise<boolean> {
  const [conv] = await tx
    .select({ humanUntil: agentConversations.humanUntil })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)))
    .for('share');
  return conv?.humanUntil != null && conv.humanUntil.getTime() > now.getTime();
}

/**
 * The verdict pressed — the approval transaction's LAST statement, a
 * compare-and-set on 'pressing': false when a stop moved the row first (⏸, a
 * person's own decision, a disarm), and the caller then rolls the whole
 * approval back. Inside the approval, so «pressed» and «approved and queued»
 * are one fact, and a stop that waits on this row finds it 'pressed'.
 */
export async function settleAutoPressInTx(tx: Tx, draftId: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(agentAutoVerdicts)
    .set({ state: 'pressed', pressedAt: at, outcome: null })
    .where(and(eq(agentAutoVerdicts.draftId, draftId), eq(agentAutoVerdicts.state, 'pressing')))
    .returning({ id: agentAutoVerdicts.draftId });
  return rows.length > 0;
}

/**
 * A draft the MACHINE approved, and where its reply is (fix pass A, C3) — or
 * null: no verdict pressed it (a person's own ✅, one migration behind), and
 * every press on it answers as it always did.
 */
export async function machinePressedReply(
  draftId: string,
): Promise<{ outbox: { id: string; status: string; readDone: boolean } | null } | null> {
  if (!(await agentAutoReady())) return null;
  const [v] = await db.select({ state: agentAutoVerdicts.state }).from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  if (v?.state !== 'pressed') return null;
  const [o] = await db
    .select({ id: agentOutbox.id, status: agentOutbox.status, readDone: agentOutbox.readDone })
    .from(agentOutbox)
    .where(eq(agentOutbox.draftId, draftId));
  return { outbox: o ?? null };
}

/** Where a reply the machine approved is, as the «kech» a press after it says — or null: it never left. */
export type AfterPress = 'pressed' | 'sending' | 'sent';

/**
 * The reply's place, for the words (fix pass A, C3): still takeable back (❌
 * «Bekor qilish»), being sent (the listener has read or claimed it), gone — or
 * null when it never left (taken back, expired, failed): then the press after
 * it answers as it always did.
 */
export function afterPressOf(o: { status: string; readDone: boolean } | null): AfterPress | null {
  if (!o) return null;
  if (autoTakeBackable(o)) return 'pressed';
  if (o.status === 'agent' || o.status === 'sending') return 'sending';
  if (o.status === 'sent' || o.status === 'unknown') return 'sent';
  return null;
}

/**
 * A draft the chat superseded leaves the layer (fix pass A, C4): its waiting
 * row is gone — never pressed, and never what ⏸ on an old card stops. Called by
 * `createDraft` after its commit (inside it would take the verdict after the
 * draft, the opposite of every disarm's order). A row being pressed is the
 * press's own: it reads the draft and calls it gone.
 */
export async function settleSupersededAuto(draftId: string): Promise<void> {
  if (!(await agentAutoReady())) return;
  await db
    .update(agentAutoVerdicts)
    .set({ state: 'gone', outcome: 'superseded' })
    .where(and(eq(agentAutoVerdicts.draftId, draftId), eq(agentAutoVerdicts.state, 'waiting')));
}

// ── a person on the card ────────────────────────────────────────────────────

/**
 * Why a waiting auto stopped because of HIM: his own decision on the card, ⏸ — or «✍️ Savolga javob» (spec
 * SPEC-P1-v2 §2.2: a question never counts down today, and the stop is the press's first act all the same).
 */
export type PersonStop = 'owner_send' | 'owner_edit' | 'owner_reject' | 'owner_human' | 'pause' | 'owner_answer';

/**
 * His own decision on a draft stops its auto — every non-auto `decideDraft`
 * (bot AND web) and his ✏️ words call this first. A row the sweep has CLAIMED
 * stops too (fix pass A, C2): its press checks the row inside its approval
 * and loses. The card is redrawn (it becomes the ordinary card).
 */
export async function stopAutoForPerson(draftId: string, actorId: string, why: PersonStop): Promise<boolean> {
  if (!(await agentAutoReady())) return false;
  const stopped = await db
    .update(agentAutoVerdicts)
    .set({ state: 'stopped', outcome: why, stoppedAt: new Date(), stoppedBy: actorId })
    .where(and(eq(agentAutoVerdicts.draftId, draftId), inArray(agentAutoVerdicts.state, ['waiting', 'pressing'])))
    .returning({ draftId: agentAutoVerdicts.draftId });
  if (stopped.length === 0) return false;
  await refreshCard(draftId);
  return true;
}

export type StopAutoRefusal = 'not_ready' | 'not_found' | 'not_account_holder' | AfterPress | 'not_waiting';

/**
 * ⏸'s answers in his words — «kech» once the machine's press went through:
 * still takeable back, the words name «❌ Bekor qilish» (fix pass A, C3).
 * The same three sentences answer a person's press after the machine's
 * (bot-door DECIDE_WORDS `auto_pressed`/`auto_sending`/`auto_sent`).
 */
export const STOP_AUTO_WORDS: Record<StopAutoRefusal, string> = {
  not_ready: 'Server hali yangilanmagan — o‘zi yuborish yo‘q.',
  not_found: 'Bu javob o‘zi yuborilmaydi.',
  not_account_holder: 'Bu javob sizning akkauntingizdan emas.',
  pressed: 'Kech — AI javobni o‘zi tasdiqladi. Ketmasin desangiz, kartadagi «❌ Bekor qilish»ni bosing.',
  sending: 'Kech — javob yuborilmoqda.',
  sent: 'Kech — javob yuborildi.',
  not_waiting: 'Bu javob endi o‘zi ketmaydi.',
};

/**
 * ⏸ «To‘xtat»: the holder alone; the auto becomes his card again — waiting, or
 * claimed by the sweep and not yet pressed (fix pass A, C2: the press checks
 * the row inside its approval and loses, so «To‘xtatildi» is true).
 *
 * A card whose draft is no longer the chat's live reply (fix pass A, C4) — a
 * newer customer line re-pointed the card's row at a newer draft and the edit
 * did not land, so his screen still shows the old draft's ⏸: his press is
 * about this chat's card, so it stops the chat's LIVE reply, and the old
 * draft's own row leaves the layer. No live reply counting down: «it will not
 * go» — never «To‘xtatildi» about a row nothing would have pressed.
 */
export async function stopAuto(staffId: string, draftId: string): Promise<{ ok: true } | { ok: false; code: StopAutoRefusal }> {
  if (!(await agentAutoReady())) return { ok: false, code: 'not_ready' };
  const [row] = await db
    .select({
      managerUserId: agentAutoVerdicts.managerUserId,
      peerId: agentAutoVerdicts.peerId,
      state: agentAutoVerdicts.state,
      draftStatus: agentDrafts.status,
    })
    .from(agentAutoVerdicts)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentAutoVerdicts.draftId))
    .where(eq(agentAutoVerdicts.draftId, draftId));
  if (!row || row.state === null) return { ok: false, code: 'not_found' };
  if (row.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  if (row.draftStatus === 'pending' || row.draftStatus === 'editing') {
    if (await stopAutoForPerson(draftId, staffId, 'pause')) return { ok: true };
    return { ok: false, code: await notStoppedWhy(draftId) };
  }
  if (row.state === 'pressed') {
    const pressed = await machinePressedReply(draftId);
    return { ok: false, code: afterPressOf(pressed?.outbox ?? null) ?? 'not_waiting' };
  }
  // A dead card: its own row leaves the layer, and the press follows the card to the chat's live reply.
  await db
    .update(agentAutoVerdicts)
    .set({ state: 'gone', outcome: row.draftStatus })
    .where(and(eq(agentAutoVerdicts.draftId, draftId), eq(agentAutoVerdicts.state, 'waiting')));
  const [live] = await db
    .select({ draftId: agentAutoVerdicts.draftId })
    .from(agentAutoVerdicts)
    .innerJoin(agentDrafts, eq(agentDrafts.id, agentAutoVerdicts.draftId))
    .where(
      and(
        eq(agentAutoVerdicts.managerUserId, row.managerUserId),
        eq(agentAutoVerdicts.peerId, row.peerId),
        inArray(agentAutoVerdicts.state, ['waiting', 'pressing']),
        eq(agentDrafts.status, 'pending'),
      ),
    )
    .orderBy(desc(agentAutoVerdicts.createdAt))
    .limit(1);
  if (live && (await stopAutoForPerson(live.draftId, staffId, 'pause'))) {
    await refreshCard(draftId);
    return { ok: true };
  }
  return { ok: false, code: live ? await notStoppedWhy(live.draftId) : 'not_waiting' };
}

/**
 * Why ⏸ stopped nothing (fix pass C, FIX-REGRESS-1): the row read a moment
 * ago as waiting or claimed may have been pressed since — the machine's
 * approval committing between that read and the stop, the stop waiting on its
 * verdict row and finding it 'pressed'. Then «kech», with where the reply is
 * (still takeable back: «❌ Bekor qilish»), as `stopAutoForEdit` answers —
 * never «Bu javob endi o‘zi ketmaydi» about a reply that is going.
 */
async function notStoppedWhy(draftId: string): Promise<AfterPress | 'not_waiting'> {
  return afterPressOf((await machinePressedReply(draftId))?.outbox ?? null) ?? 'not_waiting';
}

/**
 * The page's ✏️, BEFORE its box opens (fix pass B, C1). The bot's ✏️ is a
 * decision (`decideDraft` 'edit') and stops the countdown there; the page's is
 * a box that writes nothing until «Saqlash» — so his typing would race the
 * machine, which presses the AI's own text at its due minute and leaves his
 * «Saqlash» «faol emas». The countdown stops HERE, on the server, as his ✏️
 * («owner_edit»), and only then does the box open: a row the sweep claimed
 * stops too (its press loses inside its approval, fix pass A). A reply the
 * machine already approved answers «kech» in ⏸'s own words, and the box stays
 * shut. A card that never counted down — every card while the layer was never
 * armed, one migration behind — opens its box as it always did, nothing
 * written.
 */
export async function stopAutoForEdit(
  staffId: string,
  draftId: string,
): Promise<{ ok: true; stopped: boolean } | { ok: false; code: 'not_account_holder' | AfterPress }> {
  if (!(await agentAutoReady())) return { ok: true, stopped: false };
  const read = async () =>
    (
      await db
        .select({ managerUserId: agentAutoVerdicts.managerUserId, state: agentAutoVerdicts.state })
        .from(agentAutoVerdicts)
        .where(eq(agentAutoVerdicts.draftId, draftId))
    )[0];
  const row = await read();
  if (!row || row.state === null) return { ok: true, stopped: false };
  if (row.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  if (row.state !== 'pressed' && (await stopAutoForPerson(draftId, staffId, 'owner_edit'))) return { ok: true, stopped: true };
  // Nothing stopped: the machine's press may have gone through a moment ago — then the box stays shut.
  const fresh = row.state === 'pressed' ? row : await read();
  if (fresh?.state === 'pressed') {
    const after = afterPressOf((await machinePressedReply(draftId))?.outbox ?? null);
    if (after) return { ok: false, code: after };
  }
  return { ok: true, stopped: false };
}

// ── step-downs ──────────────────────────────────────────────────────────────

/** How far back a step-down looks, and how long a chat stays out of the layer. */
export const AUTO_STEP_DOWN = { windowMs: 7 * 86_400_000, chatOffMs: 30 * 86_400_000, feedbackToDisarm: 2, botQuestionChatsToDisarm: 2 } as const;

type StepDownReason = Extract<AutoDisarmReason, 'feedback' | 'blocked' | 'bot_question'>;

/** Pure: the alarm a step-down raises — the reason (auto-card's one map), what stays, and that re-arming is his. No customer in it. */
export function autoDisarmAlarmText(reason: StepDownReason): string {
  return (
    `⚠️ AI o‘zi yuborishi o‘chirildi. Sabab: ${AUTO_DISARM_WORDS[reason]}.\n` +
    `AI qoralama yozishda davom etadi — har bir javobni siz ✅ bilan yuborasiz. ` +
    `Qayta yoqish faqat sizning bosishingiz bilan.`
  );
}

/**
 * Disarm by itself, with ONE alarm to the holder and every super_admin (the
 * account's alarms ride the bot — crm/account-alarm's rule): only when it WAS
 * armed, so a second step-down on the same day is silent. The replies it
 * stopped get their cards back as ordinary cards.
 */
async function stepDown(reason: StepDownReason, holderId: string): Promise<boolean> {
  // «Stop sending by yourself»: what it approved and has not yet sent is taken back too (fix pass A, C5).
  const out = await db.transaction((tx) => disarmAutoInTx(tx, reason, null, { takeBack: true }));
  for (const id of [...out.stoppedDraftIds, ...out.takenBackDraftIds]) await refreshCard(id);
  if (!out.wasArmed) return false;
  const supers = await usersWithRoles(['super_admin']);
  await notifyStaffTelegram({ userIds: [holderId, ...supers], type: 'AgentForcedOff', text: autoDisarmAlarmText(reason) });
  logger.warn({ reason }, '[agent] auto-send disarmed itself');
  return true;
}

/** The chat stays out of the layer for 30 days — the later of what it already had and this. */
async function chatOff(managerUserId: string, peerId: bigint, reason: string, now: Date): Promise<void> {
  const until = new Date(now.getTime() + AUTO_STEP_DOWN.chatOffMs);
  await db
    .insert(agentAutoChats)
    .values({ managerUserId, peerId, offUntil: until, reason, updatedAt: now })
    .onConflictDoUpdate({
      target: [agentAutoChats.managerUserId, agentAutoChats.peerId],
      // `${table}.column`: inside ON CONFLICT the bare name is the proposed row's as much as the existing one's.
      set: { offUntil: sql`greatest(${agentAutoChats}.off_until, ${until.toISOString()}::timestamptz)`, reason, updatedAt: now },
    });
}

/** Did this chat get an auto reply within the step-down window? */
async function autoPressedInChat(managerUserId: string, peerId: bigint, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: agentAutoVerdicts.draftId })
    .from(agentAutoVerdicts)
    .where(
      and(
        eq(agentAutoVerdicts.managerUserId, managerUserId),
        eq(agentAutoVerdicts.peerId, peerId),
        eq(agentAutoVerdicts.state, 'pressed'),
        gte(agentAutoVerdicts.pressedAt, new Date(now.getTime() - AUTO_STEP_DOWN.windowMs)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export type AutoFeedbackRefusal = 'not_ready' | 'not_found' | 'not_account_holder' | 'not_sent' | 'already';

export const AUTO_FEEDBACK_WORDS: Record<AutoFeedbackRefusal, string> = {
  not_ready: 'Server hali yangilanmagan.',
  // No row at all — a purged chat took it (fix pass B, C7): never «o‘zi yuborilmagan» about a reply that was.
  not_found: 'Bu javob topilmadi.',
  not_account_holder: 'Bu javob sizning akkauntingizdan emas.',
  not_sent: 'Bu javob o‘zi yuborilmagan.',
  already: 'Allaqachon belgilangan.',
};

/**
 * 👎 «Xato edi» on a reply the machine sent: the holder alone, once. The chat
 * leaves the layer for 30 days; two in seven days disarm it (step-down).
 */
export async function autoFeedback(
  staffId: string,
  draftId: string,
  now: Date = new Date(),
): Promise<{ ok: true; disarmed: boolean } | { ok: false; code: AutoFeedbackRefusal }> {
  if (!(await agentAutoReady())) return { ok: false, code: 'not_ready' };
  const [row] = await db
    .select({ managerUserId: agentAutoVerdicts.managerUserId, peerId: agentAutoVerdicts.peerId, state: agentAutoVerdicts.state, feedback: agentAutoVerdicts.feedback })
    .from(agentAutoVerdicts)
    .where(eq(agentAutoVerdicts.draftId, draftId));
  if (!row) return { ok: false, code: 'not_found' };
  if (row.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  // A reply the gate refused at the scheduling (no state), or one the machine never pressed: not its own.
  if (row.state !== 'pressed') return { ok: false, code: 'not_sent' };
  const marked = await db
    .update(agentAutoVerdicts)
    .set({ feedback: 'bad', feedbackAt: now })
    .where(and(eq(agentAutoVerdicts.draftId, draftId), eq(agentAutoVerdicts.state, 'pressed'), isNull(agentAutoVerdicts.feedback)))
    .returning({ id: agentAutoVerdicts.draftId });
  if (marked.length === 0) return { ok: false, code: 'already' };
  await chatOff(row.managerUserId, row.peerId, 'feedback', now);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentAutoVerdicts)
    .where(
      and(
        eq(agentAutoVerdicts.managerUserId, row.managerUserId),
        eq(agentAutoVerdicts.feedback, 'bad'),
        gte(agentAutoVerdicts.feedbackAt, new Date(now.getTime() - AUTO_STEP_DOWN.windowMs)),
      ),
    );
  const disarmed = Number(count?.n ?? 0) >= AUTO_STEP_DOWN.feedbackToDisarm ? await stepDown('feedback', row.managerUserId) : false;
  await refreshCard(draftId);
  return { ok: true, disarmed };
}

/**
 * A customer who got an auto reply within seven days turned out to have
 * BLOCKED the account (outbox-store's `recipient_final` branch): the layer
 * disarms itself. Called on the listener's pump — never throws.
 */
export async function autoStepDownOnBlock(managerUserId: string, peerId: bigint, now: Date = new Date()): Promise<boolean> {
  try {
    if (!(await agentAutoReady())) return false;
    if (!(await autoPressedInChat(managerUserId, peerId, now))) return false;
    return await stepDown('blocked', managerUserId);
  } catch (err) {
    logger.error({ err }, '[agent] auto block step-down failed');
    return false;
  }
}

/**
 * «Siz botmisiz?» in a chat that got an auto reply within seven days (run's
 * `bot_question` notice): that chat leaves the layer for 30 days, and a
 * SECOND such chat within seven days disarms it. Never throws.
 */
export async function autoStepDownOnBotQuestion(managerUserId: string, peerId: bigint, now: Date = new Date()): Promise<{ chatOff: boolean; disarmed: boolean }> {
  try {
    if (!(await agentAutoReady())) return { chatOff: false, disarmed: false };
    if (!(await autoPressedInChat(managerUserId, peerId, now))) return { chatOff: false, disarmed: false };
    await chatOff(managerUserId, peerId, 'bot_question', now);
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentAutoChats)
      .where(
        and(
          eq(agentAutoChats.managerUserId, managerUserId),
          eq(agentAutoChats.reason, 'bot_question'),
          gte(agentAutoChats.updatedAt, new Date(now.getTime() - AUTO_STEP_DOWN.windowMs)),
        ),
      );
    const disarmed = Number(count?.n ?? 0) >= AUTO_STEP_DOWN.botQuestionChatsToDisarm ? await stepDown('bot_question', managerUserId) : false;
    return { chatOff: true, disarmed };
  } catch (err) {
    logger.error({ err }, '[agent] auto bot-question step-down failed');
    return { chatOff: false, disarmed: false };
  }
}

// ── arming ──────────────────────────────────────────────────────────────────

export type AutoConfigRefusal = 'not_ready' | 'forbidden' | 'not_account_holder' | 'agent_off' | 'not_work_account' | 'bad_value';

export class AutoConfigError extends Error {
  constructor(public readonly code: AutoConfigRefusal) {
    super(code);
  }
}

/** Every refusal of the arming doors, in his words. */
export const AUTO_CONFIG_WORDS: Record<AutoConfigRefusal, string> = {
  not_ready: 'Server hali yangilanmagan — o‘zi yuborish yo‘q.',
  forbidden: 'Buni faqat akkaunt egasi yoki super admin qila oladi.',
  not_account_holder: 'O‘zi yuborishni faqat akkaunt egasi yoqadi.',
  agent_off: 'Avval AI sotuvchini yoqing.',
  not_work_account: 'Avval raqamni «Ish raqami» deb belgilang.',
  bad_value: 'Noto‘g‘ri qiymat.',
};

type AutoActor = { id: string; roles: readonly string[] };

const AUTO_AUDIT_ID = '00000000-0000-0000-0000-000000000143';

/** Is this person's connected account marked «Ish raqami» — false with none (the gate's own fact, `autoFactsFor`). */
export async function workAccountOf(userId: string): Promise<boolean> {
  const [acc] = await db.select({ work: tgAccounts.workAccount }).from(tgAccounts).where(eq(tgAccounts.managerUserId, userId));
  return acc?.work === true;
}

/**
 * Arm or disarm «o'zi yuborish». Arming is the ACCOUNT HOLDER's alone (his
 * answer 15: a message leaves a personal account only by its holder), only
 * while the agent runs, and only on a number marked «Ish raqami» (his Q5 ⭐);
 * it clears the last disarm. Disarming is open to the holder and any
 * super_admin — an off switch never waits for one person. Audited.
 */
export async function setAutoArmed(actor: AutoActor, armed: boolean, ctx: AuditContext): Promise<AutoConfig> {
  if (!(await agentAutoReady())) throw new AutoConfigError('not_ready');
  const pre = await readAgentConfig();
  if (armed) {
    if (!pre?.ownerUserId || actor.id !== pre.ownerUserId) throw new AutoConfigError('not_account_holder');
    if (!agentRunning(pre)) throw new AutoConfigError('agent_off');
    if (!(await workAccountOf(pre.ownerUserId))) throw new AutoConfigError('not_work_account');
  } else if (!mayRunAgent(actor, pre)) {
    throw new AutoConfigError('forbidden');
  }
  const out = await db.transaction(async (tx) => {
    // agent_config first, then the layer's row — the order «off» locks them in (config `setAgentMode`).
    const [agent] = await tx.select().from(agentConfig).where(eq(agentConfig.id, 1)).for('share');
    if (armed && (agent?.mode !== 'shadow' || agent.ownerUserId !== actor.id)) throw new AutoConfigError('agent_off');
    const [before] = await tx.select().from(agentAutoConfig).where(eq(agentAutoConfig.id, 1)).for('update');
    if (!before) throw new AutoConfigError('not_ready');
    const now = new Date();
    let stopped: string[] = [];
    let takenBack: string[] = [];
    if (armed) {
      await tx
        .update(agentAutoConfig)
        .set({ armedAt: before.armedAt ?? now, armedBy: before.armedBy ?? actor.id, disarmedAt: null, disarmReason: null, updatedAt: now })
        .where(eq(agentAutoConfig.id, 1));
    } else {
      // His «o‘chirish» means «stop sending by yourself»: a reply pressed a second before it is taken back too.
      const off = await disarmAutoInTx(tx, 'manual', actor.id, { takeBack: true });
      stopped = off.stoppedDraftIds;
      takenBack = off.takenBackDraftIds;
    }
    await writeAudit(tx, ctx, {
      entityType: 'agent_auto_config',
      entityId: AUTO_AUDIT_ID,
      action: 'update',
      before: { armed: before.armedAt !== null },
      after: { armed, ...(stopped.length > 0 ? { stopped: stopped.length } : {}), ...(takenBack.length > 0 ? { takenBack: takenBack.length } : {}) },
    });
    const [row] = await tx.select().from(agentAutoConfig).where(eq(agentAutoConfig.id, 1));
    return { config: toAutoConfig(row!), cards: [...stopped, ...takenBack] };
  });
  for (const id of out.cards) await refreshCard(id);
  return out.config;
}

/**
 * Which kinds of reply may go by themselves — the holder's choice among the five, at least one. Audited. The
 * fifth, `price`, is admitted by 0148's CHECK alone: one migration behind it is refused in words, never a 23514.
 */
export async function setAutoCategories(actor: AutoActor, categories: readonly string[], ctx: AuditContext): Promise<AutoConfig> {
  const chosen = [...new Set(categories)];
  if (chosen.length === 0 || chosen.some((c) => !(AUTO_SEND_CATEGORIES as readonly string[]).includes(c))) throw new AutoConfigError('bad_value');
  if (!(await agentAutoReady())) throw new AutoConfigError('not_ready');
  if (chosen.includes('price') && !(await agentFullP1Ready())) throw new AutoConfigError('not_ready');
  const pre = await readAgentConfig();
  if (!pre?.ownerUserId || actor.id !== pre.ownerUserId) throw new AutoConfigError('not_account_holder');
  // In the design's own order, so the stored list never depends on the order of the boxes.
  const ordered = AUTO_SEND_CATEGORIES.filter((c) => chosen.includes(c));
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(agentAutoConfig).where(eq(agentAutoConfig.id, 1)).for('update');
    if (!before) throw new AutoConfigError('not_ready');
    const [row] = await tx
      .update(agentAutoConfig)
      .set({ categories: [...ordered], updatedAt: new Date() })
      .where(eq(agentAutoConfig.id, 1))
      .returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_auto_config',
      entityId: AUTO_AUDIT_ID,
      action: 'update',
      before: { categories: before.categories },
      after: { categories: ordered },
    });
    return toAutoConfig(row!);
  });
}

/** The bounds a typed daily count keeps (0148's CHECK); null is «no cap». */
export const AUTO_PER_DAY_MAX = 1000;

/**
 * The layer's daily count (spec §5.1, his «7 chegara qoyma»): null = no cap, or a whole number he types, 1 to
 * `AUTO_PER_DAY_MAX`. The holder's alone, as the kinds are. One migration behind it is refused in words (the
 * column is NOT NULL and bounded 1-80 there). Audited.
 */
export async function setAutoPerDay(actor: AutoActor, perDay: number | null, ctx: AuditContext): Promise<AutoConfig> {
  if (perDay !== null && !(Number.isInteger(perDay) && perDay >= 1 && perDay <= AUTO_PER_DAY_MAX)) throw new AutoConfigError('bad_value');
  if (!(await agentAutoReady()) || !(await agentFullP1Ready())) throw new AutoConfigError('not_ready');
  const pre = await readAgentConfig();
  if (!pre?.ownerUserId || actor.id !== pre.ownerUserId) throw new AutoConfigError('not_account_holder');
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(agentAutoConfig).where(eq(agentAutoConfig.id, 1)).for('update');
    if (!before) throw new AutoConfigError('not_ready');
    const [row] = await tx.update(agentAutoConfig).set({ perDay, updatedAt: new Date() }).where(eq(agentAutoConfig.id, 1)).returning();
    await writeAudit(tx, ctx, {
      entityType: 'agent_auto_config',
      entityId: AUTO_AUDIT_ID,
      action: 'update',
      before: { perDay: before.perDay },
      after: { perDay },
    });
    return toAutoConfig(row!);
  });
}

/**
 * Tests: put the layer's singleton back the way a file found it (#183 — a
 * configuration row is the next file's input on the one shared database).
 */
export async function __restoreAutoConfig(snapshot: AutoConfig | null): Promise<void> {
  if (!snapshot) return;
  await db
    .update(agentAutoConfig)
    .set({
      armedAt: snapshot.armedAt,
      armedBy: snapshot.armedBy,
      holdSec: snapshot.holdSec,
      perDay: snapshot.perDay,
      maxChars: snapshot.maxChars,
      minConfidence: snapshot.minConfidence.toFixed(2),
      categories: snapshot.categories,
      disarmedAt: snapshot.disarmedAt,
      disarmReason: snapshot.disarmReason,
    })
    .where(eq(agentAutoConfig.id, 1));
}

/** The newest verdict rows of a chat — the page's and the tests' reader. */
export async function autoVerdictsOf(managerUserId: string, peerId: bigint) {
  if (!(await agentAutoReady())) return [];
  return db
    .select()
    .from(agentAutoVerdicts)
    .where(and(eq(agentAutoVerdicts.managerUserId, managerUserId), eq(agentAutoVerdicts.peerId, peerId)))
    .orderBy(desc(agentAutoVerdicts.createdAt));
}
