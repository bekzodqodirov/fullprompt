import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { and, eq, sql } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, scanEvents } from '@/modules/platform/db/schema';
import { getActor, type Actor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import {
  batchTabHref,
  batchTabsFor,
  mayOpenBatchCard,
  mayOpenBatchCosts,
  mayOpenBatchVed,
  type BatchTab,
} from '@/modules/wms/batches/card-door';
import { batchLoadProgress, loadBatchHead, type BatchHead } from '@/modules/wms/batches/card-head';
import { batchDocsPending } from '@/modules/wms/batches/docs-pending';
import { batchLots } from '@/modules/wms/batches/lots';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { formerCodesOf, formerNames, type FormerCodeRow } from '@/modules/wms/batches/former-codes';
import { mayRenameBatch, renameDoorOpens, renameStageOf } from '@/modules/wms/batches/rename-door';
import {
  batchCarriageOf,
  batchCostEntryCount,
  batchCostSheet,
  batchLandedCostByLot,
  type LotLandedCost,
} from '@/modules/wms/costing/service';
import { costSightFor } from '@/modules/wms/costing/cost-sight';
import {
  pricingChargesOf,
  pricingSight,
  pricingView,
  tripPricedCount,
  type PricingView,
} from '@/modules/wms/finance/pricing-view';
import { batchCharges, batchTripCoverage } from '@/modules/wms/finance/service';
import { isContinuationTrip, tripKind } from '@/modules/wms/reports/dashboard-math';
import { countAcceptPanel } from '@/modules/wms/scanning/count-accept';
import { countDoorFor, mayCountMove } from '@/modules/wms/scanning/count-door';
import { countedOnTruck } from '@/modules/wms/scanning/count-load';
import { qrlessUncountedByTruck } from '@/modules/wms/scanning/service';
import { aboardFilter, batchMissingBoxes, remainingToUnload } from '@/modules/wms/scanning/unload';
import { batchTnvedProducts, missingTnvedCount } from '@/modules/wms/tnved/batch-lots';
import { devicesForBatch } from '@/modules/wms/tracking/devices';
import { truckOnRoadRow } from '@/modules/wms/tracking/on-road';
import { BackLink } from '@/components/back-link';
import { compactUsd, num } from '@/components/charts/format';
import { truckRoadWords } from '@/components/truck-road';
import { BatchActions } from './batch-actions';
import { BatchCodeForm } from './batch-code-form';
import { ProfitTracked } from './profit-tracked';

/**
 * ONE card per truck (owner's 3a, docs/CARD-TABS.md): six tabs — six URLs,
 * each asking its own door — under one header that every tab page renders
 * around its body. A server component and not a Next layout: a layout would
 * also wrap the full-screen scan screens, would be KEPT (and go stale) across
 * tab switches, and could not light its tab without a client hook.
 *
 * The header was measured before it was built (four-lens review): the first
 * draft put a loader's contents list below the fold and the accountant's
 * money tabs 1 250 px down on a phone. So it says each thing once, draws a
 * button only for somebody who may press it, keeps the KPI tiles for lg, and
 * moved the unloading controls (812 px for three missing lots) into the
 * «Tushirish» tab they are the work of.
 *
 * Every number here is the destination tab's OWN figure (#513), read through
 * the same per-request memoised function the tab's body calls, and shown only
 * to that tab's audience. The money reads keep the pricing page's shape: for a
 * price-only reader the tannarx is never READ (Q19), not merely left undrawn.
 */

// Literal maps: Tailwind compiles only classes it can see.
const STATUS_CLASS: Record<string, string> = {
  forming: 'bg-surface-sunken text-ink-700',
  loading: 'bg-warn/10 text-warn',
  in_transit: 'bg-brand-50 text-brand-700',
  arrived: 'bg-good/10 text-good',
  unloaded: 'bg-good/10 text-good',
  closed: 'bg-surface-sunken text-ink-500',
  cancelled: 'bg-bad/10 text-bad',
};
const LADDER = ['forming', 'loading', 'in_transit', 'arrived', 'unloaded', 'closed'] as const;
type StepState = 'done' | 'now' | 'todo';
const STEP_BAR: Record<StepState, string> = {
  done: 'bg-good',
  now: 'bg-brand-600',
  todo: 'bg-line-strong',
};
const TILE_TONE = {
  plain: 'text-ink-900',
  good: 'text-good',
  bad: 'text-bad',
  muted: 'text-ink-500',
} as const;

/**
 * «60 kg · 0.18 m³» — ONE spelling for the Tarkib table's Σ line and the
 * header's «Yuk» tile, which print the same two numbers (#513). The tile
 * first used the charts' one-decimal m³, and the owner's first screenshot
 * read «0.2 m³» on the tile over «0.18 m³» on the table beneath it.
 */
export function cargoLine(kg: number, m3: number): string {
  return `${Math.round(kg)} kg · ${Math.round(m3 * 100) / 100} m³`;
}

/** The tab strip's words — short on every width; a body's own h2 says the rest. */
async function tabLabels(head: BatchHead): Promise<Record<BatchTab, string>> {
  const t = await getTranslations('batches');
  const tc = await getTranslations('batchCard');
  const tf = await getTranslations('finance');
  const loading = ['forming', 'loading', 'cancelled'].includes(head.batch.status);
  return {
    tarkib: t('contents'),
    yuklash: loading ? tc('tabLoading') : tc('tabUnloading'),
    xarajat: t('costs'),
    // An internal leg's money page is a cost page (C1a).
    narx: head.internal ? tf('costLabel') : tf('priceLabel'),
    bojxona: tc('tabCustoms'),
    mashina: tc('tabTruck'),
  };
}

/**
 * «B-00123 · Xarajatlar» — six browser tabs of one truck no longer all read
 * «GSR LOGISTICS», and the route announcer has a title that changes. Only
 * for someone the card admits: a code is not a title a stranger's 404 wears.
 */
export async function batchTabMetadata(id: string, tab: BatchTab): Promise<Metadata> {
  const actor = await getActor();
  if (!actor) return {};
  const head = await loadBatchHead(id);
  if (!head || !mayOpenBatchCard(actor, head.batch)) return {};
  const labels = await tabLabels(head);
  return { title: `${head.batch.code} · ${labels[tab]}` };
}

/** A header figure's read failing must not take every tab down (cache() memoises errors). */
async function soft<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[batch-card] ${what}`, err);
    return null;
  }
}

interface Todo {
  tab: BatchTab;
  hash?: string;
  label: string;
  count?: number;
  testid: string;
}

export async function BatchCard({
  head,
  actor,
  active,
  children,
}: {
  head: BatchHead;
  actor: Actor;
  active: BatchTab;
  children: ReactNode;
}) {
  const { batch } = head;
  const id = batch.id;
  const t = await getTranslations('batches');
  const tc = await getTranslations('batchCard');
  const tf = await getTranslations('finance');
  const tu = await getTranslations('unloading');
  const tcount = await getTranslations('countLoad');
  const tca = await getTranslations('countAccept');
  const tcargo = await getTranslations('cargo');
  const tclients = await getTranslations('clients');
  const format = await getFormatter();

  // «Sanab yuklash» (0112) — region A. The ⚠ chip counts the cartons beyond
  // the plan that RIDE the truck, once each (decision 25): an office count
  // dialled down keeps its scan events.
  const onSpotCount = (
    await db
      .select({ n: sql<number>`count(DISTINCT ${scanEvents.boxId})` })
      .from(scanEvents)
      .innerJoin(boxes, eq(boxes.id, scanEvents.boxId))
      .where(
        and(
          eq(scanEvents.batchId, id),
          eq(scanEvents.addedOnSpot, true),
          eq(scanEvents.type, 'load'),
          aboardFilter(id),
        ),
      )
  )[0]!.n;
  const loadingNow = ['forming', 'loading'].includes(batch.status);
  const unloadingNow = ['in_transit', 'arrived'].includes(batch.status);
  const departed = batch.departedAt !== null;
  const cancelled = batch.status === 'cancelled';
  const tabs = batchTabsFor(actor, head.internal);
  const labels = await tabLabels(head);

  // What rode — the Tarkib table's own rows (the riders, void excluded, the
  // membership of every money tab), so the tile and the table are one read.
  const lots = await batchLots(id);
  const progress = loadingNow ? await batchLoadProgress(id) : null;
  const totalPlanned = progress ? [...progress.values()].reduce((a, p) => a + p.planned, 0) : 0;
  const totalLoaded = progress ? [...progress.values()].reduce((a, p) => a + p.loaded, 0) : 0;
  const counted = loadingNow ? await countedOnTruck(id) : null;
  const overArrived = departed
    ? Number(
        (
          await db
            .select({ n: sql<number>`count(DISTINCT ${scanEvents.boxId})` })
            .from(scanEvents)
            .where(sql`${scanEvents.batchId} = ${id} AND ${scanEvents.type} = 'unload' AND ${scanEvents.addedOnSpot} = true`)
        )[0]?.n ?? 0,
      )
    : 0;

  const canVehicle = actor.permissions.has('batches.vehicle_info');
  // The pairing code is the LOADER's (the driver's phone is set up at the
  // truck); after departure it lives on the «Mashina» tab.
  const devices = loadingNow && canVehicle ? await devicesForBatch(id) : [];
  const pairCode = devices.find((device) => device.pairCode)?.pairCode ?? null;
  const road = unloadingNow ? await soft('road', () => truckOnRoadRow(id)) : null;
  const roadWords = road ? await truckRoadWords() : null;

  // Money, each figure behind its own tab's door.
  const costDoor = mayOpenBatchCosts(actor.permissions);
  const costSheet = costDoor ? await soft('cost sheet', () => batchCostSheet(id, costSightFor(actor))) : null;
  const ownCostCount = costDoor && departed ? await soft('cost count', () => batchCostEntryCount(id)) : null;
  const sight = pricingSight(actor.permissions, head.internal);
  const full = sight === 'full';
  const pricing: { view: PricingView; priced: number; continuation: boolean; carriers: string } | null =
    sight !== 'none' && !head.internal
      ? await soft('pricing', async () => {
          const [charges, lotCost, coverage, carriage] = await Promise.all([
            batchCharges(id),
            full ? batchLandedCostByLot(id) : Promise.resolve(new Map<string, LotLandedCost>()),
            batchTripCoverage(id),
            batchCarriageOf(id),
          ]);
          const view = pricingView(lots, lotCost, pricingChargesOf(charges));
          // The pricing page's own count (1a): a client priced on the China
          // truck or the deal counts, as the handover gate lets them out.
          return {
            view,
            priced: tripPricedCount(view.clients, coverage),
            // «Davomi» — the pricing page's own word (2026-09-30).
            continuation: isContinuationTrip(carriage),
            carriers: carriage.carriers.map((row) => row.code).join(', '),
          };
        })
      : null;

  // «Qolgan ishlar» — each item asks the door of the exact thing it links to.
  const todos: Todo[] = [];
  const inDest = inScope(actor, batch.destWarehouseId);
  const destShortcut = actor.permissions.has('receipts.void') && inDest;
  const destCount = mayCountMove(actor, batch.destWarehouseId);
  if (unloadingNow && (actor.permissions.has('scan.unload') || destShortcut || destCount)) {
    const remaining = (await remainingToUnload(id)).length;
    if (remaining > 0) {
      todos.push({ tab: 'yuklash', label: tc('todoRemaining'), count: remaining, testid: 'batch-todo-remaining' });
    }
  }
  if (departed && (destShortcut || destCount)) {
    const missing = (await batchMissingBoxes(id)).length;
    if (missing > 0) {
      todos.push({ tab: 'yuklash', hash: 'missing', label: tu('missingTitle'), count: missing, testid: 'batch-todo-missing' });
    }
  }
  if (loadingNow && countDoorFor(actor, batch.originWarehouseId)) {
    const awaiting = (await qrlessUncountedByTruck(db, [id])).get(id) ?? [];
    if (awaiting.length > 0) {
      todos.push({ tab: 'yuklash', hash: 'count-load', label: tc('todoCountLoad'), count: awaiting.length, testid: 'batch-todo-count-load' });
    }
  }
  if (unloadingNow && destCount) {
    // The office's count work: lots the phone cannot scan (a mode) with
    // cartons still aboard — «awaiting» alone is every carton on the truck.
    const panel = await countAcceptPanel(id);
    const lotsToCount = panel.lots.filter((lot) => lot.mode !== null && lot.awaiting > 0).length;
    if (lotsToCount > 0) {
      todos.push({ tab: 'yuklash', hash: 'count-accept', label: tc('todoCountAccept'), count: lotsToCount, testid: 'batch-todo-count-accept' });
    }
  }
  if (costDoor && ownCostCount === 0) {
    todos.push({ tab: 'xarajat', label: tc('todoNoCosts'), testid: 'batch-todo-no-costs' });
  }
  if (mayOpenBatchVed(actor.permissions) && head.crossesBorder && !batch.customsClearedAt && !cancelled) {
    const missingCodes = missingTnvedCount(await batchTnvedProducts(id, departed));
    if (missingCodes > 0) {
      todos.push({ tab: 'bojxona', label: tc('todoTnved'), count: missingCodes, testid: 'batch-todo-tnved' });
    }
  }
  if (actor.permissions.has('ved.docs') && unloadingNow && (await batchDocsPending(id))) {
    todos.push({ tab: 'bojxona', hash: 'hujjatlar', label: tc('todoAgent'), testid: 'batch-todo-agent' });
  }
  const badge = (tab: BatchTab) => todos.filter((todo) => todo.tab === tab).length;
  const tabHref = (tab: BatchTab, hash = 'tabs') => `${batchTabHref(id, tab)}#${hash}`;

  // The ✏️ on the code: the SAME predicate the service obeys (rename-door.ts),
  // so a drawn pencil never bounces. The aboard count is the unload screen's
  // own (cached, the todo list reads it) and is read only for a person whose
  // door is open at all.
  const renameStage = renameDoorOpens(actor, batch)
    ? renameStageOf(batch.status, unloadingNow ? (await remainingToUnload(id)).length : 0)
    : 'closed';
  const renameMode = renameStage !== 'closed' && mayRenameBatch(actor, batch, renameStage) ? renameStage : 'off';
  // «Oldingi nomi» — every name the truck wore ON THE ROAD (a name changed
  // before departure frees, former-codes.ts), for everyone who may open the
  // card (the papers keep them); the who/why log only for the truck's readers.
  const renames: FormerCodeRow[] = (await soft('former', () => formerCodesOf(id))) ?? [];
  const former = formerNames(renames, batch.code);

  // The stage buttons this person can press — and only those.
  const inOrigin = inScope(actor, batch.originWarehouseId);
  const canLoad = actor.permissions.has('scan.load') && loadingNow;
  const canUnload = actor.permissions.has('scan.unload') && unloadingNow;
  const canFinish = actor.permissions.has('scan.load') && inOrigin;
  // Owner's rule: the origin-warehouse loader can also send the truck off
  // (with a confirm dialog); closing/arrival stays manager-only.
  const canDepart = actor.permissions.has('batches.depart_close') || (actor.permissions.has('scan.load') && inOrigin);
  const canCancel = actor.permissions.has('batches.depart_close');

  // The ladder: the status chip's own words, dated where a column is.
  const now = LADDER.indexOf(batch.status as (typeof LADDER)[number]);
  const stepDate: Partial<Record<(typeof LADDER)[number], Date | null>> = {
    forming: batch.createdAt,
    in_transit: batch.departedAt,
    arrived: batch.arrivedAt,
    closed: batch.closedAt,
  };
  const stateOf = (i: number): StepState =>
    batch.status === 'closed' || i < now ? 'done' : i === now ? 'now' : 'todo';

  // The tiles, from lg (on a phone they repeated the tab below them).
  const clientIds = new Set(lots.flatMap((lot) => (lot.clientId ? [lot.clientId] : [])));
  const unclaimed = new Set(lots.flatMap((lot) => (lot.clientId ? [] : [lot.marking ?? lot.receiptId])));
  const receiptCount = new Set(lots.map((lot) => lot.receiptId)).size;
  const boxTotal = lots.reduce((a, lot) => a + lot.onBatch, 0);
  const kgTotal = lots.reduce((a, lot) => a + lot.kg, 0);
  const m3Total = lots.reduce((a, lot) => a + lot.m3, 0);
  const margin = pricing && full ? pricing.view.totals : null;
  const marginKind = margin
    ? tripKind({
        internal: false,
        continuation: pricing?.continuation ?? false,
        revenueUsd: margin.chargedUsd,
        profitUsd: margin.marginUsd,
      })
    : null;

  return (
    <div className="space-y-3">
      {/* /batches bounces the accountant, the sellers and the viewer, who reach
          a truck from money and cargo screens — a back link that bounces is
          worse than none (#1023). */}
      {mayReadBatches(actor.permissions) && <BackLink href="/batches" label={t('title')} />}

      <div className="card space-y-2 !p-3" data-testid="batch-head">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <BatchCodeForm
            batchId={batch.id}
            code={batch.code}
            mode={renameMode}
            ownFormer={former}
            // A VED fact: sent only to a screen that draws the road panel
            // (the one place it is printed), never in every card's payload.
            sentToAgentAt={renameMode === 'road' ? (batch.sentToAgentAt ?? null) : null}
          />
          <span className="font-mono text-sm font-bold">
            {head.originCode} → {head.destCode}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-sm font-semibold ${
              STATUS_CLASS[batch.status] ?? 'bg-surface-sunken text-ink-700'
            }`}
            data-testid="batch-status"
          >
            {t(`statuses.${batch.status}`)}
            {now >= 0 && <span className="lg:hidden"> · {now + 1}/{LADDER.length}</span>}
          </span>
          {actor.permissions.has('finance.reports') && (
            <ProfitTracked batchId={batch.id} tracked={batch.profitTracked} compact />
          )}
          <span className="ml-auto hidden text-xs text-ink-500 lg:inline">
            {format.dateTime(batch.createdAt, { dateStyle: 'short' })}
          </span>
        </div>

        {former.length > 0 && (
          <div className="space-y-1">
            <p
              className="w-full text-xs text-ink-500 [overflow-wrap:anywhere]"
              data-testid="batch-former-codes"
            >
              {t('rename.former', { codes: former.join(' → ') })}
            </p>
            {mayReadBatches(actor.permissions) && (
              <details className="text-xs" data-testid="batch-rename-log">
                <summary className="cursor-pointer text-ink-500">{t('rename.log')}</summary>
                <ol className="mt-1 space-y-1">
                  {renames.map((row, i) => (
                    <li key={i} className="[overflow-wrap:anywhere]">
                      {t('rename.logRow', {
                        date: format.dateTime(row.at, { dateStyle: 'short', timeStyle: 'short' }),
                        who: row.by ?? '—',
                        from: row.from,
                        to: row.to,
                      })}
                      <span className="block text-ink-500">{row.reason}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}

        {!cancelled && now >= 0 && (
          <ol aria-label={tc('ladderAria')} className="flex gap-1" data-testid="batch-ladder">
            {LADDER.map((step, i) => {
              const date = stepDate[step];
              return (
                <li key={step} className="min-w-0 flex-1" aria-current={i === now ? 'step' : undefined}>
                  <span aria-hidden className={`block h-1.5 rounded-full ${STEP_BAR[stateOf(i)]}`} />
                  <span
                    className={`sr-only lg:not-sr-only lg:mt-1 lg:block lg:text-2xs lg:leading-tight ${
                      i === now ? 'lg:font-bold lg:text-ink-900' : 'lg:text-ink-500'
                    }`}
                  >
                    {t(`statuses.${step}`)}
                    {date && (
                      <time dateTime={new Date(date).toISOString()} className="block font-normal">
                        {format.dateTime(new Date(date), { dateStyle: 'short' })}
                      </time>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {loadingNow && (
          <p className="text-sm">
            <b>
              {totalLoaded}/{totalLoaded + totalPlanned} 📦
            </b>{' '}
            {t('loadedOfPlanned')}
            {Number(onSpotCount) > 0 && (
              <span className="ml-2 rounded bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
                +{onSpotCount} {t('onSpot')}
              </span>
            )}
            {counted && counted.cartons > 0 && (
              <span
                data-testid="batch-counted-chip"
                className="ml-2 rounded bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700"
              >
                {tcount('countedChip', { n: counted.cartons })}
              </span>
            )}
          </p>
        )}

        {departed && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-700" data-testid="batch-facts">
            <span>🚀 {format.dateTime(batch.departedAt!, { dateStyle: 'short', timeStyle: 'short' })}</span>
            {head.crossesBorder && (
              <span data-testid="batch-customs-fact">
                · {t('customs')}:{' '}
                {batch.customsClearedAt
                  ? `✅ ${format.dateTime(batch.customsClearedAt, { dateStyle: 'short' })}`
                  : '—'}
              </span>
            )}
            {Number(onSpotCount) > 0 && (
              <span className="rounded bg-orange-100 px-2 py-0.5 font-semibold text-orange-800">
                +{onSpotCount} {t('onSpot')}
              </span>
            )}
            {overArrived > 0 && (
              <span
                className="rounded bg-orange-100 px-2 py-0.5 font-semibold text-orange-800"
                data-testid="batch-over-arrived"
              >
                +{overArrived} {tca('overArrived')}
              </span>
            )}
          </p>
        )}

        {road && roadWords && (
          <p className="text-xs text-ink-700" data-testid="batch-road">
            <b>{roadWords.word(road)}</b> · {roadWords.sentence(road)}
          </p>
        )}

        {loadingNow && pairCode && (
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs text-ink-500">📲 {t('pairCodeLabel')}</span>
            <span
              data-testid="batch-pair-code"
              className="font-mono text-xl font-extrabold tracking-widest text-brand-700"
            >
              {pairCode}
            </span>
          </p>
        )}

        {(canLoad || canUnload) && (
          <div className="flex flex-wrap gap-2">
            {canLoad && (
              <Link
                href={`/batches/${batch.id}/load`}
                className="btn-primary flex-1 whitespace-nowrap px-3"
                data-testid="open-loading"
              >
                📱 {t('startLoading')}
              </Link>
            )}
            {canUnload && (
              <Link
                href={`/batches/${batch.id}/unload`}
                className="btn-primary flex-1 whitespace-nowrap px-3"
                data-testid="open-unloading"
              >
                📤 {t('startUnloading')}
              </Link>
            )}
          </div>
        )}
        {loadingNow && (canFinish || canDepart || canCancel) && (
          <BatchActions batchId={batch.id} canFinish={canFinish} canDepart={canDepart} canCancel={canCancel} />
        )}
      </div>

      <div className="hidden gap-3 lg:grid lg:grid-cols-5" data-testid="batch-tiles">
        <Tile
          href={active === 'tarkib' ? null : tabHref('tarkib')}
          label={tcargo('title')}
          value={tc('tileBoxes', { n: num(boxTotal) })}
          lines={[cargoLine(kgTotal, m3Total)]}
          testid="batch-tile-cargo"
        />
        <Tile
          href={active === 'tarkib' ? null : tabHref('tarkib')}
          label={tclients('title')}
          value={num(clientIds.size)}
          lines={[
            tc('tileReceipts', { n: receiptCount }),
            unclaimed.size > 0 ? tc('tileUnclaimed', { n: unclaimed.size }) : null,
          ]}
          testid="batch-tile-clients"
        />
        {costSheet && costSheet.totalUsd !== null && (
          <Tile
            href={active === 'xarajat' ? null : tabHref('xarajat')}
            label={t('costs')}
            value={compactUsd(costSheet.totalUsd)}
            exact={String(costSheet.totalUsd)}
            // The Σ line's own warning: entries with no dollar value yet.
            lines={[costSheet.unconverted > 0 ? `⚠️ ${costSheet.unconverted}` : null]}
            testid="batch-tile-costs"
          />
        )}
        {pricing && (
          <Tile
            href={active === 'narx' ? null : tabHref('narx')}
            label={tc('tilePriced')}
            value={`${pricing.priced} / ${pricing.view.clients.length}`}
            testid="batch-tile-priced"
          />
        )}
        {margin && (
          <Tile
            href={active === 'narx' ? null : tabHref('narx')}
            label={tf('marginLabel')}
            value={
              marginKind === 'unpriced'
                ? tc('tileNoPrice')
                : marginKind === 'continuation'
                  ? tc('tileContinuation')
                  : compactUsd(margin.marginUsd)
            }
            exact={marginKind === 'unpriced' || marginKind === 'continuation' ? undefined : String(margin.marginUsd)}
            tone={marginKind === 'unpriced' || marginKind === 'continuation' ? 'muted' : marginKind === 'loss' ? 'bad' : 'good'}
            lines={
              marginKind === 'continuation'
                ? [tc('tileContinuationLine', { codes: pricing?.carriers ?? '' })]
                : [
                    `${tf('priceLabel')} ${compactUsd(margin.chargedUsd)} · ${tf('costLabel')} ${compactUsd(margin.costUsd)}`,
                    margin.prevUsd > 0.009 ? `${tf('prevLegs')}: ${compactUsd(margin.prevUsd)}` : null,
                    margin.laterUsd > 0.009 ? `${tf('laterLegs')}: ${compactUsd(margin.laterUsd)}` : null,
                  ]
            }
            testid="batch-tile-margin"
          />
        )}
      </div>

      {todos.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="batch-todo">
          <span className="section-title">⚠️ {tc('todoTitle')}</span>
          {todos.map((todo) => (
            <Link
              key={todo.testid}
              href={tabHref(todo.tab, todo.hash ?? 'tabs')}
              data-testid={todo.testid}
              className="chip chip-warn min-h-9 max-w-full [overflow-wrap:anywhere]"
            >
              {todo.label}
              {todo.count !== undefined && <b className="font-mono tabular-nums">{num(todo.count)}</b>}
            </Link>
          ))}
        </div>
      )}

      {/* The strip. On a phone a 3-column grid of chips — every tab and badge
          visible, no JS; from md a wrapping row. Each link lands on `#tabs`:
          on a phone that scrolls the strip under the app bar, so a tap SHOWS
          the new tab instead of the same header; from lg the margin is taller
          than the header, which clamps the scroll to the top and keeps the
          whole header in view. A link from Telegram carries no hash. */}
      <nav
        id="tabs"
        tabIndex={-1}
        aria-label={tc('tabsAria', { code: batch.code })}
        data-testid="batch-tabs"
        className="grid scroll-mt-16 grid-cols-3 gap-1 focus:outline-none md:flex md:flex-wrap lg:scroll-mt-[60rem]"
      >
        {tabs.map((tab) => {
          const lit = tab === active;
          const n = badge(tab);
          return (
            <Link
              key={tab}
              href={tabHref(tab)}
              aria-current={lit ? 'page' : undefined}
              data-testid={`batch-tab-${tab}`}
              // 12 px on a phone: a third of 328 px holds «Себестоимость» on
              // one line there, and a label that still does not fit wraps
              // rather than being cut to «Тамо…» (measured, first draft).
              className={`flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-lg px-1.5 text-center text-xs font-semibold leading-tight md:px-3 md:text-sm ${
                lit ? 'bg-brand-50 text-brand-800' : 'bg-surface-sunken text-ink-700 hover:bg-line'
              }`}
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{labels[tab]}</span>
              {n > 0 && (
                <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-xs text-warn" aria-label={`⚠️ ${n}`}>
                  {n}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-4" data-testid="batch-tab-body">
        {children}
      </div>
    </div>
  );
}

/** A header figure: a link to the tab it came from, or plain on that tab itself. */
function Tile({
  href,
  label,
  value,
  lines = [],
  exact,
  tone = 'plain',
  testid,
}: {
  href: string | null;
  label: string;
  value: ReactNode;
  lines?: (string | null)[];
  exact?: string;
  tone?: keyof typeof TILE_TONE;
  testid: string;
}) {
  const body = (
    <>
      <p className="text-2xs font-semibold uppercase leading-tight tracking-wide text-ink-500">{label}</p>
      <p
        data-value={exact}
        className={`mt-0.5 whitespace-nowrap font-mono text-lg font-bold tabular-nums ${TILE_TONE[tone]}`}
      >
        {value}
      </p>
      {lines
        .filter((line): line is string => line !== null)
        .map((line) => (
          <p key={line} className="break-words text-2xs leading-snug text-ink-500">
            {line}
          </p>
        ))}
    </>
  );
  return href ? (
    <Link href={href} className="card-tap block min-w-0 !p-3" data-testid={testid}>
      {body}
    </Link>
  ) : (
    <div className="card min-w-0 !p-3" data-testid={testid}>
      {body}
    </div>
  );
}
