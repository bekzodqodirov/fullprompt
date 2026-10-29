import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, roles, userRoles, users } from '@/modules/platform/db/schema';
import { nextVedAssigneeInTx, vedRotaPool } from '@/modules/wms/calc/service';

/**
 * His item 5 (2026-10-20, «ved hodimlariga hisoblash … 1 odamga kop tushb
 * ketyabti»; 2026-10-21 «faqat murodga tushgan, 10 foizcha boshqa hodimga»).
 *
 * The rota counted OPEN requests and broke a tie by the newest OPEN request —
 * which is NULL for everybody when nobody holds anything, the normal state of
 * a team that keeps up. Every candidate tied and the same first row won. The
 * tests below pass the rota their OWN pool, so a seeded or leftover VED on a
 * long-lived database cannot decide them (#653).
 */

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const phone = () => `+99893${SUFFIX}${(seq += 1)}`;
const madeUsers: string[] = [];
let vedA = '';
let vedB = '';
let vedC = '';
let adminVed = '';
let adminOnly = '';

async function userWithRoles(roleCodes: string[], name: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: phone(), fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  for (const code of roleCodes) {
    const r = await db.query.roles.findFirst({ where: eq(roles.code, code) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  madeUsers.push(u!.id);
  return u!.id;
}

/** A request held by `holder`, handed at `at`; closed unless `open`. */
async function handed(holder: string, at: Date, open = false): Promise<void> {
  await db.insert(calcRequests).values({
    entityType: 'deal',
    entityId: uuidv4(),
    requestedBy: holder,
    assigneeId: holder,
    itemCount: 1,
    section: 'rastamojka',
    requestedAt: at,
    takenAt: at,
    dueAt: new Date(at.getTime() + 3_600_000),
    completedAt: open ? null : at,
    completedBy: open ? null : holder,
  });
}

/** One request through the rota, the way `openCalcRequest` lands it. */
async function landOne(pool: string[]): Promise<string | null> {
  return db.transaction(async (tx) => {
    const id = await nextVedAssigneeInTx(tx, pool);
    if (id) {
      await tx.insert(calcRequests).values({
        entityType: 'deal',
        entityId: uuidv4(),
        requestedBy: id,
        assigneeId: id,
        itemCount: 1,
        section: 'rastamojka',
        takenAt: new Date(),
        dueAt: new Date(Date.now() + 3_600_000),
        // Done at once: the team «keeps up», so nobody ever holds an open one.
        completedAt: new Date(),
        completedBy: id,
      });
    }
    return id;
  });
}

async function clearRequests(): Promise<void> {
  if (madeUsers.length === 0) return;
  await db.delete(calcRequests).where(inArray(calcRequests.assigneeId, madeUsers));
}

beforeAll(async () => {
  vedA = await userWithRoles(['ved_manager'], `Rota A ${SUFFIX}`);
  vedB = await userWithRoles(['ved_manager'], `Rota B ${SUFFIX}`);
  vedC = await userWithRoles(['ved_manager'], `Rota C ${SUFFIX}`);
  adminVed = await userWithRoles(['admin', 'ved_manager'], `Rota AdminVed ${SUFFIX}`);
  adminOnly = await userWithRoles(['admin'], `Rota AdminOnly ${SUFFIX}`);
});

afterAll(async () => {
  await clearRequests();
  if (madeUsers.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, madeUsers));
    await db.delete(users).where(inArray(users.id, madeUsers));
  }
  await pgClient.end();
});

describe('the VED rota (his item 5)', () => {
  it('with nobody holding an open job, nine requests spread three each over three people', async () => {
    await clearRequests();
    const pool = [vedA, vedB, vedC];
    const got: string[] = [];
    for (let i = 0; i < 9; i += 1) got.push((await landOne(pool))!);
    const count = (id: string) => got.filter((g) => g === id).length;
    expect([count(vedA), count(vedB), count(vedC)]).toEqual([3, 3, 3]);
  });

  it('a free person comes first, however many they were handed today', async () => {
    await clearRequests();
    const now = new Date();
    // A was handed five today and holds none; B holds one open since dawn.
    for (let i = 0; i < 5; i += 1) await handed(vedA, now);
    await handed(vedB, now, true);
    expect(await landOne([vedA, vedB])).toBe(vedA);
  });

  it('among the free, fewest handed TODAY wins; then whoever has waited longest', async () => {
    await clearRequests();
    const now = new Date();
    const lastWeek = new Date(now.getTime() - 7 * 86_400_000);
    await handed(vedA, now);
    await handed(vedA, now);
    await handed(vedB, now);
    // C was handed nothing today, but more recently than… nobody — C is the
    // only one at zero today, so C wins regardless of the older history.
    await handed(vedC, lastWeek);
    expect(await landOne([vedA, vedB, vedC])).toBe(vedC);
    // Now C has one today too: A 2, B 1, C 1 — B and C tie on today, and B
    // was handed earlier than C's just-landed one, so B waits longest.
    expect(await landOne([vedA, vedB, vedC])).toBe(vedB);
  });

  it('a second request waits for the first: two landings in the same instant go to two people', async () => {
    await clearRequests();
    const pool = [vedA, vedB];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstPicked!: (id: string | null) => void;
    const picked = new Promise<string | null>((resolve) => (firstPicked = resolve));
    // The first lands an OPEN request and holds its transaction open.
    const first = db.transaction(async (tx) => {
      const id = await nextVedAssigneeInTx(tx, pool);
      await tx.insert(calcRequests).values({
        entityType: 'deal',
        entityId: uuidv4(),
        requestedBy: id!,
        assigneeId: id,
        itemCount: 1,
        section: 'rastamojka',
        takenAt: new Date(),
        dueAt: new Date(Date.now() + 3_600_000),
      });
      firstPicked(id);
      await held;
      return id;
    });
    const a = await picked;
    // The second starts while the first still holds; it must wait for the
    // commit and then see the first's open request.
    const second = landOne(pool);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(a);
    expect(two).not.toBe(one);
  });

  it('the pool holds an admin who also has the VED role, and not an admin who only has the admin role (his 5.7)', async () => {
    const pool = await vedRotaPool();
    expect(pool).toEqual(expect.arrayContaining([vedA, vedB, vedC, adminVed]));
    expect(pool).not.toContain(adminOnly);
  });

  it('a deactivated VED leaves the pool', async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, vedC));
    try {
      expect(await vedRotaPool()).not.toContain(vedC);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, vedC));
    }
  });
});

