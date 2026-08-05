import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  clients,
  deals,
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { updateLead } from '@/modules/wms/crm/service';
import { createDeal, updateDeal } from '@/modules/wms/deals/service';

/**
 * What the two card forms write down.
 *
 * Both of them used to audit a FIXED handful of columns out of the many they
 * write — the lead form nine columns and three recorded, the deal form eight
 * and two — so an edit could leave no trace at all, and a save that changed
 * nothing still wrote a row saying it had. The History tab is only as true as
 * these two writers, which is why the round that made history readable had to
 * come here first.
 */

const SUFFIX = String(Date.now()).slice(-7);
let actorId = '';
let stageId = '';
let leadId = '';
let clientId = '';
let dealId = '';

const ctx = () => ({ actorId, ip: null, userAgent: null });

/** The audit rows for one entity, oldest first. */
async function trail(entityType: string, entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.id));
}

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admins[0]!.id;

  const [stage] = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder)).limit(1);
  stageId = stage!.id;
  const [lead] = await db
    .insert(leads)
    .values({
      name: `Audit sinov ${SUFFIX}`,
      phone: '+998900000000',
      company: 'Eski firma',
      stageId,
      ownerId: actorId,
      createdBy: actorId,
    })
    .returning();
  leadId = lead!.id;

  const client = await createClient(
    { name: `Audit mijoz ${SUFFIX}`, clientCode: `AUD${SUFFIX}` },
    ctx(),
  );
  clientId = client.id;
  dealId = await createDeal(
    { clientId, title: 'Eski sarlavha', quotedAmount: 200, quotedCurrency: 'USD' },
    ctx(),
  );
});

afterAll(async () => {
  // audit_log refuses DELETE by database rule; what this file made goes, the
  // trail it left stays.
  await db.delete(events).where(inArray(events.entityId, [dealId, leadId]));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('the lead form', () => {
  const form = (over: Record<string, string> = {}) => ({
    name: `Audit sinov ${SUFFIX}`,
    phone: '+998900000000',
    company: 'Eski firma',
    sourceId: '',
    stageId,
    ownerId: actorId,
    note: '',
    nextActionAt: '',
    nextActionNote: '',
    ...over,
  });

  it('records the field the person actually corrected', async () => {
    // The old payload named name/stageId/ownerId only, so this edit — the
    // single most common one on the card — was invisible in the history.
    await updateLead(leadId, form({ phone: '+998911112233' }), ctx());
    const rows = await trail('lead', leadId);
    const last = rows.at(-1)!;
    expect(last.action).toBe('update');
    expect(last.after).toEqual({ phone: '+998911112233' });
    expect(last.before).toEqual({ phone: '+998900000000' });
  });

  it('says nothing when the person changed nothing', async () => {
    const before = (await trail('lead', leadId)).length;
    await updateLead(leadId, form({ phone: '+998911112233' }), ctx());
    expect((await trail('lead', leadId)).length).toBe(before);
  });

  it('records several corrections in one save as one row naming all of them', async () => {
    await updateLead(leadId, form({ phone: '+998911112233', company: 'Yangi firma', note: 'izoh' }), ctx());
    const last = (await trail('lead', leadId)).at(-1)!;
    expect(last.after).toEqual({ company: 'Yangi firma', note: 'izoh' });
  });
});

describe('the deal form', () => {
  it('does not move the quote onto whoever last fixed a typo', async () => {
    // `quoted_amount` comes back "200.00" while the form sends "200". Compared
    // as strings that is a re-pricing, and the deal's own record of WHO named
    // the price and WHEN was overwritten on every unrelated save.
    const [before] = await db.select().from(deals).where(eq(deals.id, dealId));
    await updateDeal(
      dealId,
      { clientId, title: 'Yangi sarlavha', quotedAmount: 200, quotedCurrency: 'USD' },
      ctx(),
    );
    const [after] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(after!.quotedAt?.getTime()).toBe(before!.quotedAt?.getTime());
    expect(after!.quotedBy).toBe(before!.quotedBy);
  });

  it('records the title, which the amount-and-volume payload never could', async () => {
    const last = (await trail('deal', dealId)).at(-1)!;
    expect(last.after).toEqual({ title: 'Yangi sarlavha' });
    expect(last.before).toEqual({ title: 'Eski sarlavha' });
  });

  it('does not print an unchanged price as a change', async () => {
    // "200.00 → 200" was on the deal card every time anything else was saved.
    // The `create` row names the price it was opened at, and should.
    const rows = (await trail('deal', dealId)).filter((row) => row.action === 'update');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys((row.after ?? {}) as Record<string, unknown>)).not.toContain('amount');
    }
  });

  it('still records a real re-pricing, and stamps it', async () => {
    const [before] = await db.select().from(deals).where(eq(deals.id, dealId));
    await updateDeal(
      dealId,
      { clientId, title: 'Yangi sarlavha', quotedAmount: 350, quotedCurrency: 'USD' },
      ctx(),
    );
    const [after] = await db.select().from(deals).where(eq(deals.id, dealId));
    expect(Number(after!.quotedAmount)).toBe(350);
    expect(after!.quotedAt!.getTime()).toBeGreaterThan(before!.quotedAt!.getTime());

    const [last] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'deal'), eq(auditLog.entityId, dealId)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(last!.after).toEqual({ amount: '350' });
    expect(last!.before).toEqual({ amount: '200' });
  });
});
