import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  calcRequests,
  clients,
  kbFacts,
  notifications,
  roles,
  tgAccounts,
  tgChatRules,
  tgPeerPulls,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { agentCardFor, agentCommand, agentPress, agentText } from '@/modules/wms/agent/bot-door';
import { announceAgentCalc, priceDraftFromText } from '@/modules/wms/agent/calc-loop';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { purgeAgentChat } from '@/modules/wms/agent/purge';

/**
 * The AI sotuvchi's loops around the draft (spec §17.9-§17.11): the
 * calculation answer reaching the chat that asked, the stranger card's
 * buttons and the typed code's echo, the knowledge base's two presses, the
 * purge. agent_config is CONFIGURATION (#183) — snapshotted and restored.
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`78${SUFFIX}`);
const OTHER_PEER = BigInt(`79${SUFFIX}`);
let ownerId = '';
let otherId = '';
let sellerId = '';
let accountId = '';
let clientId = '';
let otherClientId = '';
let snapshot: AgentConfig | null = null;
const requestIds: string[] = [];

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function request(supersedes: string | null = null): Promise<string> {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType: 'deal',
      entityId: '00000000-0000-4000-8000-000000000136',
      requestedBy: ownerId,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
      supersedesRequestId: supersedes,
    })
    .returning({ id: calcRequests.id });
  requestIds.push(r!.id);
  return r!.id;
}

async function link(requestId: string, manager = ownerId, peer = PEER): Promise<void> {
  await db.insert(agentCalcLinks).values({ requestId, rootRequestId: requestId, managerUserId: manager, peerId: peer });
}

async function ownerCards(type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, type)));
}

async function strangerRule(phone: string | null = '+998901112233'): Promise<string> {
  const [r] = await db
    .insert(tgChatRules)
    .values({ managerUserId: ownerId, peerId: PEER, peerTitle: 'Notanish', peerPhone: phone })
    .returning({ id: tgChatRules.id });
  return r!.id;
}

async function clearChat() {
  for (const peer of [PEER, OTHER_PEER]) {
    await db.delete(agentCalcLinks).where(eq(agentCalcLinks.peerId, peer));
    await db.delete(agentOutbox).where(eq(agentOutbox.peerId, peer));
    await db.delete(agentDrafts).where(eq(agentDrafts.peerId, peer));
    await db.delete(agentRuns).where(eq(agentRuns.peerId, peer));
    await db.delete(agentConversations).where(eq(agentConversations.peerId, peer));
    await db.delete(tgPeerPulls).where(eq(tgPeerPulls.peerId, peer));
    await db.delete(tgChatRules).where(eq(tgChatRules.peerId, peer));
  }
  await db.delete(notifications).where(and(inArray(notifications.userId, [ownerId, otherId]), sql`${notifications.type} LIKE 'Agent%'`));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  ownerId = await makeUser(`AI egasi ${SUFFIX}`, 'super_admin', '01');
  otherId = await makeUser(`Ikkinchi menejer ${SUFFIX}`, 'super_admin', '02');
  sellerId = await makeUser(`Sotuvchi ${SUFFIX}`, 'sales_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99892${SUFFIX}11`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AL${SUFFIX}`, name: `Laylo Mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}66`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  const [c2] = await db
    .insert(clients)
    .values({ clientCode: `AM${SUFFIX}`, name: `Boshqa Mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}77`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  otherClientId = c2!.id;
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: ownerId, sessionExclusiveAt: new Date(), sessionExclusiveBy: ownerId, startedAt: new Date() })
    .where(eq(agentConfig.id, 1));
});

beforeEach(clearChat);

afterAll(async () => {
  await clearChat();
  await db.delete(kbFacts).where(sql`${kbFacts.sourceRef}->>'suffix' = ${SUFFIX} OR ${kbFacts.clientId} = ${clientId}`);
  if (requestIds.length > 0) await db.delete(calcRequests).where(inArray(calcRequests.id, [...requestIds].reverse()));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId]));
  await __restoreAgentConfig(snapshot);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, otherId, sellerId]));
});

describe('the calculation answer reaches the chat that asked (his 8)', () => {
  it('«Готово» on a linked request → the owner hears it with a 💵 door', async () => {
    const id = await request();
    await link(id);
    expect(await announceAgentCalc(id, 'done', { amountText: '1 250 $' })).toBe(true);
    const [card] = await ownerCards('AgentCalcAnswered');
    expect(card!.payload).toMatchObject({ requestId: id, priceable: true, event: 'done' });
    expect((card!.payload as { text: string }).text).toContain('1 250 $');
    const rows = buttonsFor('AgentCalcAnswered', card!.payload as Record<string, unknown>)!;
    expect(rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([`ag:p:${id}`]);
    const [l] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, id));
    expect(l!.lastNotifiedKind).toBe('done');
  });

  it('a correction is a new request — its answer still reaches the chat, through the chain root', async () => {
    const root = await request();
    await link(root);
    const child = await request(root);
    expect(await announceAgentCalc(child, 'sealed', { amountText: '900 $' })).toBe(true);
    const [card] = await ownerCards('AgentCalcAnswered');
    expect(card!.payload).toMatchObject({ requestId: child, priceable: true });
  });

  it('a hand-back is news without a price door', async () => {
    const id = await request();
    await link(id);
    expect(await announceAgentCalc(id, 'returned', { reason: 'Kod yetishmaydi' })).toBe(true);
    const [card] = await ownerCards('AgentCalcAnswered');
    expect(card!.payload).toMatchObject({ priceable: false });
    expect(buttonsFor('AgentCalcAnswered', card!.payload as Record<string, unknown>)).toBeNull();
  });

  it('a request the agent never sent, or a link from another account, says nothing', async () => {
    const lonely = await request();
    expect(await announceAgentCalc(lonely, 'done')).toBe(false);
    const foreign = await request();
    await link(foreign, otherId, OTHER_PEER);
    expect(await announceAgentCalc(foreign, 'done')).toBe(false);
    expect(await ownerCards('AgentCalcAnswered')).toHaveLength(0);
  });

  it('«💵 Narx yozaman» refuses in words before anything is written', async () => {
    const lonely = await request();
    expect(await priceDraftFromText(ownerId, lonely, '1250')).toEqual({ ok: false, code: 'not_linked' });
    const id = await request();
    await link(id);
    expect(await priceDraftFromText(otherId, id, '1250')).toEqual({ ok: false, code: 'not_account_holder' });
    expect(await priceDraftFromText(ownerId, id, "ko'p")).toEqual({ ok: false, code: 'bad_number' });
    expect(await priceDraftFromText(ownerId, id, '0')).toEqual({ ok: false, code: 'bad_number' });
    expect(await db.select().from(agentDrafts).where(eq(agentDrafts.peerId, PEER))).toHaveLength(0);
  });

  it('a swipe-reply to the answer card arms the price, by HIS OWN notification row', async () => {
    const id = await request();
    await link(id);
    await announceAgentCalc(id, 'done', { amountText: '1 000 $' });
    const [card] = await ownerCards('AgentCalcAnswered');
    await db
      .update(notifications)
      .set({ payload: sql`${notifications.payload} || ${JSON.stringify({ tg: { chatId: '555', messageId: 42 } })}::jsonb` })
      .where(eq(notifications.id, card!.id));
    expect(await agentCardFor(ownerId, 555n, 42)).toEqual({ kind: 'agent_price', payload: { requestId: id } });
    // Somebody else replying to a message with the same numbers resolves nothing.
    expect(await agentCardFor(otherId, 555n, 42)).toBeNull();
  });
});

describe('a stranger’s chat: a lead, a client by its code, or personal (§17.11)', () => {
  it('a typed code is ECHOED first; the echo card’s ✅ binds the chat and asks for a pull', async () => {
    const ruleId = await strangerRule();
    const ask = await agentPress(ownerId, 'k', ruleId, undefined);
    expect(ask.arm).toEqual({ kind: 'agent_code', payload: { ruleId } });

    expect(await agentText(ownerId, ask.arm!, 'GS 777')).toContain('bitta so‘z');
    expect(await agentText(ownerId, ask.arm!, `ZZ${SUFFIX}`)).toContain("bunday kod yo'q");
    expect(await ownerCards('AgentCodeEcho')).toHaveLength(0);

    expect(await agentText(ownerId, ask.arm!, `al${SUFFIX}`)).toContain('Tekshiring');
    const [echo] = await ownerCards('AgentCodeEcho');
    expect((echo!.payload as { text: string }).text).toContain(`AL${SUFFIX}`);
    expect((echo!.payload as { text: string }).text).toContain('+998901112233');
    const yes = buttonsFor('AgentCodeEcho', echo!.payload as Record<string, unknown>)!.flat()[0]!;
    const parsed = parseCallback('callback_data' in yes ? yes.callback_data : '');
    expect(parsed).toMatchObject({ kind: 'agent', op: 'c', id: ruleId });

    // Nothing is written by the echo alone.
    const [before] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(before!.decision).toBe('pending');

    const done = await agentPress(ownerId, 'c', ruleId, (parsed as { digest?: string }).digest);
    expect(done.toast).toContain('Bog');
    const [after] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(after).toMatchObject({ decision: 'include', clientId });
    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, PEER)));
    expect(conv).toMatchObject({ identityClientId: clientId, identityStrength: 'typed_code' });
    expect(await db.select().from(tgPeerPulls).where(eq(tgPeerPulls.peerId, PEER))).toHaveLength(1);
  });

  it('an OLDER echo card cannot confirm a code typed after it (leak-4)', async () => {
    const ruleId = await strangerRule();
    const arm = { kind: 'agent_code' as const, payload: { ruleId } };
    await agentText(ownerId, arm, `AL${SUFFIX}`);
    // Read by the code it echoed, never by position (an unordered read, 67b).
    const [first] = (await ownerCards('AgentCodeEcho')).filter((n) => (n.payload as { clientId?: string }).clientId === clientId);
    const firstYes = buttonsFor('AgentCodeEcho', first!.payload as Record<string, unknown>)!.flat()[0]!;
    const firstDigest = (parseCallback('callback_data' in firstYes ? firstYes.callback_data : '') as { digest?: string }).digest;
    await agentText(ownerId, arm, `AM${SUFFIX}`);

    const refused = await agentPress(ownerId, 'c', ruleId, firstDigest);
    expect(refused.toast).toContain('o‘zgargan');
    const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(rule!.decision).toBe('pending');
    // A press with no echo at all is refused too.
    expect((await agentPress(ownerId, 'c', ruleId, undefined)).toast).toContain('o‘zgargan');
  });

  it('only the account holder answers the card; «🚫 Shaxsiy» excludes the chat', async () => {
    const ruleId = await strangerRule();
    expect((await agentPress(otherId, 'x', ruleId, undefined)).toast).toBe('Topilmadi');
    expect((await agentText(otherId, { kind: 'agent_code', payload: { ruleId } }, `AL${SUFFIX}`))).toBe('Topilmadi.');
    await agentPress(ownerId, 'x', ruleId, undefined);
    const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
    expect(rule!.decision).toBe('exclude');
  });
});

describe('the knowledge base learns only what he approved (§17.8, leak-2)', () => {
  async function answered(finalBody: string, opts: { status?: string; needsOwner?: boolean } = {}) {
    const [d] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        anchorTgMessageId: 1n,
        proposedBody: 'Tekshirib aytaman.',
        finalBody,
        needsOwner: opts.needsOwner ?? true,
        ownerQuestion: 'Ombor yakshanba ishlaydimi?',
        status: opts.status ?? 'approved',
        decidedBy: opts.status === 'pending' ? null : ownerId,
        decidedAt: opts.status === 'pending' ? null : new Date(),
        policy: { suffix: SUFFIX },
      })
      .returning({ id: agentDrafts.id });
    return d!.id;
  }

  it('«📌 Umumiy qoida» needs a second press before a general fact is written', async () => {
    const id = await answered("Yakshanba ombor dam oladi, dushanbadan ishlaydi.");
    const first = await agentPress(ownerId, 'g', id, undefined);
    expect(first.reply).toContain('BARCHA');
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${id}`)).toHaveLength(0);
    const second = await agentPress(ownerId, 'g', id, undefined);
    expect(second.toast).toContain('saqlandi');
    const facts = await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${id}`);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ scope: 'general', clientId: null, approvedBy: ownerId });
    await db.delete(kbFacts).where(eq(kbFacts.id, facts[0]!.id));
    expect((await agentPress(ownerId, 'g', id, undefined)).toast).toBe('Allaqachon hal qilingan');
  });

  it('money never becomes knowledge; «👤 Faqat shu mijoz» scopes to the client', async () => {
    const money = await answered('Sizga 300 $ chegirma.');
    expect((await agentPress(ownerId, 'u', money, undefined)).reply).toContain('Narx bilimga yozilmaydi');
    const own = await answered("Sizning yukingiz har doim Yiwu omboridan jo'naydi.");
    await agentPress(ownerId, 'u', own, undefined);
    const [fact] = await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${own}`);
    expect(fact).toMatchObject({ scope: 'client', clientId });
  });

  it('a press on a draft the card never offered it for is refused', async () => {
    const pending = await answered('Yakshanba dam olamiz.', { status: 'pending' });
    expect((await agentPress(ownerId, 'u', pending, undefined)).toast).toBe('Topilmadi');
    await db.delete(agentDrafts).where(eq(agentDrafts.id, pending));
    const unasked = await answered('Yakshanba dam olamiz.', { needsOwner: false });
    expect((await agentPress(ownerId, 'u', unasked, undefined)).toast).toBe('Topilmadi');
    expect((await agentPress(otherId, 'u', unasked, undefined)).toast).toBe('Topilmadi');
    expect(await db.select().from(kbFacts).where(inArray(sql`${kbFacts.sourceRef}->>'draftId'`, [pending, unasked]))).toHaveLength(0);
  });
});

describe('the purge takes this chat and nothing else (§17.12)', () => {
  it('drafts, runs, links, pulls, the chat’s own facts — never another chat’s', async () => {
    const mk = async (peer: bigint) => {
      const [d] = await db
        .insert(agentDrafts)
        .values({ managerUserId: ownerId, peerId: peer, clientId, anchorTgMessageId: 1n, proposedBody: 'x', status: 'expired' })
        .returning({ id: agentDrafts.id });
      await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: peer });
      await db.insert(tgPeerPulls).values({ managerUserId: ownerId, peerId: peer, requestedBy: ownerId });
      const req = await request();
      await link(req, ownerId, peer);
      await db.insert(kbFacts).values({
        scope: 'client',
        clientId,
        answer: `fakt ${peer}`,
        source: 'owner',
        sourceRef: { draftId: d!.id, suffix: SUFFIX },
        approvedAt: new Date(),
        approvedBy: ownerId,
      });
      return d!.id;
    };
    const gone = await mk(PEER);
    const kept = await mk(OTHER_PEER);
    expect(await purgeAgentChat(ownerId, PEER)).toEqual({ drafts: 1 });
    expect(await db.select().from(agentDrafts).where(eq(agentDrafts.id, gone))).toHaveLength(0);
    expect(await db.select().from(agentDrafts).where(eq(agentDrafts.id, kept))).toHaveLength(1);
    expect(await db.select().from(agentConversations).where(eq(agentConversations.peerId, PEER))).toHaveLength(0);
    expect(await db.select().from(agentConversations).where(eq(agentConversations.peerId, OTHER_PEER))).toHaveLength(1);
    expect(await db.select().from(tgPeerPulls).where(eq(tgPeerPulls.peerId, PEER))).toHaveLength(0);
    expect(await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.peerId, PEER))).toHaveLength(0);
    expect(await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.peerId, OTHER_PEER))).toHaveLength(1);
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${gone}`)).toHaveLength(0);
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${kept}`)).toHaveLength(1);
  });
});

describe('«/agent» — the bot’s kill switch', () => {
  it('a seller cannot switch it; the owner switches it off and on', async () => {
    expect(await agentCommand(sellerId, 'off')).toContain('faqat AI egasi');
    expect((await readAgentConfig())!.mode).toBe('shadow');
    expect(await agentCommand(ownerId, 'off')).toContain("o'chirildi");
    expect((await readAgentConfig())!.mode).toBe('off');
    expect(await agentCommand(ownerId, '')).toContain("o'chiq");
    expect(await agentCommand(ownerId, 'on')).toContain('yoqildi');
    expect((await readAgentConfig())!.mode).toBe('shadow');
  });
});
