import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { permissions, rolePermissions, roles, userRoles, users } from '@/modules/platform/db/schema';
import {
  RoleError,
  createRole,
  deleteRole,
  grantableBy,
  groupPermissions,
  listRoles,
  renameRole,
  setRoleGrants,
  someoneCanStillManageRoles,
} from '@/modules/platform/rbac/roles';
import { PERMISSION_CODES } from '@/modules/platform/rbac/catalog';

/**
 * A permissions screen that can lock the owner out, or let a manager grant
 * himself the accounts, is worse than no screen. Every case here is a way
 * that could happen.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
let ownerPerms: Set<string>;
const ctx = () => ({ actorId });

/** An editor who holds everything — the owner. */
const owner = () => ({ id: actorId, permissions: ownerPerms, roles: ['super_admin'] });

async function grantsOf(roleId: string): Promise<string[]> {
  const rows = await db
    .select({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.code).sort();
}

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  ownerPerms = new Set<string>(PERMISSION_CODES);
});

afterAll(async () => {
  await pgClient.end();
});

describe('roles are data the owner edits', () => {
  it('lists every role with its grants and how many people hold it', async () => {
    const list = await listRoles();
    const salesRole = list.find((role) => role.code === 'sales_manager')!;
    expect(salesRole).toBeDefined();
    expect(salesRole.grants).toContain('crm.leads');
    expect(salesRole.isSystem).toBe(true);
    expect(salesRole.userCount).toBeGreaterThanOrEqual(0);
  });

  it('creates, renames and deletes a role of its own', async () => {
    const created = await createRole(
      { code: `dispatcher_${SUFFIX}`, name: 'Dispecher', description: 'Sinov roli' },
      owner(),
      ctx(),
    );
    expect(created.isSystem).toBe(false);

    await renameRole(created.id, 'Dispecher (yangi)', 'Yangilandi', ctx());
    const renamed = (await listRoles()).find((role) => role.id === created.id)!;
    expect(renamed.name).toBe('Dispecher (yangi)');

    await deleteRole(created.id, ctx());
    expect((await listRoles()).some((role) => role.id === created.id)).toBe(false);
  });

  it('refuses a duplicate code', async () => {
    await expect(
      createRole({ code: 'sales_manager', name: 'Boshqa', description: '' }, owner(), ctx()),
    ).rejects.toThrow(RoleError);
  });

  it('never deletes a role that ships with the app', async () => {
    const system = (await listRoles()).find((role) => role.code === 'logist')!;
    await expect(deleteRole(system.id, ctx())).rejects.toThrow(RoleError);
  });

  it('never deletes a role somebody holds', async () => {
    const created = await createRole(
      { code: `inuse_${SUFFIX}`, name: 'Band', description: '' },
      owner(),
      ctx(),
    );
    await db.insert(userRoles).values({ userId: actorId, roleId: created.id });
    await expect(deleteRole(created.id, ctx())).rejects.toThrow(RoleError);
    // Cleanup so the actor does not carry a stray role into later cases.
    await db.delete(userRoles).where(eq(userRoles.roleId, created.id));
    await deleteRole(created.id, ctx());
  });
});

describe('the guardrails', () => {
  it('changes grants and remembers that a human chose them', async () => {
    const created = await createRole(
      { code: `edit_${SUFFIX}`, name: 'Tahrir', description: '' },
      owner(),
      ctx(),
    );
    await setRoleGrants(created.id, ['crm.leads', 'finance.view'], owner(), ctx());
    expect(await grantsOf(created.id)).toEqual(['crm.leads', 'finance.view']);

    // Taking one away is the case the seed used to undo.
    await setRoleGrants(created.id, ['crm.leads'], owner(), ctx());
    expect(await grantsOf(created.id)).toEqual(['crm.leads']);

    const row = await db.query.roles.findFirst({ where: eq(roles.id, created.id) });
    expect(row!.grantsCustomised).toBe(true);
    const [source] = await db
      .select({ source: rolePermissions.source })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, created.id));
    expect(source!.source).toBe('admin');

    await deleteRole(created.id, ctx());
  });

  it('refuses to let an editor edit a role they hold themselves', async () => {
    // Editing your own powers is how you lock yourself out — and how you
    // quietly promote yourself.
    const created = await createRole(
      { code: `mine_${SUFFIX}`, name: 'Meniki', description: '' },
      owner(),
      ctx(),
    );
    const editorHoldingIt = {
      id: actorId,
      permissions: ownerPerms,
      roles: ['super_admin', `mine_${SUFFIX}`],
    };
    await expect(
      setRoleGrants(created.id, ['finance.manage'], editorHoldingIt, ctx()),
    ).rejects.toThrow(RoleError);
    await deleteRole(created.id, ctx());
  });

  it('refuses to hand out a permission the editor does not hold', async () => {
    const created = await createRole(
      { code: `limited_${SUFFIX}`, name: 'Cheklangan', description: '' },
      owner(),
      ctx(),
    );
    // A logist-level editor: no finance.manage, no accounting.
    const limited = {
      id: actorId,
      permissions: new Set(['platform.roles.manage', 'crm.leads', 'plans.manage']),
      roles: ['logist'],
    };
    await expect(setRoleGrants(created.id, ['finance.manage'], limited, ctx())).rejects.toThrow(
      RoleError,
    );
    // What they DO hold is fine.
    await setRoleGrants(created.id, ['crm.leads'], limited, ctx());
    expect(await grantsOf(created.id)).toEqual(['crm.leads']);

    await deleteRole(created.id, ctx());
  });

  it('lets an editor keep a grant they could not have made themselves', async () => {
    // Otherwise a role holding one permission the editor lacks becomes
    // permanently uneditable, and they delete and recreate it instead.
    const created = await createRole(
      { code: `keep_${SUFFIX}`, name: 'Saqlash', description: '' },
      owner(),
      ctx(),
    );
    await setRoleGrants(created.id, ['finance.manage', 'crm.leads'], owner(), ctx());

    const limited = {
      id: actorId,
      permissions: new Set(['platform.roles.manage', 'crm.leads', 'crm.manage']),
      roles: ['logist'],
    };
    // Adds crm.manage, keeps finance.manage untouched — allowed.
    await setRoleGrants(created.id, ['finance.manage', 'crm.leads', 'crm.manage'], limited, ctx());
    expect(await grantsOf(created.id)).toEqual(['crm.leads', 'crm.manage', 'finance.manage']);

    // …but REMOVING finance.manage is a change they may not make.
    await expect(
      setRoleGrants(created.id, ['crm.leads', 'crm.manage'], limited, ctx()),
    ).rejects.toThrow(RoleError);

    await deleteRole(created.id, ctx());
  });

  it('refuses an invented permission code', async () => {
    const created = await createRole(
      { code: `bogus_${SUFFIX}`, name: 'Yolg‘on', description: '' },
      owner(),
      ctx(),
    );
    await expect(
      setRoleGrants(created.id, ['finance.everything'], owner(), ctx()),
    ).rejects.toThrow(RoleError);
    await deleteRole(created.id, ctx());
  });

  it('will not leave the company with nobody who can manage roles', async () => {
    // The scenario has to genuinely remove the last grant to prove anything —
    // and that state must never be committed, because it is the one condition
    // this module exists to prevent. So it runs inside a transaction that
    // always rolls back, and the invariant is checked where it really lives.
    const [perm] = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.code, 'platform.roles.manage'));

    await expect(
      db.transaction(async (tx) => {
        expect(await someoneCanStillManageRoles(tx), 'someone can manage roles today').toBe(true);

        // Take it away from every role at once — the end state of any series
        // of well-meaning edits.
        await tx.delete(rolePermissions).where(eq(rolePermissions.permissionId, perm!.id));
        expect(await someoneCanStillManageRoles(tx)).toBe(false);

        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // Nothing escaped.
    const [after] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rolePermissions)
      .where(eq(rolePermissions.permissionId, perm!.id));
    expect(Number(after!.n), 'the rollback left the grants intact').toBeGreaterThan(0);
  });

  it('deactivating everyone counts as nobody, not as someone', async () => {
    // A role granting the permission is not the same as a person who can use
    // it: the holders could all be deactivated staff.
    await expect(
      db.transaction(async (tx) => {
        await tx.update(users).set({ active: false });
        expect(await someoneCanStillManageRoles(tx)).toBe(false);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const [active] = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.active, true));
    expect(Number(active!.n)).toBeGreaterThan(0);
  });
});

describe('the screen has something usable to render', () => {
  it('groups permissions by the area they govern', () => {
    const groups = groupPermissions(PERMISSION_CODES);
    const areas = groups.map((group) => group.area);
    expect(areas).toContain('finance');
    expect(areas).toContain('crm');
    // Every code lands in exactly one group.
    expect(groups.flatMap((group) => group.codes).sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it('offers an editor only what they hold', () => {
    expect(grantableBy(new Set(PERMISSION_CODES))).toHaveLength(PERMISSION_CODES.length);
    expect(grantableBy(new Set(['crm.leads']))).toEqual(['crm.leads']);
    expect(grantableBy(new Set())).toEqual([]);
  });
});

describe('the seed hands ownership over', () => {
  it('leaves an edited role alone on the next deploy', async () => {
    // The regression that makes people stop trusting a permissions screen:
    // remove a grant, deploy, and the grant is back.
    const viewer = (await listRoles()).find((role) => role.code === 'viewer')!;
    const editor = { id: actorId, permissions: ownerPerms, roles: ['super_admin'] };
    await setRoleGrants(viewer.id, [], editor, ctx());
    expect(await grantsOf(viewer.id)).toEqual([]);

    const row = await db.query.roles.findFirst({ where: eq(roles.id, viewer.id) });
    expect(row!.grantsCustomised, 'the seed keys off this flag').toBe(true);

    // Mirror what seed.ts does: skip a customised role entirely.
    const customised = new Set(
      (await db.select().from(roles)).filter((r) => r.grantsCustomised).map((r) => r.code),
    );
    expect(customised.has('viewer')).toBe(true);

    // Put it back so later runs of the suite start from the shipped matrix.
    await db.update(roles).set({ grantsCustomised: false }).where(eq(roles.id, viewer.id));
    const [reportsPerm] = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.code, 'reports.all_warehouses'));
    await db
      .insert(rolePermissions)
      .values({ roleId: viewer.id, permissionId: reportsPerm!.id, source: 'seed' })
      .onConflictDoNothing();
  });
});

describe('the money stays away from sales', () => {
  it('sales_manager cannot see the company margin, whatever the screens do', async () => {
    // The owner's answer to "which numbers must be hidden from whom" was
    // "you decide": cost and margin. This is where that lives.
    const [row] = await db
      .select({ codes: sql<string[]>`array_agg(${permissions.code})` })
      .from(roles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(roles.code, 'sales_manager'));
    const granted = new Set(row?.codes ?? []);

    for (const code of ['finance.reports', 'finance.expenses', 'finance.manage'] as const) {
      expect(granted.has(code), `sales_manager must not hold ${code}`).toBe(false);
    }
    // Client balances they DO need.
    expect(granted.has('finance.view')).toBe(true);
  });
});
