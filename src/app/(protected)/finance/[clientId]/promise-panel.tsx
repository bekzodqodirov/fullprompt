import { getTranslations } from 'next-intl/server';
import { addDays } from '@/modules/platform/time/tashkent';
import { clientPromises } from '@/modules/wms/debt/promises';
import { CENT, PROMISE_HORIZON_DAYS, type PromiseStatus } from '@/modules/wms/debt/rules';
import { PromiseCancel, PromiseForm } from './promise-form';

/** Literal map (#163): a status added to the table is a type error here. */
const STATUS: Record<PromiseStatus, { key: string; tone: string }> = {
  open: { key: 'promise.status.open', tone: 'text-warn' },
  kept: { key: 'promise.status.kept', tone: 'text-good' },
  settled: { key: 'promise.status.settled', tone: 'text-ink-700' },
  broken: { key: 'promise.status.broken', tone: 'text-bad' },
  cancelled: { key: 'promise.status.cancelled', tone: 'text-ink-500' },
};

/** `YYYY-MM-DD` as dd.mm.yyyy — the office's own way, and no Intl month (#678). */
function day(value: string): string {
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * The «Pul» tab's promise block (0114). Read by whoever may open this ledger
 * (the page's own door); the form and the ✖ only for `canPromise` — the
 * service's `mayGrantDebt`, asked by the page so a control is never drawn
 * that the service would refuse.
 */
export async function PromisePanel({
  clientId,
  canPromise,
  balanceUsd,
  today,
}: {
  clientId: string;
  canPromise: boolean;
  balanceUsd: number;
  today: string;
}) {
  const t = await getTranslations('qarz');
  const promises = await clientPromises(clientId);
  const open = promises.find((p) => p.status === 'open') ?? null;
  const closed = promises.filter((p) => p.status !== 'open');
  if (!canPromise && promises.length === 0) return null;
  const usd = (n: number) => `$${n.toFixed(2)}`;

  return (
    <section className="card space-y-2" data-testid="promise-panel">
      <h2 className="text-sm font-bold uppercase text-ink-500">🤝 {t('promise.title')}</h2>
      {open ? (
        <div className="space-y-1 rounded-lg bg-warn/10 p-2 text-sm" data-testid="promise-open">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-lg font-extrabold">{usd(open.amountUsd)}</span>
            <span className="text-ink-700">{t('promise.due', { date: day(open.dueOn) })}</span>
            <span className={`text-xs font-semibold ${STATUS.open.tone}`}>{t(STATUS.open.key)}</span>
          </p>
          <p className="text-xs text-ink-700" data-testid="promise-progress">
            {t('promise.progress', { paid: usd(open.paidSinceUsd), amount: usd(open.amountUsd) })}
          </p>
          {open.note && <p className="break-words text-xs text-ink-600">{open.note}</p>}
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
            <span>{t('promise.by', { name: open.createdByName ?? '—' })}</span>
            {canPromise && <PromiseCancel promiseId={open.id} clientId={clientId} />}
          </p>
        </div>
      ) : canPromise ? (
        balanceUsd > CENT ? (
          <PromiseForm clientId={clientId} today={today} maxDay={addDays(today, PROMISE_HORIZON_DAYS)} />
        ) : (
          <p className="text-sm text-ink-500">{t('promise.noDebt')}</p>
        )
      ) : (
        <p className="text-sm text-ink-500">{t('promise.none')}</p>
      )}
      {closed.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-500">{t('promise.history', { n: closed.length })}</summary>
          <ul className="mt-1 divide-y divide-line">
            {closed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-2 py-1" data-testid="promise-past">
                <span className="font-mono">{usd(p.amountUsd)}</span>
                <span className="text-ink-600">{t('promise.due', { date: day(p.dueOn) })}</span>
                <span className={`font-semibold ${STATUS[p.status].tone}`}>{t(STATUS[p.status].key)}</span>
                <span className="text-ink-500">{t('promise.by', { name: p.createdByName ?? '—' })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
