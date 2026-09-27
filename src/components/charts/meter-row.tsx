import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * ONE row shape for a list of things that each have a share: a truck's road
 * travelled, a funnel stage's cards. Label left, value right, a thin bar under
 * both, an optional sentence under that — so the trucks card and the funnel
 * card read as one grammar and a person learns the row once.
 *
 * The rows are usually LINKS, and a link carries no tooltip (a tap navigates,
 * so a tip there is unreachable on a phone): every value is PRINTED, and the
 * list is its own table, like `WarehouseFillRows` and `DivergingRows`.
 *
 * `pct: null` draws NO bar at all — «we cannot say» (a truck with no schedule,
 * a route we do not model) must not look like «zero». The colour is the
 * caller's, from its own literal map (Tailwind compiles only what it sees);
 * this component never picks one. The label truncates and the value never
 * wraps: a nowrap row wider than 360 px rescales the whole phone page (#400).
 */
export function MeterRow({
  href,
  label,
  value,
  pct,
  barClass,
  sub,
  testid,
}: {
  href?: string;
  label: ReactNode;
  value: ReactNode;
  /** 0-100; null = no bar (unknown is not empty). */
  pct: number | null;
  /** A literal class from the caller's map, e.g. `bg-viz-in`. */
  barClass: string;
  sub?: ReactNode;
  testid?: string;
}) {
  const width = meterWidth(pct);
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-ink-700">{label}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-ink-900">
          {value}
        </span>
      </span>
      {width !== null && (
        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-sunken" data-meter="">
          <span className={`block h-full rounded-full ${barClass}`} style={{ width: `${width}%` }} />
        </span>
      )}
      {sub && <span className="mt-0.5 block text-2xs leading-snug text-ink-500">{sub}</span>}
    </>
  );
  return href ? (
    <Link href={href} data-testid={testid} className="-mx-1 block rounded-lg px-1 py-1 hover:bg-surface-sunken">
      {body}
    </Link>
  ) : (
    <div data-testid={testid} className="py-1">
      {body}
    </div>
  );
}

/**
 * The drawn width: null stays null (no bar), anything else is clamped into
 * the track, and a real but tiny share gets 2 % so it is visible as «some» —
 * the fill rows' rule. Exactly 0 draws an empty track: 0 is an answer.
 */
export function meterWidth(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  return Math.min(100, Math.max(2, pct));
}
