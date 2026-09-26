/**
 * Money and number formatting for the dashboard's charts and tiles — one home,
 * so a tile, its chart and the home card print the same figure the same way.
 *
 * The sign goes BEFORE the dollar: a drained kassa reads «−$1,875», never
 * «$-1,875» (the admin home's rule, moved here). The minus is U+2212, the
 * typographic one, so it has the width of a plus and a column of signed
 * values stays aligned.
 */

const MINUS = '−';

/** Whole dollars with thousands commas: «$12,400», «−$1,875». */
export function usd(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? MINUS : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

/** An explicit sign on both sides of zero, for deltas: «+$4,200», «−$900». */
export function signedUsd(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '$0';
  return `${rounded < 0 ? MINUS : '+'}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

/**
 * Compact dollars for a tile or an axis tick: «$950», «$12.4K», «$1.24M».
 * At most seven characters (sign included) for anything under $10B, which is
 * what lets a half-width tile at 360 px keep its value on one line.
 */
export function compactUsd(value: number): string {
  const sign = value < 0 ? MINUS : '';
  const abs = Math.abs(value);
  if (abs < 1_000) return `${sign}$${Math.round(abs)}`;
  if (abs < 10_000) return `${sign}$${trim((abs / 1_000).toFixed(2))}K`;
  if (abs < 1_000_000) return `${sign}$${trim((abs / 1_000).toFixed(1))}K`;
  if (abs < 10_000_000) return `${sign}$${trim((abs / 1_000_000).toFixed(2))}M`;
  if (abs < 1_000_000_000) return `${sign}$${trim((abs / 1_000_000).toFixed(1))}M`;
  return `${sign}$${trim((abs / 1_000_000_000).toFixed(2))}B`;
}

/** «12.40» → «12.4», «3.00» → «3»: a trailing zero is noise at display size. */
function trim(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** A plain count or measure with commas: «1,240». */
export function num(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

/** m³ as a person writes it: one decimal under 100, whole above. */
export function m3(value: number): string {
  return value < 100 ? num(Math.round(value * 10) / 10, 1) : num(Math.round(value));
}

/** A percentage with one decimal under 10, whole above: «4.5%», «27%». */
export function pct(value: number): string {
  const abs = Math.abs(value);
  const text = abs < 10 ? trim(abs.toFixed(1)) : String(Math.round(abs));
  return `${value < 0 ? MINUS : ''}${text}%`;
}
