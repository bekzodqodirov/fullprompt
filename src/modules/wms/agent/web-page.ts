import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentDrafts,
  agentOutbox,
  calcRequests,
  clients,
  kbFacts,
  leads,
  tgAccountGuard,
  tgAccounts,
  users,
} from '../../platform/db/schema';
import { canLogInSql } from '../../platform/users/login';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { MAX_OPEN_PER_REQUESTER, openRequests } from '../calc/service';
import { guardForUser } from '../crm/account-guard';
import { cardDigest, digestBody } from './card';
import { renderDraftCard } from './card-io';
import { agentTablesReady, type AgentConfig } from './config';
import { AGENT_LIMITS } from './limits';
import { agentStats, type AgentStats } from './stats';
import { dayRunCounts, sendsToday } from './today';
import { AVIA_KG_PER_M3 } from './tools';
import type { ComposedAction } from './types';

/**
 * What `/suhbatlar/ai` reads (spec §17.12). One module so the page stays a
 * layout and every number on it is a query a test can call.
 *
 * The card a draft shows here is the card the bot shows — `renderDraftCard`
 * over the STORED row — so the two doors read the same words, and the ✅ here
 * carries the digest `decideDraft` compares (leak-3): the digest of the body
 * and actions the page drew, computed exactly as the decision recomputes it.
 */

export interface WebDraft {
  id: string;
  managerUserId: string;
  holderName: string;
  status: string;
  kind: string;
  needsOwner: boolean;
  blocked: boolean;
  /** The text a ✏️ box opens with — his own, or the machine's. */
  body: string;
  /** `decideDraft`'s digest of what this card shows. */
  digest: string;
  cardText: string;
  /** Where the conversation is read: the thread, or the lead card's chat. */
  chatHref: string | null;
  createdAt: Date;
  outbox: { id: string; status: string; nextStepAt: Date; readDone: boolean; step: string } | null;
  /** The «remember this answer» question is open (spec §7.1.4) — and armed for a general fact. */
  kbAsk: boolean;
  kbArmed: boolean;
}

type DraftRow = typeof agentDrafts.$inferSelect;
type OutboxRow = typeof agentOutbox.$inferSelect;

/** The ✅'s digest, exactly as `decideDraft` recomputes it — `digestBody`, stored actions. */
export function webDigest(d: Pick<DraftRow, 'finalBody' | 'proposedBody' | 'actions'>): string {
  return cardDigest(digestBody(d), (d.actions ?? []) as ComposedAction[]);
}

function chatHrefOf(d: Pick<DraftRow, 'clientId' | 'leadId'>): string | null {
  if (d.clientId) return `/suhbatlar/${d.clientId}`;
  if (d.leadId) return `/crm/leads/${d.leadId}#tg-thread`;
  return null;
}

function toWeb(d: DraftRow, o: OutboxRow | null, holderName: string): WebDraft {
  const kb = ((d.policy ?? {}) as { kb?: string }).kb;
  return {
    id: d.id,
    managerUserId: d.managerUserId,
    holderName,
    status: d.status,
    kind: d.kind,
    needsOwner: d.needsOwner,
    blocked: d.blocked,
    body: digestBody(d),
    digest: webDigest(d),
    cardText: renderDraftCard(d, o),
    chatHref: chatHrefOf(d),
    createdAt: d.createdAt,
    outbox: o ? { id: o.id, status: o.status, nextStepAt: o.nextStepAt, readDone: o.readDone, step: o.step } : null,
    kbAsk: d.status === 'approved' && d.needsOwner && d.finalBody !== null && kb !== 'saved' && kb !== 'skipped',
    kbArmed: kb === 'general_armed',
  };
}

const LIST_CAP = 60;

/**
 * The page's three draft lists. «Kutilmoqda» = live drafts that are not a
 * question to him; «Savollar» = live drafts that ARE one (`needs_owner`), plus
 * answered ones whose «remember this?» is still open; the approved replies
 * still waiting to leave sit under «Kutilmoqda» with their cancel.
 */
export async function webDrafts(now = new Date()): Promise<{
  pending: WebDraft[];
  questions: WebDraft[];
  remember: WebDraft[];
  waiting: WebDraft[];
}> {
  const draftsWithOutbox = () =>
    db
      .select({ d: agentDrafts, o: agentOutbox, holder: users.fullName })
      .from(agentDrafts)
      .innerJoin(users, eq(users.id, agentDrafts.managerUserId))
      .leftJoin(agentOutbox, eq(agentOutbox.draftId, agentDrafts.id));
  const [liveRows, waitingRows, rememberRows] = await Promise.all([
    draftsWithOutbox()
      .where(inArray(agentDrafts.status, ['pending', 'editing']))
      .orderBy(desc(agentDrafts.createdAt))
      .limit(LIST_CAP),
    draftsWithOutbox()
      .where(and(eq(agentDrafts.status, 'approved'), inArray(agentOutbox.status, ['agent', 'sending'])))
      .orderBy(asc(agentOutbox.nextStepAt))
      .limit(LIST_CAP),
    draftsWithOutbox()
      .where(
        and(
          eq(agentDrafts.status, 'approved'),
          eq(agentDrafts.needsOwner, true),
          sql`${agentDrafts.finalBody} IS NOT NULL`,
          sql`coalesce(${agentDrafts.policy}->>'kb', '') NOT IN ('saved', 'skipped')`,
          gte(agentDrafts.updatedAt, new Date(now.getTime() - 7 * 86_400_000)),
        ),
      )
      .orderBy(desc(agentDrafts.updatedAt))
      .limit(20),
  ]);
  const live = liveRows.map((r) => toWeb(r.d, r.o, r.holder));
  return {
    pending: live.filter((d) => !d.needsOwner),
    questions: live.filter((d) => d.needsOwner),
    remember: rememberRows.map((r) => toWeb(r.d, r.o, r.holder)),
    waiting: waitingRows.map((r) => toWeb(r.d, r.o, r.holder)),
  };
}

export interface WebKbFact {
  id: string;
  scope: 'general' | 'client' | 'lead';
  /** «GS777 · Ali» / «Lid: Bobur» — whose fact a per-customer one is. */
  owner: string | null;
  question: string | null;
  answer: string;
  source: string;
  usesCount: number;
  createdAt: Date;
}

/** The knowledge the agent may state: every live fact, general first, then each customer's. */
export async function webKbFacts(): Promise<{ facts: WebKbFact[]; retired: number }> {
  const [rows, [retired]] = await Promise.all([
    db
      .select({
        id: kbFacts.id,
        scope: kbFacts.scope,
        question: kbFacts.question,
        answer: kbFacts.answer,
        source: kbFacts.source,
        usesCount: kbFacts.usesCount,
        createdAt: kbFacts.createdAt,
        clientCode: clients.clientCode,
        clientName: clients.name,
        leadName: leads.name,
      })
      .from(kbFacts)
      .leftJoin(clients, eq(clients.id, kbFacts.clientId))
      .leftJoin(leads, eq(leads.id, kbFacts.leadId))
      .where(isNull(kbFacts.retiredAt))
      .orderBy(sql`CASE ${kbFacts.scope} WHEN 'general' THEN 0 ELSE 1 END`, asc(kbFacts.createdAt))
      .limit(300),
    db.select({ n: sql<number>`count(*)::int` }).from(kbFacts).where(sql`${kbFacts.retiredAt} IS NOT NULL`),
  ]);
  return {
    facts: rows.map((r) => ({
      id: r.id,
      scope: r.scope as WebKbFact['scope'],
      owner:
        r.scope === 'client'
          ? [r.clientCode, r.clientName].filter(Boolean).join(' · ')
          : r.scope === 'lead'
            ? `Lid: ${r.leadName ?? '—'}`
            : null,
      question: r.question,
      answer: r.answer,
      source: r.source,
      usesCount: r.usesCount,
      createdAt: r.createdAt,
    })),
    retired: Number(retired?.n ?? 0),
  };
}

/** Who may be the agent's account: a colleague who can sign in and holds a live Telegram connection here. */
export async function ownerCandidates(): Promise<{ id: string; name: string; tgPhone: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.fullName, tgPhone: tgAccounts.tgPhone })
    .from(tgAccounts)
    .innerJoin(users, eq(users.id, tgAccounts.managerUserId))
    .where(and(sql`${tgAccounts.status} <> 'signed_out'`, sql`${tgAccounts.sessionEnc} IS NOT NULL`, canLogInSql()))
    .orderBy(asc(users.fullName));
  return rows;
}

export interface AgentToday {
  /** Inbound runs today — what `daily_draft_cap` counts (run.ts `reserve`). */
  runs: number;
  drafts: number;
  errors: number;
  /** input + output + cache-write tokens today — what `daily_token_cap` counts. */
  tokens: number;
  /** AI sends today on the owner's account, against the day's ceiling (decide.ts's budget). */
  sends: number;
  sendCeiling: number;
}

/**
 * Today's usage — the reservation's own counts and the ✅'s own budget, read
 * from the ONE module both caps ask (today.ts, #513): what the page prints is
 * what the next run and the next ✅ are refused by.
 */
export async function agentToday(config: AgentConfig, now = new Date()): Promise<AgentToday> {
  const dayStart = tashkentDayStart(tashkentDay(now)).toISOString();
  const [counts, budget] = await Promise.all([
    dayRunCounts(dayStart, null),
    config.ownerUserId ? sendsToday(config.ownerUserId, config.startedAt, now) : Promise.resolve({ used: 0, ceiling: 0 }),
  ]);
  return {
    runs: counts.runs,
    drafts: counts.drafts,
    errors: counts.errors,
    tokens: counts.tokens,
    sends: budget.used,
    sendCeiling: budget.ceiling,
  };
}

/**
 * «AI qoidalari» on the Bilimlar tab (§17.14 e): what the agent follows that
 * is not a fact — each number read from where the agent reads it
 * (`AGENT_LIMITS`, `agent_config`), never typed twice.
 */
export interface AgentRules {
  truckMin: { m3: number; kg: number };
  avia: { minKg: number; daysMin: number; daysMax: number; kgPerM3: number; usdPerKg: number | null; setAt: Date | null };
}

export function agentRules(config: Pick<AgentConfig, 'aviaUsdPerKg' | 'aviaRateSetAt'>): AgentRules {
  return {
    truckMin: { m3: AGENT_LIMITS.minShipment.m3, kg: AGENT_LIMITS.minShipment.kg },
    avia: {
      minKg: AGENT_LIMITS.avia.minKg,
      daysMin: AGENT_LIMITS.avia.daysMin,
      daysMax: AGENT_LIMITS.avia.daysMax,
      kgPerM3: AVIA_KG_PER_M3,
      usdPerKg: config.aviaUsdPerKg,
      setAt: config.aviaRateSetAt,
    },
  };
}

/** «Ochiq hisoblar N/20» — the owner's open calculation requests against the queue's per-requester cap (his Q10 ⭐). */
export async function openCalcsFor(ownerUserId: string | null): Promise<{ open: number; cap: number }> {
  if (!ownerUserId) return { open: 0, cap: MAX_OPEN_PER_REQUESTER };
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(calcRequests)
    .where(and(eq(calcRequests.requestedBy, ownerUserId), openRequests));
  return { open: Number(row?.n ?? 0), cap: MAX_OPEN_PER_REQUESTER };
}

/**
 * «Sayt va /admin/tarif farq qiladi» (review money-3, his Q7 ⭐): a run in the
 * last seven days had its yo'lkira estimate refused because the website's
 * band and the table he edits disagree. The tool writes that sentence into
 * `tool_calls` (tools.ts `refuse`); this asks for it.
 */
export async function tariffMismatchSeen(now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [row] = await db.execute<{ seen: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM agent_runs r, jsonb_array_elements(r.tool_calls) AS c
       WHERE r.created_at >= ${since}::timestamptz
         AND jsonb_typeof(r.tool_calls) = 'array'
         AND c->>'text' LIKE '%farq qiladi%') AS seen`);
  return row?.seen === true;
}

/** The last 30 days of drafts, counted by `agentStats`. */
export async function webStats(now = new Date()): Promise<AgentStats> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db
    .select({
      status: agentDrafts.status,
      kind: agentDrafts.kind,
      edited: sql<boolean>`${agentDrafts.finalBody} IS NOT NULL`,
      outboxStatus: agentOutbox.status,
      category: agentDrafts.category,
    })
    .from(agentDrafts)
    .leftJoin(agentOutbox, eq(agentOutbox.draftId, agentDrafts.id))
    .where(gte(agentDrafts.createdAt, since));
  return agentStats(rows.map((r) => ({ ...r, edited: r.edited === true })));
}

export interface OwnerAccountState {
  accountId: string;
  pausedAt: Date | null;
  pausedKind: string | null;
  pauseReason: string | null;
  floodUntil: Date | null;
  /** Telegram's wait is still in force now. */
  floodActive: boolean;
  /** The listener's agent pump has not stamped within `pumpFreshMs` — ✅ is refused (`listener_behind`). */
  listenerBehind: boolean;
  agentPumpAt: Date | null;
}

export async function ownerAccountState(ownerUserId: string | null, now = new Date()): Promise<OwnerAccountState | null> {
  if (!ownerUserId) return null;
  const g = await guardForUser(ownerUserId);
  if (!g) return null;
  return {
    accountId: g.accountId,
    pausedAt: g.pausedAt,
    pausedKind: g.pausedKind,
    pauseReason: g.pauseReason,
    floodUntil: g.floodUntil,
    floodActive: g.floodUntil !== null && g.floodUntil.getTime() > now.getTime(),
    agentPumpAt: g.agentPumpAt,
    listenerBehind: !g.agentPumpAt || now.getTime() - g.agentPumpAt.getTime() > AGENT_LIMITS.pumpFreshMs,
  };
}

export interface PausedAccount {
  pausedAt: Date;
  pausedKind: string | null;
  pauseReason: string | null;
}

/**
 * Every paused Telegram account, by account id — for the /suhbatlar bridge
 * panel (review regression-11). A pause is a property of the ACCOUNT, any
 * manager's (his Q13 ⭐), so this reads them all; who may clear one is the
 * panel's and the service's question. Empty when 0136 has not landed, and on
 * a read that fails — the bridge panel must render regardless.
 */
export async function pausedAccounts(): Promise<Map<string, PausedAccount>> {
  if (!(await agentTablesReady())) return new Map();
  try {
    const rows = await db
      .select({
        accountId: tgAccountGuard.accountId,
        pausedAt: tgAccountGuard.pausedAt,
        pausedKind: tgAccountGuard.pausedKind,
        pauseReason: tgAccountGuard.pauseReason,
      })
      .from(tgAccountGuard)
      .where(sql`${tgAccountGuard.pausedAt} IS NOT NULL`);
    return new Map(
      rows.map((r) => [r.accountId, { pausedAt: r.pausedAt!, pausedKind: r.pausedKind, pauseReason: r.pauseReason }]),
    );
  } catch {
    return new Map();
  }
}

/** A person's name for the settings card — the owner may have disconnected and left the candidates list. */
export async function userName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, userId));
  return row?.name ?? null;
}
