'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { payKpiAction, setStaffCategoryAction, stampClientCargoAction, type StaffFormState } from './actions';

/**
 * A refusal in WORDS — `hodimlar.refusal.<code>`. The key is built at runtime,
 * which `i18n-keys.test.ts` cannot see, so `staff-refusal-map.test.ts` reads
 * the three unions out of the services and demands every member in all four
 * bundles (#906/#915's shape): a code added tomorrow is red the day it is
 * written, not the day a payer meets it.
 */
export function RefusalText({ state }: { state: StaffFormState }) {
  const t = useTranslations('hodimlar');
  if (!state.error) return null;
  const text = t(`refusal.${state.error}`);
  return (
    <span className="chip chip-warn" data-testid="hodimlar-error">
      {state.month ? `${state.month}: ` : ''}
      {text}
      {state.reason ? ` — ${t(`refusal.${state.reason}`)}` : ''}
    </span>
  );
}

/**
 * «KPI to'lash». The amount is NOT an input (`payUpsale`'s rule): the screen
 * shows what the server derived and posts it back only as a compare-and-set
 * (`expectedUsd`), so a figure that moved between the render and the press is
 * refused rather than paid. Controlled inputs and no `<form action>` — a
 * refusal must not wipe the till and the date (#377).
 */
export function KpiPayForm({
  sellerId,
  payableUsd,
  accounts,
  today,
}: {
  sellerId: string;
  payableUsd: number;
  accounts: { id: string; name: string; currency: string }[];
  /** Tashkent's day from the server (R5). */
  today: string;
}) {
  const t = useTranslations('hodimlar');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<StaffFormState>({});
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? 'USD';

  return (
    <details className="rounded border border-line" data-testid="kpi-pay-fold">
      <summary className="cursor-pointer px-2 py-1.5 text-sm font-semibold text-brand-700">
        {t('kpiPay')} · ${payableUsd.toFixed(2)}
      </summary>
      <div className="space-y-2 p-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-2xs">
            <span className="label">{t('kassa')}</span>
            <select
              className="input input-sm !w-40"
              aria-label={t('kassa')}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="text-2xs">
            <span className="label">{t('payDate')}</span>
            <input
              type="date"
              className="input input-sm !w-36"
              value={date}
              max={latestTxDate()}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="grow text-2xs">
            <span className="label">{t('payNote')}</span>
            <input className="input input-sm w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            data-testid="kpi-pay"
            disabled={pending || !accountId}
            onClick={() =>
              startTransition(async () => {
                const res = await payKpiAction(sellerId, {
                  accountId,
                  currency,
                  expenseDate: date,
                  expectedUsd: payableUsd,
                  note,
                });
                setResult(res);
                if (res.ok) router.refresh();
              })
            }
          >
            {t('kpiPay')}
          </button>
          {result.ok ? (
            <span className="chip chip-good" data-testid="kpi-paid">
              ✅ ${result.paidUsd?.toFixed(2)}
            </span>
          ) : null}
          <RefusalText state={result} />
        </div>
        <p className="text-2xs text-ink-500">{t('kpiPayHint')}</p>
      </div>
    </details>
  );
}

/**
 * The KPI payout's and the salary's category — beside the button they unlock,
 * the upsale picker's precedent (a setting printed as a uuid box on
 * /admin/settings is unusable). The fold's face carries the answer.
 */
export function StaffCategoryForm({
  settingKey,
  title,
  unset,
  hint,
  categories,
  current,
  mayChoose,
}: {
  settingKey: 'kpi_expense_category_id' | 'salary_expense_category_id';
  title: string;
  unset: string;
  hint: string;
  categories: { id: string; name: string }[];
  current: string;
  mayChoose: boolean;
}) {
  const t = useTranslations('hodimlar');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(setStaffCategoryAction, {});
  const chosen = categories.find((c) => c.id === current);
  if (!mayChoose && chosen) return null;

  return (
    <details className="card !p-0" data-testid={`staff-category-${settingKey}`} open={!chosen}>
      <summary className="cursor-pointer p-3 text-sm font-bold text-ink-700">
        {chosen ? (
          <span>
            <span className="text-good">✅</span> {title}: <span className="font-normal">{chosen.name}</span>
          </span>
        ) : (
          <span>
            <span className="text-warn">⚠</span> {unset}
          </span>
        )}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-xs text-ink-500">{hint}</p>
        {mayChoose ? (
          <form action={formAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="key" value={settingKey} />
            <select name="categoryId" defaultValue={current} aria-label={title} className="input min-w-40 flex-1">
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-primary px-4" disabled={pending}>
              {tc('save')}
            </button>
            {state.ok && <span className="self-center text-sm text-good">✅</span>}
            <RefusalText state={state} />
          </form>
        ) : (
          <p className="text-xs text-warn">{t('categoryAsk')}</p>
        )}
      </div>
    </details>
  );
}

/**
 * «→ {seller}» on a «Sotuvchisiz yuk» row whose client already names a
 * seller: stamps that client's unstamped cargo to the seller the card names
 * (the action re-reads it — the button only carries the client).
 */
export function StampRepairButton({ clientId, sellerName }: { clientId: string; sellerName: string }) {
  const t = useTranslations('hodimlar');
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(stampClientCargoAction, {});
  return (
    <form action={formAction} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <button type="submit" className="btn-secondary !px-2 !py-1 text-xs" disabled={pending} data-testid="unstamped-repair">
        {t('unstampedRepair', { name: sellerName })}
      </button>
      {state.ok && <span className="text-sm text-good">✅</span>}
      <RefusalText state={state} />
    </form>
  );
}
