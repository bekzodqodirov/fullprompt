import { SERIES_BG, type SeriesKey } from './legend';

/**
 * A part-to-whole bar: debt by age, cargo by where it stands. Segments are
 * separated by the card's own surface (a 2 px gap, never a stroke), carry no
 * text inside (a label that does not fit is worse than none), and each is a
 * tooltip target. A zero segment is not drawn; an all-zero bar is an empty
 * track rather than a divide-by-zero.
 */
export function StackBar({
  parts,
  height = 'h-3',
  testid,
}: {
  parts: { key: SeriesKey; value: number; tip?: string }[];
  height?: 'h-1.5' | 'h-3';
  testid?: string;
}) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  return (
    <div className={`flex ${height} gap-0.5 overflow-hidden rounded-full bg-surface-sunken`} data-testid={testid}>
      {total > 0 &&
        parts
          .filter((part) => part.value > 0)
          .map((part, i) => (
            <span
              key={`${part.key}-${i}`}
              data-tip={part.tip}
              className={`h-full ${SERIES_BG[part.key]}`}
              style={{ width: `${(part.value / total) * 100}%` }}
            />
          ))}
    </div>
  );
}
