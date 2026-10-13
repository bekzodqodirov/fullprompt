import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import type { BazaBasis } from '../calc/pricing';
import { basisConflicts } from '../calc/basis';
import { normalizeName, type ImportUnit } from './import-parse';
import { newestReadyBatchId } from './import-service';
import { candidateStatement } from './import-stats-sql';
import {
  FEW,
  QUARTILE_INDEX,
  jsonRows,
  seriesFromRaw,
  type ExemplarKey,
  type PriceExemplar,
  type RawSeries,
  type SeriesStats,
} from './import-stats-math';

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
export const BASIS_FOR_UNIT: Record<ImportUnit, BazaBasis> = {
  kg: 'kg',
  dona: 'unit',
  m3: 'm3',
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
export const UNIT_FOR_BASIS: Record<BazaBasis, ImportUnit> = {
  kg: 'kg',
  unit: 'dona',
  m3: 'm3',
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
 * pieces first where the law is counting pieces, and cubic metres LAST (a
 * line's kub is usually a packing-list volume with the packaging in it, and
 * his file holds m³ declarations at the edges only). A row stating no figure
 * at all cannot be valued, and gets no suggestion.
 *
 * And above all of it, the VED's own CHOICE (0125, his 18a): a row whose
 * basis a person picked is answered in that unit and in no other — a fill
 * that quietly re-priced a chosen «$/kg» row per dona would undo the one
 * thing he asked the select to do. A chosen unit the law cannot hold (a pair
 * unit on a juft/litr/m² code) answers NOTHING: the row is already named as
 * a conflict, and a fill must not put a price on it.
 *
 * Every parameter is REQUIRED so the compiler names every caller: an optional
 * `chosen` fails OPEN, and the fills run AFTER the save's measure pass —
 * which is safe only because this function never offers an extended unit
 * (m²/juft/litr) the measure pass did not already ask the row for: one the
 * law pins, or one the VED chose (`tests/unit/customs-import-parse.test.ts`).
 */
export function unitsForRow(input: {
  dutyUnit: string | null | undefined;
  chosen: BazaBasis | null;
  hasWeight: boolean;
  hasQuantity: boolean;
  hasVolume: boolean;
  /**
   * A pair the row STATES (2026-10-09): the seller's «120 m²» on a code whose
   * law pins no unit. The row's figure is m², so a per-piece or per-kg
   * declaration would price a number nobody stated — the import fill used to
   * hand «120 m²» of tiles a per-dona price (audit). Required, like the rest.
   */
  statedPair: 'm2' | 'juft' | 'litr' | null;
}): ImportUnit[] {
  const u = input.dutyUnit;
  if (input.chosen !== null) {
    return basisConflicts(u, input.chosen) ? [] : [UNIT_FOR_BASIS[input.chosen]];
  }
  if (u === 'm2' || u === 'juft' || u === 'litr') return [u];
  if (u === 'kg') return ['kg'];
  if (input.statedPair !== null && u !== 'dona' && u !== '1000_dona' && u !== 'sm3') {
    return [input.statedPair];
  }
  const kg: ImportUnit[] = input.hasWeight ? ['kg'] : [];
  const dona: ImportUnit[] = input.hasQuantity ? ['dona'] : [];
  const m3: ImportUnit[] = input.hasVolume ? ['m3'] : [];
  return u === 'dona' || u === '1000_dona' || u === 'sm3'
    ? [...dona, ...kg, ...m3]
    : [...kg, ...dona, ...m3];
}

export interface ImportBazaRow {
  id: string;
  name: string;
  unit: ImportUnit;
  basis: BazaBasis;
  pricePerUnitUsd: number;
  weightPerUnitKg: number | null;
  declaredAt: string | null;
  sender: string | null;
  /** The declaration's country as the file writes it («156-КИТАЙ») —
   * display only: the list and the auto-fill read every origin (§9). */
  originCountry: string | null;
  /** 0..1 — how close the file's name is to the one the VED typed. */
  nameSim: number;
  /** The rank the ordering used: nameSim, or the weight-blended score. */
  score: number;
  /** Is this row's unit one the row being priced accepts? Only a match may auto-fill. */
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
  /**
   * C1's second series — the name-matched declarations (China only, D3),
   * per file unit — computed only for the 📥 dialog (`named: true`), riding
   * the same similarity scan as the list. Absent in every other mode: the
   * auto-fill must not pay for an aggregate it never reads.
   */
  named?: Partial<Record<ImportUnit, SeriesStats>>;
  /** 'short_name': the typed name is under MIN_NEEDLE, so «what this name
   * finds» is not a question the file can answer (its list is just the
   * newest rows). */
  namedState?: 'ok' | 'short_name';
  /** The threshold the named series and the auto-fill both used — ONE read. */
  minSim?: number;
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

export interface SuggestInput {
  tnvedCode: string;
  name: string;
  /**
   * The units the ROW accepts — `unitsForRow`'s answer, every member and not
   * only the first (0125). A candidate in any of them ranks first and counts
   * as a match; the per-piece weight re-rank (his «donada har bir tovarni
   * og'irligiga qaraymiz») applies whenever dona is among them, which a
   * first-only ranking would have dropped on every advalor row that states a
   * weight. The auto-fill asks one unit at a time, because there the ORDER is
   * the preference.
   */
  units: ImportUnit[];
  /** kg per piece, when the request row states both a weight and a count. */
  weightPerUnitKg?: number | null;
}

/**
 * Candidates for ONE row. The batch id is passed in by the batched caller so
 * a hundred-row save does not ask «which import is newest» a hundred times.
 */
export async function suggestImportBaza(
  input: SuggestInput,
  opts: { batchId?: string | null; minSim?: number; picker?: boolean; named?: true } = {},
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
  // The named series exists only in the dialog, and only for a name that
  // can score (D4) — a short name's fifty «candidates» are the newest rows,
  // and plotting them as «what this name finds» would lie.
  const dialog = opts.picker === true && opts.named === true;
  const named = dialog && usable;
  const readMinSim = async () =>
    opts.minSim ?? Number((await getSetting('import_baza_min_sim')) ?? MIN_SIM_DEFAULT);
  // Read BEFORE the query in that mode — on the pool, never inside a tx
  // (#714) — so the series and the auto threshold are ONE number.
  const earlyMinSim = named ? await readMinSim() : undefined;
  const { rows, total, namedSeries } = await queryCandidates(
    batchId,
    input,
    usable ? needle : null,
    limit,
    earlyMinSim !== undefined ? { minSim: earlyMinSim } : undefined,
  );
  const candidates = rows.slice(0, limit);
  const namedPart: Pick<ImportBazaSuggestion, 'named' | 'namedState'> = dialog
    ? usable
      ? { named: namedSeries ?? {}, namedState: 'ok' }
      : { namedState: 'short_name' }
    : {};
  if (!usable) return { auto: null, candidates, batchId, total, ...namedPart };

  const minSim = earlyMinSim ?? (await readMinSim());
  const best = candidates[0];
  // Auto-fill needs BOTH: a name we believe, and the right unit. A per-kg
  // price landing on a per-dona row is off by the weight of the goods.
  const auto = best && best.unitMatches && best.nameSim >= minSim ? best : null;
  return { auto, candidates, batchId, total, ...namedPart, ...(named ? { minSim } : {}) };
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
  /** The dialog's name-matched series, riding the same scan (D4). */
  named?: { minSim: number },
): Promise<{ rows: ImportBazaRow[]; total: number; namedSeries?: Partial<Record<ImportUnit, SeriesStats>> }> {
  // The statement is built by a PURE function (import-stats-sql.ts) so a
  // unit test can read what each mode pays — the auto-fill's statement must
  // carry no aggregate at all.
  const rows = await db.execute<{
    id: string;
    name: string;
    unit: ImportUnit;
    price_per_unit_usd: string;
    weight_per_unit_kg: string | null;
    declared_at: string | null;
    sender: string | null;
    origin_country: string | null;
    name_sim: number;
    score: number;
    total: number;
    named_q?: unknown;
    named_ex?: unknown;
  }>(candidateStatement(batchId, input, needle, limit, named));

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
    originCountry: r.origin_country ?? null,
    nameSim: Number(r.name_sim),
    score: Number(r.score),
    unitMatches: input.units.includes(r.unit),
  }));
  if (!named) return { rows: mapped, total };
  return {
    rows: mapped,
    total,
    namedSeries: namedSeriesOf(
      jsonRows<RawSeries & { unit: ImportUnit }>(rows[0]?.named_q),
      jsonRows<NamedExemplarRow>(rows[0]?.named_ex),
    ),
  };
}

/** One declaration at a named quartile, as the candidate statement's
 * `named_ex` subquery hands it back. */
interface NamedExemplarRow {
  unit: ImportUnit;
  price: string;
  id: string;
  name: string;
  declared_at: string | null;
  sender: string | null;
  origin_country: string | null;
  w: string | null;
}

/** The named series per unit, each quartile matched to its real row. */
function namedSeriesOf(
  series: (RawSeries & { unit: ImportUnit })[],
  exemplars: NamedExemplarRow[],
): Partial<Record<ImportUnit, SeriesStats>> {
  const out: Partial<Record<ImportUnit, SeriesStats>> = {};
  for (const raw of series) {
    const ex: Partial<Record<ExemplarKey, PriceExemplar | null>> = {};
    const ladder = raw.ladder ?? [];
    for (const key of ['p25', 'p50', 'p75'] as const) {
      const price = ladder[QUARTILE_INDEX[key]];
      if (price === undefined || raw.n < FEW) continue;
      const hit = exemplars.find((e) => e.unit === raw.unit && Number(e.price) === Number(price));
      ex[key] = hit
        ? {
            id: hit.id,
            name: hit.name,
            declaredAt: hit.declared_at,
            sender: hit.sender,
            originCountry: hit.origin_country,
            weightPerUnitKg: hit.w === null ? null : Number(hit.w),
            pricePerUnitUsd: Number(hit.price),
          }
        : null;
    }
    out[raw.unit] = seriesFromRaw(raw, ex);
  }
  return out;
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
    origin_country: string | null;
  }>(sql`
    SELECT r.id::text AS id, r.name, r.unit, r.price_per_unit_usd,
           r.weight_per_unit_kg, r.declared_at::text AS declared_at, r.sender,
           r.origin_country
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
    originCountry: r.origin_country,
    nameSim: 1,
    score: 1,
    unitMatches: true,
  };
}
