import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { moveLead, setLeadOwner } from '@/modules/wms/crm/service';

/**
 * What a bulk press must still do, per row.
 *
 * The actions loop over these same two functions — one `run()` around the
 * loop, so one permission check and one revalidate, but the WRITE stays
 * per-lead because `moveLead` is the only path that audits and emits
 * `LeadStageChanged`. A bare `UPDATE … WHERE id IN (…)` would be a silent
 * third stage-write path, exactly the shape round 18 closed. These tests
 * hold that: they call what the action calls and then look for the trail.
 */

const SUFFIX = String(Date.now()).slice(-7);
const NAME = `Bulk sinov ${SUFFIX}`;

let actorId = '';
let otherId = '';
let openStage = '';
let secondStage = '';
let lostStage = '';
const created: string[] = [];

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admins[0]!.id;
  otherId = (await db.select({ id: users.id }).from(users).limit(5)).find(
    (row) => row.id !== actorId,
  )!.id;

  const stages = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder));
  openStage = stages.find((row) => row.kind === 'open')!.id;
  secondStage = stages.filter((row) => row.kind === 'open')[1]?.id ?? openStage;
  lostStage = stages.find((row) => row.kind === 'lost')!.id;

  for (let index = 0; index < 3; index += 1) {
    const [row] = await db
      .insert(leads)
      .values({ name: `${NAME} ${index}`, stageId: openStage, createdBy: actorId })
      .returning();
    created.push(row!.id);
  }
});

afterAll(async () => {
  // Events too: an unprocessed LeadStageChanged pointing at a deleted lead is
  // work the rules engine would pick up on the next sweep (#154, #380).
  await db.delete(events).where(inArray(events.entityId, created));
  // The audit rows STAY: the database refuses to delete them («audit_log is
  // append-only»), which is the whole point of an audit log and is the right
  // answer. They point at a lead id that no longer exists, which is what a
  // record of a deletion looks like.
  await db.delete(leads).where(inArray(leads.id, created));
  await pgClient.end();
});

const ctx = () => ({ actorId, ip: null, userAgent: null });

describe('moving several leads', () => {
  it('writes an audit row for every one of them', async () => {
    for (const id of created) await moveLead(id, secondStage, '', ctx());

    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(and(inArray(auditLog.entityId, created), eq(auditLog.entityType, 'lead')));
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(created.length);
  });

  it('leaves a stage event behind for the automation rules to hear', async () => {
    // The phase-7 engine and the deal cargo-trigger both read these; a bulk
    // move that skipped them would look right on the board and fire nothing.
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(and(eq(events.type, 'LeadStageChanged'), inArray(events.entityId, created)));
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(created.length);
  });

  it('refuses a lost move with no reason, and says so per row', async () => {
    await expect(moveLead(created[0]!, lostStage, '', ctx())).rejects.toMatchObject({
      code: 'reason_required',
    });
    // …and the lead stayed where it was, rather than half-moving.
    const [row] = await db.select().from(leads).where(eq(leads.id, created[0]!));
    expect(row!.stageId).toBe(secondStage);
  });

  it('accepts the same move once a reason is given', async () => {
    await moveLead(created[0]!, lostStage, 'mijoz boshqa firmani tanladi', ctx());
    const [row] = await db.select().from(leads).where(eq(leads.id, created[0]!));
    expect(row!.stageId).toBe(lostStage);
    expect(row!.lostReason).toBe('mijoz boshqa firmani tanladi');
  });
});

describe('handing several leads to somebody', () => {
  it('changes the owner and nothing else', async () => {
    const before = await db.select().from(leads).where(eq(leads.id, created[1]!));
    await setLeadOwner(created[1]!, otherId, ctx());
    const [after] = await db.select().from(leads).where(eq(leads.id, created[1]!));

    expect(after!.ownerId).toBe(otherId);
    // `updateLead` would have blanked these; the narrow function is why the
    // bulk bar can hand over a lead it only knows the id of.
    expect(after!.name).toBe(before[0]!.name);
    expect(after!.stageId).toBe(before[0]!.stageId);
    expect(after!.note).toBe(before[0]!.note);
  });

  it('audits the handover', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, created[1]!), eq(auditLog.action, 'update')));
    expect(rows.some((row) => (row.after as { ownerId?: string })?.ownerId === otherId)).toBe(true);
  });

  it('does nothing at all when the owner is already that person', async () => {
    const before = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.entityId, created[1]!));
    await setLeadOwner(created[1]!, otherId, ctx());
    const after = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(eq(auditLog.entityId, created[1]!));
    // A sweep over twenty leads where nineteen already belong to the person
    // must not write nineteen audit rows saying nothing changed.
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });
});
