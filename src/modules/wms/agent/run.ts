import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { aiConfigured, realCallModel, STAFF_MODEL, type CallModel, type ModelBlock, type ModelMessage, type ModelUsage } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { agentConversations, agentOutbox, agentRuns, clients, tgChatRules, tgOutbox, users } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { readGuard } from '../crm/account-guard';
import { agentRunning, agentTablesReady, readAgentConfig, type AgentConfig } from './config';
import { loadContext, type AgentContext } from './context';
import { eligibleForRun, type Ineligible } from './eligibility';
import { generalFacts, kbSearch, type KbHit } from './kb';
import { AGENT_LIMITS } from './limits';
import { detectLocale, type AgentLocale } from './locale';
import { askedLocation, customerNumberSources, policyFor, splitUrls, type PolicyMemory } from './policy-input';
import { chatBlock, runTail, stableHead } from './prompt';
import { JOB_AGENT_INBOUND, type AgentInboundJob } from './queues';
import { runTool, TOOL_SPECS, type ChecklistState, type ToolOutcome } from './tools';
import { draftWorthy } from './worthy';
import { writeDraft, writeNotice, type ComposedAction } from './drafts';
import type { NumberSource } from './numbers';
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
async function ledger(job: AgentInboundJob, attempt: number, outcome: 'refused' | 'notice' | 'capped', error: string): Promise<boolean> {
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
}): Promise<LoopResult> {
  const { ctx } = input;
  const started = input.now().getTime();
  const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'text', text: chatBlock(ctx) }] }];
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const tools: LoopResult['tools'] = [];
  const outcomes: ToolOutcome[] = [];
  const env = {
    ctx,
    day: input.day,
    kb: (q: string) =>
      kbSearch({ clientIds: ctx.identity.codes.map((c) => c.id), leadId: ctx.identity.leadId }, q),
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
      .where(and(eq(users.active, true), isNotNull(users.phone), sql`right(regexp_replace(${users.phone}, '\\D', '', 'g'), 9) IN (${sql.join(tails.map((t) => sql`${t}`), sql`, `)})`))
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
    listenerCurrent: guard?.agentPumpAt ? now.getTime() - guard.agentPumpAt.getTime() < AGENT_LIMITS.pumpFreshMs : false,
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
    const [counts] = await tx.execute<{ runs: number; chat: number; tokens: number }>(sql`
      SELECT
        count(*) FILTER (WHERE trigger = 'inbound' AND outcome NOT IN ('refused', 'capped', 'notice'))::int AS runs,
        count(*) FILTER (WHERE trigger = 'inbound' AND outcome NOT IN ('refused', 'capped', 'notice')
                          AND manager_user_id = ${job.managerUserId} AND peer_id = ${job.peerId}::bigint)::int AS chat,
        coalesce(sum(input_tokens + output_tokens + cache_write_tokens), 0)::int AS tokens
      FROM agent_runs WHERE created_at >= ${dayStart}::timestamptz`);
    const runs = Number(counts?.runs ?? 0);
    const chat = Number(counts?.chat ?? 0);
    const tokens = Number(counts?.tokens ?? 0);
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
      if (await ledger(job, attempt, 'notice', worthy.reason)) await writeNotice(ctx, worthy.reason);
      return { outcome: 'notice', reason: worthy.reason };
    }
    // A ledger row, so the sweep's deploy-gap pass does not ask again every minute.
    await ledger(job, attempt, 'refused', worthy.reason);
    return { outcome: 'skipped', reason: worthy.reason };
  }
  if (worthy.greetingOnly && ageMs < AGENT_LIMITS.greetingWaitMs) {
    await reschedule(job, (AGENT_LIMITS.greetingWaitMs - ageMs) / 1000, deps);
    return { outcome: 'rescheduled', reason: 'greeting_only' };
  }

  const elig = eligibleForRun(await eligibilityFacts(ctx, config, t));
  if (!elig.ok) {
    await ledger(job, attempt, 'refused', elig.reason);
    return { outcome: 'refused', reason: elig.reason };
  }

  const reserved = await reserve(job, attempt, config, t);
  if (reserved === 'duplicate') return { outcome: 'stood_down', reason: 'duplicate' };
  if (reserved.startsWith('capped:')) {
    const fresh = await ledger(job, attempt, 'capped', reserved.slice(7));
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
    const c = loop.compose;
    if (!c.replyNeeded && !c.needsOwner) {
      settle = { ...settle, outcome: 'no_reply', error: null };
      return { outcome: 'no_reply' };
    }

    const memory = memoryFor(ctx, loop, facts, canary);
    const policy = await policyFor({
      managerUserId: ctx.managerUserId,
      peerId: ctx.peerId,
      body: c.replyText,
      memory,
      strip: stripFor(ctx),
    });
    const { actions, notes } = validateActions(c, ctx, loop.outcomes, t);
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
  const sources: NumberSource[] = [...customerNumberSources(ctx.messages), ...loop.outcomes.flatMap((o) => o.sources)];
  // General facts are in every prompt: their non-money figures, phones and
  // links count as said by the company (a kb money figure never does — the
  // customer-sources reading turns it into `customer_money`, money-9).
  const factText = facts.map((f) => f.answer).join('\n');
  sources.push(...customerNumberSources([{ direction: 'in', body: factText, ref: 'bilim' }]).map((s) => ({ ...s, label: 'kompaniya bilimi' })));
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
    hasEstimate: loop.outcomes.some((o) => o.estimate === true),
    ownCodes: ctx.identity.codes.map((c) => c.clientCode),
    managerName: ctx.identity.managerName,
    canary,
  };
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
      actions.push({ type: 'calc_submit', section: cl.section, facts: cl.facts, certificate: cl.certificate, citedMessageIds: [...new Set(cited)] });
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
