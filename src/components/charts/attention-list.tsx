import Link from 'next/link';
import type { AttentionLevel } from '@/modules/wms/reports/dashboard-math';
import { Icon, type IconName } from '@/components/ui/icon';

/**
 * «E'tibor kerak»: one ranked list of what needs a person, each row a sentence
 * with its money in it and a link to where it is fixed. The dot repeats the
 * word's tone for a glance down the list — it never carries the meaning alone.
 */

// Literal maps: Tailwind compiles only classes it can see.
const DOT: Record<AttentionLevel, string> = { bad: 'bg-bad', warn: 'bg-warn', info: 'bg-ink-400' };

export interface AttentionRow {
  kind: string;
  level: AttentionLevel;
  text: string;
  value?: string;
  href: string;
}

function Row({ row }: { row: AttentionRow }) {
  return (
    <li>
      <Link
        href={row.href}
        data-testid={`att-${row.kind}`}
        className="-mx-1 flex min-h-11 items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-surface-sunken"
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[row.level]}`} />
        <span className="line-clamp-2 min-w-0 flex-1 text-sm text-ink-900">{row.text}</span>
        {row.value && (
          <span className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums">{row.value}</span>
        )}
        <span aria-hidden className="text-ink-400">
          ›
        </span>
      </Link>
    </li>
  );
}

export function AttentionList({
  visible,
  hidden,
  moreLabel,
  emptyLabel,
}: {
  visible: AttentionRow[];
  hidden: AttentionRow[];
  moreLabel: string;
  emptyLabel: string;
}) {
  if (visible.length === 0) {
    // The sentence carries its own ✅ in every bundle (`dashboard.allClear`),
    // so a prefix here printed «✅ ✅ …» (judge O23).
    return <p className="text-sm font-semibold text-good">{emptyLabel}</p>;
  }
  return (
    <>
      <ul className="grid gap-x-6 lg:grid-cols-2">
        {visible.map((row) => (
          <Row key={row.kind} row={row} />
        ))}
      </ul>
      {hidden.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs font-semibold text-brand-700">{moreLabel}</summary>
          <ul className="mt-1 grid gap-x-6 lg:grid-cols-2">
            {hidden.map((row) => (
              <Row key={row.kind} row={row} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/*
 * The same rows as CARDS: the top of the ranked list, drawn where the eye
 * lands right under the headline figures. Each card is ONE link (no tip — a
 * tap navigates), and its severity is said three times so no reader depends
 * on colour: the icon's shape (a triangle for work, a clock for information),
 * the level WORD, and the tint. The level stays the three-word union — a
 * calm state is not a fourth level (widening it touches every
 * `Record<AttentionLevel, …>`, #591, judge O24); it is the one card drawn
 * when there is nothing to rank.
 */

// Literal maps: Tailwind compiles only classes it can see.
const CARD_BG: Record<AttentionLevel, string> = {
  bad: 'bg-bad/10',
  warn: 'bg-warn/10',
  info: 'bg-surface-sunken',
};
const ICON_BG: Record<AttentionLevel, string> = {
  bad: 'bg-bad',
  warn: 'bg-warn',
  info: 'bg-ink-400',
};
const WORD: Record<AttentionLevel, string> = {
  bad: 'text-bad',
  warn: 'text-warn',
  info: 'text-ink-500',
};
const ICON: Record<AttentionLevel, IconName> = {
  bad: 'alert',
  warn: 'alert',
  info: 'clock',
};

export function AttentionCards({
  rows,
  levelLabel,
  emptyLabel,
  testid,
}: {
  rows: AttentionRow[];
  /** The level WORD per level, from the caller's literal `t()` map (#163). */
  levelLabel: Record<AttentionLevel, string>;
  /** Already carries its own ✅ — printed as given. */
  emptyLabel: string;
  testid?: string;
}) {
  if (rows.length === 0) {
    return (
      <div data-testid={testid}>
        <p className="rounded-xl bg-good/10 p-3 text-sm font-semibold text-good" data-testid="att-clear">
          {emptyLabel}
        </p>
      </div>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid={testid}>
      {rows.map((row) => (
        <li key={row.kind} className="min-w-0">
          <Link
            href={row.href}
            data-testid={`att-${row.kind}`}
            data-level={row.level}
            className={`flex h-full min-h-11 min-w-0 items-start gap-2.5 rounded-xl p-3 hover:ring-1 hover:ring-line-strong ${CARD_BG[row.level]}`}
          >
            <span
              aria-hidden
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ICON_BG[row.level]}`}
            >
              <Icon name={ICON[row.level]} className="h-4 w-4 text-surface-raised" strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className={`text-2xs font-bold uppercase tracking-wide ${WORD[row.level]}`}>
                  {levelLabel[row.level]}
                </span>
                {row.value && (
                  <span className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums text-ink-900">
                    {row.value}
                  </span>
                )}
              </span>
              {/* No `block` beside line-clamp: Tailwind emits `display` after
                  `line-clamp`, and the clamp needs its own -webkit-box. */}
              <span className="mt-0.5 line-clamp-3 text-sm leading-snug text-ink-900">{row.text}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
