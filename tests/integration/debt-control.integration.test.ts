import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clients,
  clientTransactions,
  dealStages,
  deals,
  events,
  handovers,
  issueApprovals,
  moneyAccounts,
  notifications,
  paymentPromises,
  permissions,
  rolePermissions,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';
import { decideApprovalFromBot, linkStaffChat } from '@/modules/platform/telegram/staff-bot';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { issueBoxes } from '@/modules/wms/issue/service';
import {
  approvalRecipients,
  decideIssueApproval,
  pendingApprovals,
  requestIssueApproval,
} from '@/modules/wms/issue/approvals';
import { deferPayment } from '@/modules/wms/deals/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { debtReleases, releasePartsSql, wentOutOnDebtSql, type DebtReleaseFilter } from '@/modules/wms/debt/releases';
import {
  cancelPromise,
  clientPromises,
  PROMISE_TASK_TITLE,
  promisesDueBetween,
  recordPromise,
  sweepPromises,
} from '@/modules/wms/debt/promises';
import { promiseBrokenAt } from '@/modules/wms/debt/rules';
import { companyMoneySight, type MoneyActor } from '@/modules/wms/finance/scope';
import type { ScopedActor } from '@/modules/platform/rbac/scope';
import { deleteDebtReleasedFor } from '../fixtures/debt-released';

/**
 * Qarz nazorati (0114) against a real database: who may let a debt slide
 * (the owner's 2a — a seller his own clients, the admin and the accountant
 * everybody's), the register of what went out on debt and what came back,
 * and the payment promise judged by the ledger alone.
 *
 * Every audited fixture user is DEACTIVATED in cleanup, never deleted
 * (audit_log's FK); the warehouse is deactivated so later pickers do not
 * inherit it (#183); the promises, their tasks and their pings are removed.
 */

const STAMP = String(Date.now()).slice(-7);
let seq = 0;
const next = () => (seq += 1);

let whId: string;
/** A second counter the scoped warehouse manager does NOT stand at (D3a). */
let whB: string;
let accountId: string;
const people: string[] = [];
const clientIds: string[] = [];
const chats: bigint[] = [];

/** Whose money he reads and which ROLE he holds — what `counterDebtRelease` asks besides where. */
type Releaser = MoneyActor & { roles: readonly string[] };
interface Person {
  id: string;
  name: string;
  actor: Releaser;
}
let S1: Person; // seller who owns C1
let S2: Person; // another seller
let W: Person; // warehouse manager (the grant, no ledger) — UNSCOPED in his actor here
let A: Person; // accountant
let SA: Person; // super_admin — the owner, D6a's audience beside the accountant
let WM: Person; // warehouse manager standing at whId (D2's person)
let OP: Person; // warehouse operator at whId

const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });
const ALL: DebtReleaseFilter = { from: null, to: null, approverId: null, includeReturned: true };
const sight = companyMoneySight({ id: 'x', permissions: new Set(['finance.manage', 'finance.reports']) })!;

/** The person's grants as the DATABASE holds them — what the bot and the ping read. */
async function grantsOf(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));
  return new Set(rows.map((r) => r.code));
}

async function mkUser(role: string, label: string): Promise<Person> {
  const n = next();
  const name = `Qarz ${label} ${STAMP}-${n}`;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99897${String(Number(STAMP) * 10 + n).slice(-7)}`,
      fullName: name,
      passwordHash: 'x',
      locale: 'uz',
      active: true,
    })
    .returning({ id: users.id });
  people.push(user!.id);
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, role));
  await db.insert(userRoles).values({ userId: user!.id, roleId: r!.id });
  return { id: user!.id, name, actor: { id: user!.id, permissions: await grantsOf(user!.id), roles: [role] } };
}

/** The person at THIS counter, scoped like the session `Actor` (and the `user_warehouses` row agrees). */
const at = (person: Person, ...warehouseIds: string[]): Releaser & ScopedActor => ({
  ...person.actor,
  warehouseScoped: true,
  warehouseIds,
});

async function mkClient(sellerId: string | null): Promise<{ id: string; code: string }> {
  const code = `QZ${STAMP}${next()}`.slice(0, 12);
  const [c] = await db
    .insert(clients)
    .values({ clientCode: code, name: `Qarz mijoz ${code}`, salesManagerId: sellerId })
    .returning({ id: clients.id });
  clientIds.push(c!.id);
  return { id: c!.id, code };
}

async function ledger(
  clientId: string,
  type: 'charge' | 'payment' | 'refund',
  usd: number,
  opts: { createdAt?: Date; dealId?: string; currency?: string; amount?: number; voided?: boolean } = {},
): Promise<string> {
  const [row] = await db
    .insert(clientTransactions)
    .values({
      clientId,
      type,
      amount: String(opts.amount ?? usd),
      currency: opts.currency ?? 'USD',
      rateToUsd: opts.amount ? String(usd / opts.amount) : '1',
      amountUsd: String(usd),
      txDate: tashkentDay(),
      dealId: opts.dealId ?? null,
      accountId: type === 'refund' ? accountId : null,
      createdBy: A.id,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.voided ? { voidedAt: new Date(), voidedBy: A.id, voidReason: 'test' } : {}),
    })
    .returning({ id: clientTransactions.id });
  return row!.id;
}

async function box(clientId: string, warehouseId: string = whId): Promise<string> {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `qarztest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: A.id,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '欠款货',
          boxCount: 1,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(A.id),
  );
  return (await db.select().from(boxes).where(eq(boxes.lotId, lotId)))[0]!.id;
}

async function issue(
  clientId: string,
  by: Releaser & Partial<ScopedActor>,
  opts: { debtOk?: boolean; debtNote?: string; handoverId?: string; boxId?: string; warehouseId?: string } = {},
) {
  const warehouseId = opts.warehouseId ?? whId;
  return issueBoxes(
    {
      handoverId: opts.handoverId ?? uuidv4(),
      clientId,
      warehouseId,
      boxIds: [opts.boxId ?? (await box(clientId, warehouseId))],
      personName: 'Qarzdor Vakili',
      personPhone: '+998901234567',
      debtOk: opts.debtOk ?? false,
      debtNote: opts.debtNote ?? '',
      note: '',
    },
    ctx(by.id),
    // An actor with no scope of its own is the office's — unscoped (the
    // whole-ledger readers, and the warehouse manager W who is NOT at a counter).
    { warehouseScoped: false, warehouseIds: [], ...by },
  );
}

/** «Qarzga yuk berildi» rows about one handover, by recipient (0126, D6a). */
async function releasedTold(handoverId: string) {
  return db
    .select({ userId: notifications.userId, text: sql<string>`${notifications.payload}->>'text'` })
    .from(notifications)
    .where(and(eq(notifications.type, 'DebtReleased'), sql`${notifications.payload}->>'handoverId' = ${handoverId}`));
}

async function mkDeal(clientId: string): Promise<string> {
  const [stage] = await db.select({ id: dealStages.id }).from(dealStages).limit(1);
  const [deal] = await db
    .insert(deals)
    .values({ code: `QZD${STAMP}${next()}`, clientId, stageId: stage!.id, title: 'Qarz bitim', createdBy: A.id })
    .returning({ id: deals.id });
  return deal!.id;
}

const rowsFor = async (clientId: string, filter: DebtReleaseFilter = ALL) =>
  (await debtReleases(sight, filter)).rows.filter((row) => row.clientId === clientId);

beforeAll(async () => {
  S1 = await mkUser('sales_manager', 'S1');
  S2 = await mkUser('sales_manager', 'S2');
  W = await mkUser('warehouse_manager', 'W');
  A = await mkUser('accountant', 'A');
  SA = await mkUser('super_admin', 'SA');
  WM = await mkUser('warehouse_manager', 'WM');
  OP = await mkUser('warehouse_operator', 'OP');
  const [wh] = await db
    .insert(warehouses)
    .values({
      code: `QZ${STAMP}`.slice(0, 8),
      name: `Qarz WH ${STAMP}`,
      country: 'UZ',
      type: 'origin',
      timezone: 'Asia/Tashkent',
      batchPrefix: `QZ${STAMP}`.slice(0, 8),
    })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  const [second] = await db
    .insert(warehouses)
    .values({
      code: `QB${STAMP}`.slice(0, 8),
      name: `Qarz WH B ${STAMP}`,
      country: 'UZ',
      type: 'origin',
      timezone: 'Asia/Tashkent',
      batchPrefix: `QB${STAMP}`.slice(0, 8),
    })
    .returning({ id: warehouses.id });
  whB = second!.id;
  // The scoped people stand at whId — the rows `actorGrants` would read.
  await db.insert(userWarehouses).values([
    { userId: WM.id, warehouseId: whId },
    { userId: OP.id, warehouseId: whId },
  ]);
  const [till] = await db
    .insert(moneyAccounts)
    .values({ name: `Qarz kassa ${STAMP}`, currency: 'USD' })
    .returning({ id: moneyAccounts.id });
  accountId = till!.id;
});

afterAll(async () => {
  const promiseRows = await db
    .select({ taskId: paymentPromises.taskId })
    .from(paymentPromises)
    .where(inArray(paymentPromises.clientId, clientIds));
  await db.delete(paymentPromises).where(inArray(paymentPromises.clientId, clientIds));
  const taskIds = promiseRows.flatMap((row) => (row.taskId ? [row.taskId] : []));
  if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
  await db.delete(notifications).where(inArray(notifications.userId, people));
  await db.delete(notifications).where(
    and(eq(notifications.type, 'PaymentPromiseBroken'), sql`${notifications.payload}->>'text' LIKE ${`%QZ${STAMP}%`}`),
  );
  // «Qarzga yuk berildi» goes to the owner and the accountant BY ROLE — the
  // DEMO ones too, whom `people` never reaches (0126, D6a).
  await deleteDebtReleasedFor(clientIds);
  await db.delete(notifications).where(
    and(eq(notifications.type, 'DebtReleased'), sql`${notifications.payload}->>'text' LIKE ${`%QZ${STAMP}%`}`),
  );
  await db.delete(issueApprovals).where(inArray(issueApprovals.clientId, clientIds));
  if (chats.length) await db.delete(telegramLinks).where(inArray(telegramLinks.telegramChatId, chats));
  await db.update(clients).set({ active: false }).where(inArray(clients.id, clientIds));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whId, whB]));
  await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, accountId));
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  await pgClient.end();
});

describe('who may let a debt slide — one predicate, every door', () => {
  it('the request pings exactly the people who may decide it', async () => {
    const c1 = await mkClient(S1.id);
    const pinged = await approvalRecipients(c1.id);
    expect(pinged).toContain(S1.id);
    expect(pinged).toContain(A.id);
    expect(pinged).not.toContain(S2.id);
    // The old filter let the warehouse manager in: he holds the grant and
    // reads no ledger, so he may not decide — and is not pinged.
    expect(pinged).not.toContain(W.id);
    // An unowned client: the whole-ledger deciders only.
    const lone = await mkClient(null);
    const lonePinged = await approvalRecipients(lone.id);
    expect(lonePinged).toContain(A.id);
    expect(lonePinged).not.toContain(S1.id);
  });

  it('/approvals lists what the viewer may decide; a colleague is refused and the row stays pending', async () => {
    const c1 = await mkClient(S1.id);
    await ledger(c1.id, 'charge', 100);
    const { id } = await requestIssueApproval({ clientId: c1.id, warehouseId: whId, note: 'qarz so‘rov' }, ctx(W.id));

    expect((await pendingApprovals(S1.actor)).map((r) => r.id)).toContain(id);
    expect((await pendingApprovals(S2.actor)).map((r) => r.id)).not.toContain(id);
    expect(await pendingApprovals(W.actor)).toEqual([]);

    await expect(
      decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(S2.id), S2.actor),
    ).rejects.toThrow('not_your_client');
    const [still] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(still!.status).toBe('pending');

    // The bot asks the same service with the chat's person.
    const chat = BigInt(Date.now()) * 100n + 71n;
    chats.push(chat);
    await linkStaffChat(S2.id, chat);
    expect(await decideApprovalFromBot(chat, id, 'approved')).toBe('not_your_client');

    await decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(S1.id), S1.actor);
    const [done] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(done!.status).toBe('approved');
    expect(done!.decidedBy).toBe(S1.id);
  });

  // REWRITTEN for D2 (2026-10-07, «sklad mudiri so'ramasdan beraversin»):
  // this used to read «the warehouse manager's tick is refused». W's actor is
  // UNSCOPED here — not standing at any counter — so it still is; the
  // manager AT his counter is the D2 describe below.
  it('the counter: the warehouse manager WITHOUT his warehouse scope gains nothing, the seller’s own tick passes WITH a note, a replay is not refused; the tick over no debt opens nothing', async () => {
    const c1 = await mkClient(S1.id);
    await ledger(c1.id, 'charge', 80);
    await expect(issue(c1.id, W.actor, { debtOk: true, debtNote: 'izoh' })).rejects.toThrow('debt_override_forbidden');
    // Another seller's tick on this client: refused the same way.
    await expect(issue(c1.id, S2.actor, { debtOk: true, debtNote: 'izoh' })).rejects.toThrow('debt_override_forbidden');
    // The seller's own tick passes — with the reason D4a asks of everybody.
    const handoverId = uuidv4();
    const done = await issue(c1.id, S1.actor, { debtOk: true, debtNote: 'debt-control izoh', handoverId });
    // A replay is NEVER refused — the phone asking again gets the act back.
    const again = await issue(c1.id, W.actor, { debtOk: true, handoverId, boxId: (await box(c1.id)) });
    expect(again.id).toBe(done.id);

    const clean = await mkClient(S1.id);
    const free = await issue(clean.id, W.actor, { debtOk: true });
    expect(free.kind).toBe('issued_to_client');
  });

  it('the logist: without the grant (the owner’s 2a default) his tick is refused; with it re-ticked on /admin/roles he releases for everybody', async () => {
    const c = await mkClient(S2.id);
    await ledger(c.id, 'charge', 40);
    const logist = { id: A.id, permissions: new Set<string>(ROLE_MATRIX.logist), roles: ['logist'] };
    await expect(issue(c.id, logist, { debtOk: true, debtNote: 'izoh' })).rejects.toThrow('debt_override_forbidden');
    const reticked = {
      id: A.id,
      permissions: new Set<string>([...ROLE_MATRIX.logist, 'finance.debt_override']),
      roles: ['logist'],
    };
    expect((await issue(c.id, reticked, { debtOk: true, debtNote: 'debt-control izoh' })).kind).toBe('issued_to_client');
  });

  it('a deal «muddat» is the same decision', async () => {
    const c1 = await mkClient(S1.id);
    const dealId = await mkDeal(c1.id);
    const input = { reason: 'hammasi kelganda', untilAllArrived: true };
    await expect(deferPayment(dealId, input, ctx(S2.id), S2.actor)).rejects.toThrow('not_your_client');
    await expect(deferPayment(dealId, input, ctx(W.id), W.actor)).rejects.toThrow('not_your_client');
    await deferPayment(dealId, input, ctx(S1.id), S1.actor);
    const [row] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(row!.deferredBy).toBe(S1.id);
  });
});

describe('D2-D7 (2026-10-07): the warehouse manager releases at HIS counter, and every release says why', () => {
  it('I1: at his own warehouse with a comment — stored, audited, listed, on the lenta for money readers, told to the owner and the accountant', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 80);
    const done = await issue(c.id, at(WM, whId), { debtOk: true, debtNote: 'ertaga to‘laydi' });

    const [stored] = await db.select().from(handovers).where(eq(handovers.id, done.id));
    expect(stored!.debtNote).toBe('ertaga to‘laydi');
    // The act's own `note` is untouched — the reason never reaches the paper.
    expect(stored!.note).toBeNull();
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'handover'), eq(auditLog.entityId, done.id)));
    expect(audit!.after).toMatchObject({ debtNote: 'ertaga to‘laydi', debtRight: 'warehouse' });

    const [row] = await rowsFor(c.id);
    expect(row).toMatchObject({ kind: 'tick', approverId: WM.id, reason: 'ertaga to‘laydi', decisionNote: null });

    const noteOn = async (money: boolean) =>
      (await clientFeed(c.id, { money })).find((item) => item.id === `hv-${done.id}`)?.meta.debtNote;
    expect(await noteOn(true)).toBe('ertaga to‘laydi');
    // The reason names the client's debt: it rides the ledger's door (4a).
    expect(await noteOn(false)).toBeNull();

    // EXACTLY one message each — a silent miss in the logged catch turns this
    // red here, never in production.
    const told = await releasedTold(done.id);
    expect(told.filter((r) => r.userId === SA.id)).toHaveLength(1);
    expect(told.filter((r) => r.userId === A.id)).toHaveLength(1);
    const text = told.find((r) => r.userId === SA.id)!.text;
    expect(text).toContain(c.code);
    expect(text).toContain('$80.00');
    expect(text).toContain('Izoh: ertaga to‘laydi');
    expect(text).toContain(WM.name);
    expect(text).toContain('o‘z skladi');
    // The client's seller is outside the audience; the presser hears nothing of his own press.
    expect(told.some((r) => r.userId === S1.id)).toBe(false);
    expect(told.some((r) => r.userId === WM.id)).toBe(false);
  });

  it('I1b: an audience member who ticks is not told about his own press — the other one is', async () => {
    const c = await mkClient(null);
    await ledger(c.id, 'charge', 55);
    const done = await issue(c.id, A.actor, { debtOk: true, debtNote: 'buxgalter izohi' });
    const told = await releasedTold(done.id);
    expect(told.filter((r) => r.userId === SA.id)).toHaveLength(1);
    expect(told.filter((r) => r.userId === A.id)).toHaveLength(0);
  });

  it('I2: …and nowhere else — another counter, an unscoped manager, an operator holding the grant', async () => {
    const c = await mkClient(null);
    await ledger(c.id, 'charge', 60);
    const tick = { debtOk: true, debtNote: 'izoh' };
    // Scoped to whB, at whId's counter.
    await expect(issue(c.id, at(WM, whB), tick)).rejects.toThrow('debt_override_forbidden');
    // The role scope unticked on /admin/roles: `inScope` would answer true, so the rule fails CLOSED.
    await expect(issue(c.id, { ...WM.actor, warehouseScoped: false, warehouseIds: [whId] }, tick)).rejects.toThrow(
      'debt_override_forbidden',
    );
    // An operator the owner gave the grant (it is how the price tick reaches him) — not «sklad mudiri».
    const operator = { ...at(OP, whId), permissions: new Set<string>([...OP.actor.permissions, 'finance.debt_override']) };
    await expect(issue(c.id, operator, tick)).rejects.toThrow('debt_override_forbidden');
  });

  it('I3: the comment is mandatory for EVERYONE who ticks (D4a)', async () => {
    const tickers: [string, Releaser & Partial<ScopedActor>][] = [
      ['seller (own client)', S1.actor],
      ['accountant', A.actor],
      ['super_admin', SA.actor],
      ['warehouse manager', at(WM, whId)],
    ];
    for (const [who, by] of tickers) {
      const c = await mkClient(S1.id);
      await ledger(c.id, 'charge', 45);
      const boxId = await box(c.id);
      for (const blank of ['', '   ']) {
        await expect(issue(c.id, by, { debtOk: true, debtNote: blank, boxId }), `${who} «${blank}»`).rejects.toThrow(
          'debt_note_required',
        );
      }
    }
  });

  it('I4: a stale tick over no debt needs no comment, stores none, tells nobody; a replay is never refused', async () => {
    const clean = await mkClient(S1.id);
    const free = await issue(clean.id, SA.actor, { debtOk: true });
    const [stored] = await db.select().from(handovers).where(eq(handovers.id, free.id));
    expect(stored).toMatchObject({ debtOk: true, debtNote: null });
    expect(await releasedTold(free.id)).toEqual([]);

    const owing = await mkClient(S1.id);
    await ledger(owing.id, 'charge', 30);
    const handoverId = uuidv4();
    const first = await issue(owing.id, S1.actor, { debtOk: true, debtNote: 'izoh', handoverId });
    const again = await issue(owing.id, S1.actor, { debtOk: true, handoverId, boxId: await box(owing.id) });
    expect(again.id).toBe(first.id);
  });

  it('I5: D3a — the counter’s power did not leak: no ping, no list, no decision, no muddat, no promise', async () => {
    const wm = at(WM, whId);
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 100);
    expect(await approvalRecipients(c.id)).not.toContain(WM.id);
    const { id } = await requestIssueApproval({ clientId: c.id, warehouseId: whId, note: 'so‘rov' }, ctx(OP.id));
    expect(await pendingApprovals(wm)).toEqual([]);
    await expect(decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(WM.id), wm)).rejects.toThrow(
      'not_your_client',
    );
    const [still] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(still!.status).toBe('pending');
    const dealId = await mkDeal(c.id);
    await expect(
      deferPayment(dealId, { reason: 'kutamiz', untilAllArrived: true }, ctx(WM.id), wm),
    ).rejects.toThrow('not_your_client');
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 50, dueOn: tashkentDay() }, ctx(WM.id), wm),
    ).rejects.toThrow('not_your_client');
    await decideIssueApproval({ approvalId: id, verdict: 'refused' }, ctx(S1.id), S1.actor);
  });

  it('I6: the request needs a reason (D5a); the approval release carries it; the decider is not told about his own decision', async () => {
    const c = await mkClient(null);
    await ledger(c.id, 'charge', 90);
    for (const blank of ['', '  ']) {
      await expect(
        requestIssueApproval({ clientId: c.id, warehouseId: whId, note: blank }, ctx(OP.id)),
      ).rejects.toThrow('note_required');
    }
    expect(await db.select().from(issueApprovals).where(eq(issueApprovals.clientId, c.id))).toEqual([]);

    const { id } = await requestIssueApproval({ clientId: c.id, warehouseId: whId, note: 'mijoz kafil' }, ctx(OP.id));
    const [asked] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(asked!.requestNote).toBe('mijoz kafil');
    const [event] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, 'DebtApprovalRequested'), eq(events.entityId, id)));
    expect((event!.payload as { note?: string }).note).toBe('mijoz kafil');

    // The ACCOUNTANT decides (an audience member — or the decider filter proves nothing).
    await decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(A.id), A.actor);
    const done = await issue(c.id, at(OP, whId));
    const [stored] = await db.select().from(handovers).where(eq(handovers.id, done.id));
    expect(stored!.debtNote).toBeNull();
    const [row] = await rowsFor(c.id);
    expect(row).toMatchObject({ kind: 'approval', approverId: A.id, reason: 'mijoz kafil', decisionNote: null });
    const item = (await clientFeed(c.id, { money: true })).find((entry) => entry.id === `hv-${done.id}`);
    expect(item!.meta.debtNote).toBe('mijoz kafil');
    const told = await releasedTold(done.id);
    expect(told.filter((r) => r.userId === SA.id)).toHaveLength(1);
    expect(told.filter((r) => r.userId === A.id)).toHaveLength(0);
    expect(told.filter((r) => r.userId === OP.id)).toHaveLength(0);
    expect(told.find((r) => r.userId === SA.id)!.text).toContain('Sabab: mijoz kafil');

    // The bot's one-tap «Ruxsat» (by the owner): its constant is a DECISION
    // note, never the reason — and now the accountant is told, the owner not.
    const c2 = await mkClient(null);
    await ledger(c2.id, 'charge', 40);
    const asked2 = await requestIssueApproval({ clientId: c2.id, warehouseId: whId, note: 'bot so‘rov' }, ctx(OP.id));
    const chat = BigInt(Date.now()) * 100n + 72n;
    chats.push(chat);
    await linkStaffChat(SA.id, chat);
    expect(await decideApprovalFromBot(chat, asked2.id, 'approved')).toBe('decided');
    const done2 = await issue(c2.id, at(OP, whId));
    const [row2] = await rowsFor(c2.id);
    expect(row2).toMatchObject({
      kind: 'approval',
      approverId: SA.id,
      reason: 'bot so‘rov',
      decisionNote: 'Telegram bot orqali',
    });
    const told2 = await releasedTold(done2.id);
    expect(told2.filter((r) => r.userId === A.id)).toHaveLength(1);
    expect(told2.filter((r) => r.userId === SA.id)).toHaveLength(0);
    expect(told2.find((r) => r.userId === A.id)!.text).toContain('Qaror izohi: Telegram bot orqali');
  });

  it('I7: the CHECK — a reason never rides a handover nobody ticked, and is never blank', async () => {
    const c = await mkClient(null);
    const insert = (debtOk: boolean, debtNote: string) =>
      db.insert(handovers).values({
        clientId: c.id,
        warehouseId: whId,
        kind: 'issued_to_client',
        personName: 'Tekshiruv',
        personPhone: '+998900000000',
        debtOk,
        debtNote,
        createdBy: A.id,
      });
    const broken = { code: '23514', constraint_name: 'handovers_debt_note_check' };
    await expect(insert(false, 'x')).rejects.toMatchObject(broken);
    await expect(insert(true, '  ')).rejects.toMatchObject(broken);
    await expect(insert(true, 'x'.repeat(501))).rejects.toMatchObject(broken);
  });
});

describe('«Qarzga berilgan yuklar» — the register', () => {
  it('names who allowed each kind of release, leaves out what opened nothing, and the lenta agrees', async () => {
    // ✋ a tick by the accountant.
    const tickClient = await mkClient(S1.id);
    await ledger(tickClient.id, 'charge', 120);
    const tick = await issue(tickClient.id, A.actor, { debtOk: true, debtNote: 'debt-control izoh' });

    // ✅ an approval decided by the seller and carried out by the warehouse.
    const apprClient = await mkClient(S1.id);
    await ledger(apprClient.id, 'charge', 70);
    const { id: approvalId } = await requestIssueApproval(
      { clientId: apprClient.id, warehouseId: whId, note: 'qarz so‘rov' },
      ctx(W.id),
    );
    await decideIssueApproval({ approvalId, verdict: 'approved' }, ctx(S1.id), S1.actor);
    const appr = await issue(apprClient.id, W.actor);

    // ⏳ a muddat granted by the seller: the cargo went out with nothing pressed.
    const defClient = await mkClient(S1.id);
    const dealId = await mkDeal(defClient.id);
    await ledger(defClient.id, 'charge', 90, { dealId });
    await deferPayment(dealId, { reason: 'kutamiz', untilAllArrived: true }, ctx(S1.id), S1.actor);
    const def = await issue(defClient.id, W.actor);

    // A tick posted over NO debt (the judge's #4) and a plain paid-up handover.
    const zeroClient = await mkClient(S1.id);
    const zeroTick = await issue(zeroClient.id, A.actor, { debtOk: true });

    const [t] = await rowsFor(tickClient.id);
    expect(t).toMatchObject({ kind: 'tick', approverId: A.id, debtUsd: 120, legacy: false });
    const [a] = await rowsFor(apprClient.id);
    expect(a).toMatchObject({ kind: 'approval', approverId: S1.id, gaveByName: W.name, debtUsd: 70 });
    const [d] = await rowsFor(defClient.id);
    expect(d).toMatchObject({ kind: 'deferral', approverId: S1.id, debtUsd: 90 });
    expect(await rowsFor(zeroClient.id)).toEqual([]);

    // The stored figures are the gate's own.
    const [stored] = await db.select().from(handovers).where(eq(handovers.id, def.id));
    expect(stored!.blockingUsd).toBe('0.00');
    expect(stored!.deferredUsd).toBe('90.00');
    expect(stored!.deferrals).toEqual([{ dealId, code: expect.any(String), by: S1.id, usd: 90 }]);

    // The client's lenta marks the SAME releases (#513): the approval now
    // carries the ⚠ it used to lack, the ⏳ muddat release too (the kind a
    // seller controls — the reviewer's third), the tick over nothing does not.
    const mark = async (clientId: string, handoverId: string, money = true) =>
      (await clientFeed(clientId, { money })).find((item) => item.id === `hv-${handoverId}`)?.meta.debtOverride;
    expect(await mark(tickClient.id, tick.id)).toBe(true);
    expect(await mark(apprClient.id, appr.id)).toBe(true);
    expect(await mark(defClient.id, def.id)).toBe(true);
    expect(await mark(zeroClient.id, zeroTick.id)).toBe(false);
    // «Went out on debt» says the client OWED: money, so it rides the
    // ledger's door (4a) — a lenta reader without it gets the handover alone.
    expect(await mark(tickClient.id, tick.id, false)).toBe(false);
    expect(await mark(defClient.id, def.id, false)).toBe(false);

    // And as SETS, over every handover of these four clients: the handovers
    // the register lists are exactly the ones the lenta's rule marks.
    const mine = [tickClient.id, apprClient.id, defClient.id, zeroClient.id];
    const listed = new Set(
      (await debtReleases(sight, ALL)).rows.filter((row) => mine.includes(row.clientId)).map((row) => row.handoverId),
    );
    const marked = await db.execute<{ id: string }>(sql`
      SELECT h.id FROM handovers h
       WHERE h.client_id IN (${sql.join(
         mine.map((id) => sql`${id}::uuid`),
         sql`, `,
       )}) AND h.kind = 'issued_to_client' AND ${wentOutOnDebtSql('h')}`);
    expect([...listed].sort()).toEqual([...marked].map((row) => row.id).sort());
    expect(listed.size).toBe(3);
  });

  it('«keyin to‘landi» counts money after the release — net of refunds, never a voided row or one before', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 200);
    await ledger(c.id, 'payment', 5, { createdAt: new Date(Date.now() - 3_600_000) }); // before
    await issue(c.id, A.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    const later = (s: number) => new Date(Date.now() + s * 1000);
    await ledger(c.id, 'payment', 60, { createdAt: later(1) });
    await ledger(c.id, 'payment', 999, { createdAt: later(2), voided: true });
    await ledger(c.id, 'refund', 10, { createdAt: later(3) });
    const [row] = await rowsFor(c.id);
    expect(row!.debtUsd).toBe(195);
    expect(row!.paidSinceUsd).toBe(50);
    expect(row!.returnedUsd).toBe(50);
    expect(row!.leftUsd).toBe(145);
    expect(row!.currentDebtUsd).toBe(145);
    // Raw SQL hands a timestamptz back as TEXT (#923): the row must carry a
    // Date that formats, or the page throws FORMATTING_ERROR per row.
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(() => new Intl.DateTimeFormat('uz', { timeZone: 'Asia/Tashkent' }).format(row!.createdAt)).not.toThrow();
  });

  it('«qaytmagan» never outlives the debt: a charge voided after the release takes it away', async () => {
    const c = await mkClient(S1.id);
    const charge = await ledger(c.id, 'charge', 100);
    await issue(c.id, A.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    await db
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: A.id, voidReason: 'xato narx' })
      .where(eq(clientTransactions.id, charge));
    const [row] = await rowsFor(c.id);
    expect(row).toMatchObject({ debtUsd: 100, paidSinceUsd: 0, leftUsd: 0, currentDebtUsd: 0 });
    expect(await rowsFor(c.id, { ...ALL, includeReturned: false })).toEqual([]);
  });

  it('per-person totals count each client’s LATEST release once — in SQL, whatever the list cap', async () => {
    // A person of his own, so the totals are this test's and nobody else's.
    const solo = await mkUser('accountant', 'Solo');
    const twice = await mkClient(null);
    await ledger(twice.id, 'charge', 100);
    await issue(twice.id, solo.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    await ledger(twice.id, 'charge', 50);
    await issue(twice.id, solo.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    const once = await mkClient(null);
    await ledger(once.id, 'charge', 30);
    await issue(once.id, solo.actor, { debtOk: true, debtNote: 'debt-control izoh' });

    const filter = { ...ALL, approverId: solo.id };
    const expected = [
      {
        approverId: solo.id,
        approverName: solo.name,
        releases: 3,
        clients: 2,
        // 100 then 150 is ONE client owing 150, not 250 — plus the other's 30.
        debtUsd: 180,
        returnedUsd: 0,
        leftUsd: 180,
        unknown: 0,
      },
    ];
    const whole = await debtReleases(sight, filter);
    expect(whole.totals).toEqual(expected);
    expect(whole.total).toBe(3);
    // The list stops at its cap; the totals do not (the judge's #5).
    const capped = await debtReleases(sight, filter, 1);
    expect(capped.rows).toHaveLength(1);
    expect(capped.total).toBe(3);
    expect(capped.totals).toEqual(expected);
  });

  it('older handovers: the tick is listed with no figure, a debt approval with its snapshot, a price-only approval never', async () => {
    const c = await mkClient(S1.id);
    const legacy = async (debtOk: boolean) => {
      const [h] = await db
        .insert(handovers)
        .values({
          clientId: c.id,
          warehouseId: whId,
          kind: 'issued_to_client',
          personName: 'Eski',
          personPhone: '+998900000000',
          debtOk,
          createdBy: W.id,
        })
        .returning({ id: handovers.id });
      return h!.id;
    };
    const consumed = async (handoverId: string, debtUsd: string, boxIds: string[]) =>
      db.insert(issueApprovals).values({
        clientId: c.id,
        warehouseId: whId,
        blockingDebtUsd: debtUsd,
        unpricedBoxIds: boxIds,
        requestedBy: W.id,
        status: 'consumed',
        decidedBy: A.id,
        decidedAt: new Date(),
        consumedHandoverId: handoverId,
        consumedAt: new Date(),
      });
    await ledger(c.id, 'charge', 300);
    const oldTick = await legacy(true);
    const oldAppr = await legacy(false);
    await consumed(oldAppr, '140.00', []);
    const priceOnly = await legacy(false);
    await consumed(priceOnly, '0.00', [uuidv4()]);

    const rows = await rowsFor(c.id);
    const byId = new Map(rows.map((row) => [row.handoverId, row]));
    expect(byId.get(oldTick)).toMatchObject({ kind: 'tick', debtUsd: null, legacy: false, approverId: W.id });
    expect(byId.get(oldAppr)).toMatchObject({ kind: 'approval', debtUsd: 140, legacy: true, approverId: A.id });
    expect(byId.has(priceOnly)).toBe(false);
  });

  it('a release of two parts by ONE person is one release and its whole money (the reviewer: the last part alone was summed)', async () => {
    // A seller of his own, so the totals are this test's and nobody else's.
    const seller = await mkUser('sales_manager', 'Ikki');
    const c = await mkClient(seller.id);
    const jobA = await mkDeal(c.id);
    const jobB = await mkDeal(c.id);
    const chargeA = await ledger(c.id, 'charge', 300, { dealId: jobA });
    await ledger(c.id, 'charge', 200, { dealId: jobB });
    const input = { reason: 'hammasi kelganda', untilAllArrived: true };
    await deferPayment(jobA, input, ctx(seller.id), seller.actor);
    await deferPayment(jobB, input, ctx(seller.id), seller.actor);
    // Nothing blocks — both jobs are deferred — so the warehouse presses nothing.
    await issue(c.id, W.actor);

    const { rows, total, totals } = await debtReleases(sight, { ...ALL, approverId: seller.id });
    expect(rows.map((row) => [row.kind, row.debtUsd])).toEqual([
      ['deferral', 300],
      ['deferral', 200],
    ]);
    expect(total).toBe(2);
    expect(totals).toEqual([
      {
        approverId: seller.id,
        approverName: seller.name,
        releases: 1,
        clients: 1,
        debtUsd: 500,
        returnedUsd: 0,
        leftUsd: 500,
        unknown: 0,
      },
    ]);

    // The first job's price was a mistake and is voided: he owes $200 today.
    // Each part is capped at that on its own ($200 + $200), and so is their
    // sum — «qaytmagan» never outlives the debt it counts.
    await db
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: A.id, voidReason: 'xato narx' })
      .where(eq(clientTransactions.id, chargeA));
    const after = await debtReleases(sight, { ...ALL, approverId: seller.id });
    expect(after.rows.map((row) => row.leftUsd)).toEqual([200, 200]);
    expect(after.totals).toEqual([expect.objectContaining({ releases: 1, debtUsd: 500, leftUsd: 200 })]);
  });

  it('a tick over a muddat the same person granted: one release, both parts, the money since shared between them', async () => {
    const acc = await mkUser('accountant', 'Ikkalasi');
    const c = await mkClient(null);
    const dealId = await mkDeal(c.id);
    await ledger(c.id, 'charge', 400);
    await ledger(c.id, 'charge', 600, { dealId });
    await deferPayment(dealId, { reason: 'kutamiz', untilAllArrived: true }, ctx(acc.id), acc.actor);
    await issue(c.id, acc.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    await ledger(c.id, 'payment', 500, { createdAt: new Date(Date.now() + 1000) });

    const { rows, totals } = await debtReleases(sight, { ...ALL, approverId: acc.id });
    // Each part's «qaytdi» is ITS share — debt − qaytdi = qaytmagan on every
    // line (the page used to print the handover's whole $500 on both).
    expect(rows.map((row) => [row.kind, row.debtUsd, row.returnedUsd, row.leftUsd])).toEqual([
      ['tick', 400, 400, 0],
      ['deferral', 600, 100, 500],
    ]);
    expect(totals).toEqual([
      {
        approverId: acc.id,
        approverName: acc.name,
        releases: 1,
        clients: 1,
        debtUsd: 1000,
        returnedUsd: 500,
        leftUsd: 500,
        unknown: 0,
      },
    ]);
    // By default only money still out: the gate part is back, the release is
    // still ONE release with $500 out.
    const open = await debtReleases(sight, { ...ALL, approverId: acc.id, includeReturned: false });
    expect(open.rows.map((row) => row.kind)).toEqual(['deferral']);
    expect(open.totals).toEqual([expect.objectContaining({ releases: 1, clients: 1, debtUsd: 1000, leftUsd: 500 })]);
  });

  it('the register reads its partial index — the handovers written from 0114 on are never a full scan (#934)', async () => {
    type Node = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Node[] };
    const plan = await db.transaction(async (tx) => {
      // Refused seq scans cost 1e10, so a scan the planner cannot avoid is
      // one no index could serve at all — what the statement's own text
      // proves, never what a small table happened to make cheap.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': unknown }>(sql`EXPLAIN (FORMAT JSON) ${releasePartsSql()}`);
    });
    const raw = plan[0]!['QUERY PLAN'];
    const root = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: Node }[];
    const nodes: Node[] = [];
    const walk = (node: Node) => {
      nodes.push(node);
      node.Plans?.forEach(walk);
    };
    walk(root[0]!.Plan);
    // The gate branch AND the deferrals branch — both grow with every handover.
    expect(nodes.filter((node) => node['Index Name'] === 'handovers_debt_release_idx').length).toBeGreaterThanOrEqual(2);
    // At most the older ticks: a fixed set, and no index of their own (stated).
    const scans = nodes.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'handovers');
    expect(scans.length).toBeLessThanOrEqual(1);
  });

  it('money paid since repays the overdue part first, then the deferred job', async () => {
    const c = await mkClient(S1.id);
    const dealId = await mkDeal(c.id);
    await ledger(c.id, 'charge', 400);
    await ledger(c.id, 'charge', 600, { dealId });
    await deferPayment(dealId, { reason: 'kutamiz', untilAllArrived: true }, ctx(S1.id), S1.actor);
    await issue(c.id, A.actor, { debtOk: true, debtNote: 'debt-control izoh' });
    await ledger(c.id, 'payment', 500, { createdAt: new Date(Date.now() + 1000) });
    const rows = await rowsFor(c.id);
    const gate = rows.find((row) => row.kind === 'tick')!;
    const muddat = rows.find((row) => row.kind === 'deferral')!;
    expect(gate).toMatchObject({ approverId: A.id, debtUsd: 400, deferredUsd: 600, returnedUsd: 400, leftUsd: 0 });
    expect(muddat).toMatchObject({ approverId: S1.id, debtUsd: 600, returnedUsd: 100, leftUsd: 500 });
    // By default only money still out is listed.
    const open = await rowsFor(c.id, { ...ALL, includeReturned: false });
    expect(open.map((row) => row.kind)).toEqual(['deferral']);
  });
});

describe('to‘lov va’dasi', () => {
  const today = () => tashkentDay();

  it('the seller promises for his own client; the call is a TASK and the booked call stays; the refusals are words', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 300);
    await db.update(clients).set({ nextActionAt: addDays(today(), 30), nextActionNote: 'Guangzhou narxi' }).where(eq(clients.id, c.id));

    await expect(
      recordPromise({ clientId: c.id, amountUsd: 100, dueOn: today() }, ctx(S2.id), S2.actor),
    ).rejects.toThrow('not_your_client');
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 100, dueOn: today() }, ctx(W.id), W.actor),
    ).rejects.toThrow('not_your_client');
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 300.5, dueOn: today() }, ctx(S1.id), S1.actor),
    ).rejects.toThrow('exceeds_debt');
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 100, dueOn: addDays(today(), -1) }, ctx(S1.id), S1.actor),
    ).rejects.toThrow('bad_date');
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 100, dueOn: addDays(today(), 91) }, ctx(S1.id), S1.actor),
    ).rejects.toThrow('bad_date');

    const { id } = await recordPromise(
      { clientId: c.id, amountUsd: 100, dueOn: addDays(today(), 3) },
      ctx(S1.id),
      S1.actor,
    );
    await expect(
      recordPromise({ clientId: c.id, amountUsd: 50, dueOn: today() }, ctx(A.id), A.actor),
    ).rejects.toThrow('promise_open');

    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.taskId).toBeTruthy();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(task).toMatchObject({ assigneeId: S1.id, entityType: 'client', entityId: c.id, status: 'open' });
    // No amount on anything a non-money reader sees: the words and the code.
    expect(task!.title).toBe(`${PROMISE_TASK_TITLE} · ${c.code}`);
    const [after] = await db.select().from(clients).where(eq(clients.id, c.id));
    expect(after).toMatchObject({ nextActionAt: addDays(today(), 30), nextActionNote: 'Guangzhou narxi' });

    await expect(cancelPromise(id, ctx(S2.id), S2.actor)).rejects.toThrow('not_your_client');
    await cancelPromise(id, ctx(S1.id), S1.actor);
    await expect(cancelPromise(id, ctx(S1.id), S1.actor)).rejects.toThrow('not_open');
    const [closedTask] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(closedTask!.status).toBe('cancelled');
    expect((await clientPromises(c.id))[0]!.status).toBe('cancelled');
  });

  it('an unowned client’s call goes to whoever took the promise', async () => {
    const c = await mkClient(null);
    await ledger(c.id, 'charge', 80);
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 80, dueOn: today() }, ctx(A.id), A.actor);
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(task!.assigneeId).toBe(A.id);
    await cancelPromise(id, ctx(A.id), A.actor);
  });

  it('a seller who never signs in (0120) is no seller for the call — it falls to the recorder', async () => {
    // Reachable only by a forged client post: the pickers never offer a
    // no-login person. Without the rule `createTask` refuses
    // `assignee_no_login` into the catch that only LOGS — a promise with no
    // call at all.
    const [nobody] = await db
      .insert(users)
      .values({ fullName: `Qarz xitoy ${STAMP}`, phone: null, passwordHash: null, loginEnabled: false })
      .returning({ id: users.id });
    people.push(nobody!.id);
    const c = await mkClient(nobody!.id);
    await ledger(c.id, 'charge', 300);
    const { id } = await recordPromise(
      { clientId: c.id, amountUsd: 100, dueOn: addDays(today(), 3) },
      ctx(A.id),
      A.actor,
    );
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.taskId).not.toBeNull();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(task!.assigneeId).toBe(A.id);
    await cancelPromise(id, ctx(A.id), A.actor);
  });

  it('kept when the money came — a so‘m payment a few dollars short included; the task closes itself', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 500);
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 200, dueOn: today() }, ctx(S1.id), S1.actor);
    // 2 450 000 so'm at the day's rate is $197 — the client paid what he said.
    await ledger(c.id, 'payment', 197, { currency: 'UZS', amount: 2_450_000, createdAt: new Date(Date.now() + 1000) });
    await sweepPromises(new Date());
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.status).toBe('kept');
    expect(p!.settledBy).toBeNull();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(task!.status).toBe('done');
  });

  it('the sweep closes only an OPEN task — a call the seller already closed keeps his words', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 120);
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 120, dueOn: today() }, ctx(S1.id), S1.actor);
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    await db
      .update(tasks)
      .set({ status: 'done', doneAt: new Date(), result: 'qo‘ng‘iroq qildim, ertaga to‘laydi' })
      .where(eq(tasks.id, p!.taskId!));
    await ledger(c.id, 'payment', 120, { createdAt: new Date(Date.now() + 1000) });
    await sweepPromises(new Date());
    const [task] = await db.select().from(tasks).where(eq(tasks.id, p!.taskId!));
    expect(task!.result).toBe('qo‘ng‘iroq qildim, ertaga to‘laydi');
  });

  it('two sweeps at once judge a promise ONCE — the claim is the UPDATE, not the read (#599)', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 60);
    const due = today();
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 60, dueOn: due }, ctx(S1.id), S1.actor);
    const at = promiseBrokenAt(due);
    // Deterministic, not a race left to the scheduler: a second connection
    // holds the promise's row, so BOTH sweeps read it open and BOTH claims
    // queue behind the lock; released, the second claim re-reads the row the
    // first one committed. Two unsynchronised sweeps usually do not overlap
    // at all, and a test that only sometimes overlaps proves nothing (#166).
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    let sweeps: Promise<[Awaited<ReturnType<typeof sweepPromises>>, Awaited<ReturnType<typeof sweepPromises>>]>;
    try {
      await held`BEGIN`;
      await held`SELECT id FROM payment_promises WHERE id = ${id} FOR UPDATE`;
      sweeps = Promise.all([sweepPromises(at), sweepPromises(at)]);
      let waiting = 0;
      // Observed through the POOL: pg_stat_activity freezes inside an open
      // transaction, so the holder cannot watch for the waiters itself.
      for (let i = 0; i < 250 && waiting < 2; i += 1) {
        const rows = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%payment_promises%' AND pid <> pg_backend_pid()`);
        waiting = Number(rows[0]?.n ?? 0);
        if (waiting < 2) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, 'both sweeps must be queued on the claim').toBe(2);
      await held`COMMIT`;
    } finally {
      held.release();
      await helper.end();
    }
    const [first, second] = await sweeps!;
    expect(first.broken + second.broken).toBe(1);
    const alarms = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'PaymentPromiseBroken'),
          eq(notifications.userId, S1.id),
          sql`${notifications.payload}->>'text' LIKE ${`%${c.code}%`}`,
        ),
      );
    expect(alarms).toHaveLength(1);
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, p!.taskId!));
  });

  it('a dollar payment short of the promise is NOT kept', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 500);
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 200, dueOn: today() }, ctx(S1.id), S1.actor);
    await ledger(c.id, 'payment', 197, { createdAt: new Date(Date.now() + 1000) });
    await sweepPromises(new Date());
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.status).toBe('open');
    await cancelPromise(id, ctx(S1.id), S1.actor);
  });

  it('settled — not «kept» — when the debt went away without the payment', async () => {
    const c = await mkClient(S1.id);
    const charge = await ledger(c.id, 'charge', 90);
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 90, dueOn: today() }, ctx(S1.id), S1.actor);
    await db
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: A.id, voidReason: 'xato' })
      .where(eq(clientTransactions.id, charge));
    await sweepPromises(new Date());
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.status).toBe('settled');
  });

  it('broken at noon the day after — ONE alarm across two sweeps, to the seller and the money readers', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 250);
    const due = today();
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 150, dueOn: due }, ctx(S1.id), S1.actor);
    const brokenAt = promiseBrokenAt(due);
    await sweepPromises(new Date(brokenAt.getTime() - 60_000));
    expect((await db.select().from(paymentPromises).where(eq(paymentPromises.id, id)))[0]!.status).toBe('open');
    await sweepPromises(brokenAt);
    await sweepPromises(new Date(brokenAt.getTime() + 3_600_000));
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect(p!.status).toBe('broken');
    // The call stays open — a broken promise is exactly when somebody rings.
    expect((await db.select().from(tasks).where(eq(tasks.id, p!.taskId!)))[0]!.status).toBe('open');

    const alarms = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(eq(notifications.type, 'PaymentPromiseBroken'), sql`${notifications.payload}->>'text' LIKE ${`%${c.code}%`}`),
      );
    const toSeller = alarms.filter((row) => row.userId === S1.id);
    expect(toSeller).toHaveLength(1);
    expect(alarms.filter((row) => row.userId === A.id)).toHaveLength(1);
    expect(alarms.some((row) => row.userId === S2.id)).toBe(false);
    expect(alarms.some((row) => row.userId === W.id)).toBe(false);
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, p!.taskId!));
  });

  const alarmsFor = async (code: string) =>
    db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.type, 'PaymentPromiseBroken'), sql`${notifications.payload}->>'text' LIKE ${`%${code}%`}`));

  it('the alarm reaches whoever holds the call — a colleague the task was handed to, not the seller who handed it', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 90);
    const due = today();
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 90, dueOn: due }, ctx(S1.id), S1.actor);
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    await db.update(tasks).set({ assigneeId: S2.id }).where(eq(tasks.id, p!.taskId!));
    await sweepPromises(promiseBrokenAt(due));
    const alarms = await alarmsFor(c.code);
    expect(alarms.filter((row) => row.userId === S2.id)).toHaveLength(1);
    expect(alarms.some((row) => row.userId === S1.id)).toBe(false);
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, p!.taskId!));
  });

  it('a seller who has LEFT hears nothing, so the alarm falls back to whoever took the promise', async () => {
    const seller = await mkUser('sales_manager', 'Ketgan');
    // A logist the owner re-ticked with the grant: he may promise for anyone
    // and is on neither the owner's nor the money readers' list.
    const logist = await mkUser('logist', 'L');
    const logistActor = { id: logist.id, permissions: new Set<string>([...logist.actor.permissions, 'finance.debt_override']) };
    const c = await mkClient(seller.id);
    await ledger(c.id, 'charge', 70);
    const due = today();
    const { id } = await recordPromise({ clientId: c.id, amountUsd: 70, dueOn: due }, ctx(logist.id), logistActor);
    // The call went to the seller, who then left the company.
    const [p] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, id));
    expect((await db.select().from(tasks).where(eq(tasks.id, p!.taskId!)))[0]!.assigneeId).toBe(seller.id);
    await db.update(users).set({ active: false }).where(eq(users.id, seller.id));
    await sweepPromises(promiseBrokenAt(due));
    const alarms = await alarmsFor(c.code);
    expect(alarms.filter((row) => row.userId === logist.id)).toHaveLength(1);
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, p!.taskId!));
  });

  it('a new promise closes the broken one’s call — one «💵 To‘lov va’dasi» per client, never two', async () => {
    const c = await mkClient(S1.id);
    await ledger(c.id, 'charge', 300);
    const due = today();
    const first = await recordPromise({ clientId: c.id, amountUsd: 100, dueOn: due }, ctx(S1.id), S1.actor);
    await sweepPromises(promiseBrokenAt(due));
    const [broken] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, first.id));
    expect(broken!.status).toBe('broken');
    expect((await db.select().from(tasks).where(eq(tasks.id, broken!.taskId!)))[0]!.status).toBe('open');

    const second = await recordPromise(
      { clientId: c.id, amountUsd: 100, dueOn: addDays(today(), 2) },
      ctx(S1.id),
      S1.actor,
    );
    const [oldCall] = await db.select().from(tasks).where(eq(tasks.id, broken!.taskId!));
    expect(oldCall).toMatchObject({ status: 'done', result: 'Yangi va’da olindi' });
    const open = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.entityType, 'client'), eq(tasks.entityId, c.id), eq(tasks.status, 'open')));
    const [p2] = await db.select().from(paymentPromises).where(eq(paymentPromises.id, second.id));
    expect(open.map((row) => row.id)).toEqual([p2!.taskId]);
    await cancelPromise(second.id, ctx(S1.id), S1.actor);
  });

  it('the coming payments: open promises due in a window, soonest first, for a money reader', async () => {
    const early = await mkClient(S1.id);
    const late = await mkClient(S1.id);
    const outside = await mkClient(S1.id);
    for (const c of [early, late, outside]) await ledger(c.id, 'charge', 400);
    const a = await recordPromise({ clientId: late.id, amountUsd: 150, dueOn: addDays(today(), 5) }, ctx(S1.id), S1.actor);
    const b = await recordPromise({ clientId: early.id, amountUsd: 250, dueOn: addDays(today(), 1) }, ctx(S1.id), S1.actor);
    const x = await recordPromise({ clientId: outside.id, amountUsd: 50, dueOn: addDays(today(), 20) }, ctx(S1.id), S1.actor);
    await ledger(early.id, 'payment', 40, { createdAt: new Date(Date.now() + 1000) });

    const due = (await promisesDueBetween(sight, today(), addDays(today(), 6))).filter((row) =>
      [early.id, late.id, outside.id].includes(row.clientId),
    );
    expect(due.map((row) => [row.clientCode, row.amountUsd, row.paidSinceUsd, row.balanceUsd])).toEqual([
      [early.code, 250, 40, 360],
      [late.code, 150, 0, 400],
    ]);
    // A reversed or unreadable window answers nothing rather than guessing.
    expect(await promisesDueBetween(sight, addDays(today(), 6), today())).toEqual([]);
    expect(await promisesDueBetween(sight, 'ertaga', today())).toEqual([]);
    for (const p of [a, b, x]) await cancelPromise(p.id, ctx(S1.id), S1.actor);
  });
});
