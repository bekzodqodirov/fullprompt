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
  /** The origin warehouse the column was read from. */
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

export interface HeldLot {
  lotId: string;
  receiptId: string;
  label: string;
  m3: number;
  kg: number;
  /** The whole kg/m³ every screen prints; null when the measure is missing. */
  density: number | null;
}

export interface HeldGroup {
  key: string;
  label: string;
  m3: number;
  kg: number;
  density: number;
  /** Lightest first. */
  lots: HeldLot[];
}

/** Why a freight bill was saved and NOT split (his rule 6 and its kin). */
export type FreightHeld =
  | { reason: 'cargo'; measureMissing: HeldLot[]; tooLight: HeldGroup[] }
  | { reason: 'copy_missing' | 'copy_invalid' | 'on_customs' };

/** One client group, priced on the copy. */
export interface PricedGroup {
  key: string;
  label: string;
  m3: number;
  kg: number;
  density: number;
  band: FreightBandCopy;
  /** True when the group sat below the lowest floor and took the lowest band. */
  clamped: boolean;
  /** List rate per m³ (per-kg bands: price × density). Unrounded. */
  ratePerM3: number;
  /** Tariff value of the group = rate × Σm³. Unrounded. */
  value: number;
  /** value ÷ Σvalue over the bill, 0..1. */
  share: number;
  /** Lots of a group that split whose OWN density is under the limit (ⓘ). */
  lightLots: HeldLot[];
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

/** One client group as the browser draws it (money only under full sight). */
export interface GroupView {
  key: string;
  label: string;
  m3: number;
  density: number;
  band: FreightBandCopy;
  share: number;
  ratePerM3?: number;
  lightLots: HeldLot[];
}

export type SplitView =
  | { kind: 'split'; groups: GroupView[] }
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

export interface WhLabel {
  id: string;
  code: string;
  name: string;
}

/** Everything the cost panel needs to offer, preview and explain freight. */
export type FreightOffer =
  | { status: 'server_behind'; typeFlags: TypeFlags }
  | { status: 'no_column'; warehouse: WhLabel; mayFixColumn: boolean; typeFlags: TypeFlags }
  | {
      status: 'ready';
      warehouse: WhLabel;
      zone: string;
      money: boolean;
      mayFixColumn: boolean;
      mayFixTariff: boolean;
      typeFlags: TypeFlags;
      /** The zone's FIRST effective date — before it the column is unpriced. */
      firstFrom: string | null;
      /** Newest first, at most 20. */
      versions: FreightVersion[];
    };

/** The ⚠ a save hands back when the bill was written but not split. */
export interface UnsplitView {
  held: FreightHeld;
}

/** A saved freight bill's explanation on its row. */
export interface FreightRowView {
  warehouseCode: string;
  zone: string;
  tariffFrom: string;
  /** The bill has NO share on any box (held, empty, or a lagging split). */
  unsplit: boolean;
  /** What its own copy says now: split rows, held, or no cargo. */
  view: SplitView | null;
  /** Per group key, the cents the allocations actually hold (money sight). */
  allocatedUsd?: Record<string, number>;
}

/** The re-basis door's first press: who moves how much, before anything is written. */
export interface RebasePreview {
  entryId: string;
  fromBasis: string;
  toBasis: string;
  seen: string;
  money: boolean;
  unconverted: boolean;
  rows: { key: string; label: string; beforePct: number; afterPct: number; beforeUsd?: number; afterUsd?: number }[];
  /** The after state when it would be HELD (shown, and allowed). */
  held?: FreightHeld;
  column?: { warehouseCode: string; zone: string; tariffFrom: string; previousZone: string | null };
}
