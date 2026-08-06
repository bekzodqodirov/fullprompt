import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, leadStages, leads, roles, userRoles, users } from '@/modules/platform/db/schema';
import { INLINE_LEAD_FIELDS, patchLead } from '@/modules/wms/crm/inline';

/**
 * Patching ONE field of a lead.
 *
 * The rules worth holding are the ones a whole-form save gets for free and a
 * one-field patch has to earn: it must not touch the columns it was not given,
 * it must not rewrite the row (and reorder the owner's board) when nothing
 * changed, it must refuse a field that is not on the list, and its audit line
 * must say what actually changed rather than restating the record.
 */

const SUFFIX = String(Date.now()).slice(-7);
const NAME = `Inline sinov ${SUFFIX}`;

let actorId = '';
let leadId = '';

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
  const [row] = await db
    .insert(leads)
    .values({
      name: NAME,
      phone: '+998900000000',
      company: 'Eski firma',
      note: 'eski izoh',
      stageId: stage!.id,
      ownerId: actorId,
      createdBy: actorId,
    })
    .returning();
  leadId = row!.id;
});

afterAll(async () => {
  // audit_log refuses DELETE by database rule; the lead goes, the trail stays.
  await db.delete(leads).where(inArray(leads.id, [leadId]));
  await pgClient.end();
});

const ctx = () => ({ actorId, ip: null, userAgent: null });

describe('what a one-field patch touches', () => {
  it('changes the field it was given and nothing else', async () => {
    const before = (await db.select().from(leads).where(eq(leads.id, leadId)))[0]!;
    await patchLead(leadId, 'phone', '+998911112233', ctx());
    const after = (await db.select().from(leads).where(eq(leads.id, leadId)))[0]!;

    expect(after.phone).toBe('+998911112233');
    // The whole-form action would have rewritten all nine columns from the
    // inputs it was rendered with; this one may not.
    expect(after.name).toBe(before.name);
    expect(after.company).toBe(before.company);
    expect(after.note).toBe(before.note);
    expect(after.stageId).toBe(before.stageId);
    expect(after.ownerId).toBe(before.ownerId);
  });

  it('empties a field when the box is cleared', async () => {
    await patchLead(leadId, 'company', '   ', ctx());
    const [row] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(row!.company).toBeNull();
  });

  it('refuses a value longer than the column holds', async () => {
    await expect(patchLead(leadId, 'phone', '9'.repeat(41), ctx())).rejects.toMatchObject({
      code: 'validation',
    });
  });
});

describe('what it refuses', () => {
  it('will not patch a field that is not on the list', async () => {
    // A stage is a move, an owner is a handover, and the follow-up date is
    // written as a pair with its note — none of them is a text box.
    for (const field of ['stageId', 'ownerId', 'nextActionAt', 'clientId', 'lostReason']) {
      await expect(patchLead(leadId, field, 'x', ctx())).rejects.toMatchObject({
        code: 'field_not_editable',
      });
    }
    expect([...INLINE_LEAD_FIELDS]).toEqual(['phone', 'company', 'note']);
  });

  it('will not patch the NAME — the owner had that control removed', async () => {
    // Owner, 2026-08-06: «lead kartochkasida nomni ustiga bosib o'zgartirish …
    // buni umuman olib tashla». The control is off the card AND the door is
    // shut here, which is the difference between removed and merely hidden.
    await expect(patchLead(leadId, 'name', 'Yangi nom', ctx())).rejects.toMatchObject({
      code: 'field_not_editable',
    });
  });

  it('needs an actor', async () => {
    await expect(
      patchLead(leadId, 'note', 'x', { actorId: null, ip: null, userAgent: null }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('what it writes down', () => {
  it('does nothing at all when the value is unchanged', async () => {
    const before = (await db.select().from(leads).where(eq(leads.id, leadId)))[0]!;
    const auditBefore = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.entityId, leadId));

    await patchLead(leadId, 'phone', before.phone!, ctx());

    const after = (await db.select().from(leads).where(eq(leads.id, leadId)))[0]!;
    const auditAfter = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.entityId, leadId));

    // `updated_at` is not decoration: the funnel orders by it, so a save that
    // rewrites an unchanged row reshuffles the owner's board for nothing.
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(Number(auditAfter[0]!.n)).toBe(Number(auditBefore[0]!.n));
  });

  it('audits the CHANGE, not the record', async () => {
    await patchLead(leadId, 'note', 'yangi izoh', ctx());
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, 'update')))
      // Postgres returns rows in NO order unless asked, and this file writes
      // three update rows for the same lead. `at(-1)` read the right one for
      // four rounds and then handed back the `company` row on CI — audit_log
      // takes no deletes but it does take ROLLED-BACK inserts, whose dead
      // tuples autovacuum frees for a later row to land in, so physical order
      // stops being insertion order the moment the suite grows. An unordered
      // read must never be indexed into.
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    const last = rows.at(-1)!;
    expect(last.after).toEqual({ note: 'yangi izoh' });
    expect(last.before).toEqual({ note: 'eski izoh' });
  });
});
