/**
 * «01.08» for a day of this year, «01.08.2025» for any other — numeric
 * because Chromium ships no Uzbek month names (#678), and with the year only
 * where leaving it out would mislead: a January «Bu oy» is compared with LAST
 * year's January (the P&L page's rule), and «01.01 – 27.01» under a January
 * heading would read as this month.
 */
export function shortDay(day: string, today: string): string {
  const [y, m, d] = day.split('-');
  return y === today.slice(0, 4) ? `${d}.${m}` : `${d}.${m}.${y}`;
}

/** One day prints once; a range prints both ends. */
export function dayRange(from: string, to: string, today: string): string {
  return from === to ? shortDay(from, today) : `${shortDay(from, today)} – ${shortDay(to, today)}`;
}
