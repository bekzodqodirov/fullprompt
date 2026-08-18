import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { notifications, userRoles, users } from '@/modules/platform/db/schema';
import {
  claimPendingTelegram,
  reclaimStaleTelegram,
  usersWithPermission,
} from '@/modules/platform/notifications/service';

/**
 * The staff-notification drain's claim (0082), and who is still a recipient.
 *
 * The audit found `sendPendingTelegram` reading `status='pending'` and only
 * flipping a row AFTER the Telegram round trip — so any two drains running at
 * once (a twice-registered worker; the tg-listen container booting the whole
 * fleet) both read the same thirty rows and both delivered them. The claim is
 * the fence that makes the next such regression a non-event.
 */

let actorId: string;
const mine: string[] = [];
/** Every foreign row a test claimed, put back exactly as found (#183). */
const borrowed = new Set<string>();

/**
 * Claim until the queue is dry. gsr_ci carries a four-figure backlog of
 * pending rows from earlier suites, and a single LIMIT-30 claim takes the
 * OLDEST thirty — never this file's fresh fixtures. Asserting «mine were in
 * the first thirty» would be a sentence about strangers (#713); claiming to
 * exhaustion makes every assertion about OUR rows and only ours.
 */
async function claimAll(): Promise<string[]> {
  const all: string[] = [];
  for (;;) {
    const got = await claimPendingTelegram(200);
    if (got.length === 0) break;
    all.push(...got);
    for (const id of got) if (!mine.includes(id)) borrowed.add(id);
  }
  return all;
}

async function mintPending(n: number): Promise<string[]> {
  const rows = await db
    .insert(notifications)
    .values(
      Array.from({ length: n }, () => ({
        userId: actorId,
        channel: 'telegram',
        type: 'ZZClaimTest',
        payload: {},
        status: 'pending',
      })),
    )
    .returning({ id: notifications.id });
  const ids = rows.map((r) => r.id);
  mine.push(...ids);
  return ids;
}

beforeAll(async () => {
  const who = await db.query.users.findFirst();
  if (!who) throw new Error('the suite needs at least one user');
  actorId = who.id;
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.id, mine));
  // The backlog this file claimed to get past goes back to 'pending',
  // untouched otherwise — those rows belong to nobody now, but leaving them
  // parked in 'sending' would change what the next suite's drain sees.
  if (borrowed.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...borrowed]), eq(notifications.status, 'sending')));
  }
  await pgClient.end();
});

describe('the telegram drain claims before it sends', () => {
  it('two simultaneous exhaustive claimers split the rows, never share one', async () => {
    const ids = await mintPending(40);
    const [a, b] = await Promise.all([claimAll(), claimAll()]);
    const taken = new Set(a);
    const overlap = b.filter((id) => taken.has(id));
    expect(overlap, 'a row claimed twice is a message delivered twice').toEqual([]);
    // Between them they took everything there was to take — the claim splits
    // work, it must not lose any. Asserted over OUR rows only (#713).
    const ours = new Set([...a, ...b].filter((id) => ids.includes(id)));
    expect(ours.size).toBe(40);
  });

  it('a claimed row is invisible to the next drain', async () => {
    const id = (await mintPending(1))[0]!;
    const first = await claimAll();
    expect(first).toContain(id);
    const second = await claimAll();
    expect(second).not.toContain(id);
  });

  it('a claim a dead drain left behind is put back, with the attempt counted', async () => {
    const id = (await mintPending(1))[0]!;
    await db
      .update(notifications)
      .set({ status: 'sending', claimedAt: sql`now() - interval '11 minutes'` })
      .where(eq(notifications.id, id));
    await reclaimStaleTelegram();
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.status).toBe('pending');
    // Counted, because the send may or may not have happened — this is what
    // stops a crash-looping drain from re-sending the same row without limit.
    expect(row!.attempts).toBe(1);
  });

  it('a stale claim that is out of attempts goes terminal, not back in the queue', async () => {
    const id = (await mintPending(1))[0]!;
    await db
      .update(notifications)
      .set({ status: 'sending', claimedAt: sql`now() - interval '11 minutes'`, attempts: 5 })
      .where(eq(notifications.id, id));
    await reclaimStaleTelegram();
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.status).toBe('failed');
  });

  it('a FRESH claim is left alone — ten minutes is the fence, not zero', async () => {
    const id = (await mintPending(1))[0]!;
    await claimAll();
    await reclaimStaleTelegram();
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.status).toBe('sending');
  });
});

describe('a person who left the company leaves the recipient lists', () => {
  const suffix = randomUUID().slice(0, 6);
  let leaverId: string;
  let grantedPermission: string;

  beforeAll(async () => {
    // A brand-new user wearing an existing role, so no shared configuration
    // is touched (#653: deactivating a seeded user is global state another
    // parallel file may be standing on).
    const [role] = (await db.execute(sql`
      SELECT rp.role_id AS id, p.code
      FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      LIMIT 1`)) as unknown as { id: string; code: string }[];
    grantedPermission = role!.code;
    const [leaver] = await db
      .insert(users)
      .values({
        phone: `+9989000zz${suffix}`,
        username: `zzleaver${suffix}`,
        fullName: 'ZZ Leaver',
        passwordHash: 'x',
        active: true,
      })
      .returning({ id: users.id });
    leaverId = leaver!.id;
    await db.insert(userRoles).values({ userId: leaverId, roleId: role!.id });
  });

  afterAll(async () => {
    await db.delete(userRoles).where(eq(userRoles.userId, leaverId));
    await db.delete(users).where(eq(users.id, leaverId));
  });

  it('active: on the list; deactivated: gone — the roles rows still standing', async () => {
    expect(await usersWithPermission(grantedPermission)).toContain(leaverId);
    await db.update(users).set({ active: false }).where(eq(users.id, leaverId));
    // The user_roles rows survive deactivation by design (reactivation gives
    // the job back) — which is exactly why the filter must live in the list.
    expect(await usersWithPermission(grantedPermission)).not.toContain(leaverId);
  });
});
