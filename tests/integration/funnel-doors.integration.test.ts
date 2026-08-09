import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  dealStages,
  deals,
  events,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { CrmError, createLead, listStages, moveLead, updateLead } from '@/modules/wms/crm/service';
import { DealError, createDeal, moveDeal, updateDeal } from '@/modules/wms/deals/service';

/**
 * Round 83 — the funnel has two doors and only one of them knows the law.
 *
 * `moveLead`/`moveDeal` refuse a move into a lost stage without a written
 * reason, and clear that reason on the way back out. The ✏️ form writes
 * `stage_id` through `updateLead`/`updateDeal`, which do neither — and the
 * form offers a stage `<select>` listing every stage, so this is an ordinary
 * press and not a forged post.
 *
 * The consequences are a lead lost with nobody's reason on it, and a REVIVED
 * lead still carrying the reason it was lost for — which the card prints, in
 * red, above an open lead.
 */

const MARK = `R83-${String(Date.now()).slice(-7)}`;

let actorId = '';
let openStage = '';
let lostStage = '';
let openDealStage = '';
let lostDealStage = '';
let clientId = '';
const madeLeads: string[] = [];
const madeDeals: string[] = [];

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admin!.id;

  // The owner names his own funnel, so the stages are found by KIND and never
  // by position or by label (#513's rule, in a fixture).
  const stages = await listStages();
  openStage = stages.find((s) => s.kind === 'open')!.id;
  lostStage = stages.find((s) => s.kind === 'lost')!.id;

  const dStages = await db.select().from(dealStages);
  openDealStage = dStages.find((s) => s.kind === 'open')!.id;
  lostDealStage = dStages.find((s) => s.kind === 'lost')!.id;

  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);
  clientId = client!.id;
});

afterAll(async () => {
  await db.delete(events).where(inArray(events.entityId, [...madeLeads, ...madeDeals]));
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await pgClient.end();
});

const newLead = async (stageId = openStage) => {
  const lead = await createLead({ name: `${MARK} lid`, stageId }, ctx());
  madeLeads.push(lead.id);
  return lead.id;
};

const leadRow = async (id: string) =>
  (await db.select().from(leads).where(eq(leads.id, id)))[0]!;

const formInput = (over: Record<string, unknown> = {}) => ({
  name: `${MARK} lid`,
  phone: '',
  company: '',
  sourceId: '',
  ownerId: '',
  note: '',
  nextActionAt: '',
  nextActionNote: '',
  ...over,
});

describe('the ✏️ form is the funnel’s second door', () => {
  it('refuses to lose a lead without a reason, as the board does', async () => {
    const id = await newLead();
    // The control: the guarded door already refuses this.
    await expect(moveLead(id, lostStage, '', ctx())).rejects.toThrow(CrmError);
    // …and so must the form, which offers the same stage in a <select>.
    await expect(
      updateLead(id, formInput({ stageId: lostStage }) as never, ctx()),
    ).rejects.toThrow(CrmError);
    expect((await leadRow(id)).stageId).toBe(openStage);
  });

  it('clears the reason when a lost lead is revived through the form', async () => {
    const id = await newLead();
    await moveLead(id, lostStage, 'narx qimmat', ctx());
    expect((await leadRow(id)).lostReason).toBe('narx qimmat');

    await updateLead(id, formInput({ stageId: openStage }) as never, ctx());
    const row = await leadRow(id);
    expect(row.stageId).toBe(openStage);
    // The card prints this in red above the lead. An open lead carrying the
    // reason it was once lost for is a screen nobody can read.
    expect(row.lostReason).toBeNull();
  });

  it('leaves a lead that is not moving exactly where it is', async () => {
    // The guard must not turn an ordinary save — a corrected phone — into a
    // refusal on a lead that is already lost.
    const id = await newLead();
    await moveLead(id, lostStage, 'boshqa firma', ctx());
    await updateLead(id, formInput({ stageId: lostStage, phone: '+998901112233' }) as never, ctx());
    const row = await leadRow(id);
    expect(row.stageId).toBe(lostStage);
    expect(row.phone).toBe('+998901112233');
    // Not moving is not a revival: the reason it was lost for stays.
    expect(row.lostReason).toBe('boshqa firma');
  });
});

describe('the deal card’s ✏️ form is the same door', () => {
  const newDeal = async () => {
    const id = await createDeal(
      { clientId, title: `${MARK} bitim`, stageId: openDealStage } as never,
      ctx(),
    );
    madeDeals.push(id);
    return id;
  };
  const dealRow = async (id: string) => (await db.select().from(deals).where(eq(deals.id, id)))[0]!;

  it('refuses a lost stage with no reason', async () => {
    const id = await newDeal();
    await expect(moveDeal(id, lostDealStage, ctx())).rejects.toThrow(DealError);
    await expect(
      updateDeal(id, { title: `${MARK} bitim`, stageId: lostDealStage } as never, ctx()),
    ).rejects.toThrow(DealError);
    expect((await dealRow(id)).stageId).toBe(openDealStage);
  });

  it('clears the reason when a lost deal is revived through the form', async () => {
    const id = await newDeal();
    await moveDeal(id, lostDealStage, ctx(), 'mijoz voz kechdi');
    expect((await dealRow(id)).lostReason).toBe('mijoz voz kechdi');

    await updateDeal(id, { title: `${MARK} bitim`, stageId: openDealStage } as never, ctx());
    const row = await dealRow(id);
    expect(row.stageId).toBe(openDealStage);
    expect(row.lostReason).toBeNull();
  });
});

describe('the stage picker does not offer what the service refuses', () => {
  it('a lost stage is off the lead form unless the lead is already in it', async () => {
    const stages = await listStages();
    const { formStages } = await import('@/modules/wms/crm/stage-law');
    // An open lead is not offered the lost stage — the reason belongs to the
    // funnel's own dialog, which asks for it.
    expect(formStages(stages, openStage).some((s) => s.kind === 'lost')).toBe(false);
    // …but a lead that IS lost keeps its own stage in the list, or the select
    // would fall back to the first option and SAVING would move the lead.
    const own = formStages(stages, lostStage);
    expect(own.some((s) => s.id === lostStage)).toBe(true);
  });
});

describe('nothing here left the funnel dirty', () => {
  it('every lead this file made is accounted for', async () => {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
      .where(and(inArray(leads.id, madeLeads)));
    expect(rows).toHaveLength(madeLeads.length);
  });
});
