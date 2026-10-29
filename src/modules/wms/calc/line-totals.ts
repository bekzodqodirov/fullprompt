/**
 * The shipment's cubic metres, SUMMED from its goods lines — his 2.7 b
 * («umumiy kub qatorlardan yig‘ilsin», docs/SAKKIZ-R2.md K2). A leaf with no
 * imports: the collector, the landing, the workspace and the bot's reply all
 * ask it, and a rule four modules restate is four rules (#513).
 *
 * Only VOLUME. A line's kilograms are NETTO (the baza and the per-kg floor
 * are declared on it) and the truck's are BRUTTO, so a Σ of line kilos is a
 * different number from the one freight is priced on — that total is ASKED,
 * never added up (judge MR-8's reason, one module over).
 */

/**
 * Half-up to the thousandth, on the DECIMAL the number means — the scale of
 * every m³ column (numeric(12,3)).
 *
 * `Math.round(n * 1000) / 1000` rounds the binary float, and 0.1 + 0.2 is
 * 0.30000000000000004. The technique is `pricing.ts`'s `roundTo` (the
 * 2026-10-09 audit's): `toPrecision(15)` recovers the decimal the arithmetic
 * meant and the shift is done on the decimal STRING. Restated here rather
 * than imported because this file must stay a leaf.
 */
export function roundM3(n: number): number {
  if (!Number.isFinite(n)) return n;
  const [mantissa, exponent] = n.toPrecision(15).split('e');
  const shifted = Number(`${mantissa}e${Number(exponent ?? 0) + 3}`);
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
  const back = Number(`${rounded}e-3`);
  return Number.isFinite(back) ? back : rounded / 1000;
}

const positive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

/**
 * Σ of the lines' cubic metres — ALL or NOTHING: null when there are no lines
 * or any line lacks a positive, finite volume (a partial Σ looks like a total;
 * `groupPerUnit`'s and the reconcile's `covered` rule). Rounded half-up to 3
 * decimals (numeric(12,3)).
 */
export function linesVolumeM3(lines: readonly { volumeM3: number | null }[]): number | null {
  if (lines.length === 0) return null;
  // The whole rule: one line without a figure makes the Σ a smaller number
  // wearing the shipment's name, and freight would be priced on it.
  if (!lines.every((l) => positive(l.volumeM3))) return null;
  let sum = 0;
  for (const l of lines) if (positive(l.volumeM3)) sum += l.volumeM3;
  return roundM3(sum);
}

/**
 * Did the stored m³ come from the lines? (K13 — `Workspace.volumeFromLines`
 * asks exactly this.)
 *
 * Decided at READ time from the numbers, never stored: the stored total
 * equals the Σ of the lines at the column's own scale. A total the seller
 * typed that happens to equal the Σ reads «qatorlardan» too, and that is
 * accepted — the label then tells the truth about the numbers
 * (docs/SAKKIZ-R2.md §0.1(6)).
 */
export function volumeIsLinesSum(
  storedM3: number | null,
  lines: readonly { volumeM3: number | null }[],
): boolean {
  if (storedM3 === null || !Number.isFinite(storedM3)) return false;
  const sum = linesVolumeM3(lines);
  return sum !== null && sum === roundM3(storedM3);
}
