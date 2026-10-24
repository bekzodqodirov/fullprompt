import 'dotenv/config';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  crmActivities,
  leadIntakes,
  leadSources,
  leadStages,
  leads,
  lostReasons,
  roles,
  settings,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  decodeCursor,
  hashTail,
  HASH_RULE,
  outcomesPage,
  reasonTextSql,
  saltIdFor,
  suppressionPage,
  type OutcomeRow,
  type SuppressionEntry,
} from '@/modules/wms/crm/agent-feed';
import { normaliseReason } from '@/modules/platform/settings/reason-list';
import {
  landInboundLead,
  setSourceWebhookSecret,
  sourceWebhookSecret,
} from '@/modules/wms/crm/inbound';
import { claimUntouched, stampFirstContacts } from '@/modules/wms/crm/first-contact';
import { CONTACT_NOTE } from '@/modules/wms/crm/inbound-notify';
import { addActivity, moveLead } from '@/modules/wms/crm/service';
import { GET as suppressionGET } from '@/app/api/agent/suppression/route';
import { GET as outcomesGET } from '@/app/api/agent/outcomes/route';

/**
 * The client-finding agent's half of the ERP (docs/AGENT-FEED.md), against a
 * real database: the suppression feed and its pages, the landing belt, the
 * unreminded-but-measured clock, the outcomes feed and both routes' doors.
 *
 * Every fixture is this run's own: phones whose last NINE digits are
 * `STAMP`+`seq`, names prefixed `AG-<STAMP>`, clients inserted directly
 * (never audited, so they can be deleted). Fixture lost reasons live in
 * `leads.lost_reason` TEXT only — NO `lost_reasons` dictionary row is made,
 * because a non-empty dictionary turns `reasonAllowed` to list-only for every
 * later file (#183). The two settings this file changes are snapshotted once
 * in `beforeAll` and put back (#716), and the agent door's key is cleared at
 * the end — a key left behind opens a public read path (#183).
 */

const STAMP = String(Date.now()).slice(-7);
const PREFIX = `AG-${STAMP}`;
let seq = 0;
/** A phone whose last nine digits are this run's and this call's alone. */
const phone = () => `+998${STAMP}${String((seq += 1)).padStart(2, '0')}`;
const tailOf = (p: string) => p.replace(/[^0-9]/g, '').slice(-9);
const NAME = (tag: string) => `${PREFIX} ${tag}`;
const ext = (tag: string) => `cs:${'00000000-0000-4000-8000-' + STAMP.padStart(12, '0')}:${tag}`;
const ctx = { actorId: null, ip: null, userAgent: null };

/** A Tuesday morning in the office — the reminder's clock, never «now» (#1063). */
const F = new Date('2026-09-08T10:00:00+05:00');
const minutesFrom = (at: Date, m: number) => new Date(at.getTime() + m * 60_000).toISOString();

const P1 = phone(); // an active client
const P1b = phone(); // the same client's second phone
const P2 = phone(); // a lead lost «qayta QILINMASIN»
const P3 = phone(); // an open lead
const P4 = phone(); // a lead lost «Narx» (not listed)
const P6 = phone(); // an INACTIVE client
const P7 = phone(); // a lead lost «  Test   sabab » (listed, untidy spacing)
const PN = phone(); // a lead lost «Qayta qilinmasin» typed with a NO-BREAK space
const PW = phone(); // a lead WON onto an existing client's code (the attach copies no phone)
const PW2 = phone(); // a lead on a won stage with no client at all (before round 107)

/**
 * Card phones of SEVEN and EIGHT digits (a truncated import, a number typed
 * without its code) — the app's phone rule (`phonesMatch`) matches them by
 * suffix, so the landing's client check does too. Digits 91-99 and 71-79
 * after the stamp: `phone()` stays far below.
 */
const CARD7 = `${STAMP.slice(2)}91`;
const CARD8 = `${STAMP.slice(1)}92`;
const CARD7_OLD = `${STAMP.slice(2)}93`;
const ARRIVAL7 = `+998 90 ${CARD7}`;
const ARRIVAL8 = `+998 9${CARD8}`;
const ARRIVAL7_OLD = `+998 90 ${CARD7_OLD}`;
/** Several numbers in ONE phones value, the three ways they reach a card. */
const M = (n: number) => `${STAMP}${70 + n}`;
const MULTI_TYPED = `+998 ${M(1)} / +998 ${M(2)}`;
const MULTI_SPACED = `+998${M(7)} +998${M(8)}`;
const MULTI_IMPORTED_998 = `+998${M(3)}998${M(4)}`;
const MULTI_IMPORTED_9 = `+${M(5)}${M(6)}`;

let secret = '';
let adminId = '';
let lostStage = '';
let openStage = '';
let wonStage = '';
let fixturesFrom = '';
const clientsMade: string[] = [];
const leadsMade: string[] = [];
let saved: Record<string, unknown> = {};

async function snapshotSetting(key: string, value: unknown) {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  saved[key] = row ? row.value : undefined;
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}
async function setReasons(value: string) {
  await db.update(settings).set({ value }).where(eq(settings.key, 'agent_no_contact_reasons'));
}

async function insertLead(tag: string, p: string, stageId: string, lostReason: string | null) {
  const [row] = await db
    .insert(leads)
    .values({
      name: NAME(tag),
      phone: p,
      stageId,
      lostReason,
      closedAt: lostReason ? new Date() : null,
    })
    .returning({ id: leads.id });
  leadsMade.push(row!.id);
  return row!.id;
}

/** Every entry the full feed holds, one page. */
async function fullSet(): Promise<SuppressionEntry[]> {
  return (await suppressionPage({ secret, since: null, cursor: null, limit: 5000 })).entries;
}

async function walkSuppression(since: string | null, limit: number): Promise<SuppressionEntry[]> {
  const out: SuppressionEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5000; page += 1) {
    const { decodeCursor } = await import('@/modules/wms/crm/agent-feed');
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded === 'invalid') throw new Error('the feed handed back a cursor it cannot read');
    const res = await suppressionPage({ secret, since, cursor: decoded, limit });
    out.push(...res.entries);
    if (!res.next) return out;
    cursor = res.next;
  }
  throw new Error('the walk never ended');
}

const keyOf = (e: SuppressionEntry) => `${e.kind}|${e.h}`;

async function agentOutcome(externalId: string): Promise<OutcomeRow | undefined> {
  const { rows } = await outcomesPage({ since: fixturesFrom, cursor: null, limit: 5000 });
  return rows.find((row) => row.external_id === externalId);
}

async function intakeByExt(externalId: string) {
  const [row] = await db.select().from(leadIntakes).where(eq(leadIntakes.externalId, externalId));
  return row!;
}

beforeAll(async () => {
  const [agent] = await db.select().from(leadSources).where(eq(leadSources.key, 'agent')).limit(1);
  expect(agent, 'the seed ships the agent source').toBeTruthy();

  saved = {};
  await snapshotSetting('agent_no_contact_reasons', 'Qayta qilinmasin;Test sabab');
  await snapshotSetting('inbound_contact_minutes', 15);
  secret = (await setSourceWebhookSecret('agent', true, ctx))!;

  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, 'super_admin'), eq(users.active, true)))
    .limit(1);
  adminId = admin!.id;
  const [lost] = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'lost'))
    .limit(1);
  const [open] = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'))
    .orderBy(leadStages.sortOrder)
    .limit(1);
  lostStage = lost!.id;
  openStage = open!.id;

  // A moment strictly before every fixture row, as postgres sees time.
  const [now] = await db.execute<{ at: string }>(
    sql`SELECT to_char((now() - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
  );
  fixturesFrom = now!.at;

  const code = `AGT${STAMP}`;
  // Each card's instant runs AGAINST its insertion order (the first row
  // written is the newest), so the table's own storage order is not the
  // feed's order — a page read without its ORDER BY is visibly wrong here
  // instead of right by luck.
  const base = Date.parse(fixturesFrom) + 1000;
  const at = (ms: number) => ({ createdAt: new Date(base - ms), updatedAt: new Date(base - ms) });
  const made = await db
    .insert(clients)
    .values([
      { clientCode: `${code}A`, name: NAME('mijoz'), phones: [P1, P1b], ...at(100) },
      { clientCode: `${code}B`, name: NAME('eski mijoz'), phones: [P6], active: false, ...at(200) },
      // Twenty phones on one card: one client is twenty rows that share an
      // instant and an id — the page edge's hardest case, and enough bytes
      // for the route to gzip.
      {
        clientCode: `${code}C`,
        name: NAME('ko‘p raqam'),
        // seq 50-69: `phone()` stays far below, so no tail is shared.
        phones: Array.from({ length: 20 }, (_, i) => `+998${STAMP}${50 + i}`),
        ...at(300),
      },
    ])
    .returning({ id: clients.id });
  clientsMade.push(...made.map((row) => row.id));

  await insertLead('lost-listed', P2, lostStage, 'qayta QILINMASIN');
  await insertLead('open', P3, openStage, null);
  await insertLead('lost-price', P4, lostStage, 'Narx');
  await insertLead('lost-untidy', P7, lostStage, '  Test   sabab ');
  await insertLead('lost-nbsp', PN, lostStage, 'Qayta\u00a0qilinmasin');

  const short = await db
    .insert(clients)
    .values([
      { clientCode: `${code}D`, name: NAME('7 raqam'), phones: [CARD7] },
      { clientCode: `${code}E`, name: NAME('8 raqam'), phones: [CARD8] },
      { clientCode: `${code}F`, name: NAME('eski 7 raqam'), phones: [CARD7_OLD], active: false },
      {
        clientCode: `${code}G`,
        name: NAME('bir qatorda ikki raqam'),
        phones: [MULTI_TYPED, MULTI_SPACED, MULTI_IMPORTED_998, MULTI_IMPORTED_9],
      },
    ])
    .returning({ id: clients.id });
  clientsMade.push(...short.map((row) => row.id));

  const [won] = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'won'))
    .limit(1);
  wonStage = won!.id;
  const attached = await insertLead('won-attached', PW, wonStage, null);
  await db.update(leads).set({ clientId: clientsMade[0]! }).where(eq(leads.id, attached));
  await insertLead('won-no-client', PW2, wonStage, null);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) await db.delete(settings).where(eq(settings.key, key));
    else await db.update(settings).set({ value }).where(eq(settings.key, key));
  }
  await setSourceWebhookSecret('agent', false, ctx);

  const landed = await db
    .select({ id: leads.id })
    .from(leads)
    .where(like(leads.name, `${PREFIX}%`));
  const leadIds = [...new Set([...leadsMade, ...landed.map((row) => row.id)])];
  await db.execute(sql`
    DELETE FROM notifications
     WHERE payload ->> 'intakeId' IN (SELECT id::text FROM lead_intakes WHERE name LIKE ${`${PREFIX}%`})`);
  await db.delete(leadIntakes).where(like(leadIntakes.name, `${PREFIX}%`));
  if (leadIds.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  }
  if (clientsMade.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, clientsMade));
    await db.delete(clients).where(inArray(clients.id, clientsMade));
  }
  await pgClient.end();
});

describe('the suppression feed', () => {
  it('a full pull carries the client book (active AND inactive) and the leads lost with a listed reason', async () => {
    const entries = await fullSet();
    const kinds = new Map(entries.map((e) => [e.h, e.kind]));
    expect(kinds.get(hashTail(secret, tailOf(P1)))).toBe('client');
    expect(kinds.get(hashTail(secret, tailOf(P1b)))).toBe('client');
    expect(kinds.get(hashTail(secret, tailOf(P6))), 'a former client is still ours').toBe('client');
    expect(kinds.get(hashTail(secret, tailOf(P2))), 'matched case-insensitively').toBe('lost');
    expect(kinds.get(hashTail(secret, tailOf(P7))), 'spacing normalised on both sides').toBe(
      'lost',
    );
    expect(kinds.has(hashTail(secret, tailOf(P3))), 'an open lead is not suppressed').toBe(false);
    expect(kinds.has(hashTail(secret, tailOf(P4))), 'an unlisted reason is not').toBe(false);
    // Hashes, never digits.
    expect(JSON.stringify(entries)).not.toContain(tailOf(P1));
    for (const e of entries) expect(e.h).toMatch(/^[0-9a-f]{20}$/);
  });

  it('pages one row at a time through the whole set: nothing skipped, nothing twice, and it ends', async () => {
    // Since the fixtures: the twenty-phone card's rows all share one instant
    // and one id, so only the phone's position keeps the page edge honest.
    const mine = await suppressionPage({ secret, since: fixturesFrom, cursor: null, limit: 5000 });
    const walked = await walkSuppression(fixturesFrom, 1);
    expect(walked.length).toBe(mine.entries.length);
    expect(new Set(walked.map(keyOf)).size).toBe(walked.length);
    expect(walked.map(keyOf).sort()).toEqual(mine.entries.map(keyOf).sort());
    // 2 + 1 + 20 client phones, 2 listed lost leads — at the least.
    expect(walked.length).toBeGreaterThanOrEqual(25);
  });

  it('the full walk in pages equals the one big page', async () => {
    const walked = await walkSuppression(null, 7);
    const big = await fullSet();
    expect(walked.map(keyOf).sort()).toEqual(big.map(keyOf).sort());
  });

  it('a delta carries only what moved after `since`', async () => {
    const future = (
      await suppressionPage({
        secret,
        since: new Date(Date.now() + 60_000).toISOString(),
        cursor: null,
        limit: 5000,
      })
    ).entries;
    expect(future).toEqual([]);
    const delta = (
      await suppressionPage({ secret, since: fixturesFrom, cursor: null, limit: 5000 })
    ).entries.map((e) => e.h);
    for (const p of [P1, P1b, P2, P6, P7]) expect(delta).toContain(hashTail(secret, tailOf(p)));
  });

  it('a lead that became a client is the client book too — and one lost with a no-break space is listed', async () => {
    const kinds = new Map((await fullSet()).map((e) => [e.h, e.kind]));
    expect(kinds.get(hashTail(secret, tailOf(PW))), 'won onto an existing code').toBe('client');
    expect(kinds.get(hashTail(secret, tailOf(PW2))), 'won with no client').toBe('client');
    expect(kinds.get(hashTail(secret, tailOf(PN))), 'U+00A0 is whitespace to both sides').toBe(
      'lost',
    );
  });

  it('every number in one phones value: typed with «/», with «+», imported as one run of digits', async () => {
    const hashes = new Set((await fullSet()).map((e) => e.h));
    for (let n = 1; n <= 8; n += 1) {
      expect(hashes.has(hashTail(secret, M(n))), `number ${n}`).toBe(true);
    }
  });

  it('the column normalises a reason exactly as the setting is normalised', async () => {
    for (const text of [
      '  Qayta\u00a0 qilinmasin\n',
      '\tTest\u2009\u3000sabab\ufeff',
      'A\u2028B\u202fC',
      'Повторно  НЕ   звонить',
      'plain',
      '',
    ]) {
      const [row] = await db.execute<{ v: string }>(
        sql`SELECT ${reasonTextSql(sql`${text}::text`)} AS v`,
      );
      expect(row!.v, JSON.stringify(text)).toBe(normaliseReason(text));
    }
  });

  it('follows the setting: a reason taken off the list stops suppressing', async () => {
    await setReasons('boshqa');
    const without = (await fullSet()).map((e) => e.h);
    await setReasons('Qayta qilinmasin;Test sabab');
    const back = (await fullSet()).map((e) => e.h);
    expect(without).not.toContain(hashTail(secret, tailOf(P2)));
    expect(back).toContain(hashTail(secret, tailOf(P2)));
  });
});

describe('the landing belt', () => {
  it('an agent push on a client’s phone is dropped as `suppressed` — no lead, no note, nobody told', async () => {
    const id = ext('belt-client');
    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: id,
      name: NAME('belt client'),
      phone: P1,
      note: 'NEGA TOPILDI: OLX',
    });
    expect(result).toEqual({ outcome: 'dropped', reason: 'suppressed' });
    const intake = await intakeByExt(id);
    expect(intake.outcome).toBe('dropped');
    expect(intake.reason).toBe('suppressed');
    expect(intake.sourceKey).toBe('agent');
    const onClient = await db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.entityId, clientsMade[0]!));
    expect(onClient, 'the client’s manager must not hear about it').toEqual([]);
    const made = await db
      .select()
      .from(leads)
      .where(eq(leads.name, NAME('belt client')));
    expect(made).toEqual([]);
    const pushes = await db.execute(
      sql`SELECT 1 FROM notifications WHERE payload ->> 'intakeId' = ${intake.id}`,
    );
    expect(pushes.length).toBe(0);
  });

  it('…and on a «Qayta qilinmasin» lead’s phone, and on a former client’s', async () => {
    for (const [tag, p] of [
      ['belt-lost', P2],
      ['belt-inactive', P6],
    ] as const) {
      const result = await landInboundLead({
        channel: 'webhook',
        sourceKey: 'agent',
        externalId: ext(tag),
        name: NAME(tag),
        phone: p,
      });
      expect(result, tag).toEqual({ outcome: 'dropped', reason: 'suppressed' });
    }
  });

  it('by the app’s own phone rule: a card of seven or eight digits is a client too — active or not', async () => {
    for (const [tag, p, card] of [
      ['belt-7', ARRIVAL7, 3],
      ['belt-8', ARRIVAL8, 4],
      ['belt-7-old', ARRIVAL7_OLD, 5],
      ['belt-multi', `+998${M(1)}`, 6],
      ['belt-imported', `+998 ${M(3)}`, 6],
      ['belt-won', PW, -1],
    ] as const) {
      const id = ext(tag);
      const result = await landInboundLead({
        channel: 'webhook',
        sourceKey: 'agent',
        externalId: id,
        name: NAME(tag),
        phone: p,
        note: 'NEGA TOPILDI: OLX',
      });
      expect(result, tag).toEqual({ outcome: 'dropped', reason: 'suppressed' });
      const intake = await intakeByExt(id);
      const pushes = await db.execute(
        sql`SELECT 1 FROM notifications WHERE payload ->> 'intakeId' = ${intake.id}`,
      );
      expect(pushes.length, `${tag}: nobody told`).toBe(0);
      if (card >= 0) {
        const onClient = await db
          .select()
          .from(crmActivities)
          .where(eq(crmActivities.entityId, clientsMade[card]!));
        expect(onClient, `${tag}: nothing on the card`).toEqual([]);
      }
    }
    // The feed cannot carry a seven- or eight-digit card (its rule is nine
    // digits, and the agent hashes nine): for those the belt is the guard.
    const hashes = new Set((await fullSet()).map((e) => e.h));
    expect(hashes.has(hashTail(secret, tailOf(ARRIVAL7)))).toBe(false);
  });

  it('a push it cannot check — no phone of nine digits — reaches nobody', async () => {
    for (const [tag, p] of [
      ['no-phone', null],
      ['short-phone', '123 45 67'],
    ] as const) {
      const result = await landInboundLead({
        channel: 'webhook',
        sourceKey: 'agent',
        externalId: ext(tag),
        name: NAME(tag),
        phone: p,
      });
      expect(result, tag).toEqual({ outcome: 'dropped', reason: 'no_phone' });
    }
    const made = await db
      .select()
      .from(leads)
      .where(inArray(leads.name, [NAME('no-phone'), NAME('short-phone')]));
    expect(made).toEqual([]);
  });

  it('the agent’s pushes do not spend a person’s daily cap on a phone, nor theirs the agent’s', async () => {
    // A client's number the agent hit three times today (three firms sharing
    // one phone): the person's own enquiry still lands on their card.
    const PC = phone();
    const [cl] = await db
      .insert(clients)
      .values({ clientCode: `AGT${STAMP}H`, name: NAME('cap mijoz'), phones: [PC] })
      .returning({ id: clients.id });
    clientsMade.push(cl!.id);
    for (let n = 0; n < 3; n += 1) {
      const pushed = await landInboundLead({
        channel: 'webhook',
        sourceKey: 'agent',
        externalId: ext(`cap-${n}`),
        name: NAME(`cap agent ${n}`),
        phone: PC,
      });
      expect(pushed).toEqual({ outcome: 'dropped', reason: 'suppressed' });
    }
    const person = await landInboundLead({
      channel: 'form',
      sourceKey: 'tiktok',
      name: NAME('cap person'),
      phone: PC,
      note: 'yukim bor',
    });
    expect(person.outcome).toBe('client');

    // …and the other way: three advert arrivals on a number leave the
    // agent's own push free to land.
    const PD = phone();
    for (let n = 0; n < 3; n += 1) {
      await landInboundLead({
        channel: 'webhook',
        sourceKey: 'tiktok',
        externalId: `wh-${PREFIX}-cap-${n}`,
        name: NAME(`cap tiktok ${n}`),
        phone: PD,
      });
    }
    const agent = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('cap-after-adverts'),
      name: NAME('cap agent after'),
      phone: PD,
    });
    expect(agent.outcome).toBe('joined');
  });

  it('is the agent’s alone: the same phone through an advert still lands on the client’s card', async () => {
    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-control`,
      name: NAME('tiktok control'),
      phone: P1,
    });
    expect(result.outcome).toBe('client');
    expect(result.clientId).toBe(clientsMade[0]);
  });

  it('a person through the form who names the agent is a person: «Boshqa», no belt', async () => {
    const result = await landInboundLead({
      channel: 'form',
      sourceKey: 'agent',
      name: NAME('form says agent'),
      phone: P1,
    });
    expect(result.outcome).toBe('client');
    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.name, NAME('form says agent')));
    expect(intake!.sourceKey).toBe('other');
  });
});

describe('the contact clock of an agent lead', () => {
  it('starts, with no due time — and an advert lead’s has one (the control group)', async () => {
    const agent = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('clock'),
      name: NAME('clock agent'),
      phone: phone(),
    });
    expect(agent.outcome).toBe('created');
    const mine = await intakeByExt(ext('clock'));
    expect(mine.contactClockAt).not.toBeNull();
    expect(mine.contactDueAt).toBeNull();

    const advert = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-clock`,
      name: NAME('clock tiktok'),
      phone: phone(),
    });
    expect(advert.outcome).toBe('created');
    const theirs = await intakeByExt(`wh-${PREFIX}-clock`);
    expect(theirs.contactClockAt).not.toBeNull();
    expect(theirs.contactDueAt).not.toBeNull();
  });

  it('is never claimed for the owner’s reminder, while the advert lead beside it is', async () => {
    const agent = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('remind'),
      name: NAME('remind agent'),
      phone: phone(),
    });
    const advert = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-remind`,
      name: NAME('remind tiktok'),
      phone: phone(),
    });
    expect(agent.outcome).toBe('created');
    expect(advert.outcome).toBe('created');
    const a = await intakeByExt(ext('remind'));
    const t = await intakeByExt(`wh-${PREFIX}-remind`);
    // Both put on the same fixed office morning, an hour old, 45 minutes past
    // whatever due time they LANDED with — the advert's 15-minute one, the
    // agent's NULL, which stays NULL. Explicit times, never «now» (#1063).
    await db.execute(sql`
      UPDATE lead_intakes
         SET created_at = ${minutesFrom(F, -60)}::timestamptz,
             contact_clock_at = ${minutesFrom(F, -60)}::timestamptz,
             contact_due_at = CASE WHEN contact_due_at IS NULL THEN NULL
                                   ELSE ${minutesFrom(F, -45)}::timestamptz END
       WHERE id IN (${a.id}::uuid, ${t.id}::uuid)`);
    const claimed = (await claimUntouched(F)).map((row) => row.id);
    expect(claimed, 'the claim works at this moment').toContain(t.id);
    expect(claimed).not.toContain(a.id);
  });

  it('still gets its first contact stamped — the outcomes feed reads that', async () => {
    const landed = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('stamp'),
      name: NAME('stamp agent'),
      phone: phone(),
    });
    expect(landed.outcome).toBe('created');
    // The «📞 Bog'landim» note counts from whoever the button let through.
    await addActivity(
      { entityType: 'lead', entityId: landed.leadId!, kind: 'call', note: CONTACT_NOTE },
      { actorId: adminId },
    );
    await stampFirstContacts(new Date(), landed.leadId!);
    const intake = await intakeByExt(ext('stamp'));
    expect(intake.contactedAt).not.toBeNull();
    expect(intake.contactKind).toBe('note');
  });
});

describe('a contact made after the first week', () => {
  it('is still stamped on an agent arrival — nobody else would ever ask — and on an advert’s it is not', async () => {
    const agent = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('late'),
      name: NAME('late agent'),
      phone: phone(),
    });
    const advert = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-late`,
      name: NAME('late tiktok'),
      phone: phone(),
    });
    expect(agent.outcome).toBe('created');
    expect(advert.outcome).toBe('created');
    const a = await intakeByExt(ext('late'));
    const t = await intakeByExt(`wh-${PREFIX}-late`);
    // Nine days old, as postgres counts time (#1063: never the JS clock).
    await db.execute(sql`
      UPDATE lead_intakes
         SET created_at = now() - interval '9 days',
             contact_clock_at = now() - interval '9 days'
       WHERE id IN (${a.id}::uuid, ${t.id}::uuid)`);
    for (const leadId of [agent.leadId!, advert.leadId!]) {
      await addActivity(
        { entityType: 'lead', entityId: leadId, kind: 'call', note: CONTACT_NOTE },
        { actorId: adminId },
      );
      await stampFirstContacts(new Date(), leadId);
    }
    expect((await intakeByExt(ext('late'))).contactedAt).not.toBeNull();
    expect((await agentOutcome(ext('late')))!.contacted_at).not.toBeNull();
    // Every other door's week is exactly what it was.
    expect((await intakeByExt(`wh-${PREFIX}-late`)).contactedAt).toBeNull();
  });
});

describe('the outcomes feed', () => {
  const FIELDS = [
    'external_id',
    'intake_id',
    'outcome',
    'reason',
    'lead_id',
    'client_id',
    'stage_kind',
    'stage_name',
    'lost_reason',
    'no_contact',
    'closed_at',
    'contacted_at',
    'contact_kind',
    'quoted_volume_m3',
    'at',
  ].sort();

  it('reports every agent arrival with what became of it, in the 15 fields and nothing else', async () => {
    const created = await agentOutcome(ext('clock'));
    expect(created).toMatchObject({
      outcome: 'created',
      stage_kind: 'open',
      contacted_at: null,
      reason: null,
    });
    expect(created!.lead_id).toBeTruthy();
    const contacted = await agentOutcome(ext('stamp'));
    expect(contacted!.contacted_at).not.toBeNull();
    expect(contacted!.contact_kind).toBe('note');
    const dropped = await agentOutcome(ext('belt-client'));
    expect(dropped).toMatchObject({
      outcome: 'dropped',
      reason: 'suppressed',
      lead_id: null,
      stage_kind: null,
    });

    const { rows } = await outcomesPage({ since: fixturesFrom, cursor: null, limit: 5000 });
    for (const row of rows) {
      // Never a name, a phone, a note, an owner or a price.
      expect(Object.keys(row).sort()).toEqual(FIELDS);
    }
    expect(JSON.stringify(rows)).not.toContain(PREFIX);
    // The control-group advert arrivals are not the agent's.
    expect(rows.some((row) => row.external_id.startsWith('wh-'))).toBe(false);
  });

  it('a lead lost «Qayta qilinmasin» reads as lost — and its phone joins the suppression feed', async () => {
    const row = await agentOutcome(ext('clock'));
    await moveLead(row!.lead_id!, lostStage, 'Qayta qilinmasin', { actorId: adminId });
    const after = await agentOutcome(ext('clock'));
    expect(after).toMatchObject({
      stage_kind: 'lost',
      lost_reason: 'Qayta qilinmasin',
      no_contact: true,
    });
    expect(after!.closed_at).not.toBeNull();
    expect(after!.at >= row!.at).toBe(true);

    const [lead] = await db
      .select({ phone: leads.phone })
      .from(leads)
      .where(eq(leads.id, row!.lead_id!));
    const hashes = (await fullSet()).map((e) => e.h);
    expect(hashes).toContain(hashTail(secret, tailOf(lead!.phone!)));
  });

  it('a lost reason leaves only as a LABEL — a seller’s free text with a name and a number does not', async () => {
    const landed = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('scrub'),
      name: NAME('scrub'),
      phone: phone(),
    });
    expect(landed.outcome).toBe('created');
    const typed = 'Akmal aka (direktor) +998 90 111 22 33 ga qo‘ng‘iroq qiling';
    await db
      .update(leads)
      .set({ stageId: lostStage, lostReason: typed, closedAt: new Date() })
      .where(eq(leads.id, landed.leadId!));
    const free = await agentOutcome(ext('scrub'));
    expect(free).toMatchObject({ stage_kind: 'lost', lost_reason: null, no_contact: false });
    expect(JSON.stringify(free)).not.toContain('111 22 33');

    // The owner's dictionary label is his word, not a seller's: it leaves,
    // spelt as the lead stores it — matched however it is spaced.
    const label = `AGL${STAMP} Narx qimmat`;
    const [row] = await db.insert(lostReasons).values({ label }).returning({ id: lostReasons.id });
    try {
      await db
        .update(leads)
        .set({ lostReason: `agl${STAMP}  narx QIMMAT` })
        .where(eq(leads.id, landed.leadId!));
      const listed = await agentOutcome(ext('scrub'));
      expect(listed).toMatchObject({ lost_reason: `agl${STAMP}  narx QIMMAT`, no_contact: false });
    } finally {
      // A dictionary row is CONFIGURATION: while it exists every lost move in
      // the app is list-only (#183).
      await db.delete(lostReasons).where(eq(lostReasons.id, row!.id));
    }
  });

  it('a walk that reached the end is handed where to resume — on the last page too', async () => {
    const all = (await outcomesPage({ since: fixturesFrom, cursor: null, limit: 5000 })).rows;
    const page = await outcomesPage({ since: fixturesFrom, cursor: null, limit: 5000 });
    expect(page.next).toBeNull();
    const resume = decodeCursor(page.resume);
    if (!resume || resume === 'invalid') throw new Error('no resume cursor on the last page');
    const last = all.at(-1)!;
    expect(resume.id).toBe(last.intake_id);
    expect(resume.at.slice(0, 23)).toBe(last.at.slice(0, 23));
    // …and from there, nothing again — and the same place to come back to.
    const after = await outcomesPage({ since: fixturesFrom, cursor: resume, limit: 5000 });
    expect(after.rows).toEqual([]);
    expect(after.resume).toBe(page.resume);
    const sup = await suppressionPage({ secret, since: fixturesFrom, cursor: null, limit: 5000 });
    expect(sup.next).toBeNull();
    expect(decodeCursor(sup.resume)).not.toBeNull();
  });

  it('picks up the fallback months: «Boshqa» pushes tagged clientscrapper, and only those', async () => {
    await landInboundLead({
      channel: 'webhook',
      sourceKey: 'other',
      externalId: ext('fallback'),
      ref: { utm_source: 'clientscrapper' },
      name: NAME('fallback'),
      phone: phone(),
    });
    await landInboundLead({
      channel: 'webhook',
      sourceKey: 'other',
      externalId: ext('stranger'),
      ref: { utm_source: 'x' },
      name: NAME('stranger'),
      phone: phone(),
    });
    expect(await agentOutcome(ext('fallback'))).toBeTruthy();
    expect(await agentOutcome(ext('stranger'))).toBeUndefined();
  });

  it('pages one row at a time without skipping or repeating', async () => {
    const all = (await outcomesPage({ since: fixturesFrom, cursor: null, limit: 5000 })).rows;
    const { decodeCursor } = await import('@/modules/wms/crm/agent-feed');
    const walked: OutcomeRow[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 500; i += 1) {
      const decoded = cursor ? decodeCursor(cursor) : null;
      if (decoded === 'invalid') throw new Error('unreadable cursor');
      const page = await outcomesPage({ since: fixturesFrom, cursor: decoded, limit: 1 });
      walked.push(...page.rows);
      if (!page.next) break;
      cursor = page.next;
    }
    expect(walked.map((row) => row.intake_id)).toEqual(all.map((row) => row.intake_id));
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it('every other door leaves a posted firm where it always was — not on the card’s column', async () => {
    const landed = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-company`,
      name: NAME('company tiktok'),
      phone: phone(),
      note: 'Yiwudan 5 kub\ncompany: Acme LLC',
      company: 'Acme LLC',
    });
    expect(landed.outcome).toBe('created');
    const [lead] = await db
      .select({ company: leads.company })
      .from(leads)
      .where(eq(leads.id, landed.leadId!));
    expect(lead!.company).toBeNull();
  });

  it('writes the firm the agent sent onto the card', async () => {
    const landed = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: ext('company'),
      name: NAME('company'),
      phone: phone(),
      company: 'Namuna Savdo MChJ',
    });
    expect(landed.outcome).toBe('created');
    const [lead] = await db
      .select({ company: leads.company })
      .from(leads)
      .where(eq(leads.id, landed.leadId!));
    expect(lead!.company).toBe('Namuna Savdo MChJ');
  });
});

describe('the two routes', () => {
  const url = (path: string) => `http://localhost:3000/api/agent/${path}`;
  const ask = (path: string, headers: Record<string, string> = {}) =>
    new Request(url(path), { headers: { 'x-gsr-key': secret, ...headers } });

  it('404 without the key, with a wrong key, and with the contract’s other header name alone', async () => {
    for (const GET of [suppressionGET, outcomesGET]) {
      expect((await GET(new Request(url('suppression')))).status).toBe(404);
      expect(
        (await GET(new Request(url('suppression'), { headers: { 'x-gsr-key': 'nope' } }))).status,
      ).toBe(404);
      expect(
        (await GET(new Request(url('suppression'), { headers: { 'x-erp-key': secret } }))).status,
      ).toBe(404);
    }
  });

  it('400 with a code for a cursor or a `since` it cannot read', async () => {
    const badCursor = await suppressionGET(ask('suppression?cursor=bm9wZQ'));
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: 'bad_cursor' });
    for (const since of ['yesterday', '1', '2026-02-30T00:00:00Z']) {
      const badSince = await outcomesGET(ask(`outcomes?since=${encodeURIComponent(since)}`));
      expect(badSince.status, since).toBe(400);
      expect(await badSince.json()).toEqual({ error: 'bad_since' });
    }
  });

  it('200 with the documented body, gzipped when asked and big enough, never cached by a proxy', async () => {
    const res = await suppressionGET(ask('suppression?limit=5000', { 'accept-encoding': 'gzip' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toBeTruthy();
    const body = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
    expect(Object.keys(body).sort()).toEqual([
      'entries',
      'generated_at',
      'mode',
      'next',
      'resume',
      'rule',
      'salt_id',
    ]);
    expect(body).toMatchObject({
      mode: 'full',
      rule: HASH_RULE,
      salt_id: saltIdFor(secret),
      next: null,
    });
    expect(body.entries.map((e: SuppressionEntry) => e.h)).toContain(hashTail(secret, tailOf(P1)));

    const delta = await (
      await suppressionGET(ask(`suppression?since=${encodeURIComponent(fixturesFrom)}&limit=2`))
    ).json();
    expect(delta.mode).toBe('delta');
    expect(delta.entries).toHaveLength(2);
    expect(delta.next).toBeTruthy();
    const second = await (
      await suppressionGET(
        ask(`suppression?since=${encodeURIComponent(fixturesFrom)}&limit=2&cursor=${delta.next}`),
      )
    ).json();
    expect(second.entries).toHaveLength(2);

    const outcomes = await outcomesGET(ask('outcomes'));
    expect(outcomes.status).toBe(200);
    const ob = await outcomes.json();
    expect(Object.keys(ob).sort()).toEqual(['generated_at', 'next', 'resume', 'rows']);
    expect(ob.rows.some((row: OutcomeRow) => row.external_id === ext('clock'))).toBe(true);
  });

  it('a door switched off is 404; re-minting the key rotates the salt', async () => {
    const before = await (await suppressionGET(ask('suppression?limit=1'))).json();
    await setSourceWebhookSecret('agent', false, ctx);
    expect(await sourceWebhookSecret('agent')).toBeNull();
    expect((await suppressionGET(ask('suppression'))).status).toBe(404);
    expect((await outcomesGET(ask('outcomes'))).status).toBe(404);
    secret = (await setSourceWebhookSecret('agent', true, ctx))!;
    const after = await (await suppressionGET(ask('suppression?limit=1'))).json();
    expect(after.salt_id).not.toBe(before.salt_id);
    expect(after.salt_id).toBe(saltIdFor(secret));
  });
});
