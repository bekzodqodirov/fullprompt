import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { mayOpenBatchCard } from '../batches/card-door';
import {
  HISTORY_CAP,
  issuedHandoversPage,
  phoneSiblingClients,
  type IssuedHandover,
} from '../client-cabinet/service';
import { arrivalsForPairs } from '../documents/arrivals';
import { mayReadHandoverAct } from '../issue/act-door';
import { cargoTrucks, clientCargoNow, clientCargoNowOnce } from '../inventory/client-cargo-now';
import { foldCargoNow, NOW_SECTIONS, type CargoNow } from '../inventory/client-cargo-fold';
import { firstLotPhotos } from '../receipts/first-photo';
import { receiptsReadableBy } from '../receipts/read-door';
import { trucksOnRoadRows } from '../tracking/on-road';
import type { TruckRow } from '../tracking/on-road-state';
import { historyRefs } from './history-refs';

/** A truck as the tab draws it — code, the two ends' codes, and whether its card opens. */
export interface NowTruck {
  code: string;
  originCode: string;
  destCode: string;
  /** The truck card's door (`mayOpenBatchCard`) answered yes. */
  open: boolean;
}

export interface NowSibling {
  id: string;
  code: string;
  boxes: number;
}

export interface YuklarView {
  now: CargoNow;
  trucks: Map<string, NowTruck>;
  road: Map<string, TruckRow>;
  photos: Map<string, string>;
  /** Row keys whose photograph this reader may be shown. */
  photoRows: Set<string>;
  /** Prixods this reader may open. */
  receiptsOpen: Set<string>;
  siblings: NowSibling[];
  history: { rows: IssuedHandover[]; capped: boolean; cap: number };
  /** Handovers whose act this reader may open. */
  actOpen: Set<string>;
  /** A history leg's truck id by its code, only where the truck card admits the reader. */
  legTruck: Map<string, string>;
}

type Reader = ScopedActor & { permissions: { has(code: string): boolean } };

/**
 * Everything the client card's «Yuklar» tab draws, for ONE reader — in a
 * module rather than in the page, because a rule written inside a server
 * component can only be proven by grepping it (#531), and this one carries
 * six doors and a Σ.
 *
 * The cargo is THIS code's (`clientCargoNowOnce(clientId)`), never the
 * person's: a phone sibling is a chip with its own count, because a code's
 * deals, ledger and lots are the code's own (#407). Every link is asked of
 * the door of the page it opens, in bulk — a prixod of `receiptsReadableBy`,
 * a truck of `mayOpenBatchCard`, an act of `mayReadHandoverAct` — and a
 * photograph is offered only where the row's cargo stands near the reader
 * (its own warehouse, or either end of the truck it rides: a subset of
 * `cargoNearActor`, the rule `/api/attachments` serves by).
 *
 * ~15 statements for a whole client whatever its size: the rows and their
 * trucks (2), the arrivals (one per warehouse the client stands in), the
 * road (3), the photos, the history (4) and its two refs, the siblings'
 * phones and rows, the arrival trucks, and — for a scoped reader only — one
 * for the prixod links.
 */
export async function loadYuklarView(
  actor: Reader,
  clientId: string,
  opts: { days: number; today: string },
): Promise<YuklarView> {
  const [data, history, siblingList] = await Promise.all([
    clientCargoNowOnce(clientId),
    issuedHandoversPage(clientId, opts.days),
    phoneSiblingClients(clientId),
  ]);

  // What stands somewhere is dated by its arrival HERE, from the cartons
  // still standing here (`standing` — a lot's earlier, handed-over half
  // does not date what arrived on Tuesday); what rides a truck is described
  // by the truck.
  const pairs = data.rows.flatMap((r) =>
    r.status !== 'in_transit' && r.warehouseId ? [{ lotId: r.lotId, warehouseId: r.warehouseId }] : [],
  );
  const onRoadIds = [...data.trucks.values()]
    .filter((truck) => truck.status === 'in_transit' || truck.status === 'arrived')
    .map((truck) => truck.id);
  const others = siblingList.filter((s) => s.id !== clientId);
  const [arrivals, road, photos, siblingData, receiptsOpen, refs] = await Promise.all([
    arrivalsForPairs(pairs, { standing: true }),
    trucksOnRoadRows(onRoadIds),
    firstLotPhotos(data.rows.map((r) => ({ lotId: r.lotId, receiptId: r.receiptId }))),
    others.length ? clientCargoNow(others.map((s) => s.id)) : null,
    receiptsReadableBy(
      actor,
      data.rows.map((r) => ({ id: r.receiptId, warehouseId: r.receiptWarehouseId })),
    ),
    historyRefs(
      history.rows.map((h) => h.id),
      history.rows.flatMap((h) => h.legs.map((leg) => leg.batchCode)),
    ),
  ]);
  const now = foldCargoNow(data.rows, data.trucks, arrivals, opts.today);

  // Every truck the tab names: those the cargo is on or going onto (the live
  // pointer) and those that brought what stands (the arrival rule).
  const arrivalTruckIds = [...arrivals.values()]
    .flatMap((a) => a.batchIds)
    .filter((id) => id && !data.trucks.has(id));
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

  const photoRows = new Set<string>();
  for (const s of NOW_SECTIONS) {
    for (const row of now.sections[s].rows) {
      const truck = row.truckId ? data.trucks.get(row.truckId) : undefined;
      const near = row.warehouseId
        ? inScope(actor, row.warehouseId)
        : truck
          ? mayOpenBatchCard(actor, truck)
          : false;
      if (near) photoRows.add(row.key);
    }
  }

  const siblings: NowSibling[] = others.map((s) => ({
    id: s.id,
    code: s.clientCode,
    boxes: siblingData
      ? foldCargoNow(
          siblingData.rows.filter((r) => r.clientId === s.id),
          siblingData.trucks,
          null,
          opts.today,
        ).total.boxes
      : 0,
  }));

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

  return {
    now,
    trucks,
    road,
    photos,
    photoRows,
    receiptsOpen,
    siblings,
    history: { ...history, cap: HISTORY_CAP },
    actOpen,
    legTruck,
  };
}
