import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  crmActivities,
  events,
  leadStages,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest, requestAsks } from '@/modules/wms/calc/service';
import { loadWorkspace } from '@/modules/wms/calc/workspace';

/**
 * A STORED request derives nothing (docs/SAKKIZ-R2.md §8.2.2, judge
 * regression-3).
 *
 * The collector sums the lines' m³ when nobody typed a total, and the landing
 * stores that Σ at its INSERT. A request already STORED with `volume_m3` null
 * — every request landed before the deploy, or one the VED cleared — is what
 * the workspace's freight prices, and it refuses `measure_missing`. Were the
 * VED's checklist chip to sum the lines there, it would call the volume
 * present while the engine refuses for want of it: a need and a refusal that
 * disagree, #649's shape. The two are read here through their own doors.
 */
const SUFFIX = String(Date.now()).slice(-6);

let actorId = '';
let leadId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  // A requester of this file's own (the per-requester open cap, #653).
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99892${String(Date.now()).slice(-7)}`,
      fullName: `R2 stored-volume fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
  const [lead] = await db
    .insert(leads)
    .values({ name: `R2 stored-volume ${SUFFIX}`, stageId: stage!.id, createdBy: actorId })
    .returning();
  leadId = lead!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('a stored request with no m³ is asked for it, whatever its lines say', () => {
  it('the chip and the freight engine agree', async () => {
    const opened = await openCalcRequest(
      {
        entityType: 'lead',
        entityId: leadId,
        section: 'yolkira',
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        weightKg: 3500,
        freightZone: 'cn',
        items: [
          { name: `Kurtka ${SUFFIX}`, quantity: 300, volumeM3: 1.2 },
          { name: `Shim ${SUFFIX}`, quantity: 200, volumeM3: 1.6 },
        ],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(opened.id);

    // Landed today, the Σ is stored — both doors see a volume.
    expect((await requestAsks(opened.id)).missing).not.toContain('volumeM3');
    expect((await loadWorkspace(opened.id))!.freight).not.toMatchObject({ reason: 'measure_missing' });

    // The same request as one landed before the deploy (or cleared by the
    // VED): the column is null, the lines still carry 1.2 + 1.6 m³.
    await db.update(calcRequests).set({ volumeM3: null }).where(eq(calcRequests.id, opened.id));
    expect((await requestAsks(opened.id)).missing).toContain('volumeM3');
    expect((await loadWorkspace(opened.id))!.freight).toMatchObject({ ok: false, reason: 'measure_missing' });
  });
});
