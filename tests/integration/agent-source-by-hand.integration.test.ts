import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { crmActivities, leadSources, leads, roles, userRoles, users } from '@/modules/platform/db/schema';
import { createLead, updateLead } from '@/modules/wms/crm/service';

/**
 * «Agent (qidiruv)» is written by the agent's door alone (the merge review's
 * suspected item, verified): the lead form only HIDES it, so a hand-posted
 * `sourceId` naming it used to tag a hand-made lead as the agent's — counted
 * in the agent's figures on /crm/tahlil and, since #1569, holding its AI
 * replies to the agent's playbook window. The service refuses it now, and
 * still lets the machine write it and a person re-post a lead's own source.
 */

const STAMP = String(Date.now()).slice(-7);
const NAME = (tag: string) => `Qolda ${STAMP} ${tag}`;
let adminId = '';
let agentSourceId = '';
let otherSourceId = '';

beforeAll(async () => {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, 'super_admin'), eq(users.active, true)))
    .limit(1);
  adminId = admin!.id;
  const [agent] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.key, 'agent'));
  const [other] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.key, 'instagram'));
  agentSourceId = agent!.id;
  otherSourceId = other!.id;
});

afterAll(async () => {
  const made = await db.select({ id: leads.id }).from(leads).where(like(leads.name, `Qolda ${STAMP}%`));
  const ids = made.map((row) => row.id);
  if (ids.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, ids));
    await db.delete(leads).where(inArray(leads.id, ids));
  }
  await pgClient.end();
});

describe('the agent’s source by hand', () => {
  it('a person’s create naming it is refused; the machine’s create is not', async () => {
    await expect(createLead({ name: NAME('forged'), sourceId: agentSourceId }, { actorId: adminId })).rejects.toMatchObject({
      code: 'source_not_pickable',
    });
    const machine = await createLead({ name: NAME('machine'), sourceId: agentSourceId }, { actorId: null }, { system: true });
    expect(machine.sourceId).toBe(agentSourceId);
    // Every other source is a person's to pick, as before.
    const person = await createLead({ name: NAME('person'), sourceId: otherSourceId }, { actorId: adminId });
    expect(person.sourceId).toBe(otherSourceId);
  });

  it('an edit may keep an agent lead’s own source, and may not move a lead onto it', async () => {
    const agentLead = await createLead({ name: NAME('agent-own'), sourceId: agentSourceId }, { actorId: null }, { system: true });
    // The ✏️ form re-posts the record's own source (#171): kept, not refused.
    await updateLead(agentLead.id, { name: NAME('agent-own renamed'), sourceId: agentSourceId }, { actorId: adminId });
    const [kept] = await db.select({ name: leads.name, sourceId: leads.sourceId }).from(leads).where(eq(leads.id, agentLead.id));
    expect(kept).toEqual({ name: NAME('agent-own renamed'), sourceId: agentSourceId });

    const handMade = await createLead({ name: NAME('hand'), sourceId: otherSourceId }, { actorId: adminId });
    await expect(
      updateLead(handMade.id, { name: NAME('hand'), sourceId: agentSourceId }, { actorId: adminId }),
    ).rejects.toMatchObject({ code: 'source_not_pickable' });
    const [still] = await db.select({ sourceId: leads.sourceId }).from(leads).where(eq(leads.id, handMade.id));
    expect(still!.sourceId).toBe(otherSourceId);
  });
});
