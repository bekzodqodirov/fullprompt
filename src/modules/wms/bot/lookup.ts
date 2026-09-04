import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { seesAllMoney } from '../finance/scope';
import { clientBalanceUsd } from '../finance/service';
import { arrivalCodesForPairs } from '../documents/arrivals';

/**
 * "Where is it?" — answered in the bot (owner's item 2).
 *
 * The question the office answers by telephone all day: a client rings, a
 * driver rings, and the person holding the phone is not at a computer. One
 * typed code — a client code, a box short code, a crate or a batch — and the
 * bot says what the system knows.
 *
 * It reads exactly as far as the person's own grants and warehouses reach:
 * a warehouse-scoped operator asking about cargo standing in another country
 * gets the honest "not in your warehouse", and the balance line appears only
 * for people the finance screens are open to. A read that is easier through
 * the bot than through the app would be a back door, and this bot is used by
 * everyone.
 */

export interface BotActor extends ScopedActor {
  id: string;
  permissions: Set<string>;
}

const STATUS_UZ: Record<string, string> = {
  in_stock: 'omborda',
  planned: 'planda',
  loading: 'yuklanmoqda',
  in_transit: 'yo‘lda',
  ready_for_pickup: 'olib ketishga tayyor',
  issued: 'berilgan',
  lost: 'yo‘qolgan',
  void: 'bekor qilingan',
};

const BATCH_STATUS_UZ: Record<string, string> = {
  forming: 'shakllanmoqda',
  loading: 'yuklanmoqda',
  in_transit: 'yo‘lda',
  arrived: 'yetib keldi',
  unloaded: 'tushirildi',
  closed: 'yopilgan',
  cancelled: 'bekor qilingan',
};

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The answer to one typed line. Null when nothing matched — the caller says
 * so once, rather than every branch inventing its own "not found".
 */
export async function botLookup(actor: BotActor, raw: string): Promise<string | null> {
  const query = raw.trim();
  if (query.length < 3 || query.length > 40) return null;
  const upper = query.toUpperCase();

  // A box short code is the most specific thing anyone types, and it is the
  // one a warehouse hand reads off a label — try it first.
  const box = await lookupBox(actor, upper);
  if (box) return box;

  const crate = await lookupCrate(actor, upper);
  if (crate) return crate;

  const batch = await lookupBatch(actor, upper);
  if (batch) return batch;

  return lookupClient(actor, upper);
}

async function lookupBox(actor: BotActor, code: string): Promise<string | null> {
  const [row] = await db
    .select({
      box: boxes,
      letter: receiptLots.letter,
      productZh: receiptLots.productNameZh,
      productRu: receiptLots.productNameRu,
      receiptNumber: receipts.number,
      clientCode: clients.clientCode,
      clientName: clients.name,
      marking: receipts.unclaimedMarking,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(sql`upper(${boxes.shortCode}) = ${code}`)
    .limit(1);
  if (!row) return null;

  // A box in transit belongs to nobody's warehouse; its batch's two ends are
  // what a scoped person may legitimately be asking about.
  const batch = row.box.currentBatchId
    ? await db.query.batches.findFirst({ where: eq(batches.id, row.box.currentBatchId) })
    : null;
  const reachable =
    inScope(actor, row.box.currentWarehouseId) ||
    (batch ? inScope(actor, batch.originWarehouseId) || inScope(actor, batch.destWarehouseId) : false);
  if (!reachable) return `📦 ${row.box.shortCode}\n${outOfScope()}`;

  const wh = row.box.currentWarehouseId
    ? await db.query.warehouses.findFirst({ where: eq(warehouses.id, row.box.currentWarehouseId) })
    : null;
  const product = row.productRu?.trim() || row.productZh;
  return (
    `📦 ${row.box.shortCode}\n` +
    `${row.clientCode ?? row.marking ?? '—'}${row.clientName ? ` (${row.clientName})` : ''}` +
    `${row.letter ? ` · ${row.letter}` : ''} · ${product}\n` +
    `Holati: ${STATUS_UZ[row.box.status] ?? row.box.status}` +
    (wh ? ` · ${wh.code}` : '') +
    (batch ? `\nPartiya: ${batch.code} (${BATCH_STATUS_UZ[batch.status] ?? batch.status})` : '') +
    (row.receiptNumber ? `\nPrixod: ${row.receiptNumber}` : '')
  );
}

async function lookupCrate(actor: BotActor, code: string): Promise<string | null> {
  if (!/^CR-/.test(code)) return null;
  const [row] = await db
    .select({ crate: crates, clientCode: clients.clientCode, whCode: warehouses.code })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .where(sql`upper(${crates.code}) = ${code}`)
    .limit(1);
  if (!row) return null;
  if (!inScope(actor, row.crate.warehouseId)) return `📦 ${row.crate.code}\n${outOfScope()}`;

  const members = await db
    .select({ shortCode: boxes.shortCode, status: boxes.status })
    .from(boxes)
    .where(eq(boxes.crateId, row.crate.id));
  const byStatus = new Map<string, number>();
  for (const m of members) byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
  return (
    `🧰 ${row.crate.code} · ${row.clientCode}\n` +
    `${row.crate.status === 'active' ? 'Yig‘ilgan' : 'Tarqatilgan'} · ${row.whCode}\n` +
    `Ichida: ${members.length} karobka` +
    (byStatus.size
      ? `\n${[...byStatus].map(([s, n]) => `${STATUS_UZ[s] ?? s}: ${n}`).join(' · ')}`
      : '')
  );
}

async function lookupBatch(actor: BotActor, code: string): Promise<string | null> {
  const dest = warehouses;
  const [row] = await db
    .select({ batch: batches, originCode: warehouses.code })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .where(sql`upper(${batches.code}) = ${code}`)
    .limit(1);
  if (!row) return null;
  if (
    !inScope(actor, row.batch.originWarehouseId) &&
    !inScope(actor, row.batch.destWarehouseId)
  ) {
    return `🚚 ${row.batch.code}\n${outOfScope()}`;
  }
  const destWh = await db.query.warehouses.findFirst({
    where: eq(dest.id, row.batch.destWarehouseId),
  });

  // What really rode it — the movement log, never the live pointer, which
  // unloading clears box by box (#152 / the manifest's lesson).
  const [counts] = await db
    .select({
      departed: sql<number>`count(DISTINCT bm.box_id)`,
    })
    .from(sql`box_movements bm`)
    .where(
      sql`bm.ref_type = 'batch' AND bm.ref_id = ${row.batch.id} AND bm.cause = 'batch_departed'
        AND NOT EXISTS (SELECT 1 FROM boxes vb WHERE vb.id = bm.box_id AND vb.status = 'void')`,
    );
  const [waiting] = await db
    .select({ n: sql<number>`count(*)` })
    .from(boxes)
    .where(and(eq(boxes.currentBatchId, row.batch.id), eq(boxes.status, 'in_transit')));

  return (
    `🚚 ${row.batch.code}\n` +
    `${row.originCode} → ${destWh?.code ?? '—'} · ${BATCH_STATUS_UZ[row.batch.status] ?? row.batch.status}\n` +
    `Yuklangan: ${Number(counts?.departed ?? 0)} karobka` +
    (Number(waiting?.n ?? 0) > 0 ? `\nHali qabul qilinmagan: ${Number(waiting!.n)}` : '') +
    (row.batch.departedAt
      ? `\nJo‘nadi: ${row.batch.departedAt.toISOString().slice(0, 10)}`
      : '') +
    (row.batch.vehiclePlate ? `\nMashina: ${row.batch.vehiclePlate}` : '') +
    (row.batch.driverName ? `\nHaydovchi: ${row.batch.driverName}` : '')
  );
}

async function lookupClient(actor: BotActor, code: string): Promise<string | null> {
  const [client] = await db
    .select()
    .from(clients)
    .where(sql`upper(${clients.clientCode}) = ${code}`)
    .limit(1);
  if (!client) return null;

  // The FULL cargo picture (phase 4, the owner's item 6): per (lot,
  // warehouse) — goods · boxes with the status split · kg · m³ · the truck
  // it arrived on — inside the same cut the stock screen makes. ONE grouped
  // query (the bot answers on grammy's sequential poller, round 101), then
  // #853's arrival rule for the partiya, one query per warehouse the client
  // actually stands in.
  const rows = await db
    .select({
      lotId: receiptLots.id,
      productZh: receiptLots.productNameZh,
      productRu: receiptLots.productNameRu,
      lotBoxes: receiptLots.boxCount,
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      whCode: warehouses.code,
      batchId: boxes.currentBatchId,
      n: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(
      and(
        eq(receipts.clientId, client.id),
        inArray(boxes.status, ['in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup']),
      ),
    )
    .groupBy(
      receiptLots.id,
      receiptLots.productNameZh,
      receiptLots.productNameRu,
      receiptLots.boxCount,
      receiptLots.totalWeightKg,
      receiptLots.totalVolumeM3,
      boxes.status,
      boxes.currentWarehouseId,
      warehouses.code,
      boxes.currentBatchId,
    );

  // In-transit visibility: unscoped actors as always, PLUS the batch's two
  // ends for scoped ones — wms/search's own rule, a recorded widening.
  const transitBatchIds = [...new Set(rows.filter((r) => r.batchId).map((r) => r.batchId!))];
  const transitBatches = transitBatchIds.length
    ? await db.select().from(batches).where(inArray(batches.id, transitBatchIds))
    : [];
  const batchById = new Map(transitBatches.map((b) => [b.id, b]));

  const share = (total: string | null, lotBoxes: number, n: number, digits: number) => {
    const t = total === null ? null : Number(total);
    return t === null || !Number.isFinite(t) || lotBoxes <= 0
      ? null
      : (t * (n / lotBoxes)).toFixed(digits);
  };

  let hiddenBoxes = 0;
  // Standing cargo folds per (lot, warehouse); transit folds per batch.
  const standing = new Map<
    string,
    {
      lotId: string;
      warehouseId: string;
      whCode: string;
      product: string;
      lotBoxes: number;
      lotKg: string | null;
      lotM3: string | null;
      n: number;
      byStatus: Map<string, number>;
    }
  >();
  const transit = new Map<string, { code: string; route: string; n: number; kg: number; m3: number }>();
  for (const r of rows) {
    const n = Number(r.n);
    if (r.status === 'in_transit') {
      const b = r.batchId ? batchById.get(r.batchId) : undefined;
      const reachable =
        !actor.warehouseScoped ||
        (b ? inScope(actor, b.originWarehouseId) || inScope(actor, b.destWarehouseId) : false);
      if (!reachable) {
        hiddenBoxes += n;
        continue;
      }
      const key = b?.id ?? 'yolda';
      const entry = transit.get(key) ?? {
        code: b?.code ?? 'yo‘lda',
        route: '',
        n: 0,
        kg: 0,
        m3: 0,
      };
      entry.n += n;
      entry.kg += Number(share(r.lotKg, r.lotBoxes, n, 1) ?? 0);
      entry.m3 += Number(share(r.lotM3, r.lotBoxes, n, 3) ?? 0);
      transit.set(key, entry);
      continue;
    }
    if (!inScope(actor, r.warehouseId)) {
      hiddenBoxes += n;
      continue;
    }
    if (!r.warehouseId || !r.whCode) continue;
    const key = `${r.lotId}|${r.warehouseId}`;
    const entry = standing.get(key) ?? {
      lotId: r.lotId,
      warehouseId: r.warehouseId,
      whCode: r.whCode,
      product: r.productRu?.trim() || r.productZh,
      lotBoxes: r.lotBoxes,
      lotKg: r.lotKg,
      lotM3: r.lotM3,
      n: 0,
      byStatus: new Map<string, number>(),
    };
    entry.n += n;
    entry.byStatus.set(r.status, (entry.byStatus.get(r.status) ?? 0) + n);
    standing.set(key, entry);
  }

  // The partiya each shelf-standing lot arrived on (#853's rule, verbatim).
  const arrivalCodes = await arrivalCodesForPairs(
    [...standing.values()].map((s) => ({ lotId: s.lotId, warehouseId: s.warehouseId })),
  );

  const LINE_CAP = 20;
  const standingLines = [...standing.values()]
    .sort((a, b) => a.whCode.localeCompare(b.whCode) || a.product.localeCompare(b.product))
    .map((s) => {
      const kg = share(s.lotKg, s.lotBoxes, s.n, 1);
      const m3 = share(s.lotM3, s.lotBoxes, s.n, 3);
      const statuses = [...s.byStatus]
        .map(([st, c]) => `${STATUS_UZ[st] ?? st} ${c}`)
        .join(' · ');
      const codes = arrivalCodes.get(`${s.lotId}|${s.warehouseId}`) ?? [];
      return (
        `· ${s.whCode}: ${s.product} — ${s.n} karobka (${statuses})` +
        (kg !== null ? ` · ${kg} kg` : '') +
        (m3 !== null ? ` · ${m3} m³` : '') +
        (codes.length ? ` · 🚚 ${codes.join(', ')}` : '')
      );
    });
  const transitLines = [...transit.values()].map((tr) => {
    return (
      `· 🚚 ${tr.code} yo‘lda: ${tr.n} karobka` +
      (tr.kg > 0 ? ` · ${tr.kg.toFixed(1)} kg` : '') +
      (tr.m3 > 0 ? ` · ${tr.m3.toFixed(3)} m³` : '')
    );
  });
  const allLines = [...standingLines, ...transitLines];
  const lines = allLines.slice(0, LINE_CAP);
  if (allLines.length > LINE_CAP) lines.push(`… +${allLines.length - LINE_CAP} qator`);
  // A scoped operator must never read «yuk yo‘q» about cargo that exists —
  // the dropped rows are counted and said (round 36's rule, kept honest).
  if (hiddenBoxes > 0) lines.push(`(+${hiddenBoxes} karobka boshqa joylarda — sizga ko‘rinmaydi)`);

  // Money is a permission, not a courtesy — and since round 91 it is also
  // OWNED: `finance.view` alone is a seller, and a seller reads only their
  // own book (`finance/scope.ts`). This line had kept the pre-91 two-grant
  // check, so the bot answered a balance the /finance screen refuses — found
  // by the AI round's review, because a conversational door makes a quiet
  // leak a loud one.
  const canSeeMoney =
    (actor.permissions.has('finance.view') || actor.permissions.has('finance.manage')) &&
    (seesAllMoney(actor) || client.salesManagerId === actor.id);
  const balance = canSeeMoney ? await clientBalanceUsd(client.id) : null;

  // Confirmed only: voidReceipt keeps confirmed_at, so an annulled prixod
  // would otherwise stay «oxirgi prixod» until the next real one.
  const [lastReceipt] = await db
    .select({ number: receipts.number, at: receipts.confirmedAt })
    .from(receipts)
    .where(and(eq(receipts.clientId, client.id), eq(receipts.status, 'confirmed')))
    .orderBy(desc(receipts.confirmedAt))
    .limit(1);

  // The Σ he asks the phone for: boxes, kg, m³ over what THIS person may see.
  let totalN = 0;
  let totalKg = 0;
  let totalM3 = 0;
  for (const s of standing.values()) {
    totalN += s.n;
    totalKg += Number(share(s.lotKg, s.lotBoxes, s.n, 1) ?? 0);
    totalM3 += Number(share(s.lotM3, s.lotBoxes, s.n, 3) ?? 0);
  }
  for (const tr of transit.values()) {
    totalN += tr.n;
    totalKg += tr.kg;
    totalM3 += tr.m3;
  }
  const jami =
    totalN > 0
      ? `Jami: ${totalN} karobka · ${totalKg.toFixed(1)} kg · ${totalM3.toFixed(3)} m³\n`
      : '';

  return (
    `👤 ${client.clientCode} · ${client.name}\n` +
    jami +
    (lines.length ? `${lines.join('\n')}` : 'Hozircha yuk yo‘q') +
    (balance !== null
      ? `\n💰 Balans: ${money(balance)}${balance > 0.009 ? ' (qarz)' : ''}`
      : '') +
    (lastReceipt?.number
      ? `\nOxirgi prixod: ${lastReceipt.number}${
          lastReceipt.at ? ` (${lastReceipt.at.toISOString().slice(0, 10)})` : ''
        }`
      : '')
  );
}

function outOfScope(): string {
  return 'Bu sizning omboringizda emas.';
}
