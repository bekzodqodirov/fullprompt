import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  expenseCategories,
  expenses,
  moneyAccounts,
  notifications,
  recurringExpenses,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
  userWarehouses,
} from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { findUserByIdentifier } from '@/modules/platform/auth/identify';
import {
  activeNoLoginPeople,
  createLogin,
  editNoLoginPerson,
  enableLogin,
  mintNoLoginPerson,
  setNoLoginPersonActive,
  toggleUserActive,
  updateLogin,
  UserWriteError,
} from '@/modules/platform/users/service';
import { staffByPhone, staffForChat } from '@/modules/platform/telegram/staff-bot';
import { assignablePeople } from '@/modules/platform/tasks/view';
import { createTask, reassignTask } from '@/modules/platform/tasks/service';
import { notifyStaffTelegram } from '@/modules/platform/notifications/staff';
import { usersWithPermission, usersWithRoles } from '@/modules/platform/notifications/service';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { shareTargets } from '@/modules/wms/crm/share';
import { createRoute, nextInboundOwner, rotaMembers, setRotaMembers } from '@/modules/wms/crm/routing';
import { saveSiteTeams, sitePanel } from '@/modules/wms/crm/site-assign';
import {
  listExpenses,
  saveAccount,
  saveCategory,
  saveRecurring,
  updateRecurring,
  voidExpense,
} from '@/modules/wms/accounting/service';
import { payRecurring, recurringDue } from '@/modules/wms/accounting/recurring';
import { owedEmployeeIds, staffTemplates } from '@/modules/wms/staff/salary';
import { visibleStaff } from '@/modules/wms/staff/visible';

/**
 * A person who is paid here and never signs in (0120, the owner's 2b: a
 * worker in a Chinese warehouse) against a real database.
 *
 *  A — the ONE writer (platform/users/service.ts) and the four CHECKs: mint,
 *      same-name named, phones, the database's own refusals, the roles door
 *      refusing a no-login row, the super_admin rule in the writer, and the
 *      conversion to a login in ONE transaction.
 *  B — the salary chain is the ordinary one, and «still owed» is the due
 *      list's own set: pay → stop → void re-lists the leaver.
 *  C — nobody treats them as a colleague, EVEN with the flags forced on:
 *      staff bot, tasks, mentions, share, the rota, the website roster,
 *      role-keyed lists and the Telegram queue.
 *
 * CONFIGURATION put back (#183, #653): `inbound_rota` is a GLOBAL flag — the
 * ids that carried it are snapshotted ONCE in beforeAll (#716), every flag
 * is cleared for the rota test and restored at the end. This file's own
 * kassa and kind are removed (or retired when something still points at
 * them). Every person row it minted is DEACTIVATED, never deleted: the audit
 * log points at them (audit_log's FK).
 */

// A counter at the FRONT (#598, #661): the slice would otherwise eat it.
let seq = 0;
const STAMP = String(Date.now()).slice(-6);
const nextN = () => (seq += 1);
const TODAY = tashkentDay();
const MONTH = TODAY.slice(0, 7);
const SETTINGS_ENTITY_ID = '00000000-0000-0000-0000-000000000001'; // routing.ts's own, not exported

let actorId = '';
let actorName = '';
let actorPhone = '';
let l2Id = '';
let l2Username = '';
let viewerRoleId = '';
let adminRoleId = '';
let superAdminRoleId = '';
let cat = '';
let catName = '';
let till = '';
let tillName = '';
const madeUsers: string[] = [];
const templates: string[] = [];
let previouslyFlagged: string[] = [];
const ctx = () => ({ actorId, ip: null, userAgent: null });
const chatId = BigInt(`9${STAMP}${String(Date.now()).slice(-3)}`);

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
};
const pgConstraint = (err: unknown): string | undefined => {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return e?.constraint_name ?? e?.cause?.constraint_name;
};

async function rejectsWith(p: Promise<unknown>, code: string): Promise<UserWriteError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(UserWriteError);
  expect((err as UserWriteError).code).toBe(code);
  return err as UserWriteError;
}

async function row(id: string) {
  const [r] = await db.select().from(users).where(eq(users.id, id));
  return r!;
}

async function roleCount(id: string): Promise<number> {
  return (await db.select({ id: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id))).length;
}

async function warehouseCount(id: string): Promise<number> {
  return (await db.select({ id: userWarehouses.warehouseId }).from(userWarehouses).where(eq(userWarehouses.userId, id)))
    .length;
}

async function mint(name: string, phone = '', confirmSameName = false): Promise<string> {
  const { id } = await mintNoLoginPerson({ fullName: name, phone, confirmSameName }, ctx());
  madeUsers.push(id);
  return id;
}

beforeAll(async () => {
  actorName = `Hodim aktor ${STAMP}`;
  actorPhone = `+99897${STAMP}01`;
  const [actor] = await db
    .insert(users)
    .values({ fullName: actorName, phone: actorPhone, passwordHash: 'x' })
    .returning({ id: users.id });
  actorId = actor!.id;
  madeUsers.push(actorId);
  l2Username = `+99896${STAMP}77`;
  const [l2] = await db
    .insert(users)
    .values({ fullName: `Hodim L2 ${STAMP}`, phone: `+99896${STAMP}78`, username: l2Username, passwordHash: 'x' })
    .returning({ id: users.id });
  l2Id = l2!.id;
  madeUsers.push(l2Id);

  viewerRoleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'viewer')))[0]!.id;
  adminRoleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'admin')))[0]!.id;
  superAdminRoleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'super_admin')))[0]!.id;

  catName = `Oylik ${STAMP}`;
  cat = (await saveCategory({ name: catName, cash: true, sortOrder: 950, active: true }, ctx())).id;
  tillName = `Hodim kassa ${STAMP}`;
  till = (
    await saveAccount(
      { name: tillName, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 950, active: true },
      ctx(),
    )
  ).id;

  previouslyFlagged = (
    await db.select({ id: users.id }).from(users).where(eq(users.inboundRota, true))
  ).map((r) => r.id);
});

afterAll(async () => {
  try {
    if (!actorId) return;
    const ids = madeUsers.length ? madeUsers : [actorId];
    // Money first, in FK order: this file's postings and templates.
    const tpl = await db
      .select({ id: recurringExpenses.id })
      .from(recurringExpenses)
      .where(inArray(recurringExpenses.employeeId, ids));
    const tplIds = [...new Set([...templates, ...tpl.map((r) => r.id)])];
    if (tplIds.length) {
      await db.delete(expenses).where(inArray(expenses.recurringId, tplIds));
      await db.execute(sql`DELETE FROM recurring_skips WHERE recurring_id IN (${sql.join(
        tplIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
      await db.delete(recurringExpenses).where(inArray(recurringExpenses.id, tplIds));
    }
    await db.delete(expenses).where(inArray(expenses.employeeId, ids));
    await db.delete(tasks).where(inArray(tasks.createdBy, ids));
    await db.delete(notifications).where(inArray(notifications.userId, ids));
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, ids));
    // Roles by the STAMP as well as by the ids this file collected: a login a
    // red proof let through (a refusal turned into a success) was never
    // collected, and a leftover super_admin grant is CONFIGURATION (#523).
    const stamped = sql`(SELECT id FROM users WHERE full_name LIKE ${`%${STAMP}%`})`;
    await db.delete(userRoles).where(sql`${userRoles.userId} IN ${stamped} OR ${inArray(userRoles.userId, ids)}`);
    await db
      .delete(userWarehouses)
      .where(sql`${userWarehouses.userId} IN ${stamped} OR ${inArray(userWarehouses.userId, ids)}`);
    // The global flag: this file's forced ones off, the snapshot back on.
    await db.update(users).set({ inboundRota: false, leadTeams: sql`'{}'::text[]` }).where(inArray(users.id, ids));
    if (previouslyFlagged.length) {
      await db.update(users).set({ inboundRota: true }).where(inArray(users.id, previouslyFlagged));
    }
    // Every row this file minted, and any a failed run left behind under the
    // same stamp: deactivated, never deleted (the audit log points at them).
    await db
      .update(users)
      .set({ active: false })
      .where(sql`${users.fullName} LIKE ${`%${STAMP}%`}`);
    if (cat) {
      await db
        .delete(expenseCategories)
        .where(eq(expenseCategories.id, cat))
        .catch(() => db.update(expenseCategories).set({ active: false }).where(eq(expenseCategories.id, cat)));
    }
    if (till) {
      await db
        .delete(moneyAccounts)
        .where(eq(moneyAccounts.id, till))
        .catch(() => db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, till)));
    }
  } finally {
    await pgClient.end();
  }
});

describe('A — the writer and the database', () => {
  let p1 = '';

  it('mints a person who never signs in: collapsed name, cleaned phone, no credential, no role, one audit row', async () => {
    p1 = await mint(`  Xitoy  ishchi ${STAMP} `, `+86 139-${STAMP.slice(0, 3)} (${STAMP.slice(3)}) 5`);
    const r = await row(p1);
    expect(r.fullName).toBe(`Xitoy ishchi ${STAMP}`);
    expect(r.phone).toBe(`+86139${STAMP}5`);
    expect(r.loginEnabled).toBe(false);
    expect(r.passwordHash).toBeNull();
    expect(r.username).toBeNull();
    expect(await roleCount(p1)).toBe(0);
    expect(await warehouseCount(p1)).toBe(0);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, p1), eq(auditLog.action, 'create')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ loginEnabled: false, phone: `+86139${STAMP}5` });
  });

  it('a blank phone is NULL, and two blank-phone people coexist', async () => {
    const a = await mint(`Telefonsiz A ${STAMP}`);
    const b = await mint(`Telefonsiz B ${STAMP}`);
    expect((await row(a)).phone).toBeNull();
    expect((await row(b)).phone).toBeNull();
  });

  it('a name already listed is NAMED — whoever holds it, logins included — and a second press mints', async () => {
    const err = await rejectsWith(
      mintNoLoginPerson({ fullName: `xitoy   ISHCHI ${STAMP}`, phone: '', confirmSameName: false }, ctx()),
      'same_name',
    );
    expect(err.same!.total).toBeGreaterThanOrEqual(1);
    expect(err.same!.matches[0]).toMatchObject({ id: p1, active: true, loginEnabled: false });

    const own = await rejectsWith(
      mintNoLoginPerson({ fullName: actorName, phone: '', confirmSameName: false }, ctx()),
      'same_name',
    );
    expect(own.same!.matches.find((m) => m.id === actorId)).toMatchObject({ loginEnabled: true });

    const twin = await mint(`Xitoy ishchi ${STAMP}`, '', true);
    expect(twin).not.toBe(p1);
  });

  it('a phone somebody holds is refused — as a phone OR as a login name — and a non-phone is refused', async () => {
    await rejectsWith(
      mintNoLoginPerson({ fullName: `Tel band ${STAMP}`, phone: actorPhone, confirmSameName: true }, ctx()),
      'phone_exists',
    );
    // A payroll phone equal to a login's USERNAME would shadow it in the login box.
    await rejectsWith(
      mintNoLoginPerson({ fullName: `Tel nom ${STAMP}`, phone: l2Username, confirmSameName: true }, ctx()),
      'phone_exists',
    );
    for (const phone of ['abc', '123456', '1234567890123456']) {
      await rejectsWith(
        mintNoLoginPerson({ fullName: `Tel yomon ${STAMP}`, phone, confirmSameName: true }, ctx()),
        'bad_phone',
      );
    }
  });

  it('an empty name and a too-long one are two different refusals — at mint and at edit', async () => {
    const long = `Juda uzun ism ${STAMP} `.padEnd(201, 'x');
    await rejectsWith(mintNoLoginPerson({ fullName: '   ', phone: '', confirmSameName: true }, ctx()), 'name_required');
    await rejectsWith(mintNoLoginPerson({ fullName: long, phone: '', confirmSameName: true }, ctx()), 'name_too_long');
    expect(await db.select().from(users).where(eq(users.fullName, long))).toHaveLength(0);
    // Exactly 200 after the collapse is a name.
    const p = await mint(`Chegara ${STAMP} `.padEnd(200, 'y'));
    await rejectsWith(editNoLoginPerson(p, { fullName: long, phone: '' }, ctx()), 'name_too_long');
    expect((await row(p)).fullName).toHaveLength(200);
  });

  it('the database refuses the impossible shapes, by constraint name', async () => {
    const cases: [string, Partial<typeof users.$inferInsert>][] = [
      ['users_login_password_check', { loginEnabled: false, passwordHash: 'x' }],
      ['users_login_phone_check', { loginEnabled: true, passwordHash: 'x', phone: null }],
      ['users_login_username_check', { loginEnabled: false, passwordHash: null, username: `u${STAMP}${nextN()}` }],
      ['users_login_pin_check', { loginEnabled: false, passwordHash: null, quickPinHash: 'x' }],
    ];
    for (const [constraint, values] of cases) {
      const err = await db
        .insert(users)
        .values({ fullName: `Shakl ${STAMP}`, phone: null, ...values })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(pgCode(err), constraint).toBe('23514');
      expect(pgConstraint(err)).toBe(constraint);
    }
  });

  it('the roles door refuses a no-login row — no role is written and nothing else moves', async () => {
    const before = await row(p1);
    await rejectsWith(
      updateLogin(
        p1,
        {
          fullName: 'Boshqa ism',
          phone: `+99895${STAMP}11`,
          username: null,
          locale: 'uz',
          roleIds: [viewerRoleId],
          warehouseIds: [],
          passwordHash: null,
        },
        ['super_admin'],
        ctx(),
      ),
      'no_login_row',
    );
    expect(await roleCount(p1)).toBe(0);
    const after = await row(p1);
    expect(after.fullName).toBe(before.fullName);
    expect(after.phone).toBe(before.phone);
    expect(after.loginEnabled).toBe(false);
  });

  it('the no-login doors refuse a login', async () => {
    await rejectsWith(editNoLoginPerson(actorId, { fullName: 'X', phone: '' }, ctx()), 'is_login');
    await rejectsWith(setNoLoginPersonActive(actorId, false, ctx()), 'is_login');
    const r = await row(actorId);
    expect(r.fullName).toBe(actorName);
    expect(r.active).toBe(true);
  });

  it('«Ishdan ketdi» and back: one audit row each, a repeat writes nothing; the admin toggle never flips yourself', async () => {
    const p = await mint(`Ketadigan ${STAMP}`);
    const count = async () =>
      (await db.select().from(auditLog).where(and(eq(auditLog.entityId, p), eq(auditLog.action, 'update')))).length;
    await setNoLoginPersonActive(p, false, ctx());
    expect((await row(p)).active).toBe(false);
    expect(await count()).toBe(1);
    await setNoLoginPersonActive(p, false, ctx());
    expect(await count()).toBe(1);
    await setNoLoginPersonActive(p, true, ctx());
    expect((await row(p)).active).toBe(true);
    expect(await count()).toBe(2);

    await toggleUserActive(actorId, actorId, ctx());
    expect((await row(actorId)).active).toBe(true);
  });

  it('super_admin is a super_admin’s move — asked by the ONE writer, and a refusal rolls the person back', async () => {
    const phone = `+99894${STAMP}${String(nextN()).padStart(2, '0')}`;
    const input = {
      fullName: `Super ${STAMP}`,
      phone,
      username: null,
      locale: 'uz' as const,
      roleIds: [superAdminRoleId],
      warehouseIds: [],
      passwordHash: 'x',
    };
    await rejectsWith(createLogin(input, ['admin'], ctx()), 'super_admin_locked');
    expect(await db.select().from(users).where(eq(users.phone, phone))).toHaveLength(0);

    const { id } = await createLogin(input, ['super_admin'], ctx());
    madeUsers.push(id);
    expect(await roleCount(id)).toBe(1);
    await rejectsWith(
      updateLogin(id, { ...input, roleIds: [viewerRoleId], passwordHash: null }, ['admin'], ctx()),
      'super_admin_locked',
    );
    const held = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, id));
    expect(held.map((r) => r.roleId)).toEqual([superAdminRoleId]);
  });

  describe('«Tizimga kirish ochish» — the one door to a login', () => {
    let q = '';
    const newPhone = `+99893${STAMP}55`;
    const base = () => ({
      phone: newPhone,
      username: null,
      locale: 'uz' as const,
      passwordHash: 'hash',
      roleIds: [viewerRoleId],
      warehouseIds: [] as string[],
    });

    beforeAll(async () => {
      q = await mint(`Kiradigan ${STAMP}`, `+86139${STAMP}9`);
    });

    it('refuses an inactive person', async () => {
      const gone = await mint(`Ketgan ${STAMP}`);
      await setNoLoginPersonActive(gone, false, ctx());
      await rejectsWith(enableLogin(gone, base(), ['super_admin'], ctx()), 'inactive_person');
    });

    it('refuses an empty phone', async () => {
      await rejectsWith(enableLogin(q, { ...base(), phone: '' }, ['super_admin'], ctx()), 'bad_phone');
    });

    it('refuses a phone another row holds — exactly, or by the staff bot’s last nine digits', async () => {
      await rejectsWith(enableLogin(q, { ...base(), phone: actorPhone }, ['super_admin'], ctx()), 'phone_exists');
      // The actor's number typed the way a person types it: spaces, no country code.
      const spaced = `97 ${STAMP.slice(0, 3)} ${STAMP.slice(3)} 01`;
      await rejectsWith(enableLogin(q, { ...base(), phone: spaced }, ['super_admin'], ctx()), 'phone_exists');
      const r = await row(q);
      expect(r.loginEnabled).toBe(false);
      expect(r.phone).toBe(`+86139${STAMP}9`);
    });

    it('refuses a phone that is another login’s USERNAME — the login box would hand that login to this person', async () => {
      // identify.ts reads the phone first: a new login whose phone is L2's
      // username would silently take L2's sign-in over (the review's F2).
      const r0 = await mint(`Nom telefon ${STAMP}`);
      await rejectsWith(enableLogin(r0, { ...base(), phone: l2Username }, ['super_admin'], ctx()), 'phone_exists');
      const r = await row(r0);
      expect(r.loginEnabled).toBe(false);
      expect(r.passwordHash).toBeNull();
      expect((await findUserByIdentifier(l2Username))?.id).toBe(l2Id);
    });

    it('is ONE transaction — a failure in the roles step leaves the person exactly as they were', async () => {
      const err = await enableLogin(q, { ...base(), warehouseIds: [randomUUID()] }, ['super_admin'], ctx()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgCode(err)).toBe('23503');
      const r = await row(q);
      expect(r.loginEnabled).toBe(false);
      expect(r.passwordHash).toBeNull();
      expect(r.phone).toBe(`+86139${STAMP}9`);
      expect(await roleCount(q)).toBe(0);
    });

    it('gives the login: phone, hash, roles, and ONE audit row carrying the payroll phone it replaced', async () => {
      const auditsBefore = (
        await db.select().from(auditLog).where(and(eq(auditLog.entityId, q), eq(auditLog.action, 'update')))
      ).length;
      await enableLogin(q, base(), ['super_admin'], ctx());
      const r = await row(q);
      expect(r.loginEnabled).toBe(true);
      expect(r.passwordHash).toBe('hash');
      expect(r.phone).toBe(newPhone);
      expect(await roleCount(q)).toBe(1);
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, q), eq(auditLog.action, 'update')));
      expect(audits).toHaveLength(auditsBefore + 1);
      const last = audits.find((a) => (a.after as Record<string, unknown> | null)?.loginEnabled === true)!;
      expect(last.before).toMatchObject({ phone: `+86139${STAMP}9`, loginEnabled: false });
      expect(last.after).toMatchObject({ phone: newPhone, loginEnabled: true, roles: ['viewer'] });
    });

    it('a second press is refused — and the no-login doors are closed to it now', async () => {
      await rejectsWith(enableLogin(q, base(), ['super_admin'], ctx()), 'already_login');
      await rejectsWith(editNoLoginPerson(q, { fullName: 'X', phone: '' }, ctx()), 'is_login');
    });

    it('the login box finds it by its new phone', async () => {
      expect((await findUserByIdentifier(newPhone))?.id).toBe(q);
    });
  });

  it('/admin/users/new lists the active no-login people only', async () => {
    const active = await mint(`Royxat faol ${STAMP}`);
    const gone = await mint(`Royxat ketgan ${STAMP}`);
    await setNoLoginPersonActive(gone, false, ctx());
    const list = (await activeNoLoginPeople()).map((p) => p.id);
    expect(list).toContain(active);
    expect(list).not.toContain(gone);
    expect(list).not.toContain(actorId);
  });
});

describe('B — the salary chain, unchanged, and «still owed» is the due list’s', () => {
  let p2 = '';
  let recurringId = '';
  let expenseId = '';

  it('a salary on a no-login person is saved, owed, paid and named like anybody’s', async () => {
    p2 = await mint(`Oylikli ${STAMP}`);
    const tpl = await saveRecurring(
      {
        employeeId: p2,
        categoryId: cat,
        amount: 100,
        currency: 'USD',
        dayOfMonth: 1,
        firstMonth: 'this',
        accountId: till,
        partnerId: '',
        warehouseId: '',
        note: '',
        active: true,
      },
      ctx(),
    );
    recurringId = tpl.id;
    templates.push(recurringId);
    const waiting = await staffTemplates(db, { today: TODAY, salaryCategoryId: cat, userId: p2 });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ salary: true, state: 'waiting' });

    const paid = await payRecurring(
      { recurringId, month: MONTH, payer: `till:${till}`, amount: 100, expenseDate: TODAY },
      ctx(),
    );
    expenseId = paid.id;
    expect(paid.employeeId).toBe(p2);
    const listed = await listExpenses({ from: TODAY, to: TODAY, categoryId: cat });
    expect(listed.find((r) => r.expense.id === expenseId)?.expense.employeeId).toBe(p2);
    expect((await staffTemplates(db, { today: TODAY, salaryCategoryId: cat, userId: p2 }))[0]!.state).toBe('paid');
  });

  it('pay → stop → leave: nobody owes; void the payment: the due list re-opens the month and /hodimlar lists him again', async () => {
    await updateRecurring(recurringId, { amount: 100, dayOfMonth: 1, active: false }, ctx());
    await setNoLoginPersonActive(p2, false, ctx());
    const view = [{ id: p2, active: false }];
    const empty = {
      hodim: null,
      kpiLineIds: new Set<string>(),
      payables: new Map<string, { payableUsd: number; overpaidUsd: number }>(),
      kpiFailed: false,
      kpiSellers: new Set<string>(),
    };

    const owedBefore = await owedEmployeeIds(db, TODAY);
    expect(owedBefore.has(p2)).toBe(false);
    expect(visibleStaff(view, { ...empty, owed: owedBefore })).toEqual([]);

    await voidExpense(expenseId, 'noto‘g‘ri kassa', ctx());
    const owedAfter = await owedEmployeeIds(db, TODAY);
    expect(owedAfter.has(p2)).toBe(true);
    expect(visibleStaff(view, { ...empty, owed: owedAfter })).toEqual(view);
    // The two readers agree: the due list names that month too.
    const due = (await recurringDue(TODAY)).filter((r) => r.recurringId === recurringId);
    expect(due.map((r) => r.month.slice(0, 7))).toContain(MONTH);
  });

  it('a NEW salary is never minted on a leaver — refused in words; reactivated, the same press saves', async () => {
    // The review's F1: the card drew «Oylik kiritish» on a «faol emas» person,
    // and a template on a leaver falls due every month with nobody to pay.
    const gone = await mint(`Ketgan oylik ${STAMP}`);
    await setNoLoginPersonActive(gone, false, ctx());
    const input = {
      employeeId: gone,
      categoryId: cat,
      amount: 90,
      currency: 'USD',
      dayOfMonth: 1,
      firstMonth: 'next' as const,
      accountId: till,
      partnerId: '',
      warehouseId: '',
      note: '',
      active: true,
    };
    await expect(saveRecurring(input, ctx())).rejects.toMatchObject({ code: 'employee_inactive' });
    const none = await db.select().from(recurringExpenses).where(eq(recurringExpenses.employeeId, gone));
    expect(none).toHaveLength(0);

    await setNoLoginPersonActive(gone, true, ctx());
    const tpl = await saveRecurring(input, ctx());
    templates.push(tpl.id);
    expect(tpl.employeeId).toBe(gone);
  });
});

describe('C — nobody treats them as a colleague, even with the flags forced on', () => {
  let p3 = '';
  let p3Phone = '';

  beforeAll(async () => {
    p3Phone = `+86139${STAMP}7`;
    p3 = await mint(`Bayroqli ${STAMP}`, p3Phone);
    await db
      .update(users)
      .set({ leadTeams: sql`'{cargo}'::text[]`, inboundRota: true })
      .where(eq(users.id, p3));
    await db.insert(telegramLinks).values({ userId: p3, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
    // A ROLE forced on too — past the writer, which refuses it (`no_login_row`):
    // without a grant the role-keyed lists below would leave p3 out whatever
    // their filter said, and the assertions would be vacuous (the review's
    // T2). The seeded admin role holds both `crm.leads` (the seller picker's
    // key) and `finance.expenses`; the grant is checked, not assumed. Swept
    // in afterAll with the ids.
    await db.insert(userRoles).values({ userId: p3, roleId: adminRoleId });
    const granted = await db.execute<{ code: string }>(sql`
      SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ${adminRoleId} AND p.code IN ('crm.leads', 'finance.expenses')`);
    expect([...granted].map((r) => r.code).sort()).toEqual(['crm.leads', 'finance.expenses']);
  });

  it('the staff bot knows them by no phone and no chat — the actor is the control', async () => {
    expect(await staffByPhone(p3Phone)).toBeNull();
    expect((await staffByPhone(actorPhone))?.id).toBe(actorId);
    expect(await staffForChat(chatId)).toBeNull();
  });

  it('no task is given to them — neither by the picker nor by a forged id', async () => {
    expect((await assignablePeople()).map((p) => p.id)).not.toContain(p3);
    const task = {
      title: `Vazifa ${STAMP}`,
      note: '',
      typeId: null,
      dueAt: '',
      tzOffsetMin: null,
      priority: 2,
      entityType: null,
      entityId: null,
      repeatUnit: null,
      repeatEvery: 1,
    };
    await expect(createTask({ ...task, assigneeId: p3 }, ctx(), { origin: 'hand' })).rejects.toMatchObject({ code: 'assignee_no_login' });
    const mine = await createTask({ ...task, assigneeId: actorId }, ctx(), { origin: 'hand' });
    await expect(
      reassignTask(mine.id, p3, { ...ctx(), actor: { id: actorId, permissions: new Set<string>() } }),
    ).rejects.toMatchObject({ code: 'assignee_no_login' });
  });

  it('no mention and no shared message', async () => {
    expect((await mentionablePeople()).map((p) => p.id)).not.toContain(p3);
    expect((await shareTargets(actorId)).map((p) => p.id)).not.toContain(p3);
  });

  it('the rota routes nothing to them, and a press that adds nobody audits nothing', async () => {
    await db.update(users).set({ inboundRota: false }).where(eq(users.inboundRota, true));
    await db.update(users).set({ inboundRota: true }).where(eq(users.id, p3));

    expect((await rotaMembers()).map((m) => m.id)).not.toContain(p3);
    expect(await nextInboundOwner()).toBeNull();
    expect(await nextInboundOwner([p3])).toBeNull();

    const settingsAudits = async () =>
      (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, SETTINGS_ENTITY_ID))).length;
    const before = await settingsAudits();
    await setRotaMembers([p3], ctx());
    expect((await row(p3)).inboundRota).toBe(true);
    expect(await settingsAudits()).toBe(before);

    await expect(createRoute({ sourceKey: null, keyword: null, userIds: [p3] }, ctx())).rejects.toMatchObject({
      code: 'members_required',
    });
  });

  it('the website roster leaves them out, and a forged team entry writes nothing', async () => {
    expect((await sitePanel()).people.map((p) => p.userId)).not.toContain(p3);
    expect(await saveSiteTeams([{ userId: p3, teams: ['general'], username: '' }], ctx())).toEqual({ changed: 0 });
    expect((await row(p3)).leadTeams).toEqual(['cargo']);
  });

  it('no role-keyed list and no Telegram row — while holding the role', async () => {
    // The actor, given the same role for this one assertion, is the control:
    // the lists DO answer holders of it, so p3's absence is the filter's.
    await db.insert(userRoles).values({ userId: actorId, roleId: adminRoleId });
    try {
      expect((await salesManagerOptions()).map((p) => p.id)).toContain(actorId);
      expect(await usersWithPermission('finance.expenses')).toContain(actorId);
      expect(await usersWithRoles(['admin'])).toContain(actorId);
    } finally {
      await db.delete(userRoles).where(and(eq(userRoles.userId, actorId), eq(userRoles.roleId, adminRoleId)));
    }
    expect((await salesManagerOptions()).map((p) => p.id)).not.toContain(p3);
    expect(await usersWithPermission('finance.expenses')).not.toContain(p3);
    expect(await usersWithRoles(['admin'])).not.toContain(p3);
    expect(await notifyStaffTelegram({ userIds: [p3], type: 'TaskAssigned', text: 'x' })).toBe(0);
    expect(await db.select().from(notifications).where(eq(notifications.userId, p3))).toHaveLength(0);
  });
});
