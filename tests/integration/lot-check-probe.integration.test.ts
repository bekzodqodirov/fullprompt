import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The tick's FIRST press of a process — nothing has probed for 0144's table yet.
 *
 * `lotClientConfirmsReady()` is a remembered answer, and every other
 * integration file about the check MOCKS the module that remembers it — so
 * none of them could see a writer that reads the answer without ever asking.
 * In the built app that writer was the tick: a server action lives in its own
 * module instance, the card's page never warms it, and until somebody pressed
 * «Mijozdan so'rash» after a restart the logist's «✅ To'g'ri» on a lot the
 * client had answered was refused `check_changed` on every press — the second
 * way out of a ❌, dead after every deploy (the as-built review, L1-1).
 *
 * This file therefore mocks NOTHING of the probe, and its fixtures are written
 * straight to the tables: the first service call of each case is the press
 * itself, exactly like the first action of a fresh process. Vitest gives a
 * file its own module state, which is what makes it that process.
 */

vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'lot-check-probe.integration' }),
}));

import { db } from '@/modules/platform/db/client';
import { boxes, clients, receiptLots, receipts, users, warehouses } from '@/modules/platform/db/schema';
import { checkLot, type LotCheckActor } from '@/modules/wms/receipts/lot-check';

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

let logistId = '';
let warehouseId = '';
let clientId = '';
let receiptId = '';
const lots: string[] = [];

const logist = (): LotCheckActor => ({
  id: logistId,
  permissions: new Set(['plans.manage', 'receipts.edit']),
  warehouseScoped: false,
  warehouseIds: [],
});
const ctx = () => ({ actorId: logistId, ip: null, userAgent: 'lot-check-probe.integration' });

const NAME = (n: number) => `探针${SFX}${n}`;

async function mintLot(seq: number): Promise<string> {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq,
      letter: String.fromCharCode(64 + seq),
      cycleNo: 1,
      productNameZh: NAME(seq),
      productNameRu: null,
      boxCount: 3,
      dimsMode: 'mixed',
      totalWeightKg: '30.000',
      totalVolumeM3: '0.3000',
    })
    .returning({ id: receiptLots.id });
  await db.insert(boxes).values(
    [1, 2, 3].map((i) => ({
      lotId: row!.id,
      seqInLot: i,
      shortCode: `PB${SFX}${seq}${i}`,
      status: 'in_stock',
      currentWarehouseId: warehouseId,
    })),
  );
  lots.push(row!.id);
  return row!.id;
}

/** The owner's ❌ on a lot, as the bot would have written it — and the token a card would draw. */
async function disputeBy(lotId: string, seq: number): Promise<string> {
  const rows = (await db.execute(sql`
    INSERT INTO lot_client_confirms (lot_id, verdict, shown_zh, shown_ru, shown_count, shown_client_id, shown_goods_key, chat_id)
    VALUES (${lotId}::uuid, 'no', ${NAME(seq)}, NULL, 3, ${clientId}::uuid, NULL, 990000001)
    RETURNING answered_at::text AS token
  `)) as unknown as { token: string }[];
  return rows[0]!.token;
}

const seen = (seq: number) => ({ nameZh: NAME(seq), nameRu: '', boxCount: 3, clientId });

async function tick(lotId: string) {
  const rows = (await db.execute(sql`
    SELECT checked_at::text AS at, checked_at > (SELECT answered_at FROM lot_client_confirms WHERE lot_id = ${lotId}::uuid) AS newer
      FROM lot_checks WHERE lot_id = ${lotId}::uuid
  `)) as unknown as { at: string; newer: boolean | null }[];
  return rows[0] ?? null;
}

beforeAll(async () => {
  logistId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000003') }))!.id;
  const [w] = await db
    .insert(warehouses)
    .values({
      code: `PB${SFX.slice(0, 4)}`,
      name: `Probe ${SFX}`,
      country: 'CN',
      type: 'origin',
      timezone: 'Asia/Shanghai',
      batchPrefix: `PB${SFX.slice(0, 4)}`,
    })
    .returning({ id: warehouses.id });
  warehouseId = w!.id;
  const [c] = await db.insert(clients).values({ clientCode: `PB${SFX}`, name: `Probe ${SFX}` }).returning({ id: clients.id });
  clientId = c!.id;
  const [r] = await db
    .insert(receipts)
    .values({
      number: `PB-${SFX}`,
      warehouseId,
      clientId,
      status: 'confirmed',
      createdBy: logistId,
      confirmedAt: new Date(Date.now() - 48 * 3_600_000),
      confirmedBy: logistId,
    })
    .returning({ id: receipts.id });
  receiptId = r!.id;
});

afterAll(async () => {
  // The prixod and its lots go (their checks and answers cascade); the
  // warehouse is only DEACTIVATED — the tick's audit rows name it.
  if (lots.length > 0) {
    await db.delete(boxes).where(inArray(boxes.lotId, lots));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lots));
  }
  if (receiptId) await db.delete(receipts).where(eq(receipts.id, receiptId));
  if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
  if (warehouseId) await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, warehouseId));
});

describe('the tick asks for 0144 itself — it never trusts what another screen remembered', () => {
  it('the FIRST press of a process lifts the client’s ❌ it was drawn with', async () => {
    const lotId = await mintLot(1);
    const token = await disputeBy(lotId, 1);

    // No reader has run: this press is the first thing the process does.
    const done = await checkLot({ lotId, seen: seen(1), seenCheckedAt: null, seenClientAt: token }, logist(), ctx());

    expect(done).toEqual({ changed: true });
    const row = await tick(lotId);
    expect(row).not.toBeNull();
    // The tick is the newer of the two — which is what the sentence reads as «lifted».
    expect(row!.newer).toBe(true);
    // …and it remembers the kilos and cubic metres (0147, his «2 b»): the first press
    // of a process asks the probe itself — never a flag nobody has warmed — or the
    // tick would be stored measure-less and hold through every re-weigh.
    const [measured] = (await db.execute(sql`
      SELECT seen_kg::text AS kg, seen_m3::text AS m3 FROM lot_checks WHERE lot_id = ${lotId}::uuid
    `)) as unknown as { kg: string | null; m3: string | null }[];
    expect(measured).toEqual({ kg: '30.00', m3: '0.300' });
  });

  it('…and the presser’s own OLDER tick does not make it «already confirmed»', async () => {
    const lotId = await mintLot(2);
    // The colleague's tick holds every fact of the lot and is the presser's own…
    await db.execute(sql`
      INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, note, checked_by, checked_at)
      VALUES (${lotId}::uuid, ${NAME(2)}, NULL, 3, ${clientId}::uuid, NULL, ${logistId}::uuid, now() - interval '1 hour')
    `);
    // …and the client's ❌ came after it, so it vetoes.
    const token = await disputeBy(lotId, 2);
    const before = await tick(lotId);
    expect(before!.newer).toBe(false);

    const done = await checkLot({ lotId, seen: seen(2), seenCheckedAt: before!.at, seenClientAt: token }, logist(), ctx());

    // A press that wrote nothing would leave the ❌ standing with «done» on the screen.
    expect(done).toEqual({ changed: true });
    expect((await tick(lotId))!.newer).toBe(true);
  });

  it('a ❌ that landed AFTER the card was drawn is not lifted unseen', async () => {
    const lotId = await mintLot(3);
    // The card was drawn with no answer on the lot; the client pressed ❌ meanwhile.
    await disputeBy(lotId, 3);

    await expect(
      checkLot({ lotId, seen: seen(3), seenCheckedAt: null, seenClientAt: null }, logist(), ctx()),
    ).rejects.toMatchObject({ code: 'check_changed' });
    expect(await tick(lotId)).toBeNull();
  });
});
