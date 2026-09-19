import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  crmPeople,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { issueParties } from '@/modules/wms/issue/parties';

/**
 * Who is waiting at the counter (owner's item 3, 2026-09-14): «spiska tursin
 * isim tel nomer va unga tegishli kodlar … yolchi GS555 700boxes gs777 400
 * boxes bekzod gs5564 5boxes».
 *
 * The fixture is his own example plus the two cases that decide whether the
 * list can be trusted: a code whose cargo is standing at ANOTHER warehouse
 * (it must not appear here), and cargo with no client at all — the carton
 * with a hand-written marking, which is a row and a door but never a choice.
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whHere: string;
let whElse: string;
let personId: string;
let codeA: string; // grouped, 7 boxes here
let codeB: string; // grouped with A under one person, 4 boxes here
let codeC: string; // ungrouped, 1 box here
let codeD: string; // ungrouped, cargo at the OTHER warehouse only
let codeE: string; // ungrouped, 2 boxes here — the SECOND one, see below
let unclaimedReceipt: string;
const madeBoxes: string[] = [];
const madeReceipts: string[] = [];

async function receiptWithBoxes(input: {
  clientId: string | null;
  marking?: string;
  warehouseId: string;
  count: number;
  status?: 'ready_for_pickup' | 'in_stock' | 'issued';
  at?: string;
}) {
  const receiptId = (
    await db
      .insert(receipts)
      .values({
        warehouseId: input.warehouseId,
        clientId: input.clientId,
        unclaimedMarking: input.marking ?? null,
        status: 'confirmed',
        createdBy: actorId,
      })
      .returning({ id: receipts.id })
  )[0]!.id;
  madeReceipts.push(receiptId);
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        productNameZh: `货${SUFFIX}`,
        boxCount: input.count,
        dimsMode: 'mixed',
        totalWeightKg: String(input.count * 10),
        totalVolumeM3: String(input.count),
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: input.count }, (_, i) => ({
        lotId,
        shortCode: `IP${SUFFIX}${madeBoxes.length + i}`,
        seqInLot: i + 1,
        currentWarehouseId: input.at ?? input.warehouseId,
        status: input.status ?? ('ready_for_pickup' as const),
      })),
    )
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));
  return receiptId;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const wh = (code: string): typeof warehouses.$inferInsert => ({
    name: `Topshirish sklad ${code}`,
    code,
    batchPrefix: code,
    country: 'UZ',
    type: 'distribution',
    timezone: 'Asia/Tashkent',
    issuesToClients: true,
  });
  whHere = (
    await db.insert(warehouses).values(wh(`IH${SUFFIX}`)).returning({ id: warehouses.id })
  )[0]!.id;
  whElse = (
    await db.insert(warehouses).values(wh(`IE${SUFFIX}`)).returning({ id: warehouses.id })
  )[0]!.id;

  personId = (
    await db
      .insert(crmPeople)
      .values({ name: `Yolchi ${SUFFIX}`, phones: ['+998 90 111-22-33'], createdBy: actorId })
      .returning({ id: crmPeople.id })
  )[0]!.id;

  const mintClient = async (code: string, name: string, over: Record<string, unknown> = {}) =>
    (
      await db
        .insert(clients)
        .values({ clientCode: code, name, ...over } as typeof clients.$inferInsert)
        .returning({ id: clients.id })
    )[0]!.id;

  codeA = await mintClient(`IA${SUFFIX}`, `Yolchi A ${SUFFIX}`, {
    personId,
    phones: ['+998 90 111-22-33'],
  });
  codeB = await mintClient(`IB${SUFFIX}`, `Yolchi B ${SUFFIX}`, {
    personId,
    phones: ['901112233', '+998 91 777-00-00'],
  });
  codeC = await mintClient(`IC${SUFFIX}`, `Bekzod ${SUFFIX}`, { phones: ['+998 93 555-44-33'] });
  codeD = await mintClient(`ID${SUFFIX}`, `Boshqa sklad ${SUFFIX}`, {});
  /**
   * A SECOND ungrouped code, and the round's own red proof is why. With one
   * of them the fixture cannot see the defect it is meant to catch: keying
   * the party map on `personId` alone folds every ungrouped customer in the
   * warehouse into one row, and one row is what a single fixture produces
   * either way (#166 — a proof that will not go red is evidence about the
   * fixture). Most customers are ungrouped, so this is also the common case.
   */
  codeE = await mintClient(`IF${SUFFIX}`, `Sobir ${SUFFIX}`, { phones: ['+998 94 222-33-44'] });

  await receiptWithBoxes({ clientId: codeA, warehouseId: whHere, count: 7 });
  await receiptWithBoxes({ clientId: codeB, warehouseId: whHere, count: 4 });
  await receiptWithBoxes({ clientId: codeC, warehouseId: whHere, count: 1, status: 'in_stock' });
  await receiptWithBoxes({ clientId: codeE, warehouseId: whHere, count: 2 });
  // Already handed over — gone from the shelf, so gone from the list.
  await receiptWithBoxes({ clientId: codeC, warehouseId: whHere, count: 5, status: 'issued' });
  // Received HERE, standing THERE: the row belongs to the other warehouse.
  await receiptWithBoxes({ clientId: codeD, warehouseId: whHere, count: 3, at: whElse });
  unclaimedReceipt = await receiptWithBoxes({
    clientId: null,
    marking: `GS${SUFFIX}MANIKEN-AL`,
    warehouseId: whHere,
    count: 2,
  });
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(clients).where(inArray(clients.id, [codeA, codeB, codeC, codeD, codeE]));
  await db.delete(crmPeople).where(eq(crmPeople.id, personId));
  await db.delete(warehouses).where(inArray(warehouses.id, [whHere, whElse]));
  await pgClient.end();
});

describe('issueParties', () => {
  it('prints one row per HUMAN BEING, with every code and its box count', async () => {
    const { parties } = await issueParties(whHere);
    const yolchi = parties.find((party) => party.personId === personId);
    expect(yolchi, 'the grouped person must be one row').toBeDefined();
    expect(yolchi!.name).toContain('Yolchi');
    expect(yolchi!.codes.map((code) => `${code.code}:${code.boxes}`).sort()).toEqual([
      `IA${SUFFIX}:7`,
      `IB${SUFFIX}:4`,
    ]);
    expect(yolchi!.boxes, 'the row totals its codes').toBe(11);
  });

  it('shows the phone — his 3.3a — including the numbers the codes carry', async () => {
    const { parties } = await issueParties(whHere);
    const yolchi = parties.find((party) => party.personId === personId)!;
    expect(yolchi.phones).toContain('+998 90 111-22-33');
    expect(yolchi.phones, 'a second number on a member code is reachable too').toContain(
      '+998 91 777-00-00',
    );
    // Deduplicated: the person and code A carry the same number.
    expect(yolchi.phones.filter((phone) => phone === '+998 90 111-22-33')).toHaveLength(1);
  });

  it('leaves each ungrouped code as its OWN row rather than folding them together', async () => {
    const { parties } = await issueParties(whHere);
    const single = parties.filter((party) => party.personId === null);
    // Two rows, one code each — `codeD`'s cargo is elsewhere and the issued
    // boxes are gone. Two is the number that matters: a map keyed on the
    // person alone answers with ONE row holding both codes, and the screen
    // would print two strangers under one name.
    expect(single).toHaveLength(2);
    expect(single.flatMap((party) => party.codes.map((code) => code.code)).sort()).toEqual([
      `IC${SUFFIX}`,
      `IF${SUFFIX}`,
    ]);
    expect(single.every((party) => party.codes.length === 1)).toBe(true);
    expect(single.find((party) => party.codes[0]!.code === `IC${SUFFIX}`)!.boxes).toBe(1);
  });

  it('counts only cargo standing HERE — never where it was received', async () => {
    const { parties } = await issueParties(whHere);
    expect(parties.flatMap((party) => party.codes).map((code) => code.code)).not.toContain(
      `ID${SUFFIX}`,
    );
    const elsewhere = await issueParties(whElse);
    expect(elsewhere.parties.flatMap((p) => p.codes).map((c) => c.code)).toContain(`ID${SUFFIX}`);
  });

  it('gives cargo with no owner its own row, by marking, pointing at the prixod', async () => {
    const { unclaimed, parties } = await issueParties(whHere);
    const row = unclaimed.find((item) => item.receiptId === unclaimedReceipt);
    expect(row, 'the unclaimed carton must be listed (his 3.2a)').toBeDefined();
    expect(row!.marking).toBe(`GS${SUFFIX}MANIKEN-AL`);
    expect(row!.boxes).toBe(2);
    // …and NEVER as a party: there is nobody to sign for it or to bill.
    expect(parties.some((party) => party.codes.some((code) => code.code.includes('MANIKEN')))).toBe(
      false,
    );
  });

  it('orders the biggest pile first — that is who is at the counter', async () => {
    const { parties } = await issueParties(whHere);
    const mine = parties.filter(
      (party) =>
        party.personId === personId ||
        [`IC${SUFFIX}`, `IF${SUFFIX}`].includes(party.codes[0]!.code),
    );
    expect(mine.map((party) => party.boxes)).toEqual([11, 2, 1]);
  });
});
