import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  crmActivities,
  leadAssignments,
  leadIntakes,
  leads,
  leadStages,
  tgAccounts,
  tgChatRules,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import {
  assignForTag,
  confirmSiteTagOnCard,
  landSiteTag,
  pickAssignee,
  saveSiteTeams,
  sitePanel,
  SiteAssignError,
} from '@/modules/wms/crm/site-assign';
import { disconnectAccount, storeIncoming } from '@/modules/wms/crm/telegram-accounts';
import { tashkentDay, tashkentDayStart } from '@/modules/platform/time/tashkent';
import { GET, HEAD } from '@/app/api/lead/assign/route';

/**
 * Round 113 against a real database: the website's question picks the least
 * busy reachable person and remembers the offer, and a visitor's tagged first
 * message becomes a lead once — never over a person's «never», never for
 * somebody the manager already talks to, never twice for one person.
 *
 * Every person here is minted by this file. The roster is GLOBAL (anybody
 * ticked anywhere is a candidate), so people ticked by earlier runs or other
 * files are un-ticked for the file's life and put back after (#653, #183).
 */

const STAMP = String(Date.now()).slice(-7);
/**
 * The file's clock. «Today» is Tashkent's day (R5), and a fixture that says
 * «twenty minutes ago» at 00:05 Tashkent is YESTERDAY — which is how this
 * file first failed, at exactly 19:00 UTC. So the loads are measured at a
 * moment at least half an hour into the Tashkent day, and every fixture time
 * is written relative to it.
 */
const CLOCK = (() => {
  const real = new Date();
  const floor = new Date(tashkentDayStart(tashkentDay(real)).getTime() + 30 * 60_000);
  return real < floor ? floor : real;
})();
const ctx = { actorId: null as string | null, ip: null, userAgent: null };
const ids: Record<string, string> = {};
let snapshot: { id: string; teams: string[] }[] = [];
let clientId = '';
let wonLeadId = '';
let openStageId = '';
let nextTag = 0;
const tag = () => `GSR-T${STAMP}${String((nextTag += 1)).padStart(2, '0')}`;
const peer = (n: number) => BigInt(`9${STAMP}${String(n).padStart(3, '0')}`);

async function mint(key: string, typed: string | null) {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99893${STAMP.slice(-5)}${String(Object.keys(ids).length).padStart(2, '0')}`,
      fullName: `Sayt hodim ${key} ${STAMP}`,
      passwordHash: 'x',
      active: true,
      telegramUsername: typed,
    })
    .returning({ id: users.id });
  ids[key] = row!.id;
}

async function tick(teams: Record<string, string[]>) {
  // Everybody this file owns first loses every team, then gets exactly these.
  await db.update(users).set({ leadTeams: [] }).where(inArray(users.id, Object.values(ids)));
  for (const [key, list] of Object.entries(teams)) {
    await db.update(users).set({ leadTeams: list }).where(eq(users.id, ids[key]!));
  }
}

async function offerTo(key: string, over: { capturable?: boolean; minutesAgo?: number } = {}) {
  const t = tag();
  await db.insert(leadAssignments).values({
    tag: t,
    team: 'cargo',
    userId: ids[key]!,
    username: `u${STAMP}${key}`,
    capturable: over.capturable ?? false,
    createdAt: new Date(CLOCK.getTime() - (over.minutesAgo ?? 0) * 60_000),
  });
  return t;
}

beforeAll(async () => {
  const ticked = await db
    .select({ id: users.id, teams: users.leadTeams })
    .from(users)
    .where(sql`cardinality(${users.leadTeams}) > 0`);
  snapshot = ticked.map((row) => ({ id: row.id, teams: row.teams ?? [] }));
  if (snapshot.length) {
    await db.update(users).set({ leadTeams: [] }).where(inArray(users.id, snapshot.map((r) => r.id)));
  }

  await mint('a', `sa${STAMP}a`);
  await mint('b', `sa${STAMP}b`);
  await mint('c', null); // connected, verified — its account row below
  await mint('g', `sa${STAMP}g`);
  await mint('m2', null); // a colleague's account, for the same-visitor join
  const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
  ctx.actorId = seeded!.id;

  await db.insert(tgAccounts).values([
    {
      managerUserId: ids.c!,
      tgPhone: `+99877${STAMP}1`,
      status: 'active',
      lastSeenAt: CLOCK,
      tgUsername: `sc${STAMP}c`,
      tgUsernameCheckedAt: CLOCK,
    },
    {
      managerUserId: ids.m2!,
      tgPhone: `+99877${STAMP}2`,
      status: 'active',
      lastSeenAt: CLOCK,
      tgUsername: `sc${STAMP}m`,
      tgUsernameCheckedAt: CLOCK,
    },
  ]);

  const [stage] = await db
    .select({ id: leadStages.id })
    .from(leadStages)
    .where(eq(leadStages.kind, 'open'))
    .limit(1);
  openStageId = stage!.id;
  const [client] = await db
    .insert(clients)
    .values({
      clientCode: `SA${STAMP}`.slice(0, 10),
      name: `Sayt mijoz ${STAMP}`,
      phones: [`+99890${STAMP}`],
    })
    .returning({ id: clients.id });
  clientId = client!.id;
});

beforeEach(async () => {
  // Each test sets up its own load; yesterday's test does not leak into it.
  await db
    .delete(leadAssignments)
    .where(
      or(
        inArray(leadAssignments.userId, Object.values(ids)),
        inArray(leadAssignments.confirmedUserId, Object.values(ids)),
      ),
    );
});

afterAll(async () => {
  const mine = Object.values(ids);
  if (mine.length) {
    await db.delete(tgMessages).where(inArray(tgMessages.managerUserId, mine));
    await db.delete(tgChatRules).where(inArray(tgChatRules.managerUserId, mine));
    await db
      .delete(leadAssignments)
      .where(or(inArray(leadAssignments.userId, mine), inArray(leadAssignments.confirmedUserId, mine)));
    await db.delete(leadIntakes).where(like(leadIntakes.externalId, `GSR-T${STAMP}%`));
    const made = await db.select({ id: leads.id }).from(leads).where(inArray(leads.ownerId, mine));
    const leadIds = made.map((row) => row.id);
    if (wonLeadId) leadIds.push(wonLeadId);
    if (leadIds.length) {
      await db.delete(crmActivities).where(inArray(crmActivities.entityId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
    await db.delete(crmActivities).where(eq(crmActivities.entityId, clientId));
    await db.delete(tgAccounts).where(inArray(tgAccounts.managerUserId, mine));
    await db.delete(clients).where(eq(clients.id, clientId));
    await db.delete(users).where(inArray(users.id, mine));
  }
  for (const row of snapshot) {
    await db.update(users).set({ leadTeams: row.teams }).where(eq(users.id, row.id));
  }
  await pgClient.end();
});

describe('the website question', () => {
  it('nobody ticked answers nobody and writes nothing', async () => {
    await tick({});
    const t = tag();
    expect(await assignForTag({ team: 'cargo', tag: t, topic: null, page: null, lang: null })).toEqual({
      username: null,
      reused: false,
    });
    const rows = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(rows).toHaveLength(0);
  });

  it('the least busy gets it, and the same tag asked twice is the same person', async () => {
    await tick({ a: ['cargo'], b: ['cargo'] });
    await offerTo('a'); // a: one visitor today, and nobody could see whether they wrote
    const t = tag();
    const first = await assignForTag({ team: 'cargo', tag: t, topic: 'yuk', page: '/narxlar/', lang: 'uz' });
    expect(first).toEqual({ username: `sa${STAMP}b`, reused: false });
    const again = await assignForTag({ team: 'cargo', tag: t, topic: null, page: null, lang: null });
    expect(again).toEqual({ username: `sa${STAMP}b`, reused: true });
    const rows = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ids.b, capturable: false, topic: 'yuk', page: '/narxlar/' });
  });

  it('a tag past its landing window, or whose person has left, answers nobody and stays spent', async () => {
    await tick({ a: ['cargo'], b: ['cargo'] });
    const ask = (t: string) => assignForTag({ team: 'cargo', tag: t, topic: null, page: null, lang: null });
    // A site that kept yesterday's tag: the name it would get back can no
    // longer land a lead, so the answer is «use your own list».
    const stale = tag();
    await db.insert(leadAssignments).values({
      tag: stale,
      team: 'cargo',
      userId: ids.b!,
      username: `sa${STAMP}b`,
      createdAt: new Date(Date.now() - 25 * 3600_000),
    });
    expect(await ask(stale)).toEqual({ username: null, reused: true });
    // …and a fresh tag whose person was deactivated since.
    await mint('x', `sa${STAMP}x`);
    const left = tag();
    await db.insert(leadAssignments).values({ tag: left, team: 'cargo', userId: ids.x!, username: `sa${STAMP}x` });
    expect(await ask(left)).toEqual({ username: `sa${STAMP}x`, reused: true });
    await db.update(users).set({ active: false }).where(eq(users.id, ids.x!));
    expect(await ask(left)).toEqual({ username: null, reused: true });
    // Neither became a second pick under the same tag.
    const rows = await db.select().from(leadAssignments).where(inArray(leadAssignments.tag, [stale, left]));
    expect(rows).toHaveLength(2);
  });

  it('a visitor we could have seen and did not stops counting after fifteen minutes', async () => {
    await tick({ a: ['cargo'], c: ['cargo'] });
    await offerTo('a', { minutesAgo: 20 }); // blind: counts all day
    await offerTo('c', { capturable: true, minutesAgo: 20 }); // seen-able, never wrote
    expect((await pickAssignee('cargo', db, CLOCK)).chosen?.userId).toBe(ids.c);
    // …while one still inside its fifteen minutes is work in hand.
    await offerTo('c', { capturable: true, minutesAgo: 5 });
    expect((await pickAssignee('cargo', db, CLOCK)).chosen?.userId).toBe(ids.a);
  });

  it('a connected account with a fresh handle is handed out as capturable', async () => {
    await tick({ c: ['cargo'] });
    const pick = await pickAssignee('cargo', db, CLOCK);
    expect(pick.chosen).toMatchObject({ userId: ids.c, username: `sc${STAMP}c`, source: 'verified', capturable: true });
  });

  it('a handle nobody has confirmed for an hour is not handed out', async () => {
    await tick({ c: ['cargo'] });
    await db
      .update(tgAccounts)
      .set({ tgUsernameCheckedAt: new Date(CLOCK.getTime() - 2 * 3_600_000) })
      .where(eq(tgAccounts.managerUserId, ids.c!));
    try {
      const pick = await pickAssignee('cargo', db, CLOCK);
      expect(pick.chosen).toBeNull();
      expect(pick.excluded).toContainEqual(
        expect.objectContaining({ userId: ids.c, reason: 'username_stale' }),
      );
    } finally {
      await db
        .update(tgAccounts)
        .set({ tgUsernameCheckedAt: CLOCK })
        .where(eq(tgAccounts.managerUserId, ids.c!));
    }
  });

  it('an advert lead routed to somebody today is part of their load', async () => {
    await tick({ a: ['cargo'], b: ['cargo'] });
    const [lead] = await db
      .insert(leads)
      .values({
        name: `Sayt reklama ${STAMP}`,
        stageId: openStageId,
        ownerId: ids.a!,
        inboundAt: CLOCK,
      })
      .returning({ id: leads.id });
    try {
      // With equal loads a sorts ahead of b (minted first, so the smaller
      // id); the routed lead has to be what sends the visitor to b.
      expect(ids.a! < ids.b!).toBe(true);
      expect((await pickAssignee('cargo', db, CLOCK)).chosen?.userId).toBe(ids.b);
    } finally {
      await db.delete(leads).where(eq(leads.id, lead!.id));
    }
  });

  it('an empty team falls to «general», and never to somebody unticked', async () => {
    await tick({ g: ['general'] });
    const pick = await pickAssignee('buying', db, CLOCK);
    expect(pick.chosen?.userId).toBe(ids.g);
    expect(pick.widened).toBe(true);
    await tick({});
    expect((await pickAssignee('buying', db, CLOCK)).chosen).toBeNull();
  });

  it('parallel visitors spread over the team instead of piling on one person', async () => {
    await tick({ a: ['cargo'], b: ['cargo'], g: ['cargo'] });
    const answers = await Promise.all(
      Array.from({ length: 6 }, () =>
        assignForTag({ team: 'cargo', tag: tag(), topic: null, page: null, lang: null }),
      ),
    );
    const counts = new Map<string, number>();
    for (const answer of answers) {
      counts.set(answer.username!, (counts.get(answer.username!) ?? 0) + 1);
    }
    // Without the lock all six read «everybody has zero» and all six go to
    // whoever sorts first.
    expect([...counts.values()].sort()).toEqual([2, 2, 2]);
  });

  it('an answer nobody is waiting for any more is not written down', async () => {
    await tick({ a: ['cargo'] });
    const t = tag();
    expect(
      await assignForTag({ team: 'cargo', tag: t, topic: null, page: null, lang: null }, () => false),
    ).toEqual({ username: null, reused: false });
    expect(await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t))).toHaveLength(0);
  });
});

describe('the public door', () => {
  const ask = (lead: string, origin: string | null, method = 'GET') =>
    new Request(`https://gsrwms.uz/api/lead/assign?team=cargo&tag=yuk&lead=${lead}`, {
      method,
      headers: origin ? { origin } : {},
    });

  it('answers the website page with a username and its CORS header', async () => {
    await tick({ a: ['cargo'] });
    const t = tag();
    const response = await GET(ask(t, 'https://gsrlogistics.uz'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: `sa${STAMP}a` });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://gsrlogistics.uz');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('another page, no page, a bad tag and a HEAD all get null and write nothing', async () => {
    await tick({ a: ['cargo'] });
    const t = tag();
    // A foreign page (or none) is not even told the answer is readable.
    for (const response of [await GET(ask(t, 'https://evil.example')), await GET(ask(t, null))]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ username: null });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    // Our own page with a malformed tag CAN read its null — that is how it
    // knows to fall back rather than wait out its timer.
    const bad = await GET(ask('GSR-12', 'https://gsrlogistics.uz'));
    expect(await bad.json()).toEqual({ username: null });
    expect(bad.headers.get('access-control-allow-origin')).toBe('https://gsrlogistics.uz');
    // HEAD is answered without running the pick at all.
    const head = await HEAD();
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t))).toHaveLength(0);
  });
});

describe('the visitor writes', () => {
  const visitor = (n: number, over: Partial<{ phone: string | null; username: string | null }> = {}) => ({
    id: peer(n),
    phone: over.phone ?? null,
    title: `Sayt mehmon ${n} ${STAMP}`,
    username: over.username === undefined ? `mehmon${STAMP}${n}` : over.username,
  });
  const land = (manager: string, t: string, who: ReturnType<typeof visitor>, wroteBefore = false) =>
    landSiteTag({
      managerUserId: ids[manager]!,
      tag: t,
      peer: who,
      text: `Salom ${t}, 20 kub yuk bor`,
      wroteBefore: async () => wroteBefore,
    });

  it('a tag we never issued is ordinary text', async () => {
    expect(await land('c', 'GSR-NEVERISSUED', visitor(1))).toEqual({ landed: false, reason: 'no_offer' });
  });

  it('somebody the manager already talks to is not a website arrival', async () => {
    const t = await offerTo('c', { capturable: true });
    expect(await land('c', t, visitor(2), true)).toEqual({ landed: false, reason: 'not_first_contact' });
    const [offer] = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(offer!.confirmedAt).toBeNull();
  });

  it('a first contact becomes a lead on the receiving manager, once, and keeps the chat', async () => {
    const t = await offerTo('c', { capturable: true });
    const who = visitor(3);
    const landed = await land('c', t, who);
    expect(landed).toMatchObject({ landed: true, outcome: 'created', clientId: null });
    const leadId = (landed as { leadId: string }).leadId;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ ownerId: ids.c, name: who.title });
    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(and(eq(leadIntakes.channel, 'site'), eq(leadIntakes.externalId, t)));
    expect(intake).toMatchObject({ outcome: 'created', sourceKey: 'sayt', leadId });
    const [rule] = await db
      .select()
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, ids.c!), eq(tgChatRules.peerId, who.id)));
    expect(rule).toMatchObject({ decision: 'include', leadId, clientId: null });
    const [offer] = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(offer).toMatchObject({ confirmedUserId: ids.c, peerId: who.id, leadId });
    const notes = await db.select().from(crmActivities).where(eq(crmActivities.entityId, leadId));
    expect(notes.map((n) => n.note).join('\n')).toContain(`@mehmon${STAMP}3`);

    // The same person again — the listener's retry after a crash — finishes
    // on the same lead and mints nothing.
    const again = await land('c', t, who);
    expect(again).toMatchObject({ landed: true, leadId });
    const same = await db.select().from(leads).where(eq(leads.name, who.title));
    expect(same).toHaveLength(1);

    // Somebody else carrying the same tag gets nothing from it.
    expect(await land('c', t, visitor(4))).toEqual({ landed: false, reason: 'no_offer' });
  });

  it('a written «never» on this chat wins over a stranger\'s tag', async () => {
    const who = visitor(5);
    await db.insert(tgChatRules).values({
      managerUserId: ids.c!,
      peerId: who.id,
      decision: 'exclude',
    });
    const t = await offerTo('c', { capturable: true });
    expect(await land('c', t, who)).toEqual({ landed: false, reason: 'decided' });
    const [rule] = await db
      .select()
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, ids.c!), eq(tgChatRules.peerId, who.id)));
    expect(rule!.decision).toBe('exclude');
    const [offer] = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(offer!.confirmedAt).toBeNull();
    expect(await db.select().from(leads).where(eq(leads.name, who.title))).toHaveLength(0);
  });

  it('the same Telegram person already on a colleague\'s open lead is joined, not duplicated', async () => {
    const who = visitor(6);
    const first = await land('m2', await offerTo('m2', { capturable: true }), who);
    const leadId = (first as { leadId: string }).leadId;
    const second = await land('c', await offerTo('c', { capturable: true }), who);
    expect(second).toMatchObject({ landed: true, outcome: 'joined', leadId });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.ownerId).toBe(ids.m2); // whoever is already working it keeps it
  });

  it('a known client asking through the website lands on their card', async () => {
    const who = visitor(7, { phone: `+99890${STAMP}` });
    const landed = await land('c', await offerTo('c', { capturable: true }), who);
    expect(landed).toMatchObject({ landed: true, outcome: 'client', leadId: null, clientId });
  });

  it('a tag in a chat that already has a card only confirms, once', async () => {
    const t = await offerTo('c', { capturable: true });
    const input = { managerUserId: ids.c!, tag: t, peerId: peer(8), clientId, leadId: null };
    expect(await confirmSiteTagOnCard(input)).toBe(true);
    expect(await confirmSiteTagOnCard(input)).toBe(false);
    const [offer] = await db.select().from(leadAssignments).where(eq(leadAssignments.tag, t));
    expect(offer).toMatchObject({ confirmedUserId: ids.c, clientId });
    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(and(eq(leadIntakes.channel, 'site'), eq(leadIntakes.externalId, t)));
    expect(intake).toMatchObject({ outcome: 'client', clientId });
  });
});

describe('a won lead\'s chat', () => {
  it('goes on reaching the client card after the win', async () => {
    const [lead] = await db
      .insert(leads)
      .values({ name: `Sayt yutilgan ${STAMP}`, stageId: openStageId, clientId })
      .returning({ id: leads.id });
    wonLeadId = lead!.id;
    const id = await storeIncoming({
      clientId: null,
      leadId: wonLeadId,
      managerUserId: ids.c!,
      row: {
        peerId: peer(9),
        tgMessageId: 1n,
        direction: 'in',
        body: 'yana savol',
        hasMedia: false,
        sentAt: new Date(),
        replyToTgMessageId: null,
        fwdFrom: null,
      },
    });
    const [row] = await db.select().from(tgMessages).where(eq(tgMessages.id, id!));
    expect(row).toMatchObject({ leadId: wonLeadId, clientId });
  });
});

describe('the panel', () => {
  it('saves only the people it rendered, and refuses a handle somebody else holds', async () => {
    await tick({ a: ['cargo'], b: ['buying'] });
    await saveSiteTeams([{ userId: ids.a!, teams: ['general', 'nonsense'], username: '@x' + STAMP + 'aa' }], ctx);
    const rows = await db
      .select({ id: users.id, teams: users.leadTeams, username: users.telegramUsername })
      .from(users)
      .where(inArray(users.id, [ids.a!, ids.b!]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.a!)).toMatchObject({ teams: ['general'], username: `x${STAMP}aa` });
    expect(byId.get(ids.b!)!.teams).toEqual(['buying']); // not on the form, untouched

    await expect(
      saveSiteTeams([{ userId: ids.a!, teams: [], username: `sc${STAMP}c` }], ctx),
    ).rejects.toThrow(SiteAssignError);
    await expect(
      saveSiteTeams([{ userId: ids.a!, teams: [], username: '9bad' }], ctx),
    ).rejects.toThrow('bad_username');
  });

  it('says so when a live listener has never read its handle', async () => {
    await db
      .update(tgAccounts)
      .set({ tgUsernameCheckedAt: null })
      .where(eq(tgAccounts.managerUserId, ids.m2!));
    const panel = await sitePanel();
    expect(panel.people.find((p) => p.userId === ids.m2)?.listenerOutdated).toBe(true);
    expect(panel.people.find((p) => p.userId === ids.c)?.listenerOutdated).toBe(false);
  });

  it('a disconnect takes the handle with it', async () => {
    await disconnectAccount(ids.m2!);
    const [account] = await db.select().from(tgAccounts).where(eq(tgAccounts.managerUserId, ids.m2!));
    expect(account).toMatchObject({ tgUsername: null, tgUsernameCheckedAt: null, status: 'signed_out' });
  });
});
