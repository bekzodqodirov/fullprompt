import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  crmActivities,
  leadIntakes,
  leadStages,
  leads,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { PHONE_CAP_PER_DAY, landInboundLead, nextInboundOwner } from '@/modules/wms/crm/inbound';
import { followUps } from '@/modules/wms/crm/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { createClient } from '@/modules/platform/clients/service';

/**
 * A lead that arrives by itself — from an advert, the public form, the bot.
 *
 * What this file proves is the LANDING, because that is where every decision
 * is: whether the person is already a customer, whether this is the same
 * enquiry as yesterday's, whose turn it is, and whether somebody is simply
 * hammering the form. Each of those is a way to damage a real card, and none
 * of them can be checked by reading the door that calls it.
 */

const STAMP = String(Date.now()).slice(-7);
const NAME = `Reklama lid ${STAMP}`;
const TODAY = new Date().toISOString().slice(0, 10);

// Real Uzbek-shaped numbers, distinct in their last NINE digits — which is
// what every phone comparison in this app actually matches on.
const P1 = `+9989${STAMP}11`.slice(0, 13);
const P2 = `+9989${STAMP}22`.slice(0, 13);
const P3 = `+9989${STAMP}33`.slice(0, 13);
const P4 = `+9989${STAMP}44`.slice(0, 13);

let rotaRoleId = '';
let sellerA = '';
let sellerB = '';
let outsiderId = '';
let clientId = '';

beforeAll(async () => {
  const [role] = await db
    .insert(roles)
    .values({
      code: `rota_${STAMP}`,
      name: `Navbat ${STAMP}`,
      isSystem: false,
      // OFF to start with: the first thing this file asks is what happens when
      // nobody is in the rotation, which is the state on the morning of the
      // deploy.
      inboundRota: false,
    })
    .returning({ id: roles.id });
  rotaRoleId = role!.id;

  const mint = async (suffix: string, roleId: string | null) => {
    const [row] = await db
      .insert(users)
      .values({
        phone: `+99893${STAMP.slice(-5)}${suffix}`,
        fullName: `Sotuvchi ${suffix} ${STAMP}`,
        passwordHash: 'x',
        active: true,
      })
      .returning({ id: users.id });
    if (roleId) await db.insert(userRoles).values({ userId: row!.id, roleId });
    return row!.id;
  };
  sellerA = await mint('01', rotaRoleId);
  sellerB = await mint('02', rotaRoleId);
  // Holds no rota role: the rotation must not reach him, and he is the one who
  // proves an unclaimed lead shows on somebody else's call list.
  outsiderId = await mint('03', null);

  // Authored by somebody who was already here: `audit_log` refuses DELETE by
  // database rule, so a user this file minted and then named as an actor could
  // never be removed again (round 59's lesson, from the other direction).
  const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
  const client = await createClient(
    { name: `Reklama mijoz ${STAMP}`, phones: [P4] },
    { actorId: seeded!.id, ip: null, userAgent: null },
  );
  clientId = client.id;
});

afterAll(async () => {
  await db.delete(leadIntakes).where(like(leadIntakes.name, `%${STAMP}%`));
  const made = await db
    .select({ id: leads.id })
    .from(leads)
    .where(like(leads.name, `%${STAMP}%`));
  for (const row of made) {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, row.id));
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, clientId));
  await db.delete(leads).where(like(leads.name, `%${STAMP}%`));
  await db.delete(clients).where(eq(clients.id, clientId));
  // A ROLE is configuration (#183): while it exists with the flag on it takes
  // part in every rotation the next spec runs.
  await db.delete(userRoles).where(eq(userRoles.roleId, rotaRoleId));
  await db.delete(roles).where(eq(roles.id, rotaRoleId));
  await db.delete(users).where(like(users.fullName, `Sotuvchi %${STAMP}`));
  await pgClient.end();
});

const arrival = (over: Partial<Parameters<typeof landInboundLead>[0]> = {}) => ({
  channel: 'form' as const,
  sourceKey: 'instagram',
  name: NAME,
  phone: P1,
  note: 'Guangzhoudan 2 kub yuk',
  ...over,
});

describe('a lead nobody typed', () => {
  it('is created, booked for today, and says so in the ledger', async () => {
    const result = await landInboundLead(arrival());
    expect(result.outcome).toBe('created');

    const [row] = await db.select().from(leads).where(eq(leads.id, result.leadId!));
    // No author. `created_by` was NOT NULL until 0065 precisely because every
    // lead came from a person; naming the round-robin owner as the author
    // would put a sentence in the audit trail that nobody said.
    expect(row!.createdBy).toBeNull();
    expect(row!.inboundAt).not.toBeNull();
    // The whole point of paying for the advert: it is on somebody's call list
    // the day it arrives, not whenever a person notices it.
    expect(row!.nextActionAt).toBe(TODAY);
    // Nobody is in the rotation yet, so it belongs to nobody — and that is a
    // state the call list has to survive, not an error.
    expect(row!.ownerId).toBeNull();

    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.leadId, result.leadId!));
    expect(intake!.outcome).toBe('created');
    expect(intake!.sourceKey).toBe('instagram');
    // Stored as the app's phone identity, so the caps can count it.
    expect(intake!.phone).toBe(P1.replace(/[^0-9]/g, '').slice(-9));

    const notes = await db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.entityId, result.leadId!));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('Guangzhoudan 2 kub yuk');
    expect(notes[0]!.createdBy).toBeNull();
  });

  it('sits on a seller call list even though it belongs to nobody', async () => {
    // The seller asks for HIS list — the only question `/bugun` ever asks —
    // and an unclaimed lead has to be in the answer. Without the isNull branch
    // an advert lead lands where literally nobody is looking.
    const mine = await followUps(TODAY, outsiderId);
    expect(mine.some((row) => row.title === NAME)).toBe(true);
  });

  it('joins the open lead when the same number writes again', async () => {
    const before = await db
      .select()
      .from(leads)
      .where(like(leads.name, `%${STAMP}%`));
    const result = await landInboundLead(arrival({ note: 'yana bir savol' }));
    expect(result.outcome).toBe('joined');

    const after = await db
      .select()
      .from(leads)
      .where(like(leads.name, `%${STAMP}%`));
    expect(after).toHaveLength(before.length);

    const notes = await db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.entityId, result.leadId!));
    expect(notes).toHaveLength(2);
    // Both boards order and cap by `updated_at`, so a second enquiry that did
    // not move the card would be invisible exactly where somebody is looking.
    const [row] = await db.select().from(leads).where(eq(leads.id, result.leadId!));
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.find((l) => l.id === result.leadId)!.updatedAt.getTime(),
    );
  });

  it('lands on the CLIENT card when the number is already in the book', async () => {
    const result = await landInboundLead(arrival({ phone: P4, name: `Mijoz yozdi ${STAMP}` }));
    expect(result.outcome).toBe('client');
    expect(result.clientId).toBe(clientId);

    // No parallel history: a coded client's question belongs on the card that
    // carries their cargo and their balance.
    const strays = await db
      .select()
      .from(leads)
      .where(like(leads.name, `Mijoz yozdi ${STAMP}`));
    expect(strays).toHaveLength(0);

    const notes = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'client'), eq(crmActivities.entityId, clientId)));
    expect(notes).toHaveLength(1);
  });

  it('drops the fourth attempt from one number and records why', async () => {
    // Two arrivals are already on the ledger for P1 (created + joined), so the
    // third is the last one allowed and the fourth is over the ceiling. The
    // cap counts ARRIVALS, not leads — a flood that was correctly joined still
    // counts, or the ceiling is escapable by repeating yourself.
    expect(PHONE_CAP_PER_DAY).toBe(3);
    await landInboundLead(arrival({ note: 'uchinchi' }));

    const result = await landInboundLead(arrival({ note: 'tortinchi' }));
    expect(result.outcome).toBe('dropped');
    expect(result.reason).toBe('capped');

    const notes = await db
      .select()
      .from(crmActivities)
      .where(like(crmActivities.note, '%tortinchi%'));
    expect(notes).toHaveLength(0);

    // Recorded anyway. A `leads` row cannot say that a lead was deliberately
    // not created, and «why did the advert produce nothing today» has to have
    // an answer.
    const capped = await db
      .select()
      .from(leadIntakes)
      .where(and(eq(leadIntakes.name, NAME), eq(leadIntakes.reason, 'capped')));
    expect(capped.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses the second delivery of the same advert lead', async () => {
    const first = await landInboundLead(
      arrival({ channel: 'meta', phone: P2, externalId: `lg_${STAMP}` }),
    );
    expect(first.outcome).toBe('created');

    // Meta re-sends until it is answered 200, so this is the ordinary case,
    // not an attack — and it is refused by the database's own unique index,
    // never by a check somebody can forget.
    const again = await landInboundLead(
      arrival({ channel: 'meta', phone: P2, externalId: `lg_${STAMP}` }),
    );
    expect(again.outcome).toBe('dropped');
    expect(again.reason).toBe('replay');

    const rows = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.externalId, `lg_${STAMP}`));
    expect(rows).toHaveLength(1);
  });

  it('shows what the person wrote ON THE LENTA, with no author', async () => {
    // Found by the browser, not by reading. `clientFeed` INNER-joined the
    // note's author, and 0065 made `crm_activities.created_by` nullable — so
    // an advert lead's only message was dropped from the one place the seller
    // looks, and the card rendered empty while the enquiry sat in the
    // database. Every lenta read has to survive a note a machine wrote.
    const landed = await landInboundLead(
      arrival({ phone: `+9989${STAMP}77`.slice(0, 13), name: `Lenta ${STAMP}`, note: 'lenta sinov' }),
    );
    const feed = await clientFeed(null, { leadId: landed.leadId!, limit: 20 });
    const note = feed.find((row) => row.body?.includes('lenta sinov'));
    expect(note, 'the advert message is missing from the lenta').toBeTruthy();
    expect(note!.actor).toBeNull();
  });
});

describe('whose turn it is', () => {
  beforeAll(async () => {
    await db.update(roles).set({ inboundRota: true }).where(eq(roles.id, rotaRoleId));
  });

  it('never reaches somebody who is not in the rotation', async () => {
    const owner = await nextInboundOwner();
    expect([sellerA, sellerB]).toContain(owner);
    expect(owner).not.toBe(outsiderId);
  });

  it('hands two arrivals to two different people', async () => {
    // Different numbers on purpose: the same number twice is one enquiry, and
    // «navbat bilan hammaga» is a statement about people, not about messages.
    const first = await landInboundLead(arrival({ phone: P3, name: `Navbat bir ${STAMP}` }));
    const second = await landInboundLead(
      arrival({ phone: `+9989${STAMP}55`.slice(0, 13), name: `Navbat ikki ${STAMP}` }),
    );

    const [a] = await db.select().from(leads).where(eq(leads.id, first.leadId!));
    const [b] = await db.select().from(leads).where(eq(leads.id, second.leadId!));
    expect(a!.ownerId).not.toBeNull();
    expect(b!.ownerId).not.toBeNull();
    expect(a!.ownerId).not.toBe(b!.ownerId);
    expect([sellerA, sellerB]).toContain(a!.ownerId);
    expect([sellerA, sellerB]).toContain(b!.ownerId);
  });
});

describe('the open-stage fence', () => {
  it('opens a NEW lead when the old one was lost', async () => {
    const lost = await db.select().from(leadStages).where(eq(leadStages.kind, 'lost')).limit(1);
    const phone = `+9989${STAMP}66`.slice(0, 13);
    const first = await landInboundLead(arrival({ phone, name: `Qaytdi ${STAMP}` }));
    await db
      .update(leads)
      .set({ stageId: lost[0]!.id, lostReason: 'sinov' })
      .where(eq(leads.id, first.leadId!));

    // Somebody who was lost and came back is a NEW enquiry — joining it onto
    // the closed card would hide it from the person whose job it now is.
    const again = await landInboundLead(arrival({ phone, name: `Qaytdi ${STAMP}` }));
    expect(again.outcome).toBe('created');
    expect(again.leadId).not.toBe(first.leadId);
  });
});
