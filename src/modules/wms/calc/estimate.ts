import { FEW, bandBounds } from '../customs/import-stats-math';
import type { ImportUnit } from '../customs/import-parse';
import {
  customsFor,
  pricedGroupOf,
  requestCustomsFor,
  type BazaBasis,
  type CustomsBreakdown,
  type CustomsRefusalDetail,
  type CustomsResult,
  type FeeBreakdown,
  type FeeRefusal,
  type PricedGroup,
  type PricedItem,
} from './pricing';
import type { Workspace } from './workspace';

/**
 * The 📊 shadow estimate — his 2.1 b and 2.2 b (docs/SAKKIZ-R2.md §6.5).
 *
 * «Baza topilmasa, shu kodning haqiqiy deklaratsiyalari medianasi» — when no
 * row priced a baza, the MEDIAN of real declarations of the same code stands
 * in for it, and the reply prints two totals: «Aniq» over the rows that
 * priced, and «Taxminiy» once the medians fill the rest.
 *
 * PURE, and a SHADOW in the strict sense: it reads the workspace and the
 * medians and returns numbers for the chat. Nothing here can write, and
 * `estimate-wire.test.ts` fences who may even import it — the seal, the
 * offer, the price channel and «Готово» never see an estimate (§3).
 *
 * Every figure still comes out of the ENGINE: the shadow baza goes onto a
 * copy of the row and `customsFor` prices the group exactly as the screen
 * would, and «Taxminiy» is `requestCustomsFor` over those results — so the
 * kernel's own «no partial sums» decides when it exists (MR-23). The median
 * is a DECLARED price (`percentile_disc`), never an average and never the
 * model's — law 1 holds.
 */

/** Why a row got no median — one name per sentence (§2.7). */
export type MedianMiss =
  | 'short_code'
  | 'no_batch'
  | 'no_declarations'
  | 'unit_mismatch'
  | 'few'
  | 'no_piece_weight'
  | 'no_measure'
  | 'timeout'
  | 'budget'
  | 'capped';

export type RowMedian =
  | { ok: true; bazaUsd: number; basis: BazaBasis; n: number; batchEnd: string; stale: boolean }
  | { ok: false; miss: MedianMiss; n: number | null };

/** One unit's series for one code: the whole series, plus one series per per-piece band asked. */
export interface CodeMedianUnit {
  unit: ImportUnit;
  n: number;
  p50: number | null;
  bands: ReadonlyMap<string /* band key */, { n: number; p50: number | null }>;
}

/**
 * The words, keyed on the union (a miss with no sentence is a compile error).
 * `few` carries its count — «{n}» is filled by `missWords`.
 */
export const MISS_WORDS: Record<MedianMiss, string> = {
  short_code: 'kod to‘liq emas (10 xona kerak)',
  no_batch: 'bojxona fayli yuklanmagan',
  no_declarations: 'bu kodda Xitoy deklaratsiyasi yo‘q',
  unit_mismatch: 'deklaratsiyalar boshqa o‘lchovda',
  few: `faqat {n} ta deklaratsiya (kamida ${FEW} kerak)`,
  no_piece_weight: 'bir donasining og‘irligi yo‘q — dona bo‘yicha solishtirib bo‘lmadi',
  no_measure: 'qatorda soni ham, og‘irligi ham yo‘q',
  timeout: 'statistika o‘qilmadi (fayl katta)',
  budget: 'vaqt yetmadi — statistika o‘qilmadi',
  capped: 'juda ko‘p qator — taxmin qilinmadi',
};

/** A miss in words, its count filled in where it has one. */
export function missWords(miss: MedianMiss, n: number | null): string {
  return MISS_WORDS[miss].replace('{n}', String(n ?? 0));
}

/**
 * The baza basis each file unit prices — `BASIS_FOR_UNIT`'s mapping,
 * RESTATED because that one lives beside the database in import-baza.ts and
 * this file must stay pure. `estimate.test.ts` holds the two equal, so a unit
 * the file learns cannot price a row in a different basis here.
 */
export const UNIT_BASIS: Record<ImportUnit, BazaBasis> = {
  kg: 'kg',
  dona: 'unit',
  m3: 'm3',
  m2: 'm2',
  juft: 'juft',
  litr: 'litr',
};

/**
 * The band a row belongs to: his ±25 % per-piece window (`bandBounds`)
 * rendered to a stable key, or null with no per-piece weight. One home for
 * «which band», shared by the read (which asks one FILTERed series per key)
 * and the choice (which looks its row's key up) — two spellings of the key
 * would quietly read another row's band.
 */
export function bandKeyOf(perPieceKg: number | null): { key: string; lo: number; hi: number } | null {
  const b = bandBounds(perPieceKg);
  return b ? { key: `${b.lo}-${b.hi}`, lo: b.lo, hi: b.hi } : null;
}

/**
 * The choice rule: the first unit of `allowed` (`unitsForItem` order, the
 * auto-fill's own preference) whose series reaches FEW. For 'dona' only the
 * row's OWN band series counts — a 0.2 kg piece priced off 2 kg pieces is
 * the error his D5 rule exists to stop — and with no per-piece weight dona is
 * skipped rather than read whole.
 *
 * The median is the one the 📥 dialog prints as «50 % (mediana)» for that
 * row and unit (pinned by `customs-estimate.integration.test.ts`), so the
 * VED opening the row sees the very number the chat was told.
 */
export function medianForRow(input: {
  allowed: readonly ImportUnit[];
  bandKey: string | null;
  rows: readonly CodeMedianUnit[];
  batch: { endDate: string };
  staleCutoff: string;
}): RowMedian {
  if (input.allowed.length === 0) return { ok: false, miss: 'no_measure', n: null };
  if (input.rows.every((r) => r.n === 0)) return { ok: false, miss: 'no_declarations', n: 0 };

  let seen: number | null = null;
  let skippedDona = false;
  for (const unit of input.allowed) {
    if (unit === 'dona' && input.bandKey === null) {
      skippedDona = true;
      continue;
    }
    const all = input.rows.find((r) => r.unit === unit);
    if (!all || all.n === 0) continue;
    const series =
      unit === 'dona' ? (all.bands.get(input.bandKey!) ?? { n: 0, p50: null }) : { n: all.n, p50: all.p50 };
    if (series.n >= FEW && series.p50 !== null) {
      return {
        ok: true,
        bazaUsd: series.p50,
        basis: UNIT_BASIS[unit],
        n: series.n,
        batchEnd: input.batch.endDate,
        // Inclusive at the boundary day, like the workspace's own `staleFor`.
        stale: input.batch.endDate <= input.staleCutoff,
      };
    }
    seen = Math.max(seen ?? 0, series.n);
  }
  if (seen !== null) return { ok: false, miss: 'few', n: seen };
  if (skippedDona && input.rows.some((r) => r.unit === 'dona' && r.n > 0)) {
    return { ok: false, miss: 'no_piece_weight', n: null };
  }
  return { ok: false, miss: 'unit_mismatch', n: null };
}

/** A row as the engine prices it, plus the id the medians are keyed by. */
export interface EstimateItem extends PricedItem {
  id: string;
}

export interface EstimateGroup {
  id: string;
  seq: number;
  label: string;
  /** The law with the EFFECTIVE certificate (`pricedGroupOf`). */
  priced: PricedGroup;
  /** The workspace's own, exact answer for the group. */
  customs: CustomsResult;
  items: EstimateItem[];
}

export interface EstimateInput {
  groups: EstimateGroup[];
  ungroupedCount: number;
  bhmUzs: number | null;
  fxUzsPerUsd: number | null;
  feeOverrideUsd: number | null;
}

export type GroupEstimate =
  | { kind: 'exact' }
  | {
      kind: 'estimated';
      customs: CustomsBreakdown;
      items: PricedItem[];
      medians: { seq: number; n: number; stale: boolean; batchEnd: string }[];
    }
  | {
      kind: 'refused';
      customs: CustomsRefusalDetail;
      misses: { seq: number; label: string; miss: MedianMiss; n: number | null }[];
    };

export interface CustomsEstimate {
  rows: number;
  exactRows: number;
  exactUsd: number | null;
  groups: Map<string /* group id */, GroupEstimate>;
  taxminiy: { customsUsd: number; fee: FeeBreakdown } | null;
  /**
   * Why taxminiy is null — first that applies, §2.2's order. `refused_measure`
   * = a shadow refused `measure_missing` (the seller's fact); `budget` = a
   * row's median miss is `budget`/`timeout`; `refused` = any other shadow
   * refusal (the VED's).
   */
  taxminiyBlock: 'ungrouped' | 'refused_measure' | 'budget' | 'refused' | FeeRefusal | null;
}

/** The sentence after «Taxminiy: hisoblab bo‘lmadi — » (§2.2), naming whose job it is. */
export const TAXMINIY_BLOCK_WORDS: Record<
  Exclude<CustomsEstimate['taxminiyBlock'], FeeRefusal | null>,
  string
> = {
  ungrouped: 'kodsiz qator bor (VED kod qo‘yadi)',
  refused_measure: '⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, kartadagi lentaga yozing',
  budget: 'vaqt yetmadi, statistika o‘qilmadi',
  refused: '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi',
};

/**
 * ONE mapping from the workspace — through `pricedGroupOf` (the EFFECTIVE
 * certificate). Spreading a `WorkspaceGroup` carries the RAW override
 * (`hasCertificate: null` = «as the request says») into a field the engine
 * reads as a boolean, and null reads as «no certificate»: the shadow would
 * add the 5-20 % additional duty to every group that inherits a «bor».
 */
export function estimateInputOf(ws: Workspace): EstimateInput {
  return {
    groups: ws.groups.map((g) => ({
      id: g.id,
      seq: g.seq,
      label: g.label,
      priced: pricedGroupOf({
        seq: g.seq,
        label: g.label,
        tnvedCode: g.tnvedCode,
        dutyPct: g.dutyPct,
        vatPct: g.vatPct,
        feeUsd: g.feeUsd,
        dutyMode: g.dutyMode,
        dutySpecific: g.dutySpecific,
        dutyUnit: g.dutyUnit,
        excisePct: g.excisePct,
        exciseSpecific: g.exciseSpecific,
        exciseUnit: g.exciseUnit,
        effectiveCertificate: g.effectiveCertificate,
        dutyFree: g.dutyFree,
        vatFree: g.vatFree,
      }),
      customs: g.customs,
      items: g.items.map(itemOf),
    })),
    ungroupedCount: ws.ungrouped.length,
    bhmUzs: ws.bhmUzs,
    fxUzsPerUsd: ws.fxUzsPerUsd,
    feeOverrideUsd: ws.feeOverrideUsd,
  };
}

/** The engine's fields of a row — and nothing that names where a price came from. */
function itemOf(i: Workspace['groups'][number]['items'][number]): EstimateItem {
  return {
    id: i.id,
    seq: i.seq,
    label: i.label,
    quantity: i.quantity,
    weightKg: i.weightKg,
    volumeM3: i.volumeM3,
    bazaUsd: i.bazaUsd,
    bazaBasis: i.bazaBasis,
    measureUnit: i.measureUnit,
    measureQty: i.measureQty,
  };
}

/** The engine's own fields of an item — the shadow's copy carries no id. */
const priceable = (i: EstimateItem): PricedItem => ({
  seq: i.seq,
  label: i.label,
  quantity: i.quantity,
  weightKg: i.weightKg,
  volumeM3: i.volumeM3,
  bazaUsd: i.bazaUsd,
  bazaBasis: i.bazaBasis,
  measureUnit: i.measureUnit,
  measureQty: i.measureQty,
});

/**
 * The two totals (his 2.2 b) and, per group, what the chat says about it.
 *
 * - A median is put ONLY on a row with no baza at all (`bazaUsd === null`):
 *   a price somebody typed with no basis yet is still THEIR number, and the
 *   engine's refusal on it is the true answer.
 * - An exact group stays exact; every other group is priced on its shadow,
 *   by the engine, with the law it already has.
 * - «Taxminiy» is WHOLE or absent (⭐ of his Question 1): it is
 *   `requestCustomsFor` over the exact results and the shadows, so one row
 *   with no figure, one uncoded row, or a fee that cannot be made leaves it
 *   null — and `taxminiyBlock` says which, in §2.2's order.
 * - «Aniq» is the exact groups' Σ WITHOUT the declaration fee: the fee's tier
 *   depends on the whole declaration, so a fee over part of it could be in
 *   the wrong tier (MR-23's own objection, his §0.1(3)).
 */
export function estimateCustoms(
  input: EstimateInput & { medians: ReadonlyMap<string /* item id */, RowMedian> },
): CustomsEstimate {
  const groups = new Map<string, GroupEstimate>();
  const results: CustomsResult[] = [];
  let rows = input.ungroupedCount;
  let exactRows = 0;
  let exactSum = 0;
  const refusedGroups: Extract<GroupEstimate, { kind: 'refused' }>[] = [];

  for (const g of input.groups) {
    rows += g.items.length;
    if (g.customs.ok) {
      groups.set(g.id, { kind: 'exact' });
      exactRows += g.items.length;
      exactSum += g.customs.customsUsd;
      results.push(g.customs);
      continue;
    }

    const used: { seq: number; n: number; stale: boolean; batchEnd: string }[] = [];
    const shadowItems = g.items.map((i) => {
      const plain = priceable(i);
      if (i.bazaUsd !== null) return plain;
      const m = input.medians.get(i.id);
      if (!m || !m.ok) return plain;
      used.push({ seq: i.seq, n: m.n, stale: m.stale, batchEnd: m.batchEnd });
      return { ...plain, bazaUsd: m.bazaUsd, bazaBasis: m.basis };
    });
    const misses = g.items.flatMap((i) => {
      if (i.bazaUsd !== null) return [];
      const m = input.medians.get(i.id);
      return m && !m.ok ? [{ seq: i.seq, label: i.label, miss: m.miss, n: m.n }] : [];
    });

    // No median stood in for anything: the shadow IS the exact answer.
    const shadow = used.length > 0 ? customsFor(g.priced, shadowItems) : g.customs;
    results.push(shadow);
    if (shadow.ok) {
      groups.set(g.id, { kind: 'estimated', customs: shadow, items: shadowItems, medians: used });
    } else {
      const refused = { kind: 'refused' as const, customs: shadow, misses };
      groups.set(g.id, refused);
      refusedGroups.push(refused);
    }
  }

  const anyEstimated = [...groups.values()].some((g) => g.kind === 'estimated');
  const assembled = requestCustomsFor({
    customs: results,
    ungroupedCount: input.ungroupedCount,
    bhmUzs: input.bhmUzs,
    fxUzsPerUsd: input.fxUzsPerUsd,
    feeOverrideUsd: input.feeOverrideUsd,
  });
  const taxminiy =
    anyEstimated && assembled.customsUsd !== null && assembled.fee?.ok
      ? { customsUsd: assembled.customsUsd, fee: assembled.fee }
      : null;

  let taxminiyBlock: CustomsEstimate['taxminiyBlock'] = null;
  if (taxminiy === null) {
    if (input.ungroupedCount > 0) taxminiyBlock = 'ungrouped';
    else if (refusedGroups.some((r) => r.customs.reason === 'measure_missing')) taxminiyBlock = 'refused_measure';
    else if (refusedGroups.some((r) => r.misses.some((m) => m.miss === 'budget' || m.miss === 'timeout'))) {
      taxminiyBlock = 'budget';
    } else if (refusedGroups.length > 0) taxminiyBlock = 'refused';
    else if (assembled.fee && !assembled.fee.ok) taxminiyBlock = assembled.fee.reason;
  }

  return {
    rows,
    exactRows,
    exactUsd: exactRows > 0 ? round2(exactSum) : null,
    groups,
    taxminiy,
    taxminiyBlock,
  };
}

/**
 * Half-up to the cent on the decimal the number means — `pricing.ts`'s
 * `roundTo` technique (the 2026-10-09 audit's), restated because that one is
 * private to the engine: the Σ of three group figures must not land a cent
 * off the same Σ the screen would print.
 */
function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  const [mantissa, exponent] = n.toPrecision(15).split('e');
  const shifted = Number(`${mantissa}e${Number(exponent ?? 0) + 2}`);
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
  const back = Number(`${rounded}e-2`);
  return Number.isFinite(back) ? back : rounded / 100;
}
