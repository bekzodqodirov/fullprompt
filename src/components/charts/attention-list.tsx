import Link from 'next/link';
import type { AttentionLevel } from '@/modules/wms/reports/dashboard-math';

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
    return <p className="text-sm font-semibold text-good">✅ {emptyLabel}</p>;
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
