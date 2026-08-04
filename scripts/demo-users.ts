/**
 * Retire the demo accounts on a live installation.
 *
 * The seed only creates them when bootstrapping an empty database, but a
 * server that started from that bootstrap still carries them. This script
 * finds every demo phone that STILL HAS THE DEMO PASSWORD — proof nobody
 * adopted the account — and deactivates it (login blocked, existing sessions
 * invalidated). An account whose password was changed is in real use and is
 * never touched, and the last active super_admin is always kept.
 *
 *   pnpm demo-users            # report only
 *   pnpm demo-users --disable  # deactivate the unused ones
 */
import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { roles, sessions, userRoles, users } from '../src/modules/platform/db/schema';
import { verifyPassword } from '../src/modules/platform/auth/password';

const DEMO_PASSWORD = 'demo1234';
const DEMO_PHONES = Array.from({ length: 11 }, (_, i) => `+9989000000${String(i + 1).padStart(2, '0')}`);

async function main() {
  const disable = process.argv.includes('--disable');

  const rows = await db
    .select({
      id: users.id,
      phone: users.phone,
      fullName: users.fullName,
      active: users.active,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(inArray(users.phone, DEMO_PHONES));

  if (rows.length === 0) {
    console.log('No demo accounts present — nothing to do.');
    return;
  }

  const superAdmins = new Set(
    (
      await db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(roles.code, 'super_admin'))
    ).map((r) => r.userId),
  );
  const [activeSuperAdminRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(sql`${roles.code} = 'super_admin' AND ${users.active}`);
  let activeSuperAdmins = Number(activeSuperAdminRow?.n ?? 0);

  const toDisable: typeof rows = [];
  for (const row of rows) {
    const stillDemoPassword = await verifyPassword(row.passwordHash, DEMO_PASSWORD);
    const isSuper = superAdmins.has(row.id);
    const label = `${row.phone}  ${row.fullName}`;
    if (!row.active) {
      console.log(`  ⏸  ${label} — already disabled`);
      continue;
    }
    if (!stillDemoPassword) {
      console.log(`  ✅ ${label} — password was changed, IN USE, left alone`);
      continue;
    }
    if (isSuper && activeSuperAdmins <= 1) {
      console.log(`  ⚠️  ${label} — last active super admin, KEPT (change its password!)`);
      continue;
    }
    console.log(`  ❌ ${label} — still on the demo password${disable ? ', disabling' : ''}`);
    toDisable.push(row);
    if (isSuper) activeSuperAdmins -= 1;
  }

  if (!disable) {
    console.log(
      toDisable.length
        ? `\n${toDisable.length} account(s) would be disabled. Re-run with --disable.`
        : '\nNothing to disable.',
    );
    return;
  }
  if (toDisable.length === 0) return;

  const ids = toDisable.map((r) => r.id);
  await db.update(users).set({ active: false }).where(inArray(users.id, ids));
  // Kill their live sessions too — deactivation alone already blocks the
  // session lookup, but leaving rows behind is untidy.
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  console.log(`\nDisabled ${ids.length} demo account(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
