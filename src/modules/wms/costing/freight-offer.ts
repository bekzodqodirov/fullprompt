import { cache } from 'react';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, costEntries, costTypes } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { tariffHistory } from '../calc/tariff-read';
import { pricingSight } from '../finance/pricing-view';
import { customsCostTypeIds } from './customs-ids';
import { copyDigest, freightCopiesFor } from './freight-copy';
import { FREIGHT_CODES_SETTING, parseFreightCodes } from './freight-codes';
import { freightTablesReady } from './freight-ready';
import { latestTxDate } from '../finance/dates';
import { FREIGHT_LIGHT_BELOW, bandForSight, copyDraft, lotCents, rollupClients } from './freight-split';
import { freightSplitZone } from './freight-zone';
import { costPool, type PoolVerdict } from './pool';
import { boxMeasures, truckRiderBoxIds, truckRiderBoxIdsFor, type ClientCostPart } from './service';
import type {
  BoxMeasure,
  FreightCopy,
  FreightOffer,
  FreightRowView,
  FreightVersion,
  LotView,
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

export function splitView(verdict: PoolVerdict, money: boolean): SplitView {
  if (verdict.kind === 'nothing') return { kind: 'nothing' };
  if (verdict.kind === 'held') return { kind: 'held', held: verdict.held };
  const views: LotView[] = (verdict.lots ?? []).map((l) => ({
    key: l.key,
    lotId: l.lotId,
    receiptId: l.receiptId,
    receiptNumber: l.receiptNumber,
    clientKey: l.clientKey,
    clientLabel: l.clientLabel,
    label: l.label,
    goods: l.goods,
    m3: l.m3,
    density: l.density,
    band: bandForSight(l.band, money),
    share: l.share,
    ...(money ? { ratePerM3: l.ratePerM3 } : {}),
  }));
  const { lots, clients } = rollupClients(views);
  return { kind: 'split', lots, clients };
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

/**
 * One truck's riders and their measures, read ONCE per request: the
 * Xarajatlar tab asks for them in the offer AND in the saved bills' folds,
 * back to back (the review as built — 1a made both run on every truck).
 * In box order, as `boxMeasures` returns them.
 */
const truckRiderMeasures = cache(async (batchId: string) => boxMeasures(await truckRiderBoxIds(batchId)));

const MAX_VERSIONS = 20;
/**
 * Only the newest few versions carry a whole per-lot split in the page (his
 * 2b multiplies the rows: a 150-lot truck × 20 versions was 3,000 views on
 * the China networks, #752). An older version keeps its digest and its
 * problem; a date that falls on it says the split is drawn after the save
 * (it WAS checked); a date older than all twenty is the server's at save
 * (E9). The bound on the page: ≤ 3 × lots for the offer, plus lots × the
 * truck's saved freight bills for their folds (judge J29).
 */
const FULL_SPLIT_VERSIONS = 3;

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
  // The origin is only the copy's provenance (it stays in the digest, so the
  // preview and the save pass the same one); it no longer chooses the column.
  const [truck] = await db
    .select({ originId: batches.originWarehouseId })
    .from(batches)
    .where(eq(batches.id, batchId));
  if (!truck) return { status: 'server_behind', typeFlags };
  const zone = freightSplitZone();

  const money = freightMoneySight(actor.permissions);
  const history = await tariffHistory();
  // A version dated after the latest day a cost may carry can never be
  // chosen by a save (the form's own `max`, finance/dates.ts), so it never
  // takes one of the three whole-split slots from the version in force today
  // (judge J16: three pre-entered future prices left today's bill with no
  // preview). It still marks the column as priced — `firstFrom` reads all.
  const allDates = [...new Set(history.filter((r) => r.zone === zone).map((r) => r.effectiveDate))].sort().reverse();
  const last = latestTxDate();
  const dates = allDates.filter((d) => d <= last);
  const measures = await truckRiderMeasures(batchId);
  const versions: FreightVersion[] = dates.slice(0, MAX_VERSIONS).map((from, i) => {
    const made = copyDraft(zone, history, from, FREIGHT_LIGHT_BELOW, truck.originId);
    if (!made.ok) return { from, digest: '', problem: made.problem, split: null };
    const split = i < FULL_SPLIT_VERSIONS ? viewOf(measures, made.draft, money) : null;
    return { from, digest: copyDigest(made.draft), problem: null, split };
  });
  return {
    status: 'ready',
    zone,
    money,
    mayFixTariff: actor.permissions.has('admin.dictionaries.manage'),
    typeFlags,
    firstFrom: allDates.at(-1) ?? null,
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
  // Every listed truck's riders in ONE read and their measures in ONE more
  // (judge J30): the Narx tab of a Toshkent truck fed by ten Yiwu trucks was
  // twenty statements one after another. A carton that rode two of them is
  // measured once and handed to both.
  const trucks = [...new Set(freight.map((b) => b.batchId!))];
  let measuresByTruck: Map<string, BoxMeasure[]>;
  if (trucks.length === 1) {
    // The Xarajatlar tab's own truck: the offer on the same page read it already.
    measuresByTruck = new Map([[trucks[0]!, await truckRiderMeasures(trucks[0]!)]]);
  } else {
    const riders = await truckRiderBoxIdsFor(trucks);
    const measured = new Map((await boxMeasures([...new Set([...riders.values()].flat())])).map((m) => [m.boxId, m] as const));
    // In box order, as `boxMeasures` hands one truck back: a held list names
    // its first five lots in that order, and the saved fold must name the five
    // the save's note named (the review as built — a UNION has no order).
    measuresByTruck = new Map<string, BoxMeasure[]>(
      [...riders].map(([truckId, ids]) => [
        truckId,
        [...ids].sort().flatMap((id) => (measured.has(id) ? [measured.get(id)!] : [])),
      ]),
    );
  }
  const allocated = new Map<string, Map<string, number>>();
  if (money) {
    // Keyed by LOT — the same `l:<lotId>` the view's rows carry (his 2b); a
    // client's dollars are the sum of its lots' cents, never a second read.
    const rows = (await db.execute(sql`
      SELECT ca.cost_entry_id AS id,
             'l:' || b.lot_id::text AS k,
             sum(ca.amount_usd) AS usd
        FROM cost_allocations ca
        JOIN boxes b ON b.id = ca.box_id
       WHERE ca.cost_entry_id IN (${sql.join(freight.map((b) => sql`${b.id}::uuid`), sql`, `)})
       GROUP BY 1, 2`)) as unknown as { id: string; k: string; usd: string }[];
    for (const r of rows) {
      if (!allocated.has(r.id)) allocated.set(r.id, new Map());
      allocated.get(r.id)!.set(r.k, Number(r.usd));
    }
  }
  for (const bill of freight) {
    const copy = copies.get(bill.id) ?? 'missing';
    // The customs flag only for a bill that really is on no box: a bill split
    // BEFORE its type joined the customs list keeps its shares until the next
    // recompute, and its fold must say what the money is on now (fix review).
    const customs = !bill.hasShare && customsIds.includes(bill.costTypeId);
    const view = viewOf(measuresByTruck.get(bill.batchId!) ?? [], copy, money, customs);
    let allocatedUsd: Record<string, number> | undefined;
    const sums = allocated.get(bill.id);
    if (money && sums && bill.amountUsd !== null) {
      // The ONE cents rule (lotCents, key order): the fold, the preview and
      // the re-basis rows round a lot — and so a client — the same way.
      allocatedUsd = lotCents(Number(bill.amountUsd), [...sums].map(([key, weight]) => ({ key, weight })));
    }
    out.set(bill.id, {
      zone: typeof copy === 'object' ? copy.zone : '',
      tariffFrom: typeof copy === 'object' ? copy.tariffFrom : '',
      unsplit: bill.amountUsd !== null && !bill.hasShare,
      view,
      ...(allocatedUsd ? { allocatedUsd } : {}),
      ...(money && bill.amountUsd !== null ? { amountUsd: Number(bill.amountUsd) } : {}),
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
