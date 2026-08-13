/**
 * «Qaysi etap qachon bo'lgani» — the dates behind the customer's timeline.
 *
 * The owner, on the first version: «sen qilgan etaplar timeline emasku hech
 * nima korinmaydi u yerda — qaysi etap qacon nima bolganini koradgan qilish
 * kerak». He is right, and the dates were never missing from the DATABASE —
 * every carton's every move is a `box_movements` row with a timestamp — they
 * were missing from the screen. This module turns those rows into the events
 * a customer reads: received, set off, reached the border warehouse, exported,
 * entered Uzbekistan, cleared, ready.
 *
 * EVENTS, not stages, on purpose. A stage answers «where is it now» and its
 * wording is stative («yuklanmoqda»); a history line answers «what happened
 * then» and needs a completed sentence. The two loading rungs therefore have
 * no history line at all — loading is the moment between the shelf and the
 * road, and the departure line carries the fact.
 *
 * Pure — the query lives in service.ts, the decisions live here, so the whole
 * derivation is testable by table.
 */

export const JOURNEY_KEYS = [
  /** Received into our warehouse (the receipt's own movement). */
  'received',
  /** Set off toward the border hub — a departure whose destination is CN. */
  'toHub',
  /** Landed at the border hub. */
  'atHub',
  /** The export truck left — a departure whose destination is UZ. */
  'export',
  /** In Uzbekistan: the truck arrived, or the operator pinned it here. */
  'inUz',
  /** «Rastamojka tugadi» — the tap on the batch card. */
  'customs',
  /** Off the truck onto our Uzbek shelf, the customer may come. */
  'ready',
] as const;

export type JourneyKey = (typeof JOURNEY_KEYS)[number];

export interface JourneyStep {
  key: JourneyKey;
  atIso: string;
}

/** What the derivation needs to know about one movement row. */
export interface JourneyEvent {
  cause: string;
  at: Date;
  toStatus: string;
  toCountry: string | null;
  toType: string | null;
}

/** The cargo genuinely landed somewhere (round 92's arrival vocabulary). */
const ARRIVAL = new Set(['unload_scan', 'undocumented_transfer', 'found_here', 'receipt_moved']);

/**
 * One lot's movements → its dated history, oldest first.
 *
 * The EARLIEST date wins each key: a two-hundred-box lot is unloaded over an
 * hour and the honest sentence is «reached the warehouse starting here».
 * Truck-level facts that never touch `box_movements` — the operator's «in
 * Uzbekistan» pin and the customs stamp — arrive through `truck`, because the
 * paperwork happens to the LORRY while the boxes still sit on it.
 */
export function journeyFromEvents(
  events: JourneyEvent[],
  truck: { inUzAt: Date | null; customsClearedAt: Date | null } | null,
): JourneyStep[] {
  const found = new Map<JourneyKey, Date>();
  const claim = (key: JourneyKey, at: Date) => {
    const prev = found.get(key);
    if (!prev || at < prev) found.set(key, at);
  };

  for (const e of events) {
    if (e.cause === 'receipt') claim('received', e.at);
    /*
     * `batch_departed` stamps the DESTINATION warehouse the moment the truck
     * leaves (round 92's trap, used here on purpose): the destination's
     * country is what tells an internal Chinese leg from the export leg, and
     * it is written exactly once per journey.
     */
    if (e.cause === 'batch_departed') {
      if (e.toCountry === 'CN') claim('toHub', e.at);
      else if (e.toCountry === 'UZ') claim('export', e.at);
    }
    if (ARRIVAL.has(e.cause)) {
      if (e.toCountry === 'CN' && e.toType === 'hub') claim('atHub', e.at);
      if (e.toCountry === 'UZ') claim('inUz', e.at);
    }
    if (e.toStatus === 'ready_for_pickup') claim('ready', e.at);
  }

  if (truck?.inUzAt) claim('inUz', truck.inUzAt);
  if (truck?.customsClearedAt) claim('customs', truck.customsClearedAt);

  // In the LADDER's order, not strictly the clock's: two events minutes apart
  // can be written out of order by two scanners, and a history that lists
  // «entered Uzbekistan» above «exported» reads as broken however true the
  // clocks are. Within one delivery the ladder IS chronology.
  return JOURNEY_KEYS.filter((key) => found.has(key)).map((key) => ({
    key,
    atIso: found.get(key)!.toISOString(),
  }));
}
