import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { batches, users, warehouses } from '@/modules/platform/db/schema';
import { nextBatchCode } from '@/modules/wms/codes';

/**
 * Round 100, the owner's item 7 — «tezkor yuklashni belgilab qoyilgan lekin
 * hatolik berdi», digest #2832070603 in his own log: the batch-code COUNTER
 * stood behind the codes already in the table, the insert hit the unique
 * index, the rollback took the counter bump with it, and every retry minted
 * the same taken code for ever. The generator now walks past taken codes,
 * which also HEALS the counter: the walk consumes the collision block once.
 */

const PREFIX = `Q7${String(Date.now()).slice(-4)}`;
let whId = '';
let destId = '';
let actorId = '';

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  // Two warehouses because batches_route_check refuses origin = dest.
  const minted = await db
    .insert(warehouses)
    .values([
      {
        code: PREFIX,
        name: `Q7 ${PREFIX}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: PREFIX,
      },
      {
        code: `${PREFIX}D`,
        name: `Q7 ${PREFIX} dest`,
        country: 'UZ',
        type: 'distribution',
        timezone: 'Asia/Tashkent',
        batchPrefix: `${PREFIX}D`,
      },
    ])
    .returning();
  whId = minted.find((w) => w.code === PREFIX)!.id;
  destId = minted.find((w) => w.code === `${PREFIX}D`)!.id;
  // The production shape, minted by hand: a batch already HOLDS the code the
  // fresh counter will produce first.
  await db.insert(batches).values({
    code: `${PREFIX}-001`,
    originWarehouseId: whId,
    destWarehouseId: destId,
    status: 'cancelled',
    createdBy: actorId,
  });
});

afterAll(async () => {
  await db.delete(batches).where(like(batches.code, `${PREFIX}-%`));
  await db.execute(sql`DELETE FROM counters WHERE kind = 'batch_seq' AND scope_key = ${PREFIX}`);
  await db.delete(warehouses).where(eq(warehouses.id, whId));
  await db.delete(warehouses).where(eq(warehouses.id, destId));
  await pgClient.end();
});

describe('a batch code walks past codes the counter never knew about', () => {
  it('skips the taken code instead of minting it for ever', async () => {
    const wh = (await db.query.warehouses.findFirst({ where: eq(warehouses.id, whId) }))!;
    // -001 is taken by the fixture, so the first honest answer is -002 —
    // the stuck-counter version returns -001 and the insert dies on the
    // unique index exactly as production's did.
    expect(await nextBatchCode(db, wh)).toBe(`${PREFIX}-002`);
    // …and the counter is HEALED: the next mint is a plain increment.
    expect(await nextBatchCode(db, wh)).toBe(`${PREFIX}-003`);
  });
});
