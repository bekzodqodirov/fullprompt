import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, costEntries, costTypes, warehouses } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { tariffHistory } from '../calc/tariff-read';
import { pricingSight } from '../finance/pricing-view';
import { customsCostTypeIds } from './customs-ids';
import { copyDigest, freightCopiesFor } from './freight-copy';
import { FREIGHT_CODES_SETTING, parseFreightCodes } from './freight-codes';
import { freightTablesReady } from './freight-ready';
import { FREIGHT_LIGHT_BELOW, copyDraft, splitCents } from './freight-split';
import { costPool, type PoolVerdict } from './pool';
import { boxMeasures, truckRiderBoxIds, type ClientCostPart } from './service';
import { tariffColumnOf } from './tariff-column';
import type {
  BoxMeasure,
  FreightCopy,
  FreightOffer,
  FreightRowView,
  FreightVersion,
  GroupView,
  SplitView,
  TypeFlags,
} from './freight-types';

/**
 * What the truck's cost form offers, previews and explains about the freight
 * basis (docs/YOLKIRA-TAQSIMOT.md §7). Every read is on the POOL — these are
 * renders — and the preview runs the SAME pure `costPool` the recompute runs,
 * over the recompute's own base (`truckRiderBoxIds`), never a look-alike.
 */

/**
 * May this reader see the money of a split (a client's share in dollars, the
 * list rate per m³)? ONE predicate for the preview, the fold and the re-basis
 * preview: the pricing page's 'full' sight. NOT `seesCompanyMoney` — the
 * entry page admits `clients.manage` without `finance.manage`, and the VED
 * reads no client's dollars (#791). Everybody else sees the band and the %.
 */
export function freightMoneySight(permissions: ReadonlySet<string>): boolean {
  return pricingSight(permissions, false) === 'full';
}

/** The ids of the cost types the panel preselects freight for, and the customs ones it never offers it on. */
export async function freightTypeFlags(): Promise<TypeFlags> {
  const codes = parseFreightCodes(await getSetting(FREIGHT_CODES_SETTING));
  const [freight, customs] = await Promise.all([
    codes.length
      ? db.select({ id: costTypes.id }).from(costTypes).where(inArray(costTypes.code, codes))
      : Promise.resolve([] as { id: string }[]),
    customsCostTypeIds(),
  ]);
  return { freightTypeIds: freight.map((t) => t.id), customsTypeIds: customs };
}

function splitView(verdict: PoolVerdict, money: boolean): SplitView {
  if (verdict.kind === 'nothing') return { kind: 'nothing' };
  if (verdict.kind === 'held') return { kind: 'held', held: verdict.held };
  const groups: GroupView[] = (verdict.groups ?? []).map((g) => ({
    key: g.key,
    label: g.label,
    m3: g.m3,
    density: g.density,
    band: money ? g.band : { min: g.band.min, max: g.band.max, perKg: g.band.perKg },
    share: g.share,
    lightLots: g.lightLots,
    ...(money ? { ratePerM3: g.ratePerM3 } : {}),
  }));
  return { kind: 'split', groups };
}

/**
 * One bill's view of its own copy over its own truck's cargo (amount 1:
 * shares only). `customs` is the recompute's own flag for a SAVED bill (a type
 * that became customs holds it — review of the round: the fold drew a tariff
 * split under an ⚠ chip); a preview's version is drawn for whichever type the
 * person picks, and the panel never offers freight on a customs one.
 */
function viewOf(
  measures: BoxMeasure[],
  copy: FreightCopy | 'missing' | 'invalid',
  money: boolean,
  customs = false,
): SplitView {
  return splitView(
    costPool({ allocationBasis: 'freight', clientId: null, amountUsd: 1 }, measures, 1, { copy, customs }),
    money,
  );
}

const MAX_VERSIONS = 20;

/**
 * The offer for ONE truck. Never throws a render down: one migration behind
 * it answers `server_behind` and the option is disabled with that sentence.
 */
export async function freightOffer(
  actor: { permissions: ReadonlySet<string> },
  batchId: string,
): Promise<FreightOffer> {
  const typeFlags = await freightTypeFlags();
  if (!(await freightTablesReady())) return { status: 'server_behind', typeFlags };
  const [truck] = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(batches)
    .innerJoin(warehouses, eq(warehouses.id, batches.originWarehouseId))
    .where(eq(batches.id, batchId));
  if (!truck) return { status: 'server_behind', typeFlags };
  const mayFixColumn = actor.permissions.has('admin.warehouses.manage');
  const zone = await tariffColumnOf(truck.id);
  if (!zone) return { status: 'no_column', warehouse: truck, mayFixColumn, typeFlags };

  const money = freightMoneySight(actor.permissions);
  const history = await tariffHistory();
  const dates = [...new Set(history.filter((r) => r.zone === zone).map((r) => r.effectiveDate))].sort().reverse();
  const measures = await boxMeasures(await truckRiderBoxIds(batchId));
  const versions: FreightVersion[] = dates.slice(0, MAX_VERSIONS).map((from) => {
    const made = copyDraft(zone, history, from, FREIGHT_LIGHT_BELOW, truck.id);
    if (!made.ok) return { from, digest: '', problem: made.problem, split: null };
    return { from, digest: copyDigest(made.draft), problem: null, split: viewOf(measures, made.draft, money) };
  });
  return {
    status: 'ready',
    warehouse: truck,
    zone,
    money,
    mayFixColumn,
    mayFixTariff: actor.permissions.has('admin.dictionaries.manage'),
    typeFlags,
    firstFrom: dates.at(-1) ?? null,
    versions,
  };
}

/**
 * Each listed FREIGHT bill explained over ITS OWN truck and ITS OWN frozen
 * copy (§7.4) — safe for a page that lists another truck's bill (the Narx
 * tab's «shu reysgacha»). Bounded: ONE copy read for every bill, the base and
 * its measures ONCE per truck, the allocations in ONE grouped read. The
 * dollars printed are always the allocations', rounded to the bill's cents
 * by the largest remainder so the fold adds up to the bill (M7).
 */
export async function explainFreightBills(
  bills: {
    id: string;
    batchId: string | null;
    costTypeId: string;
    allocationBasis: string;
    amountUsd: string | null;
    hasShare: boolean;
  }[],
  actor: { permissions: ReadonlySet<string> },
): Promise<Map<string, FreightRowView>> {
  const out = new Map<string, FreightRowView>();
  const freight = bills.filter((b) => b.allocationBasis === 'freight' && b.batchId);
  if (freight.length === 0) return out;
  const money = freightMoneySight(actor.permissions);
  const [copies, customsIds] = await Promise.all([freightCopiesFor(freight.map((b) => b.id)), customsCostTypeIds()]);
  const whIds = [...new Set([...copies.values()].flatMap((c) => (typeof c === 'object' ? [c.warehouseId] : [])))];
  const whCodes = new Map(
    whIds.length
      ? (await db.select({ id: warehouses.id, code: warehouses.code }).from(warehouses).where(inArray(warehouses.id, whIds))).map(
          (w) => [w.id, w.code] as const,
        )
      : [],
  );
  const measuresByTruck = new Map<string, BoxMeasure[]>();
  for (const truckId of new Set(freight.map((b) => b.batchId!))) {
    measuresByTruck.set(truckId, await boxMeasures(await truckRiderBoxIds(truckId)));
  }
  const allocated = new Map<string, Map<string, number>>();
  if (money) {
    const rows = (await db.execute(sql`
      SELECT ca.cost_entry_id AS id,
             CASE WHEN ca.client_id IS NOT NULL THEN 'c:' || ca.client_id::text ELSE 'r:' || rl.receipt_id::text END AS k,
             sum(ca.amount_usd) AS usd
        FROM cost_allocations ca
        JOIN boxes b ON b.id = ca.box_id
        JOIN receipt_lots rl ON rl.id = b.lot_id
       WHERE ca.cost_entry_id IN (${sql.join(freight.map((b) => sql`${b.id}::uuid`), sql`, `)})
       GROUP BY 1, 2`)) as unknown as { id: string; k: string; usd: string }[];
    for (const r of rows) {
      if (!allocated.has(r.id)) allocated.set(r.id, new Map());
      allocated.get(r.id)!.set(r.k, Number(r.usd));
    }
  }
  for (const bill of freight) {
    const copy = copies.get(bill.id) ?? 'missing';
    const view = viewOf(measuresByTruck.get(bill.batchId!) ?? [], copy, money, customsIds.includes(bill.costTypeId));
    let allocatedUsd: Record<string, number> | undefined;
    const sums = allocated.get(bill.id);
    if (money && sums && bill.amountUsd !== null) {
      const keys = [...sums.keys()];
      const cents = splitCents(Number(bill.amountUsd), keys.map((k) => sums.get(k)!));
      allocatedUsd = Object.fromEntries(keys.map((k, i) => [k, cents[i]!]));
    }
    out.set(bill.id, {
      warehouseCode: typeof copy === 'object' ? (whCodes.get(copy.warehouseId) ?? '') : '',
      zone: typeof copy === 'object' ? copy.zone : '',
      tariffFrom: typeof copy === 'object' ? copy.tariffFrom : '',
      unsplit: bill.amountUsd !== null && !bill.hasShare,
      view,
      ...(allocatedUsd ? { allocatedUsd } : {}),
    });
  }
  return out;
}

/**
 * The Narx tab's explain map (§7.4, E6): built from the breakdown's OWN
 * freight entry ids — «shu reysgacha» and «keyingi yo'l» parts are OTHER
 * trucks' bills, which the page's own entry list does not hold — and each is
 * explained on its own truck and its own copy by `explainFreightBills`,
 * never over the page's truck. A voided or vanished id simply has no entry,
 * and its line prints without a band.
 */
export async function explainBreakdown(
  breakdown: Map<string, ClientCostPart[]>,
  actor: { permissions: ReadonlySet<string> },
): Promise<Map<string, FreightRowView>> {
  const ids = [...breakdown.values()].flatMap((parts) => parts.flatMap((part) => (part.freightEntryId ? [part.freightEntryId] : [])));
  return explainFreightEntries(ids, actor);
}

async function explainFreightEntries(
  ids: string[],
  actor: { permissions: ReadonlySet<string> },
): Promise<Map<string, FreightRowView>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: costEntries.id,
      batchId: costEntries.batchId,
      costTypeId: costEntries.costTypeId,
      allocationBasis: costEntries.allocationBasis,
      amountUsd: costEntries.amountUsd,
      hasShare: sql<boolean>`EXISTS (SELECT 1 FROM cost_allocations ca WHERE ca.cost_entry_id = ${costEntries}.id)`,
    })
    .from(costEntries)
    .where(inArray(costEntries.id, unique));
  return explainFreightBills(rows, actor);
}
