'use client';

import { useActionState } from 'react';
import { bulkAnnulAction, type BulkAnnulState } from './actions';

export interface BulkRow {
  id: string;
  number: string;
  receivedAt: string;
  boxCount: number;
  volumeM3: string;
  weightKg: string;
  goods: string;
}

/** Checkbox rows + ONE reason + a confirm that names the count. */
export function BulkAnnulForm({
  rows,
  labels,
}: {
  rows: BulkRow[];
  labels: {
    reason: string;
    button: string;
    confirm: string;
    done: string;
    refused: string;
    errors: Record<string, string>;
  };
}) {
  const [state, formAction, pending] = useActionState<BulkAnnulState, FormData>(
    bulkAnnulAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const form = e.currentTarget;
        const n = form.querySelectorAll('input[name="receiptIds"]:checked').length;
        if (n === 0 || !window.confirm(labels.confirm.replace('{n}', String(n)))) {
          e.preventDefault();
        }
      }}
      className="space-y-2"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="py-1.5 pr-2">
                  <input
                    type="checkbox"
                    name="receiptIds"
                    value={row.id}
                    className="h-5 w-5"
                    data-testid="bulk-annul-pick"
                  />
                </td>
                <td className="py-1.5 pr-2 font-mono font-semibold">
                  <a className="underline" href={`/receipts/${row.id}`}>
                    {row.number}
                  </a>
                </td>
                <td className="py-1.5 pr-2 whitespace-nowrap text-ink-500">{row.receivedAt}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  📦 {row.boxCount} · {row.volumeM3} m³ · {row.weightKg} kg
                </td>
                <td className="max-w-[14rem] truncate py-1.5 text-ink-500">{row.goods}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <input
        name="reason"
        className="input"
        placeholder={labels.reason}
        required
        minLength={3}
        maxLength={500}
        data-testid="bulk-annul-reason"
      />
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {labels.errors[state.error] ?? state.error}
        </p>
      )}
      {state.done !== undefined && (
        <p className="text-sm font-semibold" data-testid="bulk-annul-result">
          <span className="text-good">✓ {labels.done}: {state.done}</span>
          {state.refused && state.refused.length > 0 && (
            <span className="text-bad">
              {' '}
              · {labels.refused}:{' '}
              {state.refused
                .map((r) => `${rows.find((x) => x.id === r.id)?.number ?? r.id} (${labels.errors[r.code] ?? r.code})`)
                .join(', ')}
            </span>
          )}
        </p>
      )}
      <button type="submit" className="btn-danger w-full disabled:opacity-60" disabled={pending} data-testid="bulk-annul-go">
        {labels.button}
      </button>
    </form>
  );
}
