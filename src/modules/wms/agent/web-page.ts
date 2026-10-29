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
import { seesAllTg } from '../crm/conversations';
import { cardDigest, digestBody } from './card';
import { renderDraftCardFull } from './card-io';
import { agentTablesReady, type AgentConfig } from './config';
import { AGENT_LIMITS } from './limits';
import { agentStats, type AgentStats } from './stats';
import { dayRunCounts, sendsToday } from './today';
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
  /** No ✅: the policy blocked it, or the card cannot show the whole reply (card-io `renderDraftCardFull`). */
  blocked: boolean;
  /** He wrote his own words for it — an `editing` draft WITHOUT them still sends the machine's on ✅ (decide). */
  ownText: boolean;
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
  /**
   * Approved replies of this draft's chat still waiting to leave — what its 🙋
   * would take back with it (ident fix F10): the page asks before the press,
   * because a card the press retires is gone from the page with the note.
   */
  waitingInChat: number;
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

function toWeb(d: DraftRow, o: OutboxRow | null, holderName: string, waitingInChat = 0): WebDraft {
  const kb = ((d.policy ?? {}) as { kb?: string }).kb;
  // The page lists live and approved drafts only, so no line here names his own reply's pause.
  const card = renderDraftCardFull(d, o, [], { surface: 'web' });
  return {
    id: d.id,
    managerUserId: d.managerUserId,
    holderName,
    status: d.status,
    kind: d.kind,
    needsOwner: d.needsOwner,
    blocked: d.blocked || card.tooLong,
    ownText: d.finalBody !== null,
    body: digestBody(d),
    digest: webDigest(d),
    cardText: card.text,
    chatHref: chatHrefOf(d),
    createdAt: d.createdAt,
    outbox: o ? { id: o.id, status: o.status, nextStepAt: o.nextStepAt, readDone: o.readDone, step: o.step } : null,
    kbAsk: d.status === 'approved' && d.needsOwner && d.finalBody !== null && kb !== 'saved' && kb !== 'skipped',
    kbArmed: kb === 'general_armed',
    waitingInChat,
  };
}

const LIST_CAP = 60;

/**
 * Who is reading the page — the drafts and the per-customer facts it may
 * list are a property of the reader (final review K10).
 */
export interface WebViewer {
  id: string;
  roles?: readonly string[];
  permissions?: ReadonlySet<string>;
}

/**
 * Whose drafts a reader sees: every account's for the Telegram supervision
 * view (`seesAllTg` — super_admin, admin, ved.docs: rounds 20/33), his own
 * account's for anybody else. `mayRunAgent` admits a configured owner who is
 * none of those — a seller the super_admin made the agent's account — and a
 * draft card carries the customer's lines, the reply and our last message: a
 * previous owner's personal chats are not his to read here (K10).
 */
function draftsSeenBy(viewer: WebViewer) {
  return seesAllTg(viewer) ? undefined : eq(agentDrafts.managerUserId, viewer.id);
}

/**
 * A per-customer fact is the chat it was learned in (`source_ref.draftId`,
 * kept through every edit — web-kb `editKbFact`), so it is seen by whoever
 * may read that chat's drafts. A general fact is the company's, seen by
 * everybody the page admits. A per-customer fact with no draft to trace is
 * seen by the supervision view only — fail closed.
 *
 * And by the agent's CURRENT owner, every one (ident fix F13): the knowledge
 * search serves a per-customer fact by its CLIENT, whichever account learned
 * it (kb `kbSearch`), so after the owner moves to another account that
 * account's drafts may state a fact the previous one was taught. What his
 * runs may say, he must be able to read, correct and retire — never only a
 * super_admin. It is a distilled sentence he approved for the customer, not
 * the chat it came from: the drafts (the customer's lines, our last message)
 * stay behind `draftsSeenBy`.
 */
export function factSeenBySql(viewer: WebViewer) {
  if (seesAllTg(viewer)) return sql`true`;
  return sql`(${kbFacts}.scope = 'general' OR EXISTS (
    SELECT 1 FROM agent_drafts fd
     WHERE fd.id::text = ${kbFacts}.source_ref->>'draftId' AND fd.manager_user_id = ${viewer.id}::uuid)
    OR EXISTS (SELECT 1 FROM agent_config ac WHERE ac.id = 1 AND ac.owner_user_id = ${viewer.id}::uuid))`;
}

/**
 * The page's three draft lists. «Kutilmoqda» = live drafts that are not a
 * question to him; «Savollar» = live drafts that ARE one (`needs_owner`), plus
 * answered ones whose «remember this?» is still open; the approved replies
 * still waiting to leave sit under «Kutilmoqda» with their cancel.
 */
export async function webDrafts(viewer: WebViewer, now = new Date()): Promise<{
  pending: WebDraft[];
  questions: WebDraft[];
  remember: WebDraft[];
  waiting: WebDraft[];
}> {
  const seen = draftsSeenBy(viewer);
  const draftsWithOutbox = () =>
    db
      .select({ d: agentDrafts, o: agentOutbox, holder: users.fullName })
      .from(agentDrafts)
      .innerJoin(users, eq(users.id, agentDrafts.managerUserId))
      .leftJoin(agentOutbox, eq(agentOutbox.draftId, agentDrafts.id));
  const [liveRows, waitingRows, rememberRows] = await Promise.all([
    draftsWithOutbox()
      .where(and(seen, inArray(agentDrafts.status, ['pending', 'editing'])))
      .orderBy(desc(agentDrafts.createdAt))
      .limit(LIST_CAP),
    draftsWithOutbox()
      .where(and(seen, eq(agentDrafts.status, 'approved'), inArray(agentOutbox.status, ['agent', 'sending'])))
      .orderBy(asc(agentOutbox.nextStepAt))
      .limit(LIST_CAP),
    draftsWithOutbox()
      .where(
        and(
          seen,
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
  // What each live draft's 🙋 would take back with it: the chat's approved replies still waiting (F10).
  const peers = [...new Set(liveRows.map((r) => r.d.peerId))];
  const waitingCounts = peers.length
    ? await db
        .select({ managerUserId: agentOutbox.managerUserId, peerId: agentOutbox.peerId, n: sql<number>`count(*)::int` })
        .from(agentOutbox)
        .where(and(eq(agentOutbox.status, 'agent'), inArray(agentOutbox.peerId, peers)))
        .groupBy(agentOutbox.managerUserId, agentOutbox.peerId)
    : [];
  const waitingIn = new Map(waitingCounts.map((w) => [`${w.managerUserId}:${String(w.peerId)}`, Number(w.n)]));
  const live = liveRows.map((r) => toWeb(r.d, r.o, r.holder, waitingIn.get(`${r.d.managerUserId}:${String(r.d.peerId)}`) ?? 0));
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

/** The knowledge the agent may state: every live fact the reader may see (`factSeenBySql`), general first, then each customer's. */
export async function webKbFacts(viewer: WebViewer): Promise<{ facts: WebKbFact[]; retired: number }> {
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
      .where(and(isNull(kbFacts.retiredAt), factSeenBySql(viewer)))
      .orderBy(sql`CASE ${kbFacts.scope} WHEN 'general' THEN 0 ELSE 1 END`, asc(kbFacts.createdAt))
      .limit(300),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(kbFacts)
      .where(and(sql`${kbFacts.retiredAt} IS NOT NULL`, factSeenBySql(viewer))),
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
  avia: { minKg: number; daysMin: number; daysMax: number; usdPerKg: number | null; setAt: Date | null };
}

export function agentRules(config: Pick<AgentConfig, 'aviaUsdPerKg' | 'aviaRateSetAt'>): AgentRules {
  return {
    truckMin: { m3: AGENT_LIMITS.minShipment.m3, kg: AGENT_LIMITS.minShipment.kg },
    avia: {
      minKg: AGENT_LIMITS.avia.minKg,
      daysMin: AGENT_LIMITS.avia.daysMin,
      daysMax: AGENT_LIMITS.avia.daysMax,
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
 * panel's and the service's question. Empty when 0138 has not landed, and on
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
