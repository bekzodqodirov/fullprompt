/**
 * The SHAPES of the yo'lkira-tarifi split (docs/YOLKIRA-TAQSIMOT.md), and
 * nothing else — no value, no import that is not a type. The `'use client'`
 * cost panel imports these with `import type`, so they must never pull the
 * database into the browser bundle (#276); every VALUE the panel needs has a
 * named pure home of its own (`./engine`, `./freight-split`,
 * `./freight-errors`). Fenced in `tests/unit/freight-wire.test.ts`.
 */

/** One carton of a bill's base, as the split reads it (`boxMeasures`). */
export interface BoxMeasure {
  boxId: string;
  clientId: string | null;
  clientCode: string | null;
  receiptId: string;
  receiptNumber: string | null;
  unclaimedMarking: string | null;
  lotId: string;
  lotLetter: string | null;
  lotSeq: number;
  /** The lot's goods (his 2b: a lot row must say WHICH goods — yostiq or kafel). */
  productNameRu: string | null;
  productNameZh: string;
  dimsMode: string;
  boxLengthCm: number | null;
  boxWidthCm: number | null;
  boxHeightCm: number | null;
  /** numeric(12,3) as the database prints it — exact, never a float. */
  boxWeightKg: string | null;
  boxCount: number;
  /** numeric(12,3) and numeric(12,4) as printed. */
  totalWeightKg: string;
  totalVolumeM3: string;
  /** Today's figures for the OLD bases (totals ÷ box_count), unchanged. */
  weightKg: number;
  volumeM3: number;
}

/** One band of a frozen copy — what the bill was split by, as of its date. */
export interface FreightBandCopy {
  min: number;
  /** Inclusive; null = the open top row. */
  max: number | null;
  price: number;
  perKg: boolean;
}

/** A bill's frozen tariff column (`cost_entry_tariffs`, his 3a). */
export interface FreightCopy {
  /**
   * The truck's origin at save — provenance only since his 1a (2026-10-15:
   * one column for every truck). It no longer chooses the column.
   */
  warehouseId: string;
  zone: string;
  /** The newest effective date among the copied rows. */
  tariffFrom: string;
  /** His rule 6's «1 kub uchun 10 kg», frozen per bill. */
  lightBelow: number;
  bands: FreightBandCopy[];
}
export type FreightCopyDraft = FreightCopy;

/** What a column lacks, decided once (`columnProblem`). */
export type ColumnProblem =
  | { kind: 'unpriced' }
  | { kind: 'gap'; from: number; to: number | null }
  | { kind: 'overlap'; at: number };

/**
 * One LOT of a bill's base (his 2b, 2026-10-15: «har bir tovar o'z zichligi
 * bilan») — what a held line names and what a split row is built from. The
 * client fields are only for drawing the lot under its client.
 */
export interface LotIdentity {
  lotId: string;
  receiptId: string;
  receiptNumber: string | null;
  /** `c:<client>`, or `r:<receipt>` for an unclaimed prixod — the roll-up key. */
  clientKey: string;
  /** The client code, or the unclaimed prixod's marking / number. */
  clientLabel: string;
  /** `GS777-A` — the marking or code with the lot letter. */
  label: string;
  /** The lot's goods name (ru, else zh). */
  goods: string;
}

export interface HeldLot extends LotIdentity {
  m3: number;
  kg: number;
  /** The whole kg/m³ every screen prints; null when the measure is missing. */
  density: number | null;
}

/** Why a freight bill was saved and NOT split (his rule 6 and its kin). */
export type FreightHeld =
  | { reason: 'cargo'; measureMissing: HeldLot[]; tooLight: HeldLot[] }
  | { reason: 'copy_missing' | 'copy_invalid' | 'on_customs' };

/** One LOT, priced on the copy by its OWN density (his 2b). */
export interface PricedLot extends LotIdentity {
  /** `l:<lotId>`. */
  key: string;
  m3: number;
  kg: number;
  density: number;
  band: FreightBandCopy;
  /** True when the lot sat below the lowest floor and took the lowest band. */
  clamped: boolean;
  /** List rate per m³ (per-kg bands: price × the lot's kg/m³). Unrounded. */
  ratePerM3: number;
  /** Tariff value of the lot aboard = rate × its m³ on this truck. Unrounded. */
  value: number;
  /** value ÷ Σvalue over the bill, 0..1. */
  share: number;
}

/** What `recomputeEntry` (and the pool behind it) decided about one bill. */
export type RecomputeVerdict =
  | { kind: 'split' }
  | { kind: 'nothing' }
  | { kind: 'held'; held: FreightHeld }
  | { kind: 'unconverted' };

/** Which cost types the panel preselects freight for, and which are customs. */
export interface TypeFlags {
  freightTypeIds: string[];
  customsTypeIds: string[];
}

/**
 * A band as a page may send it: the price only under money sight (review of
 * the round — `ratePerM3` was stripped while the band carried the same number
 * to every VED's and logist's browser in the page payload).
 */
export interface BandView {
  min: number;
  max: number | null;
  perKg: boolean;
  price?: number;
}

/** One lot as the browser draws it (money only under full sight). */
export interface LotView extends LotIdentity {
  /** `l:<lotId>`. */
  key: string;
  m3: number;
  density: number;
  band: BandView;
  share: number;
  ratePerM3?: number;
}

/**
 * One client's lots summed — computed ONCE (`rollupClients`) so the preview,
 * the fold, the Narx line and the re-basis preview cannot add it up four ways
 * (#513). `share` = Σ of its lots' shares.
 */
export interface ClientRollup {
  /** `c:<client>` / `r:<receipt>`. */
  key: string;
  label: string;
  m3: number;
  share: number;
  /** Its lots' keys, in display order. */
  lotKeys: string[];
}

export type SplitView =
  | { kind: 'split'; lots: LotView[]; clients: ClientRollup[] }
  | { kind: 'held'; held: FreightHeld }
  | { kind: 'nothing' };

/** One version of the column (one effective date) as the panel holds it. */
export interface FreightVersion {
  from: string;
  /** copyDigest of this version's draft — what the save compares (M6). */
  digest: string;
  problem: ColumnProblem | { kind: 'not_finite' } | null;
  split: SplitView | null;
}

/** Everything the cost panel needs to offer, preview and explain freight. */
export type FreightOffer =
  | { status: 'server_behind'; typeFlags: TypeFlags }
  | {
      status: 'ready';
      /** His 1a: the ONE column every truck is split by (`freightSplitZone()`). */
      zone: string;
      money: boolean;
      mayFixTariff: boolean;
      typeFlags: TypeFlags;
      /** The zone's FIRST effective date — before it the column is unpriced. */
      firstFrom: string | null;
      /** Newest first, at most 20; only the newest few carry a `split` (payload). */
      versions: FreightVersion[];
    };

/** The ⚠ a save hands back when the bill was written but not split. */
export interface UnsplitView {
  held: FreightHeld;
}

/** A saved freight bill's explanation on its row. */
export interface FreightRowView {
  /** The COPY's own column (a bill frozen on another column before 1a keeps it, 3a). */
  zone: string;
  tariffFrom: string;
  /** The bill has NO share on any box (held, empty, or a lagging split). */
  unsplit: boolean;
  /** What its own copy says now: split rows, held, or no cargo. */
  view: SplitView | null;
  /** Per LOT key (`l:<lotId>`), the cents the allocations actually hold (money sight). */
  allocatedUsd?: Record<string, number>;
  /** The bill's dollars (money sight) — what a lot's «hisobning N %» on the Narx tab divides by. */
  amountUsd?: number;
}

/** The re-basis door's first press: who moves how much, before anything is written. */
export interface RebasePreview {
  entryId: string;
  fromBasis: string;
  toBasis: string;
  seen: string;
  money: boolean;
  unconverted: boolean;
  rows: {
    key: string;
    label: string;
    beforePct: number;
    afterPct: number;
    beforeUsd?: number;
    afterUsd?: number;
  }[];
  /**
   * A freight target's after state PER LOT (his 2b) — a client spans bands
   * now. The split arm only: a held after-state lives in `held` alone, said
   * once (judge J17). Built by `splitView` and nothing else, so the price
   * rides only to a money reader (J5).
   */
  split?: { lots: LotView[]; clients: ClientRollup[] };
  /** Its dollars per lot key, to the cent, by the same rule as the rows (money sight). */
  afterLotCents?: Record<string, number>;
  /** The after state when it would be HELD (shown, and allowed). */
  held?: FreightHeld;
  /** The target lands the bill on NO carton over a base that has cartons (no such measure). */
  nowhere?: boolean;
  column?: { zone: string; tariffFrom: string; previousZone: string | null };
}
