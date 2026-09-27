import type { PlanProgress } from '@/modules/wms/reports/dashboard-math';

/**
 * The monthly plan as a thin meter (owner 5a). The track is a lighter step of
 * the fill's own hue, so the whole bar reads as one thing; a 1px tick marks
 * where the CALENDAR is — the fill behind the tick is the only urgency the
 * meter has, and the sentence beside it says so in words (never colour alone).
 *
 * `thick` is the hero's size: the same meter at 10 px under a 48 px figure,
 * where the 4 px one read as a rule line. The tick grows with it so it still
 * stands proud of the track.
 */

// Literal maps: Tailwind compiles only classes it can see.
const TRACK: Record<'thin' | 'thick', string> = {
  thin: 'h-1',
  thick: 'h-2.5',
};
const TICK: Record<'thin' | 'thick', string> = {
  thin: '-top-0.5 h-2 w-px',
  thick: '-top-0.5 h-3.5 w-0.5 -translate-x-1/2',
};

export function PlanMeter({
  progress,
  className = '',
  thick = false,
}: {
  progress: PlanProgress;
  className?: string;
  thick?: boolean;
}) {
  const fill = Math.min(100, Math.max(0, progress.pct));
  const size = thick ? 'thick' : 'thin';
  return (
    <div className={`relative rounded-full bg-viz-in/15 ${TRACK[size]} ${className}`} aria-hidden>
      <div className="h-full rounded-full bg-viz-in" style={{ width: `${fill}%` }} />
      <span
        className={`absolute bg-ink-500 ${TICK[size]}`}
        style={{ left: `${Math.round(progress.pace * 1000) / 10}%` }}
      />
    </div>
  );
}
