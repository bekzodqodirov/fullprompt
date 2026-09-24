import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '@/modules/platform/db/schema';
import { listPartners, PartnerError, savePartner } from '@/modules/wms/partners/service';
import { globalSearch, type SearchActor } from '@/modules/wms/search/service';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';

/**
 * A colleague's own account (0101, owner A1c) and the owner's M3a: «faqat
 * buxgalter va admin» see it — `finance.expenses`. The VED holds
 * `finance.manage` and the logist `clients.manage`, so every surface that
 * already admitted them to /kontragentlar must now leave these rows out: the
 * register, the search, and the settlement proof served by uuid.
 *
 * Fixture ledger rows are dated 1831 so no other file's date window meets them.
 */

const SUFFIX = String(Date.now()).slice(-7);
const TX_DATE = '1831-03-01';
let actorId = '';
let transportTypeId = '';
let staffTypeId = '';
const ctx = () => ({ actorId });

const madePartners: string[] = [];
const madeUsers: string[] = [];
let workerA = '';
let workerB = '';
let leaver = '';

let linkedPartner = '';
let typedPartner = '';
let firmPartner = '';
let staffTxId = '';
let firmTxId = '';

async function mintUser(tag: string, active = true): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99897${SUFFIX}${tag}`,
      fullName: `SP ${tag} ${SUFFIX}`,
      passwordHash: 'x',
      active,
    })
    .returning();
  madeUsers.push(row!.id);
  return row!.id;
}

async function newPartner(name: string, typeId: string, userId?: string): Promise<string> {
  const id = await savePartner(
    null,
    { name: `${name} ${SUFFIX}`, typeId, clientId: '', phone: '', note: '', userId },
    ctx(),
  );
  madePartners.push(id);
  return id;
}

async function adjustRow(partnerId: string): Promise<string> {
  // `adjust` names no cash box, so the row needs no till fixture; a direct
  // insert keeps the FX clock out of a test about who may SEE the row.
  const [row] = await db
    .insert(partnerTransactions)
    .values({
      partnerId,
      type: 'adjust',
      amount: '10',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '10',
      txDate: TX_DATE,
      createdBy: actorId,
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const types = await db.select().from(partnerTypes);
  transportTypeId = types.find((t) => t.code === 'transport')!.id;
  staffTypeId = types.find((t) => t.code === 'staff')!.id;

  workerA = await mintUser('1');
  workerB = await mintUser('2');
  leaver = await mintUser('3', false);

  // Staff by the LINK alone: an ordinary type, a login attached.
  linkedPartner = await newPartner('Omborchi Avans', transportTypeId, workerA);
  // Staff by the TYPE alone: opened before anybody linked a login.
  typedPartner = await newPartner('Hodim Turi', staffTypeId);
  firmPartner = await newPartner('Oddiy Firma', transportTypeId);

  staffTxId = await adjustRow(linkedPartner);
  firmTxId = await adjustRow(firmPartner);
});

afterAll(async () => {
  if (madePartners.length) {
    await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, madePartners));
    await db.delete(partners).where(inArray(partners.id, madePartners));
  }
  // Deactivated, never deleted: a login is what audit rows and sessions
  // point at, and this file's users must leave every recipient list.
  if (madeUsers.length) {
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('the register (owner M3a)', () => {
  it('leaves out a login-linked account AND a «Hodim»-typed one for the VED and the logist', async () => {
    const rows = await listPartners({ includeInactive: true, includeStaff: false });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(firmPartner)).toBe(true);
    expect(ids.has(linkedPartner)).toBe(false);
    expect(ids.has(typedPartner)).toBe(false);
  });

  it('shows both to the accountant, marked as staff', async () => {
    const rows = await listPartners({ includeInactive: true, includeStaff: true });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(linkedPartner)?.staff).toBe(true);
    expect(byId.get(linkedPartner)?.userId).toBe(workerA);
    expect(byId.get(typedPartner)?.staff).toBe(true);
    expect(byId.get(firmPartner)?.staff).toBe(false);
  });
});

describe('the login link (savePartner)', () => {
  it('refuses a second account for the same login, in words', async () => {
    await expect(newPartner('Ikkinchi', transportTypeId, workerA)).rejects.toMatchObject({
      code: 'user_taken',
    });
    await expect(
      savePartner(
        firmPartner,
        { name: `Oddiy Firma ${SUFFIX}`, typeId: transportTypeId, userId: workerA },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(PartnerError);
  });

  it('reads an ABSENT login as «unchanged», never as «nobody» (#171)', async () => {
    // The form a VED sees draws no login select, so its save posts no field.
    await savePartner(
      linkedPartner,
      { name: `Omborchi Avans ${SUFFIX}`, typeId: transportTypeId, note: 'VED tuzatdi' },
      ctx(),
    );
    const [row] = await db.select().from(partners).where(eq(partners.id, linkedPartner));
    expect(row!.userId).toBe(workerA);
    expect(row!.note).toBe('VED tuzatdi');
  });

  it('an empty choice unlinks, and a login can be moved to another account', async () => {
    const spare = await newPartner('Almashtirish', transportTypeId, workerB);
    await savePartner(spare, { name: `Almashtirish ${SUFFIX}`, typeId: transportTypeId, userId: '' }, ctx());
    const [cleared] = await db.select().from(partners).where(eq(partners.id, spare));
    expect(cleared!.userId).toBeNull();
    // workerB is free again, so another account may take it.
    await savePartner(spare, { name: `Almashtirish ${SUFFIX}`, typeId: transportTypeId, userId: workerB }, ctx());
    const [linked] = await db.select().from(partners).where(eq(partners.id, spare));
    expect(linked!.userId).toBe(workerB);
  });

  it('refuses to NEWLY link a deactivated login, but keeps one already linked', async () => {
    await expect(newPartner('Ketgan', transportTypeId, leaver)).rejects.toMatchObject({
      code: 'user_not_found',
    });
    // Linked while active, then the person left: an unrelated edit must pass.
    const keeper = await newPartner('Qolgan', transportTypeId);
    await db.update(partners).set({ userId: leaver }).where(eq(partners.id, keeper));
    await savePartner(keeper, { name: `Qolgan ${SUFFIX}`, typeId: transportTypeId, userId: leaver }, ctx());
    const [row] = await db.select().from(partners).where(eq(partners.id, keeper));
    expect(row!.userId).toBe(leaver);
  });
});

describe('the global search (a back door by construction)', () => {
  const searcher = (permissions: string[]): SearchActor => ({
    id: actorId,
    permissions: new Set(permissions),
    warehouseScoped: false,
    warehouseIds: [],
  });

  it('finds no staff account for the VED, and still finds the firm', async () => {
    const ved = searcher(['finance.view', 'finance.manage']);
    const staffHits = await globalSearch(ved, `Omborchi Avans ${SUFFIX}`);
    expect(staffHits.some((hit) => hit.id === linkedPartner)).toBe(false);
    const typedHits = await globalSearch(ved, `Hodim Turi ${SUFFIX}`);
    expect(typedHits.some((hit) => hit.id === typedPartner)).toBe(false);
    const firmHits = await globalSearch(ved, `Oddiy Firma ${SUFFIX}`);
    expect(firmHits.some((hit) => hit.id === firmPartner)).toBe(true);
  });

  it('finds it for the accountant', async () => {
    const accountant = searcher(['finance.view', 'finance.manage', 'finance.expenses']);
    const hits = await globalSearch(accountant, `Omborchi Avans ${SUFFIX}`);
    expect(hits.some((hit) => hit.id === linkedPartner)).toBe(true);
  });
});

describe('a staff account’s file, fetched by uuid', () => {
  const reader = (permissions: string[]) => ({
    id: uuidv4(),
    permissions: new Set(permissions),
    warehouseScoped: false,
    warehouseIds: [],
  });
  const file = (entityId: string) => ({
    id: uuidv4(),
    entityType: 'partner_transaction',
    entityId,
    uploadedBy: actorId,
  });

  it('is refused to the VED and the logist, and enforced', async () => {
    expect(await decideAttachmentRead(reader(['finance.manage']), file(staffTxId))).toEqual({
      allow: false,
      rule: 'partner-tx-staff',
      enforce: true,
    });
    expect((await decideAttachmentRead(reader(['clients.manage']), file(staffTxId))).allow).toBe(false);
  });

  it('is served to the accountant, and a firm’s file still to the VED', async () => {
    expect(
      (await decideAttachmentRead(reader(['finance.manage', 'finance.expenses']), file(staffTxId))).allow,
    ).toBe(true);
    expect((await decideAttachmentRead(reader(['finance.manage']), file(firmTxId))).allow).toBe(true);
  });
});
