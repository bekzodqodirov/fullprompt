import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import type { ConditionBoard } from './conditions';

/**
 * The one shape a rule reasons about (round 86).
 *
 * A rule now asks two questions of the card that triggered it — «does it meet
 * my conditions» and «what is its name» — and both must be answered from the
 * same row, or a rule could fire on one lead and print another's price. So
 * there is ONE record type and ONE select list, used by the event path (which
 * loads a single card) and by the stale sweep (which loads a stage's worth).
 *
 * Every money-shaped value stays a STRING: postgres numerics arrive as text
 * and turning them into numbers here would round the very figures a condition
 * compares. `conditionsMatch` parses per comparison, which is where the rule
 * about an unreadable number belongs.
 */
export interface RuleRecord {
  id: string;
  /** Lead name, or the deal's title falling back to its code. */
  name: string;
  stageName: string;
  ownerId: string | null;
  clientCode: string | null;
  source: string | null;
  phone: string | null;
  amount: string | null;
  volumeM3: string | null;
  weightKg: string | null;
  /** When anybody last did anything — the whole definition of «sitting still». */
  updatedAt: Date;
}

/**
 * The select list, written once per board.
 *
 * Both produce identical column names so one mapper reads either, and both
 * carry the columns the stale sweep filters on (`stage_id`, `updated_at`) —
 * a caller wraps this in a subquery and states its own WHERE, which is the
 * only way two very different questions can share one definition of a card.
 */
const BASE = {
  lead: sql`
    SELECT l.id, l.name, l.stage_id, l.updated_at, l.owner_id, l.phone,
           src.name AS source,
           NULL::text AS client_code,
           l.quoted_amount AS amount,
           l.quoted_volume_m3 AS volume_m3,
           l.quoted_weight_kg AS weight_kg,
           s.name AS stage_name,
           l.client_id
    FROM leads l
    JOIN lead_stages s ON s.id = l.stage_id
    LEFT JOIN lead_sources src ON src.id = l.source_id
  `,
  deal: sql`
    SELECT d.id, coalesce(nullif(d.title, ''), d.code) AS name, d.stage_id, d.updated_at,
           d.owner_id,
           NULL::text AS phone,
           NULL::text AS source,
           c.client_code,
           d.quoted_amount AS amount,
           d.quoted_volume_m3 AS volume_m3,
           d.quoted_weight_kg AS weight_kg,
           s.name AS stage_name,
           NULL::uuid AS client_id
    FROM deals d
    JOIN deal_stages s ON s.id = d.stage_id
    LEFT JOIN clients c ON c.id = d.client_id
  `,
} as const;

export function ruleRecordSource(board: ConditionBoard) {
  return BASE[board];
}

export function toRuleRecord(row: Record<string, unknown>): RuleRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    stageName: String(row.stage_name ?? ''),
    ownerId: (row.owner_id as string | null) ?? null,
    clientCode: (row.client_code as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    amount: (row.amount as string | null) ?? null,
    volumeM3: (row.volume_m3 as string | null) ?? null,
    weightKg: (row.weight_kg as string | null) ?? null,
    updatedAt: new Date(String(row.updated_at)),
  };
}

/**
 * The card an event was about.
 *
 * Called ONLY when the rule needs it — a rule with no conditions and no
 * placeholder is answered from the event's own payload, so the common case
 * still costs no query (#432).
 */
export async function loadRuleRecord(
  board: ConditionBoard,
  id: string,
): Promise<RuleRecord | null> {
  const rows = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM (${ruleRecordSource(board)}) r WHERE r.id = ${id}::uuid`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? toRuleRecord(row) : null;
}
