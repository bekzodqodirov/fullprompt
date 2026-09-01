/**
 * The whole law in one cell — a MAX row printed as its percentage alone
 * loses the floor, which on light goods IS the duty. One home, two readers
 * (the table's group header and the sealed panel's line), so the two can
 * never print the same rate differently.
 */
export function dutyText(r: {
  dutyPct: number | null;
  dutyMode: 'advalor' | 'specific' | 'max' | 'plus';
  dutySpecific: number | null;
  dutyUnit: string | null;
}): string {
  const pct = r.dutyPct === null ? '—' : `${r.dutyPct}%`;
  if (r.dutyMode === 'advalor') return pct;
  const spec = `${r.dutySpecific ?? '—'} $/${r.dutyUnit ?? '—'}`;
  if (r.dutyMode === 'specific') return spec;
  if (r.dutyMode === 'max') return `${pct} / min ${spec}`;
  return `${pct} + ${spec}`;
}
