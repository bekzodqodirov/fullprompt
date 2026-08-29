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

  // Where this client's cargo stands, per warehouse — the scoped person sees
  // only their own floors, which is the same cut the stock screen makes.
  const rows = await db
    .select({
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      whCode: warehouses.code,
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
    .groupBy(boxes.status, boxes.currentWarehouseId, warehouses.code);

  const visible = rows.filter(
    (r) => inScope(actor, r.warehouseId) || (r.status === 'in_transit' && !actor.warehouseScoped),
  );
  const lines = visible
    .map((r) => `· ${r.whCode ?? 'yo‘lda'}: ${Number(r.n)} — ${STATUS_UZ[r.status] ?? r.status}`)
    .sort();

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

  return (
    `👤 ${client.clientCode} · ${client.name}\n` +
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
