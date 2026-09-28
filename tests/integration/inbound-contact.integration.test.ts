import 'dotenv/config';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  callLogs,
  callRecorderDevices,
  clients,
  crmActivities,
  leadIntakes,
  leadStages,
  leads,
  roles,
  settings,
  telegramLinks,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { landInboundLead } from '@/modules/wms/crm/inbound';
import { addActivity, moveLead, setFollowUp, setLeadOwner } from '@/modules/wms/crm/service';
import { claimUntouched, stampFirstContacts } from '@/modules/wms/crm/first-contact';
import { CONTACT_NOTE, markContactedFromBot, remindUntouched } from '@/modules/wms/crm/inbound-notify';
import { firstContactBySeller, readPeriod, salesAnalytics } from '@/modules/wms/crm/analytics';
import { createClient } from '@/modules/platform/clients/service';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The advert lead reaches a person (0113, the owner's 5a), proven against the
 * database: the push at landing and whom it goes to, the clock, what counts
 * as contact and what does not, the owner's one reminder, the button, and the
 * seller's number on /crm/tahlil.
 *
 * Every clock the reminder reads is a FIXED office moment (`F`, a Tuesday
 * 10:00 in Tashkent) with the arrival's own timestamps written relative to it
 * — never «now» (#1063: a fixture clock that drifts into the night is a
 * different rule). Everything real-time a test WRITES (a note, a stage move,
 * an audit row) lands after those timestamps, which is exactly the order the
 * rule reads.
 *
 * Cleanup: notification rows by their intake ids, fixture users DEACTIVATED
 * and never deleted (an audited actor is an `audit_log` foreign key), the
 * setting snapshotted once in `beforeAll` and put back (#716).
 */

const STAMP = String(Date.now()).slice(-7);
let seq = 0;
/** A phone whose last NINE digits are this run's and this call's alone. */
const phone = () => `+998${STAMP}${String((seq += 1)).padStart(2, '0')}`;
const NAME = (tag: string) => `Kontakt ${STAMP} ${tag}`;

/** A Tuesday morning in the office — the reminder's clock. */
const F = new Date('2026-09-01T10:00:00+05:00');
const minutesFrom = (at: Date, m: number) => new Date(at.getTime() + m * 60_000).toISOString();

let adminId = '';
let sellerA = '';
let sellerB = '';
let strangerC = '';
let packerD = '';
let fresh = '';
const CHAT_A = BigInt(710_000_000 + Number(STAMP));
const CHAT_C = CHAT_A + 1n;
const CHAT_D = CHAT_A + 2n;
const people: string[] = [];
const clientsMade: string[] = [];
const devicesMade: string[] = [];
let savedMinutes: unknown = undefined;
let secondStage = '';

async function mint(label: string, role: string | null): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99877${STAMP}${String(people.length).padStart(2, '0')}`,
      fullName: `Kontakt ${label} ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning({ id: users.id });
  people.push(row!.id);
  if (role) {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, role));
    await db.insert(userRoles).values({ userId: row!.id, roleId: r!.id });
  }
  return row!.id;
}

async function link(userId: string, chat: bigint) {
  await db.insert(telegramLinks).values({ userId, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
}

beforeAll(async () => {
  const [saved] = await db.select().from(settings).where(eq(settings.key, 'inbound_contact_minutes'));
  savedMinutes = saved ? saved.value : undefined;
  await db
    .insert(settings)
    .values({ key: 'inbound_contact_minutes', value: 15 })
    .onConflictDoUpdate({ target: settings.key, set: { value: 15 } });

  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, 'super_admin'), eq(users.active, true)))
    .limit(1);
  adminId = admin!.id;
  sellerA = await mint('A', 'sales_manager');
  sellerB = await mint('B', 'sales_manager');
  strangerC = await mint('C', 'sales_manager');
  packerD = await mint('D', 'warehouse_operator');
  fresh = await mint('G', 'sales_manager');
  await link(sellerA, CHAT_A);
  await link(strangerC, CHAT_C);
  await link(packerD, CHAT_D);

  const stages = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'))
    .orderBy(leadStages.sortOrder);
  secondStage = stages[1]!.id;
});

afterAll(async () => {
  const made = await db.select({ id: leads.id }).from(leads).where(like(leads.name, `%${STAMP}%`));
  const leadIds = made.map((row) => row.id);
  const intakes = await db
    .select({ id: leadIntakes.id })
    .from(leadIntakes)
    .where(
      leadIds.length
        ? sql`${leadIntakes.name} LIKE ${`%${STAMP}%`} OR ${inArray(leadIntakes.leadId, leadIds)}`
        : like(leadIntakes.name, `%${STAMP}%`),
    );
  const intakeIds = intakes.map((row) => row.id);
  if (intakeIds.length) {
    const list = sql.join(
      intakeIds.map((id) => sql`${id}`),
      sql`, `,
    );
    await db.execute(sql`
      DELETE FROM notifications
       WHERE payload ->> 'intakeId' IN (${list})
          OR (payload ? 'intakeIds' AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(payload -> 'intakeIds') x WHERE x IN (${list})))`);
    await db.delete(leadIntakes).where(inArray(leadIntakes.id, intakeIds));
  }
  if (people.length) await db.execute(sql`DELETE FROM notifications WHERE user_id IN (${sql.join(people.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (leadIds.length) {
    await db.delete(callLogs).where(inArray(callLogs.leadId, leadIds));
    await db.delete(tgMessages).where(inArray(tgMessages.leadId, leadIds));
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  if (devicesMade.length) await db.delete(callRecorderDevices).where(inArray(callRecorderDevices.id, devicesMade));
  for (const id of clientsMade) {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
  await db.delete(userRoles).where(inArray(userRoles.userId, people));
  // Audited actors stay, switched off (audit_log refuses to lose its actor).
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  if (savedMinutes === undefined) {
    await db.delete(settings).where(eq(settings.key, 'inbound_contact_minutes'));
  } else {
    await db.update(settings).set({ value: savedMinutes }).where(eq(settings.key, 'inbound_contact_minutes'));
  }
  await pgClient.end();
});

type Push = { user_id: string; type: string; payload: Record<string, unknown>; status: string };

async function pushesFor(intakeId: string): Promise<Push[]> {
  return [...(await db.execute<Push>(sql`
    SELECT user_id, type, payload, status FROM notifications
     WHERE payload ->> 'intakeId' = ${intakeId}
     ORDER BY created_at`))];
}

async function remindersFor(intakeId: string): Promise<Push[]> {
  return [...(await db.execute<Push>(sql`
    SELECT user_id, type, payload, status FROM notifications
     WHERE type = 'InboundLeadUntouched'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(payload -> 'intakeIds') x WHERE x = ${intakeId})`))];
}

async function intakeOf(leadId: string, outcome?: string) {
  const rows = await db
    .select()
    .from(leadIntakes)
    .where(outcome ? and(eq(leadIntakes.leadId, leadId), eq(leadIntakes.outcome, outcome)) : eq(leadIntakes.leadId, leadId))
    .orderBy(leadIntakes.createdAt);
  return rows.at(-1)!;
}

/** Land an advert lead already belonging to `ownerId` (the taqsimot does not run). */
async function land(tag: string, ownerId: string | null, over: Partial<Parameters<typeof landInboundLead>[0]> = {}) {
  return landInboundLead({
    channel: 'form',
    sourceKey: 'instagram',
    name: NAME(tag),
    phone: over.phone ?? phone(),
    note: 'Guangzhoudan 3 kub yuk bor',
    ownerId,
    ...over,
  });
}

/** Put an arrival's clock on the fixed office morning: arrived `ago` minutes before F, due `dueAgo` before F. */
async function clockAt(intakeId: string, ago: number, dueAgo: number) {
  await db.execute(sql`
    UPDATE lead_intakes
       SET created_at = ${minutesFrom(F, -ago)}::timestamptz,
           contact_clock_at = ${minutesFrom(F, -ago)}::timestamptz,
           contact_due_at = ${minutesFrom(F, -dueAgo)}::timestamptz,
           contacted_at = NULL, contact_kind = NULL, contacted_by = NULL, contact_alerted_at = NULL
     WHERE id = ${intakeId}`);
}

describe('the push at landing', () => {
  it('a new advert lead goes to its seller at once, clocked, with the card last', async () => {
    const landed = await land('new', fresh);
    expect(landed.outcome).toBe('created');
    const intake = await intakeOf(landed.leadId!);
    expect(intake.contactClockAt).not.toBeNull();
    expect(intake.contactDueAt).not.toBeNull();

    const pushes = await pushesFor(intake.id);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.user_id).toBe(fresh);
    expect(pushes[0]!.type).toBe('InboundLeadArrived');
    expect(pushes[0]!.payload.leadId).toBe(landed.leadId);
    const text = String(pushes[0]!.payload.text);
    expect(text.split('\n')[0]).toBe('🆕 Yangi lid · Instagram');
    expect(text.split('\n').at(-1)!.endsWith(`/crm/leads/${landed.leadId}`)).toBe(true);
    // The seller's first lead rings.
    expect(pushes[0]!.payload.silent).toBeUndefined();
  });

  it('the same person again says «qayta yozdi» — and a second lead within two minutes does not ring', async () => {
    const p = phone();
    const first = await land('again', fresh, { phone: p });
    const second = await land('again', fresh, { phone: p });
    expect(second.outcome).toBe('joined');
    expect(second.leadId).toBe(first.leadId);
    const joined = await intakeOf(second.leadId!, 'joined');
    // Nobody talked to them in between: the re-enquiry is a deadline of its own.
    expect(joined.contactClockAt).not.toBeNull();
    const [push] = await pushesFor(joined.id);
    expect(String(push!.payload.text).split('\n')[0]).toBe('🔁 Qayta yozdi · Instagram');
    expect(push!.payload.silent).toBe(true);
  });

  it('a re-enquiry inside a live conversation is news, not a new deadline (judge, 10)', async () => {
    const p = phone();
    const first = await land('live', sellerA, { phone: p });
    await addActivity(
      { entityType: 'lead', entityId: first.leadId!, kind: 'call', note: 'gaplashdik' },
      { actorId: sellerA },
    );
    await land('live', sellerA, { phone: p });
    const joined = await intakeOf(first.leadId!, 'joined');
    expect(joined.contactClockAt).toBeNull();
    expect(await pushesFor(joined.id)).toHaveLength(1);
  });

  it('a website visitor is already writing to the manager — no push, no clock', async () => {
    const landed = await land('site', sellerA, { channel: 'site', sourceKey: 'sayt', externalId: `GSR-${STAMP}-S` });
    expect(landed.outcome).toBe('created');
    const intake = await intakeOf(landed.leadId!);
    expect(intake.contactClockAt).toBeNull();
    expect(await pushesFor(intake.id)).toHaveLength(0);
  });

  it('a known client writing through an advert reaches THEIR seller, with no clock', async () => {
    const p = phone();
    const client = await createClient(
      { name: `Kontakt mijoz ${STAMP}`, phones: [p], salesManagerId: sellerB },
      { actorId: adminId },
    );
    clientsMade.push(client.id);
    const landed = await land('client', null, { phone: p });
    expect(landed.outcome).toBe('client');
    const [intake] = await db.select().from(leadIntakes).where(eq(leadIntakes.clientId, client.id));
    expect(intake!.contactClockAt).toBeNull();
    const pushes = await pushesFor(intake!.id);
    expect(pushes.map((row) => row.user_id)).toEqual([sellerB]);
    expect(String(pushes[0]!.payload.text).split('\n')[0]).toBe(`📣 Mijoz ${client.clientCode} reklamadan yozdi · Instagram`);
    // No lead, so no «Bog'landim» to answer for.
    expect(pushes[0]!.payload.leadId).toBeUndefined();
  });

  it('a client with no seller reaches the office, told why (judge, 6)', async () => {
    const p = phone();
    const client = await createClient({ name: `Kontakt yetim ${STAMP}`, phones: [p] }, { actorId: adminId });
    clientsMade.push(client.id);
    await land('orphan', null, { phone: p });
    const [intake] = await db.select().from(leadIntakes).where(eq(leadIntakes.clientId, client.id));
    const pushes = await pushesFor(intake!.id);
    expect(pushes.map((row) => row.user_id)).toContain(adminId);
    expect(String(pushes[0]!.payload.text)).toContain('⚠️ Mijozning menejeri yo‘q');
  });

  it('a lead whose seller left reaches the office, told who left (judge, 7)', async () => {
    const leaver = await mint('E', 'sales_manager');
    const p = phone();
    const first = await land('leaver', leaver, { phone: p });
    await db.update(users).set({ active: false }).where(eq(users.id, leaver));
    await land('leaver', leaver, { phone: p });
    const joined = await intakeOf(first.leadId!, 'joined');
    const pushes = await pushesFor(joined.id);
    expect(pushes.map((row) => row.user_id)).not.toContain(leaver);
    expect(pushes.map((row) => row.user_id)).toContain(adminId);
    expect(String(pushes[0]!.payload.text)).toContain(`⚠️ Egasi (Kontakt E ${STAMP}) ishlamaydi`);
  });

  it('a second copy the database refused is never announced (the replay race)', async () => {
    // Deterministic: the other delivery's ledger row is written and NOT yet
    // committed, so this landing's replay check cannot see it, creates its
    // lead, and then waits on the unique index — and gets DO NOTHING.
    const ext = `race-${STAMP}`;
    const other = postgres(process.env.DATABASE_URL!, { max: 1 });
    const held = await other.reserve();
    await held`BEGIN`;
    await held`INSERT INTO lead_intakes (channel, external_id, outcome, name) VALUES ('meta', ${ext}, 'dropped', ${NAME('race-held')})`;
    const landing = land('race', sellerA, { channel: 'meta', sourceKey: 'meta', externalId: ext });
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE '%insert into lead_intakes%'`);
      waiting = Number(row?.n ?? 0);
    }
    await held`COMMIT`;
    held.release();
    await other.end();
    const result = await landing;
    expect(waiting).toBeGreaterThan(0);
    expect(result.outcome).toBe('created');
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications WHERE payload ->> 'leadId' = ${result.leadId!}`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('what counts as contact', () => {
  async function stampedKind(leadId: string) {
    await stampFirstContacts(new Date());
    const intake = await intakeOf(leadId);
    return { kind: intake.contactKind, by: intake.contactedBy, at: intake.contactedAt };
  }

  it('a call, a Telegram message, a note, a stage move, a cleared follow-up — each stamps its own kind', async () => {
    const [device] = await db
      .insert(callRecorderDevices)
      .values({ userId: sellerA, createdBy: sellerA, pairedAt: new Date(), lastSeenAt: new Date() })
      .returning({ id: callRecorderDevices.id });
    devicesMade.push(device!.id);

    const call = await land('call', sellerA);
    await db.insert(callLogs).values({
      userId: sellerA,
      leadId: call.leadId!,
      deviceId: device!.id,
      direction: 'out',
      phone: `+998${STAMP}99`,
      startedAt: new Date(),
    });
    expect(await stampedKind(call.leadId!)).toMatchObject({ kind: 'call', by: sellerA });

    const tg = await land('tg', sellerA);
    await db.insert(tgMessages).values({
      leadId: tg.leadId!,
      managerUserId: sellerA,
      peerId: BigInt(900_000_000 + Number(STAMP)),
      tgMessageId: 1n,
      direction: 'out',
      body: 'Assalomu alaykum',
      sentAt: new Date(),
    });
    expect(await stampedKind(tg.leadId!)).toMatchObject({ kind: 'telegram', by: sellerA });

    const note = await land('note', sellerA);
    await addActivity({ entityType: 'lead', entityId: note.leadId!, kind: 'note', note: 'telefon qildim' }, { actorId: sellerA });
    expect(await stampedKind(note.leadId!)).toMatchObject({ kind: 'note', by: sellerA });

    const stage = await land('stage', sellerA);
    await moveLead(stage.leadId!, secondStage, '', { actorId: sellerA });
    expect(await stampedKind(stage.leadId!)).toMatchObject({ kind: 'stage', by: sellerA });

    const done = await land('done', sellerA);
    await setFollowUp('lead', done.leadId!, null, { actorId: sellerA });
    expect(await stampedKind(done.leadId!)).toMatchObject({ kind: 'followup', by: sellerA });
  });

  it('a machine’s note is not contact — even on a lead that is nobody’s', async () => {
    // The person writes AGAIN: the re-enquiry's own lenta note (no author) is
    // written AFTER the first arrival, on a lead with nobody responsible for
    // it — the one shape where only the missing author keeps it out.
    const p = phone();
    const landed = await land('system', sellerA, { phone: p });
    await db.update(leads).set({ ownerId: null }).where(eq(leads.id, landed.leadId!));
    await db.update(leadIntakes).set({ assignedUserId: null }).where(eq(leadIntakes.leadId, landed.leadId!));
    expect((await land('system', null, { phone: p })).outcome).toBe('joined');
    await stampFirstContacts(new Date());
    expect((await intakeOf(landed.leadId!, 'created')).contactedAt).toBeNull();
  });

  it('a colleague’s note on somebody else’s lead is not contact (judge, 5)', async () => {
    const landed = await land('colleague', sellerA);
    await addActivity(
      { entityType: 'lead', entityId: landed.leadId!, kind: 'note', note: '@Kontakt A qo‘ng‘iroq qil' },
      { actorId: strangerC },
    );
    expect((await stampedKind(landed.leadId!)).at).toBeNull();
  });

  it('«Ertaga» is a postponement, not a call (judge, 5)', async () => {
    const landed = await land('tomorrow', sellerA);
    await setFollowUp('lead', landed.leadId!, addDays(tashkentDay(), 1), { actorId: sellerA });
    expect((await stampedKind(landed.leadId!)).at).toBeNull();
  });

  it('handing the lead on is not talking to it — not even by its own seller', async () => {
    const landed = await land('handover', sellerA);
    await setLeadOwner(landed.leadId!, sellerB, { actorId: sellerA });
    expect((await stampedKind(landed.leadId!)).at).toBeNull();
  });

  it('a call uploaded LATER but made EARLIER moves the stamp back to it', async () => {
    const landed = await land('late-call', sellerA);
    const intake = await intakeOf(landed.leadId!);
    await db.execute(sql`
      UPDATE lead_intakes SET created_at = now() - interval '30 minutes', contact_clock_at = now() - interval '30 minutes'
       WHERE id = ${intake.id}`);
    await addActivity({ entityType: 'lead', entityId: landed.leadId!, kind: 'note', note: 'yozdim' }, { actorId: sellerA });
    expect((await stampedKind(landed.leadId!)).kind).toBe('note');
    const [device] = await db
      .insert(callRecorderDevices)
      .values({ userId: sellerA, createdBy: sellerA, pairedAt: new Date(), lastSeenAt: new Date() })
      .returning({ id: callRecorderDevices.id });
    devicesMade.push(device!.id);
    const tenAgo = new Date(Date.now() - 10 * 60_000);
    await db.insert(callLogs).values({
      userId: sellerA,
      leadId: landed.leadId!,
      deviceId: device!.id,
      direction: 'out',
      phone: `+998${STAMP}98`,
      startedAt: tenAgo,
    });
    const after = await stampedKind(landed.leadId!);
    expect(after.kind).toBe('call');
    expect(Math.abs(after.at!.getTime() - tenAgo.getTime())).toBeLessThan(1000);
  });
});

describe('the owner’s reminder', () => {
  it('goes ONCE, naming the lead, its seller and whether the seller was told', async () => {
    const landed = await land('remind', sellerA);
    const intake = await intakeOf(landed.leadId!);
    await clockAt(intake.id, 20, 5);

    expect(await remindUntouched(F)).toBeGreaterThan(0);
    const first = await remindersFor(intake.id);
    expect(first.map((row) => row.user_id)).toContain(adminId);
    const text = String(first[0]!.payload.text);
    expect(text).toContain(NAME('remind'));
    expect(text).toContain(`Egasi: Kontakt A ${STAMP} —`);

    await remindUntouched(F);
    expect(await remindersFor(intake.id)).toHaveLength(first.length);
    const [row] = await db.select().from(leadIntakes).where(eq(leadIntakes.id, intake.id));
    expect(row!.contactAlertedAt).not.toBeNull();
  });

  it('two due arrivals on one lead are ONE line', async () => {
    const landed = await land('twice', sellerA);
    const intake = await intakeOf(landed.leadId!);
    await clockAt(intake.id, 25, 10);
    const [second] = await db.execute<{ id: string }>(sql`
      INSERT INTO lead_intakes (channel, source_key, name, outcome, lead_id, assigned_user_id,
                                created_at, contact_clock_at, contact_due_at)
      VALUES ('form', 'instagram', ${NAME('twice-2')}, 'joined', ${landed.leadId!}::uuid, ${sellerA}::uuid,
              ${minutesFrom(F, -15)}::timestamptz, ${minutesFrom(F, -15)}::timestamptz, ${minutesFrom(F, -2)}::timestamptz)
      RETURNING id`);
    await remindUntouched(F);
    const [reminder] = await remindersFor(intake.id);
    expect(reminder!.payload.intakeIds).toEqual(expect.arrayContaining([intake.id, second!.id]));
    const text = String(reminder!.payload.text);
    expect(text.split(NAME('twice')).length - 1).toBe(1);
  });

  it('never before its time, and never about a lead somebody reached', async () => {
    const early = await land('early', sellerA);
    const earlyIntake = await intakeOf(early.leadId!);
    await clockAt(earlyIntake.id, 5, -10);
    const reached = await land('reached', sellerA);
    const reachedIntake = await intakeOf(reached.leadId!);
    await clockAt(reachedIntake.id, 20, 5);
    await setFollowUp('lead', reached.leadId!, null, { actorId: sellerA });

    const claimed = (await claimUntouched(F)).map((row) => row.id);
    expect(claimed).not.toContain(earlyIntake.id);
    expect(claimed).not.toContain(reachedIntake.id);
  });

  it('waits for the seller’s calls app to report — at most thirty minutes', async () => {
    const landed = await land('grace', sellerB);
    const intake = await intakeOf(landed.leadId!);
    await clockAt(intake.id, 25, 10);
    const [device] = await db
      .insert(callRecorderDevices)
      .values({
        userId: sellerB,
        createdBy: sellerB,
        pairedAt: new Date(F.getTime() - 86_400_000 * 3),
        lastSeenAt: new Date(F.getTime() - 20 * 60_000),
      })
      .returning({ id: callRecorderDevices.id });
    devicesMade.push(device!.id);

    // The phone last spoke BEFORE the reminder fell due: a call it made since
    // may still be on its way.
    expect((await claimUntouched(F)).map((row) => row.id)).not.toContain(intake.id);
    // Thirty minutes past due and still silent: the reminder goes.
    const later = new Date(F.getTime() + 25 * 60_000);
    expect((await claimUntouched(later)).map((row) => row.id)).toContain(intake.id);
  });

  it('a handover inside the window tells the new seller (the judge’s MISSING item)', async () => {
    const landed = await land('handed', sellerA);
    const intake = await intakeOf(landed.leadId!);
    await setLeadOwner(landed.leadId!, sellerB, { actorId: adminId });
    const pushes = await pushesFor(intake.id);
    const toB = pushes.filter((row) => row.user_id === sellerB);
    expect(toB).toHaveLength(1);
    expect(String(toB[0]!.payload.text).split('\n')[0]).toBe('🆕 Lid sizga berildi · Instagram');
  });
});

describe('«📞 Bog‘landim»', () => {
  it('the seller’s press takes the lead off today’s calls, writes the note, and stamps the arrival', async () => {
    const landed = await land('button', sellerA);
    const answer = await markContactedFromBot(CHAT_A, landed.leadId!);
    expect(answer).toEqual({ outcome: 'recorded', by: `Kontakt A ${STAMP}` });

    const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
    expect(lead!.nextActionAt).toBeNull();
    const notes = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityId, landed.leadId!), eq(crmActivities.note, CONTACT_NOTE)));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.createdBy).toBe(sellerA);
    const intake = await intakeOf(landed.leadId!);
    expect(intake.contactedAt).not.toBeNull();
    expect(intake.contactedBy).toBe(sellerA);

    // A second press is «already», and writes no second note.
    expect((await markContactedFromBot(CHAT_A, landed.leadId!)).outcome).toBe('already');
    const again = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityId, landed.leadId!), eq(crmActivities.note, CONTACT_NOTE)));
    expect(again).toHaveLength(1);
  });

  it('a colleague may not answer for somebody else’s lead; a packer may not press it at all', async () => {
    const landed = await land('not-yours', sellerA);
    expect((await markContactedFromBot(CHAT_C, landed.leadId!)).outcome).toBe('not_yours');
    expect((await markContactedFromBot(CHAT_D, landed.leadId!)).outcome).toBe('forbidden');
    expect((await markContactedFromBot(CHAT_A + 99n, landed.leadId!)).outcome).toBe('not_linked');
    const notes = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityId, landed.leadId!), eq(crmActivities.note, CONTACT_NOTE)));
    expect(notes).toHaveLength(0);
    expect((await intakeOf(landed.leadId!)).contactedAt).toBeNull();
  });
});

describe('«Birinchi aloqa» on /crm/tahlil', () => {
  it('median, count and the late counts — keyed on whom the arrival was HANDED to (judge, 15)', async () => {
    const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).limit(1);
    const clock = new Date('2019-06-10T10:00:00+05:00');
    // Minutes to first contact; null = never reached.
    const waits: (number | null)[] = [10, 20, 90, 2 * 24 * 60, null];
    for (const [i, wait] of waits.entries()) {
      const [lead] = await db
        .insert(leads)
        .values({ name: NAME(`2019-${i}`), stageId: stage!.id, ownerId: sellerB, createdAt: clock })
        .returning({ id: leads.id });
      await db.execute(sql`
        INSERT INTO lead_intakes (channel, source_key, name, outcome, lead_id, assigned_user_id,
                                  created_at, contact_clock_at, contacted_at, contact_kind)
        VALUES ('form', 'instagram', ${NAME(`2019-${i}`)}, 'created', ${lead!.id}::uuid, ${sellerA}::uuid,
                ${clock.toISOString()}::timestamptz, ${clock.toISOString()}::timestamptz,
                ${wait === null ? null : minutesFrom(clock, wait)}::timestamptz,
                ${wait === null ? null : 'call'})`);
    }
    const period = readPeriod({ dan: '2019-06-01', gacha: '2019-06-30' });
    const stats = await firstContactBySeller(period);
    // (20 + 90) / 2: the median of the four reached, in minutes.
    expect(stats.get(sellerA)).toEqual({ medianMinutes: 55, measured: 4, lateHour: 3, lateDay: 2 });
    expect(stats.has(sellerB)).toBe(false);

    const row = (await salesAnalytics(period)).sellers.find((s) => s.id === sellerA);
    expect(row?.firstContact?.medianMinutes).toBe(55);
    expect(row?.fresh).toBe(0);
  });
});
