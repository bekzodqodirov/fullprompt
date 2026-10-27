import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../../platform/db/client';
import { isAnswerSql } from './credit';
import { answerFloorStandsSql, currentVersionSql, notSupersededSql } from './version-set';
import { offerStandsSql, releasedOfferWhere } from './workspace';

/**
 * A won lead's jobs, one deal per SALE (his Q5 a, 2026-10-27: «har so'rovga
 * yangi bitim» — a lead that collected two or three jobs gives each its own
 * deal at the win; docs/UCH-BAND.md §7).
 *
 * A sale is what the MONEY rules call one, never a correction chain alone
 * (judge money-1): `answerFloorStandsSql` is card-keyed — a Готово answer
 * stops standing once a newer answer or ANY later seal exists on the same
 * card («a Готово price and a later proper seal are two requests but one
 * sale»), and moved alone onto a deal of its own it would stand again, its
 * offer with it, lock that deal and become payable. So the lead's jobs are
 * grouped by two kinds of edge:
 *   - the chain edge — a correction and the request it corrects;
 *   - the outranked edge — an answer that does not stand on the lead, and
 *     every job on the lead that answered or sealed after it.
 * A component with something STANDING (a seal, an answer) or still OPEN gets
 * its own deal; a component that is all history goes with the main deal.
 */

export interface LeadJob {
  id: string;
  supersedes: string | null;
  section: string | null;
  createdAt: Date;
  open: boolean;
  /** A completed USD answer above zero, and when. */
  answerAt: Date | null;
  answerStands: boolean;
  /** The request's current version, standing or not. */
  seal: {
    at: Date;
    by: string | null;
    stands: boolean;
    totalUsd: number;
    volumeM3: number | null;
    weightKg: number | null;
  } | null;
  /** Its newest RELEASED offer (either anchor), standing or not. */
  offer: { at: Date; by: string | null; stands: boolean; priceUsd: number } | null;
}

type Row = {
  id: string;
  supersedes: string | null;
  section: string | null;
  created_at: string;
  open: boolean;
  answer_at: string | null;
  answer_stands: boolean;
  seal_at: string | null;
  seal_by: string | null;
  seal_stands: boolean | null;
  seal_total: string | null;
  seal_m3: string | null;
  seal_kg: string | null;
  offer_at: string | null;
  offer_by: string | null;
  offer_stands: boolean | null;
  offer_price: string | null;
};

/**
 * Every job on the lead with the facts the grouping and the quotes need — ONE
 * statement, on whichever handle the caller holds: the win reads it on the
 * POOL to plan, and again inside its transaction under the row locks, and
 * refuses `changed` when the two disagree (judge conc-4).
 */
export async function leadJobsFor(exec: Db | Tx, leadId: string): Promise<LeadJob[]> {
  const rows = (await exec.execute(sql`
    SELECT r.id::text AS id, r.supersedes_request_id::text AS supersedes, r.section,
           r.requested_at::text AS created_at,
           (r.completed_at IS NULL) AS open,
           CASE WHEN ${isAnswerSql('r')} AND r.answer_currency = 'USD' AND r.answer_amount > 0
                THEN r.completed_at::text END AS answer_at,
           coalesce(${isAnswerSql('r')} AND ${answerFloorStandsSql()}, false) AS answer_stands,
           sv.sealed_at::text AS seal_at, sv.sealed_by::text AS seal_by, sv.stands AS seal_stands,
           sv.total_usd::text AS seal_total, sv.volume_m3::text AS seal_m3, sv.weight_kg::text AS seal_kg,
           ro.at::text AS offer_at, ro.offered_by::text AS offer_by, ro.stands AS offer_stands,
           ro.client_price_usd::text AS offer_price
      FROM calc_requests r
      LEFT JOIN LATERAL (
        SELECT v.sealed_at, v.sealed_by, v.total_usd, v.volume_m3, v.weight_kg,
               (${notSupersededSql()}) AS stands
          FROM calc_versions v
         WHERE v.request_id = r.id AND ${currentVersionSql()}
         LIMIT 1
      ) sv ON true
      LEFT JOIN LATERAL (
        -- Unaliased: \`offerStandsSql\` names the table, never an alias.
        SELECT coalesce(calc_offers.approved_at, calc_offers.offered_at) AS at, calc_offers.offered_by,
               calc_offers.client_price_usd, (${offerStandsSql()}) AS stands
          FROM calc_offers
         WHERE (calc_offers.request_id = r.id
                OR calc_offers.version_id IN (SELECT vv.id FROM calc_versions vv WHERE vv.request_id = r.id))
           AND ${releasedOfferWhere()}
         ORDER BY 1 DESC
         LIMIT 1
      ) ro ON true
     WHERE r.entity_type = 'lead' AND r.entity_id = ${leadId}::uuid
     ORDER BY r.requested_at, r.id
  `)) as unknown as Row[];
  return rows.map((row) => ({
    id: row.id,
    supersedes: row.supersedes,
    section: row.section,
    createdAt: new Date(row.created_at),
    open: row.open === true,
    answerAt: row.answer_at ? new Date(row.answer_at) : null,
    answerStands: row.answer_stands === true,
    seal: row.seal_at
      ? {
          at: new Date(row.seal_at),
          by: row.seal_by,
          stands: row.seal_stands === true,
          totalUsd: Number(row.seal_total),
          volumeM3: row.seal_m3 === null ? null : Number(row.seal_m3),
          weightKg: row.seal_kg === null ? null : Number(row.seal_kg),
        }
      : null,
    offer: row.offer_at
      ? { at: new Date(row.offer_at), by: row.offer_by, stands: row.offer_stands === true, priceUsd: Number(row.offer_price) }
      : null,
  }));
}

/** What the transaction compares: the plan was made on the facts it re-reads. */
export function jobsDigest(jobs: readonly LeadJob[]): string {
  return JSON.stringify(
    jobs.map((j) => [
      j.id,
      j.supersedes,
      j.open,
      j.answerAt?.toISOString() ?? null,
      j.answerStands,
      j.seal ? [j.seal.at.toISOString(), j.seal.stands, j.seal.totalUsd] : null,
      j.offer ? [j.offer.at.toISOString(), j.offer.stands, j.offer.priceUsd] : null,
    ]),
  );
}

/** The lead's jobs as sales: connected components of the chain and outranked edges (pure). */
export function groupBySale(jobs: readonly LeadJob[]): LeadJob[][] {
  const parent = new Map<string, string>(jobs.map((j) => [j.id, j.id]));
  const find = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    parent.set(id, at);
    return at;
  };
  const join = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const job of jobs) if (job.supersedes) join(job.id, job.supersedes);
  for (const answer of jobs) {
    // An answer that does not stand on the lead although nobody corrected it
    // was outranked there — by every job that answered or sealed after it.
    if (!answer.answerAt || answer.answerStands) continue;
    if (jobs.some((j) => j.supersedes === answer.id)) continue;
    for (const later of jobs) {
      if (later.id === answer.id) continue;
      const answeredLater = later.answerAt !== null && later.answerAt > answer.answerAt;
      const sealedLater = later.seal !== null && later.seal.at > answer.answerAt;
      if (answeredLater || sealedLater) join(answer.id, later.id);
    }
  }
  const groups = new Map<string, LeadJob[]>();
  for (const job of jobs) {
    const root = find(job.id);
    groups.set(root, [...(groups.get(root) ?? []), job]);
  }
  return [...groups.values()];
}

/** A sale that still means something: a job open, or a seal or an answer standing. */
export function saleIsLive(sale: readonly LeadJob[]): boolean {
  return sale.some((j) => j.open || j.answerStands || (j.seal?.stands ?? false));
}

/**
 * The price a sale's own deal opens with — `quoteLockedFor`'s rule over the
 * sale's own jobs (judge money-4): the newest seal (amount, volume, weight —
 * what the seal writes on a card) against the newest released offer (its
 * amount only), later writer by the clock, and only while that writer
 * stands; a writer that no longer stands opens the deal unpriced.
 */
export function saleQuote(sale: readonly LeadJob[]): {
  amount: number;
  volumeM3: number | null;
  weightKg: number | null;
  at: Date;
  by: string | null;
} | null {
  const seal = sale
    .map((j) => j.seal)
    .filter((s): s is NonNullable<LeadJob['seal']> => s !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  const offer = sale
    .map((j) => j.offer)
    .filter((o): o is NonNullable<LeadJob['offer']> => o !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (offer && (!seal || offer.at >= seal.at)) {
    if (!offer.stands) return null;
    return { amount: offer.priceUsd, volumeM3: seal?.volumeM3 ?? null, weightKg: seal?.weightKg ?? null, at: offer.at, by: offer.by };
  }
  if (!seal || !seal.stands) return null;
  return { amount: seal.totalUsd, volumeM3: seal.volumeM3, weightKg: seal.weightKg, at: seal.at, by: seal.by };
}

/**
 * The plan: which sale is the MAIN deal's (the one that wrote the lead's own
 * number, else the newest live one), which sales get deals of their own
 * (every other live sale), and which stay with the main deal as history.
 */
export function planWinSplit(
  jobs: readonly LeadJob[],
  writerRequestId: string | null,
): { main: LeadJob[]; own: LeadJob[][] } {
  const sales = groupBySale(jobs);
  if (sales.length === 0) return { main: [], own: [] };
  const live = sales.filter(saleIsLive);
  const newest = (sale: readonly LeadJob[]) => Math.max(...sale.map((j) => j.createdAt.getTime()));
  const mainSale =
    (writerRequestId ? sales.find((sale) => sale.some((j) => j.id === writerRequestId)) : undefined) ??
    [...live].sort((a, b) => newest(b) - newest(a))[0] ??
    null;
  const own = live.filter((sale) => sale !== mainSale);
  const main = sales.filter((sale) => !own.includes(sale)).flat();
  return { main, own };
}
