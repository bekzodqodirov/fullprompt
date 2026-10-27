import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  calcBazas,
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  customsImportBatches,
  deals,
  dealStages,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { onDate, saveBaza } from '@/modules/wms/calc/dictionaries';
import { CalcError, openCalcRequest } from '@/modules/wms/calc/service';
import { confirmGroup, saveTable } from '@/modules/wms/calc/workspace';
import { pickBazas } from '@/modules/wms/calc/prefill-steps';
import type { PickOutcome, PickRequest } from '@/modules/wms/calc/prefill-ai';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { productKey } from '@/modules/wms/tnved/service';

/**
 * The machine never writes over a person (docs/SAKKIZ-R2.md §1, §7.2.7,
 * concurrency-3).
 *
 * Round 2's fill runs on EVERY save — the book's included — and the pick's
 * model call takes up to 2 × 60 s with no claim held. So a VED who, during
 * that call, clears a 📖 baza and ✅s the block would see the pick's save put
 * the book's price straight back under `actorId: null`, and that save's
 * unconfirm take their ✅ off — the module's own law (the machine stands down
 * rather than un-ticking a person's ✅) broken by the machine. The pick's save
 * carries the revision the machine last saw; the person's save moved it; the
 * machine's save is `conflict` and writes NOTHING.
 *
 * Code 3924100000 is plastic tableware — a plain advalor law in the seeded
 * PP-3818, so a kg row is at home there.
 */
const SUFFIX = String(Date.now()).slice(-6);
const CODE = '3924100000';
const BOOKED = `Plastik idish CAS ${SUFFIX}`;
const PICKED = `Qoshiq CAS ${SUFFIX}`;

let actorId = '';
let clientId = '';
let dealId = '';
let batchId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99898${String(Date.now()).slice(-7)}`, fullName: `CAS fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db.insert(clients).values({ clientCode: `MC${SUFFIX}`, name: `CAS fixture ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `MC-${SUFFIX}`, clientId, stageId: stage!.id, title: 'CAS fixture', createdBy: actorId })
    .returning();
  dealId = deal!.id;
  await saveBaza(
    { name: BOOKED, label: BOOKED, tnvedCode: null, bazaUsd: 2, basis: 'kg', effectiveDate: onDate(), note: null },
    ctx(),
  );
  // A declaration of the code named nothing like the picked row: no auto-fill,
  // but a candidate for the pick to choose.
  const [batch] = await db.execute<{ id: string }>(sql`
    INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to)
    VALUES (${`cas-${SUFFIX}.xlsx`}, ${actorId}::uuid, 'ready', ${onDate()}::date, ${onDate()}::date)
    RETURNING id::text AS id`);
  batchId = batch!.id;
  const declared = 'Изделия столовые и кухонные из пластмасс';
  await db.execute(sql`
    INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
    VALUES (${batchId}::uuid, ${CODE}, ${declared}, ${normalizeName(declared)}, 'kg', 3::numeric, '156-КИТАЙ')`);
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (batchId) await db.delete(customsImportBatches).where(eq(customsImportBatches.id, batchId));
  await db.delete(calcBazas).where(eq(calcBazas.productKey, productKey(BOOKED)));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(): Promise<string> {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items: [
        { name: PICKED, tnvedCode: CODE, weightKg: 20 },
        { name: BOOKED, tnvedCode: CODE, weightKg: 30 },
      ],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result.id;
}

const rowsOf = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);
const revOf = async (requestId: string) =>
  (await db.select({ rev: calcRequests.rev }).from(calcRequests).where(eq(calcRequests.id, requestId)))[0]!.rev;

describe('a person’s save between the machine’s question and its answer wins', () => {
  it('the pick’s save is refused: the cleared 📖 baza stays empty and the ✅ stands', async () => {
    const id = await open();
    // The machine's first write: the save that groups the rows and fills the
    // 📖 row from the book — the revision the machine carries forward.
    await saveTable(id, { items: [], adds: [] }, ctx());
    const [picked, booked] = await rowsOf(id);
    expect(booked).toMatchObject({ bazaSource: 'dictionary', bazaUsd: '2.0000' });
    expect(picked!.bazaUsd).toBeNull();
    const machineRev = await revOf(id);

    // The «model call»: while it thinks, a PERSON clears the 📖 baza and ✅s
    // the block — the normal way this queue is worked.
    const pick = async (rows: PickRequest[]): Promise<PickOutcome> => {
      await saveTable(
        id,
        { items: [{ id: booked!.id, seq: booked!.seq, bazaUsd: null, bazaBasis: null }], adds: [] },
        { actorId },
      );
      await confirmGroup(booked!.groupId!, { actorId });
      return {
        answers: rows.map((r) => ({ seq: r.seq, candidate: 0, reason: 'qoshiq' })),
        usage: null,
      };
    };
    const out = await pickBazas(id, { actorId: null }, pick, machineRev);

    expect(out.picked).toBe(0);
    expect(out.overtaken).toBe(1);
    const [pickedAfter, bookedAfter] = await rowsOf(id);
    // The person's clear stands: not refilled from the book behind their back…
    expect(bookedAfter).toMatchObject({ bazaUsd: null, bazaSource: null });
    // …the machine's answer was not written either…
    expect(pickedAfter!.bazaUsd).toBeNull();
    // …and the person's ✅ is still on the block.
    const [group] = await db.select().from(calcGroups).where(eq(calcGroups.id, booked!.groupId!));
    expect(group!.confirmedAt).not.toBeNull();
    expect(group!.confirmedBy).toBe(actorId);
  });

  it('a stale expectRev is `conflict` and writes nothing — not even the audit row', async () => {
    const id = await open();
    await saveTable(id, { items: [], adds: [] }, ctx());
    const stale = await revOf(id);
    await saveTable(id, { items: [], adds: [] }, ctx());
    const before = await rowsOf(id);
    const audits = async () =>
      (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.entityId, id), eq(auditLog.entityType, 'calc_request')))
      ).length;
    const auditsBefore = await audits();
    const revBefore = await revOf(id);

    const [picked] = before;
    await expect(
      saveTable(
        id,
        { items: [{ id: picked!.id, seq: picked!.seq, bazaUsd: 5, bazaBasis: 'kg' }], adds: [] },
        ctx(),
        { expectRev: stale },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof CalcError && err.code === 'conflict');

    expect(await rowsOf(id)).toEqual(before);
    expect(await audits()).toBe(auditsBefore);
    expect(await revOf(id)).toBe(revBefore);
  });

  it('a screen save (no expectRev) is unchanged — a person is never refused for being later', async () => {
    const id = await open();
    await saveTable(id, { items: [], adds: [] }, ctx());
    await saveTable(id, { items: [], adds: [] }, ctx());
    const [picked] = await rowsOf(id);
    const out = await saveTable(
      id,
      { items: [{ id: picked!.id, seq: picked!.seq, bazaUsd: 5, bazaBasis: 'kg' }], adds: [] },
      ctx(),
    );
    expect(out.rev).toBe(await revOf(id));
    expect((await rowsOf(id))[0]).toMatchObject({ bazaUsd: '5.0000', bazaSource: 'typed' });
  });
});
