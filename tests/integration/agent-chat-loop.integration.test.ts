import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Api, helpers } from 'telegram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  attachments,
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
import { autoTicksOf, ORDINARY_CATEGORIES } from '@/modules/wms/agent/auto-categories';
import { autoFactsFor, autoPlanFor, readAutoConfig, type AutoConfig, type AutoDraftShape } from '@/modules/wms/agent/auto-send';
import { autoMediaWords } from '@/modules/wms/agent/bot-door';
import { systemReplyFor } from '@/modules/wms/agent/system-reply';
import {
  __forgetAgentToliq1aReady,
  __pretendAgentToliq1aBehind,
  __restoreAgentConfig,
  readAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { LOOP_NOTICE, gateLoopFor, loopBucketStart, loopNoticeOnce, loopSignalKey } from '@/modules/wms/agent/loop';
import { handleInbound } from '@/modules/wms/agent/run';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { storeIncoming } from '@/modules/wms/crm/telegram-accounts';
import { toMessageRow, type RawMessage } from '@/modules/wms/crm/telegram-import';

/**
 * The CHAT loop detector against a real database (stage 1a P2 «Halqa», §4.3, J8, J33) — not the model's tool loop of
 * agent-loop.integration. What a hand-built fact cannot show: the one statement `loopFactsFor` reads (the anchor, his
 * earlier lines with their file flag, our sends timed by the thread's copy — an 'unknown' one too — and the notice's
 * claim), the run refused `loop` before any model call, the notice said ONCE through its `agent_signals` claim and
 * naming the chat the purge blanks it by, the half hour it promises kept (J33) and then over, a notice nobody hears
 * taken back, nothing said one migration behind, and the gate's `loop` read off the stored sends and the claim.
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

async function line(direction: 'in' | 'out', body: string, at: Date, hasMedia = false): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction, body, sentAt: at, hasMedia });
  return msgSeq;
}

/**
 * One of OUR machine sends: the approved draft and its outbox row. 'sent' went, with the thread's copy; 'unknown' was
 * handed to Telegram and its answer lost — no copy, no `sent_at`, only the claim before the send.
 */
async function machineSend(body: string, at: Date, status: 'sent' | 'unknown' = 'sent'): Promise<void> {
  const tgId = status === 'sent' ? await line('out', body, at) : (msgSeq += 1n);
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
    status,
    stepClaimedAt: at,
    tgMessageId: status === 'sent' ? tgId : null,
    sentAt: status === 'sent' ? at : null,
  });
}

/** The notice's claims of this chat, as the hold reads them. */
const claims = () => db.select().from(agentSignals).where(eq(agentSignals.peerId, PEER));

/** Half an hour and a minute pass since he was told: every claim of this chat moves back by that much. */
const holdOver = () => db.execute(sql`UPDATE agent_signals SET created_at = created_at - interval '31 minutes' WHERE peer_id = ${String(PEER)}::bigint`);

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

/** An away-message answered by us twice, its third line the anchor — the loop `same_inbound` stops. */
async function awayLoop(): Promise<bigint> {
  await line('in', AWAY, min(1));
  await machineSend('Assalomu alaykum! Yukingiz haqida yozing.', min(2));
  // The first answered repeat is answered again: no loop yet.
  await line('in', AWAY, min(4));
  await machineSend('Qaysi shahardan jo‘natasiz?', min(5));
  return line('in', AWAY, min(8));
}

describe('the chat loop, run by run (stage 1a P2)', () => {
  it('the second answered repeat is refused `loop` before the model, and he is told ONCE — by the chat the purge finds it by', async () => {
    const third = await awayLoop();
    const model = never();
    expect(await handleInbound(job(third), { callModel: model })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(model.requests).toHaveLength(0);
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.peerId, PEER), eq(agentRuns.anchorTgMessageId, third)));
    expect(run).toMatchObject({ outcome: 'refused', error: 'loop' });

    const said = await loopNotices();
    expect(said).toHaveLength(1);
    const payload = said[0]!.payload as { text: string; peerId?: string };
    expect(payload.text.split('\n')[0]).toBe(LOOP_NOTICE);
    expect(payload.text).toContain(`HQ${SUFFIX}`);
    // No customer text on the card.
    expect(payload.text).not.toContain(AWAY);
    expect(payload.peerId).toBe(String(PEER));
    const [claim] = await claims();
    expect(claim).toMatchObject({ topic: 'loop', managerUserId: ownerId, clientId, dedupeKey: loopSignalKey(ownerId, PEER, min(8)) });
    expect(claim!.facts).toMatchObject({ signals: ['same_inbound'], fastDelaysMs: [] });
  });

  it('the half hour he was told of holds the chat — a NEW line is not answered (J33) — and once it is over the AI answers again', async () => {
    const third = await awayLoop();
    expect(await handleInbound(job(third), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    // The customer writes something new a minute later: no loop of its own, but the notice said the AI keeps out.
    const fresh = await line('in', 'Menga narxini ayting, 5 kub', min(9));
    const model = never();
    expect(await handleInbound(job(fresh), { callModel: model })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(model.requests).toHaveLength(0);
    // …and the away-message again: held, and he is not told twice — not even from the next bucket, whose key is free.
    const fourth = await line('in', AWAY, min(20));
    expect(await handleInbound(job(fourth), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    await machineSend('Necha kub?', min(25));
    const nextBucket = await line('in', AWAY, min(30));
    expect(await handleInbound(job(nextBucket), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(await loopNotices()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);

    // The half hour passes: a new line is answered.
    await holdOver();
    const later = await line('in', 'Narxi qancha bo‘ladi?', min(32));
    expect(await handleInbound(job(later), { callModel: answers('Yuk necha kub va necha kg?') })).toMatchObject({ outcome: 'draft' });
    // …and a fresh trip — the away-message answered twice before it — is told afresh, in its own bucket.
    await machineSend('Yuk necha kub va necha kg?', min(33));
    await line('in', AWAY, min(34));
    await machineSend('Qayerdan jo‘natasiz?', min(35));
    const again = await line('in', AWAY, min(40));
    expect(await handleInbound(job(again), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(await loopNotices()).toHaveLength(2);
    expect((await claims()).map((c) => c.dedupeKey).sort()).toEqual([loopSignalKey(ownerId, PEER, min(8)), loopSignalKey(ownerId, PEER, min(40))].sort());
  });

  it('the half hour is counted from the moment he was told, on the run’s clock — the claim’s own moment', async () => {
    const third = await awayLoop();
    const toldAt = min(8);
    expect(
      await loopNoticeOnce({
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        leadId: null,
        anchorAt: min(8),
        anchorTgMessageId: third,
        at: toldAt,
        signals: ['same_inbound'],
        fastDelaysMs: [],
        label: `HQ${SUFFIX}`,
      }),
    ).toBe('said');
    const [claim] = await claims();
    expect(claim!.createdAt.toISOString()).toBe(toldAt.toISOString());
    // Told an hour ago by that clock: the half hour is long over, and a new line is answered now.
    const fresh = await line('in', 'Menga narxini ayting, 5 kub', min(9));
    expect(await handleInbound(job(fresh), { callModel: answers('Yuk qayerdan?') })).toMatchObject({ outcome: 'draft' });
  });

  it('a notice that reaches nobody is taken back, claim and all — no promise, no hold; the looping line is refused all the same', async () => {
    const third = await awayLoop();
    // The holder cannot log in (a seat with its login off, a leaver): the card is queued to nobody.
    await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
    try {
      expect(await handleInbound(job(third), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
      expect(await claims()).toHaveLength(0);
      expect(
        await loopNoticeOnce({
          managerUserId: ownerId,
          peerId: PEER,
          clientId,
          leadId: null,
          anchorAt: min(8),
          anchorTgMessageId: third,
          at: new Date(),
          signals: ['same_inbound'],
          fastDelaysMs: [],
          label: `HQ${SUFFIX}`,
        }),
      ).toBe('unheard');
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, ownerId));
    }
    expect(await claims()).toHaveLength(0);
    expect(await loopNotices()).toHaveLength(0);
    // Nothing was promised: a new line is answered.
    const fresh = await line('in', 'Menga narxini ayting, 5 kub', min(9));
    expect(await handleInbound(job(fresh), { callModel: answers('Yuk qayerdan?') })).toMatchObject({ outcome: 'draft' });
  });

  it('one migration behind (no 0151): the run is still refused `loop`, nothing is claimed or said, nothing held, nothing throws', async () => {
    __pretendAgentToliq1aBehind();
    const third = await awayLoop();
    expect(await handleInbound(job(third), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'loop' });
    expect(await loopNotices()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
  });

  it('the same question with no answer of ours between (his chat, the listener down) is no loop — and three photos under one caption neither', async () => {
    await line('in', 'Narxi qancha?', min(1));
    await line('in', 'Narxi qancha?', min(2));
    const third = await line('in', 'Narxi qancha?', min(3));
    expect(await handleInbound(job(third), { callModel: answers('Yuk necha kub?') })).toMatchObject({ outcome: 'draft' });

    await clearChat();
    const caption = 'Shu tovarni olib kelasizmi?';
    await line('in', caption, min(1), true);
    await machineSend('Ha, olib kelamiz. Necha kub?', min(2));
    await line('in', caption, min(4), true);
    await machineSend('Yuk qayerdan?', min(5));
    const photo = await line('in', caption, min(8), true);
    expect(await handleInbound(job(photo), { callModel: answers('Rasmlarni oldik. Necha kub?') })).toMatchObject({ outcome: 'draft' });
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
    const [claim] = await claims();
    // Which signal, and each counted answer's delay — what J8's first live week measures the 10 s by.
    expect(claim!.facts).toMatchObject({ signals: ['fast_peer'], fastDelaysMs: [7000, 7000, 7000] });
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
    expect(await claims()).toHaveLength(0);
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

  it('a send whose answer was lost (\'unknown\') may have gone: the same words after it are a repeat too', async () => {
    const quote = '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $.';
    await line('in', '5 kub 800 kg narxi?', min(1));
    await machineSend(quote, min(2), 'unknown');
    const anchor = await line('in', 'Yana bir marta ayting?', min(5));
    const now = min(6);
    expect((await autoFactsFor(shape(anchor, quote), { at: now, now, config: null })).loop).toBe(true);
  });

  it('the hold at the gate (J33): inside the half hour he was told of, any reply waits for his ✅ — judged when it would go', async () => {
    const anchor = await line('in', '5 kub narxi?', min(9));
    const reply = '5 kub uchun taxminan 600 $.';
    const now = new Date();
    await db.insert(agentSignals).values({
      topic: 'loop',
      managerUserId: ownerId,
      peerId: PEER,
      clientId,
      facts: { signals: ['same_inbound'] },
      dedupeKey: loopSignalKey(ownerId, PEER, min(8)),
      createdAt: new Date(now.getTime() - 5 * 60_000),
    });
    const inside = await autoFactsFor(shape(anchor, reply), { at: now, now, config: null });
    expect(inside.loop).toBe(true);
    expect(autoVerdict(inside).reasons).toContain('loop');
    // A reply that would go only after the half hour is over (its hold counts down past it) is not refused for it.
    const due = new Date(now.getTime() + 26 * 60_000);
    expect((await autoFactsFor(shape(anchor, reply), { at: due, now, config: null })).loop).toBe(false);
    // One migration behind the claim is never read.
    __pretendAgentToliq1aBehind();
    expect((await autoFactsFor(shape(anchor, reply), { at: now, now, config: null })).loop).toBe(false);
  });
});

describe('a tayyor matn and the loop (the merged-tree seam review, finding 1)', () => {
  /** The layer armed with nothing ticked but talk — what a stage-1a owner arms on day one. */
  const ARMED: AutoConfig = {
    armed: true,
    armedAt: new Date(),
    armedBy: null,
    holdSec: 120,
    perDay: null,
    maxChars: 400,
    minConfidence: 0.8,
    categories: [...ORDINARY_CATEGORIES],
    disarmedAt: null,
    disarmReason: null,
  };

  it('photo → media line → text → reply → photo again (9 min): the second media line goes — `pick` gives the chat its one wording, never a loop', async () => {
    // The line `pick` gives this chat, every time — G10 counts identical texts across chats, so a chat keeps one.
    const mediaLine = systemReplyFor({ reason: 'media', locale: 'uz', peerId: PEER }).replyText;
    await line('in', '', min(1), true);
    await machineSend(mediaLine, min(2));
    await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(3));
    await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(4));
    // Our last line is the reply, so the silence began after it: the photo is owed its line again (`toldInSilence`).
    // A kept photo is a stored file beside its line — what the run reads as a photo, and the media line answers.
    const photo = await line('in', '', min(10), true);
    const [row] = await db.select({ id: tgMessages.id }).from(tgMessages).where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.tgMessageId, photo)));
    const [file] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_message',
        entityId: row!.id,
        kind: 'photo',
        storageKey: `agent-chat-loop-test/${SUFFIX}/${row!.id}`,
        fileName: 'invoice.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10,
        uploadedBy: ownerId,
      })
      .returning({ id: attachments.id });
    try {
      expect(await handleInbound(job(photo), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    } finally {
      await db.delete(attachments).where(eq(attachments.id, file!.id));
    }
    const [d] = await db
      .select()
      .from(agentDrafts)
      .where(and(eq(agentDrafts.peerId, PEER), eq(agentDrafts.status, 'pending'), eq(agentDrafts.anchorTgMessageId, photo)));
    expect(d!.proposedBody).toBe(mediaLine);
    expect((d!.policy as { system?: unknown }).system).toBe('media');

    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
    try {
      const at = min(11);
      const facts = await autoFactsFor(d!, { at, now: at, config: ARMED });
      expect(facts.loop).toBe(false);
      expect(autoVerdict(facts)).toEqual({ eligible: true, reasons: [] });
      // The same words as the MODEL's reply are its own repeat: the rule stands for every reply but the tayyor matn.
      const asModel = await autoFactsFor({ ...d!, policy: { ...(d!.policy as object), system: undefined } }, { at, now: at, config: ARMED });
      expect(asModel.loop).toBe(true);
      expect(autoVerdict(asModel).reasons).toContain('loop');
    } finally {
      await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    }
  });

  it('…while the half hour he was told of still holds the tayyor matn too (J33): its `held` half is asked of every reply', async () => {
    const anchor = await line('in', '', min(9), true);
    const at = new Date();
    await db.insert(agentSignals).values({
      topic: 'loop',
      managerUserId: ownerId,
      peerId: PEER,
      clientId,
      facts: { signals: ['same_inbound'] },
      dedupeKey: loopSignalKey(ownerId, PEER, min(8)),
      createdAt: new Date(at.getTime() - 5 * 60_000),
    });
    const mediaLine = systemReplyFor({ reason: 'media', locale: 'uz', peerId: PEER }).replyText;
    const tayyor: AutoDraftShape = {
      managerUserId: ownerId,
      peerId: PEER,
      runId: null,
      clientId,
      leadId: null,
      anchorTgMessageId: anchor,
      kind: 'reply',
      status: 'pending',
      finalBody: null,
      proposedBody: mediaLine,
      blocked: false,
      needsOwner: false,
      category: 'other',
      language: 'uz',
      confidence: null,
      policy: { warnings: [], notes: [], noteCodes: [], system: 'media' },
      actions: [],
    };
    expect((await autoFactsFor(tayyor, { at, now: at, config: null })).loop).toBe(true);
  });
});

describe('a tayyor matn and our sends the thread lost (the independent check of the seam fixes, F1)', () => {
  /** The layer armed with nothing ticked but talk — what a stage-1a owner arms on day one. */
  const ARMED: AutoConfig = {
    armed: true,
    armedAt: new Date(),
    armedBy: null,
    holdSec: 120,
    perDay: null,
    maxChars: 400,
    minConfidence: 0.8,
    categories: [...ORDINARY_CATEGORIES],
    disarmedAt: null,
    disarmReason: null,
  };
  const files: string[] = [];
  afterEach(async () => {
    if (files.length) await db.delete(attachments).where(inArray(attachments.id, files.splice(0)));
  });

  /**
   * A kept photo — or a voice note: its line and the stored file beside it, what the run reads as a photo the media line
   * answers (or a voice note the voice line does).
   */
  async function photo(at: Date, kind: 'photo' | 'voice' | 'document' = 'photo'): Promise<bigint> {
    const tgId = await line('in', '', at, true);
    const [row] = await db.select({ id: tgMessages.id }).from(tgMessages).where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.tgMessageId, tgId)));
    const [file] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_message',
        entityId: row!.id,
        kind: kind === 'photo' ? 'photo' : 'file',
        storageKey: `agent-chat-loop-lost/${SUFFIX}/${row!.id}`,
        fileName: kind === 'photo' ? 'invoice.jpg' : kind === 'voice' ? 'voice.ogg' : 'invoice.pdf',
        contentType: kind === 'photo' ? 'image/jpeg' : kind === 'voice' ? 'audio/ogg' : 'application/pdf',
        sizeBytes: 10,
        uploadedBy: ownerId,
      })
      .returning({ id: attachments.id });
    files.push(file!.id);
    return tgId;
  }
  const voiceNote = (at: Date) => photo(at, 'voice');
  /** A sticker: Telegram gave the line media and the store kept no file for it — no line's kind. */
  const sticker = (at: Date) => line('in', '', at, true);
  /** His line of a kind, as the tables below spell it: P a photo, V a voice note, D a file, S a sticker. */
  const his = (e: 'P' | 'V' | 'D' | 'S', at: Date) =>
    e === 'V' ? voiceNote(at) : e === 'D' ? photo(at, 'document') : e === 'S' ? sticker(at) : photo(at);

  /**
   * One of OUR sends with NO thread copy, as the send step leaves it: 'unknown' (handed to Telegram, the answer lost —
   * no `sent_at`, only the claim), 'sent' with no message id (a RANDOM_ID_DUPLICATE), or still 'sending' (in flight —
   * no line of ours yet). Returns the outbox row, so a test can settle an in-flight one later.
   */
  async function lostSend(body: string, at: Date, shape: 'unknown' | 'no_id' | 'sending'): Promise<string> {
    msgSeq += 1n;
    const [draft] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: msgSeq - 1n, status: 'approved', proposedBody: body, decidedAt: at, decidedBy: ownerId })
      .returning({ id: agentDrafts.id });
    const [row] = await db
      .insert(agentOutbox)
      .values({
        draftId: draft!.id,
        managerUserId: ownerId,
        peerId: PEER,
        clientId,
        body,
        randomId: BigInt(`7${SUFFIX}${msgSeq}`),
        answersTgMessageId: msgSeq - 1n,
        queuedBy: ownerId,
        status: shape === 'no_id' ? 'sent' : shape,
        stepClaimedAt: at,
        tgMessageId: null,
        sentAt: shape === 'no_id' ? at : null,
      })
      .returning({ id: agentOutbox.id });
    return row!.id;
  }

  /** Settle an in-flight row as the send step does: 'unknown', or 'sent' with no message id. */
  const settle = (id: string, shape: 'unknown' | 'no_id', at: Date) =>
    db
      .update(agentOutbox)
      .set(shape === 'unknown' ? { status: 'unknown' } : { status: 'sent', sentAt: at })
      .where(eq(agentOutbox.id, id));

  const mediaLine = () => systemReplyFor({ reason: 'media', locale: 'uz', peerId: PEER }).replyText;
  const pendingFor = async (anchor: bigint) =>
    (
      await db
        .select()
        .from(agentDrafts)
        .where(and(eq(agentDrafts.peerId, PEER), eq(agentDrafts.status, 'pending'), eq(agentDrafts.anchorTgMessageId, anchor)))
    )[0];

  async function gate(d: AutoDraftShape, at: Date) {
    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
    try {
      const facts = await autoFactsFor(d, { at, now: at, config: ARMED });
      return { loop: facts.loop, verdict: autoVerdict(facts) };
    } finally {
      await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    }
  }

  it.each(['unknown', 'no_id'] as const)(
    'photo → media line %s (no thread copy) → photo again in the SAME silence: the run writes no second line',
    async (shape) => {
      await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(1));
      await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(2));
      await photo(min(3));
      await lostSend(mediaLine(), min(4), shape);
      const again = await photo(min(6));
      expect(await handleInbound(job(again), { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
      expect(await pendingFor(again)).toBeUndefined();
    },
  );

  it.each(['unknown', 'no_id'] as const)(
    '…and the gate never presses one written while that line was still in flight, once it settled %s: held `loop`',
    async (shape) => {
      await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(1));
      await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(2));
      await photo(min(3));
      // In flight when the next photo came: no line of ours yet, so the run owes the photo its line…
      const flying = await lostSend(mediaLine(), min(4), 'sending');
      const again = await photo(min(6));
      expect(await handleInbound(job(again), { callModel: never() })).toMatchObject({ outcome: 'draft' });
      const d = await pendingFor(again);
      expect(d!.proposedBody).toBe(mediaLine());
      expect((d!.policy as { system?: unknown }).system).toBe('media');
      // …then Telegram took the first one and the thread never got its copy: the same words must not go again.
      await settle(flying, shape, min(4));
      const g = await gate(d!, min(7));
      expect(g.loop).toBe(true);
      expect(g.verdict.reasons).toContain('loop');
      // The loop's own repeat is not what refused it — the tayyor matn's «once per silence» is.
      const half = await gateLoopFor({ managerUserId: ownerId, peerId: PEER, anchorTgMessageId: again, body: mediaLine() }, min(7));
      expect(half.held).toBe(false);
    },
  );

  it('…while the same line in a LATER silence goes: his text and our reply since begin it anew (the seam fix’s point)', async () => {
    await photo(min(1));
    await lostSend(mediaLine(), min(2), 'unknown');
    await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(3));
    await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(4));
    const later = await photo(min(10));
    expect(await handleInbound(job(later), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(later);
    expect(d!.proposedBody).toBe(mediaLine());
    const g = await gate(d!, min(11));
    expect(g.loop).toBe(false);
    expect(g.verdict).toEqual({ eligible: true, reasons: [] });
  });

  it('…and so does a reply of ours the thread lost: it reached the customer as surely as the line did, and began a silence', async () => {
    await line('in', 'Rastamojka qancha bo‘ladi?', min(1));
    await machineSend('Hisoblatishga yubordim, javob kelishi bilan aytaman.', min(2));
    await photo(min(3));
    await machineSend(mediaLine(), min(4));
    // Our next reply (the VED's answer told, say): handed to Telegram, its answer lost — the thread's last line of ours
    // is still the media line, and read from the thread alone the photo below was «already told».
    await lostSend('Rastamojka taxminan 1 200 $ bo‘ladi.', min(6), 'unknown');
    const later = await photo(min(10));
    expect(await handleInbound(job(later), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(later);
    expect(d!.proposedBody).toBe(mediaLine());
    expect((await gate(d!, min(11))).verdict).toEqual({ eligible: true, reasons: [] });
  });

  it('a reply still in flight is no line said: the send step cancels it once he writes again, so the next photo is owed its line', async () => {
    await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(1));
    await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(2));
    await photo(min(3));
    await lostSend(mediaLine(), min(4), 'sending');
    const again = await photo(min(6));
    expect(await handleInbound(job(again), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    expect((await gate((await pendingFor(again))!, min(7))).loop).toBe(false);
  });

  /**
   * The check of the F1-F3 fixes, R1: the thread's burst still holds the photo our LOST media line answered, so the line
   * was chosen by that photo — media, told — and the run skipped `media_only` with nobody hearing the voice note after
   * it. The line answers his lines after our newest send, and the first kind among them not yet said: the voice line,
   * whatever shape the media line's send was left in (the copied control is what the run owes).
   */
  const voiceLine = () => systemReplyFor({ reason: 'voice', locale: 'uz', peerId: PEER }).replyText;
  it.each(['copied', 'unknown', 'no_id'] as const)(
    'photo → media line (%s) → voice note: the voice line is drafted — and the gate does not hold it `loop`',
    async (shape) => {
      await line('in', 'Yuk 3 kub, 450 kg, Guanchjoudan', min(1));
      await machineSend('Rahmat, qachon jo‘natmoqchisiz?', min(2));
      await photo(min(3));
      if (shape === 'copied') await machineSend(mediaLine(), min(4));
      else await lostSend(mediaLine(), min(4), shape);
      const voice = await voiceNote(min(6));
      expect(await handleInbound(job(voice), { callModel: never() })).toMatchObject({ outcome: 'draft' });
      const d = await pendingFor(voice);
      expect(d!.proposedBody).toBe(voiceLine());
      expect((d!.policy as { system?: unknown }).system).toBe('voice');
      expect((await gate(d!, min(7))).loop).toBe(false);
    },
  );

  it.each(['copied', 'unknown', 'no_id'] as const)(
    'photo → voice line (%s) → voice note: our line answered the photo before it — the voice note tells HIM, as a copied line does',
    async (shape) => {
      await photo(min(1));
      if (shape === 'copied') await machineSend(voiceLine(), min(2));
      else await lostSend(voiceLine(), min(2), shape);
      const voice = await voiceNote(min(4));
      expect(await handleInbound(job(voice), { callModel: never() })).toEqual({ outcome: 'notice', reason: 'voice_only' });
      expect(await pendingFor(voice)).toBeUndefined();
    },
  );

  it('photo → media line (unknown) → photo → voice note: the voice note is still owed its line, the photo is not', async () => {
    await photo(min(1));
    await lostSend(mediaLine(), min(2), 'unknown');
    await photo(min(4));
    const voice = await voiceNote(min(5));
    expect(await handleInbound(job(voice), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(voice);
    expect(d!.proposedBody).toBe(voiceLine());
    expect((d!.policy as { system?: unknown }).system).toBe('voice');
  });

  it('a Chinese chat: our copied zh media line, read back from the thread (NFKC folds its «，»), was said — no second line (R2)', async () => {
    await line('in', '你好，我有3立方的货，从广州发', min(1));
    await machineSend('好的，什么时候发货？', min(2));
    await photo(min(3));
    const zh = systemReplyFor({ reason: 'media', locale: 'zh', peerId: PEER }).replyText;
    expect(zh).toContain('，');
    await machineSend(zh, min(4));
    const again = await photo(min(6));
    expect(await handleInbound(job(again), { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
    expect(await pendingFor(again)).toBeUndefined();
  });

  it('a voice note beside his text: the AI’s reply is the gate’s `media` — and the words name the voice note for it (R3)', async () => {
    await line('in', 'Assalomu alaykum', min(1));
    await machineSend('Vaalaykum assalom! Qanday yordam bera olaman?', min(2));
    await voiceNote(min(3));
    const text = await line('in', 'Ish vaqtingiz qanday?', min(4));
    expect(await handleInbound(job(text), { callModel: answers('Ish vaqtimiz 9:00 dan 18:00 gacha.') })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(text);
    expect((d!.policy as { system?: unknown }).system).toBeUndefined();
    const g = await gate(d!, min(5));
    expect(g.verdict.reasons).toContain('media');
    // What the page and the bot tell him about that very reply: it stays his — for a voice note, not only a photo or a file.
    expect(autoMediaWords(autoTicksOf(ARMED.categories))).toContain('rasm, ovoz yoki fayl kelgan xabarga AI yozgan javob sizga qoladi');
  });

  /**
   * The check of the R1 fix, R3: a text with a link — every 1688 / taobao question — comes with Telegram's preview, and
   * `has_media` called it a file, so the gate held the model's reply to it `media` and every link question waited for
   * him. Born as the listener births it — gramjs's own preview object through `toMessageRow`, written by
   * `storeIncoming` — it is a text; a photo with a caption, born the same way, is still media.
   */
  async function born(raw: Omit<RawMessage, 'id' | 'date'>, at: Date): Promise<bigint> {
    msgSeq += 1n;
    const row = toMessageRow(PEER, { ...raw, id: Number(msgSeq), date: Math.floor(at.getTime() / 1000) });
    expect(await storeIncoming({ clientId, managerUserId: ownerId, row })).not.toBeNull();
    return msgSeq;
  }
  const preview = () =>
    new Api.MessageMediaWebPage({ webpage: new Api.WebPagePending({ id: helpers.returnBigInt('5'), date: 1 }) });

  it('a link question, Telegram’s preview beside it, is a text: the model’s reply to it is not held `media`', async () => {
    await line('in', 'Assalomu alaykum', min(1));
    await machineSend('Vaalaykum assalom! Qanday yordam bera olaman?', min(2));
    const t = await born({ message: 'https://detail.1688.com/offer/6543.html shu tovar qachon keladi?', media: preview() }, min(3));
    const [stored] = await db.select({ hasMedia: tgMessages.hasMedia }).from(tgMessages).where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.tgMessageId, t)));
    expect(stored!.hasMedia).toBe(false);
    expect(await handleInbound(job(t), { callModel: answers('Tovar omborga kelgach, sizga darhol xabar beramiz.') })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(t);
    expect((d!.policy as { system?: unknown }).system).toBeUndefined();
    expect((await gate(d!, min(4))).verdict).toEqual({ eligible: true, reasons: [] });
  });

  it('…while a photo with a caption is media: the model answers the caption, and the gate keeps that reply his', async () => {
    await line('in', 'Assalomu alaykum', min(1));
    await machineSend('Vaalaykum assalom! Qanday yordam bera olaman?', min(2));
    const photo = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: helpers.returnBigInt('6') }) });
    const t = await born({ message: 'Shu tovar qachon keladi?', media: photo }, min(3));
    expect(await handleInbound(job(t), { callModel: answers('Tovar omborga kelgach, sizga darhol xabar beramiz.') })).toMatchObject({ outcome: 'draft' });
    expect((await gate((await pendingFor(t))!, min(4))).verdict.reasons).toContain('media');
  });

  it('…and once the voice line was said too (lost as well), the next voice note tells HIM — never the customer again', async () => {
    await photo(min(1));
    await lostSend(mediaLine(), min(2), 'unknown');
    await voiceNote(min(4));
    await lostSend(voiceLine(), min(5), 'no_id');
    await photo(min(7));
    const voice = await voiceNote(min(8));
    expect(await handleInbound(job(voice), { callModel: never() })).toEqual({ outcome: 'notice', reason: 'voice_only' });
    expect(await pendingFor(voice)).toBeUndefined();
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice'), sql`${notifications.payload}->>'text' LIKE ${'%ovozli xabar%'}`));
    expect(told).toHaveLength(1);
  });

  const voiceNotices = () =>
    db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice'), sql`${notifications.payload}->>'text' LIKE ${'%ovozli xabar%'}`));

  /**
   * The check of the R1 fix: photo, the media line, the voice line — both said in this silence — then a voice note and
   * photos, each its own run. The voice note tells HIM once; every photo after it is skipped quietly. Naming the voice
   * kind whenever his lines held one wrote «Mijoz yana ovozli xabar yubordi» once per later photo (1 → 2 → 3 → 4).
   */
  it.each([
    ['copied', ['V', 'P']],
    ['copied', ['V', 'P', 'P']],
    ['copied', ['V', 'P', 'P', 'P']],
    ['unknown', ['V', 'P', 'P']],
    // The final check, F-sticker: a sticker after the voice note told of named the voice kind again — a notice per
    // sticker. Every voice note is told of once, a later one too.
    ['copied', ['V', 'S']],
    ['copied', ['V', 'S', 'S']],
    ['copied', ['V', 'P', 'S']],
    ['copied', ['V', 'S', 'P']],
    ['copied', ['V', 'P', 'V', 'S']],
  ] as const)('photo → media line → voice line (%s) → %j: one voice notice per voice note, the lines after it skipped', async (shape, tail) => {
    await photo(min(1));
    if (shape === 'copied') {
      await machineSend(mediaLine(), min(2));
      await machineSend(voiceLine(), min(3));
    } else {
      await lostSend(mediaLine(), min(2), 'unknown');
      await lostSend(voiceLine(), min(3), 'unknown');
    }
    const runs = [];
    let at = 5;
    for (const e of tail) {
      const anchor = await his(e, min(at++));
      runs.push(await handleInbound(job(anchor), { callModel: never() }));
      expect(await pendingFor(anchor)).toBeUndefined();
    }
    expect(runs).toEqual(tail.map((e) => (e === 'V' ? { outcome: 'notice', reason: 'voice_only' } : { outcome: 'skipped', reason: 'media_only' })));
    expect(await voiceNotices()).toHaveLength(tail.filter((e) => e === 'V').length);
  });

  /**
   * The final check, F-coalesce: a voice note and a photo (or a file, a sticker) sent TOGETHER after both lines were
   * said. Each line's job runs once his burst has landed — the debounce and his typing wait make it so — and every job
   * but the newest's stands down `not_newest` before it judges anything. The newest line's run is the first to judge
   * the voice note, and tells HIM of it once; naming his newest line's kind skipped the photo quietly and the voice note
   * reached nobody. The next photo, its own run, is skipped — the voice note was told of.
   */
  it.each([
    ['copied', ['V', 'P']],
    ['copied', ['V', 'P', 'P']],
    ['copied', ['V', 'S']],
    ['copied', ['V', 'P', 'S']],
    ['copied', ['P', 'V']],
    ['copied', ['V', 'D']],
    ['unknown', ['V', 'P']],
  ] as const)('photo → media line → voice note → voice line (%s) → %j sent together: the newest line’s run tells HIM once', async (shape, tail) => {
    await photo(min(1));
    if (shape === 'copied') await machineSend(mediaLine(), min(2));
    else await lostSend(mediaLine(), min(2), 'unknown');
    await voiceNote(min(3));
    if (shape === 'copied') await machineSend(voiceLine(), min(4));
    else await lostSend(voiceLine(), min(4), 'unknown');
    const anchors: bigint[] = [];
    for (const [i, e] of tail.entries()) anchors.push(await his(e, sec(min(6), i * 3)));
    const runs = [];
    for (const anchor of anchors) runs.push(await handleInbound(job(anchor), { callModel: never() }));
    expect(runs).toEqual(
      anchors.map((_, i) => (i < anchors.length - 1 ? { outcome: 'stood_down', reason: 'not_newest' } : { outcome: 'notice', reason: 'voice_only' })),
    );
    for (const anchor of anchors) expect(await pendingFor(anchor)).toBeUndefined();
    expect(await voiceNotices()).toHaveLength(1);
    const next = await photo(min(9));
    expect(await handleInbound(job(next), { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
    expect(await voiceNotices()).toHaveLength(1);
  });

  /**
   * «Judged» is read off the ledger (run `judgedThroughOf`): a row the voice note's run left that judged nothing that
   * stands — a stand-down stored at the write, eligibility's `not_newest`, an error the sweep retries — leaves the voice
   * note to the photo's run, which tells HIM of it. A notice row is a judgment: the photo after it is skipped. The rows
   * are written as the run would leave them; the run of the photo is the real one.
   */
  it.each([
    ['stood_down', 'editing', true],
    ['refused', 'not_newest', true],
    ['error', 'interrupted', true],
    ['notice', 'voice_only', false],
    ['refused', 'media_only', false],
  ] as const)('the voice note’s own run left `%s %s`: the photo after it tells HIM — %s', async (outcome, error, tells) => {
    await photo(min(1));
    await machineSend(mediaLine(), min(2));
    await voiceNote(min(3));
    await machineSend(voiceLine(), min(4));
    const voice = await voiceNote(min(6));
    await db.insert(agentRuns).values({ managerUserId: ownerId, peerId: PEER, trigger: 'inbound', anchorTgMessageId: voice, attempt: 0, outcome, error });
    const next = await photo(min(7));
    expect(await handleInbound(job(next), { callModel: never() })).toEqual(
      tells ? { outcome: 'notice', reason: 'voice_only' } : { outcome: 'skipped', reason: 'media_only' },
    );
    expect(await voiceNotices()).toHaveLength(tells ? 1 : 0);
  });

  it('a line judged once and run again (another attempt) tells nobody twice: its own earlier run judged it', async () => {
    await photo(min(1));
    await machineSend(mediaLine(), min(2));
    await machineSend(voiceLine(), min(3));
    const voice = await voiceNote(min(5));
    expect(await handleInbound(job(voice), { callModel: never() })).toEqual({ outcome: 'notice', reason: 'voice_only' });
    // A burst of voice notes alone is `voice_only` — skipped under that word, with no second notice.
    expect(await handleInbound({ ...job(voice), attempt: 1 }, { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'voice_only' });
    expect(await voiceNotices()).toHaveLength(1);
  });

  it('…while a voice note after the photos still tells HIM: no earlier run judged it', async () => {
    await photo(min(1));
    await machineSend(mediaLine(), min(2));
    await machineSend(voiceLine(), min(3));
    await voiceNote(min(5));
    await photo(min(6));
    const voice = await voiceNote(min(7));
    expect(await handleInbound(job(voice), { callModel: never() })).toEqual({ outcome: 'notice', reason: 'voice_only' });
  });

  /**
   * The check of the R1 fix: Telegram stamps his lines in whole seconds and a lost send's moment is the server's, to the
   * millisecond — so a line sent in the same second as our lost send, after it, sorted at or before it, and the line it
   * was owed was dropped (`skipped media_only`, nobody answered). Read at the thread's own granularity, a line in that
   * second stands after our send: drafted, and the gate — which reads the same placement — does not hold it `loop`.
   */
  it.each([
    ['voice note → voice line (unknown) → photo: the media line', 'voice', 'unknown', 'photo', 'media'],
    ['voice note → voice line (no_id) → photo: the media line', 'voice', 'no_id', 'photo', 'media'],
    ['photo → our reply (unknown) → photo: the media line', 'reply', 'unknown', 'photo', 'media'],
    ['photo → media line (unknown) → voice note: the voice line', 'media', 'unknown', 'voice', 'voice'],
  ] as const)('%s, his line in the second our send left', async (_, ours, shape, his, want) => {
    const base = min(1);
    if (ours === 'voice') await voiceNote(base);
    else await photo(base);
    const body = ours === 'voice' ? voiceLine() : ours === 'media' ? mediaLine() : 'Rahmat, qachon jo‘natmoqchisiz?';
    await lostSend(body, sec(base, 65.7), shape);
    const anchor = his === 'photo' ? await photo(sec(base, 65)) : await voiceNote(sec(base, 65));
    expect(await handleInbound(job(anchor), { callModel: never() })).toMatchObject({ outcome: 'draft' });
    const d = await pendingFor(anchor);
    expect((d!.policy as { system?: unknown }).system).toBe(want);
    expect((await gate(d!, min(3))).loop).toBe(false);
  });

  it('…and a photo in that second after our lost media line is the same silence: no second line', async () => {
    const base = min(1);
    await photo(base);
    await lostSend(mediaLine(), sec(base, 65.7), 'unknown');
    const again = await photo(sec(base, 65));
    expect(await handleInbound(job(again), { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
    expect(await pendingFor(again)).toBeUndefined();
  });

  it('…while a line a whole second before our lost send stands before it: our line answered it', async () => {
    const base = min(1);
    await voiceNote(base);
    await lostSend(voiceLine(), sec(base, 65.7), 'unknown');
    const before = await photo(sec(base, 64));
    // His photo came before the voice line, which answered his lines up to it: nothing after our newest send.
    expect(await handleInbound(job(before), { callModel: never() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
  });
});

describe('the loop at the moment a price would go (the merged-tree seam review, finding 6)', () => {
  it('a price written in the hold’s last two minutes is not refused `loop` at planning — its due time falls after the half hour', async () => {
    const anchor = await line('in', '5 kub 800 kg Yiwudan narxi?', min(9));
    const now = new Date();
    // The price's hold is the layer's (`holdSecFor`), read as stored; he was told so long ago that the half hour ends
    // halfway through it — still holding now, over by the time the price would go.
    const hold = (await readAutoConfig())!.holdSec * 1000;
    expect(hold).toBeGreaterThan(0);
    await db.insert(agentSignals).values({
      topic: 'loop',
      managerUserId: ownerId,
      peerId: PEER,
      clientId,
      facts: { signals: ['same_inbound'] },
      dedupeKey: loopSignalKey(ownerId, PEER, min(8)),
      createdAt: new Date(now.getTime() - 30 * 60_000 + hold / 2),
    });
    const price: AutoDraftShape = {
      managerUserId: ownerId,
      peerId: PEER,
      runId: null,
      clientId,
      leadId: null,
      anchorTgMessageId: anchor,
      kind: 'reply',
      status: 'pending',
      finalBody: null,
      proposedBody: '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $. Boj va QQS alohida hisoblanadi.',
      blocked: false,
      needsOwner: false,
      category: 'price',
      language: 'uz',
      confidence: '0.90',
      policy: {
        warnings: [],
        notes: [],
        noteCodes: [],
        ledger: [{ raw: '960 $', kind: 'money', source: 'tool', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }],
        memory: { hasEstimate: true },
      },
      actions: [],
    };
    const tools = [{ name: 'yolkira_estimate', ok: true, text: '', estimate: true }];
    // The fact at `now` still holds (the half hour is not over)…
    expect((await autoFactsFor(price, { at: now, now, tools, config: null })).loop).toBe(true);
    // …and the plan reads it where the price would go: one hold on, half a hold past the half hour.
    const plan = await autoPlanFor({ draft: price, tools, now });
    expect(plan).not.toBeNull();
    expect(plan!.holdSec * 1000).toBe(hold);
    expect(plan!.reasons).not.toContain('loop');
  });
});

describe('the echo window and his typing (the merged-tree seam review, finding 7)', () => {
  it('«ha» three seconds after our question is an echo — unless the listener saw him typing after it: then it is answered', async () => {
    await line('in', 'Yuk Yiwudan, 3 kub', min(1));
    await machineSend('Rastamojkani ham alohida hisoblab beraymi?', min(2));
    const yes = await line('in', 'ha', sec(min(2), 3));
    expect(await handleInbound(job(yes), { callModel: never() })).toEqual({ outcome: 'refused', reason: 'echo' });

    await clearChat();
    await line('in', 'Yuk Yiwudan, 3 kub', min(1));
    await machineSend('Rastamojkani ham alohida hisoblab beraymi?', min(2));
    const typed = await line('in', 'ha', sec(min(2), 3));
    // The listener's one stamp: he typed a second after our line went.
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, peerTypingAt: sec(min(2), 1) });
    expect(await handleInbound(job(typed), { callModel: answers('Yaxshi, tovar nomi va og‘irligini yozing.') })).toMatchObject({ outcome: 'draft' });
  });
});
