'use client';

import { useActionState, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import {
  editPersonAction,
  mintPersonAction,
  payKpiAction,
  setPersonActiveAction,
  setStaffCategoryAction,
  stampClientCargoAction,
  type StaffFormState,
} from './actions';

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

/**
 * «➕ Tizimga kirmaydigan hodim qo'shish» (0120, the owner's 2b) — a warehouse
 * worker in China who is paid here and never signs in.
 *
 * Controlled, no `<form action>` (KpiPayForm's pattern): a refusal keeps what
 * was typed. On success it LANDS on the new person's card
 * (`/hodimlar?hodim=<id>`, the fast one-person pass) with «Oylik kiritish»
 * open — adding somebody is the first half of giving them a salary.
 *
 * A name already listed is NAMED, never a bare «shu ism bor»: each match is a
 * link to its card with its state, and the second press mints (any edit of the
 * name takes the confirmation back — the quick-create rule).
 */
export function NoLoginPersonNew() {
  const t = useTranslations('hodimlar');
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<StaffFormState>({});

  return (
    <details className="card !p-3" data-testid="hodimlar-person-new">
      <summary className="cursor-pointer text-sm font-semibold text-brand-700">➕ {t('personNew')}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-2xs text-ink-500">{t('personNewHint')}</p>
        <label className="block">
          <span className="label">{t('personName')}</span>
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setConfirm(false);
            }}
            data-testid="hodimlar-person-name"
          />
        </label>
        <label className="block">
          <span className="label">{t('personPhone')}</span>
          <input
            className="input"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="hodimlar-person-phone"
          />
          <span className="mt-1 block text-2xs text-ink-500">{t('personPhoneHint')}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            data-testid="hodimlar-person-save"
            disabled={pending || name.trim() === ''}
            onClick={() =>
              startTransition(async () => {
                const res = await mintPersonAction({ fullName: name, phone, confirmSameName: confirm });
                setResult(res);
                if (res.ok && res.id) {
                  // A FULL load, not router.push (#1242): `await` returns with the
                  // action's value while the router is still applying the page the
                  // action revalidated, and a navigation arriving then DISCARDS that
                  // pending action — whose promise Next 15.5 never settles, so the
                  // navigation it is entangled with never commits (3-4 of 8 on a
                  // warm server; the URL never moved). A document load is not in
                  // the router's queue at all.
                  window.location.assign(`/hodimlar?hodim=${res.id}`);
                  return;
                }
                if (res.error === 'same_name') setConfirm(true);
              })
            }
          >
            {t('personAdd')}
          </button>
          {/* The fallback if the load above is slow. No prefetch: the page is
              being loaded anyway, and a prefetch here was the first thing the
              lost soft navigation reused. */}
          {result.ok && result.id ? (
            <Link
              className="chip chip-good"
              data-testid="hodimlar-person-added"
              href={`/hodimlar?hodim=${result.id}`}
              prefetch={false}
            >
              ✅ {t('personAdded')}
            </Link>
          ) : null}
          {result.error && result.error !== 'same_name' ? <RefusalText state={result} /> : null}
        </div>
        {result.error === 'same_name' ? (
          <div className="card space-y-1 !p-2 text-sm" data-testid="hodimlar-person-same-name">
            <p>{t('personSameName')}</p>
            <ul className="space-y-1">
              {(result.matches ?? []).map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-x-2">
                  <Link
                    href={`/hodimlar?hodim=${m.id}`}
                    className="font-semibold text-brand-700"
                    data-testid="hodimlar-person-match"
                  >
                    {m.name}
                  </Link>
                  <span className="text-2xs text-ink-500">
                    {m.loginEnabled ? t('personStateLogin') : t('noLogin')}
                    {m.active ? '' : ` · ${t('inactive')}`}
                  </span>
                </li>
              ))}
            </ul>
            {result.more ? (
              <p className="text-2xs text-ink-500">{t('personSameNameMore', { count: result.more })}</p>
            ) : null}
            {/* «The salary goes on that card» is true of a person who still
                works here; a leaver's card refuses a new salary, so their way
                is «Qayta faollashtirish» first (the review's F1). */}
            {(result.matches ?? []).some((m) => m.active) ? (
              <p className="text-2xs text-ink-600">{t('personSameNameAgain')}</p>
            ) : null}
            {(result.matches ?? []).some((m) => !m.active) ? (
              <p className="text-2xs text-ink-600" data-testid="hodimlar-person-same-return">
                {t('personSameNameReturn')}
              </p>
            ) : null}
            <p className="text-2xs text-ink-600">{t('personSameNameOther')}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * «Ishdan ketdi» / «Qayta faollashtirish» — ONE visible button in the card's
 * header of a person who never signs in. The confirm tells the right order:
 * pay the last month through «To'landi», then stop the template.
 */
export function NoLoginPersonActive({ person }: { person: { id: string; name: string; active: boolean } }) {
  const t = useTranslations('hodimlar');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StaffFormState>({});
  // No router.refresh() after these actions (#1242): each one revalidates
  // /hodimlar, so its answer already carries the new page — and a refresh
  // fired while that page is still streaming in made the router drop both,
  // leaving the button greyed for ever (measured 1 in 5 on a warm server).
  const press = (active: boolean) =>
    startTransition(async () => {
      const res = await setPersonActiveAction(person.id, active);
      setResult(res);
    });

  return (
    <span className="ml-auto inline-flex flex-wrap items-center gap-2">
      {person.active ? (
        <button
          type="button"
          className="btn-danger"
          data-testid="staff-person-leave"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t('personLeaveConfirm', { name: person.name }))) press(false);
          }}
        >
          {t('personLeave')}
        </button>
      ) : (
        <button
          type="button"
          className="btn-secondary"
          data-testid="staff-person-return"
          disabled={pending}
          onClick={() => press(true)}
        >
          {t('personReturn')}
        </button>
      )}
      <RefusalText state={result} />
    </span>
  );
}

/** «✏️ Ism, telefon» — the name and the payroll phone of a person who never signs in. */
export function NoLoginPersonTools({ person }: { person: { id: string; name: string; phone: string | null } }) {
  const t = useTranslations('hodimlar');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(person.name);
  const [phone, setPhone] = useState(person.phone ?? '');
  const [result, setResult] = useState<StaffFormState>({});

  return (
    <details className="border-t border-line pt-2" data-testid="staff-person-edit">
      <summary className="cursor-pointer text-xs font-semibold text-brand-700">✏️ {t('personEdit')}</summary>
      <div className="mt-2 space-y-2">
        <label className="block">
          <span className="label">{t('personName')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-testid="staff-person-name" />
        </label>
        <label className="block">
          <span className="label">{t('personPhone')}</span>
          <input
            className="input"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="staff-person-phone"
          />
          <span className="mt-1 block text-2xs text-ink-500">{t('personPhoneHint')}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            data-testid="staff-person-save"
            disabled={pending || name.trim() === ''}
            onClick={() =>
              startTransition(async () => {
                const res = await editPersonAction(person.id, { fullName: name, phone });
                setResult(res);
              })
            }
          >
            {tc('save')}
          </button>
          {result.ok ? <span className="text-sm text-good">✅ {tc('saved')}</span> : null}
          <RefusalText state={result} />
        </div>
      </div>
    </details>
  );
}
