import type { ReactNode } from 'react';

/**
 * Every chart's table twin: the same numbers as rows, one tap away. A tooltip
 * only enhances; this is where a value is reachable without a pointer, on a
 * phone, for a screen reader and for somebody who wants the cents.
 */
export function TableTwin({
  summary,
  head,
  rows,
  testid,
}: {
  summary: string;
  head: ReactNode[];
  rows: ReactNode[][];
  testid?: string;
}) {
  return (
    <details className="group mt-2" data-testid={testid}>
      <summary className="cursor-pointer text-xs font-semibold text-brand-700">{summary}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-max text-xs">
          <thead>
            <tr className="border-b border-line text-ink-500">
              {head.map((cell, i) => (
                <th key={i} className={`px-1.5 py-1 font-semibold ${i === 0 ? 'text-left' : 'text-right'}`}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-line last:border-0">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={`whitespace-nowrap px-1.5 py-1 ${i === 0 ? 'text-left' : 'text-right font-mono tabular-nums'}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
