import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clients,
  deals,
  dealStages,
  events,
  expenseCategories,
  expenses,
  kpiPayouts,
  leadStages,
  leads,
  notifications,
  receipts,
  staffGroupPosts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { receiveStamped, removeStamped } from '../fixtures/stamped-cargo';
import { ftlDoorFor, FtlError, mayRevertFtl } from '@/modules/wms/ftl/door';
import { setDealLoad, setReceiptLoad } from '@/modules/wms/ftl/service';
import { receiptLoadView } from '@/modules/wms/ftl/read';
import { createDeal, DealError, linkReceipt, updateDeal } from '@/modules/wms/deals/service';
import { CrmError, createLead, setLeadOwner, updateLead } from '@/modules/wms/crm/service';
import { stampedCargo } from '@/modules/wms/staff/cargo';
import { uncoveredCtes, unpricedScopeSql } from '@/modules/wms/finance/unpriced';
import { ratingViewFor } from '@/modules/wms/staff/rating';
import { celebrateLeadWon } from '@/modules/wms/staff/celebrate';
import { departBatch } from '@/modules/wms/scanning/service';

/**
 * LTL / FTL (0135, the owner's 2026-10-20 answers 1a 2a 3b 4a 5a 6a 7a)
 * against a real database: the KPI counts LTL only, the doors (who may mark,
 * who may take back), the inheritance a prixod takes from its deal, the paid
 * month frozen, the rating's separate line, the won post, and the logist's
 * departure hint.
 *
 * Cargo is dated in 1663 (a year no other file uses — search BARE numbers,
 * #1377) and the paid-month cargo in 2026-09, the seed's first KPI month (the
 * freeze is floored there). Audited rows point at the users, clients and
 * warehouses, so those are DEACTIVATED, never deleted.
 */
const S = String(Date.now()).slice(-6);
let n = 0;
const next = () => String((n += 1)).padStart(2, '0');

const madeUsers: string[] = [];
const madeClients: string[] = [];
const madeDeals: string[] = [];
const madeLeads: string[] = [];
const madeBatches: string[] = [];
const madeWarehouses: string[] = [];
const stamped: string[] = [];
const madeExpenses: string[] = [];
let actorId = '';
let openStageId = '';
let categoryId = '';

const ctx = (id = actorId) => ({ actorId: id });
const seller = (id: string) => ftlDoorFor({ id, permissions: new Set(['crm.leads']), warehouseScoped: false });
const office = (id = actorId) => ftlDoorFor({ id, permissions: new Set(['plans.manage']), warehouseScoped: false });

async function mintUser(label: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ phone: `+99894${S}${next()}`, fullName: `FTL ${label} ${S}`, passwordHash: 'x' })
    .returning({ id: users.id });
  madeUsers.push(row!.id);
  return row!.id;
}

async function mintClient(managerId: string | null, phones: string[] = []): Promise<{ id: string; code: string }> {
  const code = `FT${S}${next()}`;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: code, name: `FTL mijoz ${S}`, salesManagerId: managerId, phones })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return { id: row!.id, code };
}

async function mintDeal(clientId: string, ownerId: string | null): Promise<string> {
  const [row] = await db
    .insert(deals)
    .values({ code: `FT-${S}-${next()}`, clientId, stageId: openStageId, title: 'FTL', ownerId, createdBy: actorId })
    .returning({ id: deals.id });
  madeDeals.push(row!.id);
  return row!.id;
}

async function cargo(input: {
  clientId: string;
  sellerId: string | null;
  day?: string;
  m3: number;
  kg: number;
  boxes?: number;
  dealId?: string;
}) {
  const made = await receiveStamped({
    clientId: input.clientId,
    actorId,
    sellerId: input.sellerId,
    m3: input.m3,
    kg: input.kg,
    boxes: input.boxes,
    dealId: input.dealId ?? null,
    receivedAt: new Date(`${input.day ?? '1663-03-10'}T07:00:00Z`),
  });
  stamped.push(made.receiptId);
  return made;
}

async function modeOf(receiptId: string): Promise<{ mode: string; hand: boolean } | null> {
  const rows = (await db.execute(sql`
    SELECT mode, hand FROM receipt_load_mode WHERE receipt_id = ${receiptId}::uuid`)) as unknown as {
    mode: string;
    hand: boolean;
  }[];
  return rows[0] ?? null;
}

const isFtl = async (receiptId: string) => (await modeOf(receiptId))?.mode === 'ftl';

/** A LIVE KPI payout to `sellerId` through `throughMonth` — the 6a freeze's trigger. */
async function payout(sellerId: string, throughMonth: string): Promise<string> {
  const [expense] = await db
    .insert(expenses)
    .values({
      categoryId,
      amount: '10.00',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '10.00',
      expenseDate: '2026-10-09',
      employeeId: sellerId,
      createdBy: actorId,
    } as never)
    .returning({ id: expenses.id });
  madeExpenses.push(expense!.id);
  await db.insert(kpiPayouts).values({
    sellerId,
    expenseId: expense!.id,
    amountUsd: '10.00',
    throughMonth: `${throughMonth}-01`,
    earnedPaidUsd: '10.00',
    paidBeforeUsd: '0',
    breakdown: [],
    createdBy: actorId,
  });
  return expense!.id;
}

const window1663 = { key: '1663-03-14', from: new Date('1663-03-07T13:00:00Z'), to: new Date('1663-03-14T13:00:00Z') };

beforeAll(async () => {
  actorId = await mintUser('admin');
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  openStageId = stage!.id;
  const [cat] = await db
    .insert(expenseCategories)
    .values({ name: `FTL KPI ${S}`, cash: true })
    .returning({ id: expenseCategories.id });
  categoryId = cat!.id;
});

afterAll(async () => {
  const notes = await db.select({ id: notifications.id }).from(notifications).where(
    and(inArray(notifications.type, ['FtlMarked', 'FtlSuspected']), sql`${notifications.payload}->>'text' LIKE ${`%${S}%`}`),
  );
  if (notes.length) await db.delete(notifications).where(inArray(notifications.id, notes.map((r) => r.id)));
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.delete(kpiPayouts).where(inArray(kpiPayouts.sellerId, madeUsers));
  }
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  if (madeLeads.length) {
    await db.delete(staffGroupPosts).where(inArray(staffGroupPosts.dedupeKey, madeLeads.map((id) => `won:${id}`)));
  }
  if (madeBatches.length) {
    const evs = await db.select({ id: events.id }).from(events).where(inArray(events.entityId, madeBatches));
    if (evs.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, evs.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, evs.map((e) => e.id)));
    }
  }
  if (stamped.length) {
    const boxIds = (
      await db.execute(sql`
        SELECT b.id::text AS id FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
         WHERE rl.receipt_id IN (${sql.join(stamped.map((id) => sql`${id}::uuid`), sql`, `)})`)
    ) as unknown as { id: string }[];
    if (boxIds.length) {
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, [...boxIds].map((b) => b.id)));
      await db.update(boxes).set({ currentBatchId: null }).where(inArray(boxes.id, [...boxIds].map((b) => b.id)));
    }
  }
  await removeStamped(stamped);
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeLeads.length) await db.update(leads).set({ ownerId: null }).where(inArray(leads.id, madeLeads));
  await db.update(expenseCategories).set({ active: false }).where(eq(expenseCategories.id, categoryId));
  if (madeClients.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, madeClients));
  if (madeWarehouses.length) await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, madeWarehouses));
  if (madeUsers.length) await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('the office door (2a) over the SEEDED roles', () => {
  it('admin, super_admin, logist and the accountant may take FTL back; the seller, the VED and the warehouse may not', async () => {
    const rows = (await db.execute(sql`
      SELECT r.code, r.warehouse_scoped AS scoped, coalesce(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS perms
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.code, r.warehouse_scoped`)) as unknown as { code: string; scoped: boolean; perms: string[] }[];
    const byCode = new Map([...rows].map((row) => [row.code, row]));
    const door = (code: string) => {
      const row = byCode.get(code);
      expect(row, `role ${code} is seeded`).toBeTruthy();
      return mayRevertFtl({ permissions: new Set(row!.perms), warehouseScoped: row!.scoped });
    };
    for (const code of ['super_admin', 'admin', 'logist', 'accountant']) expect(door(code), code).toBe(true);
    for (const code of ['sales_manager', 'ved_manager', 'warehouse_manager', 'warehouse_operator']) expect(door(code), code).toBe(false);
    // A warehouse role somebody gives «Rejalar» one day is still not the office.
    expect(mayRevertFtl({ permissions: new Set(['plans.manage']), warehouseScoped: true })).toBe(false);
  });
});

describe('the KPI counts LTL only, and the paid part is a part of it', () => {
  it('stampedCargo splits by mode; the paid scope drops FTL cartons', async () => {
    const a = await mintUser('kpi');
    const client = await mintClient(a);
    const ltl = await cargo({ clientId: client.id, sellerId: a, m3: 4, kg: 400 });
    const ftl = await cargo({ clientId: client.id, sellerId: a, m3: 80, kg: 9000 });
    await setReceiptLoad(ftl.receiptId, 'ftl', seller(a), ctx(a));

    const range = { from: new Date('1663-03-01T00:00:00Z'), to: new Date('1663-04-01T00:00:00Z') };
    const [l] = await stampedCargo(db, range, { kind: 'own', userId: a }, 'ltl');
    const [f] = await stampedCargo(db, range, { kind: 'own', userId: a }, 'ftl');
    const [all] = await stampedCargo(db, range, { kind: 'own', userId: a }, 'all');
    expect(l!.m3).toBeCloseTo(4, 6);
    expect(f!.m3).toBeCloseTo(80, 6);
    expect(all!.m3).toBeCloseTo(84, 6);

    const [paid] = (await db.execute(sql`
      WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'stamped', sellerId: a, ...range, load: 'ltl' }), { landedOnly: false })}
      SELECT coalesce(sum(m3), 0)::text AS m3 FROM u_box`)) as unknown as { m3: string }[];
    expect(Number(paid!.m3)).toBeCloseTo(4, 6);
    expect(ltl.receiptId).toBeTruthy();
  });
});

describe('a prixod inherits its deal’s FTL — and only what the mark may reach', () => {
  it('a seller’s mark reaches his own stamp, never a colleague’s; a client correction is left out', async () => {
    const a = await mintUser('owner');
    const b = await mintUser('colleague');
    const client = await mintClient(a);
    const other = await mintClient(b);
    const deal = await mintDeal(client.id, a);
    const mine = await cargo({ clientId: client.id, sellerId: a, m3: 10, kg: 900, dealId: deal });
    const colleagues = await cargo({ clientId: client.id, sellerId: b, m3: 5, kg: 400, dealId: deal });
    const moved = await cargo({ clientId: client.id, sellerId: a, m3: 3, kg: 200, dealId: deal });
    // A client correction keeps deal_id (receipts/edit.ts) — the cascade must not follow it.
    await db.update(receipts).set({ clientId: other.id, salesManagerId: b }).where(eq(receipts.id, moved.receiptId));

    const result = await updateDeal(deal, { clientId: client.id, ownerId: a, load: { mode: 'ftl', door: seller(a) } }, ctx(a));
    expect(result.ftl?.changed).toBe(1);
    expect(await isFtl(mine.receiptId)).toBe(true);
    expect(await isFtl(colleagues.receiptId)).toBe(false);
    expect(await isFtl(moved.receiptId)).toBe(false);
    const why = new Map(result.ftl!.skipped.map((s) => [s.receiptId, s.why]));
    expect(why.get(colleagues.receiptId)).toBe('other_seller');
    expect(why.get(moved.receiptId)).toBe('other_client');

    // The office's mark reaches the colleague's cargo too (still not the moved one).
    await updateDeal(deal, { clientId: client.id, ownerId: a, load: { mode: 'ltl', door: office() } }, ctx());
    expect(await isFtl(mine.receiptId)).toBe(false);
    await updateDeal(deal, { clientId: client.id, ownerId: a, load: { mode: 'ftl', door: office() } }, ctx());
    expect(await isFtl(colleagues.receiptId)).toBe(true);
    expect(await isFtl(moved.receiptId)).toBe(false);
  });

  it('a re-file to an FTL deal upgrades; a re-file to an LTL deal or a detach never downgrades', async () => {
    const a = await mintUser('refile');
    const client = await mintClient(a);
    const ftlDeal = await mintDeal(client.id, a);
    const ltlDeal = await mintDeal(client.id, a);
    await setDealLoad(ftlDeal, 'ftl', office(), ctx());
    const r = await cargo({ clientId: client.id, sellerId: a, m3: 2, kg: 100 });

    await linkReceipt(r.receiptId, ftlDeal, ctx());
    expect(await isFtl(r.receiptId)).toBe(true);
    await linkReceipt(r.receiptId, ltlDeal, ctx(a));
    expect(await isFtl(r.receiptId)).toBe(true);
    await linkReceipt(r.receiptId, null, ctx(a));
    expect(await isFtl(r.receiptId)).toBe(true);
    // The office declares the source deal not FTL: what THAT deal gave goes back, wherever the prixod went.
    await setDealLoad(ftlDeal, 'ltl', office(), ctx());
    expect(await isFtl(r.receiptId)).toBe(false);
  });

  it('a hand-pinned prixod is left alone by the deal, and named', async () => {
    const a = await mintUser('pin');
    const client = await mintClient(a);
    const deal = await mintDeal(client.id, a);
    const r = await cargo({ clientId: client.id, sellerId: a, m3: 2, kg: 100, dealId: deal });
    await setReceiptLoad(r.receiptId, 'ftl', seller(a), ctx(a));
    await setReceiptLoad(r.receiptId, 'ltl', office(), ctx());
    expect(await modeOf(r.receiptId)).toEqual({ mode: 'ltl', hand: true });
    const { cascade } = await setDealLoad(deal, 'ftl', office(), ctx());
    expect(await isFtl(r.receiptId)).toBe(false);
    expect(cascade!.skipped.find((s) => s.receiptId === r.receiptId)?.why).toBe('hand');
  });
});

describe('the doors refuse in words (2a)', () => {
  it('a seller cannot take FTL back, cannot mark a colleague’s job, and cannot hand an FTL job on', async () => {
    const a = await mintUser('door-a');
    const b = await mintUser('door-b');
    const client = await mintClient(a);
    const deal = await mintDeal(client.id, a);
    const theirs = await mintDeal(client.id, b);

    await expect(
      updateDeal(theirs, { clientId: client.id, ownerId: b, load: { mode: 'ftl', door: seller(a) } }, ctx(a)),
    ).rejects.toMatchObject({ code: 'ftl_not_yours' });
    await updateDeal(deal, { clientId: client.id, ownerId: a, load: { mode: 'ftl', door: seller(a) } }, ctx(a));
    await expect(
      updateDeal(deal, { clientId: client.id, ownerId: a, load: { mode: 'ltl', door: seller(a) } }, ctx(a)),
    ).rejects.toMatchObject({ code: 'ftl_office_only' });
    // Handing the FTL job to a colleague in an ordinary save — with or without a door.
    await expect(
      updateDeal(deal, { clientId: client.id, ownerId: b, load: { mode: 'ftl', door: seller(a) } }, ctx(a)),
    ).rejects.toMatchObject({ code: 'ftl_office_only' });
    await expect(updateDeal(deal, { clientId: client.id, ownerId: b }, ctx(a))).rejects.toBeInstanceOf(DealError);
    // A save that carries no mode leaves FTL as it is (absent = unchanged, never «LTL»).
    await updateDeal(deal, { clientId: client.id, ownerId: a, title: 'yangi nom' }, ctx(a));
    expect((await db.execute(sql`SELECT 1 FROM deal_ftl WHERE deal_id = ${deal}::uuid`)).length).toBe(1);
    // The office may do all of it.
    await updateDeal(deal, { clientId: client.id, ownerId: b, load: { mode: 'ltl', door: office() } }, ctx());
  });

  it('a deal is created FTL only for its own owner by a seller', async () => {
    const a = await mintUser('create-a');
    const b = await mintUser('create-b');
    const client = await mintClient(b);
    await expect(
      createDeal({ clientId: client.id, ownerId: b, load: { mode: 'ftl', door: seller(a) } }, ctx(a)),
    ).rejects.toMatchObject({ code: 'ftl_not_yours' });
    const id = await createDeal({ clientId: client.id, ownerId: a, load: { mode: 'ftl', door: seller(a) } }, ctx(a));
    madeDeals.push(id);
    expect((await db.execute(sql`SELECT by_office FROM deal_ftl WHERE deal_id = ${id}::uuid`))[0]).toEqual({ by_office: false });
  });

  it('on the prixod card a seller may only write FTL, only on his own stamp', async () => {
    const a = await mintUser('card-a');
    const b = await mintUser('card-b');
    const client = await mintClient(a);
    const r = await cargo({ clientId: client.id, sellerId: b, m3: 1, kg: 50 });
    await expect(setReceiptLoad(r.receiptId, 'ftl', seller(a), ctx(a))).rejects.toMatchObject({ code: 'ftl_not_yours' });
    // An LTL write by a seller is refused whatever the current mode — it would pin his cargo against the office.
    const own = await cargo({ clientId: client.id, sellerId: a, m3: 1, kg: 50 });
    await expect(setReceiptLoad(own.receiptId, 'ltl', seller(a), ctx(a))).rejects.toMatchObject({ code: 'ftl_office_only' });
    expect(await modeOf(own.receiptId)).toBeNull();
  });

  it('leads: a seller marks his own; an FTL lead is not handed on in bulk without the office', async () => {
    const a = await mintUser('lead-a');
    const b = await mintUser('lead-b');
    const lead = await createLead({ name: `FTL lid ${S}`, ownerId: a, load: { mode: 'ftl', door: seller(a) } }, ctx(a));
    madeLeads.push(lead.id);
    await expect(setLeadOwner(lead.id, b, ctx(a), seller(a))).rejects.toBeInstanceOf(CrmError);
    await expect(
      updateLead(lead.id, { name: lead.name, ownerId: a, load: { mode: 'ltl', door: seller(a) } }, ctx(a)),
    ).rejects.toMatchObject({ code: 'ftl_office_only' });
    await setLeadOwner(lead.id, b, ctx(), office());
  });
});

describe('a PAID month is frozen (6a)', () => {
  it('the card refuses in words, the deal skips and names it, and voiding the payout lifts it', async () => {
    const a = await mintUser('paid');
    const client = await mintClient(a);
    const deal = await mintDeal(client.id, a);
    const sept = await cargo({ clientId: client.id, sellerId: a, day: '2026-09-15', m3: 6, kg: 500, dealId: deal });
    const old = await cargo({ clientId: client.id, sellerId: a, day: '2025-06-15', m3: 6, kg: 500 });
    const expenseId = await payout(a, '2026-09');

    const refused = await setReceiptLoad(sept.receiptId, 'ftl', office(), ctx()).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(FtlError);
    expect(refused).toMatchObject({ code: 'kpi_paid', detail: { month: '2026-09' } });
    // A month before the first KPI table carries no KPI money: never frozen.
    await setReceiptLoad(old.receiptId, 'ftl', office(), ctx());
    expect(await isFtl(old.receiptId)).toBe(true);

    const { cascade } = await setDealLoad(deal, 'ftl', office(), ctx());
    expect(await isFtl(sept.receiptId)).toBe(false);
    expect(cascade!.skipped.find((s) => s.receiptId === sept.receiptId)?.why).toBe('kpi_paid');
    expect((await receiptLoadView(sept.receiptId))?.paid?.month).toBe('2026-09');

    await db.update(expenses).set({ voidedAt: new Date() } as never).where(eq(expenses.id, expenseId));
    await setReceiptLoad(sept.receiptId, 'ftl', office(), ctx());
    expect(await isFtl(sept.receiptId)).toBe(true);
  });
});

describe('the rating (3b) and the won post (4a)', () => {
  it('FTL is off the ranking and on its own line, and its seller is not idle', async () => {
    const a = await mintUser('rating-ftl');
    const b = await mintUser('rating-ltl');
    const client = await mintClient(a);
    const ftl = await cargo({ clientId: client.id, sellerId: a, day: '1663-03-10', m3: 82, kg: 9500 });
    await cargo({ clientId: client.id, sellerId: b, day: '1663-03-11', m3: 7, kg: 900 });
    await setReceiptLoad(ftl.receiptId, 'ftl', office(), ctx());
    const { view } = await ratingViewFor(window1663, { withHistory: false });
    expect(view.rows.map((r) => r.userId)).toContain(b);
    expect(view.rows.map((r) => r.userId)).not.toContain(a);
    expect(view.ftl.find((f) => f.userId === a)?.m3).toBeCloseTo(82, 6);
    expect(view.team.m3).toBeCloseTo(view.rows.reduce((t, r) => t + r.m3, 0), 6);
  });

  it('an FTL win is labelled and carries no month line; LTL wins count LTL only', async () => {
    const a = await mintUser('won');
    const [won] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'won')).limit(1);
    const mk = async (ftl: boolean) => {
      const lead = await createLead(
        { name: `FTL g'alaba ${S}`, ownerId: a, ...(ftl ? { load: { mode: 'ftl' as const, door: seller(a) } } : {}) },
        ctx(a),
      );
      madeLeads.push(lead.id);
      await db.update(leads).set({ stageId: won!.id, closedAt: new Date() }).where(eq(leads.id, lead.id));
      return lead.id;
    };
    const ftlLead = await mk(true);
    await celebrateLeadWon({ payload: { stageKind: 'won', leadId: ftlLead }, actorId: a });
    const ltlLead = await mk(false);
    await celebrateLeadWon({ payload: { stageKind: 'won', leadId: ltlLead }, actorId: a });
    const html = async (leadId: string) =>
      (await db.select({ html: staffGroupPosts.html }).from(staffGroupPosts).where(eq(staffGroupPosts.dedupeKey, `won:${leadId}`)))[0]
        ?.html ?? '';
    expect(await html(ftlLead)).toContain('🚛 <b>FTL</b> — butun mashina');
    expect(await html(ftlLead)).not.toContain('Bu oy');
    // The FTL win before it is not this month's first LTL win's company.
    expect(await html(ltlLead)).toContain("Bu oyning birinchi g'alabasi!");
  });
});

describe('the logist’s hint at departure (7a)', () => {
  async function truck(origin: string, dest: string, receiptIds: string[]) {
    const [b] = await db
      .insert(batches)
      .values({ code: `FTL${S}${next()}`, originWarehouseId: origin, destWarehouseId: dest, type: 'transfer', status: 'loading', createdBy: actorId })
      .returning();
    madeBatches.push(b!.id);
    await db.execute(sql`
      UPDATE boxes SET status = 'loading', current_batch_id = ${b!.id}::uuid, current_warehouse_id = ${origin}::uuid
       WHERE lot_id IN (SELECT id FROM receipt_lots WHERE receipt_id IN (${sql.join(receiptIds.map((id) => sql`${id}::uuid`), sql`, `)}))`);
    return b!;
  }
  const hints = async (code: string) =>
    (await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'FtlSuspected'), sql`${notifications.payload}->>'text' LIKE ${`%${code}%`}`))) as {
      payload: { text: string; receiptIds: string[] };
    }[];

  it('one client fills the truck: the logists hear it once; the next leg of the same cargo stays quiet', async () => {
    const logist = await mintUser('logist');
    await db.execute(sql`
      INSERT INTO user_roles (user_id, role_id) SELECT ${logist}::uuid, id FROM roles WHERE code = 'logist'`);
    const a = await mintUser('hint');
    const client = await mintClient(a);
    const r1 = await cargo({ clientId: client.id, sellerId: a, m3: 40, kg: 4000, boxes: 2 });
    const r2 = await cargo({ clientId: client.id, sellerId: a, m3: 42, kg: 4100, boxes: 2 });
    const [yw] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'YW'));
    const [ka] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'KA'));
    // Yiwu → Kashgar is CN → CN, and it is the truck a whole-truck job leaves China on.
    const first = await truck(yw!.id, ka!.id, [r1.receiptId, r2.receiptId]);
    await departBatch(first.id, ctx());
    const said = await hints(first.code);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]!.payload.text).toContain("FTL bo'lishi mumkin");
    expect(said[0]!.payload.text).toContain(client.code);
    expect(new Set(said[0]!.payload.receiptIds)).toEqual(new Set([r1.receiptId, r2.receiptId]));

    // The same cargo's next leg names nothing new.
    await db.execute(sql`
      UPDATE boxes SET status = 'in_stock', current_warehouse_id = ${ka!.id}::uuid, current_batch_id = NULL
       WHERE lot_id IN (SELECT id FROM receipt_lots WHERE receipt_id IN (${r1.receiptId}::uuid, ${r2.receiptId}::uuid))`);
    const [tas] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'TAS1'));
    const second = await truck(ka!.id, tas!.id, [r1.receiptId, r2.receiptId]);
    await departBatch(second.id, ctx());
    expect(await hints(second.code)).toHaveLength(0);
  });

  it('two clients on one truck, or a truck already FTL: silence', async () => {
    const a = await mintUser('mixed');
    const one = await mintClient(a);
    const two = await mintClient(a);
    const r1 = await cargo({ clientId: one.id, sellerId: a, m3: 5, kg: 500 });
    const r2 = await cargo({ clientId: two.id, sellerId: a, m3: 5, kg: 500 });
    const [yw] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'YW'));
    const [tas] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'TAS1'));
    const mixed = await truck(yw!.id, tas!.id, [r1.receiptId, r2.receiptId]);
    await departBatch(mixed.id, ctx());
    expect(await hints(mixed.code)).toHaveLength(0);

    const r3 = await cargo({ clientId: one.id, sellerId: a, m3: 80, kg: 8000 });
    await setReceiptLoad(r3.receiptId, 'ftl', office(), ctx());
    const marked = await truck(yw!.id, tas!.id, [r3.receiptId]);
    await departBatch(marked.id, ctx());
    expect(await hints(marked.code)).toHaveLength(0);
  });

  it('one person under two codes (a shared phone) is one owner', async () => {
    const a = await mintUser('phones');
    // A run-scoped number: a fixed one would match another file's client
    // book (telegram-live's +998901112233 did, and picked this file's client).
    const phone = `9${S}${next()}`.slice(0, 9);
    const one = await mintClient(a, [`+998 ${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5, 7)} ${phone.slice(7)}`]);
    const two = await mintClient(a, [phone]);
    const r1 = await cargo({ clientId: one.id, sellerId: a, m3: 30, kg: 3000 });
    const r2 = await cargo({ clientId: two.id, sellerId: a, m3: 30, kg: 3000 });
    const [yw] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'YW'));
    const [tas] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'TAS1'));
    const t = await truck(yw!.id, tas!.id, [r1.receiptId, r2.receiptId]);
    await departBatch(t.id, ctx());
    expect((await hints(t.code)).length).toBeGreaterThan(0);
  });
});
