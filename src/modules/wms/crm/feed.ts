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
 * The journey itself comes from `box_movements`, GROUPED. That table is a log
 * — 10,920 rows for 4,401 consignments, one per box — and rendering it raw
 * would be one feed line per carton, which is not a timeline. Grouping by the
 * batch (`ref_id`) collapses 2,082 departure rows to 1,198: one line per truck
 * per client, which is the thing a person actually remembers. The three-hop
 * path to a client (receipts → lots → boxes → movements) has no index of its
 * own but walks three that exist; measured on the owner's busiest client
 * (1,834 movement rows) it is 4.3 ms warm.
 *
 * A LOSS is grouped by DAY instead, because `marked_lost` and
 * `inventory_missing` are written with `ref_id` NULL — grouping those by
 * `ref_id` would collapse every box a client ever lost into a single row
 * dated whenever the last one happened.
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
  | 'crate'
  | 'departed'
  | 'arrived'
  | 'cancelled'
  | 'lost'
  | 'handover'
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
  clientId: string | null,
  opts: { limit?: number; before?: Date; leadId?: string | null; dealId?: string | null } = {},
): Promise<FeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  // A LEAD is not a client, and most leads never become one — but the sales
  // work on them (calls, notes) is exactly what a timeline is for. When a
  // lead id is given, its own activities join the feed; when `clientId` is
  // null every client-keyed branch compares against NULL and yields nothing,
  // which is the correct answer rather than a special case: the lead's card
  // still gets a living lenta instead of a blank.
  const leadId = opts.leadId ?? null;
  // The deal's own chat (owner: "BITIM uchun chatlar bo'lishi kerak ichki
  // hodimlar bilan"). Same NULL trick as the lead: absent, the branch is inert.
  const dealId = opts.dealId ?? null;
  // A bound every branch can use, so the union never sorts more than it must.
  const before = opts.before ?? null;
  const cutoff = before ? sql`${before.toISOString()}::timestamptz` : sql`'infinity'::timestamptz`;

  const rows = await db.execute<Row>(sql`
    SELECT * FROM (
      -- What was said, both directions — with the photographs we hold
      -- (item 15), the same shape the note branch uses so the renderer is
      -- one block for both.
      SELECT
        'tg-' || m.id::text                       AS id,
        CASE WHEN m.direction = 'out' THEN 'tg_out' ELSE 'tg_in' END AS kind,
        m.sent_at                                 AS at,
        CASE WHEN m.direction = 'out' THEN u.full_name ELSE NULL END AS actor,
        m.body                                    AS body,
        jsonb_build_object(
          'hasMedia', m.has_media,
          'files', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', att.id, 'name', att.file_name, 'image', att.content_type LIKE 'image/%'
            ) ORDER BY att.created_at), '[]'::jsonb)
            FROM attachments att
            WHERE att.entity_type = 'tg_message' AND att.entity_id = m.id
          )
        ) AS meta
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

      -- What somebody wrote down: a call, a meeting, a note — and the files
      -- pinned to it (owner: "zametkaga fayllar qo'shish").
      SELECT
        'ac-' || a.id::text, 'note', a.happened_at, u.full_name, a.note,
        jsonb_build_object(
          'kind', a.kind,
          'files', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', att.id, 'name', att.file_name, 'image', att.content_type LIKE 'image/%'
            ) ORDER BY att.created_at), '[]'::jsonb)
            FROM attachments att
            WHERE att.entity_type = 'crm_activity' AND att.entity_id = a.id
          )
        )
      FROM crm_activities a
      JOIN users u ON u.id = a.created_by
      WHERE (
          (a.entity_type = 'client' AND a.entity_id = ${clientId})
          OR (a.entity_type = 'lead' AND a.entity_id = ${leadId})
          OR (a.entity_type = 'deal' AND a.entity_id = ${dealId})
        )
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

      UNION ALL

      -- Handed over. The end of the job, and the only source that names the
      -- human being who actually carried the cargo away.
      SELECT
        'hv-' || h.id::text, 'handover', h.created_at, u.full_name, h.note,
        jsonb_build_object(
          'person', h.person_name, 'phone', h.person_phone,
          'warehouse', w.code, 'debtOverride', h.debt_ok
        )
      FROM handovers h
      JOIN warehouses w ON w.id = h.warehouse_id
      JOIN users u ON u.id = h.created_by
      WHERE h.client_id = ${clientId} AND h.kind = 'issued_to_client'
        AND h.created_at < ${cutoff}

      UNION ALL

      -- A crate is a service the client PAYS for, so it belongs beside the
      -- money rather than among the box scans.
      SELECT
        'cr-' || cr.id::text, 'crate', cr.created_at, NULL, NULL,
        jsonb_build_object('code', cr.code, 'kind', cr.kind, 'warehouse', w.code)
      FROM crates cr
      JOIN warehouses w ON w.id = cr.warehouse_id
      WHERE cr.client_id = ${clientId} AND cr.created_at < ${cutoff}

      UNION ALL

      -- The journey, one line per truck rather than one per carton.
      SELECT
        'bm-' || mv.cause || '-' || coalesce(mv.ref_id::text, mv.day::text) AS id,
        CASE mv.cause
          WHEN 'batch_departed' THEN 'departed'
          WHEN 'batch_cancelled' THEN 'cancelled'
          WHEN 'marked_lost' THEN 'lost'
          WHEN 'inventory_missing' THEN 'lost'
          ELSE 'arrived'
        END,
        mv.at, NULL, NULL,
        jsonb_build_object(
          'boxes', mv.boxes,
          'batch', b.code,
          'plate', b.vehicle_plate,
          'warehouse', w.code,
          'ready', mv.ready
        )
      FROM (
        SELECT
          bm.cause,
          bm.ref_id,
          date_trunc('day', bm.created_at) AS day,
          max(bm.created_at) AS at,
          count(*) AS boxes,
          max(bm.to_warehouse_id::text) AS to_wh,
          bool_or(bm.to_status = 'ready_for_pickup') AS ready
        FROM box_movements bm
        JOIN boxes bx ON bx.id = bm.box_id
        JOIN receipt_lots rl ON rl.id = bx.lot_id
        JOIN receipts rr ON rr.id = rl.receipt_id
        WHERE rr.client_id = ${clientId}
          AND bm.created_at < ${cutoff}
          AND bm.cause IN (
            'batch_departed', 'unload_scan', 'undocumented_transfer',
            'batch_cancelled', 'marked_lost', 'inventory_missing'
          )
        -- By batch where there is one; by DAY where there is not, because a
        -- loss carries ref_id NULL and would otherwise collapse a client's
        -- entire history of losses into one row.
        GROUP BY bm.cause, bm.ref_id, date_trunc('day', bm.created_at)
      ) mv
      LEFT JOIN batches b ON b.id = mv.ref_id
      LEFT JOIN warehouses w ON w.id::text = mv.to_wh
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
