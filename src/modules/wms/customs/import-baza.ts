import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { normalizeName, type ImportUnit } from './import-parse';
import { newestReadyBatchId } from './import-service';

/**
 * «Bazani tanlashda yordam bersin» — the customs dump answering the VED's
 * baza question (docs/VED-IMPORT-AI.md §2.3).
 *
 * The owner's own rule, verbatim: «qaysi narx(baz)ni olishni tovar nomi shu
 * bizda hisoblatishga berilgan tovar nomi bilan qanchalik togriligiga qarab
 * olamiz agar togri bolmasa baza yoq deb ved hodimi ozi qoyadi. donada
 * hisoblanadgan tovarlarda har bir tovarni ogirligiga qaraymiz.»
 *
 * So: the CODE narrows (exactly — a neighbouring code's price is not this
 * code's price), the NAME ranks, the WEIGHT re-ranks piece goods, and below
 * the threshold nothing is filled at all. A guess that silently prices cargo
 * is worse than an empty cell the VED fills themselves.
 */

/** The baza basis each file unit fills. sm³ cannot appear — see #868. */
export const BASIS_FOR_UNIT: Record<ImportUnit, 'kg' | 'unit' | 'm2' | 'juft' | 'litr'> = {
  kg: 'kg',
  dona: 'unit',
  m2: 'm2',
  juft: 'juft',
  litr: 'litr',
};

/**
 * The inverse — which file unit a row priced on this basis is looking for.
 *
 * `defaultBasisFor` already turns the CODE's law into a basis, so the caller
 * asks the law once and this maps it into the file's vocabulary; keeping a
 * second law→unit chain beside it would be #513 in a lookup table.
 */
export const UNIT_FOR_BASIS: Record<'kg' | 'unit' | 'm2' | 'juft' | 'litr', ImportUnit> = {
  kg: 'kg',
  unit: 'dona',
  m2: 'm2',
  juft: 'juft',
  litr: 'litr',
};

/**
 * Which of the file's units may price THIS row, best first.
 *
 * MEASURED, and the reason this function exists at all: 74 % of his file is
 * declared per kilogram, while `defaultBasisFor` answers 'unit' for every
 * ordinary advalor code — the law only pins a unit when it charges a
 * specific duty. Asking per-dona alone would have refused three quarters of
 * every quarter's file while looking like it was working.
 *
 * So: when the law PINS a unit (m²/juft/litr, or a per-kg duty), that is the
 * only answer — a price in another unit is off by the weight of the goods.
 * When it does not, the row itself decides: whatever it states a figure for,
 * with kilograms first because that is what the file and the trade use, and
 * pieces first where the law is counting pieces. A row stating neither a
 * weight nor a count cannot be valued at all, and gets no suggestion.
 */
export function unitsForRow(input: {
  dutyUnit: string | null | undefined;
  hasWeight: boolean;
  hasQuantity: boolean;
}): ImportUnit[] {
  const u = input.dutyUnit;
  if (u === 'm2' || u === 'juft' || u === 'litr') return [u];
  if (u === 'kg') return ['kg'];
  const kg: ImportUnit[] = input.hasWeight ? ['kg'] : [];
  const dona: ImportUnit[] = input.hasQuantity ? ['dona'] : [];
  return u === 'dona' || u === '1000_dona' || u === 'sm3' ? [...dona, ...kg] : [...kg, ...dona];
}

export interface ImportBazaRow {
  id: string;
  name: string;
  unit: ImportUnit;
  basis: 'kg' | 'unit' | 'm2' | 'juft' | 'litr';
  pricePerUnitUsd: number;
  weightPerUnitKg: number | null;
  declaredAt: string | null;
  sender: string | null;
  /** 0..1 — how close the file's name is to the one the VED typed. */
  nameSim: number;
  /** The rank the ordering used: nameSim, or the weight-blended score. */
  score: number;
  /** Does this row's unit match the row being priced? Only a match may auto-fill. */
  unitMatches: boolean;
}

export interface ImportBazaSuggestion {
  /** Filled automatically (above the threshold, unit matches) — or null. */
  auto: ImportBazaRow | null;
  /** What the picker lists, best first. Includes unit mismatches, labelled. */
  candidates: ImportBazaRow[];
  /** Which import the answer came from — null when nothing is imported yet. */
  batchId: string | null;
  /** How many declarations the file holds under this code, before the cap —
   * so the screen can say «200 ta · eng mos 50 tasi» rather than implying
   * that fifty is all there is. */
  total: number;
}

/** How many rows the AUTO-fill path ranks. Ten is what it needs to pick one. */
const CANDIDATE_LIMIT = 10;
/**
 * How many the PICKER lists.
 *
 * Ten was «a screenful» when the list lived in a 288px popover that the
 * table clipped anyway. In a dialog with a search box the question changes:
 * the search filters what has been FETCHED, so the cap decides what he can
 * ever reach. Fifty is roughly 25 KB of declaration prose — measured against
 * the 500-character names his own file carries — and the count line says
 * when there are more.
 */
const PICKER_LIMIT = 50;
const MIN_SIM_DEFAULT = 0.45;
/** Shorter than this and «name similarity» stops meaning anything. */
const MIN_NEEDLE = 4;

interface SuggestInput {
  tnvedCode: string;
  name: string;
  /** The unit the ROW is priced in — from the code's law, or per-dona. */
  unit: ImportUnit;
  /** kg per piece, when the request row states both a weight and a count. */
  weightPerUnitKg?: number | null;
}

/**
 * Candidates for ONE row. The batch id is passed in by the batched caller so
 * a hundred-row save does not ask «which import is newest» a hundred times.
 */
export async function suggestImportBaza(
  input: SuggestInput,
  opts: { batchId?: string | null; minSim?: number; picker?: boolean } = {},
): Promise<ImportBazaSuggestion> {
  const batchId = opts.batchId !== undefined ? opts.batchId : await newestReadyBatchId();
  if (!batchId) return { auto: null, candidates: [], batchId: null, total: 0 };

  const needle = normalizeName(input.name);
  // A needle this short matches inside almost any declaration text: at three
  // characters «м2» or «оси» would auto-price a whole quarter, so it can
  // never AUTO-fill.
  //
  // But it used to return an empty list as well, and the comment right here
  // claimed the opposite («The picker still answers»). So a row honestly
  // called «Лак» or «Мёд» opened the picker onto «nothing under this code»
  // about a code that may hold four hundred declarations — the feature
  // unreachable for exactly the shortest, commonest names. The WHERE clause
  // never used the needle; it only SCORED. So in picker mode the list is
  // simply ordered by what is knowable without a name: the matching unit
  // first, then the newest declaration.
  const usable = needle.length >= MIN_NEEDLE;
  if (!usable && !opts.picker) return { auto: null, candidates: [], batchId, total: 0 };

  const limit = opts.picker ? PICKER_LIMIT : CANDIDATE_LIMIT;
  const { rows, total } = await queryCandidates(batchId, input, usable ? needle : null, limit);
  const candidates = rows.slice(0, limit);
  if (!usable) return { auto: null, candidates, batchId, total };

  const minSim =
    opts.minSim ?? Number((await getSetting('import_baza_min_sim')) ?? MIN_SIM_DEFAULT);
  const best = candidates[0];
  // Auto-fill needs BOTH: a name we believe, and the right unit. A per-kg
  // price landing on a per-dona row is off by the weight of the goods.
  const auto = best && best.unitMatches && best.nameSim >= minSim ? best : null;
  return { auto, candidates, batchId, total };
}

/**
 * The ranking, in SQL.
 *
 * `word_similarity(needle, name_norm)` and deliberately NOT `similarity()`:
 * MEASURED on his own file, «Товар номи» is a whole declaration paragraph —
 * 500 characters of composition, dimensions, roll counts and package lines —
 * while the VED types «Нетканый материал». Plain similarity divides by the
 * UNION of both trigram sets, so a good short name inside a long paragraph
 * scores near zero and every suggestion in the system would have been
 * refused by its own threshold. `word_similarity` asks the question actually
 * being asked: does the typed name appear, as a run, inside the declaration?
 * (Its `<%` operator is the one gin_trgm_ops indexes.)
 *
 * Filtered to the exact code inside one batch — the composite index carries
 * both halves. For DONA goods with a known per-piece weight the score blends
 * in weight closeness, his own rule: two rows under one code called the same
 * thing are told apart by what one piece weighs.
 */
async function queryCandidates(
  batchId: string,
  input: SuggestInput,
  /** null when the typed name is too short to score — see the caller. */
  needle: string | null,
  limit: number,
): Promise<{ rows: ImportBazaRow[]; total: number }> {
  const wantWeight =
    input.unit === 'dona' &&
    input.weightPerUnitKg !== null &&
    input.weightPerUnitKg !== undefined &&
    Number.isFinite(input.weightPerUnitKg) &&
    input.weightPerUnitKg > 0;
  const w = wantWeight ? Number(input.weightPerUnitKg) : 0;

  // A needle of null scores nothing — the ordering falls back to what is
  // knowable without a name, and every row still carries `nameSim` 0 so the
  // AUTO-fill's threshold can never be met by accident.
  const sim = needle === null ? sql`0::real` : sql`word_similarity(${needle}, r.name_norm)`;

  const rows = await db.execute<{
    id: string;
    name: string;
    unit: ImportUnit;
    price_per_unit_usd: string;
    weight_per_unit_kg: string | null;
    declared_at: string | null;
    sender: string | null;
    name_sim: number;
    score: number;
    total: number;
  }>(sql`
    SELECT r.id::text AS id,
           r.name,
           r.unit,
           r.price_per_unit_usd,
           r.weight_per_unit_kg,
           r.declared_at::text AS declared_at,
           r.sender,
           ${sim} AS name_sim,
           CASE
             WHEN ${wantWeight} AND r.weight_per_unit_kg IS NOT NULL
               THEN 0.7 * ${sim}
                  + 0.3 * (1 - LEAST(1, abs(${w}::numeric - r.weight_per_unit_kg)
                                        / GREATEST(${w}::numeric, 0.01)))
             ELSE ${sim}
           END AS score,
           -- The count rides the same scan: the screen must be able to say
           -- «200 declarations · the 50 closest» rather than imply that the
           -- page it shows is the whole file.
           count(*) OVER () ::int AS total
      FROM customs_import_rows r
     WHERE r.batch_id = ${batchId}::uuid
       AND r.tnved_code = ${input.tnvedCode}
     ORDER BY (r.unit = ${input.unit}) DESC, score DESC, r.declared_at DESC NULLS LAST
     LIMIT ${limit}
  `);

  const total = Number(rows[0]?.total ?? 0);
  const mapped = rows.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    basis: BASIS_FOR_UNIT[r.unit],
    pricePerUnitUsd: Number(r.price_per_unit_usd),
    weightPerUnitKg: r.weight_per_unit_kg === null ? null : Number(r.weight_per_unit_kg),
    declaredAt: r.declared_at,
    sender: r.sender,
    nameSim: Number(r.name_sim),
    score: Number(r.score),
    unitMatches: r.unit === input.unit,
  }));
  return { rows: mapped, total };
}

/**
 * One import row by id, verified against the code it claims to price.
 *
 * The picker posts an id, and an id from a form is a claim: it must exist,
 * belong to a READY batch and carry the SAME code as the row it would fill.
 * A hand-posted foreign id must not stamp somebody else's price with our
 * provenance mark (the id-teleport family — #864's lesson, one table over).
 */
export async function importRowForCode(
  rowId: string,
  tnvedCode: string,
): Promise<ImportBazaRow | null> {
  const rows = await db.execute<{
    id: string;
    name: string;
    unit: ImportUnit;
    price_per_unit_usd: string;
    weight_per_unit_kg: string | null;
    declared_at: string | null;
    sender: string | null;
  }>(sql`
    SELECT r.id::text AS id, r.name, r.unit, r.price_per_unit_usd,
           r.weight_per_unit_kg, r.declared_at::text AS declared_at, r.sender
      FROM customs_import_rows r
      JOIN customs_import_batches b ON b.id = r.batch_id
     WHERE r.id = ${rowId}::bigint
       AND r.tnved_code = ${tnvedCode}
       AND b.status = 'ready'
     LIMIT 1
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    basis: BASIS_FOR_UNIT[r.unit],
    pricePerUnitUsd: Number(r.price_per_unit_usd),
    weightPerUnitKg: r.weight_per_unit_kg === null ? null : Number(r.weight_per_unit_kg),
    declaredAt: r.declared_at,
    sender: r.sender,
    nameSim: 1,
    score: 1,
    unitMatches: true,
  };
}
