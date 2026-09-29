import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, leadStages, leads, tgMessages, users } from '@/modules/platform/db/schema';
import {
  chatBadges,
  conversationForLead,
  leadOwnChatRows,
  listConversations,
  markLeadThreadRead,
  resolveChatStates,
  threadManagersForLead,
} from '@/modules/wms/crm/conversations';
import { recordChatRead } from '@/modules/wms/crm/telegram-accounts';
import { unansweredChats, unansweredText } from '@/modules/wms/crm/unanswered';
import { LEAD_CHAT_ALARMS_FROM } from '@/modules/wms/crm/waiting';
import { salesFlowCounts } from '@/modules/wms/home/role-flows';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import type { LeadReader } from '@/modules/wms/crm/lead-door';

/**
 * A prospect's Telegram chat watched like a client's — the owner's answer
 * 4a (2026-09-28): «lidlarning chatlari ham mijoz chatlari kabi, 30 daqiqa».
 *
 * The pure rules (the alarm's two lines, the card's precedence, the row's
 * address) are unit-tested in `tests/unit/lid-chat.test.ts`. This file proves
 * the WIRING: that a lead-only row reaches all four readers — the list, the
 * card badges, the seller's home count and the nudge — through the one
 * resolver, keyed by the lead and never by the (client, lead) pair, behind
 * the same own-account fence as a client's chat.
 *
 * Every assertion is about THIS file's own rows (#713, #730): CI runs the
 * whole suite on one database, and other files leave chats behind. That is
 * also why the 30-minute sweep itself (`remindUnanswered`) is not called
 * here — it stamps and notifies EVERY due chat in the database, strangers'
 * included; what it sends is `unansweredChats` + `unansweredText`, and both
 * are asserted on this file's own messages.
 */

const MARK = `LC${String(Date.now()).slice(-7)}`;
const PEER_BASE = BigInt(Date.now()) * 1000n;
let peerSeq = 0;
/** A clock is not a unique id — a counter beside it is (chat-lead's lesson). */
const nextPeer = () => PEER_BASE + BigInt((peerSeq += 1));

let seller = '';
let boss = '';
let colleague = '';
let ved = '';
let bossName = '';
let sellerName = '';
let openStage = '';
let lostStage = '';
const madeLeads: string[] = [];
const madeClients: string[] = [];
const madePeers: bigint[] = [];

/** Recent enough to ring: past the lead watch's start and past 30 minutes. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const sellerReader = (): LeadReader => ({ id: seller, permissions: new Set(['crm.leads']) });
const bossReader = (): LeadReader => ({
  id: boss,
  permissions: new Set(['crm.leads', 'crm.leads.view_all']),
});

async function lead(opts: {
  owner: string | null;
  stage?: 'open' | 'lost';
  closedAt?: Date;
  clientId?: string;
}) {
  const [row] = await db
    .insert(leads)
    .values({
      name: `${MARK} lid ${madeLeads.length + 1}`,
      stageId: opts.stage === 'lost' ? lostStage : openStage,
      ownerId: opts.owner,
      closedAt: opts.closedAt ?? null,
      clientId: opts.clientId ?? null,
    })
    .returning();
  madeLeads.push(row!.id);
  return row!.id;
}

async function client() {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `${MARK}${madeClients.length + 1}`, name: `${MARK} mijoz` })
    .returning();
  madeClients.push(row!.id);
  return row!.id;
}

/** One stored message; returns its id. `peer` defaults to a fresh dialog. */
async function say(opts: {
  leadId?: string | null;
  clientId?: string | null;
  manager?: string;
  dir?: 'in' | 'out';
  at?: Date;
  tgId?: bigint;
  peer?: bigint;
  body?: string;
}) {
  const peer = opts.peer ?? nextPeer();
  if (!madePeers.includes(peer)) madePeers.push(peer);
  const [row] = await db
    .insert(tgMessages)
    .values({
      leadId: opts.leadId ?? null,
      clientId: opts.clientId ?? null,
      managerUserId: opts.manager ?? seller,
      peerId: peer,
      tgMessageId: opts.tgId ?? 7n,
      direction: opts.dir ?? 'in',
      body: opts.body ?? `${MARK} salom, narx qancha?`,
      sentAt: opts.at ?? ago(40),
    })
    .returning();
  return { id: row!.id, peer };
}

const sellerList = () =>
  listConversations({ id: seller }, undefined, 10_000, { leadsFor: sellerReader() });

beforeAll(async () => {
  const byPhone = async (phone: string) =>
    (await db.select().from(users).where(eq(users.phone, phone)))[0]!;
  const s = await byPhone('+998900000009'); // Dilnoza — sales_manager: crm.leads, not view_all
  const b = await byPhone('+998900000001'); // the owner — super_admin: the whole funnel
  const c = await byPhone('+998900000002'); // an admin — a colleague with an account of their own
  const v = await byPhone('+998900000004'); // the VED — ved.docs, no crm.leads
  seller = s.id;
  sellerName = s.fullName;
  boss = b.id;
  bossName = b.fullName;
  colleague = c.id;
  ved = v.id;
  const stages = await db.select().from(leadStages);
  openStage = stages.find((row) => row.kind === 'open')!.id;
  lostStage = stages.find((row) => row.kind === 'lost')!.id;
});

afterAll(async () => {
  // Messages first (they point at the leads and clients), then the read
  // pointers this file's peers wrote, then the cards (#380's order). Nothing
  // here was audited or notified, so every row can go.
  if (madeLeads.length > 0) {
    await db.delete(tgMessages).where(inArray(tgMessages.leadId, madeLeads));
  }
  if (madeClients.length > 0) {
    await db.delete(tgMessages).where(inArray(tgMessages.clientId, madeClients));
  }
  if (madePeers.length > 0) {
    await db.execute(
      sql`DELETE FROM tg_chat_reads WHERE peer_id IN (${sql.join(
        madePeers.map((p) => sql`${String(p)}`),
        sql`, `,
      )})`,
    );
  }
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  if (madeClients.length > 0) await db.delete(clients).where(inArray(clients.id, madeClients));
  await pgClient.end();
});

describe('a prospect’s chat is on the list like a client’s', () => {
  it('is a LEAD row: the lead’s name, no code, «new», opening on the card’s chat', async () => {
    const id = await lead({ owner: seller });
    await say({ leadId: id });
    const row = (await sellerList()).find((r) => r.leadId === id);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('lead');
    expect(row!.clientId).toBeNull();
    expect(row!.code).toBeNull();
    expect(row!.name).toBe(`${MARK} lid ${madeLeads.indexOf(id) + 1}`);
    expect(row!.state).toBe('new');
    expect(row!.waitingOnUs).toBe(true);
    expect(row!.messages).toBe(1);
    expect(row!.href).toBe(`/crm/leads/${id}#tg-thread`);
    expect(row!.leadOwner).toBeNull();
  });

  it('only for a reader who may open lead cards — and only when asked', async () => {
    const id = await lead({ owner: seller });
    await say({ leadId: id });
    // A caller that says nothing gets the list it always had.
    expect(
      (await listConversations({ id: seller }, undefined, 10_000)).some((r) => r.leadId === id),
    ).toBe(false);
    // `canReadTg` admits a ved.docs holder who has no crm.leads — and the
    // lead card would bounce them, so their list carries no lead rows.
    const vedOnly: LeadReader = { id: seller, permissions: new Set(['ved.docs']) };
    expect(
      (await listConversations({ id: seller }, undefined, 10_000, { leadsFor: vedOnly })).some(
        (r) => r.leadId === id,
      ),
    ).toBe(false);
  });

  it('two leads on one manager are two rows, two badges and two nudges', async () => {
    const a = await lead({ owner: seller });
    const b = await lead({ owner: seller });
    const ma = await say({ leadId: a });
    const mb = await say({ leadId: b });

    const rows = (await sellerList()).filter((r) => r.leadId === a || r.leadId === b);
    expect(rows.map((r) => r.leadId).sort()).toEqual([a, b].sort());

    const badges = await chatBadges({ id: seller }, { leadIds: [a, b] });
    expect(badges.leads.get(a)).toBe('waiting');
    expect(badges.leads.get(b)).toBe('waiting');

    const due = (await unansweredChats(30)).map((chat) => chat.messageId);
    expect(due).toContain(ma.id);
    expect(due).toContain(mb.id);
  });

  it('finds a lead row by the lead’s phone typed without its formatting', async () => {
    const id = await lead({ owner: seller });
    const digits = `9989${String(Date.now()).slice(-8)}`;
    await db
      .update(leads)
      .set({ phone: `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}` })
      .where(eq(leads.id, id));
    await say({ leadId: id });
    const found = await listConversations({ id: seller }, digits, 10_000, {
      leadsFor: sellerReader(),
    });
    expect(found.map((r) => r.leadId)).toContain(id);
  });
});

describe('one person’s conversation is ONE row', () => {
  it('a won lead’s rows (both ids) and a later client-only row are the client’s row alone', async () => {
    const clientId = await client();
    const won = await lead({ owner: seller, clientId });
    const peer = nextPeer();
    // Rekeyed on the win: the rows keep `lead_id` and gain the client.
    await say({ leadId: won, clientId, peer, tgId: 1n, at: ago(90) });
    // Written after the win by the listener, which fills the client in.
    await say({ leadId: won, clientId, peer, tgId: 2n, at: ago(60) });
    await say({ clientId, peer, tgId: 3n, at: ago(40) });

    const rows = await sellerList();
    expect(rows.filter((r) => r.clientId === clientId)).toHaveLength(1);
    expect(rows.some((r) => r.leadId === won)).toBe(false);
    expect((await chatBadges({ id: seller }, { leadIds: [won] })).leads.has(won)).toBe(false);
  });

  it('a won lead whose every row carries both ids is the client’s row alone', async () => {
    // No client-only row after the win to witness it: the rows' own client id
    // is what keeps them off the lead list. Since only a NEWER client row
    // supersedes, `client_id IS NULL` is load-bearing here and not implied.
    const clientId = await client();
    const won = await lead({ owner: seller, clientId });
    const peer = nextPeer();
    await say({ leadId: won, clientId, peer, tgId: 1n, at: ago(90) });
    await say({ leadId: won, clientId, peer, tgId: 2n, at: ago(40) });

    const rows = await sellerList();
    expect(rows.filter((r) => r.clientId === clientId)).toHaveLength(1);
    expect(rows.some((r) => r.leadId === won)).toBe(false);
    expect((await chatBadges({ id: seller }, { leadIds: [won] })).leads.has(won)).toBe(false);
    expect(await leadOwnChatRows(won, { id: seller })).toBe(0);
  });

  it('a chat the tray moved to a client stops being a lead row (the stale half)', async () => {
    // The client door (`decideChat`) rewrites the RULE only: the lead-only
    // rows it had already stored keep no client, and the same dialog then
    // carries client rows too.
    const clientId = await client();
    const moved = await lead({ owner: seller });
    const peer = nextPeer();
    const old = await say({ leadId: moved, peer, tgId: 1n, at: ago(120) });
    await say({ clientId, peer, tgId: 2n, at: ago(100), dir: 'out' });

    expect((await sellerList()).some((r) => r.leadId === moved)).toBe(false);
    expect((await chatBadges({ id: seller }, { leadIds: [moved] })).leads.has(moved)).toBe(false);
    expect((await unansweredChats(30)).some((chat) => chat.messageId === old.id)).toBe(false);
    // …and the lead card no longer claims its chat panel with that half.
    expect(await leadOwnChatRows(moved, { id: seller })).toBe(0);
  });

  it('the door swings back: a dialog filed under a lead AFTER its client half rings as the lead', async () => {
    // The tray's «↩» put a client-filed chat back and «Yangi lid» filed what
    // followed under a lead — or the lead card's «Chatni qo'shish» attached a
    // client-book dialog to a lead. Here the client rows are the OLD half,
    // and only a NEWER client row may supersede (the review's second
    // finding: an unordered witness hid every new message the prospect wrote).
    const clientId = await client();
    const flipped = await lead({ owner: seller });
    const peer = nextPeer();
    await say({ clientId, peer, tgId: 1n, at: ago(3 * 24 * 60), dir: 'out' });
    const fresh = await say({ leadId: flipped, peer, tgId: 2n, at: ago(40) });

    const row = (await sellerList()).find((r) => r.leadId === flipped);
    expect(row?.state).toBe('new');
    expect(row?.messages).toBe(1);
    expect((await chatBadges({ id: seller }, { leadIds: [flipped] })).leads.get(flipped)).toBe(
      'waiting',
    );
    expect((await unansweredChats(30)).some((chat) => chat.messageId === fresh.id)).toBe(true);
    // …and the card's panel is the lead's own, not the phone-matched client's.
    expect(await leadOwnChatRows(flipped, { id: seller })).toBe(1);
  });
});

describe('the own-account fence', () => {
  it('a colleague sees nothing; the supervision view sees it and names the manager', async () => {
    const id = await lead({ owner: seller });
    await say({ leadId: id });

    const theirs = await listConversations({ id: colleague }, undefined, 10_000, {
      leadsFor: { id: colleague, permissions: new Set(['crm.leads', 'crm.leads.view_all']) },
    });
    expect(theirs.some((r) => r.leadId === id)).toBe(false);
    expect((await chatBadges({ id: colleague }, { leadIds: [id] })).leads.has(id)).toBe(false);
    expect(await leadOwnChatRows(id, { id: colleague })).toBe(0);

    const boss_ = await listConversations({ id: boss, all: true }, undefined, 10_000, {
      leadsFor: bossReader(),
    });
    const row = boss_.find((r) => r.leadId === id);
    expect(row).toBeDefined();
    expect(row!.managers).toContain(sellerName);
    expect(await leadOwnChatRows(id, { id: boss, all: true })).toBe(1);
  });

  it('reading it on the lead card marks it for the OWNER of the account, never a supervisor', async () => {
    const id = await lead({ owner: seller });
    await say({ leadId: id });
    // The boss opens the seller's lead card: his glance must not silence the
    // seller's alarm (#650) — the fence is the statement's WHERE.
    await markLeadThreadRead(id, boss);
    expect((await sellerList()).find((r) => r.leadId === id)!.state).toBe('new');

    await markLeadThreadRead(id, seller);
    expect((await sellerList()).find((r) => r.leadId === id)!.state).toBe('seen');
  });

  it('two managers on one lead are two conversations: the supervisor picks whose to read', async () => {
    // A website lead routed to the seller and later messaged by a colleague
    // is two chats on two personal accounts; merged by timestamp they show
    // one that never happened (#639, the design judge's fifth finding).
    const id = await lead({ owner: seller });
    await say({ leadId: id, manager: seller, body: `${MARK} sotuvchiga` });
    await say({ leadId: id, manager: colleague, body: `${MARK} kollegaga` });

    const chips = await threadManagersForLead(id);
    expect(chips.map((chip) => chip.id).sort()).toEqual([seller, colleague].sort());

    const bodies = async (viewer: { id: string; all?: boolean }, managerId?: string) =>
      (await conversationForLead(id, viewer, 200, managerId)).map((m) => m.body);
    // The supervision view reads the one it picked…
    expect(await bodies({ id: boss, all: true }, seller)).toEqual([`${MARK} sotuvchiga`]);
    expect(await bodies({ id: boss, all: true }, colleague)).toEqual([`${MARK} kollegaga`]);
    // …and a seller's hand-typed pick cannot widen their own account.
    expect(await bodies({ id: seller }, colleague)).toEqual([`${MARK} sotuvchiga`]);
  });
});

describe('the board asks only about the cards it drew', () => {
  it('a bound kind answers for its own ids; a board of clients never gets lead marks', async () => {
    const a = await lead({ owner: seller });
    const b = await lead({ owner: seller });
    await say({ leadId: a });
    await say({ leadId: b });
    const onlyA = await chatBadges({ id: seller }, { leadIds: [a] });
    expect(onlyA.leads.has(a)).toBe(true);
    expect(onlyA.leads.has(b)).toBe(false);

    const clientId = await client();
    await say({ clientId });
    const dealBoard = await chatBadges({ id: seller }, { clientIds: [clientId] });
    expect(dealBoard.clients.get(clientId)).toBe('waiting');
    expect(dealBoard.leads.size).toBe(0);
  });
});

describe('the seller’s home and the nudge', () => {
  it('the home counts a waiting lead chat, and drops it once read on the phone', async () => {
    // The app's own day, never UTC's (R5 — a test's clock must be the app's).
    const today = tashkentDay();
    const count = async (leadChats: boolean) =>
      (await salesFlowCounts(seller, today, { leadChats })).waitingChats;
    // Before/after, never an absolute: other files' chats are in this count.
    const before = await count(true);
    const beforeClientsOnly = await count(false);
    const id = await lead({ owner: seller });
    const { peer } = await say({ leadId: id });
    expect(await count(true)).toBe(before + 1);
    // The list and the home say the same thing (#513): a person whose list
    // carries no lead rows gets none in their count either.
    expect(await count(false)).toBe(beforeClientsOnly);

    await recordChatRead({ managerUserId: seller, peerId: peer, maxTgMessageId: 7n });
    expect(await count(true)).toBe(before);
  });

  it('the nudge names the lead after 30 minutes, links its card, and stops once marked or read', async () => {
    const id = await lead({ owner: seller });
    const msg = await say({ leadId: id, at: ago(45) });
    const mine = (await unansweredChats(30)).find((chat) => chat.messageId === msg.id);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe('lead');
    expect(mine!.leadId).toBe(id);
    expect(mine!.openable).toBe(true);
    const text = unansweredText(mine!, 'https://gsr.example');
    expect(text).toContain(`Lid: ${MARK} lid`);
    expect(text.trim().split('\n').at(-1)).toBe(`https://gsr.example/crm/leads/${id}#tg-thread`);

    // Once per silence: the sweep stamps the message it reported.
    await db.update(tgMessages).set({ remindedAt: new Date() }).where(eq(tgMessages.id, msg.id));
    expect((await unansweredChats(30)).some((chat) => chat.messageId === msg.id)).toBe(false);

    // A fresh silence on another lead, read on the phone before 30 minutes
    // pass: nothing to say.
    const other = await lead({ owner: seller });
    const read = await say({ leadId: other, at: ago(45) });
    await recordChatRead({ managerUserId: seller, peerId: read.peer, maxTgMessageId: 7n });
    expect((await unansweredChats(30)).some((chat) => chat.messageId === read.id)).toBe(false);
  });

  it('rings only an account whose screens carry lead chats (crm.leads) — one rule for all three', async () => {
    // The VED pressed «Yangi lid» on their own tray: `leadForChat` made them
    // the owner of a lead no screen of theirs lists and whose card sends
    // them away. The list and the home count leave it out for them, and so
    // does the nudge (the review's fourth finding).
    const id = await lead({ owner: ved });
    const msg = await say({ leadId: id, manager: ved });
    expect((await unansweredChats(30)).some((chat) => chat.messageId === msg.id)).toBe(false);
  });

  it('a chat on someone else’s lead is shown without a door, naming whose lead it is', async () => {
    // `leadForChat` reuses ANY open lead with the number, whoever owns it: the
    // chat is on the seller's phone, the lead is the boss's, and the seller's
    // card link would bounce (the design judge's first finding).
    const id = await lead({ owner: boss });
    const msg = await say({ leadId: id });

    const row = (await sellerList()).find((r) => r.leadId === id)!;
    expect(row.href).toBeNull();
    expect(row.leadOwner).toBe(bossName);

    const mine = (await unansweredChats(30)).find((chat) => chat.messageId === msg.id)!;
    expect(mine.openable).toBe(false);
    const text = unansweredText(mine, 'https://gsr.example');
    expect(text).not.toContain('https://');
    expect(text).toContain(bossName);
  });
});

describe('no burst of old alarms', () => {
  it('a lead chat from before the watch began stays on the list, quietly', async () => {
    const id = await lead({ owner: seller });
    const old = await say({
      leadId: id,
      at: new Date(LEAD_CHAT_ALARMS_FROM.getTime() - 86_400_000),
    });
    const row = (await sellerList()).find((r) => r.leadId === id)!;
    expect(row).toBeDefined();
    expect(row.waitingOnUs).toBe(false);
    expect((await unansweredChats(30)).some((chat) => chat.messageId === old.id)).toBe(false);
    expect((await chatBadges({ id: seller }, { leadIds: [id] })).leads.get(id)).toBe('yes');
  });

  it('a lost lead is settled — until the person writes again after it closed', async () => {
    const closedAt = ago(120);
    const settled = await lead({ owner: seller, stage: 'lost', closedAt });
    const before = await say({ leadId: settled, at: ago(180) });
    expect((await unansweredChats(30)).some((chat) => chat.messageId === before.id)).toBe(false);
    expect((await sellerList()).find((r) => r.leadId === settled)!.waitingOnUs).toBe(false);

    const again = await lead({ owner: seller, stage: 'lost', closedAt });
    const after = await say({ leadId: again, at: ago(60) });
    expect((await unansweredChats(30)).some((chat) => chat.messageId === after.id)).toBe(true);
    expect((await sellerList()).find((r) => r.leadId === again)!.waitingOnUs).toBe(true);
  });
});

describe('the resolver over a page of nothing but leads', () => {
  it('answers without asking the outbox about nobody', async () => {
    const id = await lead({ owner: seller });
    const seeds = Array.from({ length: 3 }, (_, n) => ({
      clientId: null,
      leadId: id,
      managerUserId: seller,
      peerId: nextPeer(),
      tgMessageId: BigInt(n + 1),
      direction: 'in',
      sentAt: ago(40),
    }));
    const states = await resolveChatStates(seeds);
    expect(states.size).toBe(3);
    expect([...states.values()].every((state) => state === 'new')).toBe(true);
  });
});
