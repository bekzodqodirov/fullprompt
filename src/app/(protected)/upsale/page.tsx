import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { readPeriod } from '@/modules/wms/crm/analytics';
import { listAccounts, listCategories } from '@/modules/wms/accounting/service';
import { getSetting } from '@/modules/platform/settings/service';
import { mayApproveBelowFloor, upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import {
  bySeller,
  pendingBelowFloor,
  upsaleRows,
  UPSALE_CAP,
  type UpsaleRow,
  type UpsaleState,
} from '@/modules/wms/calc/upsale-service';
import { PageHeader } from '@/components/ui/page';
import { hrefWith } from '@/components/list/board-filter';
import { CategoryForm, PayForm, ReleaseButton } from './pay-form';

/**
 * «Sotuvchi ulushi» — what a seller earns, and the accountant's Friday.
 *
 * Two shapes from one query, not two queries: below `md` a list, from `md` a
 * table. A nine-column table is what round 83 already had to rebuild as a
 * list, and a row wider than a 360 px viewport rescales the WHOLE page (#400)
 * on the screen the sellers actually carry.
 *
 * Law 4 decides who reads what, in one place: the owner and the accountant
 * see everyone, a seller sees their own, and the VED — who computed the floor
 * — sees none of it at all and is not queried.
 */
const STATE_CLASS: Record<UpsaleState, string> = {
  paid: 'chip chip-good',
  // Deliberately NOT brand: on this screen «ready to pay» is the ordinary
  // state, and painting the commonest row red makes the table a wall of
  // alarms — which is how the one row that DOES need attention («the client
  // has not paid») stops being visible.
  payable: 'chip chip-neutral',
  awaiting_payment: 'chip chip-warn',
  no_invoice: 'chip chip-neutral',
  no_deal: 'chip chip-neutral',
};

const STATE_KEY: Record<UpsaleState, 'stPaid' | 'stPayable' | 'stAwaiting' | 'stNoInvoice' | 'stNoDeal'> = {
  paid: 'stPaid',
  payable: 'stPayable',
  awaiting_payment: 'stAwaiting',
  no_invoice: 'stNoInvoice',
  no_deal: 'stNoDeal',
};

export default async function UpsalePage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; gacha?: string; hodim?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const scope = upsaleScopeFor(actor);
  // Law 4. Not filtered — not reachable.
  if (scope === 'none') redirect('/');

  const params = await searchParams;
  const period = readPeriod(params);
  const t = await getTranslations('upsale');
  const format = await getFormatter();

  let rows: UpsaleRow[] = [];
  let truncated = false;
  let pending: Awaited<ReturnType<typeof pendingBelowFloor>> = [];
  let accounts: Awaited<ReturnType<typeof listAccounts>> = [];
  let categories: Awaited<ReturnType<typeof listCategories>> = [];
  let categoryId = '';
  let behind = false;
  try {
    const res = await upsaleRows(scope, actor.id, {
      from: period.dan,
      to: period.gacha,
      sellerId: params.hodim,
    });
    rows = res.rows;
    truncated = res.truncated;
    if (mayApproveBelowFloor(actor)) pending = await pendingBelowFloor();
    if (actor.permissions.has('finance.expenses') && scope === 'all') {
      // The payer's two questions: out of which till, and under which cost
      // type. The second is a setting with no picker anywhere else, so it is
      // asked here — see `CategoryForm`.
      [accounts, categories, categoryId] = await Promise.all([
        listAccounts(),
        listCategories(),
        getSetting('upsale_expense_category_id').then((v) => String(v ?? '').trim()),
      ]);
    }
  } catch (err) {
    // 0088's columns. This screen must say a sentence on deploy morning, not
    // show a digest (#472-475).
    if (!isServerBehind(err)) throw err;
    logger.error({ err }, '[upsale] server behind');
    behind = true;
  }

  const money = (n: number) => `$${n.toFixed(2)}`;
  const totals = {
    earned: Math.round(rows.reduce((s, r) => s + r.upsaleUsd, 0) * 100) / 100,
    paid: Math.round(rows.filter((r) => r.state === 'paid').reduce((s, r) => s + (r.paidUsd ?? 0), 0) * 100) / 100,
    waiting:
      Math.round(rows.filter((r) => r.state !== 'paid').reduce((s, r) => s + r.upsaleUsd, 0) * 100) / 100,
  };
  const payable = rows.filter((r) => r.state === 'payable');
  const current = { dan: period.dan, gacha: period.gacha, hodim: params.hodim ?? '' };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader icon="wallet" title={t('title')} />

      {behind ? (
        <p className="chip chip-warn" data-testid="upsale-behind">
          {t('none')}
        </p>
      ) : null}

      {/* One GET form, so the period is in the address bar and a found answer
          is a link (#514: every value validated on the way back in). */}
      <form className="card flex flex-wrap items-end gap-2 !p-3" data-testid="upsale-period">
        <label className="text-2xs">
          <span className="label">{t('when')}</span>
          <input type="date" name="dan" className="input input-sm !w-36" defaultValue={period.dan} />
        </label>
        <label className="text-2xs">
          <span className="label">—</span>
          <input type="date" name="gacha" className="input input-sm !w-36" defaultValue={period.gacha} />
        </label>
        {params.hodim ? <input type="hidden" name="hodim" value={params.hodim} /> : null}
        <button type="submit" className="btn-secondary">
          {t('title')}
        </button>
      </form>

      <div className="grid grid-cols-3 gap-2" data-testid="upsale-scoreboard">
        {(
          [
            ['earned', totals.earned],
            ['waiting', totals.waiting],
            ['paid', totals.paid],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="card !p-3">
            <p className="text-2xs uppercase text-ink-500">{t(key)}</p>
            <p className="font-mono text-lg font-bold tabular-nums">{money(value)}</p>
          </div>
        ))}
      </div>

      {pending.length > 0 ? (
        <section className="card !p-3" data-testid="upsale-pending">
          <p className="text-2xs uppercase text-ink-500">{t('pending')}</p>
          <ul className="mt-1 space-y-2">
            {pending.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold tabular-nums">
                  {money(Number(o.clientPriceUsd))}
                </span>
                <span className="text-2xs text-ink-500">
                  {t('reason')}: {o.belowFloorReason ?? '—'}
                </span>
                <span className="text-2xs text-ink-500">
                  {format.dateTime(o.offeredAt, { dateStyle: 'short' })}
                </span>
                <ReleaseButton offerId={o.id} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {categories.length > 0 ? (
        <CategoryForm
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          current={categoryId}
          mayChoose={actor.permissions.has('admin.settings.manage')}
        />
      ) : null}

      {accounts.length > 0 && payable.length > 0 ? (
        <details className="card !p-0" data-testid="upsale-pay-fold">
          <summary className="cursor-pointer p-3 text-sm font-bold text-ink-700">
            {t('payTitle')}
            <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-700">
              {payable.length} · $
              {(Math.round(payable.reduce((s, r) => s + r.upsaleUsd, 0) * 100) / 100).toFixed(2)}
            </span>
          </summary>
          <div className="px-3 pb-3">
        <PayForm
          rows={payable.map((r) => ({
            offerId: r.offerId,
            sellerId: r.sellerId,
            sellerName: r.sellerName,
            clientCode: r.clientCode,
            clientName: r.clientName,
            upsaleUsd: r.upsaleUsd,
            offeredAt: r.offeredAt.toISOString(),
          }))}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
        />
          </div>
        </details>
      ) : null}

      {scope === 'all' && rows.length > 0 ? (
        <section className="card !p-3" data-testid="upsale-sellers">
          <ul className="space-y-1">
            {bySeller(rows).map((s) => (
              <li key={s.sellerId} className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link
                  className="font-semibold text-brand-700"
                  href={hrefWith(current, { hodim: s.sellerId })}
                  data-testid="upsale-seller-link"
                >
                  {s.sellerName ?? '—'}
                </Link>
                <span className="font-mono font-semibold tabular-nums text-ink-900">
                  {money(s.earnedUsd)}
                </span>
                <span className="text-2xs text-ink-500">
                  {s.jobs} {t('jobs')} · {t('paid')} {money(s.paidUsd)} · {t('waiting')}{' '}
                  {money(s.waitingUsd)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="upsale-none">
          {t('none')}
        </p>
      ) : (
        <>
          {/* The phone shape. A nine-column table at 360 px rescales the whole
              page, and this is the screen a seller reads their own pay on. */}
          <ul className="space-y-2 md:hidden" data-testid="upsale-list">
            {rows.map((r) => (
              <li key={r.offerId} className="card !p-3" data-testid="upsale-row">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-base font-bold tabular-nums">
                    {money(r.upsaleUsd)}
                  </span>
                  <span className={STATE_CLASS[r.state]}>{t(STATE_KEY[r.state])}</span>
                  <span className="text-2xs text-ink-500">
                    {format.dateTime(r.offeredAt, { dateStyle: 'short' })}
                  </span>
                </div>
                <p className="text-2xs text-ink-600">
                  {r.clientCode ?? ''} {r.clientName ?? ''}
                  {scope === 'all' ? ` · ${r.sellerName ?? '—'}` : ''}
                </p>
                {/* «Tannarx korinmasin sotuvchiga» (owner, 2026-08-25): the
                    floor prints only where law 4 already shows costs. The
                    seller keeps their price and their share — the two
                    figures that are THEIRS. */}
                <p className="text-2xs text-ink-500">
                  {t('clientPrice')} {money(r.clientPriceUsd)}
                  {scope === 'all' ? ` · ${t('floor')} ${money(r.floorUsd)}` : ''}
                </p>
              </li>
            ))}
          </ul>

          <div className="hidden md:block">
            <div className="table-wrap overflow-x-auto">
              <table className="w-full text-sm" data-testid="upsale-table">
                <thead>
                  <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                    <th className="p-2">{t('when')}</th>
                    {scope === 'all' ? <th className="p-2">{t('seller')}</th> : null}
                    <th className="p-2">{t('client')}</th>
                    <th className="p-2 text-right">{t('clientPrice')}</th>
                    {scope === 'all' ? <th className="p-2 text-right">{t('floor')}</th> : null}
                    <th className="p-2 text-right">{t('share')}</th>
                    <th className="p-2">{t('state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.offerId} className="border-b border-line/60" data-testid="upsale-tr">
                      <td className="p-2 font-mono tabular-nums">
                        {format.dateTime(r.offeredAt, { dateStyle: 'short' })}
                      </td>
                      {scope === 'all' ? <td className="p-2">{r.sellerName ?? '—'}</td> : null}
                      <td className="p-2">
                        {r.clientCode ?? ''} {r.clientName ?? ''}
                      </td>
                      <td className="p-2 text-right font-mono tabular-nums">
                        {money(r.clientPriceUsd)}
                      </td>
                      {scope === 'all' ? (
                        <td className="p-2 text-right font-mono tabular-nums">
                          {money(r.floorUsd)}
                        </td>
                      ) : null}
                      <td className="p-2 text-right font-mono font-semibold tabular-nums">
                        {money(r.upsaleUsd)}
                      </td>
                      <td className="p-2">
                        <span className={STATE_CLASS[r.state]}>{t(STATE_KEY[r.state])}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {truncated ? (
            <p className="text-2xs text-ink-500" data-testid="upsale-sliced">
              {t('sliced', { n: UPSALE_CAP })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
