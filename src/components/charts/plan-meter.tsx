import type { PlanProgress } from '@/modules/wms/reports/dashboard-math';

/**
 * The monthly plan as a thin meter (owner 5a). The track is a lighter step of
 * the fill's own hue, so the whole bar reads as one thing; a 1px tick marks
 * where the CALENDAR is — the fill behind the tick is the only urgency the
 * meter has, and the sentence beside it says so in words (never colour alone).
 */
export function PlanMeter({ progress, className = '' }: { progress: PlanProgress; className?: string }) {
  const fill = Math.min(100, Math.max(0, progress.pct));
  return (
    <div className={`relative h-1 rounded-full bg-viz-in/15 ${className}`} aria-hidden>
      <div className="h-full rounded-full bg-viz-in" style={{ width: `${fill}%` }} />
      <span
        className="absolute -top-0.5 h-2 w-px bg-ink-500"
        style={{ left: `${Math.round(progress.pace * 1000) / 10}%` }}
      />
    </div>
  );
}
