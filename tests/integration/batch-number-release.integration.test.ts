import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, batches, clients, clientTransactions, users, warehouses } from '@/modules/platform/db/schema';
import { writeAudit } from '@/modules/platform/audit/service';
import { bumpCounter, nextBatchCode, readCounter } from '@/modules/wms/codes';
import { batchNumberReport, batchNumberState } from '@/modules/wms/batches/batch-number';
import {
  batchByFormerCode,
  codeEverWorn,
  formerCodesFor,
} from '@/modules/wms/batches/former-codes';
import { releaseTrailingCodes, renameBatch } from '@/modules/wms/batches/rename';
import { renameDoorFor } from '@/modules/wms/batches/rename-door';
import { botLookupAnswer, type BotActor } from '@/modules/wms/bot/lookup';
import { cancelBatch } from '@/modules/wms/scanning/unload';

/**
 * «Bekor qilingan partiya raqami qaytadi» — his 4a / 5a / 7a
 * (docs/NARX-VA-RAQAM.md §2.6 + §3.2), against real rows and the cancel's own
 * service (the door a test can press, #531).
 *
 * Every test gives the file's origin warehouse a FRESH prefix (a prefix is
 * the counter's key, so each test owns its own sequence and nothing another
 * file minted can stand at its top). The two warehouses are fixed codes
 * reused across runs and RETIRED at the end (audit_log FK — an audited
 * warehouse is never deleted); the trucks, the money row and the counters are
 * deleted; the audit rows stay (audit_log refuses DELETE) and every reader
 * JOINs to `batches`, so an orphan is invisible.
 */

const WH_O = 'NRLO';
const WH_D = 'NRLD';
const STAMP = String(Date.now()).slice(-6);
let seq = 0;
/** A per-run tail: the counter at the FRONT, so a slice can never cut it (#598). */
const tag = () => `${String(seq++).padStart(2, '0')}${STAMP}`;

let originId = '';
let destId = '';
let actorId = '';
let clientId = '';
const ctx = () => ({ actorId });
const trucks: string[] = [];
const prefixes: string[] = [];
const moneyRows: string[] = [];

/** A fresh sequence for one test: the origin's prefix, as /admin/warehouses would set it. */
async function freshPrefix(): Promise<string> {
  const prefix = `NR${tag()}`;
  prefixes.push(prefix);
  await db.update(warehouses).set({ batchPrefix: prefix }).where(eq(warehouses.id, originId));
  return prefix;
}

/** A quick batch exactly as the action mints one — the counter walk, the insert, the create audit row. */
async function mint(prefix: string): Promise<{ id: string; code: string }> {
  return db.transaction(async (tx) => {
    const code = await nextBatchCode(tx, { code: WH_O, batchPrefix: prefix });
    const [row] = await tx
      .insert(batches)
      .values({ code, originWarehouseId: originId, destWarehouseId: destId, status: 'forming', createdBy: actorId })
      .returning();
    trucks.push(row!.id);
    await writeAudit(tx, { actorId, warehouseId: originId }, {
      entityType: 'batch',
      entityId: row!.id,
      action: 'create',
      after: { code, quick: true },
    });
    return { id: row!.id, code };
  });
}

const codeOf = async (id: string) => (await db.query.batches.findFirst({ where: eq(batches.id, id) }))!.code;
const counterOf = (prefix: string) => readCounter(db, 'batch_seq', prefix);
const releaseRows = async (id: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'batch'), eq(auditLog.entityId, id), sql`${auditLog.after}->>'released' = 'true'`));

const planner = () =>
  renameDoorFor({ id: actorId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] });
const boss: BotActor = { id: '', permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] };

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

/** Is anybody WAITING on a lock right now? Through the POOL — a snapshot freezes inside an open tx (#873). */
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
  async function ensureWarehouse(code: string, country: string, type: string) {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) {
      if (!existing.active) await db.update(warehouses).set({ active: true }).where(eq(warehouses.id, existing.id));
      return existing.id;
    }
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `Raqam ${code}`, country, type, timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O, 'CN', 'origin');
  destId = await ensureWarehouse(WH_D, 'UZ', 'customs');
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  boss.id = actorId;
  const [c] = await db.insert(clients).values({ clientCode: `NRL${STAMP}`, name: `Raqam ${STAMP}` }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  try {
    if (moneyRows.length) await db.delete(clientTransactions).where(inArray(clientTransactions.id, moneyRows));
    if (trucks.length) await db.delete(batches).where(inArray(batches.id, trucks));
    for (const prefix of prefixes) {
      await db.execute(sql`DELETE FROM counters WHERE kind = 'batch_seq' AND scope_key = ${prefix}`);
    }
    if (clientId) await db.delete(clients).where(eq(clients.id, clientId));
    await db.update(warehouses).set({ active: false, batchPrefix: WH_O }).where(eq(warehouses.code, WH_O));
    await db.update(warehouses).set({ active: false }).where(eq(warehouses.code, WH_D));
  } finally {
    await pgClient.end();
  }
});

describe('the top number comes back (his 4a)', () => {
  it('cancel the top → renamed «… (bekor)», the counter rewound, the next mint takes it', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    const b = await mint(prefix);
    expect(b.code).toBe(`${prefix}-002`);

    const res = await cancelBatch(b.id, 'xato yo‘nalish', ctx());
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-002`] });
    // The answer's row is the truck as it stands now, under its bekor name.
    expect(res.batch.code).toBe(`${prefix}-002 (bekor)`);
    expect(res.batch.status).toBe('cancelled');
    expect(await codeOf(b.id)).toBe(`${prefix}-002 (bekor)`);
    expect(await counterOf(prefix)).toBe(1);
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', number: `${prefix}-002` });

    const again = await mint(prefix);
    expect(again.code).toBe(`${prefix}-002`);
    expect(await codeOf(a.id)).toBe(`${prefix}-001`);
  });

  it('the release audit row is NOT a former name — the number is free, nothing calls it «oldingi nomi»', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    await cancelBatch(b.id, 'xato', ctx());
    const rows = await releaseRows(b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ code: `${prefix}-002` });
    expect(rows[0]!.after).toEqual({ code: `${prefix}-002 (bekor)`, released: true });
    expect(rows[0]!.warehouseId).toBe(originId);
    expect(await codeEverWorn(db, `${prefix}-002`, null)).toBe(false);
    expect(await formerCodesFor(b.id)).toEqual([]);
    expect(await batchByFormerCode(`${prefix}-002`)).toBeNull();
  });

  it('the same number cancelled twice is «(bekor 2)» — a name ever worn is never reused', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const first = await mint(prefix);
    await cancelBatch(first.id, 'xato', ctx());
    const second = await mint(prefix);
    expect(second.code).toBe(`${prefix}-002`);
    const res = await cancelBatch(second.id, 'yana xato', ctx());
    expect(res.number.kind).toBe('returned');
    expect(await codeOf(first.id)).toBe(`${prefix}-002 (bekor)`);
    expect(await codeOf(second.id)).toBe(`${prefix}-002 (bekor 2)`);
    expect(await counterOf(prefix)).toBe(1);
  });

  it('the bot sends «P-002» to the cancelled truck while nobody wears the number', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    await cancelBatch(b.id, 'xato', ctx());
    const answer = (await botLookupAnswer(boss, `${prefix}-002`))?.text ?? '';
    expect(answer).toContain('raqami qaytarildi');
    expect(answer).toContain(`${prefix}-002 (bekor)`);
    // Once the number is minted again, the exact lookup answers the live truck.
    const c = await mint(prefix);
    const live = (await botLookupAnswer(boss, `${prefix}-002`))?.text ?? '';
    expect(c.code).toBe(`${prefix}-002`);
    expect(live).not.toContain('raqami qaytarildi');
    expect(live).toContain('shakllanmoqda');
  });
});

describe('a gap below the top stays (his 5a)', () => {
  it('cancel below the top → kept «newer», naming the truck that blocks; nothing written', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    const b = await mint(prefix);
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'kept', why: 'newer', newer: b.code, number: a.code });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await counterOf(prefix)).toBe(2);
    expect(await releaseRows(a.id)).toHaveLength(0);
    // The card says the same thing, durably.
    expect(await batchNumberState(a.id)).toEqual({ kind: 'kept', why: 'newer', number: a.code, name: b.code });
  });

  it('cascade: 002 cancelled while 003 lived, then 003 cancelled → both come back', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    const c = await mint(prefix);
    expect((await cancelBatch(b.id, 'xato', ctx())).number).toMatchObject({ kind: 'kept', why: 'newer' });
    const res = await cancelBatch(c.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-003`, `${prefix}-002`] });
    expect(await codeOf(b.id)).toBe(`${prefix}-002 (bekor)`);
    expect(await codeOf(c.id)).toBe(`${prefix}-003 (bekor)`);
    expect(await counterOf(prefix)).toBe(1);
    // The earlier cancel's card now says «qaytarildi» — the answer is the truck's own row (P2-REL-2).
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', number: `${prefix}-002` });
  });

  it('a number nobody holds stops the walk («unworn»)', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    // A number the counter passed with no truck behind it.
    await bumpCounter(db, 'batch_seq', prefix);
    const c = await mint(prefix);
    expect(c.code).toBe(`${prefix}-003`);
    const res = await cancelBatch(c.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-003`] });
    const walk = await releaseTrailingCodes(prefix, ctx());
    expect(walk).toEqual({ released: [], stop: { why: 'unworn', number: `${prefix}-002` } });
    expect(await counterOf(prefix)).toBe(2);
    expect(await codeOf(a.id)).toBe(a.code);
  });

  it('the release twice is a no-op', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    const b = await mint(prefix);
    await cancelBatch(b.id, 'xato', ctx());
    const walk = await releaseTrailingCodes(prefix, ctx());
    expect(walk).toEqual({ released: [], stop: { why: 'newer', number: a.code, name: a.code } });
    expect(await releaseRows(b.id)).toHaveLength(1);
    expect(await counterOf(prefix)).toBe(1);
  });
});

describe('a truck renamed before it left', () => {
  it('renamed to its plate, then cancelled → its number comes back; no rename needed', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    const plate = `01A${tag()}BA`;
    await renameBatch({ batchId: b.id, code: plate, seen: { code: b.code, stage: 'loading' } }, planner(), ctx());
    const res = await cancelBatch(b.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-002`] });
    expect(await codeOf(b.id)).toBe(plate);
    expect(await counterOf(prefix)).toBe(1);
    const rows = await releaseRows(b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ code: plate });
    expect(rows[0]!.after).toEqual({ code: plate, released: true });
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', number: `${prefix}-002` });
    expect((await mint(prefix)).code).toBe(`${prefix}-002`);
  });

  it('renamed and LEFT → the walk stops «renamed_left», naming its name', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    const b = await mint(prefix);
    const plate = `01A${tag()}BA`;
    await renameBatch({ batchId: b.id, code: plate, seen: { code: b.code, stage: 'loading' } }, planner(), ctx());
    await db.update(batches).set({ status: 'in_transit', departedAt: new Date() }).where(eq(batches.id, b.id));
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'kept', why: 'renamed_left', newer: plate, number: `${prefix}-002` });
    expect(await counterOf(prefix)).toBe(2);
    expect(await codeOf(a.id)).toBe(a.code);
  });
});

describe('papers at the agent keep the number (his 7a)', () => {
  it('ticked «agentga yuborildi» → kept «agent»', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    await db.update(batches).set({ sentToAgentAt: '2026-11-08' }).where(eq(batches.id, a.id));
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'kept', why: 'agent', newer: a.code, number: a.code });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await counterOf(prefix)).toBe(1);
  });

  it('tick → untick → cancel is still kept «agent» — an untick does not un-send papers', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    // The two rows the tick and the untick write (batch-actions-server.ts).
    for (const sent of [true, false]) {
      await writeAudit(db, { actorId, warehouseId: originId }, {
        entityType: 'batch',
        entityId: a.id,
        action: 'update',
        after: { sentToAgent: sent, frozenLots: 0 },
      });
    }
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toMatchObject({ kind: 'kept', why: 'agent' });
    expect(await codeOf(a.id)).toBe(a.code);
  });
});

describe('what else keeps a number', () => {
  it('the warehouse prefix changed since the mint → kept «prefix»', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    await freshPrefix();
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toMatchObject({ kind: 'kept', why: 'prefix' });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await counterOf(prefix)).toBe(1);
  });

  it('a truck cancelled after it LEFT (the annul) keeps its number — «left»', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    await db
      .update(batches)
      .set({ status: 'cancelled', departedAt: new Date() })
      .where(eq(batches.id, a.id));
    expect(await releaseTrailingCodes(prefix, ctx())).toEqual({
      released: [],
      stop: { why: 'left', number: a.code, name: a.code },
    });
    expect(await batchNumberState(a.id)).toEqual({ kind: 'kept', why: 'left', number: a.code });
  });

  it('a truck with money on it cannot be cancelled, so its number never moves', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    const [row] = await db
      .insert(clientTransactions)
      .values({
        clientId,
        type: 'charge',
        amount: '10',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '10',
        txDate: '2026-11-08',
        batchId: a.id,
        createdBy: actorId,
      })
      .returning({ id: clientTransactions.id });
    moneyRows.push(row!.id);
    await expect(cancelBatch(a.id, 'xato', ctx())).rejects.toMatchObject({ code: 'batch_has_charges' });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await counterOf(prefix)).toBe(1);
  });
});

describe('concurrency — never a duplicate', () => {
  it('a mint in flight between the cancel and its release → kept «newer», and the next number is fresh', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    let answer: Awaited<ReturnType<typeof cancelBatch>> | Error | null = null;
    const third = `${prefix}-003`;
    let thirdId = '';
    await withHolder(async (held) => {
      await held`BEGIN`;
      // A mint half-way: the counter bumped (its row lock held), the truck inserted, not committed.
      await held`INSERT INTO counters (kind, scope_key, value) VALUES ('batch_seq', ${prefix}, 1)
                 ON CONFLICT (kind, scope_key) DO UPDATE SET value = counters.value + 1`;
      thirdId = randomUUID();
      trucks.push(thirdId);
      await held`INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by)
                 VALUES (${thirdId}, ${third}, ${originId}, ${destId}, 'forming', ${actorId})`;
      const ours = cancelBatch(b.id, 'xato', ctx()).then(
        (res) => (answer = res),
        (err: Error) => (answer = err),
      );
      expect(await someoneWaits(), 'the release never waited for the mint').toBe(true);
      await held`COMMIT`;
      await ours;
    });
    expect(answer).not.toBeInstanceOf(Error);
    expect((answer as unknown as Awaited<ReturnType<typeof cancelBatch>>).number).toEqual({
      kind: 'kept',
      why: 'newer',
      newer: third,
      number: b.code,
    });
    expect(await codeOf(b.id)).toBe(b.code);
    expect(await counterOf(prefix)).toBe(3);
    expect((await mint(prefix)).code).toBe(`${prefix}-004`);
  });

  it('a release that cannot get the counter in 3 s answers «busy»; the cancel stands, the card says «pending», the next walk frees it', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    let answer: Awaited<ReturnType<typeof cancelBatch>> | null = null;
    await withHolder(async (held) => {
      await held`BEGIN`;
      await held`SELECT value FROM counters WHERE kind = 'batch_seq' AND scope_key = ${prefix} FOR UPDATE`;
      answer = await cancelBatch(b.id, 'xato', ctx());
      await held`ROLLBACK`;
    });
    expect(answer!.number).toEqual({ kind: 'kept', why: 'busy', number: b.code });
    expect((await db.query.batches.findFirst({ where: eq(batches.id, b.id) }))!.status).toBe('cancelled');
    expect(await batchNumberState(b.id)).toEqual({ kind: 'kept', why: 'pending', number: b.code });
    expect((await releaseTrailingCodes(prefix, ctx())).released).toEqual([b.code]);
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', number: b.code });
  }, 30_000);
});

describe('the dry run (his 7a)', () => {
  it('lists every gap in his words, names what --apply returns, and --apply returns exactly that', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix); // 001 — cancelled before this round: a gap in the MIDDLE, stays
    await mint(prefix); // 002 — live
    await bumpCounter(db, 'batch_seq', prefix); // 003 — nobody
    const d = await mint(prefix); // 004 — live
    const e = await mint(prefix); // 005 — cancelled before this round, agent-ticked: kept
    const f = await mint(prefix); // 006 — cancelled before this round: trailing → returns
    // Cancelled the old way — no give-back ran (rows from before the deploy).
    await db.update(batches).set({ status: 'cancelled' }).where(inArray(batches.id, [a.id, e.id, f.id]));
    await db.update(batches).set({ sentToAgentAt: '2026-11-01' }).where(eq(batches.id, e.id));

    const [report] = await batchNumberReport([prefix]);
    expect(report!.prefix).toBe(prefix);
    expect(report!.counter).toBe(6);
    expect(report!.warehouses).toEqual([WH_O]);
    expect(report!.highestCode).toBe(`${prefix}-006`);
    expect(report!.cancelled.map((c) => [c.code, c.atAgent, c.released])).toEqual([
      [a.code, false, false],
      [e.code, true, false],
      [f.code, false, false],
    ]);
    expect(report!.gaps).toEqual([
      { number: `${prefix}-001`, kind: 'cancelled', atAgent: false },
      { number: `${prefix}-003`, kind: 'unworn' },
      { number: `${prefix}-005`, kind: 'cancelled', atAgent: true },
      { number: `${prefix}-006`, kind: 'cancelled', atAgent: false },
    ]);
    expect(report!.wouldReturn).toEqual([`${prefix}-006`]);

    const walk = await releaseTrailingCodes(prefix, { actorId: null });
    expect(walk.released).toEqual(report!.wouldReturn);
    expect(walk.stop).toMatchObject({ why: 'agent', number: e.code });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await codeOf(d.id)).toBe(d.code);
    // Read again, the released truck is named as such and nothing more returns.
    const [after] = await batchNumberReport([prefix]);
    expect(after!.cancelled.find((c) => c.code === `${f.code} (bekor)`)?.released).toBe(true);
    expect(after!.wouldReturn).toEqual([]);
  });
});
