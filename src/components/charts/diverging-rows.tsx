import Link from 'next/link';
import { usd } from './format';
import { SERIES_BG } from './legend';

/**
 * The Balans as a bridge: what we HOLD grows right, what we OWE grows left, on
 * ONE dollar scale, and the last row is the net. The zero sits where the two
 * sides need it — at maxOwe / (maxOwe + maxHave) of the lane — so the larger
 * side gets the room instead of both halves squeezing to the smaller one.
 * Each row is a link to the screen that produced it, so the figure can be
 * checked there (#513).
 */
export interface DivergingRow {
  key: string;
  label: string;
  /** Signed: + we hold / are owed, − we owe. */
  value: number;
  href: string;
  note?: string;
  testid?: string;
}

export function DivergingRows({
  rows,
  net,
  testid,
}: {
  rows: DivergingRow[];
  net: { label: string; value: number; href: string };
  testid?: string;
}) {
  const maxHave = Math.max(0, ...rows.map((row) => row.value), net.value);
  const maxOwe = Math.max(0, ...rows.map((row) => -row.value), -net.value);
  const span = maxHave + maxOwe || 1;
  const zero = (maxOwe / span) * 100;
  const bar = (value: number) =>
    value >= 0
      ? { left: `${zero}%`, width: `${(value / span) * 100}%` }
      : { left: `${zero - (-value / span) * 100}%`, width: `${(-value / span) * 100}%` };

  return (
    <div className="space-y-0.5" data-testid={testid}>
      {rows.map((row) => (
        <Row key={row.key} row={row} zero={zero} bar={bar} />
      ))}
      <div className="border-t border-line pt-1">
        <Row
          row={{ key: 'net', label: net.label, value: net.value, href: net.href, testid: 'dash-balance-net' }}
          bold
          zero={zero}
          bar={bar}
        />
      </div>
    </div>
  );
}

function Row({
  row,
  bold,
  zero,
  bar,
}: {
  row: DivergingRow;
  bold?: boolean;
  zero: number;
  bar: (value: number) => { left: string; width: string };
}) {
  return (
    <Link
      href={row.href}
      data-testid={row.testid}
      className="-mx-1 block rounded-lg px-1 py-1 hover:bg-surface-sunken"
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className={`min-w-0 truncate text-xs ${bold ? 'font-bold text-ink-900' : 'text-ink-700'}`}>
          {row.label}
          {row.note && <span className="ml-1 text-bad">⚠ {row.note}</span>}
        </span>
        <span
          data-value
          className={`whitespace-nowrap font-mono text-xs tabular-nums ${bold ? 'font-bold' : 'font-semibold'} ${
            bold ? (row.value < 0 ? 'text-bad' : 'text-good') : 'text-ink-900'
          }`}
        >
          {row.value > 0 && !bold ? '+' : ''}
          {usd(row.value)}
        </span>
      </span>
      <span className="relative mt-1 block h-2">
        <span className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${zero}%` }} />
        {Math.abs(row.value) > 0.5 && (
          <span
            className={`absolute inset-y-0 ${
              bold ? SERIES_BG.strong : row.value >= 0 ? `rounded-r ${SERIES_BG.in}` : `rounded-l ${SERIES_BG.out}`
            } ${bold ? 'rounded' : ''}`}
            style={bar(row.value)}
          />
        )}
      </span>
    </Link>
  );
}
