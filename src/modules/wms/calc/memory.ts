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

/** Below this a name match is a different product; the setting may raise it. */
const MIN_SIM_DEFAULT = 0.6;

/**
 * The newest confirmed seal per name, in ONE query (#432).
 *
 * `word_similarity` and not `similarity`: the needle is a short product name
 * and the stored name can be a long line off an invoice, and plain similarity
 * divides by the union of both — it scores a true match near zero, which is
 * the defect #891 found in a browser after every integration test passed.
 *
 * The ordering is «the name decides WHICH product, the date only breaks a
 * tie»: similarity rounded to two decimals descending, then the newest seal.
 * Rounding is what makes the second half do any work — 0.95 against 0.94 is
 * not a difference between two products, and between two equally-named seals
 * the recent price is the one the office would quote.
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
  const rows = await db.execute<MemoryRow>(sql`
    SELECT DISTINCT ON (n.needle)
           n.needle,
           i.id::text            AS item_id,
           v.id::text            AS version_id,
           v.sealed_at,
           u.full_name           AS sealed_by_name,
           i.tnved_code,
           i.baza_usd,
           i.baza_basis,
           word_similarity(n.needle, i.name_norm) AS name_sim
      FROM unnest(ARRAY[${list}]::text[]) AS n(needle)
      JOIN calc_request_items i ON i.name_norm IS NOT NULL
      JOIN calc_groups g   ON g.id = i.group_id AND g.confirmed_at IS NOT NULL
      JOIN calc_versions v ON v.request_id = i.request_id
      LEFT JOIN users u    ON u.id = v.sealed_by
     WHERE i.request_id <> ${opts.excludeRequestId}::uuid
       AND word_similarity(n.needle, i.name_norm) >= ${minSim}
     ORDER BY n.needle,
              round(word_similarity(n.needle, i.name_norm)::numeric, 2) DESC,
              v.sealed_at DESC
  `);
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
