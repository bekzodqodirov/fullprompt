import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  issueApprovals,
  permissions,
  rolePermissions,
  tasks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { createTask } from '@/modules/platform/tasks/service';
import {
  buttonsFor,
  completeTaskFromBot,
  decideApprovalFromBot,
  linkStaffChat,
  noteStaffEntry,
  parseCallback,
  staffByPhone,
  staffForChat,
  staffPhonesMatch,
  takeStaffEntry,
} from '@/modules/platform/telegram/staff-bot';

/**
 * The staff bot's decisions (round 35). The grammy handlers cannot run
 * without a live Telegram, so — the tg-import split — everything the bot
 * DECIDES is exercised here through the same functions the buttons call.
 */

const STAMP = String(Date.now()).slice(-7);
let actorId: string;

/** A fresh employee with a unique phone, linked (or not) to a unique chat. */
async function mintStaff(opts: { active?: boolean } = {}) {
  const phone = `+99893${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-7)}`;
  const [user] = await db
    .insert(users)
    .values({
      phone,
      fullName: `Bot xodim ${STAMP}`,
      passwordHash: 'x',
      active: opts.active ?? true,
    })
    .returning();
  return user!;
}

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('who is behind a chat', () => {
  it('matches a Telegram-shared phone against the employee list, formats and all', async () => {
    const person = await mintStaff();
    // The contact arrives without the plus and sometimes without the country
    // code — the login phone still has to match.
    expect((await staffByPhone(person.phone.replace('+', '')))?.id).toBe(person.id);
    expect((await staffByPhone(person.phone.slice(-9)))?.id).toBe(person.id);

    // Someone who left the company is not staff, whatever their phone says.
    const gone = await mintStaff({ active: false });
    expect(await staffByPhone(gone.phone)).toBeNull();

    expect(staffPhonesMatch('+998 90 175-78-00', '901757800')).toBe(true);
    expect(staffPhonesMatch('12345', '12345')).toBe(false);
  });

  it('links a chat, resolves it back, and refuses a chat another colleague holds', async () => {
    const a = await mintStaff();
    const b = await mintStaff();
    const chat = BigInt(Date.now()) * 100n + 1n;

    expect(await linkStaffChat(a.id, chat)).toBe('linked');
    expect((await staffForChat(chat))?.id).toBe(a.id);

    // Two people cannot share one Telegram.
    expect(await linkStaffChat(b.id, chat)).toBe('chat_taken');

    // Re-linking your OWN account to a new phone just moves the row.
    const newChat = chat + 1n;
    expect(await linkStaffChat(a.id, newChat)).toBe('linked');
    expect((await staffForChat(newChat))?.id).toBe(a.id);
  });

  it('the «Hodim» intent is one-shot — a customer contact never staff-links', async () => {
    const chat = BigInt(Date.now()) * 100n + 7n;
    expect(takeStaffEntry(chat)).toBe(false);
    noteStaffEntry(chat);
    expect(takeStaffEntry(chat)).toBe(true);
    expect(takeStaffEntry(chat)).toBe(false);
  });
});

describe('callback data', () => {
  it('round-trips the three shapes and refuses junk', () => {
    expect(parseCallback('e:s')).toEqual({ kind: 'entry', who: 'staff' });
    expect(parseCallback('e:c')).toEqual({ kind: 'entry', who: 'client' });
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    expect(parseCallback(`t:${id}`)).toEqual({ kind: 'task_done', taskId: id });
    expect(parseCallback(`a:1:${id}`)).toEqual({
      kind: 'approval',
      approvalId: id,
      verdict: 'approved',
    });
    expect(parseCallback(`a:0:${id}`)).toEqual({
      kind: 'approval',
      approvalId: id,
      verdict: 'refused',
    });
    expect(parseCallback('nonsense')).toBeNull();
    expect(parseCallback('t:short')).toBeNull();
  });

  it('a task lands with its button, a debtor request with both, the rest with none', () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    expect(buttonsFor('TaskAssigned', { taskId: id, text: 'x' })).toEqual([
      [{ text: '✅ Bajarildi', callback_data: `t:${id}` }],
    ]);
    expect(buttonsFor('DebtApprovalRequested', { approvalId: id })).toHaveLength(1);
    expect(buttonsFor('TaskAssigned', { text: 'no id' })).toBeNull();
    expect(buttonsFor('ReceiptConfirmed', { receiptId: id })).toBeNull();
  });
});

describe('closing a task from the button', () => {
  it('the assignee closes with a result; strangers and re-presses are refused', async () => {
    const assignee = await mintStaff();
    const chat = BigInt(Date.now()) * 100n + 21n;
    await linkStaffChat(assignee.id, chat);

    const task = await createTask(
      {
        title: `Bot vazifa ${STAMP}`,
        assigneeId: assignee.id,
        typeId: null,
        entityType: null,
        entityId: null,
        priority: 2,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId },
    );

    expect(await completeTaskFromBot(chat, task.id, 'qilindi')).toBe('done');
    const after = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(after!.status).toBe('done');
    expect(after!.result).toBe('qilindi');
    expect(after!.doneBy).toBe(assignee.id);

    expect(await completeTaskFromBot(chat, task.id, 'yana')).toBe('already_closed');

    // Somebody ELSE's task: the chat's identity is honest, so the service's
    // own rule refuses it.
    const other = await createTask(
      {
        title: `Begona ${STAMP}`,
        assigneeId: actorId,
        typeId: null,
        entityType: null,
        entityId: null,
        priority: 2,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId },
    );
    expect(await completeTaskFromBot(chat, other.id, 'x')).toBe('not_yours');

    // An unlinked chat is nobody.
    expect(await completeTaskFromBot(chat + 999n, other.id, 'x')).toBe('not_linked');
  });
});

describe('deciding a debtor request from the button', () => {
  async function mintApproval() {
    const wh = (await db.select().from(warehouses).limit(1))[0]!;
    const [client] = await db
      .insert(clients)
      .values({ clientCode: `BA${String(Date.now()).slice(-6)}`, name: 'Bot approval client' })
      .returning();
    const [row] = await db
      .insert(issueApprovals)
      .values({
        clientId: client!.id,
        warehouseId: wh.id,
        blockingDebtUsd: '100.00',
        requestedBy: actorId,
      })
      .returning();
    return row!;
  }

  it('the grant decides, the chat only identifies', async () => {
    const plain = await mintStaff();
    const plainChat = BigInt(Date.now()) * 100n + 31n;
    await linkStaffChat(plain.id, plainChat);
    const approval = await mintApproval();

    // No finance.debt_override → the button answers "not your call".
    expect(await decideApprovalFromBot(plainChat, approval.id, 'approved')).toBe('forbidden');

    // Give the SAME person the grant (through a role that holds it — grants
    // are editable data, #170) and the button starts working.
    const [grantRole] = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(permissions.code, 'finance.debt_override'))
      .limit(1);
    await db.insert(userRoles).values({ userId: plain.id, roleId: grantRole!.roleId });

    expect(await decideApprovalFromBot(plainChat, approval.id, 'approved')).toBe('decided');
    const decided = await db.query.issueApprovals.findFirst({
      where: eq(issueApprovals.id, approval.id),
    });
    expect(decided!.status).toBe('approved');
    expect(decided!.decidedBy).toBe(plain.id);

    // Single-shot, like the web screen.
    expect(await decideApprovalFromBot(plainChat, approval.id, 'refused')).toBe('already_decided');
    expect(await decideApprovalFromBot(plainChat + 999n, approval.id, 'refused')).toBe(
      'not_linked',
    );
  });
});
