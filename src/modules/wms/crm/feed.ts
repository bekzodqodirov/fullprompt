import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * One client, everything that happened, in order — the «lenta».
 *
 * Owner: "amocrm bitrixlardek katta polyada ketma-ketlikda ko'rinib tursa
 * yaxshi edi ... chatga o'xshab qachon nima bo'lgani 1 joyda ko'rinar edi."
 * He is describing the one screen every CRM is actually used through: not a
 * card with eight panels you scroll between, but a single column you read
 * downwards, where the Telegram message, the cargo that arrived, the money
 * that came in and the note somebody left are the same kind of thing —
 * something that happened, at a time, done by a person.
 *
 * It replaces the question "why is there no chat on this deal" rather than
 * answering it: a conversation panel is empty for most clients and so renders
 * nothing, while a timeline always has content, because cargo and money
 * happen even when nobody writes.
 *
 * FIVE SOURCES, chosen because each carries `client_id` DIRECTLY and each has
 * an index that makes its slice cheap:
 *
 *   tg_messages         (client_id, sent_at)      what was said
 *   tg_outbox           (client_id, queued_at)    what we are still sending
 *   crm_activities      (entity_id, happened_at)  what we wrote down
 *   receipts            (client_id)               cargo received
 *   client_transactions (client_id, created_at)   money
 *
 * Deliberately NOT box_movements: 10,588 rows carrying ref_type/ref_id with no
 * foreign key, reachable from a client only through boxes → lots → receipts.
 * Every box of every consignment would be a feed row, which is not a timeline,
 * it is a log — and it would need a join nothing indexes. Cargo enters the
 * feed at the moment a person cares about, which is the receipt.
 *
 * One `UNION ALL` of narrow selects rather than five round trips: postgres
 * sorts the union once, the LIMIT applies to the whole thing, and paging by a
 * timestamp works across all of them without any source needing to know about
 * the others.
 */

export type FeedKind =
  | 'tg_in'
  | 'tg_out'
  | 'tg_pending'
  | 'note'
  | 'cargo'
  | 'charge'
  | 'payment';

export interface FeedItem {
  /** Source-prefixed, so two tables can never collide on a React key. */
  id: string;
  kind: FeedKind;
  at: Date;
  /** The human who did it, when there was one. */
  actor: string | null;
  /** Free text — a message body, a note, a void reason. */
  body: string | null;
  /** Whatever that kind needs to render: amounts, codes, counts. */
  meta: Record<string, unknown>;
}

interface Row extends Record<string, unknown> {
  id: string;
  kind: string;
  at: Date;
  actor: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
}

/**
 * The newest `limit` items, or the newest before `before` when paging.
 *
 * Newest-first out of the database and rendered in a `flex-col-reverse` box,
 * the same trick the conversation screen uses (#302): reading order on screen,
 * and a first painted frame already at the bottom.
 */
export async function clientFeed(
  clientId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<FeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  // A bound every branch can use, so the union never sorts more than it must.
  const before = opts.before ?? null;
  const cutoff = before ? sql`${before.toISOString()}::timestamptz` : sql`'infinity'::timestamptz`;

  const rows = await db.execute<Row>(sql`
    SELECT * FROM (
      -- What was said, both directions.
      SELECT
        'tg-' || m.id::text                       AS id,
        CASE WHEN m.direction = 'out' THEN 'tg_out' ELSE 'tg_in' END AS kind,
        m.sent_at                                 AS at,
        CASE WHEN m.direction = 'out' THEN u.full_name ELSE NULL END AS actor,
        m.body                                    AS body,
        jsonb_build_object('hasMedia', m.has_media) AS meta
      FROM tg_messages m
      JOIN users u ON u.id = m.manager_user_id
      WHERE m.client_id = ${clientId} AND m.sent_at < ${cutoff}

      UNION ALL

      -- Replies that have not gone yet. On the timeline for the same reason
      -- they are in the thread: a queued answer is not a delivered one.
      SELECT
        'ob-' || o.id::text, 'tg_pending', o.queued_at, u.full_name, o.body,
        jsonb_build_object('status', o.status, 'error', o.last_error)
      FROM tg_outbox o
      JOIN users u ON u.id = o.manager_user_id
      WHERE o.client_id = ${clientId}
        AND o.status IN ('queued', 'sending', 'failed')
        AND o.queued_at < ${cutoff}

      UNION ALL

      -- What somebody wrote down: a call, a meeting, a note.
      SELECT
        'ac-' || a.id::text, 'note', a.happened_at, u.full_name, a.note,
        jsonb_build_object('kind', a.kind)
      FROM crm_activities a
      JOIN users u ON u.id = a.created_by
      WHERE a.entity_type = 'client' AND a.entity_id = ${clientId}
        AND a.happened_at < ${cutoff}

      UNION ALL

      -- Cargo, at the moment a person cares about: it arrived and was booked.
      SELECT
        'rc-' || r.id::text, 'cargo', r.confirmed_at, u.full_name, r.source_note,
        jsonb_build_object(
          'number', r.number,
          'warehouse', w.code,
          'boxes', (SELECT coalesce(sum(l.box_count), 0) FROM receipt_lots l WHERE l.receipt_id = r.id),
          'voided', r.voided_at IS NOT NULL
        )
      FROM receipts r
      JOIN warehouses w ON w.id = r.warehouse_id
      LEFT JOIN users u ON u.id = r.confirmed_by
      WHERE r.client_id = ${clientId} AND r.confirmed_at IS NOT NULL
        AND r.confirmed_at < ${cutoff}

      UNION ALL

      -- Money. A voided entry stays on the timeline and says so: it happened,
      -- and then somebody undid it, and both are part of the story.
      SELECT
        'tx-' || t.id::text,
        CASE WHEN t.type = 'payment' THEN 'payment' ELSE 'charge' END,
        t.created_at, u.full_name, t.note,
        jsonb_build_object(
          'amount', t.amount, 'currency', t.currency, 'amountUsd', t.amount_usd,
          'method', t.method, 'voided', t.voided_at IS NOT NULL
        )
      FROM client_transactions t
      JOIN users u ON u.id = t.created_by
      WHERE t.client_id = ${clientId} AND t.created_at < ${cutoff}
    ) feed
    ORDER BY at DESC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as FeedKind,
    at: new Date(r.at),
    actor: r.actor,
    body: r.body,
    meta: r.meta ?? {},
  }));
}

/**
 * Is there anything at all to show?
 *
 * Cheaper than fetching a page, and used to decide whether a card gets a
 * timeline or nothing — a panel that renders an empty box on every card in the
 * system is the clutter this codebase keeps deciding against (#183).
 */
export async function clientFeedHasAnything(clientId: string): Promise<boolean> {
  const [row] = await db.execute<{ n: number }>(sql`
    SELECT 1 AS n WHERE EXISTS (
      SELECT 1 FROM tg_messages WHERE client_id = ${clientId}
      UNION ALL SELECT 1 FROM crm_activities WHERE entity_type = 'client' AND entity_id = ${clientId}
      UNION ALL SELECT 1 FROM receipts WHERE client_id = ${clientId} AND confirmed_at IS NOT NULL
      UNION ALL SELECT 1 FROM client_transactions WHERE client_id = ${clientId}
    )
  `);
  return row !== undefined;
}
