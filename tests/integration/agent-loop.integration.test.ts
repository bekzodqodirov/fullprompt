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
  clientTelegramLinks,
  kbFacts,
  leads,
  notifications,
  roles,
  tgAccounts,
  tgChatRules,
  tgMessages,
  tgPeerIndex,
  tgPeerPulls,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import {
  agentCardFor,
  agentCommand,
  agentPress,
  agentText,
  PRICE_DRAFTED,
  PRICE_PROMPT,
  priceRefusalText,
} from '@/modules/wms/agent/bot-door';
import { announceAgentCalc, priceDraftFromText } from '@/modules/wms/agent/calc-loop';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { chatIdentity } from '@/modules/wms/agent/context';
import { strangerCards } from '@/modules/wms/agent/jobs';
import { purgeAgentChat, PURGED_CARD_TEXT } from '@/modules/wms/agent/purge';
import { decideChat, openLeadForChat } from '@/modules/wms/crm/chat-rules';
import { phoneFingerprint } from '@/modules/wms/crm/peer-index';

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
let siblingClientId = '';
let snapshot: AgentConfig | null = null;
const requestIds: string[] = [];
const leadIds: string[] = [];
/** Drafts whose 📌 may write a GENERAL fact — read in every chat, so swept by draft in afterAll (#183). */
const generalDraftIds: string[] = [];
let msgSeq = 5000n;
/** Laylo's card phone — the one number that PROVES the chat (his Q19 ⭐). */
const CARD_PHONE = `+99897${SUFFIX}66`;
/** A phone only the sibling's card carries (fit-12). */
const SIBLING_ONLY_PHONE = `+99897${SUFFIX}88`;

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

const textOf = (n: { payload: unknown }) => String((n.payload as Record<string, unknown>).text ?? '');

async function strangerRule(phone: string | null = '+998901112233', title = 'Notanish'): Promise<string> {
  const [r] = await db
    .insert(tgChatRules)
    .values({ managerUserId: ownerId, peerId: PEER, peerTitle: title, peerPhone: phone })
    .returning({ id: tgChatRules.id });
  return r!.id;
}

/** An inbound message the listener stored onto `client` — what chatIdentity reads the bind from. */
async function storedInbound(client: string, peer = PEER): Promise<void> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId: client,
    managerUserId: ownerId,
    peerId: peer,
    tgMessageId: msgSeq,
    direction: 'in',
    body: 'Yukim qayerda?',
    sentAt: new Date(),
  });
}

/** The echo flow to its ✅: code typed, the card's own ✅ pressed. */
async function confirmCode(ruleId: string, code: string): Promise<void> {
  await agentText(ownerId, { kind: 'agent_code', payload: { ruleId } }, code);
  const echo = (await ownerCards('AgentCodeEcho')).find((n) => (n.payload as { live?: boolean }).live !== false)!;
  const yes = buttonsFor('AgentCodeEcho', echo.payload as Record<string, unknown>)!.flat()[0]!;
  const parsed = parseCallback('callback_data' in yes ? yes.callback_data : '') as { digest?: string };
  expect((await agentPress(ownerId, 'c', ruleId, parsed.digest)).toast).toContain('Bog');
}

async function ruleOf(ruleId: string) {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  return rule!;
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
    await db.delete(tgMessages).where(and(eq(tgMessages.managerUserId, ownerId), eq(tgMessages.peerId, peer)));
    await db.delete(tgPeerIndex).where(and(eq(tgPeerIndex.managerUserId, ownerId), eq(tgPeerIndex.peerId, peer)));
    await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.telegramChatId, peer));
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
  // Laylo's second code: one person, two cards, one shared phone (fit-12).
  const [c3] = await db
    .insert(clients)
    .values({ clientCode: `AN${SUFFIX}`, name: `Laylo Ikkinchi ${SUFFIX}`, phones: [CARD_PHONE, SIBLING_ONLY_PHONE], salesManagerId: ownerId })
    .returning({ id: clients.id });
  siblingClientId = c3!.id;
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: ownerId, sessionExclusiveAt: new Date(), sessionExclusiveBy: ownerId, startedAt: new Date() })
    .where(eq(agentConfig.id, 1));
});

beforeEach(clearChat);

afterAll(async () => {
  await clearChat();
  await db.delete(kbFacts).where(sql`${kbFacts.sourceRef}->>'suffix' = ${SUFFIX} OR ${kbFacts.clientId} = ${clientId}`);
  if (generalDraftIds.length > 0) await db.delete(kbFacts).where(inArray(sql`${kbFacts.sourceRef}->>'draftId'`, generalDraftIds));
  if (requestIds.length > 0) await db.delete(calcRequests).where(inArray(calcRequests.id, [...requestIds].reverse()));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  if (leadIds.length > 0) await db.delete(leads).where(inArray(leads.id, leadIds));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId, siblingClientId]));
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
    // The hand-back's run is a queued job (regression-3) — stood in for here,
    // so nothing is left on the shared queue for the e2e server to pick up.
    const sent: string[] = [];
    expect(await announceAgentCalc(id, 'returned', { reason: 'Kod yetishmaydi' }, { enqueue: async (name) => void sent.push(name) })).toBe(true);
    expect(sent).toEqual(['agent.hand_back']);
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
    // The yes is the QUESTION's own button, carrying the arm's token (I3).
    const yes = first.buttons!.flat()[0]!;
    const parsed = parseCallback(yes.callback_data) as { op: string; id: string; digest?: string };
    expect(parsed).toMatchObject({ kind: 'agent', op: 'g', id });
    const second = await agentPress(ownerId, 'g', id, parsed.digest);
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
    expect(await purgeAgentChat(ownerId, PEER)).toMatchObject({ drafts: 1 });
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

describe('a hand-made bind serves no cargo until the chat proves it (his Q19 ⭐, review I1)', () => {
  it('a chat the listener matched by phone (no rule at all) is proven by construction', async () => {
    await storedInbound(clientId);
    const id = await chatIdentity(ownerId, PEER);
    expect(id).toMatchObject({ clientId, strength: 'phone', cargoAllowed: true });
  });

  it('(A) «↩ Yo‘q» after ✅ takes the RULE back too — not only the conversation', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    await storedInbound(clientId);
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'include', clientId });
    // The ↩ of the card that was confirmed — a press that raced the card's close.
    const back = await agentPress(ownerId, 'b', ruleId, clientId.slice(-8));
    expect(back.toast).toContain('Bekor');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'pending', clientId: null });
    const [conv] = await db.select().from(agentConversations).where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, PEER)));
    expect(conv).toMatchObject({ identityClientId: null, identityStrength: null });
    // The message the rule stored keeps its client_id — and it is nobody's
    // identity any more: no knowledge scope, no name, no deal to land on (I7).
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ clientId: null, leadId: null, strength: null, codes: [], customerName: null });
  });

  it('the echo card is closed after ✅: no ✅, no ↩ — its verdict instead', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const [echo] = await ownerCards('AgentCodeEcho');
    const payload = echo!.payload as Record<string, unknown>;
    expect(payload.live).toBe(false);
    expect(String(payload.text)).toContain('Tasdiqlandi');
    expect(buttonsFor('AgentCodeEcho', payload)).toBeNull();
  });

  it('the stranger card is closed by the decision too — a late 🆕 on it is not a second answer', async () => {
    const ruleId = await strangerRule();
    await strangerCards(ownerId, new Date());
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const [card] = (await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId);
    expect((card!.payload as Record<string, unknown>).live).toBe(false);
    expect(buttonsFor('AgentStranger', card!.payload as Record<string, unknown>)).toBeNull();
  });

  it('(B) a second code withdraws the first one’s include — no stale bind stays', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    await storedInbound(clientId);
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId } }, `AM${SUFFIX}`);
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'pending', clientId: null });
    const [conv] = await db.select().from(agentConversations).where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, PEER)));
    expect(conv).toMatchObject({ identityClientId: otherClientId, identityStrength: null });
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ clientId: null, codes: [], cargoAllowed: false });
    // The first echo card lost its buttons; only the newest one is live — and a
    // closed copy the drain had not sent yet is never sent.
    const echoes = await ownerCards('AgentCodeEcho');
    const live = echoes.filter((n) => (n.payload as { live?: boolean }).live !== false);
    expect(live.map((n) => (n.payload as { clientId: string }).clientId)).toEqual([otherClientId]);
    expect(echoes.find((n) => (n.payload as { clientId: string }).clientId === clientId)!.status).toBe('muted');
  });

  it('(C) the web tray’s «Bu mijoz» on a chat whose phone is not on the card serves nothing', async () => {
    const ruleId = await strangerRule('+998901112233');
    await decideChat({ id: ruleId, decision: 'include', clientId }, { actorId: ownerId });
    await storedInbound(clientId);
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ clientId, strength: 'rule', cargoAllowed: false });
  });

  it('a rule bind IS proven by the chat’s phone on the card — or on a phone sibling’s card', async () => {
    const own = await strangerRule(CARD_PHONE);
    await decideChat({ id: own, decision: 'include', clientId }, { actorId: ownerId });
    await storedInbound(clientId);
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ strength: 'rule', cargoAllowed: true });
    await clearChat();
    const sib = await strangerRule(SIBLING_ONLY_PHONE);
    await decideChat({ id: sib, decision: 'include', clientId }, { actorId: ownerId });
    await storedInbound(clientId);
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ cargoAllowed: true });
  });

  it('…by the listener’s hashed peer index (a lookback attach stores no number)', async () => {
    const [rule] = await db
      .insert(tgChatRules)
      .values({ managerUserId: ownerId, peerId: PEER, decision: 'include', clientId, decidedBy: ownerId, decidedAt: new Date() })
      .returning({ id: tgChatRules.id });
    await storedInbound(clientId);
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ cargoAllowed: false });
    await db.insert(tgPeerIndex).values({ managerUserId: ownerId, peerId: PEER, phoneHash: phoneFingerprint(CARD_PHONE)! });
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ cargoAllowed: true });
    expect(rule).toBeDefined();
  });

  it('…and by the customer’s own linked cabinet — a hidden number’s only way', async () => {
    const ruleId = await strangerRule(null);
    await confirmCode(ruleId, `AL${SUFFIX}`);
    await storedInbound(clientId);
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ strength: 'typed_code', cargoAllowed: false });
    await db.insert(clientTelegramLinks).values({ clientId, telegramChatId: PEER, status: 'linked', linkedAt: new Date() });
    expect(await chatIdentity(ownerId, PEER)).toMatchObject({ strength: 'typed_code', cargoAllowed: true });
  });

  it('the echo card says what the bind will allow, before he confirms', async () => {
    const hidden = await strangerRule(null);
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId: hidden } }, `AL${SUFFIX}`);
    expect(textOf((await ownerCards('AgentCodeEcho'))[0]!)).toContain('📵 Chat raqami yashirin');
    await clearChat();
    const onCard = await strangerRule(CARD_PHONE);
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId: onCard } }, `AL${SUFFIX}`);
    expect(textOf((await ownerCards('AgentCodeEcho'))[0]!)).toContain('✔ Chat raqami kartada');
    await clearChat();
    const off = await strangerRule('+998901112233');
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId: off } }, `AL${SUFFIX}`);
    expect(textOf((await ownerCards('AgentCodeEcho'))[0]!)).toContain("kartada yo'q");
  });

  it('a ✅ from before a web-tray decision does not undo it', async () => {
    const ruleId = await strangerRule();
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId } }, `AL${SUFFIX}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await decideChat({ id: ruleId, decision: 'exclude' }, { actorId: ownerId });
    const refused = await agentPress(ownerId, 'c', ruleId, clientId.slice(-8));
    expect(refused.toast).toContain('hal qilingan');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'exclude' });
  });

  it('a late «🆕 Yangi lid» never turns a client’s chat into a lead', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const out = await agentPress(ownerId, 'n', ruleId, undefined);
    expect(out.reply).toContain('allaqachon');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'include', clientId, leadId: null });
  });
});

describe('the «📵» card: a hidden-number first contact (his Q18 ⭐, review fit-7)', () => {
  it('one card per peer, in its own words, never the message text', async () => {
    const ruleId = await strangerRule(null, `Yashirin ${SUFFIX}`);
    expect(await strangerCards(ownerId, new Date())).toBeGreaterThanOrEqual(1);
    const cards = (await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId);
    expect(cards).toHaveLength(1);
    expect(textOf(cards[0]!)).toContain(`📵 Raqami yashirin yangi odam yozdi: Yashirin ${SUFFIX}`);
    const rows = buttonsFor('AgentStranger', cards[0]!.payload as Record<string, unknown>)!;
    expect(rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([`ag:n:${ruleId}`, `ag:k:${ruleId}`, `ag:x:${ruleId}`]);
    await strangerCards(ownerId, new Date());
    expect((await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId)).toHaveLength(1);
  });

  it('a peer in his own contacts gets no card — a friend is not a lead', async () => {
    const ruleId = await strangerRule(null, `Do'st ${SUFFIX}`);
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, peerContact: true });
    await strangerCards(ownerId, new Date());
    expect((await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId)).toHaveLength(0);
  });

  it('«🆕 Yangi lid» opens a lead BY NAME through the agent door only — and never twice', async () => {
    const ruleId = await strangerRule(null, `Yashirin Lid ${SUFFIX}`);
    // The tray's own door keeps its refusal.
    await expect(openLeadForChat(ruleId, { actorId: ownerId })).rejects.toThrow('chat_no_phone');
    const first = await agentPress(ownerId, 'n', ruleId, undefined);
    expect(first.toast).toContain('Lid ochildi');
    const rule = await ruleOf(ruleId);
    expect(rule).toMatchObject({ decision: 'include', clientId: null });
    leadIds.push(rule.leadId!);
    const [lead] = await db.select().from(leads).where(eq(leads.id, rule.leadId!));
    expect(lead).toMatchObject({ name: `Yashirin Lid ${SUFFIX}`, phone: null, ownerId });
    // A redelivered press finds the rule's own lead.
    await agentPress(ownerId, 'n', ruleId, undefined);
    expect((await ruleOf(ruleId)).leadId).toBe(rule.leadId);
    expect(await db.select().from(leads).where(eq(leads.name, `Yashirin Lid ${SUFFIX}`))).toHaveLength(1);
  });
});

describe('a general fact refuses every name the chat is known by (review I3)', () => {
  async function leadAnswered(finalBody: string) {
    const [stage] = await db.execute<{ id: string }>(sql`SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`);
    const [lead] = await db
      .insert(leads)
      .values({ name: `Shahzod Aliyev ${SUFFIX}`, stageId: stage!.id, ownerId })
      .returning({ id: leads.id });
    leadIds.push(lead!.id);
    const [d] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        leadId: lead!.id,
        anchorTgMessageId: 1n,
        proposedBody: 'Tekshirib aytaman.',
        finalBody,
        needsOwner: true,
        ownerQuestion: 'Ombor yakshanba ishlaydimi?',
        status: 'approved',
        decidedBy: ownerId,
        decidedAt: new Date(),
        policy: { suffix: SUFFIX },
      })
      .returning({ id: agentDrafts.id });
    return d!.id;
  }

  async function generalAttempt(id: string) {
    const first = await agentPress(ownerId, 'g', id, undefined);
    const digest = (parseCallback(first.buttons!.flat()[0]!.callback_data) as { digest?: string }).digest;
    return agentPress(ownerId, 'g', id, digest);
  }

  it('a lead chat’s first name alone is refused («Shahzod aka» for «Shahzod Aliyev»)', async () => {
    const id = await leadAnswered('Shahzod aka, yakshanba ombor dam oladi.');
    expect((await generalAttempt(id)).reply).toContain("mijoz ma'lumoti bor");
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${id}`)).toHaveLength(0);
  });

  it('a client’s first name alone, and the peer’s own Telegram title, are refused', async () => {
    const [d] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        anchorTgMessageId: 1n,
        proposedBody: 'x',
        finalBody: 'Laylo opa, yakshanba ombor dam oladi.',
        needsOwner: true,
        status: 'approved',
        decidedBy: ownerId,
        decidedAt: new Date(),
        policy: { suffix: SUFFIX },
      })
      .returning({ id: agentDrafts.id });
    expect((await generalAttempt(d!.id)).reply).toContain("mijoz ma'lumoti bor");
    await strangerRule(null, 'Dilnoza Tursunova');
    const [d2] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        clientId: otherClientId,
        anchorTgMessageId: 2n,
        proposedBody: 'x',
        finalBody: 'Dilnoza, yakshanba ombor dam oladi.',
        needsOwner: true,
        status: 'approved',
        decidedBy: ownerId,
        decidedAt: new Date(),
        policy: { suffix: SUFFIX },
      })
      .returning({ id: agentDrafts.id });
    expect((await generalAttempt(d2!.id)).reply).toContain("mijoz ma'lumoti bor");
  });

  it('two presses on the CARD — a redelivery, or two taps into a bot that was down — only ask', async () => {
    const id = await leadAnswered('Yakshanba ombor dam oladi, dushanbadan ishlaydi.');
    const one = await agentPress(ownerId, 'g', id, undefined);
    const two = await agentPress(ownerId, 'g', id, undefined);
    expect(one.reply).toContain('BARCHA');
    expect(two.reply).toContain('BARCHA');
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${id}`)).toHaveLength(0);
    // Both questions carry the SAME token: either one's yes is the yes.
    expect(two.buttons).toEqual(one.buttons);
    // A forged token is no yes either.
    expect((await agentPress(ownerId, 'g', id, '00000000')).reply).toContain('BARCHA');
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${id}`)).toHaveLength(0);
  });
});

describe('the purge blanks EVERY agent card of the chat (review I5)', () => {
  async function card(type: string, payload: Record<string, unknown>, status = 'sent') {
    const [n] = await db
      .insert(notifications)
      .values({ userId: ownerId, channel: 'telegram', type, status, payload: { text: `Mijoz: «yukim qayerda» ${SUFFIX}`, ...payload } })
      .returning({ id: notifications.id });
    return n!.id;
  }

  it('stranger, echo, calc answer (the whole chain), notice — this chat’s only; an unsent copy is never sent', async () => {
    const ruleId = await strangerRule();
    const root = await request();
    await link(root);
    const child = await request(root);
    const ids = {
      stranger: await card('AgentStranger', { ruleId }),
      echo: await card('AgentCodeEcho', { ruleId, clientId }, 'pending'),
      root: await card('AgentCalcAnswered', { requestId: root, priceable: true }),
      child: await card('AgentCalcAnswered', { requestId: child, priceable: true, tg: { chatId: 990001, messageId: 4242 } }),
      notice: await card('AgentNotice', { peerId: String(PEER) }),
      otherNotice: await card('AgentNotice', { peerId: String(OTHER_PEER) }),
    };
    const out = await purgeAgentChat(ownerId, PEER);
    expect(out.cards).toBeGreaterThanOrEqual(5);
    const rows = await db.select().from(notifications).where(inArray(notifications.id, Object.values(ids)));
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const key of ['stranger', 'echo', 'root', 'child', 'notice'] as const) {
      const p = by.get(ids[key])!.payload as Record<string, unknown>;
      expect(p.text, key).toBe(PURGED_CARD_TEXT);
      expect(p.live, key).toBe(false);
    }
    expect(by.get(ids.echo)!.status).toBe('muted');
    expect(by.get(ids.stranger)!.status).toBe('sent');
    expect(String((by.get(ids.otherNotice)!.payload as Record<string, unknown>).text)).toContain('yukim qayerda');
    // A closed card draws no buttons when its copy is edited.
    expect(buttonsFor('AgentCodeEcho', by.get(ids.echo)!.payload as Record<string, unknown>)).toBeNull();
    expect(buttonsFor('AgentStranger', by.get(ids.stranger)!.payload as Record<string, unknown>)).toBeNull();
    // …and a calculation answer's «💵 Narx yozaman» is no door either: its
    // link went in the same transaction, a press would arm a wait that eats a text.
    for (const key of ['root', 'child'] as const) {
      const p = by.get(ids[key])!.payload as Record<string, unknown>;
      expect(p.priceable, key).toBe(false);
      expect(buttonsFor('AgentCalcAnswered', p), key).toBeNull();
    }
    expect(await agentCardFor(ownerId, 990001n, 4242)).toBeNull();
  });
});

describe('a late press on the stranger card is never a second decision (review I1)', () => {
  it('«🆕» after the web tray said «Shaxsiy»: no lead, no pull — and the card is closed', async () => {
    const ruleId = await strangerRule();
    await strangerCards(ownerId, new Date());
    await decideChat({ id: ruleId, decision: 'exclude' }, { actorId: ownerId });
    const out = await agentPress(ownerId, 'n', ruleId, undefined);
    expect(out.reply).toContain('shaxsiy');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'exclude', clientId: null, leadId: null });
    expect(await db.select().from(tgPeerPulls).where(eq(tgPeerPulls.peerId, PEER))).toHaveLength(0);
    const [card] = (await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId);
    expect(buttonsFor('AgentStranger', card!.payload as Record<string, unknown>)).toBeNull();
  });

  it('«🚫» after the web tray\'s «Bu mijoz» does not exclude the client\'s chat', async () => {
    const ruleId = await strangerRule();
    await decideChat({ id: ruleId, decision: 'include', clientId }, { actorId: ownerId });
    expect((await agentPress(ownerId, 'x', ruleId, undefined)).reply).toContain("mijozga bog'langan");
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'include', clientId });
  });

  it('a code typed AFTER a web «Shaxsiy» is echoed by nobody — the ✅ never comes', async () => {
    const ruleId = await strangerRule();
    // 👤 pressed while the chat was still in question…
    const ask = await agentPress(ownerId, 'k', ruleId, undefined);
    // …the web tray answers, and only then is the code typed.
    await decideChat({ id: ruleId, decision: 'exclude' }, { actorId: ownerId });
    expect(await agentText(ownerId, ask.arm!, `AL${SUFFIX}`)).toContain('shaxsiy');
    expect(await ownerCards('AgentCodeEcho')).toHaveLength(0);
    expect((await agentPress(ownerId, 'k', ruleId, undefined)).arm).toBeUndefined();
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'exclude', clientId: null });
  });

  it('an echo’s ✅ after a web «Shaxsiy» is refused even when the conversation was written since', async () => {
    const ruleId = await strangerRule();
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId } }, `AL${SUFFIX}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await decideChat({ id: ruleId, decision: 'exclude' }, { actorId: ownerId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Any agent write moves the conversation's clock past the web decision.
    await db.update(agentConversations).set({ updatedAt: new Date() }).where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, PEER)));
    expect((await agentPress(ownerId, 'c', ruleId, clientId.slice(-8))).toast).toContain('hal qilingan');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'exclude', clientId: null });
  });

  it('↩ after the web tray re-decided the SAME client is not the flow’s to undo', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await decideChat({ id: ruleId, decision: 'include', clientId }, { actorId: ownerId });
    expect((await agentPress(ownerId, 'b', ruleId, clientId.slice(-8))).toast).toContain('hal qilingan');
    expect(await ruleOf(ruleId)).toMatchObject({ decision: 'include', clientId });
  });
});

describe('↩ takes back the bind, and with it what was built on it (review I1, I7)', () => {
  it('a draft written under the withdrawn client expires — it can never be approved onto that client', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: 1n, proposedBody: 'Yukingiz Yiwuda.', status: 'pending' })
      .returning({ id: agentDrafts.id });
    await agentPress(ownerId, 'b', ruleId, clientId.slice(-8));
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d!.id));
    expect(after!.status).toBe('expired');
  });

  it('an approved reply still waiting to go is cancelled — it was written to the client he took back', async () => {
    const ruleId = await strangerRule();
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: 1n, proposedBody: 'Yukingiz Yiwuda.', status: 'approved', decidedBy: ownerId, decidedAt: new Date() })
      .returning({ id: agentDrafts.id });
    const [o] = await db
      .insert(agentOutbox)
      .values({
        draftId: d!.id,
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        body: 'Yukingiz Yiwuda.',
        randomId: BigInt(`9${SUFFIX}01`),
        answersTgMessageId: 1n,
        queuedBy: ownerId,
        nextStepAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: agentOutbox.id });
    await agentPress(ownerId, 'b', ruleId, clientId.slice(-8));
    const [row] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, o!.id));
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row!.lastError).toMatch(/^identity_changed/);
  });

  it('the chat left in question gets a live stranger card back — the ✅ had closed the first', async () => {
    const ruleId = await strangerRule();
    await strangerCards(ownerId, new Date());
    await confirmCode(ruleId, `AL${SUFFIX}`);
    const before = (await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === ruleId);
    expect(before.every((n) => buttonsFor('AgentStranger', n.payload as Record<string, unknown>) === null)).toBe(true);
    await agentPress(ownerId, 'b', ruleId, clientId.slice(-8));
    const live = (await ownerCards('AgentStranger')).filter(
      (n) => (n.payload as { ruleId: string }).ruleId === ruleId && buttonsFor('AgentStranger', n.payload as Record<string, unknown>) !== null,
    );
    expect(live).toHaveLength(1);
    expect(textOf(live[0]!)).toContain('qaytadan tanlang');
    // …and ↩ before any ✅ (the stranger card still live) sends no second one.
    await clearChat();
    const pendingRule = await strangerRule();
    await strangerCards(ownerId, new Date());
    await agentText(ownerId, { kind: 'agent_code', payload: { ruleId: pendingRule } }, `AL${SUFFIX}`);
    await agentPress(ownerId, 'b', pendingRule, clientId.slice(-8));
    expect((await ownerCards('AgentStranger')).filter((n) => (n.payload as { ruleId: string }).ruleId === pendingRule)).toHaveLength(1);
  });
});

describe('a «📵» lead with no title is named by a placeholder, not a person (review I3)', () => {
  it('a general fact with «Telegram» in it is not refused as the lead’s name', async () => {
    const ruleId = await strangerRule(null, '');
    await agentPress(ownerId, 'n', ruleId, undefined);
    const rule = await ruleOf(ruleId);
    leadIds.push(rule.leadId!);
    const [d] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        leadId: rule.leadId!,
        anchorTgMessageId: 3n,
        proposedBody: 'x',
        finalBody: "Raqamingizni yuboring, Telegram orqali ham yozsa bo'ladi.",
        needsOwner: true,
        status: 'approved',
        decidedBy: ownerId,
        decidedAt: new Date(),
        policy: { suffix: SUFFIX },
      })
      .returning({ id: agentDrafts.id });
    generalDraftIds.push(d!.id);
    const first = await agentPress(ownerId, 'g', d!.id, undefined);
    const digest = (parseCallback(first.buttons!.flat()[0]!.callback_data) as { digest?: string }).digest;
    expect((await agentPress(ownerId, 'g', d!.id, digest)).toast).toContain('saqlandi');
    const facts = await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${d!.id}`);
    expect(facts).toHaveLength(1);
    await db.delete(kbFacts).where(eq(kbFacts.id, facts[0]!.id));
  });
});

describe('«💵 Narx yozaman» says what it does — his 6 b, nothing is recorded (answers review)', () => {
  it('the question and the answer speak of one sentence to the customer, never of an offer', async () => {
    const id = await request();
    await link(id);
    await storedInbound(clientId);
    const asked = await agentPress(ownerId, 'p', id, undefined);
    expect(asked.reply).toBe(PRICE_PROMPT);
    expect(asked.reply).toContain('bitim kartasiga hech narsa yozilmaydi');
    expect(asked.arm).toEqual({ kind: 'agent_price', payload: { requestId: id } });
    const answered = await agentText(ownerId, { kind: 'agent_price', payload: { requestId: id } }, '1250');
    expect(answered).toBe(PRICE_DRAFTED);
    // Neither sentence promises the offer the bot no longer writes.
    for (const words of [asked.reply!, answered!]) expect(words).not.toMatch(/taklif/iu);
  });

  it('each refusal has its own code and its own words — the editing reply, the two readings, no message to answer', async () => {
    const id = await request();
    await link(id);
    const price = { kind: 'agent_price' as const, payload: { requestId: id } };
    // No customer message stored in this chat: nothing to answer — and no price or answer is blamed.
    expect(await priceDraftFromText(ownerId, id, '1250')).toEqual({ ok: false, code: 'no_anchor' });
    const noAnchor = await agentText(ownerId, price, '1250');
    expect(noAnchor).toContain("javob beriladigan xabari yo'q");
    expect(noAnchor).not.toMatch(/narxi yoki javobi topilmadi/u);

    await storedInbound(clientId);
    expect(await priceDraftFromText(ownerId, id, '1.250')).toEqual({
      ok: false,
      code: 'ambiguous_number',
      readings: { thousands: 1250, decimal: '1,25' },
    });
    expect(await agentText(ownerId, price, '1.250')).toBe('«1.250» — 1250 dollarmi yoki 1,25 dollarmi? Aniq yozing: 1250 yoki 1,25');

    // His own reply to this chat is being typed: the price waits for it.
    const [own] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: msgSeq, proposedBody: 'x', status: 'editing' })
      .returning({ id: agentDrafts.id });
    expect(await priceDraftFromText(ownerId, id, '1250')).toEqual({ ok: false, code: 'editing_open' });
    expect(await agentText(ownerId, price, '1250')).toContain('siz yozayotgan javob bor');
    expect((await db.select().from(agentDrafts).where(eq(agentDrafts.peerId, PEER))).map((d) => d.id)).toEqual([own!.id]);

    // Five refusals, five sentences — none of them a raw code.
    const words = new Set(
      (['not_linked', 'not_account_holder', 'bad_number', 'editing_open', 'no_anchor'] as const).map((code) =>
        priceRefusalText({ ok: false, code }, 'x'),
      ),
    );
    expect(words.size).toBe(5);
    for (const w of words) expect(w).not.toMatch(/^[a-z_]+$/u);
  });
});
