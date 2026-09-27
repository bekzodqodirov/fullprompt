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
 *
 * Three additive options, each off by default so every existing tile renders
 * exactly as before:
 *  - `size: 'lg'` for a headline row: text-2xl, which still fits «−$1.24M» in
 *    a half-width tile at 360 px (7 characters of mono ≈ 101 px of 134).
 *  - `tag` after the label — a `ScopeTag` naming what the figure covers. The
 *    row WRAPS rather than squeezing the label: a tag beside «TUSHUM» in a
 *    half tile would otherwise truncate the one word that says what it is.
 *  - `exact` — the unrounded figure as `data-value` on the value itself, so a
 *    test can compare the tile with the report its link opens (#513) without
 *    parsing «$124.5K» back into a number.
 */
// A literal map: Tailwind compiles only classes it can see.
const VALUE_SIZE: Record<'md' | 'lg', string> = {
  md: 'text-xl',
  lg: 'text-2xl',
};

export function StatTile({
  href,
  label,
  value,
  valueTone = 'text-ink-900',
  lines,
  visual,
  footer,
  testid,
  size = 'md',
  tag,
  exact,
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
  size?: 'md' | 'lg';
  /** Printed after the label, inside the link — plain text (a ScopeTag), never a link. */
  tag?: ReactNode;
  /** The exact value behind the compact one, rendered as `data-value`. */
  exact?: string;
}) {
  const labelText = (
    <p className="text-2xs font-semibold uppercase leading-tight tracking-wide text-ink-500">{label}</p>
  );
  return (
    <div className="card flex min-w-0 flex-col !p-0" data-testid={testid}>
      <Link href={href} className="block min-w-0 flex-1 rounded-[inherit] p-3 hover:bg-surface-sunken">
        {tag ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {labelText}
            {tag}
          </div>
        ) : (
          labelText
        )}
        <p
          data-value={exact}
          className={`mt-0.5 whitespace-nowrap font-mono font-bold tabular-nums ${VALUE_SIZE[size]} ${valueTone}`}
        >
          {value}
        </p>
        {lines?.map((line, i) => (
          // Wraps rather than truncates: at 360 px a truncated line hid the
          // 60+ day debt, the number the tile exists to show (screenshot).
          <p key={i} className="break-words text-2xs leading-snug text-ink-500">
            {line}
          </p>
        ))}
        <div className="mt-1.5">{visual ?? <div className="h-6" aria-hidden />}</div>
      </Link>
      {footer && <div className="border-t border-line px-3 py-1.5 text-2xs">{footer}</div>}
    </div>
  );
}
