import 'dotenv/config';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  clients,
  clientTransactions,
  expenseRequests,
  leads,
  leadStages,
  notifications,
  partners,
  partnerTransactions,
  partnerTypes,
  receiptLots,
  receipts,
  roles,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { actorGrants } from '@/modules/platform/rbac/authorize';
import { holatFor, HOLAT, ownerSummaryFromBot } from '@/modules/platform/telegram/staff-bot';
import { replyKeyboardFor } from '@/modules/platform/telegram/keyboards';
import { cashFlow, companyBalanceParts, profitAndLoss } from '@/modules/wms/accounting/reports';
import { openExpenseRequests, openExpenseRequestTotals } from '@/modules/wms/accounting/expense-requests';
import { clientMoneyInPeriod } from '@/modules/wms/finance/service';
import { intakeByDay } from '@/modules/wms/reports/business';
import { loadLeadFlow, scopeKeyOf } from '@/modules/wms/reports/dashboard';
import { dashboardWindows, pnlParts, rankAttention } from '@/modules/wms/reports/dashboard-math';
import { attentionFacts, attentionGates } from '@/modules/wms/reports/attention';
import { readAttentionSources } from '@/modules/wms/reports/attention-sources';
import { truckMoves } from '@/modules/wms/reports/overview';
import { composeOwnerSummary } from '@/modules/wms/reports/owner-summary';
import { ownerSummarySight } from '@/modules/wms/reports/owner-summary-door';
import { OWNER_SUMMARY_TYPE, sendOwnerSummaries } from '@/modules/wms/reports/owner-summary-jobs';
import { reportBaseIds } from '@/modules/wms/reports/report-scope';

/**
 * The owner's evening summary (answer 7a), against a real database.
 *
 * Every figure the message prints is checked two ways: against the report
 * function the dashboard prints it from, over the same window (#513), AND
 * against LITERALS this file typed (#1116) — a payment of $123.45, one prixod
 * of 4 boxes / 1.25 m³ / 250.5 kg, one truck that left, one lead — because an
 * agreement between two readers of one rule proves nothing about the rule.
 *
 * Everything parks in 1677 (this package's private year, grep before
 * reusing). Pre-1924 Postgres answers `Asia/Tashkent` with LMT +04:37, so no
 * fixture sits in 19:00-19:23 UTC (business.ts's own warning). The pinned
 * moments are mid-day UTC, which is the same Tashkent day under LMT or +05.
 * Cleanup is the LAST test, never an afterAll that can silently do nothing
 * (#183); nothing here edits a shared role's grants (judge 8b — that half is
 * the unit test's, over hand-built actors).
 */

const STAMP = `${Date.now()}`.slice(-7);
/** A Tuesday: the daily shape. */
const DAY = '1677-06-15';
/** Another Tuesday, where nothing happens. */
const QUIET = '1677-06-22';
/** A Monday: the weekly shape, over 14-20 Sep. */
const MONDAY = '1677-09-20';
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`);

let ownerId = '';
let actorId = '';
let whId = '';
let clientId = '';
let receiptId = '';
let batchId = '';
let leadId = '';
let partnerId = '';
const PARTNER = `Kechki firma ${STAMP}`;
/** Test people: a muted super_admin (also the bot's owner chat), a deactivated one, an admin, an accountant. */
const people: Record<'muted' | 'gone' | 'admin' | 'accountant', string> = { muted: '', gone: '', admin: '', accountant: '' };
const CHAT_OWNER = BigInt(`77${STAMP}01`);
const CHAT_ACC = BigInt(`77${STAMP}02`);
const CHAT_NOBODY = BigInt(`77${STAMP}03`);

async function person(tag: string, role: string, over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({ phone: `+99877${STAMP}${tag.length}${tag.charCodeAt(0)}`, fullName: `kx ${tag} ${STAMP}`, passwordHash: 'x', ...over })
    .returning({ id: users.id });
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, role));
  await db.insert(userRoles).values({ userId: row!.id, roleId: r!.id });
  return row!.id;
}

const rowsFor = (day: string) =>
  db
    .select({ userId: notifications.userId, status: notifications.status, payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, OWNER_SUMMARY_TYPE), sql`${notifications.payload}->>'day' = ${day}`));

beforeAll(async () => {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, 'super_admin'), eq(users.active, true), eq(users.phone, '+998900000001')));
  ownerId = owner!.id;
  actorId = ownerId;

  people.muted = await person('muted', 'super_admin', { mutedNotificationTypes: ['OwnerSummary'] });
  people.gone = await person('gone', 'super_admin', { active: false });
  people.admin = await person('admin', 'admin');
  people.accountant = await person('acc', 'accountant');
  await db.insert(telegramLinks).values([
    { userId: people.muted, telegramChatId: CHAT_OWNER, status: 'linked', linkedAt: new Date() },
    { userId: people.accountant, telegramChatId: CHAT_ACC, status: 'linked', linkedAt: new Date() },
  ]);

  const [wh] = await db
    .insert(warehouses)
    .values({
      name: `Kechki ${STAMP}`,
      code: `KX${STAMP}`,
      batchPrefix: `KX${STAMP}`,
      country: 'CN',
      type: 'origin',
      timezone: 'Asia/Shanghai',
    })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  const [dest] = await db
    .insert(warehouses)
    .values({
      name: `Kechki UZ ${STAMP}`,
      code: `KY${STAMP}`,
      batchPrefix: `KY${STAMP}`,
      country: 'UZ',
      type: 'distribution',
      timezone: 'Asia/Tashkent',
    })
    .returning({ id: warehouses.id });

  // One prixod: 4 boxes, 1.25 m³, 250.5 kg — 08:00 UTC is the same day in Tashkent.
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: whId, status: 'confirmed', createdBy: actorId, receivedAt: at(DAY, '08:00') })
    .returning({ id: receipts.id });
  receiptId = receipt!.id;
  await db.insert(receiptLots).values({
    receiptId,
    seq: 1,
    productNameZh: `货${STAMP}`,
    boxCount: 4,
    dimsMode: 'mixed',
    totalWeightKg: '250.5',
    totalVolumeM3: '1.25',
  });

  // One truck that left that day (closed: it is on nobody's road now).
  const [batch] = await db
    .insert(batches)
    .values({
      code: `KX${STAMP}-001`,
      originWarehouseId: whId,
      destWarehouseId: dest!.id,
      status: 'closed',
      departedAt: at(DAY, '09:00'),
      arrivedAt: at('1677-07-01', '09:00'),
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  batchId = batch!.id;

  // One lead that arrived that day.
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).limit(1);
  const [lead] = await db
    .insert(leads)
    .values({ name: `kx lead ${STAMP}`, stageId: stage!.id, createdBy: actorId, createdAt: at(DAY, '10:00') })
    .returning({ id: leads.id });
  leadId = lead!.id;

  // One client payment of $123.45 that day (no kassa named: history-shaped).
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `KX${STAMP}`, name: `kx client ${STAMP}` })
    .returning({ id: clients.id });
  clientId = client!.id;
  await db.insert(clientTransactions).values({
    clientId,
    type: 'payment',
    amount: '123.45',
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: '123.45',
    txDate: DAY,
    createdBy: actorId,
  });

  // A firm we owe, due within the Monday's four weeks: charged 17 Sep, paid
  // within 10 days → due 27 Sep.
  const [type] = await db.select({ id: partnerTypes.id }).from(partnerTypes).limit(1);
  const [partner] = await db
    .insert(partners)
    .values({ name: PARTNER, typeId: type!.id, createdBy: actorId, payWithinDays: 10 })
    .returning({ id: partners.id });
  partnerId = partner!.id;
  await db.insert(partnerTransactions).values({
    partnerId,
    type: 'charge',
    amount: '777.00',
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: '777.00',
    txDate: '1677-09-17',
    createdBy: actorId,
  });

  // …and $10.00 of the same client's debt settled into that firm's account
  // the same day (a three-cornered settlement, round 39): money the CLIENT
  // closed, never a till of ours. «Mijozlar to'lagan (sof)» counts it — the
  // homes' own figure (U26, judge 2) — and the kassa's «kirim» does not.
  await db.insert(clientTransactions).values({
    clientId,
    type: 'payment',
    amount: '10.00',
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: '10.00',
    txDate: DAY,
    partnerId,
    createdBy: actorId,
  });
});

afterAll(async () => {
  await pgClient.end();
});

async function ownerActor() {
  return { id: ownerId, ...(await actorGrants(ownerId)) };
}

describe('every figure is the dashboard’s own, over the same window (#513)', () => {
  it('the daily message agrees with the report functions and with the literals', async () => {
    const actor = await ownerActor();
    const sight = ownerSummarySight(actor);
    expect(sight, 'the demo owner reads the company’s money').not.toBeNull();
    const now = at(DAY, '12:00');
    const summary = await composeOwnerSummary(actor, sight!, now);
    const f = summary.facts;
    expect(summary.day).toBe(DAY);
    expect(summary.window).toBe('bugun');
    expect([f.from, f.to]).toEqual([DAY, DAY]);

    // The destination functions, over the same window.
    const [pnl, flow, collected, intake, moves, balance, leadFlow] = await Promise.all([
      profitAndLoss(DAY, DAY),
      cashFlow(DAY, DAY),
      clientMoneyInPeriod(DAY, DAY),
      intakeByDay(DAY, DAY, undefined),
      truckMoves(DAY, DAY, undefined),
      companyBalanceParts(),
      loadLeadFlow(DAY, DAY),
    ]);
    expect(f.revenueUsd).toBe(pnlParts(pnl, 'total').revenue);
    expect(f.collectedUsd).toBe(collected.netCollected);
    expect(f.cash.inUsd).toBe(flow.inflow);
    expect(f.cash.outUsd).toBe(flow.outflow);
    expect(f.tills.usd).toBe(balance.cashUsd);
    expect(f.tills.count).toBe(balance.cashRows.length);
    expect(f.intake).toEqual(intake.total);
    expect([f.trucks.departed, f.trucks.arrived]).toEqual([moves.departed, moves.arrived]);
    expect(f.leads).toEqual({ fresh: leadFlow.fresh, won: leadFlow.won, wonUsd: leadFlow.wonUsd, wonOther: leadFlow.wonOther });

    // …and the literals this file typed (#1116): the settlement into a firm's
    // account is the client's money closed, never cash in a till.
    expect(f.collectedUsd).toBe(133.45);
    expect(f.cash.inUsd).toBe(123.45);
    expect(f.intake).toEqual({ receipts: 1, boxes: 4, m3: 1.25, kg: 250.5 });
    expect(f.trucks.departed).toBe(1);
    expect(f.leads?.fresh).toBe(1);
    const text = summary.text.replace(/ /g, ' ');
    expect(text.split('\n')[0]).toBe('📊 GSR — kun xulosasi, 15.06 (soat 17:00)');
    expect(text).toContain('💵 Mijozlar to‘lagan (sof): $133.45');
    expect(text).toContain('🏦 Kassa: kirim $123.45');
    expect(text).toContain('📦 Prixod: 1 ta · 4 karobka · 1.25 m³ · 250.5 kg');
    expect(text).toContain('🚚 Jo‘nadi: 1 · Keldi: 0');
    expect(text).toContain('👥 Yangi lid: 1 · Yutildi: 0');
    expect(text.endsWith('/dashboard?davr=bugun')).toBe(true);
    expect(summary.quiet).toBe(false);
  });

  it('the attention rows are the dashboard list’s own top three', async () => {
    const actor = await ownerActor();
    const sight = ownerSummarySight(actor)!;
    const now = at(DAY, '12:00');
    const summary = await composeOwnerSummary(actor, sight, now);
    const baseIds = reportBaseIds(actor);
    const gates = attentionGates(actor.permissions, { sight, scoped: baseIds !== undefined, company: false });
    const sources = await readAttentionSources(gates, scopeKeyOf(baseIds), now);
    const ranked = rankAttention(attentionFacts(gates, sources, dashboardWindows(DAY)), 3);
    expect(summary.facts.attention.top.map((fact) => fact.kind)).toEqual(ranked.visible.map((fact) => fact.kind));
    expect(summary.facts.attention.total).toBe(ranked.visibleCount);
  });

  it('Monday is the week, and names what must be paid over the next four weeks', async () => {
    const actor = await ownerActor();
    const summary = await composeOwnerSummary(actor, ownerSummarySight(actor)!, at(MONDAY, '12:00'));
    expect(summary.window).toBe('7');
    expect([summary.facts.from, summary.facts.to]).toEqual(['1677-09-14', MONDAY]);
    const text = summary.text.replace(/ /g, ' ');
    expect(text.split('\n')[0]).toBe('📊 GSR — hafta xulosasi, 14.09–20.09 (soat 17:00)');
    expect(text).toContain('📅 Keyingi 4 hafta to‘lovlari (21.09–18.10):');
    expect(text).toContain(`• 27.09 — ${PARTNER}: $777.00`);
    expect(text.endsWith('/dashboard?davr=7')).toBe(true);
    // Nothing moved that week — only the payment makes it worth sending.
    expect(summary.facts.revenueUsd).toBe(0);
    expect(summary.quiet).toBe(false);
  });
});

describe('who receives it, and how often', () => {
  it('the owner and the muted super_admin get a row; the admin and the deactivated one none', async () => {
    const run = await sendOwnerSummaries(at(DAY, '15:00'));
    expect(run.failed).toBe(0);
    const rows = await rowsFor(DAY);
    const mine = (userId: string) => rows.filter((row) => row.userId === userId);
    expect(mine(ownerId).map((row) => row.status)).toEqual(['pending']);
    // Their own switch: kept as the record, never sent.
    expect(mine(people.muted).map((row) => row.status)).toEqual(['muted']);
    expect(mine(people.gone)).toEqual([]);
    expect(mine(people.admin)).toEqual([]);
    expect(mine(people.accountant)).toEqual([]);
    const payload = mine(ownerId)[0]!.payload as { text: string; day: string; window: string };
    expect(Object.keys(payload).sort()).toEqual(['day', 'text', 'window']);
    expect(payload.window).toBe('bugun');
    expect(payload.text).toContain('Mijozlar to‘lagan (sof)');
  });

  it('twice in one day is still one row each — the retry is safe (#727)', async () => {
    const before = (await rowsFor(DAY)).length;
    const again = await sendOwnerSummaries(at(DAY, '15:05'));
    expect(again.queued).toBe(0);
    expect((await rowsFor(DAY)).length).toBe(before);
    expect((await rowsFor(DAY)).filter((row) => row.userId === ownerId)).toHaveLength(1);
  });

  it('a day when nothing moved sends nothing', async () => {
    const run = await sendOwnerSummaries(at(QUIET, '15:00'));
    expect(run.queued).toBe(0);
    expect(await rowsFor(QUIET)).toEqual([]);
  });

  it('a quiet Monday with a payment coming due does send', async () => {
    await sendOwnerSummaries(at(MONDAY, '15:00'));
    const rows = (await rowsFor(MONDAY)).filter((row) => row.userId === ownerId);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { text: string }).text).toContain(PARTNER);
  });
});

describe('«📊 Holat» in the staff bot', () => {
  it('the owner’s chat: the button, and the text', async () => {
    expect(await holatFor(CHAT_OWNER)).toBe(true);
    const keyboard = (await replyKeyboardFor(CHAT_OWNER)) as { keyboard: { text: string }[][] };
    expect(keyboard.keyboard.flat().map((b) => b.text)).toContain(HOLAT);
    const outcome = await ownerSummaryFromBot(CHAT_OWNER);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.text).toMatch(/^📊 GSR — (kun|hafta) xulosasi/);
  });

  it('the accountant reads the money on the screens, and is still not offered this', async () => {
    expect(await holatFor(CHAT_ACC)).toBe(false);
    const keyboard = (await replyKeyboardFor(CHAT_ACC)) as { keyboard: { text: string }[][] };
    expect(keyboard.keyboard.flat().map((b) => b.text)).not.toContain(HOLAT);
    expect(await ownerSummaryFromBot(CHAT_ACC)).toEqual({ status: 'refused' });
  });

  it('a chat nobody linked is nobody', async () => {
    expect(await holatFor(CHAT_NOBODY)).toBe(false);
    expect(await ownerSummaryFromBot(CHAT_NOBODY)).toEqual({ status: 'not_linked' });
  });
});

describe('the rasxod queue as totals (judge 4, U10’s shape)', () => {
  it('101 open requests total 101 — the screen’s list stops at a hundred, the total does not', async () => {
    const before = await openExpenseRequestTotals();
    await db.insert(expenseRequests).values(
      Array.from({ length: 101 }, (_, i) => ({
        amount: '1.00',
        currency: 'USD',
        note: `kx ${STAMP} ${i}`,
        createdBy: people.admin,
        paidBySelf: i === 0,
      })),
    );
    const after = await openExpenseRequestTotals();
    expect(after.count - before.count).toBe(101);
    expect(after.ownPocket.count - before.ownPocket.count).toBe(1);
    expect((await openExpenseRequests()).length).toBeLessThanOrEqual(100);
  });
});

describe('cleanup (the last test, #183)', () => {
  it('removes everything this file made', async () => {
    await db.delete(notifications).where(
      and(
        eq(notifications.type, OWNER_SUMMARY_TYPE),
        inArray(sql`${notifications.payload}->>'day'`, [DAY, QUIET, MONDAY]),
      ),
    );
    await db.delete(expenseRequests).where(like(expenseRequests.note, `kx ${STAMP} %`));
    await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partnerId));
    await db.update(partners).set({ active: false, payWithinDays: null }).where(eq(partners.id, partnerId));
    await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(leads).where(eq(leads.id, leadId));
    await db.delete(batches).where(eq(batches.id, batchId));
    await db.delete(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.update(warehouses).set({ active: false }).where(like(warehouses.code, `K_${STAMP}`));
    const ids = Object.values(people);
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, ids));
    await db.delete(userRoles).where(inArray(userRoles.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
    expect(await rowsFor(DAY)).toEqual([]);
    expect((await db.select().from(users).where(inArray(users.id, ids))).length).toBe(0);
  });
});
