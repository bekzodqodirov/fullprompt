import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// What the listener hands pg-boss is recorded, not sent: nothing here works
// the queue, and a real job would wait for a worker on the shared database.
const queued = vi.hoisted(() => [] as { name: string; data: unknown; options: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async (name: string, data: unknown, options: unknown) => {
    queued.push({ name, data, options });
  },
}));

import { db } from '@/modules/platform/db/client';
import {
  agentConversations,
  auditLog,
  clients,
  leads,
  notifications,
  roles,
  tgChatRules,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { chatIdentity, type AgentContext } from '@/modules/wms/agent/context';
import { customerLabel } from '@/modules/wms/agent/drafts';
import { strangerCards } from '@/modules/wms/agent/jobs';
import { JOB_AGENT_INBOUND, shouldStartAgentRun } from '@/modules/wms/agent/queues';
import { leadForChat, ownerOfVerdict, phonelessLeadForChat } from '@/modules/wms/crm/chat-lead';
import { decideChat, openLeadForChat, rulesFor } from '@/modules/wms/crm/chat-rules';
import { storeIncoming } from '@/modules/wms/crm/telegram-accounts';
import { toMessageRow, type ChatRule, type DialogPeer, type RawMessage } from '@/modules/wms/crm/telegram-import';
import { decideIncoming } from '@/modules/wms/crm/telegram-live';
import { PHONELESS_LEAD_NAME } from '@/modules/wms/crm/unknown-chat';

/**
 * His «1 a» (2026-10-29): «Telegramda raqamini yashirgan odam yangi
 * raqamingizga yozsa … tizim uni avtomatik lid qilib ochadi va AI darhol
 * javob tayyorlaydi — bu raqam faqat mijozlar uchun».
 *
 * Driven through the functions the listener's live line runs, in its order —
 * `decideIncoming` → `ownerOfVerdict` → `storeIncoming` → the agent trigger
 * (`shouldStartAgentRun` → `enqueue`) — against a real database, because the
 * rule that matters is the do-not-mint-twice one and it lives in a lock.
 *
 * Rules and leads are CONFIGURATION for the listener (#183) and are deleted
 * by peer and by id in afterAll; the fixture manager is deactivated, never
 * deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
/** A peer id nobody else can mint: a clock is unique per millisecond only (chat-lead's lesson). */
const PEER_BASE = BigInt(Date.now()) * 1000n;
let peerSeq = 0;
const madePeers: bigint[] = [];
const nextPeer = () => {
  const p = PEER_BASE + BigInt((peerSeq += 1));
  madePeers.push(p);
  return p;
};
let msgSeq = 9000;
/** Every lead this file's lines minted, visible-number ones included. */
const madeLeads = new Set<string>();

let managerId = '';
let clientId = '';
const ctx = () => ({ actorId: managerId, ip: null, userAgent: null });

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99896${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

/** A private person whose number Telegram hides from this account. */
const hidden = (id: bigint, over: Partial<DialogPeer> = {}): DialogPeer => ({
  id,
  phone: null,
  firstName: `Yashirin ${SUFFIX}`,
  isPrivate: true,
  isBot: false,
  ...over,
});

const line = (over: Partial<RawMessage> = {}): RawMessage => ({
  id: (msgSeq += 1),
  message: 'Salom, Xitoydan yuk bormi?',
  date: Math.floor(Date.now() / 1000),
  ...over,
});

/**
 * The listener's live line, as `handleMessage` runs it on a WORK account:
 * decided, owned, stored, and — for a new row — handed to the agent the way
 * `afterStored` hands it (the AI speaks from this account, and is on).
 */
async function liveLine(peer: DialogPeer, msg: RawMessage, rules: Map<bigint, ChatRule> = new Map()) {
  const verdict = decideIncoming(peer, msg, [], rules, true);
  if (!verdict.store) return { verdict, owner: null, written: null, decision: null };
  const owner = await ownerOfVerdict(verdict, managerId, ctx());
  if (!owner) return { verdict, owner, written: null, decision: null };
  if (owner.leadId) madeLeads.add(owner.leadId);
  const written = await storeIncoming({ clientId: owner.clientId, leadId: owner.leadId, managerUserId: managerId, row: verdict.row });
  const decision = written
    ? shouldStartAgentRun({
        origin: 'live',
        direction: verdict.row.direction,
        accountManagerUserId: managerId,
        agentOwnerUserId: managerId,
        agentOn: true,
        stored: true,
      })
    : null;
  if (decision === 'run') {
    await enqueue(
      JOB_AGENT_INBOUND,
      { managerUserId: managerId, peerId: verdict.row.peerId.toString(), anchorTgMessageId: verdict.row.tgMessageId.toString(), origin: 'live' },
      { retryLimit: 0 },
    );
  }
  return { verdict, owner, written, decision };
}

async function ruleOf(peer: bigint) {
  const [r] = await db
    .select()
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, peer)));
  return r;
}

/** Leads minted on this manager's account for the hidden-number door. */
async function phonelessLeads() {
  return db
    .select({ id: leads.id, name: leads.name, phone: leads.phone, ownerId: leads.ownerId, note: leads.note })
    .from(leads)
    .where(and(eq(leads.ownerId, managerId), sql`${leads.phone} IS NULL`));
}

beforeAll(async () => {
  managerId = await makeUser(`Ish raqami ${SUFFIX}`, 'sales_manager', '01');
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `YP${SUFFIX}`, name: `Yashirin Mijoz ${SUFFIX}`, salesManagerId: managerId })
    .returning({ id: clients.id });
  clientId = c!.id;
});

afterAll(async () => {
  const made = [...new Set([...madeLeads, ...(await phonelessLeads()).map((l) => l.id)])];
  // Rules first: a leftover include changes what the listener stores (#183), and it points at a lead deleted below.
  await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, madePeers));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, madePeers));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, madePeers));
  await db.delete(notifications).where(eq(notifications.userId, managerId));
  if (made.length > 0) await db.delete(leads).where(inArray(leads.id, made));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, managerId));
});

describe('a hidden number writing to a WORK number becomes a lead the AI answers (R2, R3, R5)', () => {
  it('the first line opens ONE lead by the chat, keeps the line on it, and asks the AI for a draft — like a visible stranger', async () => {
    const peer = nextPeer();
    const first = await liveLine(hidden(peer), line());
    expect(first.verdict).toMatchObject({ store: true, openLead: true, peer: { peerId: peer, phone: null } });
    expect(first.owner).toMatchObject({ clientId: null, label: 'LID' });
    const leadId = first.owner!.leadId!;
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ name: `Yashirin ${SUFFIX}`, phone: null, ownerId: managerId });
    expect(lead!.note).toContain('ish raqamiga yozdi');
    // The line is on the lead.
    const [row] = await db.select().from(tgMessages).where(eq(tgMessages.id, first.written!));
    expect(row).toMatchObject({ leadId, clientId: null, peerId: peer, direction: 'in', body: 'Salom, Xitoydan yuk bormi?' });
    // The chat is bound to it by its tray rule — committed as include, never as a pending question.
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId, clientId: null, peerPhone: null, decidedBy: managerId });
    // …and the rule's change is audited with the door that made it.
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'tg_chat_rule'), eq(auditLog.entityId, (await ruleOf(peer))!.id)));
    expect(audit!.after).toMatchObject({ decision: 'include', leadId, reason: 'work_account_phoneless' });
    // The agent's trigger fires exactly as for a visible-number new lead.
    expect(first.decision).toBe('run');
    const visible = await liveLine(hidden(nextPeer(), { phone: `+99893${SUFFIX}77` }), line());
    expect(visible.verdict).toMatchObject({ store: true, openLead: true });
    expect(visible.decision).toBe(first.decision);
    const jobs = queued.filter((q) => q.name === JOB_AGENT_INBOUND && (q.data as { peerId: string }).peerId === peer.toString());
    expect(jobs).toHaveLength(1);
    if (!first.verdict.store) throw new Error('unreachable');
    expect(jobs[0]!.data).toMatchObject({
      managerUserId: managerId,
      anchorTgMessageId: first.verdict.row.tgMessageId.toString(),
      origin: 'live',
    });
  });

  it('the burst’s next line, a reconnect’s catch-up and a later line all land on the SAME lead', async () => {
    const peer = nextPeer();
    const before = (await phonelessLeads()).length;
    const first = await liveLine(hidden(peer), line());
    const leadId = first.owner!.leadId!;
    // The listener's in-memory rules are minutes old: the next line of the burst decides with none —
    // and a chat already bound costs it one read, not a transaction (it asks on every line for ten minutes).
    const tx = vi.spyOn(db, 'transaction');
    const second = await liveLine(hidden(peer), line({ message: 'Narxi qancha?' }));
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
    expect(second.verdict).toMatchObject({ openLead: true });
    expect(second.owner!.leadId).toBe(leadId);
    // Catch-up after a restart reads fresh rules: the chat's rule IS its lead.
    const fresh = await rulesFor(managerId);
    const caught = await liveLine(hidden(peer), line({ message: 'Javob bering' }), fresh);
    expect(caught.verdict).toMatchObject({ store: true, leadId });
    // A week later, renamed in Telegram: still the same chat, the same lead.
    const later = await liveLine(hidden(peer, { firstName: 'Boshqa ism' }), line({ message: 'Yana men' }));
    expect(later.owner!.leadId).toBe(leadId);
    expect((await phonelessLeads()).length - before).toBe(1);
    const rows = await db.select({ leadId: tgMessages.leadId }).from(tgMessages).where(eq(tgMessages.peerId, peer));
    expect(rows.map((r) => r.leadId)).toEqual([leadId, leadId, leadId, leadId]);
  });

  it('two lines decided at the same moment mint ONE lead — the chat’s rule row is the lock', async () => {
    // Over a pending row an earlier personal-mode «📵» card left: no INSERT to
    // wait on, so only the lock can keep the second line from minting too.
    // Made deterministic rather than raced: a third transaction holds the row
    // while both lines arrive, and lets go only once BOTH are waiting on it —
    // with the lock they wait at the read and the second finds the first's
    // lead; without it they read «pending» together and each mints its own.
    const peer = nextPeer();
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerTitle: 'Eski karta', peerPhone: null });
    const before = (await phonelessLeads()).length;
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.select().from(tgChatRules).where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, peer))).for('update');
      held();
      await released;
    });
    await holding;
    const lines = [
      leadForChat(managerId, { peerId: peer, phone: null, title: 'Bir vaqtda' }, ctx()),
      leadForChat(managerId, { peerId: peer, phone: null, title: 'Bir vaqtda' }, ctx()),
    ];
    // Both waiting on the row — counted through the pool, outside any transaction (a snapshot inside one freezes).
    for (let i = 0; i < 200; i += 1) {
      const [w] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%tg_chat_rules%'`);
      if ((w?.n ?? 0) >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await holder;
    const both = await Promise.all(lines);
    expect(new Set(both).size).toBe(1);
    expect((await phonelessLeads()).length - before).toBe(1);
    expect((await ruleOf(peer))!.leadId).toBe(both[0]);
  });

  it('…and over no row at all, three at once still mint one', async () => {
    const peer = nextPeer();
    const before = (await phonelessLeads()).length;
    const all = await Promise.all([1, 2, 3].map(() => leadForChat(managerId, { peerId: peer, phone: null, title: 'Bir vaqtda' }, ctx())));
    expect(new Set(all).size).toBe(1);
    expect((await phonelessLeads()).length - before).toBe(1);
  });

  it('serves no cargo or money — the chat proves no number — and the card names it «Lid: <name>»', async () => {
    const peer = nextPeer();
    const first = await liveLine(hidden(peer), line());
    const identity = await chatIdentity(managerId, peer);
    expect(identity).toMatchObject({
      clientId: null,
      leadId: first.owner!.leadId,
      strength: 'lead',
      cargoAllowed: false,
      customerName: `Yashirin ${SUFFIX}`,
    });
    expect(customerLabel({ identity } as unknown as AgentContext)).toBe(`Lid: Yashirin ${SUFFIX}`);
    // Won onto a client later, the fence still holds: a bind a person made is not proof (I1).
    await db.update(tgMessages).set({ clientId }).where(eq(tgMessages.peerId, peer));
    await db.update(leads).set({ clientId }).where(eq(leads.id, first.owner!.leadId!));
    expect(await chatIdentity(managerId, peer)).toMatchObject({ clientId, cargoAllowed: false });
  });

  it('a nameless person is named by words — never by the chat id', async () => {
    const peer = nextPeer();
    const first = await liveLine(hidden(peer, { firstName: null, lastName: null, username: null }), line());
    expect(first.verdict).toMatchObject({ peer: { title: `#${peer}` } });
    const [lead] = await db.select({ name: leads.name }).from(leads).where(eq(leads.id, first.owner!.leadId!));
    expect(lead!.name).toBe(PHONELESS_LEAD_NAME);
    const withHandle = await liveLine(hidden(nextPeer(), { firstName: null, username: 'yuk_kerak' }), line());
    const [handled] = await db.select({ name: leads.name }).from(leads).where(eq(leads.id, withHandle.owner!.leadId!));
    expect(handled!.name).toBe('@yuk_kerak');
  });
});

describe('a person’s answer on the tray outranks the machine (R2)', () => {
  it('«hech qachon» written since the listener read its rules: nothing is minted and the rule stands', async () => {
    const peer = nextPeer();
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'exclude', peerPhone: null });
    const before = (await phonelessLeads()).length;
    // The listener's map is stale (empty) — the verdict still says «open a lead»…
    const out = await liveLine(hidden(peer), line());
    expect(out.verdict).toMatchObject({ openLead: true });
    // …and the door under the lock says no.
    expect(out.owner).toBeNull();
    expect(out.written).toBeNull();
    expect((await phonelessLeads()).length).toBe(before);
    expect(await ruleOf(peer)).toMatchObject({ decision: 'exclude', leadId: null });
  });

  it('a chat bound to a client since then is not taken off that client', async () => {
    const peer = nextPeer();
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'include', clientId, peerPhone: null });
    expect(await leadForChat(managerId, { peerId: peer, phone: null, title: 'X' }, ctx())).toBeNull();
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', clientId, leadId: null });
  });

  it('a ↩ on the tray takes the rule back to «pending» — the next line finds the lead the chat’s rows are on', async () => {
    const peer = nextPeer();
    const first = await liveLine(hidden(peer), line());
    const leadId = first.owner!.leadId!;
    const rule = (await ruleOf(peer))!;
    await decideChat({ id: rule.id, decision: 'pending' }, ctx());
    expect(await ruleOf(peer)).toMatchObject({ decision: 'pending', leadId: null });
    const before = (await phonelessLeads()).length;
    const next = await liveLine(hidden(peer), line({ message: 'Yana savol' }));
    expect(next.owner!.leadId).toBe(leadId);
    expect((await phonelessLeads()).length).toBe(before);
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId });
  });
});

describe('a CLIENT whose number Telegram has since hidden is still that client (R2)', () => {
  it('the line goes on the client the chat was kept on — no lead, no rule that would outrank the phone for good', async () => {
    const peer = nextPeer();
    // Kept by the phone classifier, the day the number still showed: rows on the client, no rule.
    await storeIncoming({
      clientId,
      managerUserId: managerId,
      row: toMessageRow(peer, line({ date: Math.floor(Date.now() / 1000) - 86_400 })),
    });
    const before = (await phonelessLeads()).length;
    const now = await liveLine(hidden(peer), line({ message: 'Raqamimni yashirdim' }));
    expect(now.verdict).toMatchObject({ openLead: true });
    expect(now.owner).toEqual({ clientId, leadId: null, label: `YP${SUFFIX}` });
    expect((await phonelessLeads()).length).toBe(before);
    expect(await ruleOf(peer)).toBeUndefined();
    // …and the door itself refuses to mint over it when asked directly.
    expect(await leadForChat(managerId, { peerId: peer, phone: null, title: 'X' }, ctx())).toBeNull();
    expect(await ruleOf(peer)).toBeUndefined();
  });
});

describe('no «📵» card for a work number’s hidden-number chat any more (R4)', () => {
  it('the card sweep finds no question about it — even over the pending row an old card left', async () => {
    const peer = nextPeer();
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerTitle: 'Eski savol', peerPhone: null });
    await liveLine(hidden(peer), line());
    const rule = (await ruleOf(peer))!;
    expect(rule.decision).toBe('include');
    await strangerCards(managerId, new Date());
    const cards = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, managerId), eq(notifications.type, 'AgentStranger'), sql`${notifications.payload}->>'ruleId' = ${rule.id}`));
    expect(cards).toHaveLength(0);
  });

  it('on a PERSONAL account the same line is stored nowhere and opens nothing', async () => {
    const peer = nextPeer();
    expect(decideIncoming(hidden(peer), line(), [], new Map(), false)).toEqual({ store: false, reason: 'no_phone' });
    expect(await ruleOf(peer)).toBeUndefined();
  });
});

describe('the «📵» card’s own door shares the minting (R2)', () => {
  it('«🆕 Yangi lid» opens the lead through the same transaction and finds it again on a second press', async () => {
    const peer = nextPeer();
    const [r] = await db
      .insert(tgChatRules)
      .values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerTitle: `Karta ${SUFFIX}`, peerPhone: null })
      .returning({ id: tgChatRules.id });
    const { leadId } = await openLeadForChat(r!.id, ctx(), { phoneless: 'agent_stranger' });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ name: `Karta ${SUFFIX}`, phone: null, ownerId: managerId });
    expect(lead!.note).toContain('«📵» kartasidan');
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'tg_chat_rule'), eq(auditLog.entityId, r!.id)));
    expect(audit!.after).toMatchObject({ reason: 'agent_stranger_phoneless', leadId });
    expect(await phonelessLeadForChat({ managerUserId: managerId, peerId: peer, title: null, via: 'agent_stranger' }, ctx())).toBe(leadId);
  });
});
