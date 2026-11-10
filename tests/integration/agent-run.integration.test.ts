import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  clients,
  kbFacts,
  notifications,
  roles,
  tgAccountGuard,
  tgAccounts,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft, submitOwnText } from '@/modules/wms/agent/decide';
import { agentSweep, retireOnHumanReply } from '@/modules/wms/agent/jobs';
import { handleInbound } from '@/modules/wms/agent/run';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * The AI sotuvchi's run and decision against a real database (spec §17.3,
 * §17.7). The model is SCRIPTED — CI has no key, and a scripted model is the
 * only way to drive the tool loop deterministically — so what this file
 * proves is everything around the model: the stand-downs, the gates, the
 * caps, the draft with its card, the decision and its refusals.
 *
 * agent_config is a singleton CONFIGURATION row on the one database every
 * file shares (#183): snapshotted in beforeAll and put back in afterAll. The
 * fixture users are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`77${SUFFIX}`);
let ownerId = '';
let otherId = '';
let accountId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let msgSeq = 1000n;

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function inbound(body: string, agoMs = 60_000): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: msgSeq,
    direction: 'in',
    body,
    sentAt: new Date(Date.now() - agoMs),
  });
  return msgSeq;
}

async function outbound(body: string): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: msgSeq,
    direction: 'out',
    body,
    sentAt: new Date(Date.now() - 30_000),
  });
  return msgSeq;
}

const job = (anchor: bigint) => ({
  managerUserId: ownerId,
  peerId: String(PEER),
  anchorTgMessageId: String(anchor),
  origin: 'live' as const,
});

/** A model that answers with the given tool calls, in order, ending in compose_reply. */
function scripted(steps: { name: string; input: Record<string, unknown> }[]): CallModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const fn = (async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel & { requests: ModelRequest[] };
  fn.requests = requests;
  return fn;
}

function compose(text: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'compose_reply',
    input: {
      reply_needed: true,
      reply_text: text,
      language: 'uz',
      gloss_uz: '',
      category: 'price',
      confidence: 0.8,
      needs_owner: false,
      owner_question: '',
      next_step: 'quote',
      actions: [],
      used_fact_ids: [],
      cited_message_refs: [],
      ...extra,
    },
  };
}

const actorOf = (id: string) => ({ id, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const ctx = () => ({ actorId: ownerId });

async function liveDraft() {
  const [d] = await db
    .select()
    .from(agentDrafts)
    .where(and(eq(agentDrafts.managerUserId, ownerId), eq(agentDrafts.peerId, PEER), inArray(agentDrafts.status, ['pending', 'editing'])));
  return d ?? null;
}

async function cardOf(draftId: string) {
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return row ?? null;
}

async function clearChat() {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), sql`${notifications.type} LIKE 'Agent%'`));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`AI egasi ${SUFFIX}`, 'super_admin', '01');
  otherId = await makeUser(`Boshqa admin ${SUFFIX}`, 'super_admin', '02');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99892${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AI${SUFFIX}`, name: `Aziz Mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}55`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: ownerId,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: ownerId,
      startedAt: new Date(Date.now() - 30 * 86_400_000),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
      humanPauseMin: 120,
    })
    .where(eq(agentConfig.id, 1));
  // The CRM's send switch is configuration too (outbox.integration's idiom).
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  await clearChat();
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  await clearChat();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, otherId]));
});

describe('a run drafts a reply and posts its card', () => {
  it('a yo’lkira question → the website figure → a draft with a ✅ that carries the digest', async () => {
    const anchor = await inbound("Assalomu alaykum, Yiwudan Toshkentga 5 kub 1000 kg yuk bor, yo'lkira qancha bo'ladi?");
    const model = scripted([
      { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
      compose("Assalomu alaykum! Yo'lkira taxminan 800 $ bo'ladi (5 kub, 1000 kg). Boj va QQS alohida hisoblanadi."),
    ]);
    const out = await handleInbound(job(anchor), { callModel: model });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    // The tool answered from the website's sheet AND agreed with /admin/tarif.
    // (The loop keeps ONE messages array, so read the tool result out of it.)
    const toolResult = model.requests[1]!.messages
      .flatMap((m) => m.content)
      .find((b): b is { type: 'tool_result'; tool_use_id: string; content: string } => b.type === 'tool_result');
    expect(toolResult?.content).toContain('800');

    const d = await liveDraft();
    expect(d?.status).toBe('pending');
    const card = await cardOf(d!.id);
    expect(card?.status).toBe('pending');
    const payload = card!.payload as Record<string, unknown>;
    expect(payload.text).toContain("Yo'lkira taxminan 800 $");
    expect(payload.text).toContain('Raqamlar');
    const rows = buttonsFor('AgentDraft', payload)!;
    const send = rows.flat().find((b) => 'callback_data' in b && b.callback_data.startsWith('ag:s:'));
    expect(send).toBeDefined();
    const parsed = parseCallback((send as { callback_data: string }).callback_data);
    expect(parsed).toMatchObject({ kind: 'agent', op: 's', id: d!.id });
    // Every button the card draws is one the parser takes (#939).
    for (const b of rows.flat()) if ('callback_data' in b) expect(parseCallback(b.callback_data)).not.toBeNull();
  });

  it('stands down when the anchor is no longer the newest inbound (the debounce)', async () => {
    const first = await inbound('5 kub yuk bor');
    await inbound('Yiwudan');
    const out = await handleInbound(job(first), { callModel: scripted([compose('x')]) });
    expect(out).toEqual({ outcome: 'stood_down', reason: 'not_newest' });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER))).toHaveLength(0);
  });

  it('a newer question supersedes the pending draft and RE-POINTS its card', async () => {
    const a1 = await inbound('Yukim qayerda?');
    await handleInbound(job(a1), { callModel: scripted([compose('Tekshirib aytaman.')]) });
    const first = await liveDraft();
    const card = await cardOf(first!.id);
    const a2 = await inbound('Va qachon keladi?');
    await handleInbound(job(a2), { callModel: scripted([compose('Tekshirib yozaman.')]) });
    const second = await liveDraft();
    expect(second!.id).not.toBe(first!.id);
    const [old] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, first!.id));
    expect(old!.status).toBe('superseded');
    const [sameRow] = await db.select().from(notifications).where(eq(notifications.id, card!.id));
    expect((sameRow!.payload as { draftId: string }).draftId).toBe(second!.id);
  });

  it('a card written 23 minutes after the customer’s line says so, first, with the job’s own cause (C11)', async () => {
    const a = await inbound('Yukim qayerda?', 23 * 60_000);
    const out = await handleInbound({ ...job(a), origin: 'pull' }, { callModel: scripted([compose('Tekshirib aytaman.')]) });
    expect(out).toMatchObject({ outcome: 'draft' });
    const d = await liveDraft();
    // A pull follows an answer given at either door — the bot's card or the web tray — and names neither one's buttons.
    const late = '⏱ Mijoz 23 daqiqadan beri javob kutyapti (chat lid yoki mijoz deb belgilangandan keyin yozildi)';
    expect((d!.policy as { notes: string[] }).notes[0]).toBe(late);
    expect(((await cardOf(d!.id))!.payload as { text: string }).text).toContain(`ℹ️ ${late}`);
  });

  it('the wait is counted from the customer’s FIRST unanswered line, not the anchor (C11, the run’s own argument)', async () => {
    await inbound('Assalomu alaykum, yuk bor', 30 * 60_000);
    const a = await inbound('Yiwudan Toshkentga 5 kub, narxi qancha?', 5 * 60_000);
    await handleInbound({ ...job(a), origin: 'sweep' }, { callModel: scripted([compose('Tekshirib aytaman.')]) });
    const d = await liveDraft();
    expect((d!.policy as { notes: string[] }).notes[0]).toBe('⏱ Mijoz 30 daqiqadan beri javob kutyapti (AI qayta tekshirganda yozildi)');
  });

  it('…and a card on time carries no such line', async () => {
    const a = await inbound('Yukim qayerda?');
    await handleInbound({ ...job(a), origin: 'pull' }, { callModel: scripted([compose('Tekshirib aytaman.')]) });
    const d = await liveDraft();
    expect(((await cardOf(d!.id))!.payload as { text: string }).text).not.toContain('⏱');
  });

  it('a promise blocks ✅ — the card draws no send button', async () => {
    const a = await inbound('Chegirma bormi?');
    const out = await handleInbound(job(a), { callModel: scripted([compose('Albatta, sizga chegirma qilamiz.')]) });
    expect(out).toMatchObject({ outcome: 'draft', blocked: true });
    const d = await liveDraft();
    const payload = (await cardOf(d!.id))!.payload as Record<string, unknown>;
    expect(payload.text).toContain('chegirma');
    const rows = buttonsFor('AgentDraft', payload)!;
    expect(rows.flat().some((b) => 'callback_data' in b && b.callback_data.startsWith('ag:s:'))).toBe(false);
    const r = await decideDraft(actorOf(ownerId), d!.id, 'send', { digest: payload.digest as string }, ctx());
    expect(r).toMatchObject({ ok: false, code: 'policy_block' });
  });

  it('«siz botmisiz?» drafts nothing — a notice instead (his Q4 ⭐)', async () => {
    const a = await inbound('Siz botmisiz?');
    const model = scripted([compose('x')]);
    const out = await handleInbound(job(a), { callModel: model });
    expect(out).toMatchObject({ outcome: 'notice', reason: 'bot_question' });
    expect(model.requests).toHaveLength(0);
    const notices = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
    expect(notices).toHaveLength(1);
  });

  it('«rahmat» after our statement costs no run, and leaves a ledger row the sweep will not re-ask', async () => {
    await outbound('Yukingiz keldi.');
    const a = await inbound('rahmat', 10_000);
    const model = scripted([compose('x')]);
    const out = await handleInbound(job(a), { callModel: model });
    expect(out).toMatchObject({ outcome: 'skipped', reason: 'closing' });
    expect(model.requests).toHaveLength(0);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER));
    expect(runs.map((r) => r.outcome)).toEqual(['refused']);
  });

  it('a chat he answered himself within the pause is not drafted', async () => {
    await inbound('Salom', 5 * 60_000);
    await outbound('Ha, eshitaman');
    const a = await inbound('Yukim qachon keladi?', 5_000);
    const out = await handleInbound(job(a), { callModel: scripted([compose('x')]) });
    expect(out).toEqual({ outcome: 'refused', reason: 'human_active' });
  });

  it('a stale listener refuses the run (the reply would never be sent)', async () => {
    await db.update(tgAccountGuard).set({ agentPumpAt: new Date(Date.now() - 10 * 60_000) }).where(eq(tgAccountGuard.accountId, accountId));
    const a = await inbound('Yukim qayerda?');
    const out = await handleInbound(job(a), { callModel: scripted([compose('x')]) });
    expect(out).toEqual({ outcome: 'refused', reason: 'listener_behind' });
  });

  it('the day’s cap refuses before the model, once with a card', async () => {
    await db.update(agentConfig).set({ dailyDraftCap: 0 }).where(eq(agentConfig.id, 1));
    try {
      const a = await inbound('Yukim qayerda?');
      const model = scripted([compose('x')]);
      expect(await handleInbound(job(a), { callModel: model })).toMatchObject({ outcome: 'capped' });
      expect(model.requests).toHaveLength(0);
    } finally {
      await db.update(agentConfig).set({ dailyDraftCap: 150 }).where(eq(agentConfig.id, 1));
    }
  });
});

describe('his decision (one function for the bot and the web)', () => {
  async function drafted(text = 'Tekshirib aytaman.') {
    const a = await inbound('Yukim qayerda?');
    await handleInbound(job(a), { callModel: scripted([compose(text)]) });
    const d = await liveDraft();
    const payload = (await cardOf(d!.id))!.payload as { digest: string };
    return { d: d!, digest: payload.digest };
  }

  it('✅ by the holder writes the outbox row in the same step as «approved»', async () => {
    const { d, digest } = await drafted();
    const r = await decideDraft(actorOf(ownerId), d.id, 'send', { digest }, ctx());
    expect(r).toMatchObject({ ok: true, status: 'approved' });
    const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id));
    expect(o!.status).toBe('agent');
    expect(o!.randomId > 0n).toBe(true);
    expect(o!.queuedBy).toBe(ownerId);
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
    expect(after!.status).toBe('approved');
  });

  it('with the CRM’s send switch off ✅ is refused in words and nothing is queued', async () => {
    const { d, digest } = await drafted();
    await setSetting('tg_sending_enabled', false, ownerId);
    try {
      expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest }, ctx())).toEqual({ ok: false, code: 'sending_disabled' });
      expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id))).toHaveLength(0);
      const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
      expect(after!.status).toBe('pending');
    } finally {
      await setSetting('tg_sending_enabled', true, ownerId);
    }
  });

  it('only the account holder decides — a super_admin is refused (leak-5)', async () => {
    const { d, digest } = await drafted();
    const r = await decideDraft(actorOf(otherId), d.id, 'send', { digest }, { actorId: otherId });
    expect(r).toEqual({ ok: false, code: 'not_account_holder' });
  });

  it('a press on a card that changed is refused (leak-3)', async () => {
    const { d } = await drafted();
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: '00000000' }, ctx())).toEqual({
      ok: false,
      code: 'stale_card',
    });
  });

  it('his own reply after the anchor turns ✅ into «taken over»', async () => {
    const { d, digest } = await drafted();
    await outbound('Men o‘zim aytdim');
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest }, ctx())).toEqual({ ok: false, code: 'taken_over' });
  });

  it('✏️ his own words become the body and pass the owner subset', async () => {
    const { d } = await drafted();
    expect(await decideDraft(actorOf(ownerId), d.id, 'edit', {}, ctx())).toMatchObject({ ok: true, status: 'editing' });
    expect(await submitOwnText(actorOf(ownerId), d.id, 'Ertaga yetib keladi, 200$ chegirma bilan', ctx())).toMatchObject({ ok: true });
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
    expect(after!.finalBody).toContain('chegirma');
    expect(after!.blocked).toBe(false);
  });

  it('🙋 makes the chat his for 24 hours', async () => {
    const { d } = await drafted();
    expect(await decideDraft(actorOf(ownerId), d.id, 'human', {}, ctx())).toMatchObject({ ok: true, status: 'taken_over' });
    const [conv] = await db.select().from(agentConversations).where(eq(agentConversations.peerId, PEER));
    expect(conv!.humanUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('his phone reply retires the live draft; the agent’s own echo retires nothing', async () => {
    const { d } = await drafted();
    const out = await outbound('Ha');
    expect(await retireOnHumanReply(ownerId, PEER, out)).toBe(1);
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
    expect(after!.status).toBe('taken_over');
  });

  it('the sweep expires a draft whose anchor is older than 24 hours', async () => {
    const a = await inbound('Yukim qayerda?', 23 * 3_600_000);
    await handleInbound(job(a), { callModel: scripted([compose('Tekshiraman')]) });
    const d = await liveDraft();
    expect(d).not.toBeNull();
    await db.update(tgMessages).set({ sentAt: new Date(Date.now() - 25 * 3_600_000) }).where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.tgMessageId, a)));
    await agentSweep();
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d!.id));
    expect(after!.status).toBe('expired');
  });
});

describe('a chat whose bind it does not prove reads none of the client’s own facts (identity review B7)', () => {
  const marker = `Maxsus fakt ${SUFFIX}`;
  let factId = '';

  beforeAll(async () => {
    const [f] = await db
      .insert(kbFacts)
      .values({
        scope: 'client',
        clientId,
        question: marker,
        answer: `${marker}: yukni Andijondagi omborda oladi.`,
        source: 'owner',
        approvedAt: new Date(),
        approvedBy: ownerId,
      })
      .returning({ id: kbFacts.id });
    factId = f!.id;
  });

  afterAll(async () => {
    await db.delete(tgChatRules).where(and(eq(tgChatRules.managerUserId, ownerId), eq(tgChatRules.peerId, PEER)));
    await db.delete(kbFacts).where(eq(kbFacts.id, factId));
  });

  async function kbResult(): Promise<string> {
    const a = await inbound(`${marker} haqida ayting`);
    const model = scripted([{ name: 'kb_search', input: { query: marker } }, compose('Tekshirib aytaman.')]);
    expect(await handleInbound(job(a), { callModel: model })).toMatchObject({ outcome: 'draft' });
    const result = model.requests[1]!.messages
      .flatMap((m) => m.content)
      .find((b): b is { type: 'tool_result'; tool_use_id: string; content: string } => b.type === 'tool_result');
    return result!.content;
  }

  it('the listener’s own phone classification proves the chat: the client’s fact is served', async () => {
    expect(await kbResult()).toContain(marker);
  });

  it('a hand-made «Bu mijoz» with no phone on the card names the client and serves none of his facts', async () => {
    await db
      .insert(tgChatRules)
      .values({ managerUserId: ownerId, peerId: PEER, decision: 'include', clientId, decidedBy: ownerId, decidedAt: new Date() });
    try {
      expect(await kbResult()).not.toContain(marker);
    } finally {
      await db.delete(tgChatRules).where(and(eq(tgChatRules.managerUserId, ownerId), eq(tgChatRules.peerId, PEER)));
    }
  });
});

/**
 * His «30 ta emas 100 tagacha» (2026-11-10, #1622): the model reads up to a
 * hundred messages, and every rule keeps counting the newest thirty. A chat
 * whose OLD part asked the rail price, named Kashgar, stated 500 kg and chose
 * the flight — every one of which, in the rules' window, changes the draft —
 * and whose newest message asks an ordinary truck price.
 */
describe('a long chat: the model reads it, the rules count the recent part (#1622)', () => {
  async function at(direction: 'in' | 'out', body: string, agoMs: number): Promise<bigint> {
    msgSeq += 1n;
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: ownerId,
      peerId: PEER,
      tgMessageId: msgSeq,
      direction,
      body,
      sentAt: new Date(Date.now() - agoMs),
    });
    return msgSeq;
  }

  it('old rail, Kashgar, 500 kg and a flight are background: the truck is priced from the new figures, no guard fires', async () => {
    const HOUR = 3_600_000;
    let ago = 6 * HOUR;
    const step = () => (ago -= 60_000);
    await at('in', "Temir yo'l bilan qancha bo'ladi?", step());
    await at('out', 'Aniqlab aytaman.', step());
    await at('in', 'Qashqardan 500 kg yuk bor', step());
    await at('out', "Xo'p.", step());
    await at('in', "Avia bilan jo'nataman", step());
    await at('out', 'Tushunarli.', step());
    for (let i = 0; i < 36; i++) await at(i % 2 ? 'out' : 'in', i % 2 ? 'Arzimaydi' : 'Rahmat', step());
    await at('out', "Yana savol bo'lsa yozing.", 3 * HOUR);
    const anchor = await at('in', "Assalomu alaykum, Yiwudan Toshkentga 5 kub 1000 kg yuk bor, yo'lkira qancha bo'ladi?", 60_000);

    const model = scripted([
      // w1/v1 are the NEW figures only when the old «500 kg» is not a measure.
      { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
      // It cites #1 — the chat's oldest line, in the part only the model reads: a citation reaches what it saw.
      compose("Assalomu alaykum! Yo'lkira taxminan 800 $ bo'ladi (5 kub, 1000 kg). Boj va QQS alohida hisoblanadi.", {
        cited_message_refs: ['#1'],
      }),
    ]);
    const out = await handleInbound(job(anchor), { callModel: model });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });

    // The model read the old part, under the heading that says it is background, and the chat is a cache breakpoint.
    const opening = model.requests[0]!.messages[0]!.content[0] as { type: 'text'; text: string; cache?: true };
    expect(opening.cache).toBe(true);
    const heading = opening.text.indexOf('Oldingi suhbat');
    const suhbat = opening.text.indexOf('Suhbat (eski → yangi):');
    expect(heading).toBeGreaterThan(-1);
    const rail = opening.text.indexOf("Temir yo'l bilan qancha bo'ladi?");
    expect(rail).toBeGreaterThan(heading);
    expect(rail).toBeLessThan(suhbat);
    expect(opening.text.slice(suhbat)).not.toContain('Qashqardan');

    // The truck was priced from the new 5 kub / 1000 kg — not refused as Kashgar's, not 500 kg.
    const toolResult = model.requests[1]!.messages
      .flatMap((m) => m.content)
      .find((b): b is { type: 'tool_result'; tool_use_id: string; content: string } => b.type === 'tool_result');
    expect(toolResult?.content).toContain('800');

    const d = await liveDraft();
    expect(d?.needsOwner).toBe(false);
    const [first] = await db
      .select({ id: tgMessages.id })
      .from(tgMessages)
      .where(eq(tgMessages.peerId, PEER))
      .orderBy(tgMessages.sentAt)
      .limit(1);
    expect(d!.citedMessageIds).toEqual([first!.id]);
    const memory = (d!.policy as { memory: { sources: { value: number }[]; aviaOnly?: boolean; aviaMentioned?: boolean } }).memory;
    expect(memory.aviaOnly ?? false).toBe(false);
    expect(memory.aviaMentioned ?? false).toBe(false);
    expect(memory.sources.some((s) => s.value === 500)).toBe(false);
    const card = await cardOf(d!.id);
    expect(String((card!.payload as Record<string, unknown>).text)).not.toContain("temir yo'l");
  });

  it('his own reply thirty-five messages back, inside the pause, still stands the AI down', async () => {
    await at('in', 'Salom', 50 * 60_000);
    await at('out', 'Ha, eshitaman', 40 * 60_000);
    for (let i = 0; i < 35; i++) await at('in', `Rasm ${i + 1}`, (39 - i) * 60_000);
    const a = await at('in', 'Shularni hisoblab bering', 5_000);
    const out = await handleInbound(job(a), { callModel: scripted([compose('x')]) });
    expect(out).toEqual({ outcome: 'refused', reason: 'human_active' });
  });

  it('the account’s robot is not his: a Business greeting an hour back, then thirty-five photos, still drafts (#1627)', async () => {
    await at('in', 'Salom', 70 * 60_000);
    const greeting = await at('out', 'Assalomu alaykum! Hozir band emasman, tez orada javob beraman.', 60 * 60_000);
    const [row] = await db
      .select({ id: tgMessages.id })
      .from(tgMessages)
      .where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.tgMessageId, greeting)));
    await db.insert(tgMessageFlags).values({ messageId: row!.id, autoSent: true });
    for (let i = 0; i < 35; i++) await at('in', `Rasm ${i + 1}`, (39 - i) * 60_000);
    const a = await at('in', 'Shularni hisoblab bering', 5_000);
    const out = await handleInbound(job(a), { callModel: scripted([compose('Tekshirib aytaman.', { category: 'qualification' })]) });
    expect(out).toMatchObject({ outcome: 'draft' });
  });

  it('an AI send in the window is not his: the pause does not hold for it', async () => {
    await at('in', 'Salom', 50 * 60_000);
    const sent = await at('out', 'Assalomu alaykum, eshitaman.', 40 * 60_000);
    const [draft] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        anchorTgMessageId: sent - 1n,
        status: 'approved',
        proposedBody: 'Assalomu alaykum, eshitaman.',
        decidedAt: new Date(Date.now() - 41 * 60_000),
        decidedBy: ownerId,
      })
      .returning({ id: agentDrafts.id });
    await db.insert(agentOutbox).values({
      draftId: draft!.id,
      managerUserId: ownerId,
      peerId: PEER,
      clientId,
      body: 'Assalomu alaykum, eshitaman.',
      randomId: BigInt(`8${SUFFIX}${msgSeq}`),
      answersTgMessageId: sent - 1n,
      queuedBy: ownerId,
      status: 'sent',
      tgMessageId: sent,
      sentAt: new Date(Date.now() - 40 * 60_000),
    });
    const a = await at('in', 'Yukim qachon keladi?', 5_000);
    const out = await handleInbound(job(a), { callModel: scripted([compose('Tekshirib aytaman.', { category: 'status' })]) });
    expect(out).toMatchObject({ outcome: 'draft' });
  });
});
