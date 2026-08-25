/**
 * Which boxes of a receipt a CORRECTION may act on, and which forbid it.
 *
 * Voiding a receipt, moving it to another warehouse and returning unclaimed
 * cargo to its sender all ask the same question and all asked it the same
 * wrong way: «is every box still in_stock», thrown as `box_not_in_stock` on
 * the first that is not. The rule behind that is right — cargo that has been
 * loaded, has departed or has been handed to the client is resolved by the
 * load/unload/issue machinery and not by a correction — but it is stated over
 * the wrong set, because two of the eight box states are TERMINAL.
 *
 * A `void` box (the surplus from a 20 → 18 miscount correction, or a receipt
 * voided earlier) and a `lost` box (a crushed carton, with a person's written
 * reason) do not come back to a shelf by themselves: no scan, no unload and no
 * correction moves them. A manager may restore a `lost` box deliberately —
 * `boxes/status.ts`, the one door back, which refuses when the receipt has
 * been voided in the meantime — and that is a decision made with the loss's
 * own history on screen, not something a correction does on the way past.
 * Blocking a correction on one is therefore not «resolve it first», it is FOR EVER
 * — one lost carton out of twenty and that receipt can never be voided, never
 * be moved to the right warehouse, and unclaimed cargo can never be returned
 * to the sender who has turned up to collect it.
 *
 * They are equally not to be acted ON. Re-voiding a `void` box is noise;
 * overwriting a `lost` box would erase a recorded loss to tidy up a
 * correction, which is the worse of the two mistakes.
 *
 * So: three sets, and the caller uses all three. `act` is corrected, `blocked`
 * refuses, and the terminal rest is simply left alone.
 */
export const TERMINAL_BOX_STATUSES = ['void', 'lost'] as const;

export function isTerminalBox(status: string): boolean {
  return (TERMINAL_BOX_STATUSES as readonly string[]).includes(status);
}

export function splitForCorrection<T extends { status: string }>(
  boxRows: T[],
): { act: T[]; blocked: T[] } {
  const act: T[] = [];
  const blocked: T[] = [];
  for (const box of boxRows) {
    if (box.status === 'in_stock') act.push(box);
    else if (!isTerminalBox(box.status)) blocked.push(box);
  }
  return { act, blocked };
}
