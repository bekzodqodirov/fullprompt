import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * One headline figure: label, value, a comparison line and a small visual.
 * The whole tile is a link to the report that produced the value, so the two
 * can never disagree without the owner seeing both (#513). Nothing inside
 * carries a tooltip — a tap on a link navigates, so a tip there would be
 * unreachable on a phone; every sub-value is printed.
 *
 * The value is compact and never wraps (a nowrap figure wider than a
 * half-width tile at 360 px would rescale the page, #400): «$124.5K».
 */
export function StatTile({
  href,
  label,
  value,
  valueTone = 'text-ink-900',
  lines,
  visual,
  footer,
  testid,
}: {
  href: string;
  label: string;
  value: ReactNode;
  valueTone?: 'text-ink-900' | 'text-bad' | 'text-good';
  lines?: ReactNode[];
  visual?: ReactNode;
  /** Rendered OUTSIDE the link (a second link must never nest inside the first). */
  footer?: ReactNode;
  testid?: string;
}) {
  return (
    <div className="card flex min-w-0 flex-col !p-0" data-testid={testid}>
      <Link href={href} className="block min-w-0 flex-1 rounded-[inherit] p-3 hover:bg-surface-sunken">
        <p className="truncate text-2xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
        <p className={`mt-0.5 whitespace-nowrap font-mono text-xl font-bold tabular-nums ${valueTone}`}>{value}</p>
        {lines?.map((line, i) => (
          <p key={i} className="truncate text-2xs text-ink-500">
            {line}
          </p>
        ))}
        <div className="mt-1.5">{visual ?? <div className="h-6" aria-hidden />}</div>
      </Link>
      {footer && <div className="border-t border-line px-3 py-1.5 text-2xs">{footer}</div>}
    </div>
  );
}
