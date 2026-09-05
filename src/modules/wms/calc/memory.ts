import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import type { BazaBasis } from './pricing';

/**
 * The AI-VED's memory: what this company has already SEALED (0096).
 *
 * The owner, 2026-09-05: «shu muhrlangan datani AI xotirasiga qo'yish kerak».
 * A price a VED person confirmed and sealed is the company's own answer about
 * that product, so it is the FIRST place the machine looks the next time a
 * similar name arrives — ahead of the dictionaries, ahead of the quarterly
 * customs file, and far ahead of the model.
 *
 * THERE IS NO MEMORY TABLE, and that is the design. `lgotaLastByCode` (#767)
 * settled this shape once already: a second copy of a sealed number can
 * disagree with the seal it was copied from, and nothing could then say which
 * is true. The memory is the sealed record itself — `calc_versions` is never
 * deleted — and this module is the one query that reads it.
 *
 * WHAT IT SUPPLIES: the TNVED code and the baza (value + basis). Deliberately
 * NOT the rates: those come from PP-3818 by code at group mint, which is the
 * law and not an opinion, and a second rate writer is exactly what law 1
 * forbids. The lgota memory already exists beside this one and stays there.
 *
 * WHAT COUNTS AS MEMORY: an item of a request that has a `calc_versions` row
 * (it was sealed) whose group carried a ✅ (a person looked at those numbers).
 * An unconfirmed group is not a person's word even when the request sealed —
 * the seal is blocked on confirmations today, but a legacy row from before
 * that rule, or a group emptied and re-made, must not become a source.
 * SUPERSEDED requests do count: their seal WAS a person's word on that day,
 * and the correction that replaced it is newer and wins by the ordering.
 */

/**
 * The name a memory is looked up by — lower-cased, whitespace collapsed.
 *
 * ONE helper, called by every item writer (`openCalcRequest`, `saveTable`'s
 * edits and adds, `recalcFromSealed`'s copy) rather than a database trigger:
 * a trigger is invisible to the audit row and to the transaction discipline,
 * and this column has to be written by the same statement that writes the
 * name it describes. The SQL in 0096 backfills with the same expression.
 */
export function itemNameNorm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface MemoryHit {
  /** The sealed item this answer was copied from — provenance for the 🧠 chip. */
  itemId: string;
  versionId: string;
  sealedAt: Date;
  sealedByName: string | null;
  tnvedCode: string | null;
  bazaUsd: number | null;
  bazaBasis: BazaBasis | null;
  /** How close the names were, 0..1 — printed nowhere, used by the caller's
   * own thresholds and by the tests. */
  nameSim: number;
}

type MemoryRow = {
  needle: string;
  item_id: string;
  version_id: string;
  sealed_at: string;
  sealed_by_name: string | null;
  tnved_code: string | null;
  baza_usd: string | null;
  baza_basis: string | null;
  name_sim: number;
};

/**
 * «Exclude nothing» — a request that does not exist yet (the intake's own
 * case: the items are being written, so there is no id to leave out). A real
 * uuid rather than a null branch, because the query's `<>` must stay one
 * shape for the planner and for the reader.
 */
export const NO_REQUEST = '00000000-0000-0000-0000-000000000000';

/** Below this a name match is a different product; the setting may raise it. */
const MIN_SIM_DEFAULT = 0.6;

/**
 * The newest confirmed seal per name, in ONE query (#432).
 *
 * `similarity` and NOT `word_similarity`, which is the opposite of the choice
 * #891 records — and the difference between the two cases is the whole
 * reason. There the needle is a short product name and the target is a long
 * DECLARATION paragraph somebody filed, so a symmetric measure divides by a
 * union the needle never had a chance of filling. Here BOTH sides are our own
 * item names, of comparable length, and `word_similarity` is asymmetric:
 * MEASURED, «sumka» against «sumka teri» scores **1.000**, «monitor» against
 * «monitor 24"» scores **1.000**, and «erkaklar kurtkasi» against «ayollar
 * kurtkasi» scores **0.611** — men's jackets inheriting women's price.
 * `similarity` answers 0.545, 0.400 and 0.458 for the same three: each
 * refused, while «erkaklar kurtkasi» against «erkaklar kurtkasi qora» still
 * scores 0.783 and is taken. A memory that answers about a DIFFERENT product
 * is worse than one that answers about nothing.
 *
 * The ordering is «the name decides WHICH product, the date only breaks a
 * tie»: similarity rounded to two decimals descending, then the newest seal.
 * Rounding is what makes the second half do any work — 0.95 against 0.94 is
 * not a difference between two products, and between two equally-named seals
 * the recent price is the one the office would quote.
 *
 * `%` BESIDE the comparison, and it is not decoration. MEASURED on 50 000
 * sealed item names — the size this table reaches after a year or two of the
 * feature — the comparison ALONE is a sequential scan per needle: **919 ms**,
 * with 0096's GIN index never read. `%` is the operator the index answers,
 * and the same query comes back in a millisecond. The operator's own
 * threshold is a GUC, so it is set for the TRANSACTION (`set_config(…, true)`
 * — local, reverted at commit, never leaked onto a pooled connection) from
 * the same setting the comparison uses; if the two ever disagreed the
 * operator would silently narrow what the threshold admits, which is why they
 * are written from one value.
 */
export async function sealedMemoryFor(
  names: string[],
  opts: { excludeRequestId: string; minSim?: number },
): Promise<Map<string, MemoryHit>> {
  const out = new Map<string, MemoryHit>();
  const needles = [...new Set(names.map(itemNameNorm).filter(Boolean))];
  if (needles.length === 0) return out;

  const configured = opts.minSim ?? Number(await getSetting('calc_memory_min_sim'));
  const minSim = Number.isFinite(configured) ? configured : MIN_SIM_DEFAULT;

  // A JS array interpolated into a raw fragment is not a postgres array —
  // it is a comma-joined string that `unnest` refuses (the house footgun).
  const list = sql.join(
    needles.map((n) => sql`${n}`),
    sql`, `,
  );
  // One short read transaction, for the GUC alone: `set_config(…, true)` is
  // reverted at commit, so nothing about the pool's next borrower changes.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('pg_trgm.similarity_threshold', ${String(minSim)}, true)`,
    );
    return tx.execute<MemoryRow>(sql`
    SELECT DISTINCT ON (n.needle)
           n.needle,
           i.id::text            AS item_id,
           v.id::text            AS version_id,
           v.sealed_at,
           u.full_name           AS sealed_by_name,
           i.tnved_code,
           i.baza_usd,
           i.baza_basis,
           similarity(n.needle, i.name_norm) AS name_sim
      FROM unnest(ARRAY[${list}]::text[]) AS n(needle)
      JOIN calc_request_items i ON i.name_norm IS NOT NULL AND n.needle % i.name_norm
      JOIN calc_groups g   ON g.id = i.group_id AND g.confirmed_at IS NOT NULL
      JOIN calc_versions v ON v.request_id = i.request_id
      LEFT JOIN users u    ON u.id = v.sealed_by
     WHERE i.request_id <> ${opts.excludeRequestId}::uuid
       AND similarity(n.needle, i.name_norm) >= ${minSim}
     ORDER BY n.needle,
              round(similarity(n.needle, i.name_norm)::numeric, 2) DESC,
              v.sealed_at DESC
  `);
  });
  return collect(rows, out);
}

function collect(rows: MemoryRow[], out: Map<string, MemoryHit>): Map<string, MemoryHit> {
  for (const r of rows) {
    out.set(r.needle, {
      itemId: r.item_id,
      versionId: r.version_id,
      // A raw `db.execute` hands timestamps back as TEXT (#925, found in a
      // browser with every test green) — coerce, never assume.
      sealedAt: new Date(r.sealed_at),
      sealedByName: r.sealed_by_name,
      tnvedCode: r.tnved_code,
      bazaUsd: r.baza_usd === null ? null : Number(r.baza_usd),
      bazaBasis: (r.baza_basis as BazaBasis | null) ?? null,
      nameSim: Number(r.name_sim),
    });
  }
  return out;
}

/**
 * Who sealed the answer a row is wearing, for the 🧠 chip's title.
 *
 * ONE query for every memory-filled row on the screen (#432), keyed by the
 * sealed ITEM id that `memory_item_id` names.
 *
 * It prints a DATE and a PERSON and deliberately not a «V2»: the V number on
 * /hisoblash/tarix is the rank within a correction CHAIN (`calc/chain.ts`
 * walks `supersedes_request_id` for it), while `calc_versions.version_no` is
 * the seal count of one request — the two disagree the moment a job has been
 * re-calculated, and two screens printing different V's for one seal is worse
 * than a chip that does not print one at all.
 */
export interface MemoryProvenance {
  sealedAt: Date;
  sealedByName: string | null;
}

type ProvenanceRow = {
  item_id: string;
  sealed_at: string;
  sealed_by_name: string | null;
};

export async function memoryProvenanceFor(itemIds: string[]): Promise<Map<string, MemoryProvenance>> {
  const out = new Map<string, MemoryProvenance>();
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = await db.execute<ProvenanceRow>(sql`
    SELECT DISTINCT ON (i.id)
           i.id::text  AS item_id,
           v.sealed_at,
           u.full_name AS sealed_by_name
      FROM calc_request_items i
      JOIN calc_versions v ON v.request_id = i.request_id
      LEFT JOIN users u    ON u.id = v.sealed_by
     WHERE i.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
     ORDER BY i.id, v.sealed_at DESC
  `);
  for (const r of rows) {
    // TEXT out of a raw execute (#925).
    out.set(r.item_id, { sealedAt: new Date(r.sealed_at), sealedByName: r.sealed_by_name });
  }
  return out;
}
