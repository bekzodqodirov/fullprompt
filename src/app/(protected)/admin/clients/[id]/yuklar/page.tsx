import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { mayOpenClientCard } from '@/modules/platform/clients/card-door';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { HISTORY_CAP, issuedHandoversPage, phoneSiblingClients } from '@/modules/wms/client-cabinet/service';
import { clientHeadOnce } from '@/modules/wms/client-card/head';
import { historyRefs } from '@/modules/wms/client-card/history-refs';
import { readHistoryDays } from '@/modules/wms/client-card/history-window';
import { mayReadHandoverAct } from '@/modules/wms/documents/handover-act-door';
import { arrivalsForPairs } from '@/modules/wms/documents/arrivals';
import { cargoTrucks, clientCargoNow, clientCargoNowOnce } from '@/modules/wms/inventory/client-cargo-now';
import { foldCargoNow, NOW_SECTIONS } from '@/modules/wms/inventory/client-cargo-fold';
import { firstLotPhotos } from '@/modules/wms/receipts/first-photo';
import { receiptsReadableBy } from '@/modules/wms/receipts/read-door';
import { trucksOnRoadRows } from '@/modules/wms/tracking/on-road';
import { ClientCard } from '@/components/client-card';
import { ClientCargoNow, type NowSibling, type NowTruck } from '@/components/client-cargo-now';
import { ClientCargoHistory } from '@/components/client-cargo-history';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const actor = await getActor();
  if (!actor || !mayOpenClientCard(actor)) return {};
  const client = await clientHeadOnce((await params).id);
  if (!client) return {};
  const t = await getTranslations('yuklar');
  return { title: `${client.clientCode} · ${t('tab')}` };
}

/**
 * «Yuklar» — the client card's third tab (docs/CARD-TABS.md): where this
 * client's cargo is RIGHT NOW, in the customer's own four steps, and what
 * they have already collected.
 *
 * The door is the card's own, `mayOpenClientCard` — asked BEFORE the lookup,
 * so the URL cannot answer «does this client exist» to somebody refused
 * (CARD-TABS (R)); after it, «not found» is the only other word. No money on
 * this tab and no money read behind it: the shell's «Pul» badge is the
 * shell's, drawn for the ledger's audience alone.
 *
 * Every link is asked of the door of the page it opens (a prixod of
 * `receiptsReadableBy`, a truck of `mayOpenBatchCard`, an act of
 * `mayReadHandoverAct`) — a link that bounces is worse than no link. The
 * cargo itself is unscoped here exactly as on «Umumiy» (the same door, the
 * same facts); a photograph is drawn only where the row's cargo stands near
 * the reader, the attachment gate's own rule, so a drawn photo is served.
 */
export default async function ClientCargoTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `tarix` = the history window (90 | 365), `toliq=1` = draw every row. */
  searchParams: Promise<{ tarix?: string; toliq?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayOpenClientCard(actor)) redirect('/');
  const client = await clientHeadOnce(id);
  if (!client) notFound();

  const days = readHistoryDays(sp.tarix);
  const full = sp.toliq === '1';
  const today = tashkentDay();

  const [data, history, siblings] = await Promise.all([
    clientCargoNowOnce(client.id),
    issuedHandoversPage(client.id, days),
    phoneSiblingClients(client.id),
  ]);

  // What stands somewhere is dated by its arrival HERE, from the cartons
  // still standing here (`standing`, the judge's finding 2); what rides a
  // truck is described by the truck.
  const pairs = data.rows.flatMap((r) =>
    r.status !== 'in_transit' && r.warehouseId ? [{ lotId: r.lotId, warehouseId: r.warehouseId }] : [],
  );
  const onRoadIds = [...data.trucks.values()]
    .filter((truck) => truck.status === 'in_transit' || truck.status === 'arrived')
    .map((truck) => truck.id);
  const others = siblings.filter((s) => s.id !== client.id);
  const [arrivals, road, photos, siblingData, readable] = await Promise.all([
    arrivalsForPairs(pairs, { standing: true }),
    trucksOnRoadRows(onRoadIds),
    firstLotPhotos(data.rows.map((r) => ({ lotId: r.lotId, receiptId: r.receiptId }))),
    others.length ? clientCargoNow(others.map((s) => s.id)) : null,
    receiptsReadableBy(
      actor,
      data.rows.map((r) => ({ id: r.receiptId, warehouseId: r.receiptWarehouseId })),
    ),
  ]);
  const now = foldCargoNow(data.rows, data.trucks, arrivals, today);

  // Every truck the tab names: the ones the cargo is on (the live pointer)
  // and the ones that brought what stands (the arrival rule), each with its
  // own answer from the truck card's door.
  const arrivalTruckIds = [...arrivals.values()].flatMap((a) => a.batchIds).filter((x) => x && !data.trucks.has(x));
  const arrivalTrucks = await cargoTrucks(arrivalTruckIds);
  const trucks = new Map<string, NowTruck>();
  for (const truck of [...data.trucks.values(), ...arrivalTrucks.values()]) {
    trucks.set(truck.id, {
      code: truck.code,
      originCode: truck.originCode,
      destCode: truck.destCode,
      open: mayOpenBatchCard(actor, truck),
    });
  }

  // A photograph where this row's cargo stands near the reader: its own
  // warehouse, or either end of the truck it rides — a subset of
  // `cargoNearActor`, the rule `/api/attachments` serves by.
  const photoRows = new Set<string>();
  for (const s of NOW_SECTIONS) {
    for (const row of now.sections[s].rows) {
      const truck = row.truckId ? data.trucks.get(row.truckId) : undefined;
      const near = row.warehouseId ? inScope(actor, row.warehouseId) : truck ? mayOpenBatchCard(actor, truck) : false;
      if (near) photoRows.add(row.key);
    }
  }

  const siblingChips: NowSibling[] = others.map((s) => ({
    id: s.id,
    code: s.clientCode,
    boxes: siblingData
      ? foldCargoNow(
          siblingData.rows.filter((r) => r.clientId === s.id),
          siblingData.trucks,
          null,
          today,
        ).total.boxes
      : 0,
  }));

  const refs = await historyRefs(
    history.rows.map((h) => h.id),
    history.rows.flatMap((h) => h.legs.map((leg) => leg.batchCode)),
  );
  const actOpen = new Set(
    history.rows
      .filter((h) => {
        const warehouseId = refs.handoverWarehouse.get(h.id);
        return warehouseId ? mayReadHandoverAct(actor, warehouseId) : false;
      })
      .map((h) => h.id),
  );
  const legTruck = new Map<string, string>();
  for (const [code, truck] of refs.truckByCode) {
    if (mayOpenBatchCard(actor, truck)) legTruck.set(code, truck.id);
  }

  // Links that change one parameter carry the other (#514).
  const base = `/admin/clients/${client.id}/yuklar`;
  const href = (patch: { tarix?: number; toliq?: boolean }) => {
    const q = new URLSearchParams();
    const tarix = patch.tarix ?? days;
    const toliq = patch.toliq ?? full;
    if (tarix !== 90) q.set('tarix', String(tarix));
    if (toliq) q.set('toliq', '1');
    const qs = q.toString();
    return `${base}${qs ? `?${qs}` : ''}`;
  };

  return (
    <ClientCard client={client} active="yuklar">
      <div className="space-y-4">
        <ClientCargoNow
          now={now}
          trucks={trucks}
          road={road}
          photos={photos}
          photoRows={photoRows}
          receiptsOpen={readable}
          siblings={siblingChips}
          full={full}
          fullHref={href({ toliq: true })}
        />
        <ClientCargoHistory
          rows={history.rows}
          capped={history.capped}
          cap={HISTORY_CAP}
          days={days}
          hrefs={{ short: `${href({ tarix: 90 })}#topshirilgan`, year: `${href({ tarix: 365 })}#topshirilgan` }}
          actOpen={actOpen}
          legTruck={legTruck}
        />
      </div>
    </ClientCard>
  );
}
