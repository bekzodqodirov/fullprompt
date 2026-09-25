import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { withoutJit } from '@/modules/platform/db/no-jit';
import { getActor } from '@/modules/platform/rbac/authorize';
import { calendarDay, tashkentDay, tashkentMinute } from '@/modules/platform/time/tashkent';
import { BackLink } from '@/components/back-link';
import { PageHeader } from '@/components/ui/page';
import { moneyOwnerFilter } from '@/modules/wms/finance/scope';
import { mayOpenPricing } from '@/modules/wms/finance/pricing-door';
import {
  unattachedChargesByClient,
  unpricedGate,
  unpricedReceiptsOn,
  type UnpricedReceipt,
} from '@/modules/wms/finance/unpriced';
import { daysSince } from '@/modules/wms/reports/dashboard-math';

/** The render is paged; the fetch covers everything (round 68's rule). */
const PAGE = 150;

/**
 * «Yetib kelgan, narx yozilmagan yuk» — the accountant's list (0104, the
 * owner's Q4 c: the whole history). Every prixod with landed cargo no price
 * covers, by `finance/unpriced.ts` — the rule the counter's ban refuses and
 * the dashboard counts, so a row here is exactly a carton the counter stops
 * (when it landed by road after the ban's instant) and clearing a row is
 * exactly what opens the counter.
 *
 * Same door as /finance, and the same money scope: a seller sees their own
 * clients (round 91). No tannarx is printed here — the VED keeps /finance
 * (the owner's Q19 follow-up) and must not read a cost on it. The truck cells
 * link to the pricing page only for a person that page admits
 * (`mayOpenPricing`): a row whose link bounces is worse than no row.
 */
export default async function UnpricedCargoPage({
  searchParams,
}: {
  searchParams: Promise<{ dan?: string; page?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) redirect('/');
  const t = await getTranslations('unpriced');
  const tf = await getTranslations('finance');
  const params = await searchParams;
  const from = calendarDay(params.dan) ?? undefined;
  const page = Math.max(1, Math.floor(Number(params.page) || 1));

  const gate = await unpricedGate();
  // The whole book: past JIT's cost line by shape (platform/db/no-jit.ts).
  const rows = await withoutJit((exec) =>
    unpricedReceiptsOn(
      exec,
      { kind: 'company', warehouseIds: undefined, ownerId: moneyOwnerFilter(actor), landedFrom: from },
      gate,
    ),
  );
  // The money most at risk first — cargo already handed over — then the
  // longest waiting.
  rows.sort(
    (a, b) =>
      Number(b.issuedBoxes > 0) - Number(a.issuedBoxes > 0) ||
      a.firstLandedAt.getTime() - b.firstLandedAt.getTime(),
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const slice = rows.slice((page - 1) * PAGE, page * PAGE);
  const card = await withoutJit((exec) =>
    unattachedChargesByClient(exec, [...new Set(slice.map((row) => row.clientId))]),
  );

  const byClient = new Map<string, UnpricedReceipt[]>();
  for (const row of slice) byClient.set(row.clientId, [...(byClient.get(row.clientId) ?? []), row]);

  const today = tashkentDay();
  const pricingLinks = mayOpenPricing(actor.permissions);
  // The prixod page asks the warehouse door; a person with no warehouse
  // scope opens every one, anybody else gets the number as plain text.
  const receiptLinks = !actor.warehouseScoped;
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  const hrefFor = (patch: { page?: number }) => {
    const q = new URLSearchParams();
    if (from) q.set('dan', from);
    if (patch.page && patch.page > 1) q.set('page', String(patch.page));
    const s = q.toString();
    return `/finance/narxsiz${s ? `?${s}` : ''}`;
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href="/finance" label={tf('title')} />
      <PageHeader icon="wallet" title={t('title')} />
      <p className="text-sm text-ink-500">{t('pageNote')}</p>
      <p
        className={`text-sm font-semibold ${gate.state === 'invalid' ? 'text-warn' : 'text-ink-700'}`}
        data-testid="unpriced-gate"
      >
        {gate.state === 'on'
          ? `🔒 ${t('gateLine', { when: tashkentMinute(gate.since) })}`
          : gate.state === 'off'
            ? t('gateOff')
            : `⚠️ ${t('gateInvalid')}`}
      </p>
      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="text-sm">
          <span className="label">{t('from')}</span>
          <input type="date" name="dan" defaultValue={from ?? ''} className="input" max={today} />
        </label>
        <button type="submit" className="btn-secondary">
          ✓
        </button>
      </form>

      {rows.length === 0 && (
        <p className="card text-sm text-good" data-testid="unpriced-empty">
          {t('empty')}
        </p>
      )}

      {[...byClient.entries()].map(([clientId, list]) => {
        const first = list[0]!;
        const extra = card.get(clientId);
        return (
          <div key={clientId} className="card space-y-2" data-testid="unpriced-client">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Link href={`/finance/${clientId}`} className="font-mono text-lg font-extrabold text-brand-700">
                {first.clientCode}
              </Link>
              <span className="min-w-0 truncate text-sm text-ink-700">{first.clientName}</span>
              {extra && extra.cardOnlyUsd > 0.009 && (
                <span className="chip text-xs text-warn" data-testid="unpriced-card-charged">
                  {t('cardCharged', { usd: money(extra.cardOnlyUsd) })}
                </span>
              )}
            </div>
            <ul className="divide-y divide-line">
              {list.map((row) => (
                <li key={row.receiptId} className="space-y-1 py-2 text-sm" data-testid="unpriced-row">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    {receiptLinks ? (
                      <Link href={`/receipts/${row.receiptId}`} className="num font-semibold text-brand-700 underline">
                        {row.number ?? '—'}
                      </Link>
                    ) : (
                      <span className="num font-semibold">{row.number ?? '—'}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-ink-700">{row.goods}</span>
                    <span className="num whitespace-nowrap text-xs text-ink-500">
                      {t('waitingDays', { n: daysSince(row.firstLandedAt, today) })}
                    </span>
                  </p>
                  <p className="num text-xs text-ink-600">
                    📦 {row.boxes} · {row.kg} kg · {row.m3} m³
                    {row.arrivalTrucks.length > 0 && ' · '}
                    {row.arrivalTrucks.map((truck, index) => (
                      <span key={truck.batchId}>
                        {index > 0 && ', '}
                        {pricingLinks ? (
                          <Link
                            href={`/batches/${truck.batchId}/pricing`}
                            className="font-mono text-brand-700 underline"
                            data-testid="unpriced-truck"
                          >
                            {truck.code}
                          </Link>
                        ) : (
                          <span className="font-mono" data-testid="unpriced-truck">
                            {truck.code}
                          </span>
                        )}
                      </span>
                    ))}
                    {row.dealCode && <span className="font-mono"> · {row.dealCode}</span>}
                  </p>
                  <p className="flex flex-wrap gap-1.5">
                    {row.issuedBoxes > 0 && (
                      <span className="chip bg-bad/10 text-xs text-bad" data-testid="unpriced-issued">
                        {t('issued', { n: row.issuedBoxes })}
                      </span>
                    )}
                    {row.gatedBoxes > 0 && (
                      <span className="chip bg-bad/10 text-xs text-bad" data-testid="unpriced-blocked">
                        {t('blocked')}
                      </span>
                    )}
                    {row.elsewhere.map((e) => (
                      <span key={e.batchId} className="chip text-xs text-warn" data-testid="unpriced-elsewhere">
                        {t('elsewhere', { code: e.code, usd: money(e.usd) })}
                      </span>
                    ))}
                    {row.walkIn && (
                      <span className="chip text-xs text-ink-600" data-testid="unpriced-walkin">
                        {t('walkIn')}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {pages > 1 && (
        <p className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={hrefFor({ page: page - 1 })} className="btn-secondary px-3">
              ←
            </Link>
          ) : (
            <span />
          )}
          <span className="text-ink-500">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={hrefFor({ page: page + 1 })} className="btn-secondary px-3">
              {t('more', { n: rows.length - page * PAGE })} →
            </Link>
          ) : (
            <span />
          )}
        </p>
      )}
    </div>
  );
}
