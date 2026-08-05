import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, clients, deals, events, roles, userRoles, users } from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { INLINE_CLIENT_FIELDS, patchClient } from '@/modules/platform/clients/inline';
import { createDeal } from '@/modules/wms/deals/service';
import { INLINE_DEAL_FIELDS, patchDeal } from '@/modules/wms/deals/inline';

/**
 * Correcting a deal or a client card in place.
 *
 * The rules that matter are the ones about what a one-field patch may NOT
 * reach. A deal's quote is the number a client was told and carries the name
 * of whoever said it; a client's CODE is its identity on every label, act and
 * payment. Both are one keystroke away from the boxes these functions serve,
 * and only the allowlist keeps them apart.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId = '';
let otherId = '';
let clientId = '';
let dealId = '';

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admins[0]!.id;
  const [other] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt));
  otherId = other!.id;

  const client = await createClient(
    {
      name: `Inline karta ${SUFFIX}`,
      clientCode: `INL${SUFFIX}`,
      phones: ['+998900000000'],
      notes: 'eski izoh',
    },
    ctx(),
  );
  clientId = client.id;
  dealId = await createDeal(
    { clientId, title: 'Eski sarlavha', quotedAmount: 500, quotedCurrency: 'USD' },
    ctx(),
  );
});

afterAll(async () => {
  await db.delete(events).where(inArray(events.entityId, [dealId, clientId]));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('a deal, corrected in place', () => {
  it('changes the title and touches nothing else', async () => {
    const before = (await db.select().from(deals).where(eq(deals.id, dealId)))[0]!;
    await patchDeal(dealId, 'title', 'Yangi sarlavha', ctx());
    const after = (await db.select().from(deals).where(eq(deals.id, dealId)))[0]!;

    expect(after.title).toBe('Yangi sarlavha');
    expect(after.quotedAmount).toBe(before.quotedAmount);
    expect(after.stageId).toBe(before.stageId);
    expect(after.ownerId).toBe(before.ownerId);
  });

  it('leaves the quote and its author untouchable', async () => {
    // The stamp is the point of the card: `updateDeal` writes quotedAt and
    // quotedBy when the price really moves, and a patch cannot do that.
    for (const field of [
      'quotedAmount',
      'quotedVolumeM3',
      'quotedWeightKg',
      'quotedCurrency',
      'stageId',
      'ownerId',
      'clientId',
      'discountAmount',
    ]) {
      await expect(patchDeal(dealId, field, '1', ctx())).rejects.toMatchObject({
        code: 'field_not_editable',
      });
    }
    expect([...INLINE_DEAL_FIELDS]).toEqual(['title', 'note']);
  });

  it('says nothing when nothing changed', async () => {
    const rows = () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'deal'), eq(auditLog.entityId, dealId)));
    const before = (await rows()).length;
    await patchDeal(dealId, 'title', 'Yangi sarlavha', ctx());
    expect((await rows()).length).toBe(before);
  });

  it('audits the change, not the record', async () => {
    await patchDeal(dealId, 'note', 'yangi izoh', ctx());
    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'deal'), eq(auditLog.entityId, dealId)))
      .orderBy(asc(auditLog.id));
    expect(trail.at(-1)!.after).toEqual({ note: 'yangi izoh' });
  });
});

describe('a client, corrected in place', () => {
  it('takes a second number without touching the code', async () => {
    const before = (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;
    await patchClient(clientId, 'phones', '+998900000000, +998911112233', ctx());
    const after = (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;

    expect(after.phones).toEqual(['+998900000000', '+998911112233']);
    expect(after.clientCode).toBe(before.clientCode);
    expect(after.name).toBe(before.name);
  });

  it('hands the account to another seller, and back to nobody', async () => {
    await patchClient(clientId, 'salesManagerId', otherId, ctx());
    expect((await db.select().from(clients).where(eq(clients.id, clientId)))[0]!.salesManagerId).toBe(
      otherId,
    );
    await patchClient(clientId, 'salesManagerId', '', ctx());
    expect(
      (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!.salesManagerId,
    ).toBeNull();
  });

  it('refuses a manager who is not a person here', async () => {
    // A picker, so a bad id is a forged post rather than a typo — and the
    // column has a foreign key that would throw an unreadable error instead.
    await expect(
      patchClient(clientId, 'salesManagerId', '00000000-0000-0000-0000-000000000000', ctx()),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('leaves the code, the name and the active flag out of reach', async () => {
    for (const field of ['clientCode', 'name', 'active', 'messengerNote', 'locale']) {
      await expect(patchClient(clientId, field, 'x', ctx())).rejects.toMatchObject({
        code: 'field_not_editable',
      });
    }
    expect([...INLINE_CLIENT_FIELDS]).toEqual(['phones', 'notes', 'salesManagerId']);
  });

  it('says nothing when nothing changed', async () => {
    const rows = () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'client'), eq(auditLog.entityId, clientId)));
    const before = (await rows()).length;
    await patchClient(clientId, 'notes', 'eski izoh', ctx());
    expect((await rows()).length).toBe(before);
  });

  it('needs an actor', async () => {
    await expect(
      patchClient(clientId, 'notes', 'x', { actorId: null, ip: null, userAgent: null }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
