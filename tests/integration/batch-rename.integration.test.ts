import 'dotenv/config';
import { aliasedTable, and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  boxMovements,
  clients,
  receiptLots,
  receipts,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { warehouseScopeEither } from '@/modules/platform/rbac/scope';
import { nextBatchCode, nextBoxCodes } from '@/modules/wms/codes';
import { RenameError, renameBatch } from '@/modules/wms/batches/rename';
import type { RenameDoorActor } from '@/modules/wms/batches/rename-door';
import {
  batchTextMatchSql,
  codeEverWornSql,
  formerCodeHitSql,
} from '@/modules/wms/batches/former-codes';
import { cancelBatch, finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { annulReceipt } from '@/modules/wms/receipts/annul';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';
import { botLookupAnswer, type BotActor } from '@/modules/wms/bot/lookup';
import { likeNeedle } from '@/modules/wms/search/query';

/**
 * A truck renamed on the road (the owner's 1a / 2a / 3a, 2026-09-30 —
 * reverses DECISIONS #122), against real rows.
 *
 * Every fixture is this file's own: its trucks, cartons, clients and names
 * carry a per-run tag (#598), the three warehouses are fixed codes reused
 * across runs (an audited warehouse can only be deactivated, never deleted),
 * and the trucks are DELETED at the end — an in-transit leftover is a truck on
 * /transit, the map and the silent-truck sweep for every later spec (#154).
 * The rename's audit rows stay (audit_log refuses DELETE), and every reader
 * JOINs to `batches`, so an orphan is invisible. `client_code_prefix` is read,
 * never written.
 */

const WH_O = 'RNMO';
const WH_D = 'RNMD';
const WH_X = 'RNMX';
const STAMP = String(Date.now()).slice(-6);
let seq = 0;
/** A per-run name tail: the counter at the FRONT of nothing, the clock beside it (#598). */
const tag = () => `${STAMP}${seq++}`;

let originId = '';
let destId = '';
let thirdId = '';
let actorId = '';
let clientId = '';
let clientCode = '';
const ctx = () => ({ actorId });
const trucks: string[] = [];
const boxIds: string[] = [];
const receiptIds: string[] = [];
const clientIds: string[] = [];
const counterKeys: string[] = [];

const planner = (): RenameDoorActor => ({
  id: actorId,
  permissions: new Set(['plans.manage']),
  warehouseScoped: false,
  warehouseIds: [],
});

type Seen = { code: string; stage: 'loading' | 'road' };

function rename(batchId: string, code: string, seen: Seen, reason?: string, door = planner()) {
  return renameBatch({ batchId, code, reason, seen }, door, ctx());
}

/** The refusal's code (and detail), or 'ok' — never a thrown test. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof RenameError) return err.detail && !['batch_changed'].includes(err.code) ? `${err.code}/${err.detail}` : err.code;
    throw err;
  }
}

async function codeOf(batchId: string): Promise<string> {
  return (await db.query.batches.findFirst({ where: eq(batches.id, batchId) }))!.code;
}

async function renameRows(batchId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'batch'),
        eq(auditLog.entityId, batchId),
        sql`(${auditLog.before}->>'code') IS NOT NULL`,
      ),
    );
}

/**
 * A truck of this file's own. `cartons` cartons ride it: `loading` on a
 * forming truck, `in_transit` (with the departure movement) on a departed one,
 * each with a REAL minted short code — `nextBoxCodes`, the one the labels use.
 */
async function mintTruck(opts: {
  status: 'forming' | 'in_transit';
  cartons: number;
  code?: string;
  origin?: string;
  dest?: string;
}) {
  const code = opts.code ?? `RNT-${tag()}`;
  const departed = opts.status !== 'forming';
  const [truck] = await db
    .insert(batches)
    .values({
      code,
      originWarehouseId: opts.origin ?? originId,
      destWarehouseId: opts.dest ?? destId,
      status: opts.status,
      departedAt: departed ? new Date() : null,
      createdBy: actorId,
    })
    .returning();
  trucks.push(truck!.id);
  let boxCodes: string[] = [];
  let receiptId = '';
  if (opts.cartons > 0) {
    const [receipt] = await db
      .insert(receipts)
      .values({ warehouseId: originId, clientId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
      .returning();
    receiptId = receipt!.id;
    receiptIds.push(receiptId);
    const [lot] = await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        dimsMode: 'mixed',
        productNameZh: '改名',
        boxCount: opts.cartons,
        totalWeightKg: String(opts.cartons * 10),
        totalVolumeM3: String(opts.cartons * 0.2),
      })
      .returning();
    boxCodes = await nextBoxCodes(db, { code: WH_O, timezone: 'Asia/Shanghai' }, opts.cartons);
    const rows = await db
      .insert(boxes)
      .values(
        boxCodes.map((shortCode, i) => ({
          lotId: lot!.id,
          shortCode,
          seqInLot: i + 1,
          status: departed ? 'in_transit' : 'loading',
          currentBatchId: truck!.id,
          currentWarehouseId: departed ? null : originId,
        })),
      )
      .returning();
    boxIds.push(...rows.map((r) => r.id));
    if (departed) {
      await db.insert(boxMovements).values(
        rows.map((r) => ({
          boxId: r.id,
          fromWarehouseId: originId,
          toWarehouseId: opts.dest ?? destId,
          fromStatus: 'loading',
          toStatus: 'in_transit',
          cause: 'batch_departed',
          refType: 'batch',
          refId: truck!.id,
          actorId,
        })),
      );
    }
  }
  return { id: truck!.id, code, boxCodes, receiptId };
}

function unloadScan(batchId: string, code: string) {
  return {
    clientEventUuid: uuidv4(),
    batchId,
    code,
    method: 'qr' as const,
    scannedAt: new Date().toISOString(),
  };
}

/** Somebody else's transaction, held open on its own connection. */
async function withHolder(run: (held: postgres.ReservedSql) => Promise<void>) {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await run(held);
  } finally {
    held.release();
    await helper.end();
  }
}

/**
 * Is anybody WAITING on a lock right now? Asked through the POOL — a snapshot
 * of pg_stat_activity freezes inside an open transaction (#873).
 */
async function someoneWaits(): Promise<boolean> {
  for (let i = 0; i < 250; i += 1) {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  async function ensureWarehouse(code: string, country: string, type: string, timezone: string) {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `Rename ${code}`, country, type, timezone, batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O, 'CN', 'origin', 'Asia/Shanghai');
  destId = await ensureWarehouse(WH_D, 'UZ', 'customs', 'Asia/Tashkent');
  thirdId = await ensureWarehouse(WH_X, 'UZ', 'distribution', 'Asia/Tashkent');
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  clientCode = `RN${STAMP}`;
  const [c] = await db.insert(clients).values({ clientCode, name: `Rename ${STAMP}` }).returning();
  clientId = c!.id;
  clientIds.push(clientId);
});

afterAll(async () => {
  try {
    if (trucks.length) await db.delete(scanEvents).where(inArray(scanEvents.batchId, trucks));
    if (boxIds.length) {
      await db.delete(scanEvents).where(inArray(scanEvents.boxId, boxIds));
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    if (receiptIds.length) {
      await db.delete(receiptLots).where(inArray(receiptLots.receiptId, receiptIds));
      await db.delete(receipts).where(inArray(receipts.id, receiptIds));
    }
    if (trucks.length) await db.delete(batches).where(inArray(batches.id, trucks));
    if (clientIds.length) {
      await db.execute(sql`DELETE FROM client_notices WHERE client_id IN ${sql.raw(`(${clientIds.map((id) => `'${id}'`).join(',')})`)}`);
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
    for (const key of counterKeys) {
      await db.execute(sql`DELETE FROM counters WHERE kind = 'batch_seq' AND scope_key = ${key}`);
    }
  } finally {
    await pgClient.end();
  }
});

describe('on the road: a reason, and a name the bot recognises', () => {
  it('(a) a departed truck plus a reason → renamed, one audit row that says why', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    const to = `KA-${tag()}`;
    const res = await rename(t.id, to, { code: t.code, stage: 'road' }, '  agent   hujjatida boshqa raqam ');
    expect(res).toMatchObject({ changed: true, from: t.code, stage: 'road' });
    expect(await codeOf(t.id)).toBe(to);
    const rows = await renameRows(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ code: t.code });
    expect(rows[0]!.after).toEqual({ code: to, reason: 'agent hujjatida boshqa raqam' });
  });

  it('(b) an empty or two-character reason is refused and nothing is written', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    for (const reason of [undefined, '', '  ', 'ab']) {
      expect(await outcome(rename(t.id, `KA-${tag()}`, { code: t.code, stage: 'road' }, reason))).toBe(
        'reason_required',
      );
    }
    expect(await codeOf(t.id)).toBe(t.code);
    expect(await renameRows(t.id)).toHaveLength(0);
  });

  it('(c) the road charset names its cause; a plate is fine', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    const seen = { code: t.code, stage: 'road' as const };
    const why = 'hujjat';
    expect(await outcome(rename(t.id, 'КА-77', seen, why))).toBe('code_cyrillic');
    expect(await outcome(rename(t.id, 'KA 77', seen, why))).toBe('code_chars');
    expect(await outcome(rename(t.id, 'KASHGAR', seen, why))).toBe('code_needs_digit');
    expect(await outcome(rename(t.id, `K${'7'.repeat(20)}`, seen, why))).toBe('code_length');
    const plate = `01A${tag()}BA`;
    expect(await outcome(rename(t.id, plate, seen, why))).toBe('ok');
    expect(await codeOf(t.id)).toBe(plate);
  });
});

describe('(c2) what a name would be mistaken for — refused at BOTH stages', () => {
  it('lot, client, box and crate shapes on a forming truck and a departed one', async () => {
    const forming = await mintTruck({ status: 'forming', cartons: 1 });
    const road = await mintTruck({ status: 'in_transit', cartons: 1 });
    const realBox = road.boxCodes[0]!;
    const cases: [string, string][] = [
      ['GS777-A', 'code_shape/lot'],
      ['YW105', 'code_shape/client'],
      [realBox, 'code_shape/box'],
      ['CR-X1', 'code_shape/crate'],
    ];
    for (const [name, expected] of cases) {
      expect(await outcome(rename(forming.id, name, { code: forming.code, stage: 'loading' })), `loading ${name}`).toBe(
        expected,
      );
      expect(await outcome(rename(road.id, name, { code: road.code, stage: 'road' }, 'hujjat')), `road ${name}`).toBe(
        expected,
      );
    }
    // The pre-departure door keeps its free rule, spaces and all.
    const free = `GSR KASHGAR ${tag()}`;
    expect(await outcome(rename(forming.id, free, { code: forming.code, stage: 'loading' }))).toBe('ok');
  });

  it('(g) a name another thing already answers to in the bot is refused', async () => {
    const shadowed = `A1B${tag()}C`;
    const [c] = await db.insert(clients).values({ clientCode: shadowed, name: 'Soya' }).returning();
    clientIds.push(c!.id);
    const forming = await mintTruck({ status: 'forming', cartons: 0 });
    const road = await mintTruck({ status: 'in_transit', cartons: 1 });
    expect(await outcome(rename(forming.id, shadowed, { code: forming.code, stage: 'loading' }))).toBe(
      'code_shadows/client',
    );
    expect(await outcome(rename(road.id, shadowed, { code: road.code, stage: 'road' }, 'hujjat'))).toBe(
      'code_shadows/client',
    );
  });
});

describe('(d) when renaming stops', () => {
  it('open while a carton is aboard, closed once the last one is scanned off — button or no button', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 2 });
    await ingestUnloadScans([unloadScan(t.id, t.boxCodes[0]!)], ctx());
    const arrived = await db.query.batches.findFirst({ where: eq(batches.id, t.id) });
    expect(arrived!.status).toBe('arrived');
    const mid = `KA-${tag()}`;
    expect(await outcome(rename(t.id, mid, { code: t.code, stage: 'road' }, 'hujjat'))).toBe('ok');
    // (d3) the last carton scanned off, nobody presses «Tushirish tugadi».
    await ingestUnloadScans([unloadScan(t.id, t.boxCodes[1]!)], ctx());
    expect((await db.query.batches.findFirst({ where: eq(batches.id, t.id) }))!.status).toBe('arrived');
    expect(await outcome(rename(t.id, `KA-${tag()}`, { code: mid, stage: 'road' }, 'hujjat'))).toBe('rename_closed');
    expect(await codeOf(t.id)).toBe(mid);
  });

  it('closed after «Tushirish tugadi», even with a carton still counted aboard', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 2 });
    await ingestUnloadScans([unloadScan(t.id, t.boxCodes[0]!)], ctx());
    await finishUnload(t.id, ctx(), { mayCloseWithMissing: true });
    expect(await outcome(rename(t.id, `KA-${tag()}`, { code: t.code, stage: 'road' }, 'hujjat'))).toBe(
      'rename_closed',
    );
  });

  it('closed on a cancelled forming truck', async () => {
    const t = await mintTruck({ status: 'forming', cartons: 0 });
    await cancelBatch(t.id, 'test tozalash', ctx());
    expect(await outcome(rename(t.id, `KA-${tag()}`, { code: t.code, stage: 'loading' }))).toBe('rename_closed');
  });

  it('(d4) closed on a truck the annul retired (every member void)', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    const res = await annulReceipt(t.receiptId, 'test tozalash', { id: actorId, roles: ['super_admin'] }, ctx());
    expect(res.batchesRetired).toEqual([t.code]);
    expect(await outcome(rename(t.id, `KA-${tag()}`, { code: t.code, stage: 'road' }, 'hujjat'))).toBe(
      'rename_closed',
    );
  });
});

describe('a name a truck ever wore is never another truck’s', () => {
  it('(e) B may not take A’s former name; A may take its own back', async () => {
    const a = await mintTruck({ status: 'forming', cartons: 0, code: `EWX-${tag()}` });
    const b = await mintTruck({ status: 'forming', cartons: 0 });
    const y = `EWY-${tag()}`;
    expect(await outcome(rename(a.id, y, { code: a.code, stage: 'loading' }))).toBe('ok');
    expect(await outcome(rename(b.id, a.code, { code: b.code, stage: 'loading' }))).toBe('code_taken');
    expect(await outcome(rename(a.id, a.code, { code: y, stage: 'loading' }))).toBe('ok');
    expect(await codeOf(a.id)).toBe(a.code);
  });

  it('(e2) a free pre-departure name may come back on the road — its SHAPE is still judged', async () => {
    const t = await mintTruck({ status: 'forming', cartons: 1 });
    const free = `GSR KASHGAR ${tag()}`;
    expect(await outcome(rename(t.id, free, { code: t.code, stage: 'loading' }))).toBe('ok');
    // It departs.
    await db.update(batches).set({ status: 'in_transit', departedAt: new Date() }).where(eq(batches.id, t.id));
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentWarehouseId: null })
      .where(eq(boxes.currentBatchId, t.id));
    const road = `KA-${tag()}`;
    expect(await outcome(rename(t.id, road, { code: free, stage: 'road' }, 'hujjat'))).toBe('ok');
    expect(await outcome(rename(t.id, free, { code: road, stage: 'road' }, 'eski nom qaytdi'))).toBe('ok');
    expect(await codeOf(t.id)).toBe(free);

    // Pre-rule history: a former name the shape rule would refuse today.
    const old = `ZQ${tag()}`;
    await db.insert(auditLog).values({
      entityType: 'batch',
      entityId: t.id,
      action: 'update',
      before: { code: old },
      after: { code: `${old}-X` },
    });
    expect(await outcome(rename(t.id, old, { code: free, stage: 'road' }, 'hujjat'))).toBe('code_shape/client');
  });

  it('(h) the same name again is nothing — no audit row', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    const before = (await renameRows(t.id)).length;
    const res = await rename(t.id, t.code.toLowerCase(), { code: t.code, stage: 'road' }, 'hujjat');
    expect(res.changed).toBe(false);
    expect((await renameRows(t.id)).length).toBe(before);
  });

  it('(f) the counter walks past a name a truck used to wear', async () => {
    const prefix = `RP${tag()}`;
    counterKeys.push(prefix);
    const t = await mintTruck({ status: 'forming', cartons: 0, code: `${prefix}-001` });
    expect(await outcome(rename(t.id, `RPX-${tag()}`, { code: t.code, stage: 'loading' }))).toBe('ok');
    expect(await nextBatchCode(db, { code: WH_O, batchPrefix: prefix })).toBe(`${prefix}-002`);
  });

  it('(f2) the counter WAITS for an in-flight rename to the number it reaches', async () => {
    const prefix = `RQ${tag()}`;
    counterKeys.push(prefix);
    const first = `${prefix}-001`;
    const t = await mintTruck({ status: 'forming', cartons: 0 });
    let minted: string | Error = '';
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext('batch-code'), hashtext(upper(${first}::text)))`;
      await held`UPDATE batches SET code = ${first} WHERE id = ${t.id}`;
      const ours = db
        .transaction((tx) => nextBatchCode(tx, { code: WH_O, batchPrefix: prefix }))
        .then((code) => (minted = code), (err: Error) => (minted = err));
      expect(await someoneWaits(), 'the counter never had to wait for the rename').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(minted).toBe(`${prefix}-002`);
  });
});

describe('(i) the door — the service asks it again', () => {
  it('no plans.manage, neither end, a stale-stage dest, and a door minted for somebody else', async () => {
    const road = await mintTruck({ status: 'in_transit', cartons: 1 });
    const forming = await mintTruck({ status: 'forming', cartons: 0 });
    const closed = await mintTruck({ status: 'in_transit', cartons: 0 });
    const seenRoad = { code: road.code, stage: 'road' as const };
    const noGrant: RenameDoorActor = { ...planner(), permissions: new Set(['batches.depart_close']) };
    expect(await outcome(rename(road.id, `KA-${tag()}`, seenRoad, 'hujjat', noGrant))).toBe('forbidden');

    const elsewhere: RenameDoorActor = { ...planner(), warehouseScoped: true, warehouseIds: [thirdId] };
    expect(await outcome(rename(road.id, `KA-${tag()}`, seenRoad, 'hujjat', elsewhere))).toBe('forbidden');
    // Never «rename_closed» to a stranger: the refusal says nothing about the truck.
    expect(
      await outcome(rename(closed.id, `KA-${tag()}`, { code: closed.code, stage: 'road' }, 'hujjat', elsewhere)),
    ).toBe('forbidden');

    const atDest: RenameDoorActor = { ...planner(), warehouseScoped: true, warehouseIds: [destId] };
    expect(await outcome(rename(forming.id, `KA-${tag()}`, { code: forming.code, stage: 'loading' }, undefined, atDest))).toBe(
      'forbidden',
    );
    expect(await outcome(rename(road.id, `KA-${tag()}`, seenRoad, 'hujjat', atDest))).toBe('ok');

    const road2 = await mintTruck({ status: 'in_transit', cartons: 1 });
    const someoneElse: RenameDoorActor = { ...planner(), id: uuidv4() };
    expect(
      await outcome(rename(road2.id, `KA-${tag()}`, { code: road2.code, stage: 'road' }, 'hujjat', someoneElse)),
    ).toBe('forbidden');
  });
});

describe('races — each made deterministic by a held transaction', () => {
  it('(j) a same-name writer that bypassed the lock is a sentence, never a 23505', async () => {
    const a = await mintTruck({ status: 'forming', cartons: 0 });
    const b = await mintTruck({ status: 'forming', cartons: 0 });
    const w = `RJW-${tag()}`;
    let result: unknown;
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`UPDATE batches SET code = ${w} WHERE id = ${b.id}`;
      const ours = rename(a.id, w, { code: a.code, stage: 'loading' }).then(
        () => (result = 'ok'),
        (err: unknown) => (result = err),
      );
      expect(await someoneWaits(), 'the rename never met the uncommitted name').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(result).toBeInstanceOf(RenameError);
    expect((result as RenameError).code).toBe('code_taken');
  });

  it('(k) «Tushirish tugadi» pressed while the rename waits → rename_closed', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    let result = '';
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT id FROM batches WHERE id = ${t.id} FOR NO KEY UPDATE`;
      await held`UPDATE batches SET status = 'unloaded' WHERE id = ${t.id}`;
      const ours = outcome(rename(t.id, `KA-${tag()}`, { code: t.code, stage: 'road' }, 'hujjat')).then(
        (r) => (result = r),
      );
      expect(await someoneWaits(), 'the rename never waited for the truck row').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(result).toBe('rename_closed');
    expect(await codeOf(t.id)).toBe(t.code);
  });

  it('(o) a colleague renamed it first: the form that saw the old name is refused', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    const theirs = `KAY-${tag()}`;
    let result = '';
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT id FROM batches WHERE id = ${t.id} FOR UPDATE`;
      await held`UPDATE batches SET code = ${theirs} WHERE id = ${t.id}`;
      const ours = outcome(rename(t.id, `KAZ-${tag()}`, { code: t.code, stage: 'road' }, 'hujjat')).then(
        (r) => (result = r),
      );
      expect(await someoneWaits(), 'the rename never waited for the colleague').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(result).toBe('batch_changed');
    expect(await codeOf(t.id)).toBe(theirs);
  });

  it('(o2) a loading form on a truck that has since departed is refused as CHANGED, not by the road charset', async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1 });
    expect(await outcome(rename(t.id, `GSR KASHGAR ${tag()}`, { code: t.code, stage: 'loading' }))).toBe(
      'batch_changed',
    );
  });

  it('(p) a rename to a name another truck is wearing-and-leaving in an open transaction waits, then is refused', async () => {
    const a = await mintTruck({ status: 'forming', cartons: 0 });
    const b = await mintTruck({ status: 'forming', cartons: 0 });
    const x = `RPX-${tag()}`;
    const w = `RPW-${tag()}`;
    let result = '';
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext('batch-code'), hashtext(upper(${x}::text)))`;
      await held`UPDATE batches SET code = ${x} WHERE id = ${b.id}`;
      await held`INSERT INTO audit_log (entity_type, entity_id, action, before, after)
                 VALUES ('batch', ${b.id}, 'update', jsonb_build_object('code', ${b.code}::text), jsonb_build_object('code', ${x}::text))`;
      await held`UPDATE batches SET code = ${w} WHERE id = ${b.id}`;
      await held`INSERT INTO audit_log (entity_type, entity_id, action, before, after)
                 VALUES ('batch', ${b.id}, 'update', jsonb_build_object('code', ${x}::text), jsonb_build_object('code', ${w}::text))`;
      const ours = outcome(rename(a.id, x, { code: a.code, stage: 'loading' })).then((r) => (result = r));
      expect(await someoneWaits(), 'the rename never waited for the name lock').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(result).toBe('code_taken');
    expect(await codeOf(a.id)).toBe(a.code);
  });
});

describe('the old name stays findable', () => {
  let truckId = '';
  let oldCode = '';
  let newCode = '';

  beforeAll(async () => {
    const t = await mintTruck({ status: 'in_transit', cartons: 1, code: `RNS-${tag()}` });
    truckId = t.id;
    oldCode = t.code;
    newCode = `RNN-${tag()}`;
    await rename(t.id, newCode, { code: t.code, stage: 'road' }, 'agent raqami');
  });

  const logist = (): SearchActor => ({
    id: actorId,
    permissions: new Set(['plans.manage']),
    warehouseScoped: false,
    warehouseIds: [],
  });

  it('(l) ⌘K finds the truck by its old name, labelled; by its own name with no «formerCode» key at all', async () => {
    const byOld = (await globalSearch(logist(), oldCode)).filter((hit) => hit.kind === 'batch');
    expect(byOld).toHaveLength(1);
    expect(byOld[0]).toMatchObject({ id: truckId, code: newCode, formerCode: oldCode });
    const byNew = (await globalSearch(logist(), newCode)).filter((hit) => hit.kind === 'batch');
    expect(byNew).toHaveLength(1);
    expect('formerCode' in byNew[0]!).toBe(false);
  });

  it('(l2) a warehouse reader at neither end finds it by NEITHER name', async () => {
    const stranger: SearchActor = {
      id: actorId,
      permissions: new Set(['scan.unload']),
      warehouseScoped: true,
      warehouseIds: [thirdId],
    };
    for (const text of [oldCode, newCode]) {
      expect((await globalSearch(stranger, text)).filter((hit) => hit.kind === 'batch'), text).toHaveLength(0);
    }
  });

  it('(l3) the /batches archive’s joined select finds it by the old name, with the name', async () => {
    const dest = aliasedTable(warehouses, 'dest');
    const scoped = { warehouseScoped: true, warehouseIds: [originId] };
    const like = likeNeedle(oldCode);
    const rows = await db
      .select({ id: batches.id, code: batches.code, originCode: warehouses.code, formerCode: formerCodeHitSql(like) })
      .from(batches)
      .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
      .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
      .where(and(warehouseScopeEither(scoped, batches.originWarehouseId, batches.destWarehouseId), batchTextMatchSql(like)));
    expect(rows).toEqual([{ id: truckId, code: newCode, originCode: WH_O, formerCode: oldCode }]);
  });

  it('(m) the staff bot answers an old name LAST, and never hands a stranger the new one', async () => {
    const boss: BotActor = { id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] };
    const byOld = await botLookupAnswer(boss, oldCode);
    expect(byOld?.text).toContain(`Hozirgi nomi: ${newCode}`);
    const byNew = await botLookupAnswer(boss, newCode);
    expect(byNew?.text).toContain(`Oldingi nomi: ${oldCode}`);

    const stranger: BotActor = { id: actorId, permissions: new Set(['scan.unload']), warehouseScoped: true, warehouseIds: [thirdId] };
    const hidden = await botLookupAnswer(stranger, oldCode);
    expect(hidden?.text).toContain('omboringizda emas');
    expect(hidden?.text).not.toContain(newCode);
  });

  it('(m) a client later minted with a truck’s OLD name is the one the bot answers', async () => {
    const t = await mintTruck({ status: 'forming', cartons: 0 });
    const old = `B2C${tag()}D`;
    expect(await outcome(rename(t.id, old, { code: t.code, stage: 'loading' }))).toBe('ok');
    expect(await outcome(rename(t.id, `KA-${tag()}`, { code: old, stage: 'loading' }))).toBe('ok');
    const [c] = await db.insert(clients).values({ clientCode: old, name: `Mijoz ${old}` }).returning();
    clientIds.push(c!.id);
    const boss: BotActor = { id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] };
    const answer = await botLookupAnswer(boss, old);
    expect(answer?.text).toContain(old);
    expect(answer?.text).not.toContain('oldingi nomi');
  });
});

describe('(n) the reads are the indexes’, even as a generic plan', () => {
  it('EXPLAIN names both 0121 indexes, custom and generic', async () => {
    const dialect = new PgDialect();
    const name = `rn_plan_${STAMP}`;
    const plan = (rows: unknown) =>
      (rows as Record<string, string>[]).map((r) => r['QUERY PLAN']).join('\n');
    const literal = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;
    const plans: string[] = [];
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const worn = codeEverWornSql('ZZ-NOPE-1', null);
        const text: SQL = sql`SELECT "batches"."id" FROM batches WHERE ${batchTextMatchSql('%ZZ-NOPE%')}`;
        plans.push(plan(await tx.execute(sql`EXPLAIN ${worn}`)));
        plans.push(plan(await tx.execute(sql`EXPLAIN ${text}`)));
        await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
        for (const [i, q] of [worn, text].entries()) {
          const { sql: stmt, params } = dialect.sqlToQuery(q);
          await tx.execute(sql.raw(`PREPARE ${name}_${i} AS ${stmt}`));
          plans.push(plan(await tx.execute(sql.raw(`EXPLAIN EXECUTE ${name}_${i}(${params.map(literal).join(', ')})`))));
          await tx.execute(sql.raw(`DEALLOCATE ${name}_${i}`));
        }
        throw new Error('rollback');
      })
      .catch((err: Error) => {
        if (err.message !== 'rollback') throw err;
      });
    const [wornCustom, textCustom, wornGeneric, textGeneric] = plans;
    for (const p of [wornCustom, wornGeneric]) {
      expect(p).toContain('audit_batch_former_code_idx');
      expect(p).toContain('batches_code_upper_idx');
    }
    for (const p of [textCustom, textGeneric]) expect(p).toContain('audit_batch_former_code_idx');
  });
});
