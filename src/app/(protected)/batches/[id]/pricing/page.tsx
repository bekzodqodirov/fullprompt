import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { batches, currencies } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { balancesForClients, batchCharges } from '@/modules/wms/finance/service';
import {
  batchClientCostBreakdown,
  batchCostEntryCount,
  batchLandedCostByLot,
  unconvertedCostCount,
  type ClientCostPart,
  type LotLandedCost,
} from '@/modules/wms/costing/service';
import { batchLots, type BatchLot } from '@/modules/wms/batches/lots';
import { batchRoute } from '@/modules/wms/batches/internal';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { pricingSight, pricingView } from '@/modules/wms/finance/pricing-view';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { BackLink } from '@/components/back-link';
import { LightboxImg } from '@/components/lightbox-img';
import { PricingForm } from './pricing-form';
import { PageHeader } from '@/components/ui/page';

/**
 * Batch pricing (Phase 2.1, owner's flow): when the cargo is through customs
 * and ready, the VED manager + accountant set each client's negotiated price
 * here — every saved price becomes a ledger charge tied to this batch.
 *
 * 2026-09-24, the owner: «klient bo'yicha jamlab ko'rsatmasin — partiya
 * ichidagi tovarlar bo'yicha ko'rsatsin, tovar nomi, rasmi, prixodga linki,
 * bitim ulangan bo'lsa bitim ham». His answer on the price (1c): the price
 * STAYS one per client — so the screen opens each client into the goods that
 * rode, each with its own exact tannarx, and the price, the margin and the
 * form stay on the client. A per-goods price or margin is not printed: the
 * charge is one number for the client, and splitting it over the goods is an
 * allocation nobody made (deals/service.ts refuses the same invention).
 *
 * Membership is ONE rule for every figure here — rows, tannarx and the
 * header: the truck's RIDERS (`batches/riders.ts`, the rule its bills are
 * split over), an annulled box excluded. The old page had a second rule of
 * its own (departed movements, else the live pointer) and a third for the
 * header.
 *
 * A carton's fate is SAID, never subtracted (U35): a lost or still-missing
 * box keeps its cost share (#833) and stays in the row's kilos, so this page,
 * the grid and «Partiya foydasi» go on agreeing to the cent — but the person
 * typing a price per kilo sees how many kilos arrived, and the price/kg is
 * measured against those.
 *
 * Two readers since the owner's Q19 (2026-09-25, «ved hodimi … tannarxni
 * ham ko'rmasin»): `pricingSight` answers `full` (cost, price, margin) or
 * `price` (the goods, their kilos and fate, the price and the form — the VED
 * keeps pricing trucks, #108). For `price` the tannarx is never READ, not
 * merely left undrawn: the four cost reads below are skipped.
 */
export default async function BatchPricingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.manage')) redirect('/');
  const t = await getTranslations('finance');

  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) notFound();
  // The grid's rule and the batch card's: a warehouse-scoped reader sees a
  // truck that starts or ends at one of their warehouses, and no other.
  if (!inScope(actor, batch.originWarehouseId) && !inScope(actor, batch.destWarehouseId)) {
    notFound();
  }

  // An internal truck is never priced (owner's C1a, 2026-09-24): the page
  // stays — its cost per goods is still the question — but the price, the
  // margin and the form go, and the warning becomes the one he asked for:
  // «rasxodini yozmading». Decided BEFORE the reads, because it decides
  // which of them this reader may have at all.
  const route = await batchRoute(id);
  const internal = route?.internal ?? false;
  const sight = pricingSight(actor.permissions, internal);
  if (sight === 'none') redirect(`/batches/${id}`);
  const full = sight === 'full';

  const lots = await batchLots(id);
  const receiptIds = [...new Set(lots.map((lot) => lot.receiptId))];
  const [charges, currencyRows, lotCost, breakdown, unconverted, ownCosts] = await Promise.all([
    batchCharges(id),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
    full ? batchLandedCostByLot(id) : Promise.resolve(new Map<string, LotLandedCost>()),
    full ? batchClientCostBreakdown(id) : Promise.resolve(new Map<string, ClientCostPart[]>()),
    full ? unconvertedCostCount(id, receiptIds) : Promise.resolve(0),
    full ? batchCostEntryCount(id) : Promise.resolve(0),
  ]);

  const view = pricingView(
    lots,
    lotCost,
    charges.map(({ tx, clientCode, clientName }) => ({
      clientId: tx.clientId,
      clientCode,
      clientName,
      type: tx.type,
      amountUsd: Number(tx.amountUsd),
    })),
  );
  const balances = await balancesForClients([
    ...view.clients.map((group) => group.clientId),
    ...view.orphans.map((row) => row.clientId),
  ]);
  const costOf = (lot: BatchLot) => lotCost.get(lot.lotId);
  const money = (value: number) => `$${value.toFixed(2)}`;
  const { totals } = view;
  const dealLinks = canWriteDeal(actor.permissions);
  const today = tashkentDay();
  const currencyCodes = currencyRows.map((c) => c.code);

  const fateWords = (fate: { lost: number; missing: number; leftBehind: number }) =>
    [
      fate.lost > 0 ? t('fateLost', { count: fate.lost }) : null,
      fate.missing > 0 ? t('fateMissing', { count: fate.missing }) : null,
      fate.leftBehind > 0 ? t('fateLeftBehind', { count: fate.leftBehind }) : null,
    ].filter(Boolean);

  const lotRows = (list: BatchLot[]) => (
    <ul className="divide-y divide-line rounded-lg border border-line" data-testid="pricing-lots">
      {list.map((lot) => {
        const cost = costOf(lot);
        const id = codeIdentity(lot.marking, lot.clientCode);
        const photo = lot.goodsPhotoId ?? lot.boxPhotoId;
        const prev = cost ? Math.round((cost.totalUsd - cost.batchUsd) * 100) / 100 : 0;
        return (
          <li key={lot.lotId} className="flex gap-2 p-2" data-testid="pricing-lot">
            {photo ? (
              <LightboxImg attachmentId={photo} className="h-14 w-14 rounded object-cover" />
            ) : (
              <span className="h-14 w-14 shrink-0 rounded bg-surface-sunken" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <b className="num">
                  {id.main}
                  {lot.letter && `-${lot.letter}`}
                </b>{' '}
                <span className="text-ink-700">{lot.productNameZh}</span>
                {lot.productNameRu && <span className="text-ink-500"> · {lot.productNameRu}</span>}
              </p>
              <p className="text-xs text-ink-500">
                <Link
                  href={`/receipts/${lot.receiptId}`}
                  className="num whitespace-nowrap text-brand-700 underline-offset-2 hover:underline"
                >
                  {lot.receiptNumber ?? '—'}
                </Link>
                {lot.dealCode && (
                  <>
                    {' · '}
                    {dealLinks && lot.dealId ? (
                      <Link
                        href={`/bitimlar/${lot.dealId}`}
                        className="num text-brand-700 underline-offset-2 hover:underline"
                        data-testid="pricing-deal"
                      >
                        {lot.dealCode}
                      </Link>
                    ) : (
                      <span className="num" data-testid="pricing-deal">
                        {lot.dealCode}
                      </span>
                    )}
                    {lot.dealTitle && <span className="truncate"> {lot.dealTitle}</span>}
                  </>
                )}
              </p>
              <p className="font-mono text-xs tabular-nums text-ink-500">
                📦 {lot.onBatch}
                {lot.onBatch < lot.lotBoxCount && `/${lot.lotBoxCount}`} · {lot.kg} kg · {lot.m3} m³
              </p>
              {(lot.lostCount > 0 || lot.missingCount > 0 || lot.leftBehindCount > 0) && (
                <p className="text-xs font-semibold text-warn" data-testid="lot-fate">
                  ⚠{' '}
                  {fateWords({
                    lost: lot.lostCount,
                    missing: lot.missingCount,
                    leftBehind: lot.leftBehindCount,
                  }).join(' · ')}
                </p>
              )}
            </div>
            {full && (
              <div className="shrink-0 text-right">
                <p className="num text-sm font-bold" data-testid="lot-cost">
                  {money(cost?.totalUsd ?? 0)}
                </p>
                {/* Two short lines, not one long one: on a phone the goods
                    name beside it is what needs the width. */}
                {cost && cost.totalUsd > 0 && lot.kg > 0 && (
                  <p className="num text-xs text-ink-500">{(cost.totalUsd / lot.kg).toFixed(2)}/kg</p>
                )}
                {cost && cost.totalUsd > 0 && lot.m3 > 0 && (
                  <p className="num text-xs text-ink-500">{(cost.totalUsd / lot.m3).toFixed(0)}/m³</p>
                )}
                {prev > 0.009 && (
                  <p className="num text-xs text-ink-500" title={t('prevLegs')}>
                    ↩ {money(prev)}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <BackLink href={`/batches/${id}`} label={batch.code} />
      <PageHeader icon="wallet" title={t('pricingTitle')} />
      <p className="text-sm text-ink-500">{t('pricingHint')}</p>

      {(lots.length > 0 || view.orphans.length > 0) && (
        <div className={`card grid ${full ? 'grid-cols-3' : 'grid-cols-1'} gap-2 text-center`}>
          {full && (
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-500">{t('costLabel')}</p>
              <p className="num text-lg font-extrabold" data-testid="pricing-total-cost">
                {money(totals.costUsd)}
              </p>
            </div>
          )}
          {internal ? (
            <p className="col-span-2 self-center text-left text-xs text-ink-500" data-testid="pricing-internal">
              {t('internalBatch')}
            </p>
          ) : (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">{t('priceLabel')}</p>
                <p className="num text-lg font-extrabold" data-testid="pricing-total-price">
                  {money(totals.chargedUsd)}
                </p>
              </div>
              {full && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-500">{t('marginLabel')}</p>
                  <p
                    className={`num text-lg font-extrabold ${
                      totals.marginUsd >= 0 ? 'text-good' : 'text-bad'
                    }`}
                  >
                    {money(totals.marginUsd)}
                  </p>
                </div>
              )}
            </>
          )}
          <p className={`${full ? 'col-span-3' : ''} text-xs text-ink-500`}>
            {!internal && t('pricedOf', { priced: totals.priced, total: view.clients.length })}
            {full && totals.prevUsd > 0.009 && (
              <span className="num">
                {internal ? '' : ' · '}
                {t('prevLegs')}: {money(totals.prevUsd)}
              </span>
            )}
          </p>
          {internal && batch.departedAt && ownCosts === 0 && (
            <p className="col-span-3 text-xs font-semibold text-warn" data-testid="pricing-internal-no-costs">
              ⚠️ {t('internalNoCosts')}
            </p>
          )}
          {unconverted > 0 && (
            <p className="col-span-3 text-xs font-semibold text-warn" data-testid="pricing-unconverted">
              ⚠️ {t('unconvertedCosts', { count: unconverted })}
            </p>
          )}
        </div>
      )}

      {lots.length === 0 && view.orphans.length === 0 && (
        <p className="text-sm text-ink-500">{t('empty')}</p>
      )}

      {view.clients.map((group) => {
        const { chargedUsd: charged, costUsd, prevUsd, kg, m3, boxes, marginUsd: margin } = group;
        const balance = balances.get(group.clientId);
        const parts = breakdown.get(group.clientId) ?? [];
        // Some kilos did not arrive: the per-kilo PRICE is measured against
        // what did, the per-kilo COST stays over what was carried — and each
        // says which it is.
        const shortfall = group.fate.lost + group.fate.missing > 0;
        const priceKg = shortfall ? group.fate.arrivedKg : kg;
        return (
          <div key={group.clientId} className="card space-y-2" data-testid="pricing-client">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Link
                href={`/finance/${group.clientId}`}
                className="font-mono text-lg font-extrabold text-brand-700"
              >
                {group.code}
              </Link>
              <span className="min-w-0 truncate text-sm text-ink-700">{group.name}</span>
              <span className="num ml-auto whitespace-nowrap text-sm font-semibold">
                {boxes} 📦 · {kg} kg · {m3} m³
              </span>
            </div>

            {lotRows(group.lots)}

            {shortfall && (
              <p className="text-xs font-semibold text-warn" data-testid="pricing-arrived">
                ⚠ {t('arrivedLine', { boxes: group.fate.arrivedBoxes, kg: group.fate.arrivedKg })}
                {' — '}
                {fateWords(group.fate).join(' · ')}
                {group.dealId && group.dealCode && dealLinks && (
                  <>
                    {' · '}
                    <Link href={`/bitimlar/${group.dealId}`} className="num text-brand-700 underline">
                      {group.dealCode}
                    </Link>
                  </>
                )}
              </p>
            )}

            {/* Cost → price → margin, the three numbers the price is decided
                from (owner). The customs entered once for the whole truck
                reaches each lot as its own share. */}
            <div
              className={`grid ${internal || !full ? 'grid-cols-1' : 'grid-cols-3'} gap-2 rounded-lg bg-surface-sunken p-2 text-center text-sm`}
            >
              {full && (
              <div>
                <p className="text-xs text-ink-500">{t('costLabel')}</p>
                <p className="num font-bold" data-testid="client-cost">
                  {money(costUsd)}
                </p>
                {kg > 0 && costUsd > 0 && (
                  <p className="num text-xs text-ink-500">
                    {(costUsd / kg).toFixed(2)}
                    {shortfall ? t('perKgLoaded') : '/kg'}
                    {m3 > 0 && ` · ${(costUsd / m3).toFixed(0)}/m³`}
                  </p>
                )}
                {prevUsd > 0.009 && (
                  <p className="num text-xs text-ink-500">
                    {t('prevLegs')}: {money(prevUsd)}
                  </p>
                )}
                {/* «Nimalar o'tirganini ko'rsam» — the tannarx opened up:
                    every source and type that landed on this client's boxes.
                    A press, not a hover — phones have no hover. */}
                {parts.length > 0 && (
                  <details className="mt-1 text-left" data-testid="cost-breakdown">
                    <summary className="cursor-pointer text-xs text-brand-700">
                      {t('costDetail')}
                    </summary>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {parts.map((part, index) => (
                        <li key={index} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate text-ink-700">
                            {part.source} · {part.typeName}
                          </span>
                          <span className="num shrink-0">${part.usd.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              )}
              {!internal && (
                <>
              <div>
                <p className="text-xs text-ink-500">{t('priceLabel')}</p>
                <p className="num font-bold">{charged > 0 ? money(charged) : '—'}</p>
                {charged > 0 && priceKg > 0 && (
                  <p className="num text-xs text-ink-500">
                    {(charged / priceKg).toFixed(2)}
                    {shortfall ? t('perKgArrived') : '/kg'}
                  </p>
                )}
              </div>
              {full && (
              <div>
                <p className="text-xs text-ink-500">{t('marginLabel')}</p>
                <p
                  className={`num font-bold ${margin === null ? '' : margin >= 0 ? 'text-good' : 'text-bad'}`}
                >
                  {margin === null ? '—' : money(margin)}
                </p>
                {margin !== null && charged > 0 && (
                  <p className="num text-xs text-ink-500">{Math.round((margin / charged) * 100)}%</p>
                )}
              </div>
              )}
                </>
              )}
            </div>
            {full && costUsd === 0 && <p className="text-xs text-warn">⚠️ {t('noCostsYet')}</p>}

            {balance && !internal && (
              <p className="text-sm">
                {t('clientBalance')}:{' '}
                <span className={`num font-bold ${balance.balanceUsd > 0.009 ? 'text-bad' : 'text-good'}`}>
                  {money(balance.balanceUsd)}
                </span>
                <Link href={`/finance/${group.clientId}`} className="ml-2 text-xs text-brand-700 underline">
                  {t('openLedger')} →
                </Link>
              </p>
            )}

            {/* Said BEFORE the press (R3a): the price also becomes this
                job's money — its profit, its deferral, the seller's upsale. */}
            {!internal && group.dealCode && (
              <p className="text-xs text-ink-500" data-testid="pricing-to-deal">
                → {t('priceAlsoToDeal', { code: group.dealCode })}
              </p>
            )}
            {!internal && (
              <PricingForm
                clientId={group.clientId}
                batchId={id}
                currencies={currencyCodes}
                today={today}
              />
            )}
          </div>
        );
      })}

      {view.unclaimed.lots.length > 0 && (
        <div className="card space-y-2" data-testid="pricing-unclaimed">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="font-bold">❓ {t('unclaimedGroup')}</p>
            {full && (
              <span className="num ml-auto text-sm font-semibold">
                {t('costLabel')}: {money(view.unclaimed.costUsd)}
              </span>
            )}
          </div>
          {lotRows(view.unclaimed.lots)}
          <p className="text-xs text-ink-500">{t('unclaimedPriceLater')}</p>
        </div>
      )}

      {internal && totals.chargedUsd > 0 && (
        // Prices posted on an internal truck before the rule existed. They
        // stay on the ledger (nothing is voided behind anybody's back), and
        // they need a row that says where they came from.
        <div className="card space-y-2" data-testid="pricing-internal-charged">
          <p className="font-bold">{t('internalPricedBefore')}</p>
          <p className="text-xs text-ink-500">{t('internalPricedBeforeHint')}</p>
          <ul className="space-y-1 text-sm">
            {[
              ...view.clients
                .filter((group) => group.chargedUsd > 0)
                .map((group) => ({ clientId: group.clientId, code: group.code, name: group.name, usd: group.chargedUsd })),
              ...view.orphans.map((row) => ({ ...row, usd: row.chargedUsd })),
            ].map((row) => (
              <li key={row.clientId} className="flex items-baseline gap-2">
                <Link href={`/finance/${row.clientId}`} className="font-mono font-bold text-brand-700">
                  {row.code}
                </Link>
                <span className="min-w-0 truncate text-ink-700">{row.name}</span>
                <span className="num ml-auto font-semibold">{money(row.usd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!internal && view.orphans.length > 0 && (
        <div className="card space-y-2" data-testid="pricing-orphans">
          <p className="font-bold">{t('orphanCharges')}</p>
          <p className="text-xs text-ink-500">{t('orphanChargesHint')}</p>
          <ul className="space-y-1 text-sm">
            {view.orphans.map((row) => (
              <li key={row.clientId} className="flex items-baseline gap-2">
                <Link href={`/finance/${row.clientId}`} className="font-mono font-bold text-brand-700">
                  {row.code}
                </Link>
                <span className="min-w-0 truncate text-ink-700">{row.name}</span>
                <span className="num ml-auto font-semibold">{money(row.chargedUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
