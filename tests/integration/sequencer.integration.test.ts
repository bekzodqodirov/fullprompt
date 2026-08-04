import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { assignLetters } from '@/modules/wms/sequencer';
import { bumpCounter, nextBoxCodes, nextReceiptNumber } from '@/modules/wms/codes';

/**
 * DB-backed tests (need DATABASE_URL). Cover spec §20 test 4 (concurrent
 * confirms get disjoint letters) and counter range reservation.
 */

const TEST_WH_CODE = 'ITEST';
let warehouseId: string;

beforeAll(async () => {
  await db.delete(warehouses).where(eq(warehouses.code, TEST_WH_CODE));
  const [wh] = await db
    .insert(warehouses)
    .values({
      code: TEST_WH_CODE,
      name: 'Integration test WH',
      country: 'CN',
      type: 'origin',
      timezone: 'Asia/Shanghai',
      batchPrefix: TEST_WH_CODE,
    })
    .returning();
  warehouseId = wh!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('assignLetters (transactional)', () => {
  it('assigns sequential letters and persists state', async () => {
    const first = await db.transaction((tx) => assignLetters(tx, warehouseId, 3));
    expect(first.map((l) => l.letter)).toEqual(['A', 'B', 'C']);

    const second = await db.transaction((tx) => assignLetters(tx, warehouseId, 2));
    expect(second.map((l) => l.letter)).toEqual(['D', 'E']);
  });

  it('acceptance test 4: concurrent confirms get disjoint letters', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.transaction((tx) => assignLetters(tx, warehouseId, 2)),
      ),
    );
    const letters = results.flat().map((l) => `${l.letter}#${l.cycleNo}`);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe('counters', () => {
  it('parallel bumps reserve disjoint ranges', async () => {
    const key = `test:${Date.now()}`;
    const ends = await Promise.all(
      Array.from({ length: 5 }, () => bumpCounter(db, 'itest', key, 10)),
    );
    expect(new Set(ends).size).toBe(5);
    expect(Math.max(...ends)).toBe(50);
  });

  it('receipt numbers follow {WH}-IN-{YYMMDD}-{seq}', async () => {
    const wh = { code: TEST_WH_CODE, timezone: 'Asia/Shanghai' };
    const n1 = await nextReceiptNumber(db, wh);
    const n2 = await nextReceiptNumber(db, wh);
    expect(n1).toMatch(new RegExp(`^${TEST_WH_CODE}-IN-\\d{6}-\\d{3}$`));
    const seq1 = Number(n1.split('-').at(-1));
    const seq2 = Number(n2.split('-').at(-1));
    expect(seq2).toBe(seq1 + 1);
  });

  it('box codes are contiguous, zero-padded, per-year', async () => {
    const wh = { code: TEST_WH_CODE, timezone: 'Asia/Shanghai' };
    const codes = await nextBoxCodes(db, wh, 3);
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).toMatch(new RegExp(`^${TEST_WH_CODE}\\d{2}-\\d{6}$`));
    }
    const nums = codes.map((c) => Number(c.split('-')[1]));
    expect(nums[1]).toBe(nums[0]! + 1);
    expect(nums[2]).toBe(nums[0]! + 2);
  });
});
