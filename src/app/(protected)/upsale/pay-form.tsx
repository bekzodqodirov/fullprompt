'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { payUpsaleAction, releaseOfferAction, type UpsaleFormState } from './actions';

export interface PayableRow {
  offerId: string;
  sellerId: string;
  sellerName: string | null;
  clientCode: string | null;
  clientName: string | null;
  upsaleUsd: number;
  offeredAt: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The accountant's Friday.
 *
 * The AMOUNT is not an input. They tick jobs, pick the till and the day, and
 * the total is rendered from the ticks so they see what they are about to pay
 * BEFORE pressing — a typed figure is how a screen says «$340 paid» while
 * $200 leaves the till, and a partial payment is fewer ticks.
 *
 * One seller at a time, because one expense names one employee: the picker
 * disables the other sellers' rows once the first is ticked, rather than
 * letting the press fail with a refusal nobody expected.
 *
 * Controlled inputs and no `<form action>` (#377 and its four repeats): the
 * commonest refusal here is a job somebody else already paid, and a refusal
 * that clears the ticks makes the accountant rebuild the whole list.
 */
export function PayForm({
  rows,
  accounts,
}: {
  rows: PayableRow[];
  accounts: { id: string; name: string; currency: string }[];
}) {
  const t = useTranslations('upsale');
  const tc = useTranslations('common');
  const tErr = useTranslations('calc');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<string[]>([]);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [result, setResult] = useState<UpsaleFormState>({});

  const chosen = useMemo(() => rows.filter((r) => picked.includes(r.offerId)), [rows, picked]);
  const seller = chosen[0]?.sellerId ?? null;
  const total = useMemo(
    () => Math.round(chosen.reduce((s, r) => s + r.upsaleUsd, 0) * 100) / 100,
    [chosen],
  );
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? 'USD';

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="upsale-pay">
      <p className="text-2xs text-ink-500">{t('payHint')}</p>

      <ul className="space-y-1">
        {rows.map((r) => {
          const other = seller !== null && r.sellerId !== seller;
          return (
            <li
              key={r.offerId}
              className={`flex flex-wrap items-center gap-2 text-sm ${other ? 'opacity-40' : ''}`}
              data-testid="upsale-pay-row"
            >
              <input
                type="checkbox"
                aria-label={`${r.clientCode ?? ''} ${r.upsaleUsd}`}
                data-testid="upsale-pick"
                disabled={other || pending}
                checked={picked.includes(r.offerId)}
                onChange={(e) =>
                  setPicked((cur) =>
                    e.target.checked
                      ? [...cur, r.offerId]
                      : cur.filter((id) => id !== r.offerId),
                  )
                }
              />
              <span className="font-mono tabular-nums">${r.upsaleUsd.toFixed(2)}</span>
              <span className="text-ink-600">{r.sellerName ?? '—'}</span>
              <span className="text-2xs text-ink-500">
                {r.clientCode ?? ''} {r.clientName ?? ''}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
        <label className="text-2xs">
          <span className="label">{t('kassa')}</span>
          <select
            className="input input-sm !w-40"
            aria-label={t('kassa')}
            data-testid="upsale-account"
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
            data-testid="upsale-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="text-2xs grow">
          <span className="label">{t('payNote')}</span>
          <input
            className="input input-sm w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          {t('payTotal')}:{' '}
          <span className="font-mono text-base font-bold tabular-nums" data-testid="upsale-total">
            ${total.toFixed(2)}
          </span>
        </span>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || picked.length === 0 || !accountId}
          data-testid="upsale-do-pay"
          onClick={() =>
            startTransition(async () => {
              const res = await payUpsaleAction(picked, {
                accountId,
                currency,
                expenseDate: date,
                note,
              });
              setResult(res);
              if (res.ok) {
                setPicked([]);
                router.refresh();
              }
            })
          }
        >
          {t('pay')}
        </button>
        {result.ok ? (
          <span className="chip chip-good" data-testid="upsale-paid">
            ✅ ${result.paidUsd?.toFixed(2)} · {result.count}
          </span>
        ) : null}
        {result.error ? (
          <span className="chip chip-warn" data-testid="upsale-error">
            {tErr.has(`errors.${result.error}`)
              ? tErr(`errors.${result.error}` as 'errors.not_found')
              : result.error}
          </span>
        ) : null}
      </div>
      <p className="sr-only">{tc('save')}</p>
    </div>
  );
}

/** «Ruxsat berish» — one press, and the promise goes to the customer. */
export function ReleaseButton({ offerId }: { offerId: string }) {
  const t = useTranslations('upsale');
  const tErr = useTranslations('calc');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn-primary"
        disabled={pending}
        data-testid="upsale-allow"
        onClick={() =>
          startTransition(async () => {
            const res = await releaseOfferAction(offerId);
            setError(res.error ?? null);
            if (res.ok) router.refresh();
          })
        }
      >
        {t('allow')}
      </button>
      {error ? (
        <span className="chip chip-warn" data-testid="upsale-allow-error">
          {tErr.has(`errors.${error}`) ? tErr(`errors.${error}` as 'errors.not_found') : error}
        </span>
      ) : null}
    </span>
  );
}
