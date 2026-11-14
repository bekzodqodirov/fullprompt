import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { aiConfigured, realCallModel, STAFF_MODEL, type CallModel, type ModelBlock, type ModelMessage, type ModelUsage } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { agentConversations, agentRuns, clients, tgChatRules, tgMessageFlags, tgMessages, tgOutbox, users } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { canLogInSql } from '../../platform/users/login';
import { pumpIsFresh, readGuard } from '../crm/account-guard';
import { lateNote } from './card';
import { agentRunning, agentTablesReady, readAgentConfig, type AgentConfig } from './config';
import { chatForm, loadContext, type AgentContext, type AviaCargo, type ChatMessage, type QuotedRoad } from './context';
import { eligibleForRun, type Ineligible } from './eligibility';
import { generalFacts, kbSearch, type KbHit } from './kb';
import type { PromptLesson } from './lesson-rules';
import { promptLessons } from './lessons';
import { AGENT_LIMITS } from './limits';
import { detectLocale, dominantScript, greetingLean, uzbekEndingLean, type AgentLocale } from './locale';
import { askedLocation, customerNumberSources, policyFor, splitUrls, type PolicyMemory } from './policy-input';
import { chatBlock, runTail, stableHead } from './prompt';
import { EDIT_ATTEMPT_BASE, JOB_AGENT_INBOUND, type AgentInboundJob } from './queues';
import { capReached, dayRunCounts } from './today';
import { addsALoadIn, belowTruckMinimumFacts, ourChinaPlaces, runTool, TOOL_SPECS, TRUCK_SECTIONS, type ChecklistState, type ToolOutcome } from './tools';
import { namedOrigins, originMentions } from './origin';
import { draftWorthy, mentionsRail, RAIL_OWNER_QUESTION } from './worthy';
import { draftFromRun, writeDraft, writeNotice, type ComposedAction } from './drafts';
import { knownNamesFor } from './chat-names';
import { answerHoldsFigure, ownerPersonalOf } from './owner-answer';
import type { ForcedQuestion } from './types';
import { autoPlanFor, autoShapeOf, autoStepDownOnBotQuestion, priceActArmed } from './auto-send';
import { namesForeignPlace } from './destination';
import {
  airMentionIn,
  extractNumbers,
  factSources,
  namesMode,
  ownerAnswerSources,
  oneModeIn,
  pricedRoadOf,
  PROHIBITS,
  railRefusedIn,
  roadChoiceIn,
  statementsOf,
  type NumberSource,
  type TravelMode,
} from './numbers';
import { hanOnly, nameWordsOf, type PolicyResult } from './policy';
import { AGENT_LOCALES } from './locale';

/**
 * One run of the AI sotuvchi for one customer message (spec §17.3).
 *
 * In order, and each step's refusal is the cheap one: stand down unless the
 * message is still the chat's newest (the debounce); wait while the customer
 * is still typing; ask whether the burst deserves a reply at all
 * (`draftWorthy`, before anything is reserved — fit-1); ask whether this chat
 * may be drafted in (`eligibleForRun`); RESERVE the run under one advisory
 * lock against the day's caps, failing closed (money-11); then the model, the
 * policy, and the draft with its card in one short transaction.
 *
 * Runs in the APP's pg-boss worker — never in the listener, whose per-peer
 * chain is sequential (#706 one process over).
 */

export interface RunDeps {
  callModel?: CallModel;
  now?: () => Date;
  /** Tests: the re-scheduling enqueue. */
  enqueue?: (job: AgentInboundJob, startAfterS: number) => Promise<void>;
}

export type RunResult =
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'stood_down'; reason: string }
  | { outcome: 'rescheduled'; reason: string }
  | { outcome: 'refused'; reason: Ineligible }
  | { outcome: 'capped'; reason: string }
  | { outcome: 'notice'; reason: string }
  | { outcome: 'no_reply' }
  | { outcome: 'draft'; draftId: string; blocked: boolean }
  | { outcome: 'error'; reason: string };

export interface ComposeReply {
  replyNeeded: boolean;
  replyText: string;
  language: AgentLocale;
  glossUz: string;
  category: string;
  /** 0-1, the model's own judgement that he sends it unchanged; null = it gave none we can read (#1625). */
  confidence: number | null;
  needsOwner: boolean;
  ownerQuestion: string;
  nextStep: string;
  actions: { type: string; section: string; citedMessageRefs: string[]; date: string; note: string }[];
  usedFactIds: string[];
  citedMessageRefs: string[];
  /**
   * Set by the rule that FORCED the question to him — rail's price (`withRailRule`) or the flight's address
   * (`withAviaQuestion`) — never by the model (spec SPEC-P1-v2 §2.2): his answer to such a question goes verbatim
   * through ✏️, so its card offers no «✍️ Savolga javob». Kept on the draft's policy (drafts `draftFromRun`).
   */
  forcedQuestion?: ForcedQuestion;
}

interface LoopResult {
  compose: ComposeReply;
  tools: { name: string; ok: boolean; text: string; estimate: boolean }[];
  outcomes: ToolOutcome[];
  usage: ModelUsage;
}

const CAP_LOCK = 'agent_run_cap';
const LOOP_WALL_MS = 90_000;

/**
 * Look again shortly — as the SAME ask: the attempt this job runs as is fixed
 * now and carried (an edit's 100 + n is counted from the ledger, and the next
 * look would count again and land on 0 or on the draft's own slot), and the
 * asker's origin stays, so the late note and the `[agent] inbound` line still
 * name who asked (review: an edit that met the customer typing came back as
 * 'typing_wait' on attempt 0, stood down as a duplicate of the draft it was
 * re-thinking, and the card his press had promised never came).
 */
async function reschedule(job: AgentInboundJob, attempt: number, startAfterS: number, deps: RunDeps, waited: 'typing' | 'greeting'): Promise<void> {
  const next: AgentInboundJob = { ...job, attempt, waited };
  if (deps.enqueue) return deps.enqueue(next, startAfterS);
  await enqueue(JOB_AGENT_INBOUND, next, { startAfter: Math.max(1, Math.round(startAfterS)), retryLimit: 0 });
}

/** The ledger row for a run that never reached the model — one per anchor and attempt, idempotent. */
async function runLedgerRow(job: AgentInboundJob, attempt: number, outcome: 'refused' | 'notice' | 'capped', error: string): Promise<boolean> {
  const rows = await db
    .insert(agentRuns)
    .values({
      managerUserId: job.managerUserId,
      peerId: BigInt(job.peerId),
      trigger: 'inbound',
      anchorTgMessageId: BigInt(job.anchorTgMessageId),
      attempt,
      outcome,
      error,
    })
    .onConflictDoNothing()
    .returning({ id: agentRuns.id });
  return rows.length > 0;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The model's `confidence` as stored (#1625): a number from 0 to 1 — the
 * chance, in its own judgement, that he sends the text unchanged — kept to
 * two places, the column's scale. Anything else is UNKNOWN (null), never
 * clamped: «85» used to become 1.00 and «-1» 0, two confident numbers nobody
 * gave. Strict tool schemas cannot carry a range, so this is the range.
 */
export function confidenceOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
  return Math.round(v * 100) / 100;
}

function parseCompose(input: Record<string, unknown>): ComposeReply {
  const lang = AGENT_LOCALES.find((l) => l === input.language) ?? 'uz';
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : [];
  return {
    replyNeeded: input.reply_needed !== false,
    replyText: asText(input.reply_text).trim(),
    language: lang,
    glossUz: asText(input.gloss_uz).trim(),
    category: asText(input.category) || 'other',
    confidence: confidenceOf(input.confidence),
    needsOwner: input.needs_owner === true,
    ownerQuestion: asText(input.owner_question).trim(),
    nextStep: asText(input.next_step) || 'wait',
    actions: actions.map((a) => ({
      type: asText(a.type),
      section: asText(a.section),
      citedMessageRefs: Array.isArray(a.cited_message_refs) ? (a.cited_message_refs as unknown[]).map(String) : [],
      date: asText(a.date),
      note: asText(a.note),
    })),
    usedFactIds: Array.isArray(input.used_fact_ids) ? (input.used_fact_ids as unknown[]).map(String) : [],
    citedMessageRefs: Array.isArray(input.cited_message_refs) ? (input.cited_message_refs as unknown[]).map(String) : [],
  };
}

/** The model loop: tools until `compose_reply`, at most `maxToolRounds`, inside a wall clock. */
export async function runLoop(input: {
  ctx: AgentContext;
  config: AgentConfig;
  facts: KbHit[];
  day: string;
  canary: string;
  callModel: CallModel;
  now: () => Date;
  /** A run the OWNER's side started (a hand-back): what it is for, after the chat. */
  instruction?: string;
  /** His price act (spec §1.2, `priceActArmed`), read ONCE for the run — the head and the avia tool say the same. */
  priceArmed: boolean;
  /**
   * His lessons (spec §3.3, lessons `promptLessons`), read ONCE for the run beside the general facts: every round's
   * head is then the same bytes — an edit on the page mid-run cannot move the cache between two rounds.
   */
  lessons: readonly PromptLesson[];
}): Promise<LoopResult> {
  const { ctx } = input;
  const started = input.now().getTime();
  const opening = input.instruction ? `${chatBlock(ctx)}\n\nVAZIFA: ${input.instruction}` : chatBlock(ctx);
  // The chat is the same bytes in every round of this run: cached once, read at a tenth of the price after
  // (#1622 — a hundred messages re-billed per tool round is what would have made the wider window expensive).
  const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: opening, cache: true }] }];
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const tools: LoopResult['tools'] = [];
  const outcomes: ToolOutcome[] = [];
  let places: Promise<ReadonlySet<string>> | null = null;
  const env = {
    ctx,
    day: input.day,
    aviaUsdPerKg: input.config.aviaUsdPerKg,
    // A client's own facts only for a chat that PROVES it is that client (identity review B7): a typed
    // code or the web tray's «Bu mijoz» without the phone on the card names the client and serves none
    // of his cargo or money — and none of his facts either. The general ones stand for everyone.
    kb: (q: string) =>
      kbSearch({ clientIds: ctx.identity.cargoAllowed ? ctx.identity.codes.map((c) => c.id) : [], leadId: ctx.identity.leadId }, q),
    // Read once per run, and only when a tool asks where the cargo starts.
    chinaPlaces: () => (places ??= ourChinaPlaces()),
    priceArmed: input.priceArmed,
  };
  for (let round = 0; round < AGENT_LIMITS.maxToolRounds; round++) {
    if (input.now().getTime() - started > LOOP_WALL_MS) throw new Error('wall_clock');
    const res = await input.callModel({
      model: STAFF_MODEL,
      systemCached: stableHead({
        styleGuide: input.config.styleApprovedAt ? input.config.styleGuide : null,
        facts: input.facts,
        priceArmed: input.priceArmed,
        lessons: input.lessons,
      }),
      system: runTail({ day: input.day, canary: input.canary }),
      messages,
      tools: TOOL_SPECS,
      maxTokens: 1_500,
    });
    if (res.usage) {
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;
      usage.cacheWriteTokens += res.usage.cacheWriteTokens;
    }
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b): b is Extract<ModelBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const compose = uses.find((u) => u.name === 'compose_reply');
    if (compose) return { compose: parseCompose(compose.input), tools, outcomes, usage };
    if (uses.length === 0) throw new Error(res.stopReason === 'max_tokens' ? 'max_tokens' : 'no_compose');
    const results: ModelBlock[] = [];
    for (const u of uses) {
      let out: ToolOutcome;
      try {
        out = await runTool(u.name, u.input, env);
      } catch (err) {
        logger.warn({ err, tool: u.name }, '[agent] tool failed');
        out = { ok: false, text: 'Vosita ishlamadi — buni aytma, needs_owner.', sources: [] };
      }
      // The estimate flag is the TOOL's own (`ToolOutcome.estimate`: a priced yo'lkira or avia answer), never read
      // off its text: `below_minimum` and every refusal carry false (spec §1.1).
      tools.push({ name: u.name, ok: out.ok, text: out.text.slice(0, 500), estimate: out.estimate === true });
      outcomes.push(out);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out.text, ...(out.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('too_many_rounds');
}

/** Facts about this chat for `eligibleForRun`, read now. */
async function eligibilityFacts(ctx: AgentContext, config: AgentConfig, now: Date) {
  const [acc] = await db.execute<{ id: string }>(sql`SELECT id FROM tg_accounts WHERE manager_user_id = ${ctx.managerUserId}`);
  const guard = acc ? await readGuard(acc.id) : null;
  const [conv] = await db
    .select({ humanUntil: agentConversations.humanUntil, mutedAt: agentConversations.mutedAt })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, ctx.managerUserId), eq(agentConversations.peerId, ctx.peerId)));

  // A person's own message in this chat — his phone, a colleague in the CRM — within the pause. Asked of the
  // chat itself and not of a window (#1623): thirty photos after his reply pushed it out of the window, and the AI
  // drafted while he was mid-conversation. Live rows only, as the window reads them; the AI's own sends are not his,
  // and neither is the account's robot — a Telegram Business greeting or away message (`auto_sent`, #1568's «the
  // account's robot is not a person»): reached over the whole pause now, it would stand the AI down exactly while he
  // is away (#1627).
  const pauseMs = config.humanPauseMin * 60_000;
  const humanSince = new Date(now.getTime() - pauseMs);
  const [lastHuman] = await db
    .select({ sentAt: tgMessages.sentAt })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, ctx.managerUserId),
        eq(tgMessages.peerId, ctx.peerId),
        eq(tgMessages.direction, 'out'),
        gt(tgMessages.sentAt, humanSince),
        isNull(tgMessageFlags.deletedAt),
        sql`coalesce(${tgMessageFlags.autoSent}, false) = false`,
        sql`NOT EXISTS (SELECT 1 FROM agent_outbox o WHERE o.manager_user_id = ${tgMessages}.manager_user_id AND o.peer_id = ${tgMessages}.peer_id AND o.tg_message_id = ${tgMessages}.tg_message_id)`,
      ),
    )
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  const [queued] = await db
    .select({ id: tgOutbox.id })
    .from(tgOutbox)
    .where(and(eq(tgOutbox.managerUserId, ctx.managerUserId), eq(tgOutbox.peerId, ctx.peerId), inArray(tgOutbox.status, ['queued', 'sending'])))
    .limit(1);
  const humanActive =
    (conv?.humanUntil && conv.humanUntil.getTime() > now.getTime()) ||
    (lastHuman && now.getTime() - lastHuman.sentAt.getTime() < pauseMs) ||
    queued !== undefined;

  // A colleague's phone in the client book (leak-1).
  const phones: string[] = [];
  if (ctx.identity.clientId) {
    const [c] = await db.select({ phones: clients.phones }).from(clients).where(eq(clients.id, ctx.identity.clientId));
    if (Array.isArray(c?.phones)) phones.push(...(c!.phones as string[]));
  }
  const [rule] = await db
    .select({ peerPhone: tgChatRules.peerPhone })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, ctx.managerUserId), eq(tgChatRules.peerId, ctx.peerId)));
  if (rule?.peerPhone) phones.push(rule.peerPhone);
  const tails = phones.map((p) => p.replace(/\D/gu, '').slice(-9)).filter((p) => p.length === 9);
  let peerIsStaff = false;
  if (tails.length) {
    const staff = await db
      .select({ id: users.id })
      .from(users)
      .where(and(canLogInSql(), isNotNull(users.phone), sql`right(regexp_replace(${users.phone}, '\\D', '', 'g'), 9) IN (${sql.join(tails.map((t) => sql`${t}`), sql`, `)})`))
      .limit(1);
    peerIsStaff = staff.length > 0;
  }

  const anchor = ctx.anchor!;
  const prevInbound = ctx.messages.filter((m) => m.direction === 'in' && m.id !== anchor.id).slice(-3);
  const norm = (t: string) => t.trim().toLowerCase();
  return {
    now,
    agentOn: agentRunning(config),
    sessionConfirmed: config.sessionExclusiveAt !== null,
    // The pump alone, not the ✅'s `listenerIsCurrent`: a draft written while the catch-up still walks is
    // decided at the ✅, and refusing it here would be a refused run the deploy-gap pass never asks again.
    listenerCurrent: pumpIsFresh(guard, now),
    accountPaused: guard?.pausedAt != null,
    privateUser: ctx.peerId > 0n,
    hasOwner: ctx.identity.clientId !== null || ctx.identity.leadId !== null,
    ruleExcluded: ctx.ruleDecision === 'exclude',
    peerIsStaff,
    muted: conv?.mutedAt != null,
    humanActive: Boolean(humanActive),
    anchorIsNewest: true,
    anchorSentAt: anchor.sentAt,
    anchorAutoSent: anchor.autoSent,
    lastOutAt: ctx.lastOut?.sentAt ?? null,
    anchorRepeats: anchor.body.trim() !== '' && prevInbound.some((m) => norm(m.body) === norm(anchor.body)),
  };
}

/**
 * Reserve the run under ONE advisory lock against every cap, failing CLOSED
 * (money-11): inbound runs today ≤ daily_draft_cap, this chat ≤ 12 today,
 * today's tokens ≤ daily_token_cap. The lock is its own statement inside the
 * transaction, the INSERT carries the counts in its WHERE (#707's shape).
 */
async function reserve(job: AgentInboundJob, attempt: number, config: AgentConfig, now: Date): Promise<'ok' | 'duplicate' | 'capped' | string> {
  const dayStart = tashkentDayStart(tashkentDay(now)).toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CAP_LOCK}))`);
    const cap = capReached(await dayRunCounts(dayStart, { managerUserId: job.managerUserId, peerId: BigInt(job.peerId) }, tx), config);
    if (cap) return `capped:${cap}`;
    const rows = await tx
      .insert(agentRuns)
      .values({
        managerUserId: job.managerUserId,
        peerId: BigInt(job.peerId),
        trigger: 'inbound',
        anchorTgMessageId: BigInt(job.anchorTgMessageId),
        attempt,
        model: STAFF_MODEL,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    return rows[0] ? `ok:${rows[0].id}` : 'duplicate';
  });
}

/**
 * The attempt this job runs as: the job's own (0, the sweep's retry 1, his
 * press's from 50 — queues `nextRedraftAttempt`, a waited job's carried by
 * `reschedule`), and an edit of the anchor its own from 100 (regression-10),
 * counted here because the listener that queues an edit does not read the
 * ledger.
 */
async function attemptFor(job: AgentInboundJob): Promise<number> {
  if (job.attempt !== undefined) return job.attempt;
  if (job.origin !== 'edit') return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.managerUserId, job.managerUserId),
        eq(agentRuns.peerId, BigInt(job.peerId)),
        eq(agentRuns.anchorTgMessageId, BigInt(job.anchorTgMessageId)),
        gte(agentRuns.attempt, EDIT_ATTEMPT_BASE),
      ),
    );
  return EDIT_ATTEMPT_BASE + Number(row?.n ?? 0);
}

const lastOutAsked = (ctx: AgentContext) => /[?؟？]\s*$/u.test(ctx.lastOut?.body ?? '');

export async function handleInbound(job: AgentInboundJob, deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  if (!(await agentTablesReady())) return { outcome: 'skipped', reason: 'not_ready' };
  const config = await readAgentConfig();
  if (!agentRunning(config) || config.ownerUserId !== job.managerUserId) return { outcome: 'skipped', reason: 'agent_off' };
  const callModel = deps.callModel ?? (aiConfigured() ? realCallModel : null);
  if (!callModel) return { outcome: 'skipped', reason: 'ai_not_configured' };

  const peerId = BigInt(job.peerId);
  const anchorId = BigInt(job.anchorTgMessageId);
  const ctx = await loadContext(job.managerUserId, peerId, anchorId);
  const newestIn = [...ctx.messages].reverse().find((m) => m.direction === 'in');
  if (!ctx.anchor || !newestIn || newestIn.tgMessageId !== anchorId) return { outcome: 'stood_down', reason: 'not_newest' };

  // The customer is still typing: look again shortly, never past the cap (fit-9).
  const t = now();
  const ageMs = t.getTime() - ctx.anchor.sentAt.getTime();
  const [conv] = await db
    .select({ typingAt: agentConversations.peerTypingAt })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, job.managerUserId), eq(agentConversations.peerId, peerId)));
  const attempt = await attemptFor(job);
  if (conv?.typingAt && t.getTime() - conv.typingAt.getTime() < 6_000 && ageMs < AGENT_LIMITS.typingWaitCapMs) {
    await reschedule(job, attempt, AGENT_LIMITS.typingExtendMs / 1000, deps, 'typing');
    return { outcome: 'rescheduled', reason: 'peer_typing' };
  }

  const worthy = draftWorthy(
    ctx.burst.map((m) => ({ text: m.body, media: m.media })),
    lastOutAsked(ctx),
  );
  if (!worthy.worthy) {
    if ('notice' in worthy) {
      if (await runLedgerRow(job, attempt, 'notice', worthy.reason)) {
        await writeNotice(ctx, worthy.reason);
        // «Botmisiz?» after an AUTO reply (§18.3 step-down): that chat leaves «o'zi yuborish» for 30 days,
        // and a second such chat in a week disarms it. Once per anchor — the ledger row's own claim.
        if (worthy.reason === 'bot_question') await autoStepDownOnBotQuestion(ctx.managerUserId, ctx.peerId, t);
      }
      return { outcome: 'notice', reason: worthy.reason };
    }
    // A ledger row, so the sweep's deploy-gap pass does not ask again every minute.
    await runLedgerRow(job, attempt, 'refused', worthy.reason);
    return { outcome: 'skipped', reason: worthy.reason };
  }
  if (worthy.greetingOnly && ageMs < AGENT_LIMITS.greetingWaitMs) {
    await reschedule(job, attempt, (AGENT_LIMITS.greetingWaitMs - ageMs) / 1000, deps, 'greeting');
    return { outcome: 'rescheduled', reason: 'greeting_only' };
  }

  const elig = eligibleForRun(await eligibilityFacts(ctx, config, t));
  if (!elig.ok) {
    await runLedgerRow(job, attempt, 'refused', elig.reason);
    return { outcome: 'refused', reason: elig.reason };
  }

  const reserved = await reserve(job, attempt, config, t);
  if (reserved === 'duplicate') return { outcome: 'stood_down', reason: 'duplicate' };
  if (reserved.startsWith('capped:')) {
    const fresh = await runLedgerRow(job, attempt, 'capped', reserved.slice(7));
    if (fresh) await capNoticeOnce(ctx, reserved.slice(7), t);
    return { outcome: 'capped', reason: reserved.slice(7) };
  }
  const runId = reserved.slice(3);

  const started = Date.now();
  let settle: Partial<typeof agentRuns.$inferInsert> = { outcome: 'error', error: 'unknown' };
  try {
    const facts = await generalFacts();
    // His lessons, read once beside the facts (§3.3): the head is the same bytes in every round of this run.
    const taught = await promptLessons();
    const canary = `gsr-${randomBytes(4).toString('hex')}`;
    const day = tashkentDay(t);
    // His price act, read once: the head, the avia tool and the avia rule below agree for the whole run (§1.2).
    const act = { priceArmed: await priceActArmed() };
    const loop = await runLoop({ ctx, config, facts, day, canary, callModel, now, priceArmed: act.priceArmed, lessons: taught.lessons });
    settle = {
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadTokens: loop.usage.cacheReadTokens,
      cacheWriteTokens: loop.usage.cacheWriteTokens,
      toolCalls: loop.tools.map((x) => ({ name: x.name, ok: x.ok, text: x.text, estimate: x.estimate })),
    };
    const drafted = withAviaRule(withRailRule(loop.compose, ctx), loop, ctx, act);
    if (!drafted.replyNeeded && !drafted.needsOwner) {
      settle = { ...settle, outcome: 'no_reply', error: null };
      return { outcome: 'no_reply' };
    }

    const memory = memoryFor(ctx, loop, facts, canary);
    const policy = await policyFor({
      managerUserId: ctx.managerUserId,
      peerId: ctx.peerId,
      body: drafted.replyText,
      memory,
      strip: stripFor(ctx),
    });
    // A draft the avia guard holds asks him for the address (review R2).
    const c = withAviaGuard(drafted, policy, loop, ctx);
    const { actions, notes } = validateActions(c, ctx, loop.outcomes, t);
    const rail = railNote(ctx, c);
    if (rail) notes.push(rail);
    const tariffMismatch = loop.outcomes.some((o) => o.tariffMismatch);
    if (tariffMismatch) notes.push("Sayt narxi va /admin/tarif farq qiladi — yo'lkira narxi aytilmadi.");
    // A card written long after the customer's message says so, first, with the job's reason
    // when it has one (2026-10-29: a pull-made card 23 minutes late looked like a fresh one).
    const late = lateNote({ anchorSentAt: ctx.anchor.sentAt, waitingSince: ctx.burst[0]?.sentAt ?? null, writtenAt: now(), origin: job.origin });
    if (late) notes.unshift(late);

    const input = { runId, ctx, compose: c, policy, memory, actions, notes, lessonSet: taught.mark };
    // «O'zi yuborish» (§18.3) — the INBOUND run's alone: judged on the very row about to be written,
    // after the policy and the actions, and written beside it in `createDraft`'s own transaction.
    const autoPlan = await autoPlanFor({ draft: autoShapeOf(draftFromRun(input)), tools: loop.tools, now: now() });
    const written = await writeDraft({ ...input, autoPlan });
    // The customer's language, remembered for the next «ok».
    const locale = detectLocale(ctx.anchor.body, ctx.storedLocale).locale ?? c.language;
    await db
      .insert(agentConversations)
      .values({ managerUserId: ctx.managerUserId, peerId: ctx.peerId, locale })
      .onConflictDoUpdate({
        target: [agentConversations.managerUserId, agentConversations.peerId],
        set: { locale, updatedAt: new Date() },
      });
    // `question_gone` is an answer's redraft's alone (`answers`), never this run's — stood down all the same if it came.
    const stood = written.kind === 'written' ? null : written.kind;
    settle = { ...settle, outcome: stood ? 'stood_down' : 'draft', error: stood };
    return stood !== null ? { outcome: 'stood_down', reason: stood } : { outcome: 'draft', draftId: written.draftId, blocked: !policy.ok };
  } catch (err) {
    logger.error({ err, runId }, '[agent] run failed');
    settle = { ...settle, outcome: 'error', error: err instanceof Error ? err.message.slice(0, 300) : 'error' };
    return { outcome: 'error', reason: String(settle.error) };
  } finally {
    await db
      .update(agentRuns)
      .set({ ...settle, durationMs: Date.now() - started })
      .where(eq(agentRuns.id, runId))
      .catch((err: unknown) => logger.error({ err, runId }, '[agent] run not settled'));
  }
}

/**
 * The figures the PROMPT dictates (incident 2026-10-29): rule 8 tells the
 * model the truck takes «eng kamida 1 kub yoki 100 kg», rule 9 the flight
 * «eng kamida 1 kg … taxminan 2-5 kun» — from `AGENT_LIMITS`, the numbers the
 * tools obey. Their only source in the policy was the seeded knowledge, which
 * he may retire or re-word: then the reply said the minimum it was told to
 * say and lost its ✅ for it. The company's rule is a source of its own,
 * whatever the knowledge holds — said as the kinds it is (a measure, the
 * flight's days), never as money, and in its own UNIT (review): unitless, its
 * «1 kub» vouched for «1 kg», its «100 kg» for «100 kub» and a count of 100
 * cartons, the flight's «2 kun» for «2 soatda». The flight's days vouch only
 * for a day count said of the flight (`sourceFor`). Each minimum is its road's
 * and a MINIMUM's (second review): unmoded, the truck's «100 kg» vouched for
 * «Avia orqali eng kamida 100 kg» (the flight takes 1 kg), and shapeless, for
 * «Sizning 100 kg yukingiz Toshkentga yetib keldi» — a weight nobody stated.
 */
const COMPANY_RULE = 'kompaniya qoidasi';
const COMPANY_RULE_SOURCES: readonly NumberSource[] = [
  { value: AGENT_LIMITS.minShipment.m3, kind: 'measure', label: COMPANY_RULE, origin: 'kb', mode: 'road', unit: 'm3', said: 'minimum' },
  { value: AGENT_LIMITS.minShipment.kg, kind: 'measure', label: COMPANY_RULE, origin: 'kb', mode: 'road', unit: 'kg', said: 'minimum' },
  { value: AGENT_LIMITS.avia.minKg, kind: 'measure', label: COMPANY_RULE, origin: 'kb', mode: 'air', unit: 'kg', said: 'minimum' },
  { value: AGENT_LIMITS.avia.daysMin, kind: 'duration', label: COMPANY_RULE, origin: 'kb', mode: 'air', unit: 'day' },
  { value: AGENT_LIMITS.avia.daysMax, kind: 'duration', label: COMPANY_RULE, origin: 'kb', mode: 'air', unit: 'day' },
];

/**
 * What the run learned, kept on the draft so ✅ re-runs the policy on the same evidence (leak-3). `ownerAnswer`: his
 * ✍️ answer this redraft is made of (spec SPEC-P1-v2 §2.2) — a SOURCE, read as a fact is (`ownerAnswerSources`), for
 * this draft alone; it adds nothing to the phones, links, names or Han text a reply may carry (an address or a
 * phone is his ✏️ text, verbatim — the bot refuses one in an answer).
 */
export function memoryFor(ctx: AgentContext, loop: LoopResult, facts: KbHit[], canary: string, ownerAnswer: string | null = null): PolicyMemory {
  // His «Temir yo'l mendan so'rasin»: in a chat about rail no figure the
  // machine found may carry a price — not the truck's website figure worded
  // as a rail one, not the avia rate. Dropped from the memory the ✅ re-runs
  // the policy on, so G1 blocks every money figure in the body, at the write
  // AND at the press; only his own ✏️ words (the owner subset) can say one.
  // Asked of the reply and of the chat's inbound window, not the burst alone
  // (final review K18): «temir yo'l bilan qancha?», his «aniqlab aytaman»,
  // then «5 kub, 800 kg» left the rail question one burst back and «Temir
  // yo'l bilan taxminan 960 $» passed on the truck's figure.
  const rail = railChat(ctx, loop.compose);
  const road = chatRoadOf(ctx, loop);
  // The customer's language over his whole BURST — every line since our last message, which is what the reply
  // answers — never the last line alone (0148 fix): «Ассалому алайкум» / «Гуанчжоудан юк бор эди» / «5 куб 800 кг»
  // says Uzbek in its first line and nothing in its last.
  const said = ctx.burst.length > 0 ? ctx.burst.map((m) => m.body).join('\n') : (ctx.anchor?.body ?? '');
  const guess = detectLocale(said, ctx.storedLocale);
  const found = loop.outcomes.flatMap((o) => o.sources).filter((s) => !rail || s.kind !== 'money');
  const sources: NumberSource[] = [...customerNumberSources(ctx.messages), ...found];
  // General facts are in every prompt: their non-money figures, phones and
  // links count as said by the company (a kb money figure never does — it
  // reads as `customer_money`, money-9). Each fact is read ALONE (B2): the
  // payment fact names money, and joined to the rest it made every street
  // number and hour of every other fact a price nobody may repeat.
  for (const f of facts) sources.push(...factSources(f.answer, 'kompaniya bilimi'));
  sources.push(...COMPANY_RULE_SOURCES);
  // His answer's figures — but never money in a rail chat (his price, his ✏️; rail is a forced question anyway).
  if (ownerAnswer !== null) sources.push(...ownerAnswerSources(ownerAnswer).filter((s) => !rail || s.kind !== 'money'));
  const urls = [...facts.flatMap((f) => f.urls), ...loop.outcomes.flatMap((o) => o.allowedUrls ?? [])];
  const { mapUrls, allowedUrls } = splitUrls(urls);
  return {
    language: loop.compose.language,
    customerScript: ctx.customerScript,
    sources,
    allowedPhones: [...facts.flatMap((f) => f.phones), ...loop.outcomes.flatMap((o) => o.allowedPhones ?? [])],
    allowedUrls,
    mapUrls,
    askedLocation: askedLocation(ctx.burst.map((m) => m.body)),
    // Either estimate tool — the truck's website figure or the avia rate × kg
    // (his 2026-10-24) — makes G11 apply: «taxminan» and «boj, QQS alohida».
    hasEstimate: !rail && loop.outcomes.some((o) => o.estimate === true),
    // …and a truck figure priced FROM our China warehouses asks for the
    // condition and the factory leg too (his third set «3»).
    fromOurWarehouse: !rail && loop.outcomes.some((o) => o.estimate === true && o.fromOurWarehouse === true),
    // The chat is the flight's and no truck's (his fourth set «2»): the reply
    // may state no China address — the flight's is his to give. The one road
    // rule the card's question asks too (`chatRoadOf`, review D4, R1-R2).
    // Not gated on rail (#1540): rail takes the machine's money out of the reply, and the
    // flight's address is a rule of its own — «Poyezd kerak emas, avia bilan» is the flight's.
    aviaOnly: road === 'air',
    // The flight was spoken of and the rule did not decide it is the chat's
    // road (#1539): a reply giving our warehouse's address keeps its ✅ and the
    // card says so — a chat the words misread costs him one look, never a
    // flight sent to a truck's warehouse in silence.
    aviaMentioned: road !== 'air' && aviaSpokenOf(ctx, road),
    // Every figure this run QUOTED (spec §1.3): what the send step, his ✅ and the machine's press price again with
    // the same function (estimate.ts `reprice`). Never in a rail chat — there no machine figure goes out at all.
    estimates: rail ? [] : loop.outcomes.flatMap((o) => (o.priced ? [o.priced] : [])),
    // The table is China → Tashkent (spec §1.8): the customer named another city or region anywhere in what he
    // wrote — the window and the burst — and an estimate reply then waits for his ✅ (a gate fact, never a block).
    foreignDestination: namesForeignPlace([...ctx.messages.filter((m) => m.direction === 'in'), ...ctx.burst].map((m) => m.body)),
    // What this run quoted, for the next run's `lastQuote` (review R1).
    quotedRoad: rail ? null : quotedRoadOf(loop),
    quotedAir: rail ? null : (loop.outcomes.find((o) => o.air)?.air ?? null),
    // The auto layer's two facts of the chat itself (spec §1.1, §4): a rail chat's money is his, and the
    // customer's language as the message the draft answers says it — read once here, so the scheduling and the
    // press judge the same thing.
    rail,
    // An unconfident guess that LEANS — on the conversation's own stored language, on the one language its greetings
    // said, or on its Uzbek Cyrillic word endings (fix pass 5, locale `uzbekEndingLean`) — admits only that language
    // (fix pass 4, auto-gate `languageAdmits`): «Здравствуйте» over unmarked words let an Uzbek reply go to a Russian
    // customer, and it was no mark of Russian either.
    customerLocale: {
      locale: guess.locale,
      confident: guess.confident,
      ...(!guess.confident && guess.locale !== null && (guess.locale === ctx.storedLocale || guess.locale === greetingLean(said) || guess.locale === uzbekEndingLean(said))
        ? { leans: true }
        : {}),
    },
    // The Chinese the facts this run read hold (his fourth set): a reply that
    // quotes a warehouse address verbatim is measured in its OWN script.
    quotableHan: hanOnly([...facts.map((f) => f.answer), ...loop.outcomes.flatMap((o) => o.factTexts ?? [])].join('')),
    // The facts this run read — the prompt's general ones and what kb_search
    // returned — may name the colleague they point at (B9), as they may carry
    // his phone.
    factNameWords: nameWordsOf([...facts.map((f) => f.answer), ...loop.outcomes.flatMap((o) => o.factTexts ?? [])]),
    // The road the customer asked about — his burst's, else the chat's — is the one a reply's day count
    // naming no road is the time of: «Mashinada 5 kunda kelsinmi?» is never answered on the flight's five.
    askedMode: askedModeOf(ctx),
    // His 13 + ⭐3 (K29): a Persian or Chinese reply comes with its Uzbek translation, or carries no ✅.
    hasGloss: glossReadable(loop.compose.glossUz),
    ownCodes: ctx.identity.codes.map((c) => c.clientCode),
    managerName: ctx.identity.managerName,
    canary,
  };
}

/**
 * The one road the customer asked about — his burst's, else the chat's
 * inbound window's; null for none or more than one. Statement by statement,
 * the newest that CHOOSES a road decides (#1539, #1540): «Avia qimmat ekan,
 * kargo bilan necha kunda?» asks the truck's days, «Fura emas temir yo'l
 * kerak» the rail's, and the goods after it («Tovar: tikuv mashinalari») choose
 * nothing. A road only turned down points at the other one when nothing
 * earlier chooses; then the one road the lines name, as before.
 */
export function askedModeOf(ctx: Pick<AgentContext, 'burst' | 'messages'>): TravelMode | null {
  const burst = ctx.burst.map((m) => m.body);
  const window = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.body);
  for (const texts of [burst, window]) {
    let turnedDown: TravelMode | null = null;
    for (const st of texts.flatMap((t) => statementsOf(t, CLAUSE)).reverse()) {
      const c = roadChoiceIn(st);
      // Rail named, not turned down, and no other road chosen beside it.
      if (namesMode(st, 'rail') && !railRefusedIn(st) && c !== 'air' && c !== 'road' && c !== 'both') return 'rail';
      if (c === 'both') return null;
      if (c === 'air' || c === 'road') return c;
      if (c === 'not_air' || c === 'not_road') turnedDown ??= c === 'not_air' ? 'road' : 'air';
    }
    if (turnedDown) return turnedDown;
    const named = oneModeIn(texts.join('\n'));
    if (named) return named;
  }
  return null;
}

/**
 * The flight was put on the table (#1539, #1540, #1541): by the customer in
 * any line — chosen, asked about or turned down — by a line of ours that
 * prices or offers it («Avia bilan yuborsangiz 2–5 kunda keladi»), by the
 * quote he approved, or by a run that priced both roads. A line of ours that
 * only says what the flight does not carry (the seeded «Avia orqali litiy
 * batareya … yuborilmaydi») puts no flight on the table. NOTHING said later
 * takes it off: #1540 let a later truck word settle the chat, and the leg to
 * our warehouse, the delivery in Andijan, a past shipment or a refusal the
 * words missed («фура не успеет») each read as that truck — the warning went
 * silent on exactly the chats it exists for. A look on a chat the customer
 * really moved to the truck costs one glance.
 */
function aviaSpokenOf(ctx: Pick<AgentContext, 'messages' | 'lastQuote'>, road: QuotedRoad | null): boolean {
  if (road === 'both') return true;
  const q = ctx.lastQuote;
  if (q && (q.road === 'air' || q.road === 'both')) return true;
  return ctx.messages.some((m) => (m.direction === 'in' ? airMentionIn(m.body) : ourLineOffersAir(m.body)));
}

/** A line of ours that prices the flight or offers it — never one that only says what it does not carry. */
function ourLineOffersAir(body: string): boolean {
  const priced = pricedRoadOf(body);
  if (priced === 'air' || priced === 'both') return true;
  return statementsOf(body, RAIL_SENTENCE)
    .filter((sentence) => !PROHIBITS.test(sentence))
    .some((sentence) => statementsOf(sentence, CLAUSE).some((st) => ['air', 'both'].includes(roadChoiceIn(st) ?? '')));
}

/**
 * This run asked the truck's price, whatever the tool answered (review D5): a
 * refused estimate is still a truck being talked about, and so is a podklyuch
 * or yo'lkira checklist — the truck sections (review R1).
 */
function truckAsked(loop: Pick<LoopResult, 'tools' | 'outcomes'>): boolean {
  return (
    loop.tools.some((t) => t.name === 'yolkira_estimate') ||
    loop.outcomes.some((o) => (o.estimate === true && !o.air) || (o.checklist !== undefined && TRUCK_SECTIONS.includes(o.checklist.section)))
  );
}

/** Pure: the road THIS run priced or asked — stored on the draft, so the next run knows what was quoted (`lastQuote`). */
export function quotedRoadOf(loop: Pick<LoopResult, 'tools' | 'outcomes'>): QuotedRoad | null {
  const air = loop.outcomes.some((o) => o.air);
  const truck = truckAsked(loop);
  return air && truck ? 'both' : air ? 'air' : truck ? 'road' : null;
}

/** One statement of a message: a sentence, or the part of it a «but» or a comma begins. */
const CLAUSE = /[,.;:!?\n،؛。，！？；：]+|(?<![\p{L}])(?:lekin|ammo|biroq|но|а|but|however)(?![\p{L}])/iu;

/**
 * Pure: the road the customer CHOSE in these lines, the newest statement that
 * chooses one winning (the checklist's rule), read by `roadChoiceIn` — a road
 * word in a form that picks the road, never the goods («Tikuv mashinasi») or
 * the company («kargongiz»), and a road turned down in the same breath («Avia
 * qimmat ekan», «Mashinada emas») is the other one (review #1538). Null: no
 * road chosen.
 */
export function roadChosenIn(texts: readonly string[]): QuotedRoad | null {
  // Each statement with its own end: a question about a road asks for it (#1540).
  const statements = texts.flatMap((t) => statementsOf(t, CLAUSE)).reverse();
  for (const st of statements) {
    const c = roadChoiceIn(st);
    if (c === 'not_air') return 'road';
    if (c === 'not_road') return 'air';
    if (c) return c;
  }
  return null;
}

/**
 * One message's text as it is compared with what was sent: compatibility
 * forms folded («m³», full-width «，»), case, spacing and a trailing «…» set
 * aside — the stored copy of a sent text is not always its byte (#1539).
 */
const sentForm = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/gu, ' ').replace(/(?:…|\.\.\.)$/u, '').trim().toLowerCase();

/**
 * The road the chat is on — the one rule the avia guard and the card's
 * question both ask (review R1-R2, #1538). What THIS run priced or asked comes
 * first; after it the NEWEST piece of evidence wins: a road the customer
 * chose in any of his lines, the road one of OUR priced lines quoted (read at
 * its price — and the echo of the quote he approved, known by its Telegram id
 * or its words, is that draft's own stored road, since its text names goods
 * as often as roads; unless he rewrote it, #1539), or the quote
 * he approved this week when its message is not in sight. A priced line
 * that names no road is no evidence: what was said before it stands, which
 * keeps the flight's address his when in doubt.
 */
export function chatRoadOf(
  ctx: Pick<AgentContext, 'messages' | 'lastQuote'>,
  loop: Pick<LoopResult, 'tools' | 'outcomes'>,
): QuotedRoad | null {
  const quoted = quotedRoadOf(loop);
  if (quoted) return quoted;
  const q = ctx.lastQuote;
  // The chat holds a message in its context form (digits read, clipped), so
  // the quote's text is compared in the same form (#1539).
  const echo = q?.text ? sentForm(chatForm(q.text)) : null;
  let echoSeen = false;
  const evidence: { road: QuotedRoad; at: number; i: number }[] = [];
  ctx.messages.forEach((m, i) => {
    let road: QuotedRoad | null = null;
    if (m.direction === 'in') road = roadChosenIn([m.body]);
    else if (q && ((q.tgMessageId !== null && m.tgMessageId === q.tgMessageId) || (echo !== null && sentForm(m.body) === echo))) {
      echoSeen = true;
      // His ✏️ words are his, and the stored road is the model's (#1539): an
      // edited quote is read at its price, the stored road when it names none.
      road = q.edited ? (pricedRoadOf(m.body) ?? q.road) : q.road;
    } else road = pricedRoadOf(m.body);
    if (road) evidence.push({ road, at: m.sentAt.getTime(), i });
  });
  if (q && !echoSeen) evidence.push({ road: q.road, at: q.at.getTime(), i: -1 });
  evidence.sort((a, b) => a.at - b.at || a.i - b.i);
  return evidence.at(-1)?.road ?? null;
}

/**
 * His fourth set «2» (2026-10-24): «yukini infosini menga bersang men adres
 * beraman telegramda sorasin». An avia figure went into the reply — or the
 * chat is the flight's and the customer asks where to send it, with a reply
 * due (review D4, R2) — so the flight's address is HIS question whatever the
 * model composed, and the card asks it with the cargo. Never in a rail chat:
 * there no machine figure goes out (`memoryFor`), so no flight was quoted —
 * the question is the rail one. A no-reply line («Rahmat, manzilni oldim»)
 * never becomes a question card.
 */
export function withAviaRule(
  c: ComposeReply,
  loop: Pick<LoopResult, 'tools' | 'outcomes'>,
  ctx: Pick<AgentContext, 'burst' | 'messages' | 'measures' | 'lastQuote'>,
  act: { priceArmed: boolean },
): ComposeReply {
  // A rail chat's question is the rail one — unless the CHAT chose the flight (#1540: «Poyezd kerak emas,
  // avia bilan»). Not this run's own avia figure: in a rail chat it never goes out (`memoryFor`).
  if (railChat(ctx, c) && chatRoadOf(ctx, { tools: [], outcomes: [] }) !== 'air') return c;
  const quoted = loop.outcomes.find((o) => o.air)?.air;
  // His price act armed (spec SPEC-P1-v2 §1.2): the flight's PRICE may go by itself — a quote alone asks him
  // nothing. Off, every quoted flight asks him with its cargo, as it always has.
  if (quoted && !act.priceArmed) return withAviaQuestion(c, quoted);
  const road = chatRoadOf(ctx, loop);
  // The customer's own words asking where to send it — kept as it was (the burst, never the model's question).
  if (c.replyNeeded && road === 'air' && asksWhereToSend(ctx.burst)) return withAviaQuestion(c, aviaCargoOf(loop, ctx));
  // …and, armed only, a REPLY in a flight's chat that names a place of ours, an address or a hand-over asked of
  // the customer (`talksDelivery`, the reply's own lists): «Ivu omborimizga yuboring» anchors on none of our
  // phones, Han pieces or house numbers (`statesChinaAddress`), and would send a flight's cargo to a truck's
  // warehouse. The address is his, always (§18.5).
  if (act.priceArmed && c.replyNeeded && (road === 'air' || road === 'both') && talksDelivery(c.replyText)) {
    return withAviaQuestion(c, aviaCargoOf(loop, ctx));
  }
  // A question the model raised itself is never cleared here — its own `needs_owner` stands.
  return c;
}

/**
 * OUR words, read with lists of their own (0148 fix). The armed rule first read the reply with the lists built for
 * what a CUSTOMER asks (`WAREHOUSE_WORD`, `SEND_VERB`, `ADDRESS_WORD` — untouched), and they are stems: «пошл» is
 * inside «Пошлина», so the exclusion sentence the prompt DICTATES in Russian («Пошлина и НДС считаются отдельно.»)
 * made every Russian flight quote his question, and the price act did nothing in Russian; «ship» is inside
 * «shipment», «ارسال» is the noun in «هزینه ارسال هوایی». And they are the customer's forms, so the reply's own way
 * of sending him somewhere — «qabul punktimizga olib boring», «сдайте на наш пункт», «drop it off at our branch»,
 * «送到我们的收货点» — matched nothing, and the flight's reply went by itself telling him where to bring the cargo.
 *
 * Four things a reply says when it directs the cargo, each as whole words:
 *  - a PLACE of ours that takes cargo — a warehouse, a reception point, a branch;
 *  - an ADDRESS, by any of its names;
 *  - the hand-over asked of HIM — an imperative or a second person: «yuboring», «yuborsangiz», «olib boring»,
 *    «topshirishingiz mumkin», «отправьте», «можете привезти», «please send», «you can drop it off», «请寄到»,
 *    «ارسال کنید». Never the noun («доставка», «shipment», «ارسال»), never OUR sending («yuboramiz», «отправим», «we
 *    ship») — those send him nowhere — and never «送到塔什干», which is where WE take it;
 *  - where WE receive it (`receivesThere`).
 *
 * Fix pass 4 (the readers' corpus, tests/unit/fixtures/agent-reader-corpus.ts): pass 3 freed ordinary replies with
 * relaxations that each let a hand-over through — an information noun ANYWHERE in the clause cancelled it («Отправьте
 * груз вместе с документами», «Yukni kompaniyamiz nomiga yuboring», «Отправьте 30 кг груза»), a locative of ours
 * freed a receive verb («Авиагрузы принимаем на нашем складе в Гуанчжоу»), «нам» read as OUR sending («Груз нам
 * отправьте»), the Tashkent pickup in one clause freed a Chinese warehouse in the next. Where the rule cannot tell an
 * ordinary reply from a hand-over, it HOLDS: information frees a clause only when no cargo is left in it as the object;
 * a receive verb beside a place of ours, an airport or a Chinese city directs, whatever its case; «we» is the
 * nominative alone; a pickup frees only a sentence that names no Chinese place.
 */
const AP_ = "['‘’ʻ`]";
const REPLY_PLACE = new RegExp(
  [
    '(?<![\\p{L}])(?:ombor|sklad|punkt|filial)\\p{L}*',
    '(?<![\\p{L}])(?:омбор|пункт|филиал)\\p{L}*',
    // «Цена складывается из веса и объёма» is «adds up» and «складной стол» folds — the warehouse only in its own
    // cases, Russian's and the endings Uzbek hangs on the loan word («складга», «складимизга»).
    '(?<![\\p{L}])склад(?:а|у|ом|е|ы|ов|ам|ами|ах|ск(?:ой|ая|ое|ие|ого|их|ом|ую)|га|да|дан|ни|нинг|лар\\p{L}*|и(?:миз|нгиз)?(?:га|да|дан|ни|нинг)?)?(?![\\p{L}])',
    `(?<![\\p{L}])qabul\\s+(?:joy|nuqta)\\p{L}*`,
    '(?<![\\p{L}])қабул\\s+(?:жой|нуқта)\\p{L}*',
    '(?<![\\p{L}])(?:warehouses?|depots?|branch(?:es)?|drop-?\\s?off\\s+points?|collection\\s+points?|receiving\\s+points?)(?![\\p{L}])',
    '仓库|仓(?!储)|收货点|收货地|网点|站点',
    'انبار|شعبه|نمایندگی',
  ].join('|'),
  'giu',
);
const REPLY_PLACE_ANY = new RegExp(REPLY_PLACE.source, 'iu');
/**
 * An airport — where a flight's cargo is handed in, or where it LANDS. It directs only beside a receive verb
 * (`receivesThere`) or a hand-over (fix pass 4): pass 3 put it among our places, and «Yuk aeroportga kelgach sizga xabar
 * beramiz» — the Tashkent arrival — became his avia question in every language.
 */
const AIRPORT = /(?<![\p{L}])(?:aeroport|airport|аэропорт)\p{L}*|机场|فرودگاه/iu;
/**
 * A place of ours named as where the cargo LEAVES or IS (fix pass 3) — «Xitoydagi omborlarimizdan hisoblanadi», «qabul
 * punktidan joʻnatilgandan keyin», «из склада», «from our warehouse», «从仓库», «از انبار», and «omborimizda», «на
 * складе», «at our warehouse», «在仓库», «در انبار» — directs nothing BY ITSELF; a hand-over in its clause still does,
 * and so does a receive verb in its sentence (`receivesThere`, fix pass 4).
 */
// Uzbek's own case on the word — never Russian's «склада» (of the warehouse), whose «-да» is the stem's «д».
const PLACE_FROM_OR_AT = /^(?:(?:ombor|sklad|punkt|filial)\p{L}*(?:dan|da|dagi)|(?:омбор|пункт|филиал)\p{L}*(?:дан|да|даги)|склад\p{L}*д(?:ан|а|аги))$/iu;
/** «uch omborimizdan qaysi biriga» — «of» our three warehouses, which: a place it GOES to, asked. */
const PARTITIVE_AFTER = /^\s*(?:qaysi|biri|bittasi|қайси|бири|биттаси)(?![\p{L}])/iu;
const BEFORE_FROM_OR_AT = /(?:(?<![\p{L}])(?:из|со|с|from|at|in)\s+(?:(?:наш|our|my|your|ваш)\p{L}*\s+)?|[从在]|(?<![\p{L}])(?:از|در)\s+)$/iu;
const RU_PREPOSITIONAL = /^(?:склад|пункт|филиал)е$/iu;
/** «…aeroportdan olib ketasiz», «заберёте в аэропорту», «pick it up at the airport» — where he collects. */
const PICKUP = /(?<![\p{L}])(?:olib\s+ket|олиб\s+кет|забер|забрать|забира|pick\s+(?:it\s+|them\s+)?up|collect)\p{L}*|自提|取货/iu;
function placeDirects(sentence: string): boolean {
  // Where he collects — in a sentence that names no Chinese place (fix pass 4): «Yukingiz Guanchjou omborimizga keladi,
  // keyin Toshkentdan olib ketasiz» freed the Chinese warehouse through the other clause's pickup.
  if (PICKUP.test(sentence) && originMentions(sentence).length === 0) return false;
  return [...sentence.matchAll(REPLY_PLACE)].some((m) => {
    const word = m[0];
    const after = sentence.slice(m.index + word.length, m.index + word.length + 10);
    if ((PLACE_FROM_OR_AT.test(word) && !PARTITIVE_AFTER.test(after)) || RU_PREPOSITIONAL.test(word)) return false;
    return !BEFORE_FROM_OR_AT.test(sentence.slice(Math.max(0, m.index - 14), m.index));
  });
}
/**
 * WE receive the cargo there (fix pass 4): «qabul qilamiz», «принимаем», «we receive», «收货», «تحویل می‌گیریم» beside a
 * place of ours, an airport or a Chinese city names where the flight's cargo is handed in — whatever the place's case
 * or preposition: «Avia yuklarni Guanchjoudagi omborimizda qabul qilamiz», «Авиагрузы принимаем на нашем складе в
 * Гуанчжоу», «We receive air cargo at our warehouse in Guangzhou», «Cargo is received in Guangzhou», «我们在广州收货».
 * Never a receive verb with no place («Avia orqali 1 kg dan qabul qilamiz»), never one in Tashkent alone.
 */
const RECEIVE =
  /(?<![\p{L}])(?:qabul\s+qil\p{L}*|қабул\s+қил\p{L}*|кабул\s+кил\p{L}*|приним\p{L}*|принят\p{L}*|прим(?:ем|ут|ет|ете)(?![\p{L}])|receiv\p{L}*|accept\p{L}*)|收货|收件|接收|签收|(?<![\p{L}])(?:تحویل\s+می\S*\s*گیر|دریافت\s+می\S*\s*کن)\p{L}*/iu;
function receivesThere(sentence: string): boolean {
  if (!RECEIVE.test(sentence)) return false;
  const chinese = originMentions(sentence).length > 0;
  if (TASHKENT.test(sentence) && !chinese) return false;
  return chinese || REPLY_PLACE_ANY.test(sentence) || AIRPORT.test(sentence);
}
// …and a street with its house number (fix pass 3: «Yiwu qabul punktidan — Futian ko‘chasi 88» names no «manzil»).
const REPLY_ADDRESS =
  /(?<![\p{L}])(?:manzil|манзил|adres|адрес|address|lokatsiya|локация|location)\p{L}*|地址|آدرس|نشانی|(?<![\p{L}])(?:ko['‘’ʻ`]?cha|кўча|куча|улиц|street|road|avenue)\p{L}*\.?\s*\d|[路街]\s*\d|خیابان\s*\S*\s*\d/iu;
/** The second person and the imperative a hand-over is asked in: «-ing», «-sangiz», «-ishingiz (mumkin)», «-asiz», «-avering». */
const UZ_YOU = `(?:ing(?:lar|iz)?|sangiz(?:lar)?|ishingiz\\p{L}*|asiz(?:lar)?|avering)`;
const UZ_CYRL_YOU = '(?:инг(?:лар|из)?|сангиз(?:лар)?|ишингиз\\p{L}*|асиз(?:лар)?|аверинг)';
/** «yozib yuboring», «aytib yuboring» — WRITE it and send: a message, never the cargo (fix pass 4). */
const WRITE_BEFORE = '(?<!(?:yozib|aytib|ёзиб|айтиб)\\s+)';
/**
 * The hand-over asked of HIM, or of whoever brings his cargo — in this trade the SUPPLIER or the factory does (fix pass
 * 3: «Sotuvchingiz yukni bizga yuborsin», «Пусть завод отправит груз нам», «Have your supplier send the goods to our
 * office»): the jussive and the third person, «to us» beside a sending verb, and the verbs that leave or give
 * («qoldiring», «оставьте», «отдайте», «leave it», «放在», «بگذارید», «kuryerimizga bering»). Never OUR offer: «let us
 * deliver», «让我们…发货» (fix pass 4).
 */
const REPLY_HANDOVER = new RegExp(
  [
    `${WRITE_BEFORE}(?<![\\p{L}])(?:yubor|jo${AP_}?nat|yetkaz|topshir|keltir)(?:${UZ_YOU}|sin(?:lar)?|ib\\s+(?:ber|qo${AP_}?y)${UZ_YOU})(?![\\p{L}])`,
    `(?<![\\p{L}])(?:olib\\s+(?:kel|bor)|eltib\\s+ber|tashlab\\s+ket)(?:${UZ_YOU}|sin(?:lar)?)(?![\\p{L}])`,
    `(?<![\\p{L}])\\p{L}+imizga\\s+(?:\\p{L}+\\s+)?(?:bering|beravering|topshiring)(?![\\p{L}])`,
    `${WRITE_BEFORE}(?<![\\p{L}])(?:юбор|жўнат|жунат|етказ|топшир|келтир)(?:${UZ_CYRL_YOU}|син(?:лар)?|иб\\s+(?:бер|қўй|куй)${UZ_CYRL_YOU})(?![\\p{L}])`,
    `(?<![\\p{L}])(?:олиб\\s+(?:кел|бор)|элтиб\\s+бер|ташлаб\\s+кет)(?:${UZ_CYRL_YOU}|син(?:лар)?)(?![\\p{L}])`,
    '(?<![\\p{L}])(?:отправ(?:ьте|ляйте|ите|ляете)|вышлите|пришлите|привез(?:ите|[её]те)|привозите|принес(?:ите|[её]те)|сда(?:йте|дите|вайте)|достав(?:ьте|ляйте)|переда(?:йте|дите)|завез(?:ите|[её]те)|подвез(?:ите|[её]те)|подвозите|завозите|отда(?:йте|дите|вайте)|(?:от|у|до)?вез(?:и|ите|[её]те)|(?:от|до)?возите)(?![\\p{L}])',
    '(?<![\\p{L}])(?:можете|сможете|можно|нужно|надо|необходимо|следует|должен|должна|должны|может|могут)\\s+(?:\\p{L}+\\s+){0,2}?(?:отправ(?:ить|лять)|привезти|привозить|сдать|сдавать|принести|доставить|передать|выслать|завезти)(?![\\p{L}])',
    '(?<![\\p{L}])пусть\\s+(?:\\p{L}+\\s+){0,3}?(?:отправ|привез|достав|сда|переда|вышл)\\p{L}*',
    '(?<![\\p{L}])(?:please|kindly|just|you\\s+(?:can|may|could|should|must|need\\s+to|have\\s+to|will\\s+need\\s+to)|if\\s+you|once\\s+you|when\\s+you)\\s+(?:\\p{L}+\\s+)?(?:send|ship|bring|deliver|drop|hand|take)(?![\\p{L}])',
    '(?<![\\p{L}])(?:have|ask|tell|let)\\s+(?!(?:us|me)(?![\\p{L}]))(?:\\p{L}+\\s+){0,3}?(?:send|ship|bring|deliver|drop|hand)(?![\\p{L}])',
    '(?<![\\p{L}])(?:supplier|factory|seller|vendor)s?\\s+(?:should|must|can|will|needs?\\s+to|has\\s+to)\\s+(?:send|ship|bring|deliver|drop|hand)(?![\\p{L}])',
    "(?:^|[.!?\\n]\\s*)(?:send|ship|bring|deliver|drop|hand|take)\\s+(?:it|them|the|your)(?![\\p{L}])(?!\\s+(?:time|word|call|seat|look|care|chance)(?![\\p{L}]))",
    '(?<![\\p{L}])(?:drop(?:\\s+(?:it|them))?\\s+off|hand(?:\\s+(?:it|them))?\\s+over)(?![\\p{L}])',
    '请(?:您)?(?:把[^，。！？]{0,12})?(?:寄|发|送|交|拿|带)|(?:寄|发|送|交|拿|带)(?:到|去|往|来|过来)(?!塔什干|乌兹别克)|您(?:可以|需要|要)(?:把[^，。！？]{0,12})?(?:寄|发|送|交)|让(?!我)[^，。！？]{1,8}?(?:寄|发|送|交)',
    'ارسال\\s+(?:کنید|نمایید|بفرمایید)|بفرستید|تحویل\\s+(?:دهید|بدهید)|بیاورید|ببرید|برسانید',
  ].join('|'),
  'giu',
);
/** «To us» beside a sending verb in any form — the factory's «yuborsa», «привезёт», «deliver», «发给我们». */
const TO_US = /(?<![\p{L}])(?:bizga|бизга|к\s+нам|нам|to\s+us|to\s+our\s+\p{L}+)(?![\p{L}])|给我们|به\s+ما(?![\p{L}])/iu;
const SENDING_ANY =
  /(?<![\p{L}])(?:yubor|jo['‘’ʻ`]?nat|yetkaz|olib\s+kel|topshir|юбор|жўнат|етказ|олиб\s+кел|отправ|привез|достав|сда|переда|вышл|send|ship|deliver|bring|drop)\p{L}*|(?:寄|发|送|交)|ارسال|بفرست|تحویل|بیاور/iu;
/**
 * What a hand-over verb is about when it is no hand-over (fix pass 3): INFORMATION — a photo, a size, the weight, a
 * list, a number, a link, a name, a document. «пришлите фото товара», «og‘irligini (kg) yozib yuboring», «send the
 * weight», «请发照片», «عکس را بفرستید» ask him for a fact, never for the cargo. Never a unit («30 кг груза» is
 * cargo), never «nom…» with another case on it («kompaniyamiz nomiga» is whose NAME it goes in — fix pass 4).
 */
const INFO_UZ = `(?:rasm|foto|surat|o${AP_}?lcham|og${AP_}?irli[gk]|vazn|hajm|ro${AP_}?yxat|raqam|havola|link|ma${AP_}?lumot|hujjat|invoys|skrinshot)\\p{L}*|nomi(?:ni|ngizni)?(?![\\p{L}])`;
const INFO_UZC = '(?:расм|фото|сурат|ўлчам|улчам|оғирли[гк]|огирли[гк]|вазн|ҳажм|хажм|рўйхат|руйхат|рақам|ракам|ҳавола|маълумот|ҳужжат|хужжат)\\p{L}*|номи(?:ни|нгизни)?(?![\\p{L}])';
const INFO_RU = '(?:фот|снимк|размер|объ[её]м|габарит|списк|номер|ссылк|данн|информаци|назван|документ|инвойс|скрин|параметр)\\p{L}*|список|вес(?:а|ом|у|е)?(?![\\p{L}])';
const INFO_EN =
  '(?:photos?|pictures?|pics?|images?|dimensions?|sizes?|weight|volume|list|number|link|details?|info(?:rmation)?|names?|documents?|invoices?|screenshots?|specs?|measurements?|requests?|comments?|messages?|questions?|reviews?|feedback)(?![\\p{L}])';
const INFO_ASK = `(?:izoh|so${AP_}?rov|ariza|savol|xabar|заявк|отзыв|коммент|сообщени|вопрос|изоҳ|сўров|ариза|савол|хабар)\\p{L}*`;
const INFO_ZH = '照片|图片|相片|尺寸|重量|体积|清单|信息|号码|链接|名称|资料|发票|截图|数据';
const INFO_FA = 'عکس|تصویر|ابعاد|وزن|حجم|لیست|فهرست|شماره|لینک|اطلاعات|مدارک|فاکتور';
const INFO_NOUN = new RegExp(
  [
    `(?<![\\p{L}])(?:${INFO_UZ})`,
    `(?<![\\p{L}])(?:${INFO_UZC})`,
    `(?<![\\p{L}])(?:${INFO_RU})`,
    `(?<![\\p{L}])${INFO_EN}`,
    `(?<![\\p{L}])${INFO_ASK}`,
    INFO_ZH,
    INFO_FA,
  ].join('|'),
  'iu',
);
/**
 * …and the CARGO named only as the information's own (fix pass 4): «фото товара», «вес груза», «yukning og‘irligini»,
 * «Tovar rasmini», «a photo of the goods», «货物的照片», «عکس بار» — the photo is the object there, never the cargo. A
 * cargo noun anywhere else in the clause is the hand-over's object, whatever information rides with it.
 */
const CARGO_OF_INFO = new RegExp(
  [
    `(?<![\\p{L}])(?:${INFO_RU})\\s+(?:(?:вашего|вашей|ваших|вашу|этого|этой|этих|всего|всех)\\s+)?(?:груз(?:а|ов)|товар(?:а|ов)|посыл(?:ки|ок))(?![\\p{L}])`,
    `(?<![\\p{L}])${INFO_EN}(?:\\s+\\([^)]*\\))?\\s+of\\s+(?:(?:the|your|this|these|those|its|all)\\s+)?(?:cargo|goods|shipment|parcel)s?(?![\\p{L}])`,
    `(?<![\\p{L}])(?:yuk|tovar|mol)(?:lar)?(?:ingiz|imiz)?(?:ning)?\\s+(?:${INFO_UZ})`,
    `(?<![\\p{L}])(?:юк|товар|мол)(?:лар)?(?:ингиз|имиз)?(?:нинг)?\\s+(?:${INFO_UZC})`,
    `(?:货物?|货品)的?(?:${INFO_ZH})`,
    `(?:${INFO_FA})\\s+(?:بار|کالا)(?![\\p{L}])`,
  ].join('|'),
  'giu',
);
/**
 * Where the cargo is to STAY — «qoldiring», «Guanchjouda tursa bo'ldi», «оставьте», «leave it in…», «بگذارید» — a
 * hand-over only about the CARGO, a place of ours or a Chinese city in its clause: «Raqamingizni qoldiring», «Telefon
 * yoqilgan tursin», «Leave it to us» leave nothing anywhere.
 */
const STAY_VERB =
  /(?<![\p{L}])(?:qoldir\p{L}*|tur(?:sa\s+bo['‘’ʻ`]?l|sin(?![\p{L}]))|қолдир\p{L}*|колдир\p{L}*|оставь(?:те)?(?![\p{L}])|оставляйте|leave\s+(?:it|them|the\s+\p{L}+|your\s+\p{L}+)\s+(?:in|at|with)(?![\p{L}]))|بگذارید/iu;
const CARGO_NOUN = /(?<![\p{L}])(?:yuk|tovar|mol|юк|товар|груз|cargo|goods|shipment|parcel)\p{L}*|货|(?<![\p{L}])بار(?![\p{L}])/iu;
const OURS = /(?<![\p{L}])(?:наш\p{L}*|our|bizning|бизнинг|\p{L}+imiz(?:ga|da)?|\p{L}+имиз(?:га|да)?)(?![\p{L}])|我们的|(?<![\p{L}])ما(?![\p{L}])/iu;
/**
 * WE are the ones handing it over (the payment rule's «we cannot hand it over») — said before the verb, in the
 * nominative. «Нам» is to whom HE hands it («Груз нам отправьте», fix pass 4) — ours only before a modal («нам нужно
 * отправить»: we need to send).
 */
const OUR_BEFORE = /(?<![\p{L}])(?:we|we'll|we've|we're|мы|нам\s+(?:нужно|надо|необходимо|следует|можно|придётся|придется))(?![\p{L}])/iu;
/** Where a sentence is split into the clauses a verb governs: commas, semicolons and «and». */
const SUB_CLAUSE = /\s*[,，、;；]\s*|\s+(?:и|va|ва|and|و)\s+/iu;
const SENTENCE = /[.!?\n。！？؟]+/u;
/** «Пришлите, пожалуйста, фото груза» — the politeness between commas is no clause of its own (fix pass 4). */
const POLITE_COMMAS = /\s*,\s*(?:пожалуйста|please|iltimos|илтимос)\s*,\s*/giu;
const POLITE_TAIL = /\s*,\s*(?:пожалуйста|please|iltimos|илтимос)\s*$/iu;

/** Tashkent named — a place of ours in that clause is where he collects, never the China end. */
const TASHKENT = /(?<![\p{L}])(?:to['‘’ʻ`]?shkent|tashkent|тошкент|ташкент|chuqursoy|чуқурсой|чукурсой)\p{L}*|塔什干|تاشکند/iu;

/** A hand-over the clause asks for: the cargo, never information alone, never ours. */
function handsOver(clause: string): boolean {
  // Information asked for frees the clause only when no cargo is left in it as the object (fix pass 4).
  if (INFO_NOUN.test(clause) && !CARGO_NOUN.test(clause.replace(CARGO_OF_INFO, ' '))) return false;
  for (const m of clause.matchAll(REPLY_HANDOVER)) {
    if (!OUR_BEFORE.test(clause.slice(0, m.index))) return true;
  }
  const stay = STAY_VERB.exec(clause);
  if (stay && !OUR_BEFORE.test(clause.slice(0, stay.index)) && (CARGO_NOUN.test(clause) || OURS.test(clause) || originMentions(clause).length > 0)) return true;
  return TO_US.test(clause) && SENDING_ANY.test(clause) && !OUR_BEFORE.test(clause.slice(0, clause.search(SENDING_ANY)));
}

/**
 * …or it names a Chinese city as where the cargo GOES, whatever the verb: «Yuk Ivuga yetib borsa bo'ldi», «Отправьте
 * на Гуанчжоу», «送到广州». Never where it STARTS — «Guanchjoudan Toshkentgacha», «из Гуанчжоу», «from Guangzhou»,
 * «从广州», «از گوانگژو» is every quote's own first words — and never where it IS (fix pass 3): «Груз в Гуанчжоу или в
 * Иу?», «Is your cargo in Guangzhou?», «货在广州还是义乌？», «Yukingiz Guanchjoudami?» ask; where it STAYS is the
 * hand-over's own verbs above («qoldiring», «оставьте», «leave it», «放在», «بگذارید»), and where WE receive it is
 * `receivesThere`'s.
 */
const TO_ENDING = /^(?:ga|га)(?![\p{L}])/iu;
const TO_ENDING_OWN = /(?:га)$/iu;
const TO_BEFORE = /(?:(?<![\p{L}])(?:на|to|به)\s+(?:our\s+|наш\p{L}*\s+)?|[到去往至]|放在)$/iu;
function sendsToChina(replyText: string): boolean {
  return originMentions(replyText).some(({ index, match }) => {
    const after = replyText.slice(index + match.length, index + match.length + 8);
    const before = replyText.slice(Math.max(0, index - 16), index);
    return TO_ENDING.test(after) || TO_ENDING_OWN.test(match) || TO_BEFORE.test(before);
  });
}

/**
 * …and the cargo HANDED IN at a Chinese place (fix pass 5, the check of pass 3): «在义乌交货就行» — «hand it over in
 * Yiwu» — names no place of ours, no «to», no «please», and went by itself once pass 3 dropped «在» from `TO_BEFORE`.
 * Never ours: «我们在义乌交货» is where WE deliver.
 */
const HAN_HAND_IN = /(?<!我们|我方|我司|我)在([^，。！？；]{1,10}?)(?:交货|交付|送货|入库|进仓)/gu;
function handsInAtChina(sentence: string): boolean {
  return [...sentence.matchAll(HAN_HAND_IN)].some((m) => originMentions(m[1]!).length > 0);
}

/** The reply directs the cargo: a place of ours, an address, where we receive it, or a hand-over asked of the customer (§1.2, armed only). */
export function talksDelivery(replyText: string): boolean {
  return replyText.split(SENTENCE).some((said) => {
    const sentence = said.trim().replace(POLITE_COMMAS, ' ').replace(POLITE_TAIL, '');
    if (REPLY_ADDRESS.test(sentence) || sendsToChina(sentence) || receivesThere(sentence) || handsInAtChina(sentence)) return true;
    // A place of ours in a sentence about Tashkent, naming no Chinese place, is the pickup (fix pass 3).
    if (placeDirects(sentence) && !(TASHKENT.test(sentence) && originMentions(sentence).length === 0)) return true;
    return sentence.split(SUB_CLAUSE).some(handsOver);
  });
}

/**
 * After the policy (review R2): a draft the avia guard holds always carries
 * the question — the guard and the card's question are one rule, or a blocked
 * draft sits in «pending» and he is never asked for the address.
 */
export function withAviaGuard(
  c: ComposeReply,
  policy: Pick<PolicyResult, 'blocks'>,
  loop: Pick<LoopResult, 'tools' | 'outcomes'>,
  ctx: Pick<AgentContext, 'burst' | 'messages' | 'measures' | 'lastQuote'>,
): ComposeReply {
  return policy.blocks.some((b) => b.code === 'avia_address') ? withAviaQuestion(c, aviaCargoOf(loop, ctx)) : c;
}

/** The model's own question about the flight's address stands; anything else keeps its place and the avia line follows it. */
function withAviaQuestion(c: ComposeReply, air: AviaCargo): ComposeReply {
  const asked = c.ownerQuestion.trim();
  const line = aviaOwnerQuestion(air);
  // The flight's address is his to give, verbatim (spec SPEC-P1-v2 §1.2, §2.2): a forced question, ✏️ only. A rail
  // question forced first keeps its name — its price is his ✏️ too, and the rail rule asked first.
  const forcedQuestion = c.forcedQuestion ?? 'avia';
  if (asksAviaAddress(asked) || asked.includes(line)) return { ...c, needsOwner: true, forcedQuestion };
  return { ...c, needsOwner: true, ownerQuestion: asked ? `${asked} · ${line}` : line, forcedQuestion };
}

/**
 * The cargo the card names: what the tool quoted this run; else the quote he
 * approved — unless the customer has told a weight since (review #1538: «Yana
 * yuk bor: 80 kg, endi Guanchjoudan» is a new shipment, and the card must not
 * ask for the address of the old one); else the customer's newest kilos and
 * the place his cargo STARTS, read from the lines that neither ask where to
 * send it nor speak of a warehouse — or «Ivu omboringizga yuborsam bo'ladimi?»
 * would name the warehouse he sends TO as the origin (review R3). A weight
 * that is one piece's («har biri 2 kg») or asked about («30 kg dan oshsa
 * qancha?») is no shipment's, and a place turned down («Shenzhendan emas») is
 * not where it starts; a weight corrected («Kechirasiz, 35 kg ekan») keeps the
 * quote's origin, a load added («Yana yuk bor») does not (#1539).
 */
function aviaCargoOf(loop: Pick<LoopResult, 'outcomes'>, ctx: Pick<AgentContext, 'messages' | 'measures' | 'lastQuote'>): AviaCargo {
  const now = loop.outcomes.find((o) => o.air)?.air;
  if (now) return now;
  const quoted = ctx.lastQuote?.air ?? null;
  const since = quoted ? ctx.lastQuote!.at.getTime() : null;
  const bodyOf = new Map(ctx.messages.map((m) => [m.ref, m] as const));
  // A weight asked about after the quote («50 kg bo'lsa qancha?») is a what-if, not the next shipment.
  const weight =
    ctx.measures
      .filter((w) => w.kind === 'weight' && !w.ref.startsWith('d'))
      .filter((w) => {
        const m = bodyOf.get(w.messageRef);
        return m !== undefined && (since === null || m.sentAt.getTime() > since) && shipmentWeightIn(m.body, { whatIfCounts: !quoted });
      })
      .at(-1) ?? null;
  if (quoted && weight === null) return quoted;
  // The NEWEST place told is the shipment's: «… Shenzhendan» last week, «endi Guanchjoudan» today.
  const told = ctx.messages
    .filter((m) => m.direction === 'in' && (since === null || m.sentAt.getTime() > since))
    .flatMap((m) => m.body.split(CLAUSE))
    .filter((st) => !asksWhereToSend([{ body: st }]) && !WAREHOUSE_WORD.test(st))
    .reverse();
  const origin = told.map((st) => startsFrom(st)).find((o) => o !== null) ?? null;
  // A corrected weight is the same shipment, which starts where it did; a load ADDED starts where it is said to.
  const sameLoad = weight !== null && !addsALoadIn(bodyOf.get(weight.messageRef)?.body ?? '');
  return { kg: weight?.value ?? null, origin: origin?.place ?? (sameLoad ? (quoted?.origin ?? null) : null) };
}

/** A weight figure: digits, then a weight unit, in the six languages. */
const WEIGHT_FIGURE = /\d[\d\s.,]*\s*(?:kg|кг|kilo\p{L}*|кило\p{L}*|килограмм\p{L}*|公斤|千克|كيلو|کیلو)/iu;
/** One piece's weight, not the shipment's: «har biri», «each», «каждая», «по 2 кг», «每件» — as words, never «Beach». */
const PER_PIECE =
  /(?<![\p{L}])(?:har\s+bir(?:i|ida|ining)?|bittasi|donasi|dona\s+(?:boshiga|uchun)|ҳар\s+бир\p{L}*|each|per\s+(?:piece|box|unit|carton|item|pc)|каждая|каждый|каждой|каждое|за\s+(?:штук|шт|короб)\p{L}*|по\s+\d)(?![\p{L}])|每件|每箱|每个|单件|单个|هر\s+کدام|هر\s+عدد/iu;
/** A what-if: «50 kg bo'lsa qancha?», «agar 40 kg», «если 50 кг», «if it is 50 kg», «如果». */
const WHAT_IF = /(?<![\p{L}])(?:agar|bo['‘’ʻ`]?lsa|oshsa|ortsa|если|if|如果|假如|اگر)(?![\p{L}])/iu;
/** The clauses a weight is told in: a comma, a stop that is no decimal point («2.5 kg»), a question mark. */
const WEIGHT_CLAUSE = /(?<!\d)[,;]|[,;](?!\d)|[!?؟。！？\n]+|\.(?=\s|$)/u;

/**
 * The message tells a SHIPMENT's weight (#1539, #1540): a weight figure in a
 * clause that names no single piece — and, when `whatIfCounts` is false, that
 * is no what-if. «Avia bilan 30 kg qancha?» states the cargo, and so does
 * «Kechirasiz, 35 kg ekan, qayerga yuboray?» after a quote; «50 kg bo'lsa
 * qancha?» after one does not.
 */
export function shipmentWeightIn(body: string, opts: { whatIfCounts: boolean }): boolean {
  return statementsOf(body, WEIGHT_CLAUSE).some(
    (clause) => WEIGHT_FIGURE.test(clause) && !PER_PIECE.test(clause) && (opts.whatIfCounts || !WHAT_IF.test(clause)),
  );
}

/**
 * The place a statement says the cargo STARTS from (#1540): the one place it
 * names that is not turned down — «Guanchjoudan, Shenzhendan emas», «не из
 * Шэньчжэня, а из Гуанчжоу», «not from Shenzhen». The negation is the place's
 * own, never any «emas» in the statement («yuk hali tayyor emas»).
 */
function startsFrom(statement: string): { place: string } | null {
  const refused = new Set<string>();
  for (const m of statement.matchAll(/(\p{L}+)\s+(?:emas|эмас)(?![\p{L}])/giu)) for (const o of namedOrigins(m[1]!)) refused.add(o.place);
  for (const m of statement.matchAll(/(?<![\p{L}])(?:не|not|нет)\s+(?:из\s+|from\s+|с\s+)?(\p{L}+)/giu)) for (const o of namedOrigins(m[1]!)) refused.add(o.place);
  for (const m of statement.matchAll(/(?<![\p{L}])نه\s+(?:از\s+)?(\S+)|不是(?:从)?(\p{Script=Han}{2,4})/gu)) for (const o of namedOrigins(m[1] ?? m[2] ?? '')) refused.add(o.place);
  const left = namedOrigins(statement).filter((o) => !refused.has(o.place));
  return left.length === 1 ? left[0]! : null;
}

const ADDRESS_WORD = /manzil|адрес|address|地址|آدرس/iu;

/** «Where do I send it» in the six languages: an address word, «where to», or «where is your warehouse». */
const SEND_ASK =
  /manzil|манзил|adres|адрес|address|lokatsiya|локация|location|نشانی|آدرس|地址|(?<![\p{L}])(?:qayerga|қаерга|qayoqqa|қаёққа|куда)(?![\p{L}])|where\s+(?:do|should|can|to)\b|which\s+warehouse|qaysi\s+(?:omborga|skladga)|в\s+какой\s+склад|کجا\s*(?:ارسال|بفرستم|بفرستیم)|寄到哪|发到哪|送到哪|寄哪|发哪/iu;
const WAREHOUSE_WORD = /ombor|sklad|склад|warehouse|仓库|انبار/iu;
const WHERE_WORD = /qayerda|қаерда|где|where|在哪|کجا/iu;
/**
 * What an address word says when nobody is asking where to send: the address
 * is had or used («manzilni oldim», «shu manzilga yubordim»), it is his own
 * («mening manzilim»), it is Tashkent's (the pickup), it is a pickup.
 */
const NOT_SEND_ASK =
  /oldim|oldik|yubordim|jo['‘’ʻ`]?natdim|получил|отправил|got\s+it|received|i\s+sent|收到|发了|گرفتم|فرستادم|manzilim|манзилим|мой\s+адрес|my\s+address|آدرس\s+من|我的地址|toshkent|тошкент|ташкент|tashkent|塔什干|تاشکند|kelib\s+ol|olib\s+ket|забр|pick\s*-?\s*up|取货|提货/iu;
/**
 * Where the cargo ARRIVES (review #1538): «Yuk qayerga keladi?», «Куда придёт
 * груз?», «Куда доставите?», a city of Uzbekistan — asked without a sending
 * verb, that is the delivery end, not the Chinese one. OUR delivering only
 * («yetkazasiz», «доставите», «will you deliver»): the factory delivering to
 * us is the China end (#1539).
 */
const ARRIVAL =
  /yetib\s+kel|kel(?:di|adi|yapti|ishi)|yetkaz(?:asiz|ib\s+berasiz|iladi|ilad)|приш[её]л|пришл|прид[её]т|приед|доставит(?:е|ся)|доставят|доставк|arriv|(?:will|do|can)\s+you\s+deliver|delivered|到了|到达|送到乌|رسید|samarqand|самарканд|andijon|андижан|namangan|наманган|farg['‘’ʻ`]?ona|фергана|buxoro|бухар|qo['‘’ʻ`]?qon|коканд|urganch|ургенч|qarshi|карши|termiz|термез|nukus|нукус|jizzax|джизак|guliston|гулистан/iu;
/**
 * Sending or bringing the cargo TO us — the China end: «yuboray», «jo'nataman»,
 * «Zavod qayerga yetkazsin?», «olib kelaymi», «Куда доставить груз в Китае?»,
 * «deliver it to», or the question naming China itself (#1539).
 */
const SEND_VERB =
  /yubor|jo['‘’ʻ`]?nat|yetkaz(?:sin|ay|sam|ib\s+ber(?:ay|sin|sam))|olib\s+kel(?:ay|sin|sam|aman|ishim)|отправ|вышл|пошл|доставить|привез|send|ship|deliver\s+(?:it|them|the|our|my|cargo|goods)|寄|发|ارسال|بفرست|xitoy(?:da(?!n)|dagi)|хитой(?:да(?!н)|даги)|в\s+кита[ей]|in\s+china|在中国|中国(?:哪|的)/iu;
/** «Manzil: Andijon, Navoiy ko'chasi 12» — an address GIVEN, not asked for. */
const GIVEN_ADDRESS = /(?:manzil|манзил|adres|адрес|address)\p{L}*\s*:\s*[^\s?？][^\n]*/giu;

/**
 * The customer asks where to SEND the cargo (review R2) — statement by
 * statement, so «Rahmat, manzilni oldim» and «Toshkentda manzilingiz qayerda?»
 * ask nothing, and neither do «откуда» or «qayergacha». Not `askedLocation`'s
 * wider «qayer»: «Yuk qayerda?» asks where the cargo IS. An address he GIVES
 * is not asked for, and where the cargo arrives is asked only with a sending
 * verb beside it (review #1538).
 */
export function asksWhereToSend(lines: readonly Pick<ChatMessage, 'body'>[]): boolean {
  return lines
    .flatMap((m) => m.body.replace(GIVEN_ADDRESS, ' ').split(CLAUSE))
    .some(
      (st) =>
        (SEND_ASK.test(st) || (WAREHOUSE_WORD.test(st) && WHERE_WORD.test(st))) &&
        !NOT_SEND_ASK.test(st) &&
        (SEND_VERB.test(st) || !ARRIVAL.test(st)),
    );
}

/**
 * The model's own question already asks the flight's ADDRESS (review D8):
 * both the flight and the address are named. A bare «air» matched «chair»
 * and «Kairat», and «Avia narxini tasdiqlang» asked for no address at all.
 */
function asksAviaAddress(question: string): boolean {
  return namesMode(question, 'air') && ADDRESS_WORD.test(question);
}

/** The card's avia line: what he needs to give the address. */
export function aviaOwnerQuestion(air: AviaCargo): string {
  const kg = air.kg === null ? "og'irligi aytilmagan" : `${air.kg} kg`;
  return `Avia: ${kg}, qayerdan: ${air.origin ?? 'aytilmagan'} — mijozga avia manzilini yozing (✏️).`;
}

/**
 * His «Temir yo'l mendan so'rasin» (2026-10-24): a burst that asks about rail
 * is HIS question whatever the model composed — the draft is forced
 * `needs_owner` and carries the question for him when the model asked none.
 * The prompt tells the model never to quote rail; G1 already blocks a figure
 * with no source. This is the part that does not depend on the model
 * listening.
 */
export function withRailRule(c: ComposeReply, ctx: Pick<AgentContext, 'burst'>): ComposeReply {
  if (!railQuestion(ctx, c)) return c;
  return { ...c, needsOwner: true, ownerQuestion: c.ownerQuestion || RAIL_OWNER_QUESTION, forcedQuestion: 'rail' };
}

/**
 * The customer is asking about rail NOW: the newest of these messages that
 * names a road names rail (fix round) — «the newest statement wins», the
 * checklist's rule. A chat that asked «temir yo'l bilan qancha?», heard «Temir
 * yo'l hozir ishlamayapti, fura bilan yuboramiz» and then chose «Unda fura
 * bilan 5 kub 800 kg qancha?» is a truck chat again; one that asked rail and
 * then sent only «5 kub, 800 kg» is still a rail chat — his own «aniqlab
 * aytaman» is no other road.
 */
function railAsked(messages: readonly { body: string }[]): boolean {
  // Statement by statement, newest first (#1540): «Poyezd kerak emas, avia bilan» turns rail down for the
  // flight, «Temir yo'l uzoq ekan, avia bilan yuboraman» chooses the flight after it — neither is his rail
  // question. A statement naming rail and another road together («Avia yoki poyezdda?») asks rail too.
  for (const m of [...messages].reverse()) {
    for (const st of statementsOf(m.body, CLAUSE).reverse()) {
      if (mentionsRail([st])) return !railRefusedIn(st);
      const c = roadChoiceIn(st);
      if (c === 'air' || c === 'road' || c === 'both') return false;
    }
  }
  return false;
}

/**
 * The reply speaks of rail AND carries a figure that could be its price (K18).
 * A rail word alone is no rail quote: the seeded «…faqat avto yoki temir yo'l
 * bilan ketadi» answers a power-bank question, and the card asked him «Mijoz
 * temir yo'l narxini so'rayapti» about it (fix round).
 */
function railQuoted(replyText: string): boolean {
  // In the rail word's own sentence (#1540): the address after «… faqat avto yoki temir yo'l bilan ketadi.»
  // carries «2255号», a house number, and it made the avia chat a rail chat that switched the address guard off.
  return statementsOf(replyText, RAIL_SENTENCE).some(
    (st) => mentionsRail([st]) && extractNumbers(st).some((f) => f.kind === 'money' || (f.kind === 'plain' && f.fixed !== true)),
  );
}
const RAIL_SENTENCE = /[!?؟。！？\n]+|\.(?=\s|$)/u;

/** His question: the burst asks about rail, or the model is answering one with a figure. */
function railQuestion(ctx: Pick<AgentContext, 'burst'>, c: Pick<ComposeReply, 'replyText'>): boolean {
  return railAsked(ctx.burst) || railQuoted(c.replyText);
}

/** The chat is about rail: its inbound window's newest road, the burst's, or the reply's rail figure (K18). */
export function railChat(ctx: Pick<AgentContext, 'burst' | 'messages'>, c: Pick<ComposeReply, 'replyText'>): boolean {
  return railAsked(ctx.messages.filter((m) => m.direction === 'in')) || railQuestion(ctx, c);
}

/**
 * Said on the card when the rail question is only EARLIER in the chat — the
 * draft is not his question, but its figures carry no source, and a bare
 * «manbasi yo'q» would not tell him why.
 */
export function railNote(ctx: Pick<AgentContext, 'burst' | 'messages'>, c: Pick<ComposeReply, 'replyText'>): string | null {
  if (!railChat(ctx, c) || railQuestion(ctx, c)) return null;
  return "Suhbatda avvalroq temir yo'l so'ralgan — AI narx aytmaydi, narxni siz ayting.";
}

/**
 * A translation he can READ (K29, fix round): three letters at least, in the
 * Latin or Cyrillic script. The Persian reply copied into `gloss_uz`, or a
 * lone «.», unlocked ✅ on a draft he still could not read.
 */
export function glossReadable(gloss: string): boolean {
  const g = gloss.trim();
  if ([...g.matchAll(/\p{L}/gu)].length < 3) return false;
  const script = dominantScript(g);
  return script === 'latin' || script === 'cyrillic';
}

export function stripFor(ctx: AgentContext): string[] {
  return [...ctx.identity.codes.map((c) => c.clientCode), ...(ctx.identity.customerName ? ctx.identity.customerName.split(/\s+/u) : [])];
}

/**
 * The actions ✅ will run, each checked by the server (fit-13, money-6): a
 * calc_submit only with a COMPLETE checklist of the same section from this
 * run and no linked request still open; a follow-up only on a real day within
 * 60 days. A dropped action is said on the card.
 */
export function validateActions(
  c: ComposeReply,
  ctx: AgentContext,
  outcomes: readonly ToolOutcome[],
  now: Date,
): { actions: ComposedAction[]; notes: string[] } {
  const actions: ComposedAction[] = [];
  const notes: string[] = [];
  const lastChecklist = [...outcomes].reverse().find((o) => o.checklist)?.checklist ?? null;
  // Citations reach the whole chat the model read (#1622): a line it quotes is a line it saw. The figures a job
  // carries still come only from the checklist, which counts the recent window.
  const refs = new Map(ctx.history.map((m) => [m.ref, m]));
  for (const a of c.actions) {
    if (a.type === 'calc_submit') {
      const cl: ChecklistState | null = lastChecklist && lastChecklist.section === a.section ? lastChecklist : null;
      // The truck's minimum is the server's too (his «1 kubdan kam yuk qabul
      // qilmasin»): a job below it is never landed, whatever the checklist
      // the model ran said — asked first, so the card names the real reason.
      if (cl && TRUCK_SECTIONS.includes(cl.section) && belowTruckMinimumFacts(cl.facts)) {
        notes.push(
          `Yuk avto minimumidan kam (${AGENT_LIMITS.minShipment.m3} kub / ${AGENT_LIMITS.minShipment.kg} kg) — hisoblatishga yuborilmaydi.`,
        );
        continue;
      }
      if (!cl || !cl.complete) {
        notes.push("Hisoblatish taklif qilindi, lekin ma'lumot to'liq emas — yuborilmaydi.");
        continue;
      }
      if (ctx.openCalcs.some((x) => x.status === 'open')) {
        notes.push("Bu chatda ochiq hisoblatish bor — ikkinchisi yuborilmaydi.");
        continue;
      }
      const cited = a.citedMessageRefs
        .map((r) => refs.get(r))
        .filter((m): m is NonNullable<typeof m> => m !== undefined && m.direction === 'in')
        .map((m) => m.id);
      // No certificate choice (his 9, 2026-10-24): «kelib chiqish sertifikati
      // bor, biz o'zimiz olamiz» — the AI never asks, and every agent job lands
      // with the company's own (decide.ts `landCalc`).
      actions.push({
        type: 'calc_submit',
        section: cl.section,
        facts: cl.facts,
        fromOurWarehouse: cl.fromOurWarehouse,
        citedMessageIds: [...new Set(cited)],
      });
    } else if (a.type === 'set_followup') {
      const day = /^\d{4}-\d{2}-\d{2}$/u.exec(a.date)?.[0];
      const today = tashkentDay(now);
      const limit = tashkentDay(new Date(now.getTime() + 60 * 86_400_000));
      if (!day || day < today || day > limit) {
        notes.push("Qayta aloqa sanasi noto'g'ri — qo'yilmaydi.");
        continue;
      }
      actions.push({ type: 'set_followup', date: day, note: a.note.slice(0, 300) });
    } else if (a.type === 'mute') {
      actions.push({ type: 'mute', reason: a.note.slice(0, 300) || 'AI taklifi' });
    }
  }
  return { actions, notes };
}

/** The first cap refusal of the day says so once (fit-1). */
async function capNoticeOnce(ctx: AgentContext, reason: string, now: Date): Promise<void> {
  const dayStart = tashkentDayStart(tashkentDay(now));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(eq(agentRuns.outcome, 'capped'), gte(agentRuns.createdAt, dayStart)));
  if (Number(row?.n ?? 0) !== 1) return;
  const { notifyCapReached } = await import('./drafts');
  await notifyCapReached(ctx.managerUserId, reason);
}

/** Tests: the ids of today's runs for a chat, newest first. */
export async function __runsFor(managerUserId: string, peerId: bigint) {
  return db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.managerUserId, managerUserId), eq(agentRuns.peerId, peerId), notInArray(agentRuns.outcome, ['__none__'])))
    .orderBy(desc(agentRuns.createdAt));
}

/**
 * An owner-triggered run's refusal that clears without anybody acting — the
 * listener stamping again after a deploy. His own message in the chat
 * (`human_active`) and a limited account are not: the first is him answering,
 * the second waits on Telegram, and both are said to him instead.
 */
export function passesByItself(reason: Ineligible): boolean {
  return reason === 'listener_behind';
}

/**
 * His ✍️ answer an owner-triggered run redrafts from (spec SPEC-P1-v2 §2.2): the question draft it answers, the
 * customer line that question answered, the bot message his answer was, and his words.
 */
export interface OwnerAnswerInput {
  questionDraftId: string;
  questionAnchor: bigint;
  /** The edit of that line the question was drafted over (`agent_drafts.anchor_edited_at`) — what `answer_stale` compares a later edit with. */
  questionAnchorEditedAt: Date | null;
  /** How far the question's run had seen its burst (owner-answer-job `questionSeenAt`) — what `answer_stale` compares the rest of its burst with. */
  questionDraftedAt: Date | null;
  messageId: number;
  text: string;
}

/** The card's line on a redraft his answer could not make a reply of (a forcing rule asked him again). */
export const ANSWER_STILL_HIS =
  '✍️ Javobingiz olindi, lekin bu savolni AI o‘zi yozmaydi (temir yo‘l narxi yoki avia manzili) — «✏️ O‘zgartirish» bilan o‘zingiz yozing.';

/**
 * A run the OWNER's side starts — a VED hand-back's question for the customer
 * (fit-5), or the reply his ✍️ answer makes (`answer`, spec SPEC-P1-v2 §2.2).
 * Keyed by its own source (`agent_runs_source_unique`), so the same hand-back
 * — or the same answer — drafts once; the token cap holds, the inbound draft
 * cap does not (money-11: his own work must not compete with the customers'
 * day).
 *
 * His answer's redraft is the one owner-triggered draft that carries an «o'zi
 * yuborish» plan (§2.2): judged by the same gate, plus `owner_figure`,
 * `owner_personal` and `answer_stale` — a figure-free answer may go by itself,
 * one with his figure always comes back to him. It supersedes the question
 * draft only when written (`createDraft`'s `answers`), never before.
 */
export async function runOwnerTriggered(
  input: {
    trigger: 'hand_back' | 'calc_answer' | 'owner_edit';
    managerUserId: string;
    peerId: bigint;
    sourceKey: string;
    instruction: string;
    answer?: OwnerAnswerInput | null;
    /**
     * His confirmed lesson rewriting a reply still waiting for his ✅ («📝 Tuzatish», spec §3.4): the draft the
     * rewrite supersedes — inside its own transaction, and only while that draft still carries this lesson's mark.
     * The lesson is the INSTRUCTION, never a source, and the rewrite carries NO «o'zi yuborish» plan: a reply he has
     * just judged wrong comes back as an ordinary card.
     */
    lesson?: { draftId: string; lessonId: string } | null;
  },
  deps: RunDeps = {},
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  if (!(await agentTablesReady())) return { outcome: 'skipped', reason: 'not_ready' };
  const config = await readAgentConfig();
  if (!agentRunning(config) || config.ownerUserId !== input.managerUserId) return { outcome: 'skipped', reason: 'agent_off' };
  const callModel = deps.callModel ?? (aiConfigured() ? realCallModel : null);
  if (!callModel) return { outcome: 'skipped', reason: 'ai_not_configured' };
  const ctx = await loadContext(input.managerUserId, input.peerId, null);
  const t = now();
  if (!ctx.anchor || t.getTime() - ctx.anchor.sentAt.getTime() > AGENT_LIMITS.anchorMaxAgeMs) {
    return { outcome: 'skipped', reason: 'no_fresh_inbound' };
  }
  // The same chat rules an inbound run asks (review leak-nit): a chat he took
  // with 🙋, a colleague's phone, a muted chat, a paused account get no
  // hand-back draft either. Minus the clauses about the ANCHOR — this run was
  // started by the VED, not by the customer's newest message, so «is it still
  // the newest», «an auto-reply», «an echo of ours», «a repeat» do not apply.
  const elig = eligibleForRun({
    ...(await eligibilityFacts(ctx, config, t)),
    anchorIsNewest: true,
    anchorAutoSent: false,
    lastOutAt: null,
    anchorRepeats: false,
  });
  if (!elig.ok) {
    // A refusal that passes by itself (a tg-listen rebuild) is recorded
    // WITHOUT the source key: the key is what makes one hand-back one draft,
    // and taking it here would make a deploy-minute refusal final (review
    // A9). The caller tries once more; every other refusal takes the key.
    await db
      .insert(agentRuns)
      .values({
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        trigger: input.trigger,
        anchorTgMessageId: ctx.anchor.tgMessageId,
        sourceKey: passesByItself(elig.reason) ? null : input.sourceKey,
        outcome: 'refused',
        error: elig.reason,
      })
      .onConflictDoNothing();
    return { outcome: 'refused', reason: elig.reason };
  }
  const dayStart = tashkentDayStart(tashkentDay(t)).toISOString();
  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CAP_LOCK}))`);
    const today = await dayRunCounts(dayStart, null, tx);
    if (!(today.tokens < config.dailyTokenCap)) return 'capped';
    const rows = await tx
      .insert(agentRuns)
      .values({
        managerUserId: input.managerUserId,
        peerId: input.peerId,
        trigger: input.trigger,
        anchorTgMessageId: ctx.anchor!.tgMessageId,
        sourceKey: input.sourceKey,
        model: STAFF_MODEL,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    return rows[0]?.id ?? 'duplicate';
  });
  if (reserved === 'capped') return { outcome: 'capped', reason: 'daily_token_cap' };
  if (reserved === 'duplicate') return { outcome: 'stood_down', reason: 'duplicate' };
  const runId = reserved;
  const started = Date.now();
  let settle: Partial<typeof agentRuns.$inferInsert> = { outcome: 'error', error: 'unknown' };
  try {
    const facts = await generalFacts();
    // Read AFTER the lesson was confirmed: the rewrite's own head already carries it (§3.3, §3.4).
    const taught = await promptLessons();
    const canary = `gsr-${randomBytes(4).toString('hex')}`;
    const act = { priceArmed: await priceActArmed() };
    const loop = await runLoop({
      ctx,
      config,
      facts,
      day: tashkentDay(t),
      canary,
      callModel,
      now,
      instruction: input.instruction,
      priceArmed: act.priceArmed,
      lessons: taught.lessons,
    });
    settle = {
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadTokens: loop.usage.cacheReadTokens,
      cacheWriteTokens: loop.usage.cacheWriteTokens,
      toolCalls: loop.tools.map((x) => ({ name: x.name, ok: x.ok, text: x.text, estimate: x.estimate })),
    };
    const drafted = withAviaRule(withRailRule(loop.compose, ctx), loop, ctx, act);
    if (!drafted.replyNeeded && !drafted.needsOwner) {
      settle = { ...settle, outcome: 'no_reply', error: null };
      return { outcome: 'no_reply' };
    }
    const answer = input.answer ?? null;
    const memory = memoryFor(ctx, loop, facts, canary, answer?.text ?? null);
    const policy = await policyFor({ managerUserId: ctx.managerUserId, peerId: ctx.peerId, body: drafted.replyText, memory, strip: stripFor(ctx) });
    const c = withAviaGuard(drafted, policy, loop, ctx);
    const { actions, notes } = validateActions(c, ctx, loop.outcomes, t);
    const rail = railNote(ctx, c);
    if (rail) notes.push(rail);
    // A forcing rule turned his answer's redraft back into a question (§2.2): said on the card, never a loop.
    if (answer && c.forcedQuestion) notes.push(ANSWER_STILL_HIS);
    const fromAnswer = answer
      ? {
          questionDraftId: answer.questionDraftId,
          questionAnchor: String(answer.questionAnchor),
          // The question's OWN edit stamp, never this redraft's: the redraft anchors on the line as it is NOW, so an
          // edit made while he answered is its own stamp and no later check of the redraft could see it.
          questionAnchorEditedAt: answer.questionAnchorEditedAt?.toISOString() ?? null,
          // …and when the question was drafted: the burst it was asked about is every line since our last message,
          // and an edit or a delete of ANY of them after this moment is a wording he never saw (fix pass 3).
          questionDraftedAt: answer.questionDraftedAt?.toISOString() ?? null,
          // Asked of his words (his Q2 a ⭐) — a figure of his that the customer or a tool also carries is theirs
          // in the ledger, and the reply made of it must still come back to him.
          figures: answerHoldsFigure(answer.text),
          personal: await ownerPersonalOf({
            text: answer.text,
            ownCodes: ctx.identity.codes.map((x) => x.clientCode),
            ownNames: [
              ...(await knownNamesFor({ managerUserId: ctx.managerUserId, peerId: ctx.peerId, clientId: ctx.identity.clientId, leadId: ctx.identity.leadId })),
              ...(ctx.identity.customerName ? [ctx.identity.customerName] : []),
            ],
            cargoAllowed: ctx.identity.cargoAllowed,
          }),
        }
      : null;
    const lesson = input.lesson ?? null;
    const draftInput = {
      runId,
      ctx,
      compose: c,
      policy,
      memory,
      actions,
      notes,
      kind: input.trigger === 'hand_back' ? ('hand_back' as const) : ('reply' as const),
      fromAnswer,
      fromLesson: lesson,
      lessonSet: taught.mark,
    };
    // His answer's redraft alone carries a plan (§2.2) — judged on the very row about to be written, as the inbound
    // run's. A lesson's rewrite carries none (§3.4), and neither does a hand-back's question.
    const autoPlan = answer ? await autoPlanFor({ draft: autoShapeOf(draftFromRun(draftInput)), tools: loop.tools, now: now() }) : null;
    const written = await writeDraft({
      ...draftInput,
      autoPlan,
      answers: answer ? { draftId: answer.questionDraftId, messageId: answer.messageId, decidedBy: input.managerUserId } : null,
      redrafts: lesson ? { draftId: lesson.draftId, lessonId: lesson.lessonId, decidedBy: input.managerUserId } : null,
    });
    const stood = written.kind === 'editing' ? 'editing' : written.kind === 'question_gone' ? 'question_gone' : null;
    settle = { ...settle, outcome: stood ? 'stood_down' : 'draft', error: stood };
    return stood !== null ? { outcome: 'stood_down', reason: stood } : { outcome: 'draft', draftId: written.draftId, blocked: !policy.ok };
  } catch (err) {
    logger.error({ err, runId }, '[agent] owner-triggered run failed');
    settle = { ...settle, outcome: 'error', error: err instanceof Error ? err.message.slice(0, 300) : 'error' };
    return { outcome: 'error', reason: String(settle.error) };
  } finally {
    await db
      .update(agentRuns)
      .set({ ...settle, durationMs: Date.now() - started })
      .where(eq(agentRuns.id, runId))
      .catch((err: unknown) => logger.error({ err, runId }, '[agent] run not settled'));
  }
}
