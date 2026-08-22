import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leads, tgAccounts, tgOutbox } from '../../platform/db/schema';
import { canReadTg, threadClientFor, tgViewerFor, type TgViewer } from './conversations';
import { bridgeState } from './telegram-live';
import { STUCK_SENDING_MS } from './telegram-send';

/**
 * The chat pulse (round 108): a token that changes exactly when a thread
 * surface would draw something different, so the screen can ask a cheap
 * question every few seconds instead of re-rendering its whole page blind.
 *
 * The blind loop it replaces was the third speed round's headline: every
 * open card with a chat re-rendered its ENTIRE page every 10 s — every 2 s
 * while `pendingFor` returned rows, and `pendingFor` includes `failed`
 * rows, which only a human's ✕ ever clears — a permanent, invisible load
 * multiplier on the one Node process that serves everything.
 *
 * What the token must see was decided adversarially, and each part answers
 * a way the naive `max(sent_at)` version was PROVEN to lie:
 * - count + max(imported_at) beside max(sent_at): a reconnect backfill
 *   inserts rows OLDER than the max, and a purge deletes without moving it;
 * - max(edited_at) (0084): an edit is an UPDATE that moves nothing else —
 *   a corrected «100 kub» must not read «10 kub» until an unrelated message;
 * - the attachments pair: the listener stores the message row first and the
 *   photo's bytes seconds later — the refresh the row triggered has already
 *   drawn the bubble without its picture;
 * - per-status outbox counts + max(queued_at) + sum(attempts): one combined
 *   count nets to zero on dismiss-failed + new-queued in the same tick, and
 *   misses queued→failed entirely — the red ✕ is the bubble that matters;
 * - the stuck bucket: «stuck» is a WALL-CLOCK fact (round 48's alarm) and no
 *   data-only token can see a row crossing five minutes — so the SERVER
 *   evaluates the clock and the count flips exactly once at the crossing;
 * - the account bits: a signed-out account or a dead bridge flips the
 *   composer's honesty (rounds 49/50) with zero table writes on this thread.
 *
 * Every term carries the exact fence its surface reads through —
 * `conversationFor`'s for messages, `pendingFor`'s for the queue — so a
 * non-supervision viewer's token over a colleague's client is a constant,
 * revealing exactly what the page itself would: nothing.
 */
export interface ChatPulse {
  t: string;
  /** Something is genuinely in flight (queued/sending — never failed). */
  fast: boolean;
}

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : '';

async function messagesTerm(where: SQL): Promise<string> {
  const [row] = await db.execute<{
    n: string;
    max_sent: Date | null;
    max_imported: Date | null;
    max_edited: Date | null;
  }>(sql`
    SELECT count(*) AS n, max(sent_at) AS max_sent,
           max(imported_at) AS max_imported, max(edited_at) AS max_edited
    FROM tg_messages WHERE ${where}
  `);
  return [row?.n ?? '0', iso(row?.max_sent), iso(row?.max_imported), iso(row?.max_edited)].join('|');
}

async function attachmentsTerm(where: SQL): Promise<string> {
  const [row] = await db.execute<{ n: string; max_at: Date | null }>(sql`
    SELECT count(*) AS n, max(a.created_at) AS max_at
    FROM attachments a
    JOIN tg_messages m ON a.entity_type = 'tg_message' AND a.entity_id = m.id
    WHERE ${where}
  `);
  return [row?.n ?? '0', iso(row?.max_at)].join('|');
}

/** The actor's own account state — 1 discrete word per account, never the
 * raw heartbeat (that moves every few seconds and would make the token a
 * blind loop again). */
async function accountTerm(actorId: string): Promise<string> {
  const rows = await db
    .select({ status: tgAccounts.status, lastSeenAt: tgAccounts.lastSeenAt })
    .from(tgAccounts)
    .where(eq(tgAccounts.managerUserId, actorId));
  const now = new Date();
  return rows
    .map((row) => `${row.status}:${bridgeState(row, now)}`)
    .sort()
    .join(',');
}

export async function chatPulseForClient(
  actor: { id: string; roles: readonly string[]; permissions: ReadonlySet<string> },
  clientId: string,
  opts: {
    /**
     * The card panel shows the thread `threadClientFor` RESOLVES (a phone
     * sibling's, round 32); the /suhbatlar screen shows exactly the asked
     * client. The RESOLUTION runs here, server-side, never trusted off the
     * wire (#514) — and re-runs per tick, so a thread appearing under the
     * card's own code moves the token too.
     */
    sibling: boolean;
  },
): Promise<ChatPulse | null> {
  if (!canReadTg(actor)) return null;
  const viewer = tgViewerFor(actor);
  const target = opts.sibling ? await threadClientFor(clientId, viewer) : clientId;

  const msgFence = (id: string) =>
    viewer.all
      ? sql`client_id = ${id}`
      : sql`client_id = ${id} AND manager_user_id = ${viewer.id}`;

  const [msgs, atts, outbox, account] = await Promise.all([
    target ? messagesTerm(msgFence(target)) : Promise.resolve('none'),
    target ? attachmentsTerm(sql`m.client_id = ${target} AND ${viewer.all ? sql`true` : sql`m.manager_user_id = ${viewer.id}`}`) : Promise.resolve('none'),
    outboxTerm(target ?? clientId, viewer),
    accountTerm(actor.id),
  ]);

  return {
    t: [target ?? 'none', msgs, atts, outbox.term, account].join('||'),
    fast: outbox.inFlight > 0,
  };
}

async function outboxTerm(
  clientId: string,
  viewer: TgViewer,
): Promise<{ term: string; inFlight: number }> {
  const [row] = await db
    .select({
      queued: sql<string>`count(*) FILTER (WHERE ${tgOutbox.status} = 'queued')`,
      sending: sql<string>`count(*) FILTER (WHERE ${tgOutbox.status} = 'sending')`,
      failed: sql<string>`count(*) FILTER (WHERE ${tgOutbox.status} = 'failed')`,
      // The wall-clock alarm: flips exactly once when a claimed row crosses
      // the stuck line, which is the one change no data write announces.
      stuck: sql<string>`count(*) FILTER (WHERE ${tgOutbox.status} = 'sending'
        AND ${tgOutbox.queuedAt} < now() - make_interval(secs => ${STUCK_SENDING_MS / 1000}))`,
      maxQueued: sql<Date | null>`max(${tgOutbox.queuedAt})`,
      attempts: sql<string>`coalesce(sum(${tgOutbox.attempts}), 0)`,
    })
    .from(tgOutbox)
    .where(
      and(
        eq(tgOutbox.clientId, clientId),
        viewer.all ? undefined : eq(tgOutbox.managerUserId, viewer.id),
        sql`${tgOutbox.status} IN ('queued', 'sending', 'failed')`,
      ),
    );
  const inFlight = Number(row?.queued ?? 0) + Number(row?.sending ?? 0);
  return {
    term: [
      row?.queued ?? '0',
      row?.sending ?? '0',
      row?.failed ?? '0',
      row?.stuck ?? '0',
      iso(row?.maxQueued),
      row?.attempts ?? '0',
    ].join('|'),
    inFlight,
  };
}

/**
 * The lead-thread variant. Gated as the LEAD CARD is — `crm.leads` plus
 * ownership — not as the tg screens are: `canReadTg` alone is satisfied by
 * a bare `ved.docs` grant whose holder can open no lead card, and a pulse
 * must never answer recency about a conversation no page will show (#514).
 * Lead threads are read-only by design, so there is no outbox term.
 */
export async function chatPulseForLead(
  actor: { id: string; roles: readonly string[]; permissions: ReadonlySet<string> },
  leadId: string,
): Promise<ChatPulse | null> {
  if (!canReadTg(actor) || !actor.permissions.has('crm.leads')) return null;
  const [lead] = await db
    .select({ ownerId: leads.ownerId })
    .from(leads)
    .where(eq(leads.id, leadId));
  if (!lead) return null;
  if (!actor.permissions.has('crm.leads.view_all') && lead.ownerId !== actor.id) return null;

  const viewer = tgViewerFor(actor);
  const fence = viewer.all
    ? sql`lead_id = ${leadId}`
    : sql`lead_id = ${leadId} AND manager_user_id = ${viewer.id}`;
  const [msgs, atts] = await Promise.all([
    messagesTerm(fence),
    attachmentsTerm(
      sql`m.lead_id = ${leadId} AND ${viewer.all ? sql`true` : sql`m.manager_user_id = ${viewer.id}`}`,
    ),
  ]);
  return { t: [leadId, msgs, atts].join('||'), fast: false };
}
