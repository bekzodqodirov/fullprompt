import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { pnlGaps, profitAndLoss } from '@/modules/wms/accounting/reports';
import { pnlParts } from '@/modules/wms/reports/dashboard-math';
import { isContinuationTrip } from '@/modules/wms/reports/dashboard-math';
import { priorPeriodOf } from '@/modules/wms/accounting/prior-period';
import { batchCarriage } from '@/modules/wms/costing/service';
import { costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { recurringArrears } from '@/modules/wms/accounting/recurring';
import { openExpenseRequestTotals } from '@/modules/wms/accounting/expense-requests';
import { uncheckedTwinRows } from '@/modules/wms/accounting/twins';
import { receiptsReadableBy } from '@/modules/wms/receipts/read-door';
import { batchTabHref, mayOpenBatchCard, mayOpenBatchCosts, mayOpenBatchPricing } from '@/modules/wms/batches/card-door';
import {
  costTargetHref,
  payerNameFor,
  readSpendFilters,
  REGISTER_PAGE,
  sarflarPeriod,
  spendMap,
  spendRegister,
  spendTruckChip,
  spendTrucks,
  truckRevenue,
  type SpendKind,
  type SpendPayer,
  type SpendTruckChip,
} from '@/modules/wms/accounting/sarflar';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { hrefWith } from '@/components/list/board-filter';
import { PageHeader } from '@/components/ui/page';
import { PnlGapsNote } from '../pnl-gaps';
import { db } from '@/modules/platform/db/client';
import { costTypes, expenseCategories, warehouses } from '@/modules/platform/db/schema';
import { asc, eq } from 'drizzle-orm';

/**
 * «Pul qayerga ketdi» (docs/SARFLAR.md §1, his «qayerda qanday rasxod
 * bolayotganini 1 pageda koradgan»). The owner, the admins and the accountant
 * (`companyMoneySight`, his 1a) — never the VED, a seller or the logist.
 *
 * Every figure is the P&L's own money regrouped: the hero IS the dashboard's
 * «Xarajat» (`pnlParts(...).cost`), every block below adds up to the book
 * total (direct + opex) and the kurs farqi is the one bridge line between
 * them. Truck money is never placed under a warehouse (his Q3): each truck is
 * a row of «Partiyalar» marked by its kind. No `<Suspense>` (#1242).
 */

const KINDS: Record<SpendKind, string> = {
  batch: 'kind.batch',
  receipt: 'kind.receipt',
  crate: 'kind.crate',
  pickup: 'kind.pickup',
};
const PAYER_LABEL: Record<SpendPayer, string> = {
  kassa: 'payer.kassa',
  own: 'payer.own',
  firm: 'payer.firm',
  book: 'payer.book',
  queue: 'payer.queue',
  history: 'payer.history',
  noKassa: 'payer.noKassa',
};
const CHIP: Record<Exclude<SpendTruckChip, null>, string> = {
  internal: 'chip.internal',
  continuation: 'chip.continuation',
  tracked: 'chip.tracked',
};
const PRESET = { oy: 'preset.oy', otgan: 'preset.otgan', yil: 'preset.yil' } as const;
const TWIN_SHAPE = {
  same_kassa: 'twinShape.same_kassa',
  kassa_cash: 'twinShape.kassa_cash',
  same_partner: 'twinShape.same_partner',
  debt_paid: 'twinShape.debt_paid',
  mergeable: 'twinShape.mergeable',
} as const;
const TRUCKS_SHOWN = 10;
const TRUCKS_PAGE = 50;

export default async function SarflarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const sight = companyMoneySight(actor);
  if (!sight) redirect('/');
  const params = await searchParams;
  const t = await getTranslations('sarflar');

  const period = sarflarPeriod(params);
  const prior = priorPeriodOf(period.from, period.to);
  const seesStaff = maySeeStaffMoney(actor.permissions);
  // Individual expense rows — a salary is one — are the expense book's
  // readers' alone (§8.4); everybody else reads the category totals.
  const expenseRows = seesStaff;
  const kassaSide = mayPickTill(actor.permissions);
  const filters = readSpendFilters(params, { seesStaff, expenseRows });
  const page = Math.max(1, Number.parseInt(params.bet ?? '1', 10) || 1);
  const allTrucks = params.partiyalar === 'hammasi';
  const truckPage = Math.max(1, Number.parseInt(params.pbet ?? '1', 10) || 1);
  const today = tashkentDay();

  const [pnl, priorPnl, gaps, map, priorMap, trucks, register, twins, arrears, requests, typeOptions, categoryOptions, places] =
    await Promise.all([
      profitAndLoss(period.from, period.to),
      profitAndLoss(prior.from, prior.to),
      pnlGaps(period.from, period.to),
      spendMap(sight, period.from, period.to, { seesStaff }),
      spendMap(sight, prior.from, prior.to, { seesStaff }),
      spendTrucks(sight, period.from, period.to, {
        limit: allTrucks ? TRUCKS_PAGE : TRUCKS_SHOWN,
        offset: allTrucks ? (truckPage - 1) * TRUCKS_PAGE : 0,
      }),
      spendRegister(
        sight,
        period,
        filters,
        { id: actor.id, seesStaff, expenseRows, costs: costSightFor(actor) },
        { limit: REGISTER_PAGE, offset: (page - 1) * REGISTER_PAGE },
      ),
      uncheckedTwinRows(sight, period.from, period.to),
      recurringArrears(today),
      openExpenseRequestTotals(),
      db.select({ id: costTypes.id, name: costTypes.name }).from(costTypes).orderBy(asc(costTypes.createdAt), asc(costTypes.code)),
      expenseRows
        ? db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).orderBy(asc(expenseCategories.sortOrder))
        : Promise.resolve([]),
      db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).where(eq(warehouses.active, true)).orderBy(asc(warehouses.name)),
    ]);

  const parts = pnlParts(pnl, 'total');
  const priorParts = pnlParts(priorPnl, 'total');
  const book = Math.round((parts.direct + parts.opex) * 100) / 100;
  const usd = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}$${usd(Math.abs(value))}`;
  const delta = (now: number, was: number) => {
    const d = Math.round((now - was) * 100) / 100;
    if (Math.abs(d) < 0.005) return null;
    return (
      <span className={d > 0 ? 'text-bad' : 'text-good'}>
        {d > 0 ? '▲' : '▼'} ${usd(Math.abs(d))}
      </span>
    );
  };
  const pct = (value: number, of: number) => (of > 0 ? `${Math.round((value / of) * 100)}%` : '—');
  const current: Record<string, string> = Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  // Every link carries the period explicitly (§8.3), so a filter survives it;
  // the preset word gives way to the dates it resolved to, and a filter
  // change starts the register on its first page.
  const base: Record<string, string> = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'davr' && key !== 'bet')),
    from: period.from,
    to: period.to,
  };
  const presetHref = (davr: string) => hrefWith({}, { davr });
  const filterHref = (patch: Record<string, string | undefined>) => hrefWith(base, patch);

  // The truck rows' kinds — read for the DRAWN rows only.
  const truckIds = trucks.rows.map((row) => row.id);
  const [carriage, revenue] = await Promise.all([batchCarriage(truckIds), truckRevenue(truckIds)]);

  // Register links: ONE readable-receipt question for the page.
  const readable = await receiptsReadableBy(
    actor,
    register.rows.flatMap((row) =>
      row.receiptId && row.receiptWarehouseId ? [{ id: row.receiptId, warehouseId: row.receiptWarehouseId }] : [],
    ),
  );

  // «Umumiy» by category: the top six, then «yana N» — summing to opex exactly.
  const categories = [...pnl.opex].sort((a, b) => b.total - a.total);
  const topCategories = categories.slice(0, 6);
  const restCategories = categories.slice(6);
  const restUsd = Math.round(restCategories.reduce((sum, row) => sum + row.total, 0) * 100) / 100;
  const priorKind = Object.fromEntries(priorMap.kinds.map((k) => [k.key, k.usd]));
  const priorCategory = Object.fromEntries(priorPnl.opex.map((row) => [row.key, row.total]));
  const maxKind = Math.max(1, ...map.kinds.map((k) => k.usd));
  const maxCategory = Math.max(1, ...topCategories.map((row) => row.total), restUsd);

  const bar = (key: string, label: string, value: number, of: number, max: number, was: number | undefined, tone: string, extra?: React.ReactNode, href?: string | null) => (
    <li key={key} className="space-y-1" data-testid={`spend-bar-${key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm [overflow-wrap:anywhere]">
        <span className="font-semibold">{href ? <Link href={href} className="underline">{label}</Link> : label}</span>
        <span className="flex flex-wrap items-baseline gap-x-2 font-mono tabular-nums">
          <span>${usd(value)}</span>
          <span className="text-ink-500">{pct(value, of)}</span>
          {was !== undefined && delta(value, was)}
          {extra}
        </span>
      </div>
      <div className="h-2 rounded bg-surface-sunken">
        <div className={`h-2 rounded ${tone}`} style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} />
      </div>
    </li>
  );
  const unconverted = (n: number) =>
    n > 0 ? <span className="rounded bg-warn/15 px-1 text-xs font-semibold text-warn">{t('noRate', { count: n })}</span> : null;

  // Every breakdown adds up to the BOOK; the kurs farqi belongs to no
  // warehouse and no truck, so it is the one line between the book and the
  // hero (§8.3), rendered from the same `pnlParts`.
  const bridge = (
    <>
      <li className="flex flex-wrap justify-between gap-x-2 py-1.5 text-ink-700">
        <span>{t('fxNoPlace')}</span>
        <span className="font-mono tabular-nums">{signed(-parts.fx)}</span>
      </li>
      <li className="flex flex-wrap justify-between gap-x-2 py-1.5 font-bold">
        <span>= {t('heroTitle')}</span>
        <span className="font-mono tabular-nums">${usd(parts.cost)}</span>
      </li>
    </>
  );
  const pages = Math.max(1, Math.ceil(register.total / REGISTER_PAGE));
  const exportHref = `/api/accounting/sarflar${hrefWith(base, {})}`;
  const mayEnter = actor.permissions.has('costs.enter_batch');

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        icon="wallet"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          mayEnter ? (
            <Link href="/accounting/sarflar/kiritish" className="btn-primary px-3" data-testid="sarf-enter">
              ＋ {t('enterTruckCost')}
            </Link>
          ) : undefined
        }
      />

      {/* 1. The period. */}
      <section className="space-y-2" data-testid="sarf-period">
        <div className="flex flex-wrap gap-2">
          {(['oy', 'otgan', 'yil'] as const).map((preset) => (
            <Link
              key={preset}
              href={presetHref(preset)}
              className={period.preset === preset ? 'chip bg-brand-600 text-white' : 'chip'}
              aria-current={period.preset === preset ? 'page' : undefined}
            >
              {t(PRESET[preset])}
            </Link>
          ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-ink-500">{t('from')}</span>
            <input type="date" name="from" defaultValue={period.from} className="input !w-40" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-ink-500">{t('to')}</span>
            <input type="date" name="to" defaultValue={period.to} className="input !w-40" />
          </label>
          <button type="submit" className="btn-secondary px-4">
            {t('show')}
          </button>
        </form>
        <p className="text-xs text-ink-500">{t('clock')}</p>
      </section>

      {/* 2. The hero — the dashboard's own «Xarajat», in parts that add up. */}
      <section className="card space-y-2" data-testid="sarf-hero">
        <p className="text-xs font-bold uppercase text-ink-500">{t('heroTitle')}</p>
        <p className="flex flex-wrap items-baseline gap-x-3 text-3xl font-bold">
          <span className="font-mono tabular-nums" data-testid="sarf-hero-total">
            ${usd(parts.cost)}
          </span>
          <span className="text-base">{delta(parts.cost, priorParts.cost)}</span>
        </p>
        <p className="text-xs text-ink-500">{t('priorWindow', { from: prior.from, to: prior.to })}</p>
        <ul className="space-y-0.5 text-sm">
          <li className="flex justify-between gap-2">
            <span>{t('direct')}</span>
            <span className="font-mono tabular-nums">${usd(parts.direct)}</span>
          </li>
          <li className="flex justify-between gap-2">
            <span>{t('opex')}</span>
            <span className="font-mono tabular-nums">${usd(parts.opex)}</span>
          </li>
          <li className="flex justify-between gap-2" data-testid="sarf-bridge">
            <span>{t('fxBridge')}</span>
            {/* Its effect on the cost: a gain lowers it (§8.3). */}
            <span className="font-mono tabular-nums">{signed(-parts.fx)}</span>
          </li>
        </ul>
      </section>
      <PnlGapsNote gaps={gaps} />

      {/* 3. «Qayerga». */}
      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card space-y-2" data-testid="sarf-kinds">
          <h2 className="text-sm font-bold uppercase text-ink-500">
            {t('whereCargo')} · ${usd(map.direct)}
          </h2>
          <ul className="space-y-2">
            {map.kinds.map((kind) =>
              bar(kind.key, t(KINDS[kind.key as SpendKind]), kind.usd, map.direct, maxKind, priorKind[kind.key], 'bg-brand-600', unconverted(kind.unconverted), filterHref({ joy: kind.key })),
            )}
          </ul>
        </div>
        <div className="card space-y-2" data-testid="sarf-categories">
          <h2 className="text-sm font-bold uppercase text-ink-500">
            {t('whereOverhead')} · ${usd(map.opex)}
          </h2>
          {categories.length === 0 ? (
            <p className="text-sm text-ink-500">—</p>
          ) : (
            <ul className="space-y-2">
              {topCategories.map((row) =>
                bar(row.key, row.label, row.total, map.opex, maxCategory, priorCategory[row.key] ?? 0, 'bg-warn/70', undefined, expenseRows ? filterHref({ turi: `c:${row.key}` }) : null),
              )}
              {restCategories.length > 0 &&
                bar('rest', t('moreCategories', { count: restCategories.length }), restUsd, map.opex, maxCategory, undefined, 'bg-warn/70')}
            </ul>
          )}
        </div>
      </section>

      {/* 4. The folds. */}
      <details className="card" data-testid="sarf-trucks" open={allTrucks}>
        <summary className="cursor-pointer text-sm font-bold">
          🚛 {t('trucksTitle')} · ${usd(map.trucksUsd)} {unconverted(map.trucksUnconverted)}
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-ink-500">
            {t('trucksNote')}{' '}
            <Link href={`/accounting/profit?from=${period.from}&to=${period.to}`} className="underline">
              {t('profitLink')} →
            </Link>
          </p>
          <p className="text-xs text-ink-500">{t('chipLegend')}</p>
          <ul className="divide-y divide-line">
            {trucks.rows.map((row) => {
              const chip = spendTruckChip({
                internal: row.internal,
                continuation: isContinuationTrip(carriage.get(row.id)),
                revenueUsd: revenue.get(row.id) ?? 0,
                tracked: row.tracked,
              });
              const card = mayOpenBatchCard(actor, { originWarehouseId: row.originWarehouseId, destWarehouseId: row.destWarehouseId });
              const href = card && mayOpenBatchPricing(actor.permissions, row.internal)
                ? batchTabHref(row.id, 'narx')
                : card && mayOpenBatchCosts(actor.permissions)
                  ? batchTabHref(row.id, 'xarajat')
                  : null;
              return (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm [overflow-wrap:anywhere]" data-testid="sarf-truck">
                  <span className="font-mono font-semibold">{row.code}</span>
                  {chip && <span className="chip text-xs" data-testid="sarf-truck-chip">{t(CHIP[chip])}</span>}
                  <span className="ml-auto font-mono tabular-nums">${usd(row.periodUsd)}</span>
                  {unconverted(row.periodUnconverted)}
                  <span className="text-xs text-ink-500">{t('allTime', { usd: usd(row.allTimeUsd) })}</span>
                  <Link href={filterHref({ partiya: row.id })} className="text-xs underline">
                    {t('rows')}
                  </Link>
                  {href ? (
                    <Link href={href} className="text-xs underline">
                      {t('notTannarx')} →
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-500">{t('notTannarx')}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {trucks.total > trucks.rows.length && !allTrucks && (
            <Link href={hrefWith(base, { partiyalar: 'hammasi', pbet: undefined })} className="text-sm underline">
              {t('allTrucks', { count: trucks.total })}
            </Link>
          )}
          {allTrucks && trucks.total > TRUCKS_PAGE && (
            <div className="flex gap-3 text-sm">
              {truckPage > 1 && <Link href={hrefWith(base, { pbet: String(truckPage - 1) })}>←</Link>}
              <span>
                {truckPage} / {Math.ceil(trucks.total / TRUCKS_PAGE)}
              </span>
              {truckPage * TRUCKS_PAGE < trucks.total && (
                <Link href={hrefWith(base, { pbet: String(truckPage + 1) })}>→</Link>
              )}
            </div>
          )}
        </div>
      </details>

      <details className="card" data-testid="sarf-warehouses">
        <summary className="cursor-pointer text-sm font-bold">🏬 {t('byWarehouse')}</summary>
        <ul className="mt-2 divide-y divide-line text-sm">
          {map.warehouses.map((row) => (
            <li key={row.key || 'none'} className="flex flex-wrap justify-between gap-x-2 py-1.5 [overflow-wrap:anywhere]">
              <span>{row.key ? <Link href={filterHref({ sklad: row.key })} className="underline">{row.label}</Link> : t('noWarehouse')}</span>
              <span className="font-mono tabular-nums">
                ${usd(row.usd)} {unconverted(row.unconverted)}
              </span>
            </li>
          ))}
          <li className="flex flex-wrap justify-between gap-x-2 py-1.5 text-ink-700" data-testid="sarf-warehouse-trucks">
            <span>{t('inTrucks')}</span>
            <span className="font-mono tabular-nums">${usd(map.trucksUsd)}</span>
          </li>
          <li className="flex flex-wrap justify-between gap-x-2 py-1.5 font-semibold">
            <span>{t('bookTotal')}</span>
            <span className="font-mono tabular-nums">${usd(book)}</span>
          </li>
          {bridge}
        </ul>
      </details>

      <details className="card" data-testid="sarf-types">
        <summary className="cursor-pointer text-sm font-bold">🏷️ {t('byType')}</summary>
        <ul className="mt-2 divide-y divide-line text-sm">
          {[...pnl.directCosts].sort((a, b) => b.total - a.total).map((row) => (
            <li key={row.key} className="flex justify-between gap-2 py-1.5 [overflow-wrap:anywhere]">
              <span>{row.label}</span>
              <span className="font-mono tabular-nums">${usd(row.total)}</span>
            </li>
          ))}
          {categories.map((row) => (
            <li key={row.key} className="flex justify-between gap-2 py-1.5 [overflow-wrap:anywhere]">
              <span>
                {row.label} <span className="text-xs text-ink-500">({t('overheadTag')})</span>
              </span>
              <span className="font-mono tabular-nums">${usd(row.total)}</span>
            </li>
          ))}
        </ul>
      </details>

      <details className="card" data-testid="sarf-payers">
        <summary className="cursor-pointer text-sm font-bold">💳 {t('byPayer')}</summary>
        <ul className="mt-2 divide-y divide-line text-sm">
          {map.payers.map((row) => {
            const payer = row.key as SpendPayer;
            const label = t(PAYER_LABEL[payer]);
            return (
              <li key={row.key} className="flex flex-wrap justify-between gap-x-2 py-1.5" data-testid={`sarf-payer-${row.key}`}>
                <span>
                  <Link href={filterHref({ payer: row.key })} className="underline">
                    {label}
                  </Link>
                  {payer === 'kassa' && (
                    <>
                      {' '}
                      <Link href={kassaSide ? '/accounting/accounts' : '/accounting/balance'} className="text-xs text-ink-500 underline">
                        ({t('kassaDollars')})
                      </Link>
                    </>
                  )}
                  {payer === 'queue' && kassaSide && (
                    <>
                      {' '}
                      <Link href="/accounting/xarajat-kassa" className="text-xs text-ink-500 underline">
                        {t('queueLink')} →
                      </Link>
                    </>
                  )}
                </span>
                <span className="font-mono tabular-nums">
                  ${usd(row.usd)} {unconverted(row.unconverted)}
                </span>
              </li>
            );
          })}
          <li className="flex justify-between gap-2 py-1.5 font-semibold">
            <span>{t('bookTotal')}</span>
            <span className="font-mono tabular-nums">${usd(book)}</span>
          </li>
          {bridge}
        </ul>
      </details>

      {/* 5. «Tekshiring» — links, never part of a total. */}
      <section className="card space-y-2 text-sm" data-testid="sarf-checks">
        <h2 className="text-sm font-bold uppercase text-ink-500">{t('checks')}</h2>
        {twins.rows === 0 && arrears.count === 0 && requests.count === 0 && <p className="text-ink-500">✅ {t('checksClean')}</p>}
        {twins.rows > 0 && (
          <details data-testid="sarf-twins">
            <summary className="cursor-pointer font-semibold text-warn">🔁 {t('twinsCount', { count: twins.rows })}</summary>
            <ul className="mt-1 space-y-1 text-xs">
              {twins.pairs.slice(0, 30).map((pair) => (
                <li key={`${pair.costId}:${pair.expenseId}`} className="[overflow-wrap:anywhere]">
                  {t(TWIN_SHAPE[pair.shape])}
                </li>
              ))}
            </ul>
            {kassaSide && (
              <Link href="/accounting/xarajat-kassa" className="text-xs underline">
                {t('queueLink')} →
              </Link>
            )}
          </details>
        )}
        {arrears.count > 0 &&
          (kassaSide ? (
            <Link href="/accounting/expenses" className="block font-semibold text-warn underline">
              ⏳ {t('arrears', { count: arrears.count })}
            </Link>
          ) : (
            <p className="font-semibold text-warn">⏳ {t('arrears', { count: arrears.count })}</p>
          ))}
        {requests.count > 0 &&
          (kassaSide ? (
            <Link href="/accounting/expenses" className="block font-semibold text-warn underline">
              💸 {t('requests', { count: requests.count })}
            </Link>
          ) : (
            <p className="font-semibold text-warn">💸 {t('requests', { count: requests.count })}</p>
          ))}
      </section>

      {/* 6. The register. */}
      <section className="space-y-2" data-testid="sarf-register">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{t('register')}</h2>
          <a href={exportHref} className="btn-secondary px-3" data-testid="sarf-xlsx">
            ⬇️ XLSX
          </a>
        </div>
        <details className="card" open={Object.values(filters).some((v) => v)}>
          <summary className="cursor-pointer text-sm font-semibold">{t('filters')}</summary>
          <form method="get" className="mt-2 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
            {filters.batchId && <input type="hidden" name="partiya" value={filters.batchId} />}
            <select name="kitob" defaultValue={filters.book ?? ''} aria-label={t('fBook')} className="input">
              <option value="">{t('fBook')}: {t('any')}</option>
              <option value="cost">{t('bookCost')}</option>
              {expenseRows && <option value="expense">{t('bookExpense')}</option>}
            </select>
            <select name="turi" defaultValue={filters.type ?? ''} aria-label={t('fType')} className="input">
              <option value="">{t('fType')}: {t('any')}</option>
              <optgroup label={t('bookCost')}>
                {typeOptions.map((option) => (
                  <option key={option.id} value={`t:${option.id}`}>
                    {option.name}
                  </option>
                ))}
              </optgroup>
              {categoryOptions.length > 0 && (
                <optgroup label={t('bookExpense')}>
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={`c:${option.id}`}>
                      {option.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <select name="sklad" defaultValue={filters.warehouseId ?? ''} aria-label={t('fWarehouse')} className="input">
              <option value="">{t('fWarehouse')}: {t('any')}</option>
              {places.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <select name="joy" defaultValue={filters.kind ?? ''} aria-label={t('fKind')} className="input">
              <option value="">{t('fKind')}: {t('any')}</option>
              {(Object.keys(KINDS) as SpendKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {t(KINDS[kind])}
                </option>
              ))}
              {expenseRows && <option value="expense">{t('bookExpense')}</option>}
            </select>
            <select name="payer" defaultValue={filters.payer ?? ''} aria-label={t('fPayer')} className="input">
              <option value="">{t('fPayer')}: {t('any')}</option>
              {(Object.keys(PAYER_LABEL) as SpendPayer[])
                .filter((payer) => payer !== 'own' || seesStaff)
                .map((payer) => (
                  <option key={payer} value={payer}>
                    {t(PAYER_LABEL[payer])}
                  </option>
                ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="men" value="1" defaultChecked={filters.mine} />
              {t('fMine')}
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="submit" className="btn-primary flex-1">
                {t('apply')}
              </button>
              <Link href={hrefWith({ from: period.from, to: period.to }, {})} className="btn-secondary">
                {t('clear')}
              </Link>
            </div>
          </form>
        </details>
        {filters.batchId && (
          <p className="text-sm">
            <Link href={filterHref({ partiya: undefined })} className="chip">
              🚛 {register.rows[0]?.batchCode ?? t('truck')} ✕
            </Link>
          </p>
        )}
        {!expenseRows && <p className="text-xs text-ink-500">{t('expenseRowsHidden')}</p>}
        <p className="text-xs text-ink-500" data-testid="sarf-register-count">
          {t('registerCount', { shown: register.rows.length, total: register.total })}
        </p>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {register.rows.map((row) => {
            const href = costTargetHref(actor, row, readable);
            const target =
              row.batchCode ?? row.receiptNumber ?? row.crateCode ?? row.pickupCode ?? (row.book === 'expense' ? t('bookExpense') : '—');
            const till = row.book === 'cost' ? tillView(actor.permissions, row) : null;
            const payerName = payerNameFor(row, seesStaff);
            return (
              <li key={`${row.book}:${row.id}`} className="space-y-0.5 p-2 text-sm [overflow-wrap:anywhere]" data-testid="sarf-row">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-ink-500">{row.day}</span>
                  <span className="font-semibold">{row.typeName}</span>
                  <span className="chip text-xs">{row.book === 'cost' ? t('bookCost') : t('bookExpense')}</span>
                  <span className="ml-auto font-mono tabular-nums">
                    {row.amount} {row.currency}
                    {row.usd !== null ? (
                      <span className="text-ink-500"> ≈ ${row.usd}</span>
                    ) : (
                      <span className="ml-1 rounded bg-warn/15 px-1 text-xs font-semibold text-warn">{t('noRateShort')}</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-2 text-xs text-ink-700">
                  {href ? (
                    <Link href={href} className="font-semibold underline">
                      {target}
                    </Link>
                  ) : (
                    <span className="font-semibold">{target}</span>
                  )}
                  {row.warehouseName && <span>🏬 {row.warehouseName}</span>}
                  <span>
                    {till?.paidFromTill
                      ? `🏦 ${till.accountName ?? t(PAYER_LABEL.kassa)}`
                      : row.book === 'expense' && row.accountName
                        ? `🏦 ${row.accountName}`
                        : (payerName ?? t(PAYER_LABEL[row.payer]))}
                  </span>
                  {row.authorName && <span className="text-ink-500">✍ {row.authorName}</span>}
                </div>
              </li>
            );
          })}
          {register.rows.length === 0 && <li className="p-3 text-sm text-ink-500">{t('empty')}</li>}
        </ul>
        {pages > 1 && (
          <div className="flex items-center gap-3 text-sm">
            {page > 1 && <Link href={hrefWith(base, { bet: String(page - 1) })}>← {t('prev')}</Link>}
            <span>
              {page} / {pages}
            </span>
            {page < pages && <Link href={hrefWith(base, { bet: String(page + 1) })}>{t('next')} →</Link>}
          </div>
        )}
      </section>
    </div>
  );
}
