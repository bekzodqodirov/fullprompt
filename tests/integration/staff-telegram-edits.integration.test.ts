import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  issueApprovals,
  notifications,
  permissions,
  rolePermissions,
  tasks,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { ApprovalError, decideIssueApproval } from '@/modules/wms/issue/approvals';
import { closeTaskMessage, settlePressedApproval } from '@/modules/platform/telegram/staff-bot';
import { createTask, reassignTask } from '@/modules/platform/tasks/service';
import { composeMyDay } from '@/modules/platform/tasks/digest';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { notificationLabels } from '@/modules/platform/notifications/labels';

/**
 * The staff messages that CHANGE after they are sent (round C): a settled
 * approval closes every decider's copy — from whichever door decided it — and
 * a closed task rewrites the message its «✅» sat on. The transport is a
 * recorder; the database is real, because «which copies» is a query.
 */

const APP = 'https://test.gsrwms.uz';
const STAMP = String(Date.now()).slice(-7);
let seq = 0;

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];

const people: string[] = [];
const approvals: string[] = [];
const clientIds: string[] = [];
const taskIds: string[] = [];
const rowsMade: string[] = [];
let deciderRoleId: string;
let whId: string;

const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

async function mintStaff(opts: { decider?: boolean; chat?: number } = {}): Promise<{ id: string; name: string }> {
  seq += 1;
  const name = `Tahrir xodim ${STAMP}-${seq}`;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99896${String(Number(STAMP) + seq).padStart(7, '0').slice(-7)}`,
      fullName: name,
      passwordHash: 'x',
      locale: 'uz',
      active: true,
    })
    .returning({ id: users.id });
  people.push(user!.id);
  if (opts.decider) await db.insert(userRoles).values({ userId: user!.id, roleId: deciderRoleId });
  if (opts.chat) {
    await db
      .insert(telegramLinks)
      .values({ userId: user!.id, telegramChatId: BigInt(opts.chat), status: 'linked', linkedAt: new Date() });
  }
  return { id: user!.id, name };
}

async function mintApproval(requestedBy: string): Promise<string> {
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `TE${STAMP}${seq}`.slice(0, 10), name: `Tahrir mijoz ${STAMP}` })
    .returning({ id: clients.id });
  clientIds.push(client!.id);
  const [row] = await db
    .insert(issueApprovals)
    .values({ clientId: client!.id, warehouseId: whId, blockingDebtUsd: '250.00', requestedBy })
    .returning({ id: issueApprovals.id });
  approvals.push(row!.id);
  return row!.id;
}

/** A decider's copy, as the drain leaves it once sent: with `payload.tg`. */
async function sentCopy(userId: string, approvalId: string, chatId: number, messageId: number) {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      channel: 'telegram',
      type: 'DebtApprovalRequested',
      status: 'sent',
      sentAt: new Date(),
      payload: {
        approvalId,
        clientCode: 'GS301',
        clientName: 'Aziz',
        warehouseCode: 'TAS1',
        blockingDebtUsd: 250,
        requestedByName: 'Operator',
        tg: { chatId, messageId },
      },
    })
    .returning({ id: notifications.id });
  rowsMade.push(row!.id);
}

const edits = () => calls.filter((c) => c.method === 'editMessageText');

beforeAll(async () => {
  const [grant] = await db
    .select({ roleId: rolePermissions.roleId })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(permissions.code, 'finance.debt_override'))
    .limit(1);
  deciderRoleId = grant!.roleId;
  whId = (await db.select().from(warehouses).limit(1))[0]!.id;
});

beforeEach(() => {
  calls = [];
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    calls.push({
      method: url.slice(url.lastIndexOf('/') + 1),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
});

afterAll(async () => {
  if (rowsMade.length) await db.delete(notifications).where(inArray(notifications.id, rowsMade));
  if (people.length) {
    // Rows the services queued for these people (TaskAssigned and friends).
    await db.delete(notifications).where(inArray(notifications.userId, people));
  }
  if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
  if (approvals.length) await db.delete(issueApprovals).where(inArray(issueApprovals.id, approvals));
  if (clientIds.length) await db.delete(clients).where(inArray(clients.id, clientIds));
  if (people.length) {
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
    await db.delete(userRoles).where(inArray(userRoles.userId, people));
    // Audited actors cannot be deleted (audit_log FK) — they leave the
    // company instead, which also takes them off every recipient list.
    await db.update(users).set({ active: false }).where(inArray(users.id, people));
  }
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedEnv.app;
  await pgClient.end();
});

describe('a settled approval closes every decider\'s copy', () => {
  it('a WEB decision edits each phone\'s copy: the verdict under it, the buttons gone, the link kept', async () => {
    const first = await mintStaff({ decider: true });
    const second = await mintStaff({ decider: true });
    const approvalId = await mintApproval(first.id);
    await sentCopy(first.id, approvalId, 901, 11);
    await sentCopy(second.id, approvalId, 902, 22);

    await decideIssueApproval(
      { approvalId, verdict: 'approved', note: 'ekrandan' },
      { actorId: first.id, ip: null, userAgent: null },
    );

    // Off the caller's path (void-dispatched) — wait for it, do not assume.
    await vi.waitFor(() => expect(edits()).toHaveLength(2), { timeout: 5_000 });
    const byChat = new Map(edits().map((e) => [e.body.chat_id, e.body]));
    expect(byChat.get(901)).toMatchObject({ message_id: 11 });
    expect(byChat.get(902)).toMatchObject({ message_id: 22 });
    const L = notificationLabels('uz');
    for (const body of byChat.values()) {
      const text = String(body.text);
      expect(text).toMatch(/^<b>🔐 /);
      expect(text).toContain(`✅ ${L.debtApprovalYes} — ${first.name}`);
      // The link is the button, and the button survives; «Ruxsat / Yo‘q» go.
      expect(text).not.toContain('/approvals');
      expect(body.reply_markup).toEqual({
        inline_keyboard: [[{ text: '↗️ Ochish', url: `${APP}/approvals` }]],
      });
    }
  });

  it('a copy the drain never sent (no `tg`) is left alone — there is no message to edit', async () => {
    const decider = await mintStaff({ decider: true });
    const approvalId = await mintApproval(decider.id);
    const [row] = await db
      .insert(notifications)
      .values({
        userId: decider.id,
        channel: 'telegram',
        type: 'DebtApprovalRequested',
        status: 'muted',
        payload: { approvalId, clientCode: 'GS1', clientName: 'X', warehouseCode: 'T', blockingDebtUsd: 1 },
      })
      .returning({ id: notifications.id });
    rowsMade.push(row!.id);
    await decideIssueApproval({ approvalId, verdict: 'refused' }, { actorId: decider.id, ip: null, userAgent: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(edits()).toHaveLength(0);
  });

  it('a copy still WAITING to be sent is never sent after the decision (STAFF-APPROVAL-UNSENT-COPY)', async () => {
    // The drain was paused (a 429, a 5xx backoff, a token being rotated) when
    // somebody decided on the web: this copy would have gone out afterwards
    // with live «Ruxsat / Yo‘q» buttons nothing would ever retire.
    const decider = await mintStaff({ decider: true });
    const approvalId = await mintApproval(decider.id);
    const [row] = await db
      .insert(notifications)
      .values({
        userId: decider.id,
        channel: 'telegram',
        type: 'DebtApprovalRequested',
        status: 'pending',
        payload: { approvalId, clientCode: 'GS1', clientName: 'X', warehouseCode: 'T', blockingDebtUsd: 1 },
      })
      .returning({ id: notifications.id });
    rowsMade.push(row!.id);
    await decideIssueApproval({ approvalId, verdict: 'refused' }, { actorId: decider.id, ip: null, userAgent: null });
    await vi.waitFor(
      async () => {
        const [after] = await db.select().from(notifications).where(eq(notifications.id, row!.id));
        expect(after).toMatchObject({ status: 'muted', error: 'decided before it was sent' });
      },
      { timeout: 5_000 },
    );
  });

  it('two deciders at once: ONE answer stands, the other hears «already decided»', async () => {
    const a = await mintStaff({ decider: true });
    const b = await mintStaff({ decider: true });
    const approvalId = await mintApproval(a.id);
    const results = await Promise.allSettled([
      decideIssueApproval({ approvalId, verdict: 'approved' }, { actorId: a.id, ip: null, userAgent: null }),
      decideIssueApproval({ approvalId, verdict: 'refused' }, { actorId: b.id, ip: null, userAgent: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ApprovalError);
    expect((lost.reason as ApprovalError).code).toBe('already_decided');
    const [row] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, approvalId));
    const winner = results[0]!.status === 'fulfilled' ? a.id : b.id;
    expect(row!.decidedBy).toBe(winner);
  });

  it('the PRESSED copy is settled even when somebody else decided first', async () => {
    const decider = await mintStaff({ decider: true });
    const approvalId = await mintApproval(decider.id);
    await decideIssueApproval({ approvalId, verdict: 'refused' }, { actorId: decider.id, ip: null, userAgent: null });
    calls = [];
    await settlePressedApproval(
      903n,
      {
        messageId: 33,
        text: '🔐 So‘rov: qarzdorga yuk berish\nMijoz: GS301 (Aziz <3>)',
        markup: {
          inline_keyboard: [
            [
              { text: '✅ Ruxsat', callback_data: `a:1:${approvalId}` },
              { text: '⛔ Yo‘q', callback_data: `a:0:${approvalId}` },
            ],
            [{ text: '↗️ Ochish', url: `${APP}/approvals` }],
          ],
        },
      },
      approvalId,
      'uz',
    );
    const [edit] = edits();
    expect(edit!.body).toMatchObject({ chat_id: 903, message_id: 33 });
    expect(String(edit!.body.text)).toBe(
      `<b>🔐 So‘rov: qarzdorga yuk berish</b>\nMijoz: GS301 (Aziz &lt;3&gt;)\n\n⛔ ${notificationLabels('uz').debtApprovalNo} — ${decider.name}`,
    );
    expect(edit!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '↗️ Ochish', url: `${APP}/approvals` }]] });
  });
});

describe('a closed task rewrites the message its «✅» sat on', () => {
  const TASK = '11111111-2222-4333-8444-555555555555';

  it('a task\'s own message becomes its record — typed text stays escaped, the link stays', async () => {
    await closeTaskMessage(
      904n,
      {
        taskId: TASK,
        origin: {
          messageId: 44,
          kind: 'single',
          text: '🆕 Yangi vazifa: <a href="https://evil.example">bos</a>\n📅 30.09',
          markup: {
            inline_keyboard: [
              [{ text: '✅ Bajarildi', callback_data: `t:${TASK}` }],
              [{ text: '↗️ Ochish', url: `${APP}/bugun` }],
            ],
          },
        },
      },
      'qildim <b>tayyor</b>',
    );
    const [edit] = edits();
    expect(edit!.body).toMatchObject({ chat_id: 904, message_id: 44, parse_mode: 'HTML' });
    expect(String(edit!.body.text)).toBe(
      '<b>🆕 Yangi vazifa: &lt;a href="https://evil.example"&gt;bos&lt;/a&gt;</b>\n📅 30.09' +
        '\n\n✅ Yopildi — qildim &lt;b&gt;tayyor&lt;/b&gt;',
    );
    expect(edit!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '↗️ Ochish', url: `${APP}/bugun` }]] });
  });

  it('a list keeps its text and loses exactly that task\'s row', async () => {
    const other = '99999999-2222-4333-8444-555555555555';
    await closeTaskMessage(
      905n,
      {
        taskId: TASK,
        origin: {
          messageId: 55,
          kind: 'list',
          text: '✅ Sizning vazifalaringiz',
          markup: {
            inline_keyboard: [
              [{ text: '✅ A', callback_data: `tb:${TASK}` }],
              [{ text: '✅ B', callback_data: `tb:${other}` }],
            ],
          },
        },
      },
      '',
    );
    expect(calls.map((c) => c.method)).toEqual(['editMessageReplyMarkup']);
    expect(calls[0]!.body).toEqual({
      chat_id: 905,
      message_id: 55,
      reply_markup: { inline_keyboard: [[{ text: '✅ B', callback_data: `tb:${other}` }]] },
    });
  });

  it('a press with no message to go back to (an old client) changes nothing', async () => {
    await closeTaskMessage(906n, { taskId: TASK, origin: null }, 'x');
    expect(calls).toHaveLength(0);
  });
});

describe('the tasks behind the buttons', () => {
  it('a HANDED-ON task arrives with «✅ Bajarildi» too', async () => {
    const author = await mintStaff();
    const first = await mintStaff();
    const next = await mintStaff();
    const task = await createTask(
      {
        title: `Uzatiladigan ${STAMP}`,
        assigneeId: first.id,
        typeId: null,
        entityType: null,
        entityId: null,
        dueAt: '2027-01-01',
        priority: 2,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId: author.id },
    );
    taskIds.push(task.id);
    await reassignTask(task.id, next.id, {
      actorId: first.id,
      ip: null,
      userAgent: null,
      actor: { id: first.id, permissions: new Set() },
    });
    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, next.id), eq(notifications.type, 'TaskAssigned')));
    expect((row!.payload as { taskId?: string }).taskId).toBe(task.id);
    expect((row!.payload as { text: string }).text).toMatch(/📅 01\.01(\.2027)?\n/);
  });

  it('the day names overdue first, at most eight, with the ids its buttons close', async () => {
    const me = await mintStaff();
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const make = async (title: string, due: string) => {
      const t = await createTask(
        {
          title,
          assigneeId: me.id,
          typeId: null,
          entityType: null,
          entityId: null,
          dueAt: due,
          priority: 2,
          repeatUnit: null,
          repeatEvery: 1,
        },
        { actorId: me.id },
      );
      taskIds.push(t.id);
      return t.id;
    };
    const today: string[] = [];
    for (let i = 0; i < 7; i += 1) today.push(await make(`Bugun ${i}`, day(0)));
    const late = [await make('Kechikkan A', day(-2)), await make('Kechikkan B', day(-3))];

    const composed = (await composeMyDay(me.id))!;
    expect(composed.tasks).toHaveLength(8);
    // Latest overdue first, as the text lists them.
    expect(composed.tasks.slice(0, 2).map((t) => t.id)).toEqual(late);
    expect(composed.tasks.slice(2).every((t) => today.includes(t.id))).toBe(true);
    expect(composed.text).toContain('🔴 Kechikkan (2)');
    expect(composed.text).toMatch(/Kechikkan A ⚠️ \d{2}\.\d{2}/);
  });
});
