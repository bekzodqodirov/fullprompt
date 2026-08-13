/**
 * Where the customer's cargo is, on the road the customer knows.
 *
 * The owner wrote the ladder himself: «htoyda qabul → htoy sklatdan yolga
 * chiqdi → htoy qirgiz chegara sklatda → sklatdan yuklandi eksport bolti →
 * transitda → ozbga kirdi → rastamojka → olib ketishingizga tayyor → olib
 * ketdingiz».
 *
 * Nothing had to be configured to answer it. `warehouses.country` and
 * `warehouses.type` already say WHERE («qirgiz chegara sklat» is his Kashgar
 * row, type `hub`, and it is the only one), `boxes.status` says WHAT, and the
 * batch its origin, its destination and the operator's manual position pin.
 * Deriving the ladder from those means it stays right when he opens a second
 * hub or renames a warehouse.
 *
 * «ozbga kirdi» and «rastamojka» were ONE rung at first, because nothing in
 * the system stamped the moment a declaration cleared and a stage that
 * advances only when a human remembers is a stage that lies. That was stated
 * to the owner with the cost, and he took the trade: «ha rastamojka tugadi
 * tugmasini qo'sh». So the batch card now carries the tap, `customs_cleared_at`
 * carries the answer, and the two rungs are separate — with the honest
 * default intact, since NULL means «nobody has said» and leaves the cargo on
 * «kirdi» rather than claiming either way.
 *
 * Pure — no database, no clock — so the whole ladder is testable by table.
 */

export const CARGO_STAGES = [
  /** Received into a Chinese warehouse of ours. */
  'cn_warehouse',
  /** Being loaded there, onto the truck that takes it to the hub. */
  'cn_loading',
  /** On the road inside China. */
  'cn_transit',
  /** Standing at the collection warehouse near the border (Kashgar). */
  'hub',
  /** Being loaded there onto the export truck — his «eksport bo'ldi». */
  'hub_loading',
  /** On the export road. */
  'export_transit',
  /** In Uzbekistan, the declaration not yet cleared (or nobody has said). */
  'in_uz',
  /** Cleared — the operator pressed «rastamojka tugadi» on the truck. */
  'customs_done',
  /** Off the truck, on our shelf, the customer may come for it. */
  'ready',
  /** Handed over. */
  'issued',
] as const;

export type CargoStage = (typeof CARGO_STAGES)[number];

/** Where a box physically stands. Null on both when it is on a truck. */
export interface StagePlace {
  country: string | null;
  type: string | null;
}

/** The truck a box is riding, as far as this question needs to know it. */
export interface StageBatch {
  originCountry: string | null;
  destCountry: string | null;
  status: string;
  checkpointKey: string | null;
  /** Has somebody pressed «rastamojka tugadi»? Absent = nobody has said. */
  customsCleared: boolean;
}

const LOADING = new Set(['planned', 'loading']);

/**
 * One box → one rung.
 *
 * The order of the tests is the design: the box's own status decides first
 * (issued and ready are facts nobody argues with), then the truck, then the
 * place. A box with an unknown truck lands on `export_transit`, whose wording
 * is deliberately just «yo'lda» — true of any road — and which is drawn with
 * no date, because a date needs a destination we do not have.
 */
export function cargoStage(
  status: string,
  place: StagePlace,
  batch: StageBatch | null,
): CargoStage {
  if (status === 'issued') return 'issued';
  if (status === 'ready_for_pickup') return 'ready';

  if (status === 'in_transit') {
    /*
     * Three ways to know the truck is in Uzbekistan, and the customs stamp
     * decides between the two rungs for all of them at once — so a declaration
     * cleared while the truck is still driving to Tashkent shows as cleared,
     * which is what actually happens.
     *
     * The pin the logist puts on the batch card outranks the schedule: a
     * person who has seen the truck in Uzbekistan knows more than we do. The
     * `arrived`/`unloaded` branch is the truck standing at its Uzbek
     * destination with this box not yet scanned off. The Chinese leg
     * deliberately gets no equivalent: his ladder has no rung for «the truck
     * reached Kashgar but nothing is unloaded», and a box still sitting on a
     * lorry is honestly described as being on the road.
     */
    const inUzbekistan =
      batch?.checkpointKey === 'in_uz' ||
      (batch?.destCountry !== 'CN' &&
        (batch?.originCountry === 'UZ' ||
          (batch !== null && ['arrived', 'unloaded', 'closed'].includes(batch.status))));
    if (inUzbekistan) return batch?.customsCleared ? 'customs_done' : 'in_uz';
    if (batch?.destCountry === 'CN') return 'cn_transit';
    return 'export_transit';
  }

  // Standing somewhere. `in_stock` in Uzbekistan means it landed at a
  // warehouse that does not hand cargo straight over — still ours, not yet
  // theirs. No truck to read a stamp from, so it stays on the earlier rung.
  if (place.country === 'UZ') return 'in_uz';
  if (place.type === 'hub') return LOADING.has(status) ? 'hub_loading' : 'hub';
  return LOADING.has(status) ? 'cn_loading' : 'cn_warehouse';
}

/** How far along the ladder — 0-based, for drawing the timeline. */
export function stageIndex(stage: CargoStage): number {
  return CARGO_STAGES.indexOf(stage);
}

/** Does this rung mean the cargo is moving? Only these carry a date. */
export function isMovingStage(stage: CargoStage): boolean {
  return stage === 'cn_transit' || stage === 'export_transit';
}
