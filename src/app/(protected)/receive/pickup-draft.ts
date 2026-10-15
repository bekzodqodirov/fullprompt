/**
 * The receive draft's factory-trip fields and the three rules that move them
 * (0133, docs/ZAVOD-YOPISH.md §3) — pure, so a test can hold them to what
 * the judges found: a deleted lot must take its line out of the answer, a
 * mis-picked client must not answer another client's lines, and the post
 * carries line ids only when there is a trip and the operator did not say
 * «the rest of the same cargo».
 */
export interface PickupDraftFields {
  pickupStopId: string | null;
  pickupLabel?: string;
  pickupLines?: { id: string; goods: string }[];
  pickupLineIds?: string[];
  pickupOwnerClientId?: string | null;
  pickupExtra?: boolean;
  pickupDeclined?: string[];
}

/** Everything the factory link carries, cleared at once (✕, a client switch, the last tick). */
export const NO_PICKUP = {
  pickupStopId: null,
  pickupLabel: undefined,
  pickupLines: undefined,
  pickupLineIds: undefined,
  pickupOwnerClientId: undefined,
  pickupExtra: undefined,
} as const satisfies Partial<PickupDraftFields>;

/**
 * A client change keeps the factory link only when its lines are MARKING
 * lines (the operator received a marking under the client he knows it
 * belongs to — probe S4) or the new client's own. Otherwise the link goes and
 * the door asks again for the new owner.
 */
export function keepsPickup(d: PickupDraftFields, nextClientId: string | null): boolean {
  return !d.pickupStopId || d.pickupOwnerClientId == null || d.pickupOwnerClientId === nextClientId;
}

/**
 * Delete a lot. A lot made from a factory line takes that line out of what
 * the prixod answers; the last line gone = this cargo is not that trip's, so
 * the link goes with it and the door may ask again.
 */
export function dropLotFrom<D extends PickupDraftFields & { lots: { id: string; pickupLineId?: string }[] }>(
  d: D,
  lotId: string,
): D {
  const gone = d.lots.find((l) => l.id === lotId);
  const next: D = { ...d, lots: d.lots.filter((l) => l.id !== lotId) };
  if (gone?.pickupLineId && d.pickupLineIds) {
    const ids = d.pickupLineIds.filter((id) => id !== gone.pickupLineId);
    return ids.length ? { ...next, pickupLineIds: ids } : { ...next, ...NO_PICKUP };
  }
  return next;
}

/** What the confirm posts about the trip — nothing the server would misread. */
export function postedPickupFields(d: PickupDraftFields): {
  pickupStopId: string | null;
  pickupLineIds?: string[];
  pickupExtra?: true;
  pickupDeclined?: string[];
} {
  return {
    pickupStopId: d.pickupStopId ?? null,
    // Only when there are some, so an older draft with a stop and no ticks
    // lets the server derive; never beside «the rest» (it answers nothing).
    ...(d.pickupStopId && d.pickupLineIds?.length && !d.pickupExtra ? { pickupLineIds: d.pickupLineIds } : {}),
    ...(d.pickupStopId && d.pickupExtra ? { pickupExtra: true as const } : {}),
    ...(d.pickupDeclined?.length ? { pickupDeclined: d.pickupDeclined } : {}),
  };
}
