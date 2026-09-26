import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import {
  clients,
  leadAssignments,
  leadIntakes,
  leads,
  tgChatRules,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { tashkentDay, tashkentDayStart } from '@/modules/platform/time/tashkent';
import { landInboundLead, type InboundOutcome } from './inbound';
import { addActivity } from './service';
import {
  LEAD_TEAMS,
  normalizeUsername,
  PENDING_OFFER_MS,
  rankByLoad,
  reachableAt,
  TAG_VALID_MS,
  type Ineligible,
  type LeadTeam,
  type LoadRow,
  type Reachable,
} from './site-assign-rules';
import { LIVE_WINDOW_S, type BridgeState } from './telegram-live';

/**
 * Saytdan so'rov → eng bo'sh menejer (round 113): the database half.
 *
 * `site-assign-rules.ts` holds every decision; this file reads the rows those
 * decisions need and writes the three records the feature has — the OFFER
 * (who the website was told to send the visitor to), the landing (the lead,
 * through `landInboundLead` like every other door) and the chat rule that
 * keeps the rest of that conversation on the lead.
 */

export class SiteAssignError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface RosterRow extends LoadRow {
  teams: LeadTeam[];
  typedUsername: string | null;
  reach: Reachable;
}

/**
 * «How busy is everybody today», in ONE grouped query — the route and the
 * panel both read this, so the panel's number IS the route's number (#513).
 *
 * A unit of work is one visitor handed to a person today, counted once:
 *  - an offer confirmed by THEM today (the visitor wrote, the lead opened);
 *  - an offer to them still waiting — for the rest of the day when nobody can
 *    see the conversation (no connected Telegram: it may well have happened),
 *    and only for 15 minutes when we could have seen it and did not (the
 *    visitor never wrote, and must not keep a manager «busy» all day);
 *  - an advert lead routed to them today by the taqsimot (Meta, /ariza) that
 *    no offer already counts — the same people work both streams, and a
 *    manager who took five Instagram leads this morning is not «free».
 *
 * «Today» is Tashkent's day, bound from `tashkentDay()` as an ISO string
 * (#156) so the app and every test read one clock (R5).
 */
async function roster(handle: Db | Tx = db, now: Date = new Date()): Promise<RosterRow[]> {
  const dayStart = tashkentDayStart(tashkentDay(now)).toISOString();
  const pendingSince = new Date(now.getTime() - PENDING_OFFER_MS).toISOString();
  const rows = (await handle.execute(sql`
    WITH offered AS (
      SELECT a.user_id AS uid,
             count(*) FILTER (
               WHERE a.confirmed_at IS NULL
                 AND (NOT a.capturable OR a.created_at > ${pendingSince}::timestamptz)
             ) AS waiting,
             max(a.created_at) AS last_offer
        FROM lead_assignments a
       WHERE a.created_at >= ${dayStart}::timestamptz
       GROUP BY a.user_id
    ),
    confirmed AS (
      SELECT a.confirmed_user_id AS uid, count(*) AS n
        FROM lead_assignments a
       WHERE a.confirmed_at >= ${dayStart}::timestamptz
       GROUP BY a.confirmed_user_id
    ),
    routed AS (
      SELECT l.owner_id AS uid, count(*) AS n, max(l.inbound_at) AS last_in
        FROM leads l
       WHERE l.inbound_at >= ${dayStart}::timestamptz
         AND l.owner_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id)
       GROUP BY l.owner_id
    )
    SELECT u.id, u.full_name, u.lead_teams, u.telegram_username,
           t.status AS tg_status, t.last_seen_at, t.tg_username, t.tg_username_checked_at,
           coalesce(o.waiting, 0) + coalesce(c.n, 0) + coalesce(r.n, 0) AS units,
           greatest(o.last_offer, r.last_in) AS last_at
      FROM users u
      LEFT JOIN tg_accounts t ON t.manager_user_id = u.id
      LEFT JOIN offered o ON o.uid = u.id
      LEFT JOIN confirmed c ON c.uid = u.id
      LEFT JOIN routed r ON r.uid = u.id
     WHERE u.active
     ORDER BY u.full_name, u.id
  `)) as unknown as {
    id: string;
    full_name: string;
    lead_teams: string[] | null;
    telegram_username: string | null;
    tg_status: string | null;
    last_seen_at: string | Date | null;
    tg_username: string | null;
    tg_username_checked_at: string | Date | null;
    units: string | number;
    last_at: string | Date | null;
  }[];
  // Raw `execute` hands timestamps over as TEXT (#923) — converted here, once.
  const at = (value: string | Date | null) => (value === null ? null : new Date(value));
  return rows.map((row) => ({
    userId: row.id,
    name: row.full_name,
    teams: (row.lead_teams ?? []).filter((t): t is LeadTeam =>
      (LEAD_TEAMS as readonly string[]).includes(t),
    ),
    typedUsername: row.telegram_username,
    units: Number(row.units),
    lastAt: at(row.last_at),
    reach: reachableAt(
      {
        typedUsername: row.telegram_username,
        account: row.tg_status
          ? {
              status: row.tg_status,
              lastSeenAt: at(row.last_seen_at),
              username: row.tg_username,
              checkedAt: at(row.tg_username_checked_at),
            }
          : null,
      },
      now,
    ),
  }));
}

export interface Candidate extends LoadRow {
  username: string;
  source: 'verified' | 'typed';
  capturable: boolean;
}

export interface Pick {
  chosen: Candidate | null;
  /** Everybody who could have been chosen, least busy first. */
  ranked: Candidate[];
  /** Ticked for the team, but unreachable — and why, in the panel's words. */
  excluded: { userId: string; name: string; reason: Ineligible }[];
  /** Nobody in the asked team could take it, so a wider tier did. */
  widened: boolean;
}

function split(rows: RosterRow[]): Pick {
  const ranked: Candidate[] = [];
  const excluded: Pick['excluded'] = [];
  for (const row of rows) {
    if (row.reach.ok) {
      ranked.push({
        userId: row.userId,
        name: row.name,
        units: row.units,
        lastAt: row.lastAt,
        username: row.reach.username,
        source: row.reach.source,
        capturable: row.reach.capturable,
      });
    } else {
      excluded.push({ userId: row.userId, name: row.name, reason: row.reach.reason });
    }
  }
  const sorted = rankByLoad(ranked);
  return { chosen: sorted[0] ?? null, ranked: sorted, excluded, widened: false };
}

/**
 * Who the next visitor of this team goes to, from one roster read.
 *
 * Asked by the route (inside its transaction) and by the panel's «keyingi»
 * line — the same function over the same rows, or the panel explains a choice
 * the route did not make (#513).
 *
 * Nobody reachable in the asked team falls to `general` (the people who said
 * they answer anything), and then to anybody ticked for the website at all,
 * before the website is told «nobody» and falls back to its own list — which
 * is a static list another team maintains, and today one name. It never falls
 * to an UNTICKED person: «hodimlarda belgilaylik qanday zaprosga kim javob
 * beradi» means a person nobody ticked is not somebody to send visitors to.
 */
export function pickFromRoster(rows: RosterRow[], team: LeadTeam): Pick {
  const first = split(rows.filter((row) => row.teams.includes(team)));
  if (first.chosen) return first;
  const tiers: RosterRow[][] = [
    team === 'general' ? [] : rows.filter((row) => row.teams.includes('general')),
    rows.filter((row) => row.teams.length > 0),
  ];
  for (const tier of tiers) {
    const wider = split(tier);
    if (wider.chosen) return { ...wider, excluded: first.excluded, widened: true };
  }
  return first;
}

/** `now` is the app's clock, passed in only so a test can stand on it (R5). */
export async function pickAssignee(
  team: LeadTeam,
  handle: Db | Tx = db,
  now: Date = new Date(),
): Promise<Pick> {
  return pickFromRoster(await roster(handle, now), team);
}

/** The ranking as stored on the offer: enough to answer «nega Aliga?» later. */
function rankingRecord(pick: Pick) {
  return {
    widened: pick.widened,
    top: pick.ranked.slice(0, 3).map((c) => ({
      userId: c.userId,
      name: c.name,
      units: c.units,
      lastAt: c.lastAt?.toISOString() ?? null,
      source: c.source,
      capturable: c.capturable,
    })),
    excluded: pick.excluded.length,
  };
}

export interface AssignInput {
  team: LeadTeam;
  tag: string;
  topic: string | null;
  page: string | null;
  lang: string | null;
}

/**
 * Answer one website question and remember the answer.
 *
 * ONE short transaction, serialised by an advisory lock, because the pick
 * reads «who has the fewest» and then writes one more for somebody — two
 * visitors from the same advert burst must not both read the same «fewest»
 * (round 103's generator, the same shape). The transaction's own statements
 * are capped at 400 ms: this door is public and the pool of ten is every
 * staff screen's (#714), so a slow minute ANSWERS «nobody» (the site falls
 * back to its own list) rather than queueing the warehouse behind the website.
 *
 * Idempotent by TAG: the same tag asked twice (a double click, a retry) gets
 * the same person, and the second call writes nothing.
 *
 * `stillWanted` is asked just before the INSERT: once the site has given up
 * (1.5 s) nobody is waiting for this answer, and an offer written anyway
 * would count as a visitor for a manager the visitor never reached.
 */
export async function assignForTag(
  input: AssignInput,
  stillWanted: () => boolean = () => true,
): Promise<{ username: string | null; reused: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '400ms'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lead_assign'))`);
    const [existing] = await tx
      .select({
        username: leadAssignments.username,
        createdAt: leadAssignments.createdAt,
        active: users.active,
      })
      .from(leadAssignments)
      .innerJoin(users, eq(users.id, leadAssignments.userId))
      .where(eq(leadAssignments.tag, input.tag))
      .limit(1);
    // A tag is ONE visitor's for as long as it can still land (TAG_VALID_MS).
    // Past that, or once the person has left, the old name would send the
    // visitor where nothing is captured or nobody reads — so the site gets
    // «nobody» and uses its own list. The tag stays spent either way: a
    // second pick under it would break the one-row-per-tag load count.
    if (existing) {
      const live =
        existing.active && Date.now() - existing.createdAt.getTime() < TAG_VALID_MS;
      return { username: live ? existing.username : null, reused: true };
    }

    const pick = await pickAssignee(input.team, tx);
    if (!pick.chosen || !stillWanted()) return { username: null, reused: false };
    await tx
      .insert(leadAssignments)
      .values({
        tag: input.tag,
        team: input.team,
        topic: input.topic,
        page: input.page,
        lang: input.lang,
        userId: pick.chosen.userId,
        username: pick.chosen.username,
        capturable: pick.chosen.capturable,
        ranking: rankingRecord(pick),
      })
      .onConflictDoNothing();
    return { username: pick.chosen.username, reused: false };
  });
}

// ─── The listener's half: a visitor wrote, carrying the tag ───────────────

export interface SiteTagPeer {
  id: bigint;
  phone: string | null;
  title: string | null;
  username: string | null;
}

export type SiteTagLanding =
  | {
      landed: true;
      outcome: InboundOutcome;
      leadId: string | null;
      clientId: string | null;
      clientCode: string | null;
    }
  | {
      landed: false;
      reason: 'no_offer' | 'not_first_contact' | 'claimed' | 'dropped' | 'decided';
    };

/** The offer a tag names, while it can still be used. */
async function liveOffer(tag: string) {
  const [offer] = await db
    .select()
    .from(leadAssignments)
    .where(
      and(
        eq(leadAssignments.tag, tag),
        gt(leadAssignments.createdAt, new Date(Date.now() - TAG_VALID_MS)),
      ),
    )
    .limit(1);
  return offer ?? null;
}

/**
 * Turn a tagged first message into a lead, once.
 *
 * WHAT THE TAG IS AND IS NOT. The website asks a public door for a username
 * and gets a tag registered against it, so registering one is open to anybody
 * with `curl`: the offer row is FRICTION, not authentication. What actually
 * keeps a manager's personal Telegram out of the company database is the rest
 * of this function — a tag we never issued, or one already bound to somebody
 * else, is ordinary text (the chat takes its ordinary road, the tray on a
 * personal number); and the landing happens only on a FIRST contact
 * (`wroteBefore`, asked of Telegram by the listener). Somebody the manager
 * already talks to — family, an old customer — who pastes a tag has not
 * arrived from the website, and their chat stays a decision a person makes.
 *
 * WHO. It lands for whoever RECEIVED it, not for whoever was offered: a
 * website that gave up waiting sends the visitor to its own fallback list,
 * and the person the visitor is actually talking to is the one who must see
 * the lead. The offer keeps both names (`user_id`, `confirmed_user_id`).
 *
 * ONCE. The claim comes first — a single UPDATE that binds the tag to this
 * manager and this Telegram person — and it is RE-ENTRANT for exactly that
 * pair: a listener killed half way through finishes the landing the next time
 * it sees the message (the start-up sweep), reusing what was already written
 * (`landInboundLead`'s replay fence, keyed on the tag), while a second
 * person typing the same tag is refused outright.
 *
 * WHERE. Through `landInboundLead` like every other door, so the arrivals
 * ledger, the caps and the join all apply: a known client's question goes to
 * their card, the same Telegram person already on an open lead (on anybody's
 * account) or the same number is joined, and only a stranger gets a new lead
 * — owned by the receiving manager, never re-routed.
 */
export async function landSiteTag(input: {
  managerUserId: string;
  tag: string;
  peer: SiteTagPeer;
  text: string;
  wroteBefore: () => Promise<boolean>;
}): Promise<SiteTagLanding> {
  // A cheap look before the network call: most tag-shaped text is not ours.
  const seen = await liveOffer(input.tag);
  const ours = (offer: typeof seen) =>
    offer !== null &&
    (offer.confirmedAt === null ||
      (offer.confirmedUserId === input.managerUserId && offer.peerId === input.peer.id));
  if (!ours(seen)) return { landed: false, reason: 'no_offer' };
  // A chat somebody already decided about keeps that decision — above all an
  // `exclude`, a person's «never», which a stranger's tag must not undo. The
  // listener only calls here for chats with no decision, and this says it
  // again where the writes are, because a rule can be written between the two.
  // The one exception is this landing's OWN rule, found by its own retry.
  const retry = seen!.confirmedAt !== null;
  const [decided] = await db
    .select({ decision: tgChatRules.decision })
    .from(tgChatRules)
    .where(
      and(
        eq(tgChatRules.managerUserId, input.managerUserId),
        eq(tgChatRules.peerId, input.peer.id),
        sql`${tgChatRules.decision} <> 'pending'`,
      ),
    )
    .limit(1);
  if (decided && (decided.decision === 'exclude' || !retry)) {
    return { landed: false, reason: 'decided' };
  }
  if (await input.wroteBefore()) return { landed: false, reason: 'not_first_contact' };

  const [offer] = await db
    .update(leadAssignments)
    .set({
      confirmedAt: sql`coalesce(${leadAssignments.confirmedAt}, now())`,
      confirmedUserId: input.managerUserId,
      peerId: input.peer.id,
    })
    .where(
      and(
        eq(leadAssignments.id, seen!.id),
        sql`(${leadAssignments.confirmedAt} IS NULL
             OR (${leadAssignments.confirmedUserId} = ${input.managerUserId}
                 AND ${leadAssignments.peerId} = ${input.peer.id}))`,
      ),
    )
    .returning();
  if (!offer) return { landed: false, reason: 'claimed' };

  // The same Telegram person already on an open lead — on this account or a
  // colleague's (a visitor who wrote to two managers is one enquiry).
  const [known] = (await db.execute(sql`
    SELECT r.lead_id
      FROM tg_chat_rules r
      JOIN leads l ON l.id = r.lead_id
      JOIN lead_stages s ON s.id = l.stage_id
     WHERE r.peer_id = ${input.peer.id}
       AND r.decision = 'include'
       AND s.kind = 'open'
     ORDER BY r.decided_at DESC NULLS LAST
     LIMIT 1`)) as unknown as { lead_id: string }[];

  const handle = input.peer.username ? `@${input.peer.username}` : null;
  const title = (input.peer.title ?? '').trim();
  const pairs = [
    { key: 'team', value: offer.team },
    { key: 'topic', value: offer.topic ?? '' },
    { key: 'page', value: offer.page ?? '' },
    { key: 'lang', value: offer.lang ?? '' },
    { key: 'telegram', value: handle ?? '' },
  ].filter((pair) => pair.value);
  const result = await landInboundLead({
    channel: 'site',
    externalId: input.tag,
    sourceKey: 'sayt',
    ownerId: input.managerUserId,
    knownLeadId: known?.lead_id ?? null,
    ref: { tag: input.tag, team: offer.team, topic: offer.topic, page: offer.page },
    name: title || handle || input.tag,
    phone: input.peer.phone,
    // A phone is often hidden, so the card carries the one way back to this
    // person that the next owner of the lead can use.
    note: [input.text.trim(), handle ? `Telegram: ${handle}` : null].filter(Boolean).join('\n'),
    fields: pairs,
  });

  let leadId: string | null = result.leadId ?? null;
  let clientId: string | null = leadId ? null : (result.clientId ?? null);
  if (result.outcome === 'dropped' && result.reason === 'replay') {
    // A second pass over the same tag — the first one's arrival is the answer.
    const [prior] = (await db.execute(sql`
      SELECT lead_id, client_id FROM lead_intakes
       WHERE channel = 'site' AND external_id = ${input.tag}
       LIMIT 1`)) as unknown as { lead_id: string | null; client_id: string | null }[];
    leadId = prior?.lead_id ?? null;
    clientId = leadId ? null : (prior?.client_id ?? null);
  }
  if (!leadId && !clientId) return { landed: false, reason: 'dropped' };

  // Keep the REST of the conversation: the rule the tray would have written
  // had somebody pressed «Lid ochish». Only over nothing or a still-pending
  // question — a chat somebody already decided about keeps that decision,
  // an `exclude` above all (a person's «never» is not a stranger's to undo).
  const [rule] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: input.managerUserId,
      peerId: input.peer.id,
      decision: 'include',
      clientId,
      leadId,
      peerTitle: title || handle,
      peerPhone: input.peer.phone,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [tgChatRules.managerUserId, tgChatRules.peerId],
      set: { decision: 'include', clientId, leadId, decidedAt: new Date() },
      setWhere: sql`${tgChatRules.decision} = 'pending'`,
    })
    .returning({ id: tgChatRules.id });

  await db
    .update(leadAssignments)
    .set({ leadId, clientId })
    .where(eq(leadAssignments.id, offer.id));

  if (rule) {
    await writeAudit(db, { actorId: null }, {
      entityType: 'tg_chat_rule',
      entityId: rule.id,
      action: 'update',
      after: { decision: 'include', clientId, leadId, reason: 'site_tag', tag: input.tag },
    });
  } else {
    // Not written: the chat already has a decision. Our own earlier pass
    // (the same card) is the retry finishing; anything else is a person's.
    const [standing] = await db
      .select({ decision: tgChatRules.decision, leadId: tgChatRules.leadId, clientId: tgChatRules.clientId })
      .from(tgChatRules)
      .where(
        and(
          eq(tgChatRules.managerUserId, input.managerUserId),
          eq(tgChatRules.peerId, input.peer.id),
        ),
      )
      .limit(1);
    const ours =
      standing?.decision === 'include' &&
      standing.leadId === leadId &&
      (leadId !== null || standing.clientId === clientId);
    if (!ours) return { landed: false, reason: 'decided' };
  }

  let clientCode: string | null = null;
  if (clientId) {
    const [row] = await db
      .select({ code: clients.clientCode })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    clientCode = row?.code ?? null;
  }
  return { landed: true, outcome: result.outcome, leadId, clientId, clientCode };
}

/**
 * A tagged message in a chat that ALREADY belongs to somebody — a known
 * client, or a lead attached before. Nothing is created and nothing about the
 * chat changes; the offer is confirmed (so it counts as the work it is) and
 * the card learns, once, that this person came in through the website and
 * what they asked about.
 */
export async function confirmSiteTagOnCard(input: {
  managerUserId: string;
  tag: string;
  peerId: bigint;
  clientId: string | null;
  leadId: string | null;
}): Promise<boolean> {
  if (!input.clientId && !input.leadId) return false;
  const [offer] = await db
    .update(leadAssignments)
    .set({
      confirmedAt: new Date(),
      confirmedUserId: input.managerUserId,
      peerId: input.peerId,
      leadId: input.leadId,
      clientId: input.leadId ? null : input.clientId,
    })
    .where(
      and(
        eq(leadAssignments.tag, input.tag),
        isNull(leadAssignments.confirmedAt),
        gt(leadAssignments.createdAt, new Date(Date.now() - TAG_VALID_MS)),
      ),
    )
    .returning();
  if (!offer) return false;
  const text = ['📣 sayt', offer.team, offer.topic, offer.page].filter(Boolean).join(' · ');
  await addActivity(
    {
      entityType: input.leadId ? 'lead' : 'client',
      entityId: (input.leadId ?? input.clientId)!,
      kind: 'note',
      note: text,
    },
    { actorId: null },
    { system: true },
  );
  // The arrivals ledger answers «is the website producing anything» — a
  // returning customer arriving through it is part of that answer.
  await db
    .insert(leadIntakes)
    .values({
      channel: 'site',
      externalId: input.tag,
      sourceKey: 'sayt',
      ref: { tag: input.tag, team: offer.team, topic: offer.topic, page: offer.page },
      outcome: input.leadId ? 'joined' : 'client',
      leadId: input.leadId,
      clientId: input.leadId ? null : input.clientId,
      assignedUserId: input.managerUserId,
    })
    .onConflictDoNothing();
  return true;
}

// ─── The listener's other half: the account's own handle ──────────────────

/**
 * What Telegram says the connected account's handle is, stamped with WHEN it
 * said so — the stamp is what lets the website question stop trusting a
 * handle nobody has confirmed lately.
 */
export async function recordAccountUsername(
  accountId: string,
  username: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE tg_accounts
       SET tg_username = ${username}, tg_username_checked_at = now(), updated_at = now()
     WHERE id = ${accountId}`);
}

/**
 * The tags the start-up sweep looks for: offers made to this manager, still
 * inside the tag's life, that never reached a card — nobody wrote yet, or a
 * landing was interrupted half way (claimed, no lead).
 */
export async function openOffersFor(managerUserId: string) {
  return db
    .select({ tag: leadAssignments.tag, createdAt: leadAssignments.createdAt })
    .from(leadAssignments)
    .where(
      and(
        sql`(${leadAssignments.userId} = ${managerUserId}
             OR ${leadAssignments.confirmedUserId} = ${managerUserId})`,
        isNull(leadAssignments.leadId),
        isNull(leadAssignments.clientId),
        gt(leadAssignments.createdAt, new Date(Date.now() - TAG_VALID_MS)),
      ),
    )
    .orderBy(desc(leadAssignments.createdAt))
    .limit(30);
}

// ─── The panel on /admin/taqsimot ─────────────────────────────────────────

export interface PanelPerson {
  userId: string;
  name: string;
  teams: LeadTeam[];
  typedUsername: string | null;
  units: number;
  reach: Reachable;
  bridge: BridgeState | null;
  /** The listener is live and has never written a handle: it predates round 113. */
  listenerOutdated: boolean;
}

export interface PanelData {
  people: PanelPerson[];
  /** Per team: who the NEXT visitor goes to, or why nobody — the route's own pick. */
  next: Record<LeadTeam, Pick>;
}

export async function sitePanel(): Promise<PanelData> {
  const rows = await roster();
  const people: PanelPerson[] = rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    teams: row.teams,
    typedUsername: row.typedUsername,
    units: row.units,
    reach: row.reach,
    bridge: row.reach.bridge,
    listenerOutdated: false,
  }));
  // The column itself is the version probe: the listener reads its handle
  // BEFORE it first reports itself live, so a live account that has never
  // stamped one is running the code from before this round (the deploy
  // rebuilt `app` and not `tg-listen`) — and without the panel saying so,
  // every visitor sent there would silently never become a lead.
  const outdated = await db.execute(sql`
    SELECT manager_user_id AS uid FROM tg_accounts
     WHERE tg_username_checked_at IS NULL
       AND status = 'active'
       AND last_seen_at > now() - make_interval(secs => ${LIVE_WINDOW_S})`);
  const stale = new Set((outdated as unknown as { uid: string }[]).map((row) => row.uid));
  for (const person of people) person.listenerOutdated = stale.has(person.userId);

  const next = {} as Record<LeadTeam, Pick>;
  for (const team of LEAD_TEAMS) next[team] = pickFromRoster(rows, team);
  return { people, next };
}

/** The newest offers, with what became of each. */
export async function recentOffers(limit = 20) {
  const offered = sql<string>`(SELECT full_name FROM users WHERE id = ${leadAssignments.userId})`;
  const took = sql<string | null>`(SELECT full_name FROM users WHERE id = ${leadAssignments.confirmedUserId})`;
  return db
    .select({
      id: leadAssignments.id,
      tag: leadAssignments.tag,
      team: leadAssignments.team,
      topic: leadAssignments.topic,
      page: leadAssignments.page,
      username: leadAssignments.username,
      capturable: leadAssignments.capturable,
      createdAt: leadAssignments.createdAt,
      confirmedAt: leadAssignments.confirmedAt,
      leadId: leadAssignments.leadId,
      clientId: leadAssignments.clientId,
      offeredName: offered,
      tookName: took,
      leadName: leads.name,
      clientCode: clients.clientCode,
    })
    .from(leadAssignments)
    .leftJoin(leads, eq(leads.id, leadAssignments.leadId))
    .leftJoin(clients, eq(clients.id, leadAssignments.clientId))
    .orderBy(desc(leadAssignments.createdAt))
    .limit(limit);
}

export interface TeamEntry {
  userId: string;
  teams: string[];
  username: string;
}

/**
 * Save the panel. ONLY the people the form rendered are touched (each row
 * posts its own id), so somebody folded away or added since the page loaded
 * keeps their teams — replace-all over an unrendered row is #171's «remove».
 *
 * A typed handle is checked for shape and for being somebody ELSE's: two
 * people on one handle would send one person's visitors to the other.
 */
export async function saveSiteTeams(
  entries: TeamEntry[],
  ctx: AuditContext,
): Promise<{ changed: number }> {
  if (entries.length === 0) return { changed: 0 };
  const cleaned = entries.map((entry) => {
    const name = normalizeUsername(entry.username);
    if (!name.ok) throw new SiteAssignError('bad_username');
    const teams = [...new Set(entry.teams)].filter((t): t is LeadTeam =>
      (LEAD_TEAMS as readonly string[]).includes(t),
    );
    return { userId: entry.userId, teams, username: name.value };
  });

  const typed = cleaned.filter((entry) => entry.username).map((entry) => entry.username!.toLowerCase());
  if (new Set(typed).size !== typed.length) throw new SiteAssignError('username_taken');

  const ids = cleaned.map((entry) => entry.userId);
  const before = await db
    .select({
      id: users.id,
      teams: users.leadTeams,
      username: users.telegramUsername,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const known = new Map(before.map((row) => [row.id, row]));

  if (typed.length) {
    // Somebody NOT on this form holding the same handle, typed or verified.
    const clash = (await db.execute(sql`
      SELECT 1 FROM users u
        LEFT JOIN tg_accounts t ON t.manager_user_id = u.id
       WHERE u.id NOT IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         AND (lower(u.telegram_username) IN (${sql.join(typed.map((t) => sql`${t}`), sql`, `)})
              OR lower(t.tg_username) IN (${sql.join(typed.map((t) => sql`${t}`), sql`, `)}))
       LIMIT 1`)) as unknown as unknown[];
    if (clash.length) throw new SiteAssignError('username_taken');
  }

  let changed = 0;
  for (const entry of cleaned) {
    const was = known.get(entry.userId);
    if (!was) continue;
    const sameTeams =
      [...(was.teams ?? [])].sort().join(',') === [...entry.teams].sort().join(',');
    const sameName = (was.username ?? null) === entry.username;
    if (sameTeams && sameName) continue;
    await db
      .update(users)
      .set({ leadTeams: entry.teams, telegramUsername: entry.username })
      .where(eq(users.id, entry.userId));
    await writeAudit(db, ctx, {
      entityType: 'user',
      entityId: entry.userId,
      action: 'update',
      before: { leadTeams: was.teams ?? [], telegramUsername: was.username },
      after: { leadTeams: entry.teams, telegramUsername: entry.username },
    });
    changed += 1;
  }
  return { changed };
}
