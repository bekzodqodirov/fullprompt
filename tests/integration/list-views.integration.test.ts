import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { listViews, roles, userRoles, users } from '@/modules/platform/db/schema';
import {
  ListViewError,
  deleteView,
  defaultViewFor,
  listViewsFor,
  saveView,
  updateView,
} from '@/modules/platform/lists/service';
import { PUBLISH_VIEWS_PERMISSION } from '@/modules/platform/lists/query';

/**
 * Saved views against the real database.
 *
 * The rules worth proving here are the ones the browser cannot: who may
 * publish, what the unique indexes actually refuse, and that a second default
 * replaces the first rather than colliding with it.
 */

const SUFFIX = String(Date.now()).slice(-7);
const SCREEN = `test-screen-${SUFFIX}`;
const ADMIN = { permissions: new Set([PUBLISH_VIEWS_PERMISSION]) };
const PLAIN = { permissions: new Set(['clients.manage']) };

let alice = '';
let bob = '';
const ctx = { actorId: '' as string | null };

beforeAll(async () => {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  alice = found[0]!.id;
  const others = await db.select({ id: users.id }).from(users).limit(5);
  bob = others.find((row) => row.id !== alice)!.id;
  ctx.actorId = alice;
});

afterAll(async () => {
  // A saved view is CONFIGURATION: left behind, it changes what the next
  // screen renders for whoever owns it (#183). CI runs vitest and Playwright
  // against ONE database, so this cleanup is not tidiness.
  await db.delete(listViews).where(eq(listViews.screen, SCREEN));
  await pgClient.end();
});

describe('saving a view', () => {
  it('stores the query string and hands it back to its owner', async () => {
    const view = await saveView(
      { screen: SCREEN, name: `Debtors ${SUFFIX}`, query: 'dir=asc&q=GS7&sort=name' },
      { id: alice, ...PLAIN },
      ctx,
    );
    expect(view.query).toBe('dir=asc&q=GS7&sort=name');

    const mine = await listViewsFor(SCREEN, alice);
    expect(mine.map((row) => row.name)).toContain(`Debtors ${SUFFIX}`);
    expect(mine.every((row) => row.mine)).toBe(true);

    // …and nobody else's screen grew a chip.
    expect(await listViewsFor(SCREEN, bob)).toHaveLength(0);
  });

  it('refuses a second view of the same name', async () => {
    await expect(
      saveView(
        { screen: SCREEN, name: `debtors ${SUFFIX}`, query: 'q=other' },
        { id: alice, ...PLAIN },
        ctx,
      ),
    ).rejects.toThrow(ListViewError);
  });

  it('refuses an empty name', async () => {
    await expect(
      saveView({ screen: SCREEN, name: '   ', query: '' }, { id: alice, ...PLAIN }, ctx),
    ).rejects.toMatchObject({ code: 'name_required' });
  });
});

describe('publishing', () => {
  it('is refused without the settings permission', async () => {
    await expect(
      saveView(
        { screen: SCREEN, name: `Shared ${SUFFIX}`, query: 'q=x', makePublic: true },
        { id: alice, ...PLAIN },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('puts the view on everyone else’s screen when an admin does it', async () => {
    await saveView(
      { screen: SCREEN, name: `Shared ${SUFFIX}`, query: 'q=x', makePublic: true },
      { id: alice, ...ADMIN },
      ctx,
    );
    const seen = await listViewsFor(SCREEN, bob);
    const shared = seen.find((row) => row.name === `Shared ${SUFFIX}`);
    expect(shared).toBeDefined();
    // Visible, but plainly somebody else's: the screen labels it and the
    // «make it my default» star is not offered on it.
    expect(shared!.mine).toBe(false);
  });

  it('cannot be somebody’s personal default at the same time', async () => {
    // The row belongs to everybody, so `is_default` on it would decide what
    // every colleague opens — the CHECK refuses it and so does the service.
    const view = await saveView(
      { screen: SCREEN, name: `Both ${SUFFIX}`, query: 'q=y', makePublic: true, makeDefault: true },
      { id: alice, ...ADMIN },
      ctx,
    );
    expect(view.isDefault).toBe(false);
  });

  it('is deletable by an admin and by nobody else', async () => {
    const [row] = await db
      .select()
      .from(listViews)
      .where(sql`${listViews.screen} = ${SCREEN} AND ${listViews.name} = ${`Both ${SUFFIX}`}`);
    await expect(deleteView(row!.id, { id: bob, ...PLAIN }, ctx)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await deleteView(row!.id, { id: bob, ...ADMIN }, ctx);
    expect(
      (await listViewsFor(SCREEN, bob)).find((view) => view.name === `Both ${SUFFIX}`),
    ).toBeUndefined();
  });
});

describe('the default view', () => {
  it('is what a bare visit opens, and only for its owner', async () => {
    const view = await saveView(
      { screen: SCREEN, name: `Mine ${SUFFIX}`, query: 'q=mine', makeDefault: true },
      { id: alice, ...PLAIN },
      ctx,
    );
    expect((await defaultViewFor(SCREEN, alice))?.id).toBe(view.id);
    expect(await defaultViewFor(SCREEN, bob)).toBeNull();
  });

  it('moves rather than collides when a second view claims it', async () => {
    // The partial unique index allows one per (person, screen); the service
    // clears the old one first, so pressing the star means what it says.
    const second = await saveView(
      { screen: SCREEN, name: `Second ${SUFFIX}`, query: 'q=second', makeDefault: true },
      { id: alice, ...PLAIN },
      ctx,
    );
    expect((await defaultViewFor(SCREEN, alice))?.id).toBe(second.id);

    await updateView(second.id, { isDefault: false }, { id: alice, ...PLAIN });
    expect(await defaultViewFor(SCREEN, alice)).toBeNull();
  });

  it('cannot be set on a view the person does not own', async () => {
    const shared = (await listViewsFor(SCREEN, bob)).find((view) => !view.mine)!;
    await expect(
      updateView(shared.id, { isDefault: true }, { id: bob, ...PLAIN }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
