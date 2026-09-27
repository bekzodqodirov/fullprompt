/**
 * «Is this code a carton the office counts, not the phone?» — decided on the
 * phone from the snapshot, so the operator hears it at once and offline,
 * before the server says the same thing (0112, Q4/Q8). Browser-safe: no
 * imports.
 *
 * The snapshot names each count-only lot with its LABEL and the codes of its
 * cartons that are NOT otherwise in the snapshot (`siblings` — an origin
 * sibling of a lot counted onto the truck, say). A carton that IS in the
 * snapshot is matched through its lot id instead.
 */
export interface CountOnlyLot {
  lotId: string;
  mode: 'counted' | 'qrless';
  label: string;
  siblings: string[];
}

export function countOnlyLotOf(
  code: string,
  boxes: readonly { shortCode: string; lotId: string; crateCode?: string | null }[],
  lots: readonly CountOnlyLot[] | undefined,
): CountOnlyLot | null {
  if (!lots || lots.length === 0) return null;
  const c = code.trim().toUpperCase();
  if (!c || /^CR-/.test(c)) return null;
  const box = boxes.find((b) => b.shortCode.toUpperCase() === c);
  if (box) {
    // A crated carton is scanned as its crate, which is never count-only.
    if (box.crateCode) return null;
    return lots.find((l) => l.lotId === box.lotId) ?? null;
  }
  return lots.find((l) => l.siblings.some((s) => s.toUpperCase() === c)) ?? null;
}
