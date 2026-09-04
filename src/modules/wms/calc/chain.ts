import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import type { CalcSectionName } from './pricing';

/**
 * The correction CHAIN — what «V2» actually counts.
 *
 * The owner: «qayta hisoblaganda V1 turibti, V2 bo'lib chiqishi kerak
 * emasmi? eski narxlar tarixi bo'lishi kerak emasmidi?» Both halves have one
 * cause. `calc_requests.current_version_no` counts seals OF ONE REQUEST, and a
 * correction is a NEW request (`recalcFromSealed`, never a re-open — the
 * clock, the sweep and the manual «Bajarildi» must not re-arm against a
 * locked price). So every correction is born at 0, seals at 1, and reads
 * «V1». The column was copied from load plans, where a plan IS re-submitted on
 * the same row and v2 is real; here the counter is measuring the wrong noun.
 *
 * MEASURED before deciding: `current_version_no` has exactly two readers in
 * the tree, both inside the seal's own UPDATE … RETURNING, and nothing ever
 * clears `completed_at`, so the column can only hold 0 or 1. Nothing selects
 * on `version_no` across requests either — every money rule keys on
 * `request_id`, `version_id` or `supersedes_request_id` (checked by grep, not
 * hoped). Which is what makes DERIVING the number safe: the printed «V2»
 * changes, and nothing any of them select changes with it.
 *
 * The number is the rank among the chain's SEALED versions, by seal time —
 * not the chain's depth. A chain can hold a priceless link (sealed → handed
 * back → sealed again), and depth would call the last one V3 when two prices
 * ever existed. And it is NOT stored: a copied counter can disagree with the
 * graph and nothing can tell (#528's shape, a pair rule in one direction),
 * and a backfill would make a sealed column mean two things depending on when
 * its row was written. The graph already knows; the old prices were never
 * lost — `calc_versions` is never deleted — they had no screen. No migration.
 *
 * «Stands» is decided by the EDGE (a child request exists), never by rank
 * position — `notSupersededSql`'s own rule, which the offer and upsale money
 * already obey. Two sealed siblings off one parent both stand, which is true
 * and is the only visible sign of a fork; `recalcFromSealed` now refuses to
 * mint one.
 */

/**
 * Every request with the root of its chain. Recursion from the roots down, so
 * a fork's siblings share a root; capped in depth because the walk is over a
 * live table and a cycle, however impossible by construction, would otherwise
 * be a hang in a screen.
 */
function treeSql(): SQL {
  return sql`
    tree AS (
      SELECT id, id AS root_id, 0 AS depth
        FROM calc_requests
       WHERE supersedes_request_id IS NULL
      UNION ALL
      SELECT r.id, t.root_id, t.depth + 1
        FROM calc_requests r
        JOIN tree t ON r.supersedes_request_id = t.id
       WHERE t.depth < 64
    ),
    ranked0 AS (
      SELECT v.id            AS version_id,
             v.request_id,
             t.root_id,
             v.sealed_at,
             v.sealed_by,
             v.valid_until,
             v.section,
             v.total_usd,
             v.per_m3_usd,
             v.per_kg_usd,
             v.discount_usd,
             v.band_override_min,
             row_number() OVER (PARTITION BY t.root_id ORDER BY v.sealed_at, v.id)::int AS quote_no,
             EXISTS (
               SELECT 1 FROM calc_requests c WHERE c.supersedes_request_id = v.request_id
             ) AS superseded,
             EXISTS (
               SELECT 1 FROM calc_requests c
                WHERE c.supersedes_request_id = v.request_id
                  AND NOT EXISTS (SELECT 1 FROM calc_versions cv WHERE cv.request_id = c.id)
             ) AS recalc_open
        FROM calc_versions v
        JOIN tree t ON t.id = v.request_id
    ),
    ranked AS (
      SELECT rk0.*,
             (
               SELECT min(nx.quote_no)
                 FROM ranked0 nx
                 JOIN calc_requests c ON c.id = nx.request_id
                WHERE c.supersedes_request_id = rk0.request_id
             ) AS superseded_by_no
        FROM ranked0 rk0
    )`;
}

export interface ChainVersion {
  versionId: string;
  requestId: string;
  /** The rank among the chain's sealed versions — what «V2» prints. */
  quoteNo: number;
  sealedAt: Date;
  sealedByName: string | null;
  section: CalcSectionName;
  totalUsd: number;
  /** A child request exists — the edge, not the rank. */
  superseded: boolean;
  /** The child that replaced it, when it has sealed. */
  supersededByNo: number | null;
  /** A child exists and has no version yet: a correction is being written. */
  recalcOpen: boolean;
  expired: boolean;
}

type RankedRow = {
  version_id: string;
  request_id: string;
  root_id: string;
  sealed_at: Date;
  sealed_by_name: string | null;
  valid_until: Date;
  section: string;
  total_usd: string;
  per_m3_usd: string | null;
  per_kg_usd: string | null;
  discount_usd: string | null;
  band_override_min: string | null;
  quote_no: number;
  superseded: boolean;
  recalc_open: boolean;
  superseded_by_no: number | null;
};

function toChain(r: RankedRow, now: Date): ChainVersion {
  return {
    versionId: r.version_id,
    requestId: r.request_id,
    quoteNo: Number(r.quote_no),
    sealedAt: r.sealed_at,
    sealedByName: r.sealed_by_name,
    section: r.section as CalcSectionName,
    totalUsd: Number(r.total_usd),
    superseded: r.superseded,
    supersededByNo: r.superseded_by_no === null ? null : Number(r.superseded_by_no),
    recalcOpen: r.recalc_open,
    expired: r.valid_until < now,
  };
}

/**
 * The whole chain a request belongs to, oldest seal first.
 *
 * One query, both directions: up to the root, then everything under it. This
 * is what the workspace prints under a sealed price and what the card prints
 * as «Oldingi: V1 …» — the old price is a document at a URL, not a number.
 */
export async function chainOf(requestId: string, now = new Date()): Promise<ChainVersion[]> {
  const rows = await db.execute<RankedRow>(sql`
    WITH RECURSIVE up AS (
      SELECT id, supersedes_request_id, 0 AS depth FROM calc_requests WHERE id = ${requestId}::uuid
      UNION ALL
      SELECT r.id, r.supersedes_request_id, u.depth + 1
        FROM calc_requests r JOIN up u ON r.id = u.supersedes_request_id
       WHERE u.depth < 64
    ),
    ${treeSql()}
    SELECT rk.*, u.full_name AS sealed_by_name
      FROM ranked rk
      LEFT JOIN users u ON u.id = rk.sealed_by
     WHERE rk.root_id = (SELECT id FROM up WHERE supersedes_request_id IS NULL LIMIT 1)
     ORDER BY rk.sealed_at, rk.version_id
  `);
  return rows.map((r) => toChain(r, now));
}

/** The printed number for ONE version, or null when it has none (never sealed). */
export async function quoteNoFor(versionId: string): Promise<number | null> {
  const rows = await db.execute<{ quote_no: number }>(sql`
    WITH RECURSIVE ${treeSql()}
    SELECT quote_no FROM ranked WHERE version_id = ${versionId}::uuid
  `);
  return rows[0] ? Number(rows[0].quote_no) : null;
}

export interface RegistryFilters {
  /** ISO dates, already validated by the screen. */
  from?: string | null;
  to?: string | null;
  section?: CalcSectionName | null;
  /** The sealer's user id, already validated as a uuid. */
  sealerId?: string | null;
  /** Free text over client code / client name / deal code (and lead name
   * only when `leadsReadable`). */
  q?: string | null;
  /** Whether the reader may see lead NAMES at all (`crm.leads`) — a filter the
   * reader may not see must not be searchable either. */
  leadsReadable: boolean;
}

export interface RegistryRow extends ChainVersion {
  entityType: 'deal' | 'lead';
  entityId: string;
  /** Deal: «GS777 · Bobur». Lead: its name, or null when the reader may not. */
  cardLabel: string | null;
  dealCode: string | null;
  perM3Usd: number | null;
  perKgUsd: number | null;
  discountUsd: number;
  bandOverrideMin: number | null;
}

/** How many rows the screen draws; the counts say what it did not. */
export const REGISTRY_CAP = 200;

/** The one predicate the rows AND the counts share (#513). */
function registryWhere(f: RegistryFilters): SQL {
  const conds: SQL[] = [sql`TRUE`];
  if (f.from) conds.push(sql`rk.sealed_at >= ${f.from}::date`);
  if (f.to) conds.push(sql`rk.sealed_at < (${f.to}::date + interval '1 day')`);
  if (f.section) conds.push(sql`rk.section = ${f.section}`);
  if (f.sealerId) conds.push(sql`rk.sealed_by = ${f.sealerId}::uuid`);
  const q = (f.q ?? '').trim();
  if (q) {
    const needle = `%${q}%`;
    const parts: SQL[] = [
      sql`cl.client_code ILIKE ${needle}`,
      sql`cl.name ILIKE ${needle}`,
      sql`d.code ILIKE ${needle}`,
    ];
    if (f.leadsReadable) parts.push(sql`l.name ILIKE ${needle}`);
    conds.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  return sql.join(conds, sql` AND `);
}

/** The joins the predicate and the rows both read from. */
function registryFromSql(): SQL {
  return sql`
    FROM ranked rk
    JOIN calc_requests r ON r.id = rk.request_id
    LEFT JOIN users u ON u.id = rk.sealed_by
    LEFT JOIN deals d ON r.entity_type = 'deal' AND d.id = r.entity_id
    LEFT JOIN clients cl ON cl.id = d.client_id
    LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id`;
}

/**
 * «Muhrlangan hisob-kitoblar» — every sealed version, newest first, capped.
 *
 * ONE ROW PER SEALED VERSION, not per request and not per card: a corrected
 * job appears twice, which is the question the owner asked. His answer 1A —
 * sealed only; the bot's typed «Готово» answers are not here, and the screen
 * says so. Filters run in SQL over the SAME predicate as the counts, because a
 * filter over an already-capped fetch answers «not found» about rows it never
 * fetched (/stock's lesson).
 */
export async function registryRows(
  f: RegistryFilters,
  now = new Date(),
): Promise<RegistryRow[]> {
  const rows = await db.execute<
    RankedRow & {
      entity_type: 'deal' | 'lead';
      entity_id: string;
      client_code: string | null;
      client_name: string | null;
      deal_code: string | null;
      lead_name: string | null;
    }
  >(sql`
    WITH RECURSIVE ${treeSql()}
    SELECT rk.*, u.full_name AS sealed_by_name,
           r.entity_type, r.entity_id,
           cl.client_code, cl.name AS client_name, d.code AS deal_code, l.name AS lead_name
    ${registryFromSql()}
    WHERE ${registryWhere(f)}
    ORDER BY rk.sealed_at DESC, rk.version_id DESC
    LIMIT ${REGISTRY_CAP}
  `);
  return rows.map((r) => {
    const base = toChain(r, now);
    const cardLabel =
      r.entity_type === 'deal'
        ? [r.client_code, r.client_name].filter(Boolean).join(' · ') || null
        : f.leadsReadable
          ? r.lead_name
          : null;
    return {
      ...base,
      entityType: r.entity_type,
      entityId: r.entity_id,
      cardLabel,
      dealCode: r.deal_code,
      perM3Usd: r.per_m3_usd === null ? null : Number(r.per_m3_usd),
      perKgUsd: r.per_kg_usd === null ? null : Number(r.per_kg_usd),
      discountUsd: Number(r.discount_usd ?? 0),
      bandOverrideMin: r.band_override_min === null ? null : Number(r.band_override_min),
    };
  });
}

/**
 * Two counts over the registry's own predicate: VERSIONS (what the screen
 * lists) and JOBS (distinct chains). A corrected job is two rows and one
 * job, and the owner's sentence — «raschotlar spiskasi» — is about jobs, so
 * both numbers are printed and named (#913).
 */
export async function registryCounts(f: RegistryFilters): Promise<{ versions: number; jobs: number }> {
  const rows = await db.execute<{ versions: number; jobs: number }>(sql`
    WITH RECURSIVE ${treeSql()}
    SELECT count(*)::int AS versions, count(DISTINCT rk.root_id)::int AS jobs
    ${registryFromSql()}
    WHERE ${registryWhere(f)}
  `);
  return { versions: Number(rows[0]?.versions ?? 0), jobs: Number(rows[0]?.jobs ?? 0) };
}

/** People who have sealed at least once — the filter's options (#171: a
 * value the form cannot render disappears on the next submit). */
export async function registrySealers(): Promise<{ id: string; name: string }[]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    SELECT DISTINCT u.id::text AS id, u.full_name AS name
      FROM calc_versions v JOIN users u ON u.id = v.sealed_by
     ORDER BY u.full_name
  `);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
