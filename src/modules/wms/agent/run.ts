import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { aiConfigured, realCallModel, STAFF_MODEL, type CallModel, type ModelBlock, type ModelMessage, type ModelUsage } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { agentConversations, agentOutbox, agentRuns, clients, tgChatRules, tgOutbox, users } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { canLogInSql } from '../../platform/users/login';
import { pumpIsFresh, readGuard } from '../crm/account-guard';
import { agentRunning, agentTablesReady, readAgentConfig, type AgentConfig } from './config';
import { chatForm, loadContext, type AgentContext, type AviaCargo, type ChatMessage, type QuotedRoad } from './context';
import { eligibleForRun, type Ineligible } from './eligibility';
import { generalFacts, kbSearch, type KbHit } from './kb';
import { AGENT_LIMITS } from './limits';
import { detectLocale, dominantScript, type AgentLocale } from './locale';
import { askedLocation, customerNumberSources, policyFor, splitUrls, type PolicyMemory } from './policy-input';
import { chatBlock, runTail, stableHead } from './prompt';
import { JOB_AGENT_INBOUND, type AgentInboundJob } from './queues';
import { dayRunCounts } from './today';
import { addsALoadIn, belowTruckMinimumFacts, ourChinaPlaces, runTool, TOOL_SPECS, TRUCK_SECTIONS, type ChecklistState, type ToolOutcome } from './tools';
import { namedOrigin } from './origin';
import { draftWorthy, mentionsRail, RAIL_OWNER_QUESTION } from './worthy';
import { writeDraft, writeNotice, type ComposedAction } from './drafts';
import { airMentionIn, extractNumbers, factSources, namesMode, oneModeIn, pricedRoadOf, roadChoiceIn, type NumberSource, type TravelMode } from './numbers';
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
  confidence: number;
  needsOwner: boolean;
  ownerQuestion: string;
  nextStep: string;
  actions: { type: string; section: string; citedMessageRefs: string[]; date: string; note: string }[];
  usedFactIds: string[];
  citedMessageRefs: string[];
}

interface LoopResult {
  compose: ComposeReply;
  tools: { name: string; ok: boolean; text: string }[];
  outcomes: ToolOutcome[];
  usage: ModelUsage;
}

const CAP_LOCK = 'agent_run_cap';
const LOOP_WALL_MS = 90_000;

async function reschedule(job: AgentInboundJob, startAfterS: number, deps: RunDeps): Promise<void> {
  const next: AgentInboundJob = { ...job, origin: 'typing_wait' };
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

function parseCompose(input: Record<string, unknown>): ComposeReply {
  const lang = AGENT_LOCALES.find((l) => l === input.language) ?? 'uz';
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : [];
  return {
    replyNeeded: input.reply_needed !== false,
    replyText: asText(input.reply_text).trim(),
    language: lang,
    glossUz: asText(input.gloss_uz).trim(),
    category: asText(input.category) || 'other',
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
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
}): Promise<LoopResult> {
  const { ctx } = input;
  const started = input.now().getTime();
  const opening = input.instruction ? `${chatBlock(ctx)}\n\nVAZIFA: ${input.instruction}` : chatBlock(ctx);
  const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: opening }] }];
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
  };
  for (let round = 0; round < AGENT_LIMITS.maxToolRounds; round++) {
    if (input.now().getTime() - started > LOOP_WALL_MS) throw new Error('wall_clock');
    const res = await input.callModel({
      model: STAFF_MODEL,
      systemCached: stableHead({ styleGuide: input.config.styleApprovedAt ? input.config.styleGuide : null, facts: input.facts }),
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
      tools.push({ name: u.name, ok: out.ok, text: out.text.slice(0, 500) });
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

  // A person's own message in this chat — his phone, a colleague in the CRM — within the pause.
  const outIds = ctx.messages.filter((m) => m.direction === 'out').map((m) => m.tgMessageId);
  const agentIds = outIds.length
    ? await db
        .select({ id: agentOutbox.tgMessageId })
        .from(agentOutbox)
        .where(and(eq(agentOutbox.managerUserId, ctx.managerUserId), inArray(agentOutbox.tgMessageId, outIds)))
    : [];
  const agentSet = new Set(agentIds.map((r) => String(r.id)));
  const lastHuman = [...ctx.messages].reverse().find((m) => m.direction === 'out' && !agentSet.has(String(m.tgMessageId)));
  const pauseMs = config.humanPauseMin * 60_000;
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
    const { runs, chat, tokens } = await dayRunCounts(dayStart, { managerUserId: job.managerUserId, peerId: BigInt(job.peerId) }, tx);
    if (!(runs < config.dailyDraftCap)) return 'capped:daily_draft_cap';
    if (!(chat < AGENT_LIMITS.runsPerChatPerDay)) return 'capped:chat_runs';
    if (!(tokens < config.dailyTokenCap)) return 'capped:daily_token_cap';
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

/** The attempt this job runs as: the sweep's retry is 1, an edit of the anchor gets its own from 100 (regression-10). */
async function attemptFor(job: AgentInboundJob): Promise<number> {
  if (job.origin !== 'edit') return job.attempt ?? 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.managerUserId, job.managerUserId),
        eq(agentRuns.peerId, BigInt(job.peerId)),
        eq(agentRuns.anchorTgMessageId, BigInt(job.anchorTgMessageId)),
        gte(agentRuns.attempt, 100),
      ),
    );
  return 100 + Number(row?.n ?? 0);
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
  if (conv?.typingAt && t.getTime() - conv.typingAt.getTime() < 6_000 && ageMs < AGENT_LIMITS.typingWaitCapMs) {
    await reschedule(job, AGENT_LIMITS.typingExtendMs / 1000, deps);
    return { outcome: 'rescheduled', reason: 'peer_typing' };
  }

  const worthy = draftWorthy(
    ctx.burst.map((m) => ({ text: m.body, media: m.media })),
    lastOutAsked(ctx),
  );
  const attempt = await attemptFor(job);
  if (!worthy.worthy) {
    if ('notice' in worthy) {
      if (await runLedgerRow(job, attempt, 'notice', worthy.reason)) await writeNotice(ctx, worthy.reason);
      return { outcome: 'notice', reason: worthy.reason };
    }
    // A ledger row, so the sweep's deploy-gap pass does not ask again every minute.
    await runLedgerRow(job, attempt, 'refused', worthy.reason);
    return { outcome: 'skipped', reason: worthy.reason };
  }
  if (worthy.greetingOnly && ageMs < AGENT_LIMITS.greetingWaitMs) {
    await reschedule(job, (AGENT_LIMITS.greetingWaitMs - ageMs) / 1000, deps);
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
    const canary = `gsr-${randomBytes(4).toString('hex')}`;
    const day = tashkentDay(t);
    const loop = await runLoop({ ctx, config, facts, day, canary, callModel, now });
    settle = {
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadTokens: loop.usage.cacheReadTokens,
      cacheWriteTokens: loop.usage.cacheWriteTokens,
      toolCalls: loop.tools.map((x) => ({ name: x.name, ok: x.ok, text: x.text })),
    };
    const drafted = withAviaRule(withRailRule(loop.compose, ctx), loop, ctx);
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

    const written = await writeDraft({
      runId,
      ctx,
      compose: c,
      policy,
      memory,
      actions,
      notes,
    });
    // The customer's language, remembered for the next «ok».
    const locale = detectLocale(ctx.anchor.body, ctx.storedLocale).locale ?? c.language;
    await db
      .insert(agentConversations)
      .values({ managerUserId: ctx.managerUserId, peerId: ctx.peerId, locale })
      .onConflictDoUpdate({
        target: [agentConversations.managerUserId, agentConversations.peerId],
        set: { locale, updatedAt: new Date() },
      });
    settle = { ...settle, outcome: written.kind === 'editing' ? 'stood_down' : 'draft', error: written.kind === 'editing' ? 'editing' : null };
    return written.kind === 'editing'
      ? { outcome: 'stood_down', reason: 'editing' }
      : { outcome: 'draft', draftId: written.draftId, blocked: !policy.ok };
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

/** What the run learned, kept on the draft so ✅ re-runs the policy on the same evidence (leak-3). */
export function memoryFor(ctx: AgentContext, loop: LoopResult, facts: KbHit[], canary: string): PolicyMemory {
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
  const found = loop.outcomes.flatMap((o) => o.sources).filter((s) => !rail || s.kind !== 'money');
  const sources: NumberSource[] = [...customerNumberSources(ctx.messages), ...found];
  // General facts are in every prompt: their non-money figures, phones and
  // links count as said by the company (a kb money figure never does — it
  // reads as `customer_money`, money-9). Each fact is read ALONE (B2): the
  // payment fact names money, and joined to the rest it made every street
  // number and hour of every other fact a price nobody may repeat.
  for (const f of facts) sources.push(...factSources(f.answer, 'kompaniya bilimi'));
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
    aviaOnly: !rail && road === 'air',
    // The flight was spoken of and the rule did not decide it is the chat's
    // road (#1485): a reply giving our warehouse's address keeps its ✅ and the
    // card says so — a chat the words misread costs him one look, never a
    // flight sent to a truck's warehouse in silence.
    aviaMentioned: !rail && road !== 'air' && aviaSpokenOf(ctx, road),
    // What this run quoted, for the next run's `lastQuote` (review R1).
    quotedRoad: rail ? null : quotedRoadOf(loop),
    quotedAir: rail ? null : (loop.outcomes.find((o) => o.air)?.air ?? null),
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
 * the newest that names a road decides (#1485): the road it chooses or names
 * («Avia qimmat ekan, kargo bilan necha kunda?» asks the truck's days, and
 * «Temir yo'l bilan qancha, avia qimmat» the rail's), and a road only turned
 * down points at the other one when nothing earlier names any.
 */
export function askedModeOf(ctx: Pick<AgentContext, 'burst' | 'messages'>): TravelMode | null {
  const burst = ctx.burst.map((m) => m.body);
  const window = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.body);
  for (const texts of [burst, window]) {
    let turnedDown: TravelMode | null = null;
    for (const st of texts.flatMap((t) => t.split(CLAUSE)).reverse()) {
      const named = oneModeIn(st);
      const c = roadChoiceIn(st);
      // Rail named and no other road chosen beside it: «Fura emas, temir yo'l kerak» asks the rail's days.
      if (namesMode(st, 'rail') && c !== 'air' && c !== 'road' && c !== 'both') return 'rail';
      if (c === 'both') return null;
      if (c === 'air' || c === 'road') return c;
      if (c === 'not_air' || c === 'not_road') {
        turnedDown ??= c === 'not_air' ? 'road' : 'air';
        continue;
      }
      if (named) return named;
      if (namesMode(st, 'air') && namesMode(st, 'road')) return null;
    }
    if (turnedDown) return turnedDown;
  }
  return null;
}

/** Avia was spoken of in the chat or in the quote he approved this week (#1485) — by anybody, in any statement. */
function aviaSpokenOf(ctx: Pick<AgentContext, 'messages' | 'lastQuote'>, road: QuotedRoad | null): boolean {
  const quoted = ctx.lastQuote?.road;
  return road === 'both' || quoted === 'air' || quoted === 'both' || ctx.messages.some((m) => airMentionIn(m.body));
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
 * qimmat ekan», «Mashinada emas») is the other one (review #1484). Null: no
 * road chosen.
 */
export function roadChosenIn(texts: readonly string[]): QuotedRoad | null {
  const statements = texts.flatMap((t) => t.split(CLAUSE)).reverse();
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
 * aside — the stored copy of a sent text is not always its byte (#1485).
 */
const sentForm = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/gu, ' ').replace(/(?:…|\.\.\.)$/u, '').trim().toLowerCase();

/**
 * The road the chat is on — the one rule the avia guard and the card's
 * question both ask (review R1-R2, #1484). What THIS run priced or asked comes
 * first; after it the NEWEST piece of evidence wins: a road the customer
 * chose in any of his lines, the road one of OUR priced lines quoted (read at
 * its price — and the echo of the quote he approved, known by its Telegram id
 * or its words, is that draft's own stored road, since its text names goods
 * as often as roads; unless he rewrote it, #1485), or the quote
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
  // the quote's text is compared in the same form (#1485).
  const echo = q?.text ? sentForm(chatForm(q.text)) : null;
  let echoSeen = false;
  const evidence: { road: QuotedRoad; at: number; i: number }[] = [];
  ctx.messages.forEach((m, i) => {
    let road: QuotedRoad | null = null;
    if (m.direction === 'in') road = roadChosenIn([m.body]);
    else if (q && ((q.tgMessageId !== null && m.tgMessageId === q.tgMessageId) || (echo !== null && sentForm(m.body) === echo))) {
      echoSeen = true;
      // His ✏️ words are his, and the stored road is the model's (#1485): an
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
): ComposeReply {
  if (railChat(ctx, c)) return c;
  const quoted = loop.outcomes.find((o) => o.air)?.air;
  if (quoted) return withAviaQuestion(c, quoted);
  if (c.replyNeeded && chatRoadOf(ctx, loop) === 'air' && asksWhereToSend(ctx.burst)) return withAviaQuestion(c, aviaCargoOf(loop, ctx));
  return c;
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
  if (asksAviaAddress(asked) || asked.includes(line)) return { ...c, needsOwner: true };
  return { ...c, needsOwner: true, ownerQuestion: asked ? `${asked} · ${line}` : line };
}

/**
 * The cargo the card names: what the tool quoted this run; else the quote he
 * approved — unless the customer has told a weight since (review #1484: «Yana
 * yuk bor: 80 kg, endi Guanchjoudan» is a new shipment, and the card must not
 * ask for the address of the old one); else the customer's newest kilos and
 * the place his cargo STARTS, read from the lines that neither ask where to
 * send it nor speak of a warehouse — or «Ivu omboringizga yuborsam bo'ladimi?»
 * would name the warehouse he sends TO as the origin (review R3). A weight
 * that is one piece's («har biri 2 kg») or asked about («30 kg dan oshsa
 * qancha?») is no shipment's, and a place turned down («Shenzhendan emas») is
 * not where it starts; a weight corrected («Kechirasiz, 35 kg ekan») keeps the
 * quote's origin, a load added («Yana yuk bor») does not (#1485).
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
        return m !== undefined && (since === null || m.sentAt.getTime() > since) && shipmentWeightIn(m.body, { askedCounts: !quoted });
      })
      .at(-1) ?? null;
  if (quoted && weight === null) return quoted;
  // The NEWEST place told is the shipment's: «… Shenzhendan» last week, «endi Guanchjoudan» today.
  const told = ctx.messages
    .filter((m) => m.direction === 'in' && (since === null || m.sentAt.getTime() > since))
    .flatMap((m) => m.body.split(CLAUSE))
    .filter((st) => !asksWhereToSend([{ body: st }]) && !WAREHOUSE_WORD.test(st) && !TURNED_DOWN.test(st))
    .reverse();
  const origin = told.map((st) => namedOrigin(st)).find((o) => o !== null) ?? null;
  // A corrected weight is the same shipment, which starts where it did; a load ADDED starts where it is said to.
  const sameLoad = weight !== null && !addsALoadIn(bodyOf.get(weight.messageRef)?.body ?? '');
  return { kg: weight?.value ?? null, origin: origin?.place ?? (sameLoad ? (quoted?.origin ?? null) : null) };
}

/** A weight figure: digits, then a weight unit, in the six languages. */
const WEIGHT_FIGURE = /\d[\d\s.,]*\s*(?:kg|кг|kilo\p{L}*|кило\p{L}*|килограмм\p{L}*|公斤|千克|كيلو|کیلو)/giu;
/** One piece's weight, not the shipment's: «har biri», «each», «каждая», «по 2 кг», «每件». */
const PER_PIECE =
  /har\s+bir(?:i|ida|ining)?|bittasi|donasi|dona\s+(?:boshiga|uchun)|ҳар\s+бир\p{L}*|each|per\s+(?:piece|box|unit|carton|item|pc)|каждая|каждый|каждой|каждое|за\s+(?:штук|шт|короб)\p{L}*|(?<![\p{L}])по\s+\d|每件|每箱|每个|单件|单个|هر\s+کدام|هر\s+عدد/iu;
/** A statement turned down: «Shenzhendan emas», «не из Шэньчжэня», «not from…», «不是». */
const TURNED_DOWN = /(?<![\p{L}])(?:emas|эмас|не|нет|not|no)(?![\p{L}])|不是|不在|نه|نیست/iu;

/**
 * The message tells a SHIPMENT's weight (#1485): a weight figure in a
 * sentence that names no single piece — and, when `askedCounts` is false,
 * that asks nothing: «Avia bilan 30 kg qancha?» states the cargo of a chat
 * with no quote yet, and after one «50 kg bo'lsa qancha?» is a what-if.
 */
export function shipmentWeightIn(body: string, opts: { askedCounts: boolean }): boolean {
  return (body.match(/[^.!?\n。！？؟]*[.!?\n。！？؟]*/gu) ?? []).some((sentence) => {
    WEIGHT_FIGURE.lastIndex = 0;
    return WEIGHT_FIGURE.test(sentence) && (opts.askedCounts || !/[?？؟]/u.test(sentence)) && !PER_PIECE.test(sentence);
  });
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
 * Where the cargo ARRIVES (review #1484): «Yuk qayerga keladi?», «Куда придёт
 * груз?», «Куда доставите?», a city of Uzbekistan — asked without a sending
 * verb, that is the delivery end, not the Chinese one. OUR delivering only
 * («yetkazasiz», «доставите», «will you deliver»): the factory delivering to
 * us is the China end (#1485).
 */
const ARRIVAL =
  /yetib\s+kel|kel(?:di|adi|yapti|ishi)|yetkaz(?:asiz|ib\s+berasiz|iladi|ilad)|приш[её]л|пришл|прид[её]т|приед|доставит(?:е|ся)|доставят|доставк|arriv|(?:will|do|can)\s+you\s+deliver|delivered|到了|到达|送到乌|رسید|samarqand|самарканд|andijon|андижан|namangan|наманган|farg['‘’ʻ`]?ona|фергана|buxoro|бухар|qo['‘’ʻ`]?qon|коканд|urganch|ургенч|qarshi|карши|termiz|термез|nukus|нукус|jizzax|джизак|guliston|гулистан/iu;
/**
 * Sending or bringing the cargo TO us — the China end: «yuboray», «jo'nataman»,
 * «Zavod qayerga yetkazsin?», «olib kelaymi», «Куда доставить груз в Китае?»,
 * «deliver it to», or the question naming China itself (#1485).
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
 * verb beside it (review #1484).
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
  return { ...c, needsOwner: true, ownerQuestion: c.ownerQuestion || RAIL_OWNER_QUESTION };
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
  for (const m of [...messages].reverse()) {
    if (mentionsRail([m.body])) return true;
    if (namesMode(m.body, 'road') || namesMode(m.body, 'air')) return false;
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
  if (!mentionsRail([replyText])) return false;
  return extractNumbers(replyText).some((f) => f.kind === 'money' || (f.kind === 'plain' && f.fixed !== true));
}

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
  const refs = new Map(ctx.messages.map((m) => [m.ref, m]));
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
 * A run the OWNER's side starts — a VED hand-back's question for the customer
 * (fit-5). Keyed by its own source (`agent_runs_source_unique`), so the same
 * hand-back drafts once; the token cap holds, the inbound draft cap does not
 * (money-11: his own work must not compete with the customers' day).
 */
export async function runOwnerTriggered(
  input: {
    trigger: 'hand_back' | 'calc_answer' | 'owner_edit';
    managerUserId: string;
    peerId: bigint;
    sourceKey: string;
    instruction: string;
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
    const canary = `gsr-${randomBytes(4).toString('hex')}`;
    const loop = await runLoop({ ctx, config, facts, day: tashkentDay(t), canary, callModel, now, instruction: input.instruction });
    settle = {
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadTokens: loop.usage.cacheReadTokens,
      cacheWriteTokens: loop.usage.cacheWriteTokens,
      toolCalls: loop.tools.map((x) => ({ name: x.name, ok: x.ok, text: x.text })),
    };
    const drafted = withAviaRule(withRailRule(loop.compose, ctx), loop, ctx);
    if (!drafted.replyNeeded && !drafted.needsOwner) {
      settle = { ...settle, outcome: 'no_reply', error: null };
      return { outcome: 'no_reply' };
    }
    const memory = memoryFor(ctx, loop, facts, canary);
    const policy = await policyFor({ managerUserId: ctx.managerUserId, peerId: ctx.peerId, body: drafted.replyText, memory, strip: stripFor(ctx) });
    const c = withAviaGuard(drafted, policy, loop, ctx);
    const { actions, notes } = validateActions(c, ctx, loop.outcomes, t);
    const rail = railNote(ctx, c);
    if (rail) notes.push(rail);
    const written = await writeDraft({ runId, ctx, compose: c, policy, memory, actions, notes, kind: input.trigger === 'hand_back' ? 'hand_back' : 'reply' });
    settle = { ...settle, outcome: written.kind === 'editing' ? 'stood_down' : 'draft', error: written.kind === 'editing' ? 'editing' : null };
    return written.kind === 'editing'
      ? { outcome: 'stood_down', reason: 'editing' }
      : { outcome: 'draft', draftId: written.draftId, blocked: !policy.ok };
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
