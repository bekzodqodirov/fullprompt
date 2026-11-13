import 'dotenv/config';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A trip's pair code is drawn again when the code is taken (CI's own
 * database found it: «driver_devices_pair_code_key» rolled a whole plan
 * approval back, because an unpaired trip keeps its code for ever). The draw
 * is made deterministic here: the next six `randomInt` answers spell a code
 * another device already holds, and only then does the real one answer.
 */
const draws = vi.hoisted(() => ({ queue: [] as number[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    randomInt: ((...args: Parameters<typeof real.randomInt>) =>
      draws.queue.length > 0 ? draws.queue.shift()! : (real.randomInt as (...a: unknown[]) => number)(...args)) as typeof real.randomInt,
  };
});

import { db, pgClient } from '@/modules/platform/db/client';
import { batches, driverDevices, users, warehouses } from '@/modules/platform/db/schema';
import { createDriverDevice, mintBatchPairCode } from '@/modules/wms/tracking/devices';

/** The alphabet devices.ts draws from — 0/O and 1/I left out. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The six draws that spell `code`. */
const spell = (code: string) => [...code].map((ch) => ALPHABET.indexOf(ch));

let originId: string;
let destId: string;
let actorId: string;

async function ensureWarehouse(code: string) {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
  if (existing) return existing.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code, name: `Pair ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return wh!.id;
}

async function newBatch() {
  const [row] = await db
    .insert(batches)
    .values({
      code: `PCD-${String(Date.now()).slice(-6)}-${Math.floor(Math.random() * 1000)}`,
      originWarehouseId: originId,
      destWarehouseId: destId,
      type: 'transfer',
      status: 'loading',
      createdBy: actorId,
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  originId = await ensureWarehouse('PCDO');
  destId = await ensureWarehouse('PCDD');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
});

afterAll(async () => {
  // A closed trip is nobody the silent-truck sweep waits for (#154).
  await db.update(batches).set({ status: 'closed' }).where(like(batches.code, 'PCD-%'));
  await pgClient.end();
});

describe('a taken pair code is drawn again', () => {
  it('the «new code» button: the first draw meets a held code, the second is the device’s', async () => {
    const held = await createDriverDevice({ batchId: await newBatch() }, { actorId });
    expect(held.pairCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/u);
    draws.queue.push(...spell(held.pairCode!));
    const next = await createDriverDevice({ batchId: await newBatch() }, { actorId });
    expect(draws.queue).toEqual([]);
    expect(next.pairCode).not.toBe(held.pairCode);
    expect(next.pairCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/u);
  });

  it('inside the batch’s own transaction the collision aborts nothing: the trip and its code are both written', async () => {
    const held = await createDriverDevice({ batchId: await newBatch() }, { actorId });
    const batchId = await newBatch();
    draws.queue.push(...spell(held.pairCode!));
    const minted = await db.transaction(async (tx) => {
      const row = await mintBatchPairCode(tx, batchId, actorId);
      // A statement after the collided INSERT still runs: the transaction was not aborted.
      await tx.update(batches).set({ driverName: 'Haydovchi' }).where(eq(batches.id, batchId));
      return row;
    });
    expect(minted.pairCode).not.toBe(held.pairCode);
    const [stored] = await db.select().from(driverDevices).where(eq(driverDevices.batchId, batchId));
    expect(stored!.pairCode).toBe(minted.pairCode);
    const [trip] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(trip!.driverName).toBe('Haydovchi');
  });
});
