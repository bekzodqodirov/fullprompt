import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  crmActivities,
  crmPeople,
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
  isSuppressedTail,
  noContactReasons,
  outcomesPage,
  reasonTextSql,
  saltIdFor,
  suppressionPage,
  type OutcomeRow,
  type SuppressionEntry,
} from '@/modules/wms/crm/agent-feed';
import { normaliseReason } from '@/modules/platform/settings/reason-list';
import {
  INDEX_SAFE_ID_BYTES,
  inboundCount,
  inboundLanded,
  landInboundLead,
  setSourceWebhookSecret,
  sourceWebhookSecret,
} from '@/modules/wms/crm/inbound';
import { claimUntouched, stampFirstContacts } from '@/modules/wms/crm/first-contact';
import { CONTACT_NOTE } from '@/modules/wms/crm/inbound-notify';
import { addActivity, moveLead } from '@/modules/wms/crm/service';
import { attachClient } from '@/modules/wms/crm/people';
import { activeClientsByPhone } from '@/modules/wms/client-cabinet/service';
import { firstContactBySeller } from '@/modules/wms/crm/analytics';
import postgres from 'postgres';
import { GET as suppressionGET } from '@/app/api/agent/suppression/route';
import { GET as outcomesGET } from '@/app/api/agent/outcomes/route';
import { POST as leadsInPOST } from '@/app/api/leads/in/[source]/route';
import { submitArizaAction } from '@/app/(public)/ariza/actions';

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
const PP = phone(); // a number only on the PERSON record of a client (crm/people.ts)
const PP2 = phone(); // a number on a person record that holds no code

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
/**
 * Four phones of their own for the long-id tests, outside `phone()`'s run:
 * that counter reaches 48 by the end of the file (measured), and 50-69 are
 * the twenty-phone card's — four more phone() calls landed on a client.
 */
const LONG_ID_PHONES = ['84', '85', '86', '87'].map((n) => `+998${STAMP}${n}`) as [string, string, string, string];
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
const peopleMade: string[] = [];
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

/**
 * Every entry the full feed holds — a FULL walk, following `next`. One page on
 * a fresh database; a long-lived one (#653) holds more than a page, and the
 * fixtures, being the newest rows, are on the LAST (review, 2026-10-24).
 */
async function fullSet(): Promise<SuppressionEntry[]> {
  return walkSuppression(null, 5000);
}

/**
 * This run's own nine-digit tails, as hashes under the current key — what a
 * paging test compares, so a row another file writes while it walks cannot
 * make two reads of a shared table disagree.
 */
const ourHashes = () =>
  new Set(
    [
      P1, P1b, P2, P6, P7, PN, PW, PW2, PP,
      ...Array.from({ length: 20 }, (_, i) => `+998${STAMP}${50 + i}`),
      ...Array.from({ length: 8 }, (_, i) => M(i + 1)),
    ].map((p) => hashTail(secret, tailOf(p))),
  );
const ours = (entries: SuppressionEntry[]) => {
  const mine = ourHashes();
  return entries.filter((e) => mine.has(e.h));
};

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

  const people = await db
    .insert(crmPeople)
    .values([
      { name: NAME('odam'), phones: [P1, PP], createdBy: adminId },
      { name: NAME('kodsiz odam'), phones: [PP2], createdBy: adminId },
    ])
    .returning({ id: crmPeople.id });
  peopleMade.push(...people.map((row) => row.id));
  await db.update(clients).set({ personId: people[0]!.id }).where(eq(clients.id, clientsMade[0]!));
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
  if (peopleMade.length) await db.delete(crmPeople).where(inArray(crmPeople.id, peopleMade));
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
    const mine = ours((await suppressionPage({ secret, since: fixturesFrom, cursor: null, limit: 5000 })).entries);
    const walked = ours(await walkSuppression(fixturesFrom, 1));
    // As MULTISETS: one phone on two records (a card and its person) is two
    // entries with one hash, by contract — the walk must carry both, once each.
    expect(walked.length).toBe(mine.length);
    expect(walked.map(keyOf).sort()).toEqual(mine.map(keyOf).sort());
    // 2 + 1 + 20 client phones, 2 listed lost leads — at the least.
    expect(walked.length).toBeGreaterThanOrEqual(25);
    // Each one-row page recomputes the set: ~0.4 s apiece on a shaped copy
    // (17,000 entries), where this walk takes ~12 s — the default 20 s is
    // too close on a long-lived database.
  }, 60_000);

  it('the full walk in small pages equals the full walk in big ones', async () => {
    const big = await fullSet();
    // Small enough to cross many page edges, big enough that a long-lived
    // database still walks in a couple of dozen reads — every page
    // recomputes the set.
    const walked = await walkSuppression(null, Math.max(7, Math.ceil(big.length / 25)));
    expect(ours(walked).map(keyOf).sort()).toEqual(ours(big).map(keyOf).sort());
    expect(ours(big).length).toBeGreaterThanOrEqual(25);
  }, 60_000);

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
    expect(kinds.get(hashTail(secret, tailOf(PP))), 'a client’s number kept on its person').toBe(
      'client',
    );
    expect(kinds.has(hashTail(secret, tailOf(PP2))), 'a person with no code is nobody’s client').toBe(
      false,
    );
  });

  it('every number in one phones value: typed with «/», with «+», imported as one run of digits', async () => {
    const hashes = new Set((await fullSet()).map((e) => e.h));
    for (let n = 1; n <= 8; n += 1) {
      expect(hashes.has(hashTail(secret, M(n))), `number ${n}`).toBe(true);
    }
  });

  it('a run of 998 numbers is cut into those numbers only — never also into nine-digit garbage', async () => {
    // Three 998 numbers are 36 digits, a multiple of nine as well: the 9-digit
    // chunks («998XXXXXX», «XXX998XXX»…) are nobody's phone, yet each reads as
    // a valid Uzbek mobile and would suppress a stranger.
    const [A, B, C] = ['81', '82', '83'].map((n) => `${STAMP}${n}`) as [string, string, string];
    const run = `998${A}998${B}998${C}`;
    const [card] = await db
      .insert(clients)
      .values({ clientCode: `AGT${STAMP}R`, name: NAME('36 raqam'), phones: [`+${run}`] })
      .returning({ id: clients.id });
    clientsMade.push(card!.id);
    const hashes = new Set((await walkSuppression(fixturesFrom, 5000)).map((e) => e.h));
    for (const real of [A, B, C]) expect(hashes.has(hashTail(secret, real)), real).toBe(true);
    const labels = await noContactReasons();
    for (const garbage of [run.slice(0, 9), run.slice(9, 18), run.slice(18, 27)]) {
      expect(hashes.has(hashTail(secret, garbage)), garbage).toBe(false);
      expect(await isSuppressedTail(`+998 ${garbage}`, labels), garbage).toBe(false);
    }
    expect(await isSuppressedTail(`+998 ${B}`, labels)).toBe(true);
  });

  it('a part of one number is no number: «+998 90/283-65-94» answers its own phone, not every …2836594', async () => {
    // The slash splits the value, and the part after it holds seven digits —
    // a FRAGMENT. Matched by suffix it suppressed a hundred strangers' numbers
    // the app's own phone rule (`phonesMatch`, over the whole value) never reads.
    const value = `+998 90/${STAMP.slice(0, 3)}-${STAMP.slice(3, 5)}-${STAMP.slice(5)}`;
    const [card] = await db
      .insert(clients)
      .values({ clientCode: `AGT${STAMP}Q`, name: NAME('bo‘lak raqam'), phones: [value] })
      .returning({ id: clients.id });
    clientsMade.push(card!.id);
    const labels = await noContactReasons();
    expect(await isSuppressedTail(`+998 90 ${STAMP}`, labels), 'the number itself').toBe(true);
    expect(await isSuppressedTail(`+998 33 ${STAMP}`, labels), 'another operator, same seven').toBe(
      false,
    );
  });

  it('a person tied to a code brings its numbers into the delta at that moment, not at the person’s own', async () => {
    const PX = phone();
    const old = new Date(Date.now() - 3 * 86_400_000);
    const [person] = await db
      .insert(crmPeople)
      .values({ name: NAME('eski odam'), phones: [PX], createdBy: adminId, createdAt: old, updatedAt: old })
      .returning({ id: crmPeople.id });
    peopleMade.push(person!.id);
    const [card] = await db
      .insert(clients)
      .values({ clientCode: `AGT${STAMP}P`, name: NAME('odamga bog‘lanadi'), phones: [], createdAt: old, updatedAt: old })
      .returning({ id: clients.id });
    clientsMade.push(card!.id);
    const h = hashTail(secret, tailOf(PX));
    const before = new Date(Date.now() - 1000).toISOString();
    expect((await walkSuppression(before, 5000)).map((e) => e.h), 'nobody holds the person yet').not.toContain(h);
    // attachClient writes the CARD, never the person.
    await attachClient(card!.id, person!.id, { actorId: adminId, ip: null, userAgent: null });
    expect((await walkSuppression(before, 5000)).map((e) => e.h)).toContain(h);
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
      ['belt-person', PP, 0],
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

    // /crm/tahlil reads that day-9 call as LATE, as it would anybody's — in
    // the late counts, never in the seller's median: the screen's number must
    // not depend on which door the lead came through.
    await db.update(leadIntakes).set({ assignedUserId: adminId }).where(eq(leadIntakes.id, a.id));
    const [row] = await db
      .select({ at: leadIntakes.createdAt })
      .from(leadIntakes)
      .where(eq(leadIntakes.id, a.id));
    const stat = (
      await firstContactBySeller(
        { from: new Date(row!.at.getTime() - 1000), to: new Date(row!.at.getTime() + 1000) },
        { owner: adminId },
      )
    ).get(adminId);
    expect(stat, 'the late agent arrival is counted at all').toBeTruthy();
    expect(stat!.measured, 'a contact after the week is no median sample').toBe(0);
    expect(stat!.medianMinutes).toBeNull();
    expect(stat!.lateDay).toBeGreaterThanOrEqual(1);
  });
});

describe('a landing that used to throw half-way', () => {
  /** The arrival landed whole: its ledger row, its lead, and the lead's lenta note. */
  async function landedWhole(id: string) {
    const intake = await intakeByExt(id);
    expect(intake, id).toBeTruthy();
    expect(intake.outcome).toBe('created');
    const notes = await db
      .select({ id: crmActivities.id })
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityId, intake.leadId!)));
    expect(notes.length, `${id}: the lenta note`).toBeGreaterThanOrEqual(1);
    return intake;
  }

  it('an emoji at the name’s 120-unit edge — the cut leaves it out whole, never half of it', async () => {
    const id = ext('emoji-name');
    const lead = NAME('emoji name ');
    const name = `${lead}${'x'.repeat(119 - lead.length)}😀 tail`;
    expect(name.slice(0, 120)).toMatch(/[\uD800-\uDBFF]$/); // the old cut's lone half
    const result = await landInboundLead({ channel: 'webhook', sourceKey: 'agent', externalId: id, name, phone: phone() });
    expect(result.outcome).toBe('created');
    const intake = await landedWhole(id);
    // The old budget (UTF-16 units), so a name never outgrows what the ✏️
    // form's schema accepts (third review).
    expect(intake.name).toBe(`${lead}${'x'.repeat(119 - lead.length)}`);
  });

  it('an emoji at a question pair’s 300-character edge', async () => {
    const id = ext('emoji-pair');
    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: id,
      name: NAME('emoji pair'),
      phone: phone(),
      fields: [{ key: 'evidence', value: `${'y'.repeat(299)}🔥🔥` }],
    });
    expect(result.outcome).toBe('created');
    const intake = await landedWhole(id);
    expect(intake.fields).toEqual([{ key: 'evidence', value: 'y'.repeat(299) }]);
  });

  it('an emoji at the lenta note’s 200-character audit excerpt', async () => {
    // «📣 agent\n» is nine UTF-16 units: the emoji sits at 199-200.
    const id = ext('emoji-note');
    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: id,
      name: NAME('emoji note'),
      phone: phone(),
      note: `${'x'.repeat(190)}😀 tail`,
    });
    expect(result.outcome).toBe('created');
    await landedWhole(id);
  });

  it('a lone half the sender put in the body itself — and on an advert door too', async () => {
    for (const [source, id] of [
      ['agent', ext('lone-half')],
      ['tiktok', `wh-${PREFIX}-lone-half`],
    ] as const) {
      const result = await landInboundLead({
        channel: 'webhook',
        sourceKey: source,
        externalId: id,
        name: NAME(`lone \ud83d half ${source}`),
        // The card keeps the phone as sent, and the create's audit row holds it.
        phone: `${phone()} \ud83d`,
        ref: { utm_campaign: 'x\udc00y' },
        fields: [{ key: 'k\ud83d', value: 'v\udc00' }],
      });
      expect(result.outcome, source).toBe('created');
      const intake = await landedWhole(id);
      expect(intake.name).toBe(NAME(`lone \ufffd half ${source}`));
      expect(intake.ref).toEqual({ utm_campaign: 'x\ufffdy' });
    }
  });

  it('a NUL anywhere in the agent’s body — every arrival lands whole, answers 200, and its retry is a replay', async () => {
    // Postgres refuses NUL in a text column (22021) and as \u0000 in jsonb
    // (22P05), and both refusals came after `createLead` had committed: a
    // 503 for ever, an orphan lead, one more lenta note per retry, nothing in
    // the outcomes (third review, through this same route).
    const post = (body: Record<string, unknown>) =>
      leadsInPOST(
        new Request('http://localhost:3000/api/leads/in/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gsr-key': secret },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ source: 'agent' }) },
      );
    const cases: [string, Record<string, unknown>][] = [
      ['nul-note', { note: 'Optom \u0000 kiyim' }],
      ['nul-extra', { meta: { src: 'x\u0000y' } }],
      // Outside the note's 1,000-character cut: only the pair and the ref hold it.
      ['nul-evidence', { note: 'x'.repeat(1100), evidence: 'qo\u0000l' }],
      ['nul-name', { name: NAME('nul \u0000 ism') }],
      ['nul-company', { company: 'Namuna \u0000 MChJ' }],
      ['nul-phone', { phone: `${phone()} \u0000` }],
      ['nul-key', { 'savol\u0000': 'javob' }],
    ];
    for (const [tag, over] of cases) {
      const id = ext(tag);
      const body = { name: NAME(tag), phone: phone(), external_id: id, ...over };
      for (const attempt of ['first', 'retry']) {
        const res = await post(body);
        expect(res.status, `${tag}: ${attempt}`).toBe(200);
      }
      const intake = await landedWhole(id);
      const notes = await db
        .select({ note: crmActivities.note })
        .from(crmActivities)
        .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityId, intake.leadId!)));
      expect(notes, `${tag}: the retry landed nothing`).toHaveLength(1);
      expect(JSON.stringify([intake, notes]), tag).not.toContain('\\u0000');
      expect((await agentOutcome(id))?.outcome, tag).toBe('created');
    }
    expect(((await intakeByExt(ext('nul-extra'))).ref as { meta: unknown }).meta).toEqual({ src: 'x\ufffdy' });
    const [card] = await db
      .select({ company: leads.company })
      .from(leads)
      .where(eq(leads.id, (await intakeByExt(ext('nul-company'))).leadId!));
    expect(card!.company).toBe('Namuna \ufffd MChJ');

    // The id itself: stored as postgres stores text (U+FFFD), and a retry is
    // a replay instead of a fence SELECT that throws on every attempt.
    const nulId = `${ext('nul-id')}\u0000`;
    for (const attempt of ['first', 'retry']) {
      const res = await post({ name: NAME('nul-id'), phone: phone(), external_id: nulId });
      expect(res.status, attempt).toBe(200);
    }
    const rows = await db.select().from(leadIntakes).where(eq(leadIntakes.externalId, `${ext('nul-id')}\ufffd`));
    expect(rows.map((row) => row.outcome)).toEqual(['created']);
    // …and the bot's own fence asks the same spelling.
    expect(await inboundLanded('webhook', nulId)).toBe(true);
  });

  it('a NUL on an advert door and on the public form — the arrival is recorded, so the daily caps count it', async () => {
    // The public form has no external id: each NUL submission was a lead
    // routed and booked for today, no ledger row, and the caps — which count
    // the ledger — never saw it (third review: five phones, five leads,
    // `inboundCount` 0). No key needed.
    const advert = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'tiktok',
      externalId: `wh-${PREFIX}-nul`,
      name: NAME('nul tiktok'),
      phone: phone(),
      note: 'salom \u0000 dunyo',
    });
    expect(advert.outcome).toBe('created');
    await landedWhole(`wh-${PREFIX}-nul`);

    const formPhone = phone();
    const form = new FormData();
    form.set('ism', NAME('nul ariza'));
    form.set('telefon', formPhone);
    form.set('izoh', 'salom \u0000 dunyo');
    expect(await submitArizaAction({}, form)).toEqual({ ok: true });
    const [intake] = await db.select().from(leadIntakes).where(eq(leadIntakes.name, NAME('nul ariza')));
    expect(intake?.outcome).toBe('created');
    expect(await inboundCount({ phone: tailOf(formPhone), sinceMs: 86_400_000 })).toBe(1);
  });

  it('a body nested deeper than the serialiser can write keeps the arrival — and one it can write is stored whole, as before', async () => {
    const nested = (depth: number) => {
      let value: unknown = 'x';
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    // 3,000 levels: `JSON.stringify` writes it, and so must the landing —
    // a replacer function overflowed at about half the depth (third review).
    const shallow = nested(3000);
    const okId = ext('deep-3000');
    const ok = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: okId,
      name: NAME('deep 3000'),
      phone: phone(),
      ref: { meta: shallow },
    });
    expect(ok.outcome).toBe('created');
    expect(JSON.stringify((await landedWhole(okId)).ref)).toBe(JSON.stringify({ meta: shallow }));

    // Fifty thousand: no serialiser writes it; the trail is a marker, the
    // arrival is whole (it used to throw inside the ledger row, after the
    // lead and its note).
    const deepId = ext('deep-50000');
    const deep = await landInboundLead({
      channel: 'webhook',
      sourceKey: 'agent',
      externalId: deepId,
      name: NAME('deep 50000'),
      phone: phone(),
      ref: { meta: nested(50_000) },
    });
    expect(deep.outcome).toBe('created');
    expect((await landedWhole(deepId)).ref).toEqual({ _truncated: true });
  });

  it('an external id longer than the ledger’s unique index holds — the arrival lands whole, its retry is a replay, the caps count it', async () => {
    // Postgres refused the ledger row (54000 «index row size … exceeds btree
    // version 4 maximum 2704») AFTER `createLead`: on the agent's door a 503
    // for ever and one more lenta note per retry, on every other door a 200
    // with an orphan lead the caps never counted (fourth review). Random
    // bytes, because the index compresses a repetitive id under its limit.
    const post = (body: Record<string, unknown>) =>
      leadsInPOST(
        new Request('http://localhost:3000/api/leads/in/agent', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gsr-key': secret },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ source: 'agent' }) },
      );
    // The spelling it is stored under, computed here from its definition and
    // not by the code under test: the hex SHA-256 of the id's UTF-8 bytes.
    const sha = (id: string) => `sha256:${createHash('sha256').update(id, 'utf8').digest('hex')}`;
    const longId = `${ext('long-id')}:${randomBytes(2200).toString('base64')}`;
    const body = { name: NAME('long id agent'), phone: LONG_ID_PHONES[0], external_id: longId };
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) statuses.push((await post(body)).status);
    expect(statuses).toEqual([200, 200, 200]);
    const intake = await landedWhole(sha(longId));
    const notes = await db
      .select({ id: crmActivities.id })
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityId, intake.leadId!)));
    expect(notes, 'the retries landed nothing').toHaveLength(1);
    const leadsLanded = await db.select({ id: leads.id }).from(leads).where(eq(leads.name, NAME('long id agent')));
    expect(leadsLanded).toHaveLength(1);
    expect(await inboundLanded('webhook', longId)).toBe(true);

    // An advert door: a 200 before as after, and now a ledger row the
    // per-phone cap counts, and a retry that is a replay.
    const googleId = `wh-${PREFIX}-long:${randomBytes(2200).toString('base64')}`;
    const googlePhone = LONG_ID_PHONES[1];
    const arrival = { channel: 'webhook' as const, sourceKey: 'google', externalId: googleId, name: NAME('long id google'), phone: googlePhone };
    expect((await landInboundLead(arrival)).outcome).toBe('created');
    expect(await landInboundLead(arrival)).toEqual({ outcome: 'dropped', reason: 'replay' });
    expect((await landedWhole(sha(googleId))).sourceKey).toBe('google');
    expect(await inboundCount({ phone: tailOf(googlePhone), sinceMs: 86_400_000 })).toBe(1);
  });

  it('an id the index holds keeps the spelling it always had — a long one of random bytes, and a repetitive one many times longer', async () => {
    // Both are over the length at which an id MAY be refused, so both are
    // fenced by both spellings; neither is refused, so each is stored, and
    // replayed, exactly as the code before this fix stored it. The longest
    // channel name, so the index row is as big as it gets.
    for (const [tag, tail, sentPhone] of [
      ['random', randomBytes(2000).toString('base64').slice(0, 2550), LONG_ID_PHONES[2]],
      ['repetitive', 'a'.repeat(20_000), LONG_ID_PHONES[3]],
    ] as const) {
      const id = `${ext(`as-sent-${tag}`)}:${tail}`;
      expect(Buffer.byteLength(id, 'utf8'), tag).toBeGreaterThan(INDEX_SAFE_ID_BYTES);
      const arrival = { channel: 'telegram' as const, sourceKey: 'telegram', externalId: id, name: NAME(`as sent ${tag}`), phone: sentPhone };
      expect((await landInboundLead(arrival)).outcome, tag).toBe('created');
      expect(await landInboundLead(arrival), tag).toEqual({ outcome: 'dropped', reason: 'replay' });
      const rows = await db.select().from(leadIntakes).where(eq(leadIntakes.name, NAME(`as sent ${tag}`)));
      expect(rows.map((row) => [row.externalId === id, row.outcome]), tag).toEqual([[true, 'created']]);
      expect(await inboundLanded('telegram', id), tag).toBe(true);
    }
  });

  it('a client card whose phones value is not a list is read as no phones — the landing’s client check does not throw', async () => {
    // Every door's step (0) scans every active card; one card holding a jsonb
    // STRING (a hand edit, an old import) made it throw «cannot extract
    // elements from a scalar» for every arrival with a phone. The row stands
    // only for the one call: three other readers of the client book still
    // throw on it (stated, DECISIONS #1468).
    const [bad] = await db
      .insert(clients)
      .values({ clientCode: `AGT${STAMP}S`, name: NAME('skalar telefon'), phones: '+998 90 000 00 00' as unknown as string[] })
      .returning({ id: clients.id });
    clientsMade.push(bad!.id);
    let found: unknown;
    try {
      found = await activeClientsByPhone(phone()).catch((err: unknown) => err);
    } finally {
      await db.delete(clients).where(eq(clients.id, bad!.id));
    }
    expect(found).toEqual([]);
  });

  it('two deliveries of one id in flight land one lead — the second waits and is a replay', async () => {
    // Deterministic: a third connection holds an UNCOMMITTED ledger row on the
    // same id, so the first delivery creates its lead and then waits on the
    // unique index. A second delivery that did not wait for it would pass the
    // replay check too and create a SECOND lead before the index refused its
    // row (review, 2026-10-24).
    const id = ext('race');
    const racePhone = phone();
    const name = NAME('race');
    const other = postgres(process.env.DATABASE_URL!, { max: 1 });
    const held = await other.reserve();
    await held`BEGIN`;
    await held`INSERT INTO lead_intakes (channel, external_id, outcome, name) VALUES ('webhook', ${id}, 'dropped', ${NAME('race-held')})`;
    const leadCount = () =>
      db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM leads WHERE name = ${name}`).then((r) => Number(r[0]!.n));
    const arrival = { channel: 'webhook' as const, sourceKey: 'agent', externalId: id, name, phone: racePhone };
    const first = landInboundLead(arrival);
    const second = landInboundLead(arrival);
    try {
      for (let i = 0; i < 200 && (await leadCount()) === 0; i++) await new Promise((r) => setTimeout(r, 25));
      expect(await leadCount(), 'the first delivery wrote its lead and waits').toBe(1);
      // Give a second delivery that did NOT wait every chance to write its own.
      for (let i = 0; i < 40 && (await leadCount()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await held`ROLLBACK`;
      held.release();
      await other.end();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.outcome).toBe('created');
    expect(b).toEqual({ outcome: 'dropped', reason: 'replay' });
    expect(await leadCount()).toBe(1);
    const rows = await db.select().from(leadIntakes).where(eq(leadIntakes.externalId, id));
    expect(rows.map((r) => r.outcome)).toEqual(['created']);
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
    expect(body).toMatchObject({ mode: 'full', rule: HASH_RULE, salt_id: saltIdFor(secret) });
    // One page on a fresh database; a long-lived one holds more (#653).
    expect(body.next === null || typeof body.next === 'string').toBe(true);
    const mine = await (
      await suppressionGET(ask(`suppression?since=${encodeURIComponent(fixturesFrom)}&limit=5000`))
    ).json();
    expect(mine.entries.map((e: SuppressionEntry) => e.h)).toContain(hashTail(secret, tailOf(P1)));

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
