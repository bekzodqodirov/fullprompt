import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenMyClients } from '@/modules/platform/clients/card-door';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { db } from '@/modules/platform/db/client';
import { withoutJit } from '@/modules/platform/db/no-jit';
import { groupDigits } from '@/modules/platform/telegram/format';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { mayOpenClientLedger } from '@/modules/wms/finance/scope';
import { unpricedGate } from '@/modules/wms/finance/unpriced';
import {
  issuingWarehouses,
  readUncollectedFilters,
  rowsInTab,
  uncollectedCargo,
  uncollectedPageQuery,
  uncollectedScope,
  waitRowKey,
  waitThresholds,
  waitingDebtors,
  waitingPriceGate,
  WAIT_TABS,
  type UncollectedRow,
  type WaitTab,
} from '@/modules/wms/issue/waiting';

/** How many rows the page draws; the header always counts all of them. */
const SHOWN = 200;

/**
 * «Olib ketilmagan yuk» (0116, the owner's 3a) — cargo standing in Tashkent or
 * Andijan waiting for its client, oldest first.
 *
 * Whose rows: `mayOpenMyClients` opens the page, `uncollectedScope` decides
 * the book (`seesAllClients` — a seller reads the clients they manage, the
 * office everybody — inside `warehouseScope`), and the home rows count with
 * the same answer. The same function the seller's morning message and the
 * svodka read, so a row on the screen and a line in Telegram are one fact
 * (#513).
 *
 * No money on the list. Of the two reasons the counter itself refuses the
 * cargo, «narxsiz» is a cargo fact every reader of the row gets (the Telegram
 * line carries it too); «qarz» is money's and appears only on rows whose
 * ledger this reader may open (`mayOpenClientLedger`).
 */
export default async function UncollectedPage({
  searchParams,
}: {
  searchParams: Promise<{ daraja?: string; ombor?: string; sotuvchi?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayOpenMyClients(actor)) redirect('/');
  const t = await getTranslations('uncollected');
  const params = await searchParams;

  const scope = uncollectedScope(actor);
  const seesAll = scope.seesAll;
  // Settings and the warehouse list on the POOL, before the read — the list
  // itself takes no pool of its own (#714).
  const [thresholds, whOptions, gate] = await Promise.all([
    waitThresholds(),
    issuingWarehouses(scope.warehouseIds),
    unpricedGate(),
  ]);
  const filters = readUncollectedFilters(params, {
    seesAll,
    warehouseIds: whOptions.map((w) => w.id),
  });
  // Everything waiting, once — the three tabs' counts are slices of it.
  const query = uncollectedPageQuery(scope, filters, new Date());
  // The whole company is a read over every waiting carton — JIT off for it
  // (0104's lesson); a seller's own book is a handful of rows.
  const list = seesAll
    ? await withoutJit((exec) => uncollectedCargo(exec, query))
    : await uncollectedCargo(db, query);

  const inTab = (tab: WaitTab) => rowsInTab(list.rows, tab, thresholds);
  const tabRows = inTab(filters.tab);
  const rows = tabRows.slice(0, SHOWN);
  const tabClients = new Set(tabRows.map((row) => row.clientId)).size;
  const tabBoxes = tabRows.reduce((sum, row) => sum + row.boxes, 0);

  // «Narxsiz» for every drawn row — the same tag the Telegram line carries;
  // «qarz» only for the rows whose ledger this reader may open.
  const moneyRows = rows.filter((row) => mayOpenClientLedger(actor, { salesManagerId: row.sellerId }));
  let unpriced = new Map<string, number>();
  let debtors = new Set<string>();
  let tagsFailed = false;
  if (rows.length > 0) {
    try {
      [unpriced, debtors] = await Promise.all([
        withoutJit((exec) => waitingPriceGate(exec, rows, gate)),
        moneyRows.length > 0
          ? waitingDebtors([...new Set(moneyRows.map((row) => row.clientId))])
          : Promise.resolve(new Set<string>()),
      ]);
    } catch (err) {
      console.warn('[uncollected] tags unavailable', err instanceof Error ? err.message : err);
      tagsFailed = true;
    }
  }
  const moneyKeys = new Set(moneyRows.map(waitRowKey));

  // Every seller who manages a client (and whoever is picked now, so the
  // select can render it, #171) — never only the sellers of the rows already
  // filtered, which would collapse the picker to the one it names.
  const sellers = seesAll ? await salesManagerOptions(filters.sellerId === 'none' ? null : filters.sellerId) : [];
  const sellerIds = new Set(sellers.map((s) => s.id));
  for (const row of list.rows) {
    if (row.sellerId && !sellerIds.has(row.sellerId)) {
      sellers.push({ id: row.sellerId, fullName: row.sellerName ?? '—' });
      sellerIds.add(row.sellerId);
    }
  }

  const current: Record<string, string> = {
    daraja: filters.tab === 'sariq' ? '' : filters.tab,
    ombor: filters.warehouseId ?? '',
    sotuvchi: filters.sellerId ?? '',
  };
  const hrefWith = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...current, ...patch })) if (value) next.set(key, value);
    const qs = next.toString();
    return `/my-clients/olib-ketilmagan${qs ? `?${qs}` : ''}`;
  };
  const tabLabel = (tab: WaitTab) =>
    tab === 'qizil'
      ? t('tabLevel', { n: thresholds.alarm })
      : tab === 'sariq'
        ? t('tabLevel', { n: thresholds.warn })
        : t('tabAll');
  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-4xl">
      <PageHeader icon="clock" title={t('title')} />
      <p className="text-sm text-ink-500">{t('hint')}</p>

      <div className="flex flex-wrap gap-2" data-testid="uncollected-tabs">
        {WAIT_TABS.map((tab) => (
          <Link
            key={tab}
            href={hrefWith({ daraja: tab === 'sariq' ? '' : tab })}
            data-testid={`uncollected-tab-${tab}`}
            className={filters.tab === tab ? 'chip-brand' : 'chip-neutral'}
          >
            {tabLabel(tab)} <b>{new Set(inTab(tab).map((row) => row.clientId)).size}</b>
          </Link>
        ))}
      </div>

      {whOptions.length > 1 && (
        <div className="flex flex-wrap gap-2" data-testid="uncollected-warehouses">
          <Link href={hrefWith({ ombor: '' })} className={filters.warehouseId ? 'chip-neutral' : 'chip-brand'}>
            {t('allWarehouses')}
          </Link>
          {whOptions.map((wh) => (
            <Link
              key={wh.id}
              href={hrefWith({ ombor: wh.id })}
              className={filters.warehouseId === wh.id ? 'chip-brand' : 'chip-neutral'}
            >
              {wh.code}
            </Link>
          ))}
        </div>
      )}

      {seesAll && (
        // A GET form: the other two filters ride as hidden inputs, or choosing
        // a seller would drop the tab and the warehouse (#171).
        <form method="get" className="flex flex-wrap items-center gap-2" data-testid="uncollected-seller-form">
          {current.daraja && <input type="hidden" name="daraja" value={current.daraja} />}
          {current.ombor && <input type="hidden" name="ombor" value={current.ombor} />}
          <label className="sr-only" htmlFor="uncollected-seller">
            {t('seller')}
          </label>
          <select
            id="uncollected-seller"
            name="sotuvchi"
            defaultValue={filters.sellerId ?? ''}
            className="input !w-auto min-w-0 max-w-full"
            data-testid="uncollected-seller"
          >
            <option value="">{t('allSellers')}</option>
            <option value="none">{t('noSeller')}</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-secondary">
            {t('show')}
          </button>
        </form>
      )}

      <p className="text-sm font-semibold text-ink-700" data-testid="uncollected-summary">
        {t('summary', { clients: tabClients, boxes: tabBoxes })}
        {tabRows.length > SHOWN && (
          <span className="ml-2 font-normal text-ink-500">{t('capped', { shown: SHOWN, total: tabRows.length })}</span>
        )}
      </p>
      {tagsFailed && <p className="text-xs text-warn">⚠ {t('tagsFailed')}</p>}

      {rows.length === 0 ? (
        <EmptyState icon="clock" title={t('empty')} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <WaitCard
              key={waitRowKey(row)}
              row={row}
              level={row.days === null ? 0 : row.days >= thresholds.alarm ? 2 : row.days >= thresholds.warn ? 1 : 0}
              unpriced={unpriced.get(waitRowKey(row)) ?? 0}
              debt={moneyKeys.has(waitRowKey(row)) && debtors.has(row.clientId)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A literal map — Tailwind compiles only what it can see. */
const BADGE: Record<0 | 1 | 2, string> = {
  0: 'chip-neutral',
  1: 'chip-warn',
  2: 'chip-bad',
};

/** «21.09» — the Tashkent day, printed the way the office writes it. */
function dayMonth(at: Date): string {
  const [, month, day] = tashkentDay(at).split('-');
  return `${day}.${month}`;
}

function WaitCard({
  row,
  level,
  unpriced,
  debt,
  t,
}: {
  row: UncollectedRow;
  level: 0 | 1 | 2;
  unpriced: number;
  debt: boolean;
  t: Awaited<ReturnType<typeof getTranslations<'uncollected'>>>;
}) {
  const phone = row.phones[0];
  // Each « · » travels WITH the part that follows it, so a wrap at 360 px can
  // never leave one dangling at a line's end (round 78's rule).
  const parts: { key: string; node: React.ReactNode; tone?: string }[] = [
    { key: 'wh', node: row.warehouseCode },
    { key: 'boxes', node: t('boxes', { n: row.boxes }) },
    { key: 'kg', node: `${groupDigits(row.kg)} kg` },
    { key: 'm3', node: `${groupDigits(row.m3)} m³` },
  ];
  if (row.goods) {
    parts.push({ key: 'goods', node: row.moreLots > 0 ? `${row.goods} ${t('moreLots', { n: row.moreLots })}` : row.goods });
  }
  parts.push({ key: 'seller', node: row.sellerName ?? t('noSeller') });
  if (row.leftover) parts.push({ key: 'leftover', node: t('leftover'), tone: 'font-semibold text-warn' });
  if (row.lastPickupAt) {
    parts.push({ key: 'pickup', node: t('lastPickup', { date: dayMonth(row.lastPickupAt) }) });
  }
  if (row.customs) parts.push({ key: 'customs', node: `🛃 ${t('customs')}` });
  if (unpriced > 0) parts.push({ key: 'unpriced', node: t('unpriced', { n: unpriced }), tone: 'font-semibold text-bad' });
  if (debt) parts.push({ key: 'debt', node: t('debt'), tone: 'font-semibold text-bad' });

  return (
    <div className="card !p-3" data-testid="uncollected-row" data-client={row.clientCode}>
      <Link href={`/admin/clients/${row.clientId}`} className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono font-extrabold text-brand-700">{row.clientCode}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-700">{row.clientName}</span>
        <span className={`${BADGE[level]} shrink-0`} data-testid="uncollected-days">
          {row.days === null ? '?' : t('days', { n: row.days })}
        </span>
      </Link>
      <div className="mt-1 flex flex-wrap items-baseline text-xs text-ink-500">
        {parts.map((part, i) => (
          <span key={part.key} className={`${part.tone ?? ''} [overflow-wrap:anywhere]`}>
            {i > 0 && ' · '}
            {part.node}
          </span>
        ))}
        {phone && (
          <a
            href={`tel:${phone.replace(/[^\d+]/g, '')}`}
            className="ml-auto pl-2 font-semibold text-brand-700"
            data-testid="uncollected-phone"
          >
            {phone}
          </a>
        )}
      </div>
    </div>
  );
}
