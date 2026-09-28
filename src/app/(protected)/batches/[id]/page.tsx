import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { batchLoadProgress, loadBatchHead } from '@/modules/wms/batches/card-head';
import { batchLots } from '@/modules/wms/batches/lots';
import { batchCrates } from '@/modules/wms/inventory/service';
import { codeIdentity } from '@/modules/wms/labels/code-identity';
import { CrateRows } from '@/components/crate-rows';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { LightboxImg } from '@/components/lightbox-img';
import { QrlessChip } from '@/components/qrless-chip';
import { TasksPanel } from '@/components/tasks-panel';
import { BatchCard, batchTabMetadata } from './batch-card';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return batchTabMetadata((await params).id, 'tarkib');
}

/**
 * The truck card's first tab — «Ichidagilar», what the truck carries
 * (docs/CARD-TABS.md). The header, the ladder, the stage buttons and the
 * other five tabs are `BatchCard`'s; this page is the contents table, the
 * crates, and the truck's tasks and fields, stacked AFTER the table so the
 * loader's list is the first thing under the header on a phone.
 *
 * The door is the card's own: origin OR destination in scope, exactly the
 * rule the batch list uses (a trip belongs to both warehouses).
 */
export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const head = await loadBatchHead(id);
  if (!head) notFound();
  if (!mayOpenBatchCard(actor, head.batch)) notFound();
  const t = await getTranslations('batches');
  const tc = await getTranslations('common');
  // The contents table is the stock table applied to a truck, so it borrows
  // the stock screen's own column names rather than inventing second ones.
  const tstock = await getTranslations('stock');
  const tqrsiz = await getTranslations('qrsiz');

  // The truck's contents, read the way the stock screen reads a shelf (owner:
  // «uni ichidagisni sklad qoldiqlaridek toliq neccha kub necha kg rasimlari
  // bn»). Membership is the truck's RIDERS, an annulled box excluded — the
  // rule every money tab, the grid and «Partiya foydasi» split the truck's
  // bills over (`batchLots`), so the Σ here is the header's «Yuk» tile and
  // the divisor on the cost tab. The card's old rule (the live pointer or a
  // departure record) put a carton found back at the origin, an annulled one
  // and an office count-over on the table but not on the money: 100 cartons
  // here, 99 on the cost line, on 1 200 of 1 422 trucks of a shaped copy.
  // kg/m³ come off the lot, shared per box, so a truck carrying half a lot is
  // credited with half its weight.
  const [lots, progress] = await Promise.all([batchLots(id), batchLoadProgress(id)]);
  const contents = lots.map((lot) => {
    const p = progress.get(lot.lotId);
    return {
      ...lot,
      // The loader's photo order (tests/unit/loading-photo-order): the
      // OUTSIDE of the carton first, the goods as the fallback.
      generalPhotoId: lot.boxPhotoId,
      photoId: lot.goodsPhotoId,
      planned: p?.planned ?? 0,
      loaded: p?.loaded ?? 0,
      qrless: p?.qrless ?? 0,
    };
  });
  const totalKg = contents.reduce((acc, row) => acc + row.kg, 0);
  const totalM3 = contents.reduce((acc, row) => acc + row.m3, 0);
  const totalBoxes = contents.reduce((acc, row) => acc + row.onBatch, 0);

  // The crates riding this truck, as PLACES beneath the cargo table (round
  // 109). Gated on `crates.manage` like every other crate surface — the row
  // is a door to the crate card, which redirects whoever may not open it.
  const crateRows = actor.permissions.has('crates.manage') ? await batchCrates(id) : [];

  return (
    <BatchCard head={head} actor={actor} active="tarkib">
      <div className="card space-y-2">
        <h2 className="text-lg font-bold">{t('contents')}</h2>
        <p className="text-sm font-semibold text-ink-700" data-testid="batch-contents-total">
          Σ {totalBoxes} 📦 · {Math.round(totalKg)} kg · {Math.round(totalM3 * 100) / 100} m³
        </p>
        {contents.length === 0 && <p className="text-sm text-ink-500">{tc('empty')}</p>}
        {/* Its own sideways scroll: a row wider than the phone rescales the
            WHOLE page, and then every tap lands somewhere else (#400). An empty
            truck gets the sentence alone — a header row over nothing reads as
            a broken table. */}
        {contents.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-line-strong bg-surface-sunken text-left">
                  <th className="p-2">📷</th>
                  <th className="p-2">{tstock('colCode')}</th>
                  <th className="p-2">{tstock('colProduct')}</th>
                  <th className="p-2 text-right">📦</th>
                  <th className="p-2 text-right">kg</th>
                  <th className="p-2 text-right">m³</th>
                </tr>
              </thead>
              <tbody>
                {contents.map((lot) => {
                  const who = codeIdentity(lot.marking, lot.clientCode);
                  return (
                    <tr key={lot.lotId} className="border-b border-line last:border-0">
                      <td className="p-1.5">
                        <div className="flex items-center gap-1">
                          {/*
                            THE OUTSIDE OF THE CARTON COMES FIRST HERE, and this is
                            the one table where that is true. The owner, at a truck:
                            «skladchi yuklash payitida karobkani ichini kormaydiku
                            shu payitda tovarni tashqa rasimi turishi kerak unga».
                            This is the list a loader reads to know WHICH cartons to
                            put on the truck, so the useful picture is the receipt's
                            general box photo; the per-lot goods photo answers «what
                            is inside», which is the question /stock and the receipt
                            card are for — and there the order stays the other way
                            round. The amber ring therefore marks the UNEXPECTED
                            one on this screen: a lot with no box photo falls back
                            to the goods photo rather than to nothing, and says so.
                          */}
                          {lot.generalPhotoId ? (
                            <LightboxImg
                              attachmentId={lot.generalPhotoId}
                              className="h-20 w-20 rounded-lg object-cover"
                            />
                          ) : lot.photoId ? (
                            <LightboxImg
                              attachmentId={lot.photoId}
                              className="h-20 w-20 rounded-lg border-2 border-warn/40 object-cover"
                            />
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap p-2">
                        <Link
                          href={`/stock?lot=${lot.lotId}`}
                          className="font-mono font-extrabold text-brand-700"
                        >
                          {who.main}-{lot.letter}
                          {who.sub && (
                            <span className="block font-sans text-2xs font-normal text-ink-500">
                              {who.sub}
                            </span>
                          )}
                        </Link>
                        {lot.qrless > 0 && (
                          <span className="block">
                            <QrlessChip n={lot.qrless} total={lot.onBatch} label={tqrsiz('chip')} />
                          </span>
                        )}
                      </td>
                      <td className="max-w-56 p-2">
                        <Link href={`/receipts/${lot.receiptId}`} className="block truncate">
                          {lot.productNameZh}
                          {lot.productNameRu && (
                            <span className="text-ink-500"> ({lot.productNameRu})</span>
                          )}
                        </Link>
                      </td>
                      <td className="p-2 text-right font-semibold">
                        {/* While the truck is being filled the useful number is
                            progress; once it has left, the plan is history and the
                            count IS the cargo. */}
                        {lot.planned > 0 ? `${lot.loaded}/${lot.onBatch}` : lot.onBatch}
                      </td>
                      <td className="p-2 text-right">{Math.round(lot.kg)}</td>
                      <td className="p-2 text-right">{Math.round(lot.m3 * 100) / 100}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <CrateRows
          rows={crateRows}
          labels={{
            title: tstock('cratesTitle'),
            inside: tstock('crateInside'),
            over: tstock('crateOver'),
            place: tstock('cratePlace'),
          }}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <TasksPanel entityType="batch" entityId={id} revalidate={`/batches/${id}`} />
        <CustomFieldsPanel entityType="batch" entityId={id} revalidate={`/batches/${id}`} />
      </div>
    </BatchCard>
  );
}
