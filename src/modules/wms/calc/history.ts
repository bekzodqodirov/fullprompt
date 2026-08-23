import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcGroups, calcOffers, calcRequests, calcVersions } from '@/modules/platform/db/schema';
import type { CalcSectionName } from './pricing';

/**
 * Price history (docs/VED.md phase C, law 10) — «sotuvchi va vedga narxlar
 * tarixi korinasa yaxshi bolar edi».
 *
 * Everything here obeys one rule the first design got wrong twice: **a
 * per-product price is shown only where it is exact, and a per-request price
 * is always labelled with the section that produced it.**
 *
 * Why the section matters: `totalsFor` zeroes the parts a section does not
 * have, so `per_m3_usd` is FREIGHT alone on a yolkira quote, CUSTOMS alone on
 * a rastamojka one and everything on a podklyuch one. Printing the three in
 * one column as «price per cube» compares three different services.
 *
 * Why customs is per-product and freight is not: `customsFor` runs per GROUP
 * and the seal stores each group's own figure, so a group's customs per m³ is
 * exact arithmetic on stored numbers. Freight is computed ONCE for the whole
 * request from the request's own density — measured, a 30 m³ mix of monitors
 * and tiles lands in band 451-500 at $290/m³ while the monitors alone are
 * band 1-100 at $110/m³, so allocating the mixed rate onto them overstates
 * their freight 2.64×. It is never allocated here.
 */

export interface QuoteHistoryRow {
  versionId: string;
  requestId: string;
  entityType: 'deal' | 'lead';
  entityId: string;
  sealedAt: Date;
  section: CalcSectionName;
  /** The whole consignment, for context — always labelled with its section. */
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
  volumeM3: number | null;
  weightKg: number | null;
  /** Exact, from this code's own group. Null when the group lacks a measure. */
  groupLabel: string;
  groupCustomsUsd: number | null;
  groupCustomsPerM3: number | null;
  groupCustomsPerUnit: number | null;
  /** What a seller actually quoted, when one has been recorded. */
  clientPriceUsd: number | null;
  belowFloor: boolean;
}

interface BreakdownGroup {
  tnvedCode?: string | null;
  label?: string | null;
  quantity?: number | null;
  volumeM3?: number | null;
  customs?: { customsUsd?: number | null } | null;
  items?: { volumeM3?: number | null; quantity?: number | null }[] | null;
}

/**
 * A group's customs per cube — or null.
 *
 * `groupMeasure` sums only the items that CARRY a measure, so a three-item
 * group where one item has a volume reports that one item's volume as the
 * group's. Dividing by it prints roughly three times the true rate. So the
 * per-unit figure is refused unless every item in the group has the measure.
 *
 * An OLD sealed row has no `volumeM3` on its items at all (the field was
 * added in phase C), which this treats exactly like a missing measure.
 */
export function groupPerUnit(
  group: BreakdownGroup,
  measure: 'volumeM3' | 'quantity',
): number | null {
  const customs = group.customs?.customsUsd;
  const total = group[measure];
  const items = group.items ?? [];
  if (typeof customs !== 'number' || !Number.isFinite(customs)) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  if (items.length === 0) return null;
  const every = items.every((i) => {
    const v = i?.[measure];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });
  if (!every) return null;
  return Math.round((customs / total) * 100) / 100;
}

/**
 * Every sealed quote that priced this TNVED code, newest first.
 *
 * The code is read from `calc_groups` (indexed by 0087) and not from the
 * breakdown jsonb, so postgres can answer with a semi-join over an index
 * instead of a scan over every sealed document ever written.
 *
 * EXISTS and not a JOIN: a request may hold several groups, and a join
 * against the group table returns the version once PER GROUP — so «the last
 * five quotes» silently becomes «the last five group rows», which on a
 * five-group consignment is one quote. That also lets the ORDER BY and the
 * LIMIT stay in SQL, where a busy code's history does not have to be
 * fetched whole to be cut to five (#432).
 */
export async function quoteHistoryFor(
  tnvedCode: string,
  opts: { limit?: number; section?: CalcSectionName } = {},
): Promise<QuoteHistoryRow[]> {
  const code = tnvedCode.trim();
  if (!code) return [];
  const limit = opts.limit ?? 5;

  const where = [
    sql`EXISTS (SELECT 1 FROM ${calcGroups} WHERE ${calcGroups}.request_id = ${calcVersions}.request_id AND ${calcGroups}.tnved_code = ${code})`,
  ];
  if (opts.section) where.push(eq(calcVersions.section, opts.section));

  const sorted = await db
    .select({
      version: calcVersions,
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
    })
    .from(calcVersions)
    .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
    .where(and(...where))
    .orderBy(desc(calcVersions.sealedAt))
    .limit(limit);

  if (sorted.length === 0) return [];

  const offers = await offersByVersion(sorted.map((r) => r.version.id));

  return sorted.map((r) => {
    const v = r.version;
    const breakdown = (v.breakdown ?? {}) as { groups?: BreakdownGroup[] };
    const group = (breakdown.groups ?? []).find((g) => (g.tnvedCode ?? '').trim() === code);
    const offer = offers.get(v.id) ?? null;
    return {
      versionId: v.id,
      requestId: v.requestId,
      entityType: r.entityType as 'deal' | 'lead',
      entityId: r.entityId,
      sealedAt: v.sealedAt,
      section: v.section as CalcSectionName,
      totalUsd: Number(v.totalUsd),
      perM3Usd: v.perM3Usd === null ? null : Number(v.perM3Usd),
      perKgUsd: v.perKgUsd === null ? null : Number(v.perKgUsd),
      volumeM3: v.volumeM3 === null ? null : Number(v.volumeM3),
      weightKg: v.weightKg === null ? null : Number(v.weightKg),
      groupLabel: group?.label ?? code,
      groupCustomsUsd:
        typeof group?.customs?.customsUsd === 'number' ? group.customs.customsUsd : null,
      groupCustomsPerM3: group ? groupPerUnit(group, 'volumeM3') : null,
      groupCustomsPerUnit: group ? groupPerUnit(group, 'quantity') : null,
      clientPriceUsd: offer ? Number(offer.clientPriceUsd) : null,
      belowFloor: offer?.belowFloor ?? false,
    };
  });
}

/** The newest offer per version — one grouped query, never one per row (#432). */
async function offersByVersion(versionIds: string[]) {
  if (versionIds.length === 0) return new Map<string, typeof calcOffers.$inferSelect>();
  const rows = await db
    .select()
    .from(calcOffers)
    .where(inArray(calcOffers.versionId, versionIds))
    .orderBy(desc(calcOffers.offeredAt));
  const out = new Map<string, typeof calcOffers.$inferSelect>();
  for (const r of rows) if (!out.has(r.versionId)) out.set(r.versionId, r);
  return out;
}

/** The codes a sealed version priced — what the history screen offers to look up. */
export async function codesInVersion(requestId: string): Promise<{ code: string; label: string }[]> {
  const rows = await db
    .select({ code: calcGroups.tnvedCode, label: calcGroups.label })
    .from(calcGroups)
    .where(and(eq(calcGroups.requestId, requestId), sql`${calcGroups.tnvedCode} IS NOT NULL`));
  return rows
    .filter((r) => r.code)
    .map((r) => ({ code: r.code!.trim(), label: r.label }));
}

export interface LastQuote {
  code: string;
  versionId: string;
  requestId: string;
  sealedAt: Date;
  section: CalcSectionName;
  totalUsd: number;
  perM3Usd: number | null;
  perKgUsd: number | null;
}

/**
 * The last N sealed quotes for EACH of several codes — in one query.
 *
 * The workspace shows this beside the group the VED is pricing, so it is
 * asked once per screen with every code on it. One `quoteHistoryFor` per code
 * would be a query per row on a list, which is the shape rounds 45, 68 and
 * 108 each found saturating the one Node process (#432).
 *
 * `row_number() OVER (PARTITION BY code …)` is the funnel's own per-stage cap
 * (#74): a plain LIMIT over the union takes the newest N ACROSS all codes, so
 * a busy code would fill the list and a quiet one would show nothing.
 *
 * The inner DISTINCT matters: a request may hold two groups carrying the same
 * code, and without it that version is counted twice and one of the three
 * slots is spent printing the same quote again.
 */
export async function lastQuotesByCode(
  codes: string[],
  perCode = 3,
): Promise<Map<string, LastQuote[]>> {
  const list = [...new Set(codes.map((c) => c.trim()))].filter(Boolean);
  const out = new Map<string, LastQuote[]>();
  if (list.length === 0) return out;

  const rows = await db.execute<{
    code: string;
    version_id: string;
    request_id: string;
    sealed_at: Date;
    section: string;
    total_usd: string;
    per_m3_usd: string | null;
    per_kg_usd: string | null;
  }>(sql`
    WITH pairs AS (
      SELECT DISTINCT
        g.tnved_code    AS code,
        v.id            AS version_id,
        v.request_id    AS request_id,
        v.sealed_at     AS sealed_at,
        v.section       AS section,
        v.total_usd     AS total_usd,
        v.per_m3_usd    AS per_m3_usd,
        v.per_kg_usd    AS per_kg_usd
      FROM calc_groups g
      JOIN calc_versions v ON v.request_id = g.request_id
      WHERE g.tnved_code IN (${sql.join(
        list.map((c) => sql`${c}`),
        sql`, `,
      )})
    )
    SELECT * FROM (
      SELECT p.*, row_number() OVER (PARTITION BY p.code ORDER BY p.sealed_at DESC) AS rn
      FROM pairs p
    ) z
    WHERE z.rn <= ${perCode}
    ORDER BY z.code, z.sealed_at DESC
  `);

  for (const r of rows) {
    const bucket = out.get(r.code) ?? [];
    bucket.push({
      code: r.code,
      versionId: r.version_id,
      requestId: r.request_id,
      sealedAt: new Date(r.sealed_at),
      section: r.section as CalcSectionName,
      totalUsd: Number(r.total_usd),
      perM3Usd: r.per_m3_usd === null ? null : Number(r.per_m3_usd),
      perKgUsd: r.per_kg_usd === null ? null : Number(r.per_kg_usd),
    });
    out.set(r.code, bucket);
  }
  return out;
}
