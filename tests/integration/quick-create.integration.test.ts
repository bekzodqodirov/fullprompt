import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, isNotNull, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, leadStages, leads } from '@/modules/platform/db/schema';
import { createLead } from '@/modules/wms/crm/service';
import { createClient } from '@/modules/platform/clients/service';
import { quickCreateLeadAction } from '@/app/(protected)/crm/actions';

/**
 * What the two-box quick form leaves behind.
 *
 * The point of this file is the DEFAULTS. The modal asks for a name and a
 * phone because everything else already has an answer — the first stage, the
 * person who typed it, the next client code — and if any of those defaults
 * stopped working the modal would silently create half a record. The actions
 * are thin wrappers over exactly these two service calls, so this proves the
 * part that can be wrong.
 */

const SUFFIX = String(Date.now()).slice(-7);
const LEAD = `Tez lid ${SUFFIX}`;
const CLIENT = `Tez mijoz ${SUFFIX}`;

let actorId = '';
let firstStage = '';

beforeAll(async () => {
  // A lead with a real author: `created_by` is nullable since 0065 (a lead an
  // advert created has none), so the first row is not necessarily a person.
  const [row] = await db
    .select({ id: leads.createdBy })
    .from(leads)
    .where(isNotNull(leads.createdBy))
    .limit(1);
  actorId = row!.id!;
  const stages = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder));
  firstStage = stages.find((stage) => stage.kind === 'open')!.id;
});

afterAll(async () => {
  await db.delete(leads).where(like(leads.name, `Tez lid ${SUFFIX}%`));
  // A client is closer to CONFIGURATION than to data (#183): it enters every
  // picker, the client book, and round 58's phone search. It goes.
  await db.delete(clients).where(like(clients.name, `Tez mijoz ${SUFFIX}%`));
  await pgClient.end();
});

const ctx = () => ({ actorId, ip: null, userAgent: null });

describe('a lead from two boxes', () => {
  it('lands on the first stage and belongs to whoever typed it', async () => {
    const lead = await createLead({ name: LEAD, phone: '+998901112233' }, ctx());
    const [row] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.stageId).toBe(firstStage);
    expect(row!.ownerId).toBe(actorId);
    expect(row!.phone).toBe('+998901112233');
  });

  it('refuses a name too short to be a name — in the ACTION, where the rule is', async () => {
    // `createLead` does not validate: the full form's zod schema runs in the
    // action, so the quick action carries its own copy of the same minimum.
    // The guard runs BEFORE any permission check, which is why this can be
    // asserted with no session — and is also why a one-letter lead can never
    // reach the database through this door.
    const before = await db.select({ id: leads.id }).from(leads);
    const result = await quickCreateLeadAction({ name: 'A', phone: '' });
    expect(result).toEqual({ ok: false, error: 'validation' });
    const after = await db.select({ id: leads.id }).from(leads);
    expect(after.length).toBe(before.length);
  });
});

describe('a client from two boxes', () => {
  it('is given the next code, because the form sends none', async () => {
    const row = await createClient(
      { clientCode: '', name: CLIENT, phones: ['+998901112233'] },
      ctx(),
    );
    expect(row.clientCode).toMatch(/^GS\d+$/);
    expect(row.name).toBe(CLIENT);
    expect(row.phones).toEqual(['+998901112233']);
  });

  it('gives the NEXT one to the next client, rather than colliding', async () => {
    const first = await db
      .select()
      .from(clients)
      .where(eq(clients.name, CLIENT))
      .limit(1);
    const second = await createClient(
      { clientCode: '', name: `${CLIENT} 2`, phones: [] },
      ctx(),
    );
    expect(second.clientCode).not.toBe(first[0]!.clientCode);
  });
});
