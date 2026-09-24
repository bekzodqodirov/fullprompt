'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setCostAccountAction } from '@/app/(protected)/costs/actions';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { mergeDuplicateAction, setCostStaffAction } from './actions';

export interface QueueRow {
  id: string;
  typeName: string;
  amount: number;
  currency: string;
  amountUsd: number | null;
  costDate: string;
  note: string | null;
  enteredByName: string;
  where: { href: string; label: string } | null;
  /** A 1:1 duplicate the M4a rule found — one press merges it. */
  suggestion: { expenseId: string; label: string } | null;
}

export interface QueueOption {
  id: string;
  label: string;
}

/**
 * The accountant's three answers to «which kassa paid this?» (0101), row by
 * row: a kassa (with what left it, when the kassa speaks another currency),
 * a colleague's own pocket (their staff account — owner M1a, the accountant
 * confirms), or «this is an expense I typed a second time» (A3/M4a). The
 * merge also takes SEVERAL ticked rows against one expense, the other shape
 * the owner said exists.
 */
export function CostQueue({
  rows,
  tills,
  staff,
  expenses,
}: {
  rows: QueueRow[];
  tills: { id: string; name: string; currency: string }[];
  staff: QueueOption[];
  /** Expenses a merge may absorb, near the dates on screen. */
  expenses: QueueOption[];
}) {
  const t = useTranslations('accounting');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expenseId, setExpenseId] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const say = (res: { ok: boolean; error?: string }) => {
    setMessage(res.ok ? { ok: true, text: t('queueDone') } : { ok: false, text: queueError(res.error, t) });
    if (res.ok) router.refresh();
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (rows.length === 0) {
    return (
      <p className="card text-sm text-ink-500" data-testid="queue-empty">
        ✅ {t('queueEmpty')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {message && (
        <p role="status" className={`text-sm font-semibold ${message.ok ? 'text-good' : 'text-bad'}`}>
          {message.text}
        </p>
      )}
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          tills={tills}
          staff={staff}
          checked={picked.has(row.id)}
          onToggle={() => toggle(row.id)}
          busy={pending}
          run={(action) => start(async () => say(await action()))}
        />
      ))}

      {/* Several costs, ONE expense: the accountant's «bir nechtasini
          jamlab, bitta summa qilib» (A3). The server re-checks M4a. */}
      <div className="card sticky bottom-20 space-y-2 md:bottom-2" data-testid="merge-bar">
        <p className="text-sm font-semibold">
          🔗 {t('mergeTitle', { count: picked.size })}
        </p>
        <select
          className="input"
          aria-label={t('mergeExpense')}
          data-testid="merge-expense"
          value={expenseId}
          onChange={(e) => setExpenseId(e.target.value)}
        >
          <option value="">— {t('mergeExpense')}</option>
          {expenses.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-primary w-full disabled:opacity-50"
          data-testid="merge-submit"
          disabled={pending || picked.size === 0 || !expenseId}
          onClick={() =>
            start(async () => {
              const res = await mergeDuplicateAction({ costIds: [...picked], expenseId });
              if (res.ok) {
                setPicked(new Set());
                setExpenseId('');
              }
              say(res);
            })
          }
        >
          {t('mergeButton')}
        </button>
        <p className="text-xs text-ink-500">{t('mergeHint')}</p>
      </div>
    </div>
  );
}

function Row({
  row,
  tills,
  staff,
  checked,
  onToggle,
  busy,
  run,
}: {
  row: QueueRow;
  tills: { id: string; name: string; currency: string }[];
  staff: QueueOption[];
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  run: (action: () => Promise<{ ok: boolean; error?: string }>) => void;
}) {
  const t = useTranslations('accounting');
  const [tillId, setTillId] = useState('');
  const [tillAmount, setTillAmount] = useState('');
  const [staffId, setStaffId] = useState('');
  const till = tills.find((option) => option.id === tillId);
  const otherCurrency = till !== undefined && till.currency !== row.currency;

  return (
    <article className="card space-y-2" data-testid="queue-row">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <input
          type="checkbox"
          aria-label={t('mergePick')}
          data-testid="queue-pick"
          checked={checked}
          onChange={onToggle}
          className="h-5 w-5 shrink-0"
        />
        <span className="font-semibold">{row.typeName}</span>
        <span className="font-mono font-bold">
          {row.amount} {row.currency}
        </span>
        {row.amountUsd !== null && row.currency !== 'USD' && (
          <span className="font-mono text-xs text-ink-500">≈ ${row.amountUsd.toFixed(2)}</span>
        )}
        <span className="basis-full text-xs text-ink-500 sm:basis-auto">
          {row.costDate} · {row.enteredByName}
          {row.where && (
            <>
              {' · '}
              <Link href={row.where.href} className="text-brand-700 underline">
                {row.where.label}
              </Link>
            </>
          )}
        </span>
      </div>
      {row.note && <p className="text-xs text-ink-700 [overflow-wrap:anywhere]">{row.note}</p>}

      {row.suggestion && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-warn/10 p-2 text-sm" data-testid="queue-suggestion">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">⚠ {t('mergeSuggest', { expense: row.suggestion.label })}</span>
          <button
            type="button"
            className="btn-secondary !min-h-9"
            disabled={busy}
            onClick={() => run(() => mergeDuplicateAction({ costIds: [row.id], expenseId: row.suggestion!.expenseId }))}
          >
            🔗 {t('mergeOne')}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <select
          className="input min-w-0 flex-1"
          aria-label={t('queueTill')}
          data-testid="queue-till"
          value={tillId}
          onChange={(e) => setTillId(e.target.value)}
        >
          <option value="">🏦 {t('queueTill')}</option>
          {tills.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({option.currency})
            </option>
          ))}
        </select>
        {otherCurrency && (
          <input
            className="input !w-36"
            inputMode="decimal"
            aria-label={t('queueTillAmount', { currency: till.currency })}
            placeholder={t('queueTillAmount', { currency: till.currency })}
            data-testid="queue-till-amount"
            value={tillAmount}
            onChange={(e) => setTillAmount(e.target.value)}
          />
        )}
        <button
          type="button"
          className="btn-primary !min-h-11"
          data-testid="queue-till-save"
          disabled={busy || !tillId || (otherCurrency && !((parseTypedMoney(tillAmount) ?? 0) > 0))}
          onClick={() =>
            run(() =>
              setCostAccountAction({
                id: row.id,
                accountId: tillId,
                accountAmount: otherCurrency ? (parseTypedMoney(tillAmount) ?? undefined) : undefined,
              }),
            )
          }
        >
          {t('queueSave')}
        </button>
      </div>

      {staff.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <select
            className="input min-w-0 flex-1"
            aria-label={t('queueStaff')}
            data-testid="queue-staff"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">👤 {t('queueStaff')}</option>
            {staff.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary !min-h-11"
            data-testid="queue-staff-save"
            disabled={busy || !staffId}
            onClick={() => run(() => setCostStaffAction({ id: row.id, partnerId: staffId }))}
          >
            {t('queueSave')}
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * The refusals in words. A literal map, never a key built from the code
 * (#163): an assembled key is invisible to the i18n fence and throws at render.
 */
const QUEUE_ERRORS = {
  account_amount_required: 'queueErrTillAmount',
  account_amount_mismatch: 'queueErrTillAmount',
  account_not_found: 'queueErrTill',
  payer_conflict: 'queueErrTaken',
  cost_taken: 'queueErrTaken',
  not_candidate: 'queueErrNotCandidate',
  amount_differs: 'queueErrAmount',
  too_far_apart: 'queueErrDays',
  no_rate: 'queueErrRate',
  fx_missing: 'queueErrRate',
  not_staff: 'queueErrNotStaff',
  forbidden: 'queueErrForbidden',
  till_forbidden: 'queueErrForbidden',
} as const;

function queueError(code: string | undefined, t: (key: string) => string): string {
  const key = code ? QUEUE_ERRORS[code as keyof typeof QUEUE_ERRORS] : undefined;
  return key ? t(key) : (code ?? 'error');
}
