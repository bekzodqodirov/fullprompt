import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { navUsage, users } from '@/modules/platform/db/schema';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { visibleWorkspaces } from '@/modules/platform/rbac/workspaces';
import {
  AUTO_LIMIT,
  STAR_LIMIT,
  frequentFor,
  recordVisit,
  setStar,
  workspacesFor,
} from '@/modules/platform/nav/usage';

/**
 * «Tez-tez» against the real database (0111).
 *
 * Users of its OWN, minted here and deactivated after: the seeded demo
 * accounts are what every Playwright spec logs in as, and CI runs this suite
 * first on the same database — a star left on the owner's account would be a
 * sidebar row in the next spec (#183).
 */

const SUFFIX = String(Date.now()).slice(-7);
const OWNER = { roles: ['super_admin'], permissions: new Set<string>(ROLE_MATRIX.super_admin) };
const SELLER = { roles: ['sales_manager'], permissions: new Set<string>(ROLE_MATRIX.sales_manager) };
// What the SHELL draws for the owner — the switched-off doors (the AI page
// with no key, as in CI) included in the reckoning.
const OWNER_WS = workspacesFor(OWNER);

let alice = '';
let bob = '';

beforeAll(async () => {
  const made = await db
    .insert(users)
    .values([
      { phone: `+99894${SUFFIX}`, fullName: `Nav fixture A ${SUFFIX}`, passwordHash: 'x' },
      { phone: `+99895${SUFFIX}`, fullName: `Nav fixture B ${SUFFIX}`, passwordHash: 'x' },
    ])
    .returning({ id: users.id });
  alice = made[0]!.id;
  bob = made[1]!.id;
});

afterAll(async () => {
  await db.delete(navUsage).where(inArray(navUsage.userId, [alice, bob]));
  // Never deleted: an audited user is kept by the audit log's FK.
  await db.update(users).set({ active: false }).where(inArray(users.id, [alice, bob]));
  await pgClient.end();
});

const rowsOf = (userId: string) =>
  db.select().from(navUsage).where(eq(navUsage.userId, userId)).orderBy(navUsage.href);

describe('a visit is counted only for a tab the person is offered', () => {
  it('refuses a raw URL, an id-bearing path and a page off the menu', async () => {
    expect(await recordVisit(alice, OWNER, '/admin/clients/2f1a0000-0000-0000-0000-000000000000')).toBe(false);
    expect(await recordVisit(alice, OWNER, '/nowhere')).toBe(false);
    // The seller is not offered the P&L; the owner is.
    expect(await recordVisit(bob, SELLER, '/accounting/pnl')).toBe(false);
    expect(await rowsOf(alice)).toHaveLength(0);
    expect(await rowsOf(bob)).toHaveLength(0);
  });

  it('earns a place in the block at the third visit, not before', async () => {
    await recordVisit(alice, OWNER, '/finance/narxsiz');
    await recordVisit(alice, OWNER, '/finance/narxsiz');
    expect((await frequentFor(alice, OWNER_WS)).map((row) => row.href)).not.toContain('/finance/narxsiz');
    await recordVisit(alice, OWNER, '/finance/narxsiz');
    expect((await frequentFor(alice, OWNER_WS)).map((row) => row.href)).toContain('/finance/narxsiz');
    const [row] = await rowsOf(alice);
    expect(row!.score).toBeGreaterThan(2.99);
  });

  it('forgets a page nobody has opened for a month (14-day half-life)', async () => {
    await db
      .update(navUsage)
      .set({ score: 4, lastAt: sql`now() - interval '28 days'` })
      .where(and(eq(navUsage.userId, alice), eq(navUsage.href, '/finance/narxsiz')));
    // 4 × 0.5² = 1: below the bar, though four visits were once recorded.
    expect((await frequentFor(alice, OWNER_WS)).map((row) => row.href)).not.toContain('/finance/narxsiz');
    // …and the next visit starts from the decayed figure, not from 4.
    await recordVisit(alice, OWNER, '/finance/narxsiz');
    const [row] = await rowsOf(alice);
    expect(row!.score).toBeGreaterThan(1.9);
    expect(row!.score).toBeLessThan(2.1);
  });

  it('shows at most three noticed pages, in the MENU’s order and never the counts’', async () => {
    // Opened most → least in the REVERSE of the menu's order.
    const pages = ['/reports/stock-aging', '/finance/reestr', '/kontragentlar', '/crm/dormant'];
    for (const [i, href] of pages.entries()) {
      for (let n = 0; n < 3 + (pages.length - i); n += 1) await recordVisit(alice, OWNER, href);
    }
    const shown = (await frequentFor(alice, OWNER_WS)).filter((row) => !row.starred).map((row) => row.href);
    expect(shown).toHaveLength(AUTO_LIMIT);
    // The least-opened of the four is the one left out…
    expect(shown).not.toContain('/crm/dormant');
    // …and the three are drawn as the menu draws them — Pul's two before
    // Hisobotlar's, in Pul's own tab order — whatever their scores.
    expect(shown).toEqual(['/kontragentlar', '/finance/reestr', '/reports/stock-aging']);
  });
});

describe('a star', () => {
  it('cannot be put on a workspace’s own row or on a page the person is not offered', async () => {
    expect(await setStar(bob, SELLER, '/bitimlar', true)).toEqual({ ok: false, error: 'entry' });
    expect(await setStar(bob, SELLER, '/accounting/pnl', true)).toEqual({ ok: false, error: 'not_offered' });
    // Taking a star OFF is an update: a forged href mints nothing.
    expect(await setStar(bob, SELLER, '/forged', false)).toEqual({ ok: true });
    expect(await rowsOf(bob)).toHaveLength(0);
  });

  it('keeps the order it was given, and the ninth is refused', async () => {
    const candidates = OWNER_WS.flatMap((ws) => [...ws.tabs, ...ws.settings].map((tab) => tab.href)).filter(
      (href) => !OWNER_WS.some((ws) => ws.href === href),
    );
    const starred = candidates.slice(0, STAR_LIMIT).reverse();
    for (const href of starred) expect(await setStar(bob, OWNER, href, true)).toEqual({ ok: true });
    expect(await setStar(bob, OWNER, candidates[STAR_LIMIT]!, true)).toEqual({ ok: false, error: 'full' });
    // Pressing an existing star again is not a ninth, and keeps its place.
    expect(await setStar(bob, OWNER, starred[0]!, true)).toEqual({ ok: true });
    const block = await frequentFor(bob, OWNER_WS);
    expect(block.map((row) => row.href)).toEqual(starred);
    expect(block.every((row) => row.starred)).toBe(true);
  });

  it('leaves the block when the page is no longer offered — nobody deletes a row', async () => {
    // The same stars, read through a seller's menu: whatever is not theirs
    // to open is simply not drawn.
    const asSeller = await frequentFor(bob, visibleWorkspaces(SELLER));
    const offered = new Set(visibleWorkspaces(SELLER).flatMap((ws) => ws.tabs.map((tab) => tab.href)));
    for (const row of asSeller) expect(offered.has(row.href)).toBe(true);
    expect((await rowsOf(bob)).filter((row) => row.starred)).toHaveLength(STAR_LIMIT);
  });

  it('comes off, and the row stays a plain visit count', async () => {
    const first = (await frequentFor(bob, OWNER_WS))[0]!.href;
    expect(await setStar(bob, OWNER, first, false)).toEqual({ ok: true });
    const row = (await rowsOf(bob)).find((one) => one.href === first)!;
    expect(row.starred).toBe(false);
    expect(row.starredAt).toBeNull();
  });
});
