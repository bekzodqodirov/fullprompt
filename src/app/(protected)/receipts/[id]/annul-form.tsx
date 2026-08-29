'use client';

import { useActionState, useState } from 'react';
import { annulReceiptAction, type AnnulState } from './actions';

export interface AnnulLabels {
  open: string;
  title: string;
  boxes: string;
  costs: string;
  unconverted: string;
  batches: string;
  willRetire: string;
  pendingPlans: string;
  clientMoney: string;
  reason: string;
  button: string;
  confirm: string;
  done: string;
  errors: Record<string, string>;
}

export interface AnnulPreviewProps {
  boxLine: string;
  costLine: string;
  unconvertedCount: number;
  batchLines: { code: string; status: string; willRetire: boolean }[];
  pendingPlanCount: number;
  clientLiveTxCount: number;
  clientLedgerHref: string | null;
}

/**
 * The cancel-batch fold, one size up: a quiet red text button opens a PREVIEW
 * of everything one press will do, then a reason and a confirm that NAMES the
 * consequences (round 50 — never «are you sure»).
 */
export function AnnulReceiptForm({
  receiptId,
  preview,
  labels,
}: {
  receiptId: string;
  preview: AnnulPreviewProps;
  labels: AnnulLabels;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<AnnulState, FormData>(
    annulReceiptAction,
    {},
  );

  if (state.ok) {
    return (
      <section className="card space-y-1 !p-4" data-testid="annul-done">
        <p className="font-semibold text-good">
          ✓ {labels.done}
          {state.repaired ? ' (↻)' : ''}
        </p>
        <p className="text-sm text-ink-500">
          {labels.boxes}: {state.boxesVoided ?? 0} · {labels.costs}: {state.costEntriesVoided ?? 0}
          {state.batchesRetired?.length ? ` · ${labels.willRetire}: ${state.batchesRetired.join(', ')}` : ''}
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="text-sm font-semibold text-bad underline"
        data-testid="annul-open"
        onClick={() => setOpen(true)}
      >
        {labels.open}
      </button>
    );
  }

  return (
    <section className="card space-y-3 border-bad/40 !p-4" data-testid="annul-panel">
      <h2 className="font-bold text-bad">{labels.title}</h2>
      <ul className="space-y-1 text-sm">
        <li data-testid="annul-preview-boxes">📦 {preview.boxLine}</li>
        <li data-testid="annul-preview-costs">
          💸 {preview.costLine}
          {preview.unconvertedCount > 0 && (
            <span className="text-warn"> · ⚠ {labels.unconverted}: {preview.unconvertedCount}</span>
          )}
        </li>
        {preview.batchLines.length > 0 && (
          <li data-testid="annul-preview-batches">
            🚚 {labels.batches}:{' '}
            {preview.batchLines
              .map((b) => `${b.code} (${b.status}${b.willRetire ? ` → ${labels.willRetire}` : ''})`)
              .join(', ')}
          </li>
        )}
        {preview.pendingPlanCount > 0 && (
          <li className="font-semibold text-warn">⚠ {labels.pendingPlans}: {preview.pendingPlanCount}</li>
        )}
        <li data-testid="annul-preview-money">
          💰 {labels.clientMoney}: {preview.clientLiveTxCount}
          {preview.clientLedgerHref && preview.clientLiveTxCount > 0 && (
            <>
              {' '}
              <a className="underline" href={preview.clientLedgerHref}>
                →
              </a>
            </>
          )}
        </li>
      </ul>
      <form
        action={formAction}
        onSubmit={(e) => {
          if (!window.confirm(labels.confirm)) e.preventDefault();
        }}
        className="space-y-2"
      >
        <input type="hidden" name="receiptId" value={receiptId} />
        <input
          name="reason"
          className="input"
          placeholder={labels.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={500}
          data-testid="annul-reason"
        />
        {state.error && (
          <p role="alert" className="text-sm font-semibold text-bad" data-testid="annul-error">
            {labels.errors[state.error] ?? state.error}
          </p>
        )}
        <button
          type="submit"
          className="btn-danger w-full disabled:opacity-60"
          disabled={pending || reason.trim().length < 3}
          data-testid="annul-confirm"
        >
          {labels.button}
        </button>
      </form>
    </section>
  );
}
