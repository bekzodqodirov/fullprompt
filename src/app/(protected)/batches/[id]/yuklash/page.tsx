import { asc, eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { boxes, clients, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { countAcceptPanel, countedLotAwaiting } from '@/modules/wms/scanning/count-accept';
import { countDoorFor, mayCountMove } from '@/modules/wms/scanning/count-door';
import { countedOnTruck, countLoadPanel } from '@/modules/wms/scanning/count-load';
import { aboardFilter, batchMissingBoxes, remainingToUnload } from '@/modules/wms/scanning/unload';
import { landedStatusFor } from '@/modules/wms/warehouses/landed';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { Panel } from '@/components/panel';
import { BatchCard, batchTabMetadata } from '../batch-card';
import { CountAcceptPanel } from '../count-accept-panel';
import { CountLoadPanel } from '../count-load-panel';
import { UnloadActions } from '../unload-actions';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return batchTabMetadata((await params).id, 'yuklash');
}

/**
 * «Yuklash / Tushirish» — the truck card's work of moving cartons
 * (docs/CARD-TABS.md): the office's two count doors (0112), the unloading
 * controls with the missing-carton resolution, and the box-by-box record of
 * what was loaded. They sat under the card's header, where the unloading
 * controls alone measured 812 px for three missing lots — above everything
 * else on every tab once the card had tabs (review, phone lens). The phone's
 * scan screens stay full-screen pages of their own; the header keeps their
 * buttons.
 *
 * The door is the card's own. Each panel keeps its own door, unchanged.
 */
export default async function BatchLoadingTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const head = await loadBatchHead(id);
  if (!head) notFound();
  if (!mayOpenBatchCard(actor, head.batch)) notFound();
  const { batch } = head;
  const t = await getTranslations('batches');
  const tc = await getTranslations('batchCard');
  const tcount = await getTranslations('countLoad');
  const tca = await getTranslations('countAccept');

  // «Sanab yuklash» (0112) — region A: the office's door at the origin (the
  // kernel's CountDoor), shown while the truck loads.
  const loadingNow = ['forming', 'loading'].includes(batch.status);
  const countDoor = countDoorFor(actor, batch.originWarehouseId);
  const loadPanel = countDoor && loadingNow ? await countLoadPanel(batch) : null;

  // Region B — «sanab qabul» (0112): the office's count at the destination.
  // The door is the count door there (plans.manage in scope, Q3a); the
  // panel's cartons beyond the truck also need the ORIGIN's door.
  const unloadingNow = ['in_transit', 'arrived'].includes(batch.status);
  const mayCountAccept = unloadingNow && mayCountMove(actor, batch.destWarehouseId);
  const [countPanel, countedAwaiting, destTypeRow, missingRows, counted] = await Promise.all([
    mayCountAccept ? countAcceptPanel(id) : null,
    unloadingNow ? countedLotAwaiting(id) : 0,
    db.select({ type: warehouses.type }).from(warehouses).where(eq(warehouses.id, batch.destWarehouseId)),
    batchMissingBoxes(id),
    countedOnTruck(id),
  ]);
  const countAwaiting = countPanel?.lots.reduce((acc, lot) => acc + lot.awaiting, 0) ?? 0;

  // Still on the truck as far as the system knows. Shown next to the unload
  // actions so nobody finishes an unload without seeing what it will declare
  // missing (owner's report).
  const remainingToAccept = unloadingNow ? (await remainingToUnload(id)).length : 0;
  const canDepartClose = actor.permissions.has('batches.depart_close');
  const canCloseWithMissing = actor.permissions.has('receipts.void') && inScope(actor, batch.destWarehouseId);

  // What was actually loaded, box by box — the truck's real cargo, so the
  // list survives unload/close (owner: after the truck leaves, the sending
  // warehouse only needs to SEE what it loaded — read-only) and follows an
  // office count dialled down (0112: the scan history keeps every carton that
  // was ever put on).
  const loadedBoxes = ['forming'].includes(batch.status)
    ? []
    : await db
        .selectDistinct({
          shortCode: boxes.shortCode,
          lotId: boxes.lotId,
          letter: receiptLots.letter,
          clientCode: clients.clientCode,
          marking: receipts.unclaimedMarking,
        })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(aboardFilter(id))
        .orderBy(asc(receiptLots.letter), asc(boxes.shortCode));

  const showUnload = ['in_transit', 'arrived', 'unloaded'].includes(batch.status) || missingRows.length > 0;
  const nothing =
    !showUnload &&
    !(countPanel && (countPanel.lots.length > 0 || countPanel.crates.length > 0)) &&
    !loadPanel &&
    loadedBoxes.length === 0;

  return (
    <BatchCard head={head} actor={actor} active="yuklash">
      {showUnload && (
        <section id="missing" className="card scroll-mt-20 space-y-2">
          <UnloadActions
            batchId={batch.id}
            status={batch.status}
            missing={missingRows.map(({ box, letter, clientCode, marking, product }) => ({
              boxId: box.id,
              shortCode: box.shortCode,
              label: `${codeIdentity(marking, clientCode).main}-${letter}`,
              lotId: box.lotId,
              product,
              crated: box.crateId !== null,
            }))}
            remaining={remainingToAccept}
            // «Hammasini qabul qilish» leaves a lot counted HERE to the count
            // (decision 21), so its button says what it will really land.
            acceptable={remainingToAccept - countedAwaiting}
            canCountResolve={mayCountMove(actor, batch.destWarehouseId)}
            // The two shortcuts and the missing-box resolution are the same
            // manager act at the same warehouse — and the WAREHOUSE half was
            // missing on `canResolve`, so the screen drew a button whose
            // action then threw an AuthError into an onClick with no
            // boundary: nothing appeared at all.
            canShortcut={canCloseWithMissing}
            canResolve={canCloseWithMissing}
            canClose={canDepartClose}
          />
        </section>
      )}

      {countPanel && (countPanel.lots.length > 0 || countPanel.crates.length > 0) && (
        <Panel
          id="count-accept"
          title={`🔢 ${tca('title')}`}
          badge={tca('badge', { lots: countPanel.lots.length, n: countAwaiting })}
          open={countPanel.lots.some((lot) => lot.awaiting > 0 && lot.mode !== null)}
          testId="count-accept-open"
        >
          <CountAcceptPanel
            batchId={batch.id}
            status={batch.status}
            notifiesClients={landedStatusFor(destTypeRow[0]?.type ?? '') === 'ready_for_pickup'}
            mayOver={mayCountMove(actor, batch.originWarehouseId)}
            lots={countPanel.lots}
            crates={countPanel.crates}
          />
        </Panel>
      )}
      {loadPanel && (
        <CountLoadPanel
          batchId={batch.id}
          quick={loadPanel.quick}
          rows={loadPanel.rows}
          crates={loadPanel.crates}
          defaultOpen={loadPanel.rows.some((row) => row.mode === 'counted' || row.mode === 'qrless')}
        />
      )}

      {loadedBoxes.length > 0 && (
        <details className="card" open={!showUnload && !loadPanel}>
          <summary className="cursor-pointer text-lg font-bold">
            🧾 {t('loadedBoxes')} ({loadedBoxes.length})
          </summary>
          <div className="mt-2 space-y-1 text-sm">
            {[...loadedBoxes
              .reduce((acc, b) => {
                const label = `${codeIdentity(b.marking, b.clientCode).main}-${b.letter}`;
                const entry = acc.get(label) ?? { counted: counted.lotIds.includes(b.lotId), codes: [] };
                entry.codes.push(b.shortCode);
                acc.set(label, entry);
                return acc;
              }, new Map<string, { counted: boolean; codes: string[] }>())
              .entries()].map(([label, lot]) => (
              <p key={label} className="border-b border-line py-1 last:border-0">
                <span className="font-mono font-extrabold text-brand-700">{label}</span>{' '}
                {/* A counted lot's cartons carry no sticker to find by code. */}
                <span className="font-mono text-xs text-ink-700">
                  {lot.counted ? tcount('loadedCounted', { n: lot.codes.length }) : lot.codes.join(', ')}
                </span>
              </p>
            ))}
          </div>
        </details>
      )}

      {nothing && <p className="card text-sm text-ink-500">{tc('nothingLoaded')}</p>}
    </BatchCard>
  );
}
