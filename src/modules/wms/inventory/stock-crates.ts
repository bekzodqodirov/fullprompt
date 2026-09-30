import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { warehouseScope } from '../../platform/rbac/scope';
import { codeIdentity } from '../labels/code-identity';
import { SHELF_STATUSES } from './service';
import { crateHereOn } from './stock-filter';
import {
  crateMeasure,
  groupCrates,
  type CratePart,
  type CrateSummary,
  type CrateTotal,
  type RowCrates,
} from './crate-grouping';

export interface StockCrates {
  /** Keyed by `rowKey(lotId, warehouseId)` — the table's own row. */
  byRow: Map<string, RowCrates>;
  /** Every crate in the result, in label order, with its ⚠. */
  crates: CrateSummary[];
  /** Cartons standing in those crates — the Σ's crated part. */
  crated: number;
}

/**
 * The crates the stock table's rows stand in, for the SAME filter the rows,
 * the Σ and the export are counted from (#513): the caller hands over its own
 * `WHERE` list and this query joins the same five tables, so a search that
 * narrows the table narrows the crates with it.
 *
 * Uncapped on purpose. The table's fetch is capped and its render is paged,
 * but the Σ's «N mesta» must describe everything the filter matched, exactly
 * as the Σ's cartons do — and the groups here are (crate, lot) pairs, never
 * more than the crated cartons themselves.
 *
 * `narrowed` = a search is on. Then the parts are only the matching cartons,
 * and the ⚠ must still be judged on the WHOLE crate, so its present members
 * are counted once more without the search. Without one the parts ARE the
 * whole crate (every member of a crate here stands at the crate's own
 * warehouse, inside or outside the viewer's scope together), and the second
 * statement is skipped.
 */
export async function stockCrates(
  filters: SQL[],
  opts: { narrowed: boolean },
): Promise<StockCrates> {
  const rows = await db
    .select({
      crateId: crates.id,
      code: crates.code,
      kind: crates.kind,
      lengthCm: crates.lengthCm,
      widthCm: crates.widthCm,
      heightCm: crates.heightCm,
      weightKg: crates.weightKg,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      warehouseId: boxes.currentWarehouseId,
      marking: receipts.unclaimedMarking,
      clientCode: clients.clientCode,
      n: sql<number>`count(*)::int`,
      seqs: sql<number[]>`array_agg(${boxes.seqInLot} ORDER BY ${boxes.seqInLot})`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .innerJoin(crates, crateHereOn())
    .where(and(...filters))
    .groupBy(crates.id, receiptLots.id, receipts.id, clients.id, boxes.currentWarehouseId);

  const parts: CratePart[] = rows.map((row) => ({
    crateId: row.crateId,
    code: row.code,
    kind: row.kind,
    lotId: row.lotId,
    warehouseId: row.warehouseId!,
    letter: row.letter ?? '',
    lotCode: `${codeIdentity(row.marking, row.clientCode).main}-${row.letter ?? ''}`,
    n: Number(row.n),
    seqs: (row.seqs ?? []).map(Number),
    kg: Number(row.kg ?? 0),
    m3: Number(row.m3 ?? 0),
    dims: {
      lengthCm: row.lengthCm,
      widthCm: row.widthCm,
      heightCm: row.heightCm,
      weightKg: row.weightKg,
    },
  }));

  let totals: Map<string, CrateTotal> | undefined;
  const ids = [...new Set(parts.map((part) => part.crateId))];
  if (opts.narrowed && ids.length > 0) {
    const whole = await db
      .select({
        crateId: crates.id,
        total: sql<number>`count(*)::int`,
        kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
        m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
      })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(crates, crateHereOn())
      .where(and(inArray(crates.id, ids), inArray(boxes.status, [...SHELF_STATUSES])))
      .groupBy(crates.id);
    totals = new Map(
      whole.map((row) => [
        row.crateId,
        { total: Number(row.total), kg: Number(row.kg ?? 0), m3: Number(row.m3 ?? 0) },
      ]),
    );
  }

  const grouped = groupCrates(parts, totals);
  return {
    byRow: grouped.byRow,
    crates: grouped.crates,
    crated: parts.reduce((sum, part) => sum + part.n, 0),
  };
}

export interface CrateCarton {
  id: string;
  shortCode: string;
  seqInLot: number;
  status: string;
}

export interface CrateContents {
  id: string;
  code: string;
  kind: string;
  status: string;
  clientCode: string;
  warehouseCode: string;
  statedM3: number | null;
  statedKg: number | null;
  kg: number;
  m3: number;
  over: boolean;
  /** Present cartons grouped by lot, oldest prixod first. */
  lots: {
    lotId: string;
    lotCode: string;
    productNameZh: string;
    productNameRu: string | null;
    boxTotal: number;
    cartons: CrateCarton[];
  }[];
  /** Members that are not standing in the crate right now (on a truck, left behind). */
  away: number;
}

/**
 * One crate opened on /stock (his answer 2a: «yana bir bosishda shu
 * yashikning har bir karobkasi alohida ko'rinadi»).
 *
 * The door is the stock screen's own: any login, the crate's warehouse inside
 * the viewer's scope. The crate CARD stays `crates.manage` — this lists the
 * same cartons the stock table already shows its reader, grouped by the
 * crate they stand in, and nothing a warehouse writes about the crate (its
 * note) crosses over.
 *
 * Its cartons are the crate's members standing in it (`crateHereOn` + the
 * shelf statuses), so the number here is the number on the row it was opened
 * from; the rest are counted as `away` rather than listed, because a carton
 * on a truck or left at the origin is not in this crate on this shelf.
 */
export async function crateContents(
  actor: Parameters<typeof warehouseScope>[0],
  crateId: string,
): Promise<CrateContents | null> {
  const [crate] = await db
    .select({
      id: crates.id,
      code: crates.code,
      kind: crates.kind,
      status: crates.status,
      warehouseId: crates.warehouseId,
      lengthCm: crates.lengthCm,
      widthCm: crates.widthCm,
      heightCm: crates.heightCm,
      weightKg: crates.weightKg,
      clientCode: clients.clientCode,
      warehouseCode: warehouses.code,
    })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(and(eq(crates.id, crateId), warehouseScope(actor, crates.warehouseId)))
    .limit(1);
  if (!crate) return null;

  const members = await db
    .select({
      id: boxes.id,
      shortCode: boxes.shortCode,
      seqInLot: boxes.seqInLot,
      status: boxes.status,
      currentWarehouseId: boxes.currentWarehouseId,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxTotal: receiptLots.boxCount,
      kgPerBox: sql<string>`${receiptLots.totalWeightKg} / ${receiptLots.boxCount}`,
      m3PerBox: sql<string>`${receiptLots.totalVolumeM3} / ${receiptLots.boxCount}`,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(eq(boxes.crateId, crate.id))
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter), asc(boxes.seqInLot));

  const lots = new Map<string, CrateContents['lots'][number]>();
  let kg = 0;
  let m3 = 0;
  let away = 0;
  const shelf: readonly string[] = SHELF_STATUSES;
  for (const member of members) {
    // `crateHereOn` restated over ONE crate's rows, in JS rather than as a
    // second SQL spelling: the crate is already loaded, and the three facts
    // are its status, its warehouse and the carton's.
    const present =
      crate.status === 'active' &&
      shelf.includes(member.status) &&
      member.currentWarehouseId === crate.warehouseId;
    if (!present) {
      away += 1;
      continue;
    }
    kg += Number(member.kgPerBox);
    m3 += Number(member.m3PerBox);
    const lot = lots.get(member.lotId) ?? {
      lotId: member.lotId,
      lotCode: `${codeIdentity(member.marking, crate.clientCode).main}-${member.letter ?? ''}`,
      productNameZh: member.productNameZh,
      productNameRu: member.productNameRu,
      boxTotal: member.boxTotal,
      cartons: [],
    };
    lot.cartons.push({
      id: member.id,
      shortCode: member.shortCode,
      seqInLot: member.seqInLot,
      status: member.status,
    });
    lots.set(member.lotId, lot);
  }
  const measure = crateMeasure(crate, kg, m3);
  return {
    id: crate.id,
    code: crate.code,
    kind: crate.kind,
    status: crate.status,
    clientCode: crate.clientCode,
    warehouseCode: crate.warehouseCode,
    statedM3: measure.statedM3,
    statedKg: measure.statedKg,
    kg: measure.kg,
    m3: measure.m3,
    over: measure.over,
    lots: [...lots.values()],
    away,
  };
}

/**
 * Which crate each carton of a lot stands in, for the lot drill-down's chips —
 * through `crateHereOn`, so a carton left behind at the origin wears no chip
 * for a crate that is now in another country (the row it was opened from
 * counts it loose).
 */
export async function crateCodesForLot(lotId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ boxId: boxes.id, code: crates.code })
    .from(boxes)
    .innerJoin(crates, crateHereOn())
    .where(and(eq(boxes.lotId, lotId), inArray(boxes.status, [...SHELF_STATUSES])));
  return new Map(rows.map((row) => [row.boxId, row.code]));
}
