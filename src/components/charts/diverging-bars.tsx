import Link from 'next/link';
import type { ReactNode } from 'react';
import { signedUsd } from './format';
import { SERIES_BG } from './legend';

/**
 * Profit per truck: a centre zero, profit grows right, a loss grows left, on
 * ONE symmetric scale. A row with no bar (an unpriced truck) carries a chip
 * instead — drawn as a bar it would read as a loss that is only a price
 * nobody has typed yet.
 */
export interface DivergingBar {
  key: string;
  code: string;
  href: string;
  /** Null = no bar (the chip carries the row). */
  value: number | null;
  sub: ReactNode;
  chip?: ReactNode;
}

export function DivergingBars({ rows, testid }: { rows: DivergingBar[]; testid?: string }) {
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.value ?? 0)));
  return (
    <ul className="space-y-1" data-testid={testid}>
      {rows.map((row) => {
        const value = row.value ?? 0;
        const width = `${(Math.abs(value) / max) * 50}%`;
        return (
          <li key={row.key} className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={row.href} className="w-20 shrink-0 truncate font-mono text-xs font-bold text-brand-700">
                {row.code}
              </Link>
              {row.value === null ? (
                <span className="min-w-0 flex-1">{row.chip}</span>
              ) : (
                <>
                  <span className="relative h-3.5 min-w-0 flex-1">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                    <span
                      className={`absolute inset-y-0 ${
                        value >= 0 ? `left-1/2 rounded-r-[3px] ${SERIES_BG.in}` : `right-1/2 rounded-l-[3px] ${SERIES_BG.out}`
                      }`}
                      style={{ width }}
                    />
                  </span>
                  <span
                    className={`w-20 shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums ${
                      value < 0 ? 'text-bad' : 'text-ink-900'
                    }`}
                  >
                    {signedUsd(value)}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 pl-[5.5rem] text-2xs text-ink-500">
              {row.sub}
              {row.value !== null && row.chip}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
