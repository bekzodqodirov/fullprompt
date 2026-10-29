import 'dotenv/config';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A card, a lead event or an alarm kicks a drain through pg-boss; the ROWS are what is asserted.
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db } from '@/modules/platform/db/client';
import {
  agentConversations,
  clients,
  crmActivities,
  leadAssignments,
  leadIntakes,
  leadStages,
  leads,
  notifications,
  roles,
  tgAccounts,
  tgChatRules,
  tgMessages,
  tgPeerPulls,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { agentPress, agentText } from '@/modules/wms/agent/bot-door';
import { strangerCards } from '@/modules/wms/agent/jobs';
import { noteStranger } from '@/modules/wms/agent/listener-hooks';
import {
  keptClientOfChat,
  ownerOfVerdict,
  phonelessLeadForChat,
  retireMachineBinding,
  settlePassedChat,
  STRANGER_CARD_BOUND,
} from '@/modules/wms/crm/chat-lead';
import { listCandidates, officialPeerSql, openLeadForChat, recordCandidates, rulesFor } from '@/modules/wms/crm/chat-rules';
import { landSiteTag } from '@/modules/wms/crm/site-assign';
import { storeIncoming } from '@/modules/wms/crm/telegram-accounts';
import {
  isTelegramOfficialPeer,
  toMessageRow,
  type ClientPhones,
  type DialogPeer,
  type RawMessage,
} from '@/modules/wms/crm/telegram-import';
import { decideIncoming, keptOnLead } from '@/modules/wms/crm/telegram-live';

/**
 * The listener's own lead binding (his «1 a», a hidden number on a work
 * number) as the 2026-10-29 review of the merged branch found it, against a
 * real database:
 *
 *  - 0 (the blocker): round 113's website rule has the SAME shape — include,
 *    a lead, no client, no `decided_by` — so «machine» had to become a mark
 *    of its own (0139 `bound_via`), written by the work-number door alone;
 *  - 2/19: the switch decides about NEW strangers only — a chat the work
 *    number kept stays on its open lead after «Shaxsiy raqam», by its rule
 *    (hidden) or its rows (visible), and a closed lead's chat is asked about
 *    afresh instead of falling into a hole;
 *  - 1/18: the binding closes the «📵» card a personal number posted, and a
 *    press on its chat is still a person's answer that wins;
 *  - 9: Telegram's own accounts are neither listed on the tray nor carded.
 *
 * The listener is a gramjs closure no test can import: `listenerLine`
 * restates its live line in its order (decide → settle a passed line → own →
 * store, or the tray/card notes), and tests/unit/chat-rule-bound-via.test.ts
 * pins that the listener runs exactly that order. Rules and leads are
 * CONFIGURATION for the listener (#183) and go in afterAll; fixture people
 * are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER_BASE = BigInt(Date.now()) * 1000n + 7n;
let peerSeq = 0;
const madePeers: bigint[] = [];
const nextPeer = () => {
  const p = PEER_BASE + BigInt((peerSeq += 1) * 3);
  madePeers.push(p);
  return p;
};
let msgSeq = 5000;
let nextTag = 0;
const siteTag = () => `GSR-M${SUFFIX}${String((nextTag += 1)).padStart(2, '0')}`;

let managerId = '';
let clientId = '';
let clientCode = '';
const ctx = () => ({ actorId: managerId, ip: null, userAgent: null });

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

async function setWork(work: boolean) {
  await db.update(tgAccounts).set({ workAccount: work }).where(eq(tgAccounts.managerUserId, managerId));
}

/**
 * The listener's live line (tg-listen `handleMessage`), on fresh rules: decided;
 * a line the switch passed over settled (`settlePassedChat`); stored on its owner,
 * or — not kept — the tray question and the «📵» card's note, as `strangerSeen` asks
 * them on the agent owner's account.
 */
async function listenerLine(peer: DialogPeer, msg: RawMessage, opts: { work: boolean; book?: ClientPhones[] }) {
  const rules = await rulesFor(managerId);
  let verdict = decideIncoming(peer, msg, opts.book ?? [], rules, opts.work);
  let reopened = false;
  if (!verdict.store && ('ask' in verdict || verdict.reason === 'no_phone')) {
    const settled = await settlePassedChat(managerId, peer.id, rules.get(peer.id), ctx());
    reopened = settled.reopened;
    if (settled.leadId) verdict = keptOnLead(peer, msg, settled.leadId);
  }
  if (!verdict.store) {
    const user = { contact: false, deleted: false };
    if ('ask' in verdict) {
      await recordCandidates(managerId, [{ peerId: verdict.peerId, title: verdict.title, phone: verdict.phone }]);
      await noteStranger({ managerUserId: managerId, peerId: peer.id, title: verdict.title, verdict: 'ask', user, reopened });
    } else if (verdict.reason === 'no_phone') {
      await noteStranger({ managerUserId: managerId, peerId: peer.id, title: 'Yashirin', verdict: 'no_phone', user, reopened });
    }
    return { verdict, owner: null, written: null, reopened };
  }
  const owner = await ownerOfVerdict(verdict, managerId, ctx());
  if (!owner) return { verdict, owner, written: null, reopened };
  const written = await storeIncoming({ clientId: owner.clientId, leadId: owner.leadId, managerUserId: managerId, row: verdict.row });
  return { verdict, owner, written, reopened };
}

async function ruleOf(peer: bigint) {
  const [r] = await db
    .select()
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, peer)));
  return r;
}

/** The SQL-only 0139 mark, read bare — this file is allowed to (the fence names it). */
async function markOf(peer: bigint): Promise<string | null | undefined> {
  const rows = await db.execute<{ bound_via: string | null }>(sql`
    SELECT bound_via FROM tg_chat_rules WHERE manager_user_id = ${managerId}::uuid AND peer_id = ${peer.toString()}::bigint`);
  return rows[0] ? rows[0].bound_via : undefined;
}

async function rowsOf(peer: bigint) {
  return db
    .select({ id: tgMessages.id, leadId: tgMessages.leadId, clientId: tgMessages.clientId })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.peerId, peer)));
}

async function cards(ruleId: string, type = 'AgentStranger') {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, managerId), eq(notifications.type, type), sql`${notifications.payload}->>'ruleId' = ${ruleId}`));
}
const live = (n: { payload: unknown }) => (n.payload as { live?: unknown }).live !== false;
const textOf = (n: { payload: unknown }) => String((n.payload as { text?: unknown }).text ?? '');

async function closeLead(leadId: string, kind: 'won' | 'lost') {
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, kind)).limit(1);
  await db.update(leads).set({ stageId: stage!.id }).where(eq(leads.id, leadId));
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${SUFFIX}71`, fullName: `Mashina bog'lash ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  managerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: managerId, roleId: role!.id });
  await db.insert(tgAccounts).values({
    managerUserId: managerId,
    tgPhone: `+99891${SUFFIX}71`,
    sessionEnc: 'v1.x.y.z',
    status: 'active',
    workAccount: false,
  });
  clientCode = `MB${SUFFIX}`;
  const [c] = await db
    .insert(clients)
    .values({ clientCode, name: `Mashina mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}71`], salesManagerId: managerId })
    .returning({ id: clients.id });
  clientId = c!.id;
});

afterAll(async () => {
  const peers = [...madePeers, 489000n];
  await db.delete(tgChatRules).where(eq(tgChatRules.managerUserId, managerId));
  await db.delete(tgMessages).where(eq(tgMessages.managerUserId, managerId));
  await db.delete(agentConversations).where(and(eq(agentConversations.managerUserId, managerId), inArray(agentConversations.peerId, peers)));
  await db.delete(tgPeerPulls).where(eq(tgPeerPulls.managerUserId, managerId));
  await db.delete(notifications).where(eq(notifications.userId, managerId));
  await db
    .delete(leadAssignments)
    .where(or(eq(leadAssignments.userId, managerId), eq(leadAssignments.confirmedUserId, managerId)));
  await db.delete(leadIntakes).where(like(leadIntakes.externalId, `GSR-M${SUFFIX}%`));
  const made = (await db.select({ id: leads.id }).from(leads).where(eq(leads.ownerId, managerId))).map((l) => l.id);
  if (made.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, made));
    await db.delete(leads).where(inArray(leads.id, made));
  }
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(tgAccounts).where(eq(tgAccounts.managerUserId, managerId));
  await db.update(users).set({ active: false }).where(eq(users.id, managerId));
});

describe('0 — a website visitor’s rule is the website’s answer, never the listener’s guess (the blocker)', () => {
  it('a real `landSiteTag` rule: on a PERSONAL number its later hidden and visible lines are stored on the site lead, and no machine door touches it', async () => {
    await setWork(false);
    const tag = siteTag();
    await db.insert(leadAssignments).values({ tag, team: 'cargo', userId: managerId, username: `mb${SUFFIX}`, capturable: true });
    const peer = nextPeer();
    const landed = await landSiteTag({
      managerUserId: managerId,
      tag,
      peer: { id: peer, phone: null, title: `Sayt mehmon ${SUFFIX}`, username: null },
      text: `Salom ${tag}, 20 kub yuk bor`,
      wroteBefore: async () => false,
    });
    expect(landed).toMatchObject({ landed: true, outcome: 'created', clientId: null });
    const siteLead = (landed as { leadId: string }).leadId;
    // Exactly the shape the first cut read as «nobody's»…
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId: siteLead, clientId: null, decidedBy: null });
    // …and no mark: only the work-number door writes one.
    expect(await markOf(peer)).toBeNull();
    const rules = await rulesFor(managerId);
    expect(rules.get(peer)).toMatchObject({ machine: false, leadId: siteLead });

    // The visitor's next lines on a personal number — hidden, and with a number nobody's book has.
    const later = await listenerLine(hidden(peer), line({ message: 'Narxi qancha?' }), { work: false });
    expect(later.owner).toMatchObject({ leadId: siteLead, clientId: null });
    expect(later.written).not.toBeNull();
    const shown = await listenerLine(hidden(peer, { phone: `+99893${SUFFIX}79` }), line({ message: 'Raqamim ko‘rinadi' }), { work: false });
    expect(shown.owner).toMatchObject({ leadId: siteLead });
    // The phone book claiming the number does not take a door's answer back: the line stays on the
    // site lead, as it did before the listener's binding existed — no retire, the rule stands.
    const book = [{ id: clientId, clientCode, phones: [`+99897${SUFFIX}71`] }];
    const claimed = decideIncoming(hidden(peer, { phone: `+99897${SUFFIX}71` }), line(), book, await rulesFor(managerId), false);
    expect(claimed).toMatchObject({ store: true, leadId: siteLead });
    expect(claimed).not.toHaveProperty('retiresMachineRule');

    // No machine door takes it: retire (either reason), the client-by-rows look-up, the minting.
    expect(await retireMachineBinding(managerId, peer, ctx())).toBe(false);
    await closeLead(siteLead, 'lost');
    expect(await retireMachineBinding(managerId, peer, ctx(), 'lead_closed')).toBe(false);
    await storeIncoming({ clientId, managerUserId: managerId, row: toMessageRow(peer, line({ message: 'mijoz qatori' })) });
    expect(await keptClientOfChat(managerId, peer)).toBeNull();
    expect(await phonelessLeadForChat({ managerUserId: managerId, peerId: peer, title: null, via: 'work_account' }, ctx())).toBeNull();
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId: siteLead, clientId: null, decidedBy: null });
    expect(await markOf(peer)).toBeNull();
  });
});

describe('2/19 — the switch governs NEW strangers only', () => {
  it('a hidden chat the work number bound stays on its OPEN lead after «Shaxsiy raqam» — hidden lines and shown ones', async () => {
    await setWork(true);
    const peer = nextPeer();
    const first = await listenerLine(hidden(peer), line(), { work: true });
    const leadId = first.owner!.leadId!;
    expect(await markOf(peer)).toBe('work_account');
    expect((await rulesFor(managerId)).get(peer)).toMatchObject({ machine: true, leadOpen: true });

    await setWork(false);
    const back = await listenerLine(hidden(peer), line({ message: 'Hali yozyapman' }), { work: false });
    expect(back.owner).toMatchObject({ leadId, clientId: null });
    expect(back.written).not.toBeNull();
    const shown = await listenerLine(hidden(peer, { phone: `+99893${SUFFIX}81` }), line({ message: 'Raqam' }), { work: false });
    expect(shown.owner).toMatchObject({ leadId });
    expect((await rowsOf(peer)).every((r) => r.leadId === leadId)).toBe(true);
    // Nothing turned it into a question: no tray row, no card.
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId });
  });

  it('a VISIBLE chat a work number kept on its lead (rows, no rule) stays there too — a fresh stranger is still asked', async () => {
    await setWork(true);
    const peer = nextPeer();
    const phone = `+99893${SUFFIX}82`;
    const first = await listenerLine(hidden(peer, { phone }), line(), { work: true });
    const leadId = first.owner!.leadId!;
    expect(await ruleOf(peer)).toBeUndefined();

    await setWork(false);
    const back = await listenerLine(hidden(peer, { phone }), line({ message: 'Yana' }), { work: false });
    expect(back.verdict).toMatchObject({ store: true, leadId });
    expect(back.written).not.toBeNull();
    expect(await ruleOf(peer)).toBeUndefined();

    // The control: a stranger nobody kept is the tray's question, as on every personal number.
    const fresh = nextPeer();
    const asked = await listenerLine(hidden(fresh, { phone: `+99893${SUFFIX}83` }), line(), { work: false });
    expect(asked.verdict).toMatchObject({ store: false, ask: true });
    expect(await ruleOf(fresh)).toMatchObject({ decision: 'pending' });
    expect(await rowsOf(fresh)).toHaveLength(0);
  });

  it('a person’s answer outranks the rows: a ↩ or «never» on the kept chat is not overridden', async () => {
    await setWork(true);
    const peer = nextPeer();
    const phone = `+99893${SUFFIX}84`;
    await listenerLine(hidden(peer, { phone }), line(), { work: true });
    await setWork(false);
    await db.insert(tgChatRules).values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerPhone: phone, decidedBy: managerId });
    const out = await listenerLine(hidden(peer, { phone }), line({ message: 'Yana' }), { work: false });
    expect(out.verdict).toMatchObject({ store: false, ask: true });
    expect(await rowsOf(peer)).toHaveLength(1);
  });

  it('a CLOSED lead’s chat on a personal number is a new stranger again: the binding is retired and the «📵» card asks once more', async () => {
    await setWork(true);
    const peer = nextPeer();
    const first = await listenerLine(hidden(peer), line(), { work: true });
    const leadId = first.owner!.leadId!;
    const ruleId = (await ruleOf(peer))!.id;
    // A card was claimed for this person before (the personal number asked once, then the switch went to work).
    await db
      .insert(agentConversations)
      .values({ managerUserId: managerId, peerId: peer, strangerCardAt: new Date(Date.now() - 3_600_000) })
      .onConflictDoUpdate({
        target: [agentConversations.managerUserId, agentConversations.peerId],
        set: { strangerCardAt: new Date(Date.now() - 3_600_000) },
      });
    await closeLead(leadId, 'lost');
    await setWork(false);

    const out = await listenerLine(hidden(peer), line({ message: 'Yana yuk bor' }), { work: false });
    expect(out.verdict).toEqual({ store: false, reason: 'no_phone' });
    expect(out.reopened).toBe(true);
    // The binding is gone (audited «lead_closed»); a fresh question stands in its place.
    const fresh = (await ruleOf(peer))!;
    expect(fresh.id).not.toBe(ruleId);
    expect(fresh).toMatchObject({ decision: 'pending', leadId: null, decidedBy: null });
    expect(await markOf(peer)).toBeNull();
    // …which the tray lists and the sweep cards — the claim the old card spent was given back.
    expect((await listCandidates({ managerUserId: managerId, decision: 'pending' })).some((r) => r.id === fresh.id)).toBe(true);
    await strangerCards(managerId, new Date());
    expect(await cards(fresh.id)).toHaveLength(1);
    // Nothing of the line was stored, and the lost lead keeps its own lines.
    expect((await rowsOf(peer)).every((r) => r.leadId === leadId)).toBe(true);
  });
});

describe('1/18 — the binding closes the card, and a press on its chat is still a person’s answer', () => {
  /** A hidden stranger asked about on a PERSONAL number, then the switch to «Ish raqami» and his next line. */
  async function carded() {
    await setWork(false);
    const peer = nextPeer();
    const asked = await listenerLine(hidden(peer), line(), { work: false });
    expect(asked.verdict).toEqual({ store: false, reason: 'no_phone' });
    const ruleId = (await ruleOf(peer))!.id;
    await strangerCards(managerId, new Date());
    const [card] = await cards(ruleId);
    expect(card && live(card)).toBe(true);
    await setWork(true);
    const bound = await listenerLine(hidden(peer), line({ message: 'Yuk bor' }), { work: true });
    return { peer, ruleId, leadId: bound.owner!.leadId! };
  }

  it('the work number’s binding closes the live «📵» card — its question is answered', async () => {
    const { peer, ruleId, leadId } = await carded();
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId, decidedBy: null });
    const [card] = await cards(ruleId);
    expect(live(card!)).toBe(false);
    expect(textOf(card!)).toContain(STRANGER_CARD_BOUND);
  });

  it('«🚫 Shaxsiy» on it excludes the chat and deletes what the listener stored', async () => {
    const { peer, ruleId } = await carded();
    expect((await rowsOf(peer)).length).toBeGreaterThan(0);
    const press = await agentPress(managerId, 'x', ruleId, undefined);
    expect(press.toast).toContain('Shaxsiy');
    expect(press.reply).toContain('o‘chirildi');
    expect(await ruleOf(peer)).toMatchObject({ decision: 'exclude', leadId: null, decidedBy: managerId });
    expect(await rowsOf(peer)).toHaveLength(0);
    expect(decideIncoming(hidden(peer), line(), [], await rulesFor(managerId), true)).toEqual({ store: false, reason: 'excluded' });
  });

  it('«👤 Mijoz — kod» on it re-points the chat to the client he typed', async () => {
    const { peer, ruleId } = await carded();
    const ask = await agentPress(managerId, 'k', ruleId, undefined);
    expect(ask.arm).toEqual({ kind: 'agent_code', payload: { ruleId } });
    expect((await agentText(managerId, ask.arm!, clientCode))?.text).toContain('Tekshiring');
    const echo = (await cards(ruleId, 'AgentCodeEcho')).find(live)!;
    const yes = buttonsFor('AgentCodeEcho', echo.payload as Record<string, unknown>)!.flat()[0]!;
    const parsed = parseCallback('callback_data' in yes ? yes.callback_data : '') as { digest?: string };
    expect((await agentPress(managerId, 'c', ruleId, parsed.digest)).toast).toContain('Bog');
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', clientId, leadId: null, decidedBy: managerId });
    const next = await listenerLine(hidden(peer), line({ message: 'Men mijozman' }), { work: true });
    expect(next.owner).toMatchObject({ clientId, leadId: null });
  });

  it('«🆕 Yangi lid» on it makes the binding his: the same lead, recorded as the person’s', async () => {
    const { peer, ruleId, leadId } = await carded();
    expect((await agentPress(managerId, 'n', ruleId, undefined)).toast).toContain('Lid ochildi');
    expect(await ruleOf(peer)).toMatchObject({ decision: 'include', leadId, decidedBy: managerId });
    expect(await markOf(peer)).toBeNull();
    expect((await rulesFor(managerId)).get(peer)).toMatchObject({ machine: false });
  });
});

describe('10 — a tray ↩ is a person’s answer, and a personal tray still opens no hidden lead', () => {
  it('a personal number’s tray refuses «Lid ochish» for a hidden number, as before', async () => {
    await setWork(false);
    const peer = nextPeer();
    const [r] = await db
      .insert(tgChatRules)
      .values({ managerUserId: managerId, peerId: peer, decision: 'pending', peerTitle: 'Tray', peerPhone: null })
      .returning({ id: tgChatRules.id });
    expect((await listCandidates({ managerUserId: managerId, decision: 'pending' })).find((x) => x.id === r!.id)).toMatchObject({
      workAccount: false,
    });
    await expect(openLeadForChat(r!.id, ctx())).rejects.toThrow('chat_no_phone');
  });
});

describe('9 — Telegram’s own accounts are neither on the tray nor carded', () => {
  it('the SQL twin answers exactly as the live predicate does', async () => {
    const ids = [777000n, 489000n, 1271266957n, 333000n, 1000n, 999000n, 1_000_000n, 2_000_000n, 5512345000n, 1500n, 42n, 1271266958n];
    const rows = await db.execute<{ id: string; official: boolean }>(sql`
      SELECT p.id::text AS id, ${officialPeerSql(sql`p.id`)} AS official
        FROM (VALUES ${sql.join(ids.map((id) => sql`(${id.toString()}::bigint)`), sql`, `)}) AS p(id)`);
    for (const id of ids) {
      const row = rows.find((r) => r.id === id.toString());
      expect(row?.official, String(id)).toBe(isTelegramOfficialPeer({ id, isPrivate: true }));
    }
  });

  it('«Verification Codes» left pending by an old card is not listed, not carded, and its card’s buttons answer in words', async () => {
    const [r] = await db
      .insert(tgChatRules)
      .values({ managerUserId: managerId, peerId: 489000n, decision: 'pending', peerTitle: 'Verification Codes', peerPhone: null })
      .returning({ id: tgChatRules.id });
    expect((await listCandidates({ managerUserId: managerId, decision: 'pending' })).some((x) => x.id === r!.id)).toBe(false);
    await strangerCards(managerId, new Date());
    expect(await cards(r!.id)).toHaveLength(0);
    // A card sent before the deploy: words, never a raw code — and «Shaxsiy» still works.
    const n = await agentPress(managerId, 'n', r!.id, undefined);
    expect(n.reply).toContain('Telegram');
    expect(n.reply).not.toContain('service_chat');
    expect((await agentPress(managerId, 'c', r!.id, 'deadbeef')).reply).toContain('Telegram');
    expect((await agentPress(managerId, 'x', r!.id, undefined)).toast).toContain('Shaxsiy');
    expect((await ruleOf(489000n))!.decision).toBe('exclude');
  });
});
