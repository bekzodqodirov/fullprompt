import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, roles, userRoles, users } from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { searchClients } from '@/modules/platform/clients/search';

/**
 * Who may own a client, and can the form still render them.
 *
 * This is the defect that quietly deleted live data: the owner list was
 * `roles.code = 'sales_manager'`, the form is a bare `<select>` whose first
 * option is blank, so a client owned by anybody else lost its owner the next
 * time somebody saved the card to fix a typo. On the owner's real data that
 * was 168 of 262 assigned clients.
 *
 * The test that matters is not "the query returns rows" — it is "the person
 * currently stored is IN the list", because a value the form cannot render is
 * a value the form will delete.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId: string;
const ctx = () => ({ actorId });
const madeClients: string[] = [];

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  actorId = staff.find((row) => row.code === 'super_admin')!.id;
});

afterAll(async () => {
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  await pgClient.end();
});

describe('who can be offered as a client’s owner', () => {
  it('offers everyone who could hold a client, not one hard-coded role', async () => {
    const options = await salesManagerOptions();
    expect(options.length).toBeGreaterThan(0);
    // The owner himself holds clients in the real data and is a super_admin,
    // never a sales_manager — the old query left him out and the form then
    // erased him.
    expect(options.map((row) => row.id)).toContain(actorId);
  });

  it('renders the person currently assigned even when they no longer qualify', async () => {
    // A colleague who changed roles, or was deactivated. Their name has to
    // stay in the box, otherwise saving the card silently reassigns the
    // client to nobody.
    const [gone] = await db
      .insert(users)
      .values({
        fullName: `Ketgan sotuvchi ${SUFFIX}`,
        phone: `+99891${SUFFIX}`,
        passwordHash: 'x',
        locale: 'uz',
        active: false,
      })
      .returning();

    const without = await salesManagerOptions();
    expect(without.map((row) => row.id)).not.toContain(gone!.id);

    const withHolder = await salesManagerOptions(gone!.id);
    expect(withHolder.map((row) => row.id)).toContain(gone!.id);

    await db.delete(users).where(eq(users.id, gone!.id));
  });

  it('leaves every assigned owner in the real book renderable', async () => {
    // The measurement that made this a bug rather than a theory: not one
    // client in the database may have an owner the form cannot show.
    const assigned = await db
      .select({ id: clients.salesManagerId })
      .from(clients)
      .where(eq(clients.active, true));
    const owners = [...new Set(assigned.map((row) => row.id).filter(Boolean))] as string[];
    const offered = new Set((await salesManagerOptions()).map((row) => row.id));
    const invisible = owners.filter((id) => !offered.has(id));
    expect(invisible).toEqual([]);
  });
});

describe('finding a client by the number that is ringing', () => {
  it('matches a stored phone however either side was typed', async () => {
    const client = await createClient(
      {
        clientCode: `PH${SUFFIX}`,
        name: `Telefon mijoz ${SUFFIX}`,
        phones: ['+998 90 175 78 22'],
      },
      ctx(),
    );
    madeClients.push(client.id);

    for (const typed of ['+998901757822', '998901757822', '901757822', '90 175 78 22', '1757822']) {
      const hits = await searchClients(typed, 20);
      expect(hits.map((row) => row.clientCode), typed).toContain(`PH${SUFFIX}`);
    }
  });

  it('does not turn a short code search into a phone sweep', async () => {
    // "444" is a real client marking here. It must not drag in every card
    // whose phone happens to contain those digits.
    const hits = await searchClients('444', 20);
    for (const hit of hits) {
      expect(
        hit.clientCode.includes('444') || hit.name.toLowerCase().includes('444'),
        hit.clientCode,
      ).toBe(true);
    }
  });
});
