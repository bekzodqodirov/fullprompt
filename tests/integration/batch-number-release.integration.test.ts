import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  clients,
  clientTransactions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { writeAudit } from '@/modules/platform/audit/service';
import { bumpCounter, nextBatchCode, readCounter } from '@/modules/wms/codes';
import { batchNumberReport, batchNumberState } from '@/modules/wms/batches/batch-number';
import {
  batchByFormerCode,
  codeEverWorn,
  formerCodesFor,
  numberHolderOf,
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
const cartonIds: string[] = [];
const lotIds: string[] = [];
const receiptIds: string[] = [];

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

/** A rename before departure, through the service (no reason — not a former name). */
const renameLoading = async (id: string, code: string) =>
  renameBatch({ batchId: id, code, seen: { code: await codeOf(id), stage: 'loading' } }, planner(), ctx());

/** A rename ON THE ROAD, through the service's road branch (a reason — a former name for ever). */
const renameRoad = async (id: string, code: string, reason: string) =>
  renameBatch({ batchId: id, code, reason, seen: { code: await codeOf(id), stage: 'road' } }, planner(), ctx());

/**
 * Departs a truck with one carton aboard: the road stage of a rename needs a
 * carton still to unload (`awaitingUnloadCount`), and that is all it reads.
 */
async function departWithCarton(id: string) {
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: originId, clientId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
    .returning();
  receiptIds.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '号码',
      boxCount: 1,
      totalWeightKg: '10',
      totalVolumeM3: '0.2',
    })
    .returning();
  lotIds.push(lot!.id);
  const [carton] = await db
    .insert(boxes)
    .values({ lotId: lot!.id, shortCode: `NRLB${tag()}`, seqInLot: 1, status: 'in_transit', currentBatchId: id })
    .returning();
  cartonIds.push(carton!.id);
  await db.update(batches).set({ status: 'in_transit', departedAt: new Date() }).where(eq(batches.id, id));
}

/** «Agentga yuborildi» as the action writes it — the column and its audit row (batch-actions-server.ts). */
async function tickAgent(id: string, sent: boolean) {
  await db.update(batches).set({ sentToAgentAt: sent ? '2026-11-09' : null }).where(eq(batches.id, id));
  await writeAudit(db, { actorId, warehouseId: originId }, {
    entityType: 'batch',
    entityId: id,
    action: 'update',
    after: { sentToAgent: sent, frozenLots: 0 },
  });
}
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
    if (cartonIds.length) await db.delete(boxes).where(inArray(boxes.id, cartonIds));
    if (lotIds.length) await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    if (receiptIds.length) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
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
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', numbers: [`${prefix}-002`] });

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
    expect(rows[0]!.after).toEqual({ code: `${prefix}-002 (bekor)`, released: true, number: `${prefix}-002` });
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
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', numbers: [`${prefix}-002`] });
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
    // The plate is both before and after: only `number` says what came back.
    expect(rows[0]!.after).toEqual({ code: plate, released: true, number: `${prefix}-002` });
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', numbers: [`${prefix}-002`] });
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

describe('a truck that wore ANOTHER truck’s vacated number (review C1, C2)', () => {
  const rename = async (id: string, code: string) =>
    renameBatch({ batchId: id, code, seen: { code: await codeOf(id), stage: 'loading' } }, planner(), ctx());

  it('swapped names: the answer and the card name the number that CAME BACK, never the born one', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix); // 001
    const b = await mint(prefix); // 002, the top
    await rename(b.id, `01S${tag()}BA`);
    await rename(a.id, b.code); // A wears 002
    await rename(b.id, a.code); // B wears 001, live
    const res = await cancelBatch(a.id, 'xato', ctx());
    // The walk gave back 002 (A wore it) and stopped at 001, B's live name.
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-002`] });
    expect(await codeOf(a.id)).toBe(`${prefix}-002 (bekor)`);
    expect(await counterOf(prefix)).toBe(1);
    expect(await batchNumberState(a.id)).toEqual({ kind: 'returned', numbers: [`${prefix}-002`] });
    expect((await releaseRows(a.id))[0]!.after).toMatchObject({ released: true, number: `${prefix}-002` });
    expect(await codeOf(b.id)).toBe(`${prefix}-001`);
    expect((await mint(prefix)).code).toBe(`${prefix}-002`);
  });

  it('kept: the card names the number the truck HOLDS (the one it wears), not the one a live colleague wears now', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix); // 001
    const b = await mint(prefix); // 002
    const c = await mint(prefix); // 003, live, the top
    await rename(a.id, `01K${tag()}BA`);
    await rename(b.id, a.code); // B (live) wears 001 now
    await rename(a.id, b.code); // A wears 002
    const res = await cancelBatch(a.id, 'xato', ctx());
    expect(res.number).toEqual({ kind: 'kept', why: 'newer', newer: c.code, number: `${prefix}-002` });
    expect(await batchNumberState(a.id)).toEqual({ kind: 'kept', why: 'newer', number: `${prefix}-002`, name: c.code });
    expect(await counterOf(prefix)).toBe(3);
  });

  it('the minter holds its number: a live truck renamed to its plate is not shadowed by a later renamer', async () => {
    const prefix = await freshPrefix();
    const y = await mint(prefix); // 001
    const x = await mint(prefix); // 002, the top
    const plate = `01X${tag()}BA`;
    await rename(x.id, plate); // X stays live, minted as 002
    await rename(y.id, x.code); // Y takes the vacated 002 by hand…
    await rename(y.id, `02Y${tag()}CC`); // …and moves away from it again
    const res = await cancelBatch(y.id, 'xato', ctx());
    // Nothing comes back: 002 is X's (live), so 001 stays below it too.
    expect(res.number).toEqual({ kind: 'kept', why: 'newer', newer: plate, number: y.code });
    expect(await counterOf(prefix)).toBe(2);
    expect(await releaseRows(y.id)).toHaveLength(0);
    expect(await codeOf(x.id)).toBe(plate);
    expect((await db.query.batches.findFirst({ where: eq(batches.id, x.id) }))!.status).toBe('forming');
    // …and the next truck is 003, never a second 002 beside the live X.
    expect((await mint(prefix)).code).toBe(`${prefix}-003`);
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

describe('papers at the agent keep the NUMBER, whoever holds it (review RVF3-1)', () => {
  /**
   * X is minted 002 and renamed to its plate (it stays live); Y takes the
   * vacated «002» by hand, its papers go to the agent under 002, and Y moves
   * away again before departure. The minter rule (C2) makes X the holder of
   * 002, and X was never ticked — but the agent holds Y's papers under 002.
   */
  async function agentShape(opts: { unticked: boolean }) {
    const prefix = await freshPrefix();
    const y = await mint(prefix); // 001
    const x = await mint(prefix); // 002, the top
    const plate = `01G${tag()}BA`;
    await renameLoading(x.id, plate);
    await renameLoading(y.id, x.code);
    await tickAgent(y.id, true);
    if (opts.unticked) await tickAgent(y.id, false);
    const away = `02G${tag()}CC`;
    await renameLoading(y.id, away);
    return { prefix, x, y, plate, away };
  }

  for (const unticked of [false, true]) {
    it(`the minter’s cancel keeps it «agent»${unticked ? ' — an untick does not un-send the colleague’s papers' : ''}`, async () => {
      const { prefix, x, plate } = await agentShape({ unticked });
      const res = await cancelBatch(x.id, 'xato', ctx());
      expect(res.number).toEqual({ kind: 'kept', why: 'agent', newer: plate, number: x.code });
      expect(await counterOf(prefix)).toBe(2);
      expect(await releaseRows(x.id)).toHaveLength(0);
      expect(await codeOf(x.id)).toBe(plate);
      // The card says the same thing, durably.
      expect(await batchNumberState(x.id)).toEqual({ kind: 'kept', why: 'agent', number: x.code, name: plate });
      // …and the next truck is 003, never a second 002 beside the papers.
      expect((await mint(prefix)).code).toBe(`${prefix}-003`);
    });
  }

  it('--apply over rows cancelled the old way agrees: the dry run says «agent», the walk gives nothing back', async () => {
    const { prefix, x, plate, away } = await agentShape({ unticked: false });
    // Cancelled by a path that ran no give-back (rows from before the deploy).
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, x.id));
    const [report] = await batchNumberReport([prefix]);
    expect(report!.wouldReturn).toEqual([]);
    expect(report!.stoppedBy).toEqual({ why: 'agent', number: x.code, name: plate });
    expect(report!.gaps).toEqual([
      { number: `${prefix}-001`, kind: 'renamed_waiting', name: away },
      { number: x.code, kind: 'cancelled', atAgent: true, name: plate },
    ]);
    expect(await releaseTrailingCodes(prefix, { actorId: null })).toEqual({
      released: [],
      stop: { why: 'agent', number: x.code, name: plate },
    });
    expect(await counterOf(prefix)).toBe(2);
    expect(await releaseRows(x.id)).toHaveLength(0);
  });

  it('the same for a WEARER: a third truck renamed to the number and cancelled gives back only what is above it', async () => {
    const { prefix, x } = await agentShape({ unticked: false });
    const w = await mint(prefix); // 003, the top
    await renameLoading(w.id, x.code); // W wears 002 now
    const res = await cancelBatch(w.id, 'xato', ctx());
    // 003 (W's own) comes back; 002 — W wears it, Y's papers went under it — stays.
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-003`] });
    expect(await codeOf(w.id)).toBe(x.code);
    expect(await counterOf(prefix)).toBe(2);
    expect(await releaseTrailingCodes(prefix, ctx())).toEqual({
      released: [],
      stop: { why: 'agent', number: x.code, name: x.code },
    });
    expect((await mint(prefix)).code).toBe(`${prefix}-003`);
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

describe('a number given back and then carried on the road by another truck (review RVF3-2)', () => {
  it('the dry run, --apply and the bot name the truck that carried it; the giver’s card stops promising it', async () => {
    const prefix = await freshPrefix();
    const r = await mint(prefix); // 001
    const b = await mint(prefix); // 002
    const c = await mint(prefix); // 003
    expect((await cancelBatch(c.id, 'xato', ctx())).number).toEqual({ kind: 'returned', codes: [c.code] });
    expect((await cancelBatch(b.id, 'xato', ctx())).number).toEqual({ kind: 'returned', codes: [b.code] });
    expect(await counterOf(prefix)).toBe(1);
    // R leaves and is renamed on the road to the free «…-002» (a partner's papers)…
    await departWithCarton(r.id);
    await renameRoad(r.id, b.code, 'hamkor raqami');
    // …a truck minted and cancelled meanwhile brings the counter back to 2…
    const d = await mint(prefix);
    expect(d.code).toBe(`${prefix}-003`);
    expect((await cancelBatch(d.id, 'xato', ctx())).number).toEqual({ kind: 'returned', codes: [d.code] });
    expect(await counterOf(prefix)).toBe(2);
    // …and R is renamed on the road again, away from it: 002 is burned for good.
    const kz = `01K${tag()}KZ`;
    await renameRoad(r.id, kz, 'yana hamkor');
    expect(await codeEverWorn(db, b.code, null)).toBe(true);

    // The holder of 002 is the truck that carried it, as ⌘K and the bot say.
    expect((await numberHolderOf(db, b.code))?.id).toBe(r.id);
    expect((await batchByFormerCode(b.code))?.batchId).toBe(r.id);
    const [report] = await batchNumberReport([prefix]);
    expect(report!.gaps).toEqual([
      { number: `${prefix}-001`, kind: 'renamed_left', name: kz },
      { number: b.code, kind: 'renamed_left', name: kz },
    ]);
    expect(report!.stoppedBy).toEqual({ why: 'renamed_left', number: b.code, name: kz });
    expect(await releaseTrailingCodes(prefix, { actorId: null })).toEqual({
      released: [],
      stop: { why: 'renamed_left', number: b.code, name: kz },
    });

    // B's card: its number came back once, and is no longer promised to the next truck.
    expect(await batchNumberState(b.id)).toEqual({
      kind: 'returned',
      numbers: [b.code],
      taken: [{ number: b.code, name: kz }],
    });
    // C's is untouched by any road: still the next truck's.
    expect(await batchNumberState(c.id)).toEqual({ kind: 'returned', numbers: [c.code] });
    // …and the mint passes over the burned one.
    expect((await mint(prefix)).code).toBe(`${prefix}-003`);
  });

  it('a cancelled truck below it says who carried it, not the cancelled minter that never left', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix); // 001
    const r = await mint(prefix); // 002
    const b = await mint(prefix); // 003, the top
    expect((await cancelBatch(b.id, 'xato', ctx())).number).toEqual({ kind: 'returned', codes: [b.code] });
    await departWithCarton(r.id);
    await renameRoad(r.id, b.code, 'hamkor raqami');
    const kz = `01K${tag()}KZ`;
    await renameRoad(r.id, kz, 'yana hamkor');
    const g = await mint(prefix);
    expect(g.code).toBe(`${prefix}-004`);
    expect((await cancelBatch(a.id, 'xato', ctx())).number).toMatchObject({ kind: 'kept', why: 'newer', newer: g.code });
    expect((await cancelBatch(g.id, 'xato', ctx())).number).toEqual({ kind: 'returned', codes: [g.code] });
    expect(await counterOf(prefix)).toBe(3);
    // The walk stopped at 003, which R took out under a rename.
    expect(await batchNumberState(a.id)).toEqual({ kind: 'kept', why: 'renamed_left', number: b.code, name: kz });
  });
});

describe('after the commit nothing fails the cancel (review F3)', () => {
  it('a failed re-read of the truck answers with the row the cancel returned — never an error page', async () => {
    const prefix = await freshPrefix();
    await mint(prefix);
    const b = await mint(prefix);
    // The pool blinks on the one post-commit read of the truck (nothing else on
    // the cancel's path asks `db.query.batches`; inside the transaction it is `tx`).
    const spy = vi.spyOn(db.query.batches, 'findFirst').mockRejectedValueOnce(new Error('pool blip'));
    let res: Awaited<ReturnType<typeof cancelBatch>>;
    let reads = 0;
    try {
      res = await cancelBatch(b.id, 'xato', ctx());
    } finally {
      reads = spy.mock.calls.length;
      spy.mockRestore();
    }
    expect(reads, 'the blip never reached the re-read').toBe(1);
    // The cancel stands, its number came back, and the row is the transaction's own.
    expect(res.batch.id).toBe(b.id);
    expect(res.batch.status).toBe('cancelled');
    expect(res.number).toEqual({ kind: 'returned', codes: [`${prefix}-002`] });
    expect(await codeOf(b.id)).toBe(`${prefix}-002 (bekor)`);
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
    expect(await batchNumberState(b.id)).toEqual({ kind: 'returned', numbers: [b.code] });
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
    // …and what stops it, by the verdict's own reason — read to him in words (review C5).
    expect(report!.stoppedBy).toEqual({ why: 'agent', number: e.code, name: e.code });

    const walk = await releaseTrailingCodes(prefix, { actorId: null });
    expect(walk.released).toEqual(report!.wouldReturn);
    expect(walk.stop).toMatchObject({ why: 'agent', number: e.code });
    expect(await codeOf(a.id)).toBe(a.code);
    expect(await codeOf(d.id)).toBe(d.code);
    // Read again, the released truck is named as such and nothing more returns.
    const [after] = await batchNumberReport([prefix]);
    expect(after!.cancelled.find((c) => c.code === `${f.code} (bekor)`)?.released).toBe(true);
    expect(after!.wouldReturn).toEqual([]);
    expect(after!.stoppedBy).toEqual({ why: 'agent', number: e.code, name: e.code });
  });

  it('a walk that runs out of numbers says so («empty») — at the bottom, and at counter 0', async () => {
    const prefix = await freshPrefix();
    const a = await mint(prefix);
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, a.id));
    const [before] = await batchNumberReport([prefix]);
    expect(before!.wouldReturn).toEqual([a.code]);
    expect(before!.stoppedBy).toBe('empty');
    expect((await releaseTrailingCodes(prefix, { actorId: null })).released).toEqual([a.code]);
    const [after] = await batchNumberReport([prefix]);
    expect(after!.counter).toBe(0);
    expect(after!.wouldReturn).toEqual([]);
    expect(after!.stoppedBy).toBe('empty');
  });
});
