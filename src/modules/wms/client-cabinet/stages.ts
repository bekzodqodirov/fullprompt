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
 * TWO of his nine are one stage here, and it is worth knowing why. «ozbga
 * kirdi» and «rastamojka» are the same recorded fact — the truck is in
 * Uzbekistan and the cargo has not been handed to the warehouse yet — because
 * nothing in the system stamps the moment a declaration clears. Splitting them
 * would mean inventing a button somebody has to remember to press, and a stage
 * that only advances when a human remembers is a stage that lies. Stated to
 * the owner: the two can be split the day he wants a “rastamojka tugadi” tap
 * on the batch card.
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
  /** In Uzbekistan, paperwork not finished. */
  'in_uz',
  /** Cleared and waiting for the customer. */
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
    // The pin the logist puts on the batch card outranks the schedule: a
    // person who has seen the truck in Uzbekistan knows more than we do.
    if (batch?.checkpointKey === 'in_uz') return 'in_uz';
    if (batch?.destCountry === 'CN') return 'cn_transit';
    /*
     * The truck has reached its Uzbek destination and this box has not been
     * scanned off it yet. That IS «ozbga kirdi / rastamojka» — the cargo is
     * here, the paperwork is not done — and it is the stage he asked for by
     * name. The Chinese leg deliberately gets no equivalent: his ladder has
     * no rung for «the truck reached Kashgar but nothing is unloaded», and a
     * box still sitting on a lorry is honestly described as being on the road.
     */
    if (batch && ['arrived', 'unloaded', 'closed'].includes(batch.status)) return 'in_uz';
    if (batch?.originCountry === 'UZ') return 'in_uz';
    return 'export_transit';
  }

  // Standing somewhere. `in_stock` in Uzbekistan means it landed at a
  // warehouse that does not hand cargo straight over — still ours, not yet
  // theirs.
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
