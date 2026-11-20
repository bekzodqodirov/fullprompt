import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropDrainKicksSince } from './drain-kicks';
import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  agentSignals,
  clients,
  notifications,
  roles,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { autoVerdict } from '@/modules/wms/agent/auto-gate';
import { autoFactsFor, type AutoDraftShape } from '@/modules/wms/agent/auto-send';
import {
  __forgetAgentToliq1aReady,
  __pretendAgentToliq1aBehind,
  __restoreAgentConfig,
  readAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { LOOP_NOTICE, loopBucketStart, loopSignalKey } from '@/modules/wms/agent/loop';
import { handleInbound } from '@/modules/wms/agent/run';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * The CHAT loop detector against a real database (stage 1a P2 «Halqa», §4.3, J8, J33) — not the model's tool loop of
 * agent-loop.integration. What a hand-built fact cannot show: the one statement `loopFactsFor` reads (the anchor, his
 * earlier lines, our sends timed by the thread's copy), the run refused `loop` before any model call, the notice said
 * ONCE per bucket through its `agent_signals` claim and naming the chat the purge blanks it by, nothing said one
 * migration behind, and the gate's `own_repeat` read off the stored sends.
 *
 * agent_config is CONFIGURATION (#183): snapshotted and put back. The fixture users are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`78${SUFFIX}`);
let ownerId = '';
let accountId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
let msgSeq = 5000n;

/** A whole loop-window bucket that ended at least half an hour ago — every line of a test sits inside one bucket. */
const BUCKET = loopBucketStart(new Date(Date.now() - 60 * 60_000));
const min = (m: number) => new Date(BUCKET.getTime() + m * 60_000);
const sec = (base: Date, s: number) => new Date(base.getTime() + s * 1000);

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function line(direction: 'in' | 'out', body: string, at: Date): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction, body, sentAt: at });
  return msgSeq;
}

/** One of OUR machine sends: the approved draft, its outbox row that went, and the thread's copy. */
async function machineSend(body: string, at: Date): Promise<void> {
  const tgId = await line('out', body, at);
  const [draft] = await db
    .insert(agentDrafts)
    .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: tgId - 1n, status: 'approved', proposedBody: body, decidedAt: at, decidedBy: ownerId })
    .returning({ id: agentDrafts.id });
  await db.insert(agentOutbox).values({
    draftId: draft!.id,
    managerUserId: ownerId,
    peerId: PEER,
    clientId,
    body,
    randomId: BigInt(`9${SUFFIX}${tgId}`),
    answersTgMessageId: tgId - 1n,
    queuedBy: ownerId,
    status: 'sent',
    tgMessageId: tgId,
    sentAt: at,
  });
}

const job = (anchor: bigint) => ({ managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(anchor), origin: 'live' as const });

/** A model that must never be asked: a loop is refused before the run spends anything. */
function never(): CallModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const fn = (async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    throw new Error('the model was called in a loop');
  }) as CallModel & { requests: ModelRequest[] };
  fn.requests = requests;
  return fn;
}

/** A model that writes one ordinary reply (agent-run.integration's `compose`, as the run reads it). */
function answers(text: string): CallModel {
  return (async (): Promise<ModelResponse> => ({
    stopReason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'compose_reply',
        input: {
          reply_needed: true,
          reply_text: text,
          language: 'uz',
          gloss_uz: '',
          category: 'qualification',
          confidence: 0.8,
          needs_owner: false,
          owner_question: '',
          next_step: 'quote',
          actions: [],
          used_fact_ids: [],
          cited_message_refs: [],
        },
      },
    ],
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })) as CallModel;
}

const loopNotices = () =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice'), sql`${notifications.payload}->>'text' LIKE ${'🔁 %'}`));

async function clearChat() {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentSignals).where(eq(agentSignals.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), sql`${notifications.type} LIKE 'Agent%'`));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  ownerId = await makeUser(`AI egasi halqa ${SUFFIX}`, 'super_admin', '01');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `HQ${SUFFIX}`, name: `Halqa Mijoz ${SUFFIX}`, phones: [`+99898${SUFFIX}55`], salesManagerId: ownerId })
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
});

beforeEach(async () => {
  __forgetAgentToliq1aReady();
  await clearChat();
  await stampAgentPump(accountId, true);
});

const KICKS_FROM = new Date().toISOString();
afterAll(async () => {
  __forgetAgentToliq1aReady();
  await dropDrainKicksSince(KICKS_FROM);
  await clearChat();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId]));
});

const AWAY = 'Xabaringiz qabul qilindi, tez orada javob beramiz.';

describe('the chat loop, run by run (stage 1a P2)', () => {
  it('the second repeat is refused `loop` before the model, and he is told ONCE per bucket — by the chat the purge finds it by', async () => {
    await line('in', AWAY, min(1));
    // The first repeat is answered: no loop yet.
    await line('in', AWAY, min(4));
    const third = await line('in', AWAY, min(8));
    const model = never();
    expect(await handleInbound(job(third), { callModel: model })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(model.requests).toHaveLength(0);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.peerId, PEER), eq(agentRuns.anchorTgMessageId, third)));
    expect(run).toMatchObject({ outcome: 'refused', error: 'loop' });

    let said = await loopNotices();
    expect(said).toHaveLength(1);
    const payload = said[0]!.payload as { text: string; peerId?: string };
    expect(payload.text.split('\n')[0]).toBe(LOOP_NOTICE);
    expect(payload.text).toContain(`HQ${SUFFIX}`);
    // No customer text on the card.
    expect(payload.text).not.toContain(AWAY);
    expect(payload.peerId).toBe(String(PEER));
    const [claim] = await db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER));
    expect(claim).toMatchObject({ topic: 'loop', managerUserId: ownerId, clientId, dedupeKey: loopSignalKey(PEER, min(8)) });
    expect((claim!.facts as { signals: string[] }).signals).toEqual(['same_inbound']);

    // A fourth time in the same bucket: refused again, said no more.
    const fourth = await line('in', AWAY, min(20));
    expect(await handleInbound(job(fourth), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    said = await loopNotices();
    expect(said).toHaveLength(1);
    // The next bucket says it again.
    const fifth = await line('in', AWAY, min(31));
    expect(await handleInbound(job(fifth), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(await loopNotices()).toHaveLength(2);
    expect(await db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER))).toHaveLength(2);
  });

  it('one migration behind (no 0151): the run is still refused `loop`, nothing is claimed or said, nothing throws', async () => {
    __pretendAgentToliq1aBehind();
    await line('in', AWAY, min(1));
    await line('in', AWAY, min(4));
    const third = await line('in', AWAY, min(8));
    expect(await handleInbound(job(third), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(await loopNotices()).toHaveLength(0);
    expect(await db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER))).toHaveLength(0);
  });

  it('fast answers to three of our sends (J8): refused `loop` — an answer 7 s on, past the 5-second echo, each a new line', async () => {
    const asks = ['Assalomu alaykum! Yukingiz haqida yozing.', 'Qaysi shahardan jo‘natasiz?', 'Yuk necha kub?'];
    let anchor = 0n;
    for (const [i, ask] of asks.entries()) {
      const at = min(2 + i);
      await machineSend(ask, at);
      anchor = await line('in', `Ticket #41${i} received. We will reply soon.`, sec(at, 7));
    }
    expect(await handleInbound(job(anchor), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    const [claim] = await db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER));
    expect((claim!.facts as { signals: string[] }).signals).toEqual(['fast_peer']);
  });

  it('…while a person who typed his answers is answered: the typing stamp after our sends', async () => {
    const asks = ['Assalomu alaykum! Yukingiz haqida yozing.', 'Qaysi shahardan jo‘natasiz?', 'Yuk necha kub?'];
    let anchor = 0n;
    for (const [i, ask] of asks.entries()) {
      const at = min(2 + i);
      await machineSend(ask, at);
      anchor = await line('in', ['Yiwudan', 'Guanchjou', '5 kub'][i]!, sec(at, 7));
    }
    // The listener's one stamp, the moment before his last answer.
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, peerTypingAt: sec(min(4), 5) });
    const out = await handleInbound(job(anchor), { callModel: answers('Og‘irligi qancha?') });
    expect(out).toMatchObject({ outcome: 'draft' });
    expect(await db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER))).toHaveLength(0);
  });
});

describe('the gate’s `loop` — own_repeat, read off the stored sends (stage 1a P2)', () => {
  const shape = (anchorTgMessageId: bigint, body: string): AutoDraftShape => ({
    managerUserId: ownerId,
    peerId: PEER,
    runId: null,
    clientId,
    leadId: null,
    anchorTgMessageId,
    kind: 'reply',
    status: 'pending',
    finalBody: null,
    proposedBody: body,
    blocked: false,
    needsOwner: false,
    category: 'greeting',
    language: 'uz',
    confidence: '0.90',
    policy: { warnings: [], notes: [] },
    actions: [],
  });

  it('the reply about to go is our last send word for word → `loop`; with other figures, or once the window passed → not', async () => {
    const quote = '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $.';
    await line('in', '5 kub 800 kg narxi?', min(1));
    await machineSend(quote, min(2));
    const anchor = await line('in', 'Yana bir marta ayting?', min(5));
    const now = min(6);
    const same = await autoFactsFor(shape(anchor, quote), { at: now, now, config: null });
    expect(same.loop).toBe(true);
    expect(autoVerdict(same).reasons).toContain('loop');
    const other = await autoFactsFor(shape(anchor, '7 kub, 900 kg yukingiz uchun Toshkentgacha taxminan 1100 $.'), { at: now, now, config: null });
    expect(other.loop).toBe(false);
    const later = min(2 + 31);
    expect((await autoFactsFor(shape(anchor, quote), { at: later, now: later, config: null })).loop).toBe(false);
  });
});
