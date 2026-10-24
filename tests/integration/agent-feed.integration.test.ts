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
  roles,
  settings,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  hashTail,
  HASH_RULE,
  outcomesPage,
  saltIdFor,
  suppressionPage,
  type OutcomeRow,
  type SuppressionEntry,
} from '@/modules/wms/crm/agent-feed';
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

let secret = '';
let adminId = '';
let lostStage = '';
let openStage = '';
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
  const made = await db
    .insert(clients)
    .values([
      { clientCode: `${code}A`, name: NAME('mijoz'), phones: [P1, P1b] },
      { clientCode: `${code}B`, name: NAME('eski mijoz'), phones: [P6], active: false },
      // Twenty phones on one card: one client is twenty rows that share an
      // instant and an id — the page edge's hardest case, and enough bytes
      // for the route to gzip.
      {
        clientCode: `${code}C`,
        name: NAME('ko‘p raqam'),
        // seq 50-69: `phone()` stays far below, so no tail is shared.
        phones: Array.from({ length: 20 }, (_, i) => `+998${STAMP}${50 + i}`),
      },
    ])
    .returning({ id: clients.id });
  clientsMade.push(...made.map((row) => row.id));

  await insertLead('lost-listed', P2, lostStage, 'qayta QILINMASIN');
  await insertLead('open', P3, openStage, null);
  await insertLead('lost-price', P4, lostStage, 'Narx');
  await insertLead('lost-untidy', P7, lostStage, '  Test   sabab ');
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
    // Both put on the same fixed office morning, an hour old: the advert's is
    // 45 minutes overdue, the agent's keeps the NULL due time it landed with.
    await db.execute(sql`
      UPDATE lead_intakes
         SET created_at = ${minutesFrom(F, -60)}::timestamptz,
             contact_clock_at = ${minutesFrom(F, -60)}::timestamptz,
             contact_due_at = CASE WHEN id = ${t.id}::uuid THEN ${minutesFrom(F, -45)}::timestamptz ELSE contact_due_at END
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
    'closed_at',
    'contacted_at',
    'contact_kind',
    'quoted_volume_m3',
    'at',
  ].sort();

  it('reports every agent arrival with what became of it, in the 14 fields and nothing else', async () => {
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
    expect(after).toMatchObject({ stage_kind: 'lost', lost_reason: 'Qayta qilinmasin' });
    expect(after!.closed_at).not.toBeNull();
    expect(after!.at >= row!.at).toBe(true);

    const [lead] = await db
      .select({ phone: leads.phone })
      .from(leads)
      .where(eq(leads.id, row!.lead_id!));
    const hashes = (await fullSet()).map((e) => e.h);
    expect(hashes).toContain(hashTail(secret, tailOf(lead!.phone!)));
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
    const badSince = await outcomesGET(ask('outcomes?since=yesterday'));
    expect(badSince.status).toBe(400);
    expect(await badSince.json()).toEqual({ error: 'bad_since' });
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
    expect(Object.keys(ob).sort()).toEqual(['generated_at', 'next', 'rows']);
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
