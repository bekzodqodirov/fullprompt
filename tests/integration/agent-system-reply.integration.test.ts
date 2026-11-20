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
  attachments,
  clients,
  notifications,
  roles,
  settings,
  tgAccountGuard,
  tgAccounts,
  tgMessageFlags,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { autoVerdict } from '@/modules/wms/agent/auto-gate';
import { autoFactsFor, type AutoDraftShape } from '@/modules/wms/agent/auto-send';
import { AgentConfigError, readAgentConfig, setAgentPersonaName, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { readAgentPersonaName } from '@/modules/platform/settings/service';
import { handleInbound } from '@/modules/wms/agent/run';
import { isSystemLine, SYSTEM_LINES, systemGlossUz } from '@/modules/wms/agent/system-reply';
import type { DraftPolicyJson } from '@/modules/wms/agent/types';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * The tayyor matn through the run (stage 1a P3, §4.4): a burst the model cannot answer — a photo or a file, a voice
 * note, Pashto — gets the code's line by the same road as any reply: eligibility, the caps, the policy, ONE draft
 * writer (J10), its card. No model is called; the run row names none; the draft is `other` with `policy.system` and
 * no note. Once per silence: while our last line is that line, the next such burst gets nothing — the photo's a ledger
 * row, the voice note's and the Pashto's still a notice to HIM. A sticker alone is skipped, as before.
 *
 * agent_config is shared CONFIGURATION (#183): snapshotted and put back. Fixture users are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`78${SUFFIX}`);
let ownerId = '';
let accountId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
/** The persona's stored row — CONFIGURATION (#183): snapshotted, put back. */
let personaRow: { value: unknown; updatedBy: string | null } | null = null;
let msgSeq = 2000n;
const madeFiles: string[] = [];
/** Each test's lines a second apart, ending near now (a burst is what came after our last line; none is «late»). */
let tick = 0;
const at = () => new Date(Date.now() - 90_000 + (tick += 1) * 1000);

async function inbound(body: string | null, file?: { contentType: string; fileName: string } | 'sticker'): Promise<bigint> {
  msgSeq += 1n;
  const [row] = await db
    .insert(tgMessages)
    .values({
      clientId,
      managerUserId: ownerId,
      peerId: PEER,
      tgMessageId: msgSeq,
      direction: 'in',
      body: body ?? '',
      hasMedia: file !== undefined,
      sentAt: at(),
    })
    .returning({ id: tgMessages.id });
  if (file && file !== 'sticker') {
    const [f] = await db
      .insert(attachments)
      .values({
        entityType: 'tg_message',
        entityId: row!.id,
        kind: file.contentType.startsWith('image/') ? 'photo' : 'file',
        storageKey: `agent-system-reply-test/${SUFFIX}/${row!.id}`,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: 10,
        uploadedBy: ownerId,
      })
      .returning({ id: attachments.id });
    madeFiles.push(f!.id);
  }
  return msgSeq;
}

/**
 * Our line, as the listener stores what went. `robot`: the account's own auto-reply (`auto_sent`) — an out line no
 * PERSON wrote, so the chat is not «his» for the pause (eligibility `humanActive`).
 */
async function outbound(body: string, robot = false): Promise<void> {
  msgSeq += 1n;
  const [row] = await db
    .insert(tgMessages)
    .values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction: 'out', body, sentAt: at() })
    .returning({ id: tgMessages.id });
  if (robot) await db.insert(tgMessageFlags).values({ messageId: row!.id, autoSent: true });
}

const PHOTO = { contentType: 'image/jpeg', fileName: 'invoice.jpg' };
const VOICE = { contentType: 'audio/ogg', fileName: 'voice_1.oga' };

const job = (anchor: bigint) => ({ managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(anchor), origin: 'live' as const });

/** A model that must not be called: a tayyor matn is the code's. */
function untouched(): CallModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const fn = (async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    throw new Error('the model was called for a tayyor matn');
  }) as CallModel & { requests: ModelRequest[] };
  fn.requests = requests;
  return fn;
}

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

async function notices() {
  return db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
}

async function runsOf() {
  return db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER));
}

async function clearChat() {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  if (madeFiles.length) await db.delete(attachments).where(inArray(attachments.id, madeFiles.splice(0)));
  await db.delete(tgMessageFlags).where(sql`${tgMessageFlags.messageId} IN (SELECT id FROM tg_messages WHERE peer_id = ${String(PEER)}::bigint)`);
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), sql`${notifications.type} LIKE 'Agent%'`));
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  const [p] = await db.select({ value: settings.value, updatedBy: settings.updatedBy }).from(settings).where(eq(settings.key, 'agent_persona_name'));
  personaRow = p ?? null;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}31`, fullName: `AI egasi ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  ownerId = u!.id;
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  await db.insert(userRoles).values({ userId: ownerId, roleId: r!.id });
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99892${SUFFIX}31`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `SR${SUFFIX}`, name: `Tayyor Matn ${SUFFIX}`, phones: [`+99897${SUFFIX}31`], salesManagerId: ownerId })
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
  tick = 0;
  await clearChat();
  await stampAgentPump(accountId, true);
});

const KICKS_FROM = new Date().toISOString();
afterAll(async () => {
  await dropDrainKicksSince(KICKS_FROM);
  await clearChat();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  await db.delete(settings).where(eq(settings.key, 'agent_persona_name'));
  if (personaRow) await db.insert(settings).values({ key: 'agent_persona_name', value: personaRow.value, updatedBy: personaRow.updatedBy });
  await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
});

describe('a photo-only burst: the media line, written by the code through the one draft writer', () => {
  it('no model; the draft is the line, `other`, `policy.system`, no note; the run row is `draft` with no model and no tokens', async () => {
    const anchor = await inbound(null, PHOTO);
    const model = untouched();
    const out = await handleInbound(job(anchor), { callModel: model });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    expect(model.requests).toHaveLength(0);
    const d = await liveDraft();
    expect(SYSTEM_LINES.media.uz.map((l) => l.text)).toContain(d!.proposedBody);
    expect(isSystemLine(d!.proposedBody)).toBe(true);
    expect(d!.category).toBe('other');
    expect(d!.confidence).toBeNull();
    const policy = d!.policy as DraftPolicyJson;
    expect(policy.system).toBe('media');
    // The card's explanation is drawn from `policy.system`, never stored as a note (a note would stop the reply).
    expect(policy.notes).toEqual([]);
    expect(policy.noteCodes).toEqual([]);
    const runs = await runsOf();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'draft', model: null, inputTokens: 0, outputTokens: 0, trigger: 'inbound' });
    // The card says what the customer sent and that the code answered — in Uzbek, not yet «ketdi».
    const card = await cardOf(d!.id);
    const text = String((card!.payload as { text?: unknown }).text);
    expect(text).toContain('📎 Mijoz rasm yoki fayl yubordi — javob — tayyor matn');
    expect(text).toContain(systemGlossUz('media'));
    // His notice is the card now: nothing else reaches him.
    expect(await notices()).toHaveLength(0);
  });

  it('a file (a document) is the media line too; a sticker alone is skipped, as before', async () => {
    const doc = await inbound(null, { contentType: 'application/pdf', fileName: 'invoice.pdf' });
    expect(await handleInbound(job(doc), { callModel: untouched() })).toMatchObject({ outcome: 'draft' });
    expect(((await liveDraft())!.policy as DraftPolicyJson).system).toBe('media');
    await clearChat();
    const sticker = await inbound(null, 'sticker');
    expect(await handleInbound(job(sticker), { callModel: untouched() })).toEqual({ outcome: 'skipped', reason: 'media_only' });
    expect(await liveDraft()).toBeNull();
    expect((await runsOf()).map((r) => r.outcome)).toEqual(['refused']);
  });

  it('a Cyrillic chat that said no language gets the Russian line — and it is not blocked (§4.4 finding 3)', async () => {
    await inbound('5 куб 800 кг');
    await outbound('Qayerdan jo‘natasiz?', true);
    // Half a minute later — a line seconds after ours is an echo the eligibility rule refuses.
    tick += 30;
    const anchor = await inbound(null, PHOTO);
    expect(await handleInbound(job(anchor), { callModel: untouched() })).toMatchObject({ outcome: 'draft', blocked: false });
    const d = await liveDraft();
    expect(d!.language).toBe('ru');
    expect(SYSTEM_LINES.media.ru.map((l) => l.text)).toContain(d!.proposedBody);
  });
});

describe('once per silence: the next such burst gets no second line', () => {
  it('a photo after our media line: a ledger row, no draft, no word to anybody', async () => {
    await outbound(SYSTEM_LINES.media.uz[0]!.text);
    const anchor = await inbound(null, PHOTO);
    const out = await handleInbound(job(anchor), { callModel: untouched() });
    expect(out).toEqual({ outcome: 'skipped', reason: 'media_only' });
    expect(await liveDraft()).toBeNull();
    expect((await runsOf()).map((r) => [r.outcome, r.error])).toEqual([['refused', 'media_only']]);
    expect(await notices()).toHaveLength(0);
  });

  it('a voice note: the first gets the voice line; the next — after the line went — tells HIM, never the customer again', async () => {
    const first = await inbound(null, VOICE);
    expect(await handleInbound(job(first), { callModel: untouched() })).toMatchObject({ outcome: 'draft' });
    const d = await liveDraft();
    expect((d!.policy as DraftPolicyJson).system).toBe('voice');
    // The line went (the listener stored it), and the customer sent another voice note.
    await db.update(agentDrafts).set({ status: 'approved' }).where(eq(agentDrafts.id, d!.id));
    await outbound(d!.proposedBody!);
    const second = await inbound(null, VOICE);
    expect(await handleInbound(job(second), { callModel: untouched() })).toEqual({ outcome: 'notice', reason: 'voice_only' });
    expect(await liveDraft()).toBeNull();
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(String((told[0]!.payload as { text?: unknown }).text)).toContain('yana ovozli xabar');
  });

  it('a voice note beside a sticker is a voice note — the voice line, not silence (§4.4 finding 1)', async () => {
    await inbound(null, VOICE);
    const anchor = await inbound(null, 'sticker');
    expect(await handleInbound(job(anchor), { callModel: untouched() })).toMatchObject({ outcome: 'draft' });
    expect(((await liveDraft())!.policy as DraftPolicyJson).system).toBe('voice');
  });
});

describe('Pashto: one line in Persian with a short Russian half, its gloss for him', () => {
  it('the first Pashto message gets the line (fa, glossed); the next, after it went, tells HIM', async () => {
    const first = await inbound('ستاسو بار څه وخت راځي');
    expect(await handleInbound(job(first), { callModel: untouched() })).toMatchObject({ outcome: 'draft', blocked: false });
    const d = await liveDraft();
    expect(d!.language).toBe('fa');
    expect(SYSTEM_LINES.pashto.map((l) => l.text)).toContain(d!.proposedBody);
    expect(d!.glossUz).toBe(systemGlossUz('pashto'));
    expect((d!.policy as DraftPolicyJson).system).toBe('pashto');
    await db.update(agentDrafts).set({ status: 'approved' }).where(eq(agentDrafts.id, d!.id));
    await outbound(d!.proposedBody!);
    const second = await inbound('زما بار ښه دی؟');
    expect(await handleInbound(job(second), { callModel: untouched() })).toEqual({ outcome: 'notice', reason: 'pashto' });
    expect(await notices()).toHaveLength(1);
  });

  it('Uyghur is no Pashto (J7): it goes to the model, never to the Persian-or-Russian line', async () => {
    const anchor = await inbound('يۈكنى ئېلىپ كېلىڭ');
    const model = untouched();
    // The model is asked (and this one throws: the run ends in an error, not in a tayyor matn).
    const out = await handleInbound(job(anchor), { callModel: model });
    expect(model.requests).toHaveLength(1);
    expect(out).toMatchObject({ outcome: 'error' });
  });
});

describe('the gate\'s two P3 facts, read off the stored chat and draft (`autoFactsFor`)', () => {
  /** A reply draft of this chat answering `anchor`, as `autoFactsFor` reads one. */
  const shape = (anchor: bigint, policy: Record<string, unknown>, language = 'uz'): AutoDraftShape => ({
    managerUserId: ownerId,
    peerId: PEER,
    runId: null,
    clientId,
    leadId: null,
    anchorTgMessageId: anchor,
    kind: 'reply',
    status: 'pending',
    finalBody: null,
    proposedBody: 'Tushunarli, hozir tekshirib aytaman.',
    blocked: false,
    needsOwner: false,
    category: 'other',
    language,
    confidence: '0.90',
    policy,
    actions: [],
  });
  const facts = (anchor: bigint, policy: Record<string, unknown> = {}, language = 'uz') =>
    autoFactsFor(shape(anchor, policy, language), { at: new Date(), now: new Date(), config: null });

  it('the complaint tripwire reads the customer\'s own burst — every line since our last one, and nothing before it', async () => {
    await inbound('Pulimni qaytaring, meni aldadingiz');
    await outbound('Tushunarli.', true);
    tick += 30;
    const calm = await inbound('Yukim qayerda?');
    expect((await facts(calm)).complaint).toBe(false);
    const angry = await inbound('Menejer kerak!');
    expect((await facts(angry)).complaint).toBe(true);
  });

  it('the honest line is a tayyor matn: in Persian or Chinese the gate keeps it his until he approved it (J27)', async () => {
    const anchor = await inbound('شما ربات هستید؟');
    const fa = await facts(anchor, { honestLine: true }, 'fa');
    expect(fa.draft.honestLine).toBe(true);
    expect(autoVerdict(fa).reasons).toContain('ready_text_unapproved');
    expect((await facts(anchor, {}, 'fa')).draft.honestLine).toBe(false);
    // The Uzbek honest line is no such card.
    const uz = await facts(anchor, { honestLine: true }, 'uz');
    expect(autoVerdict(uz).reasons).not.toContain('ready_text_unapproved');
  });
});

describe('the persona\'s name: one writer (the seat\'s door), one reader, the run\'s head', () => {
  const superAdmin = () => ({ id: ownerId, roles: ['super_admin'] });
  const ctx = () => ({ actorId: ownerId });

  it('a super_admin writes it — white space folded, a bad shape refused in its own code, \'\' clears it', async () => {
    expect(await setAgentPersonaName(superAdmin(), '  Zarina   Qo‘ziyeva ', ctx())).toBe('Zarina Qo‘ziyeva');
    expect(await readAgentPersonaName()).toBe('Zarina Qo‘ziyeva');
    await expect(setAgentPersonaName(superAdmin(), 'Zarina 2', ctx())).rejects.toMatchObject({ code: 'bad_value' });
    await expect(setAgentPersonaName(superAdmin(), 'x'.repeat(41), ctx())).rejects.toMatchObject({ code: 'bad_value' });
    expect(await setAgentPersonaName(superAdmin(), '', ctx())).toBe('');
    expect(await readAgentPersonaName()).toBe('');
  });

  it('nobody else writes it — the holder or a seller is refused, and nothing is stored', async () => {
    const before = await readAgentPersonaName();
    for (const roles of [['sales_manager'], ['admin'], []]) {
      await expect(setAgentPersonaName({ id: ownerId, roles }, 'Zarina', ctx())).rejects.toBeInstanceOf(AgentConfigError);
    }
    expect(await readAgentPersonaName()).toBe(before);
  });

  it('a value typed into the table by hand that the shape refuses is never spoken: the reader answers no name', async () => {
    await db.delete(settings).where(eq(settings.key, 'agent_persona_name'));
    await db.insert(settings).values({ key: 'agent_persona_name', value: 'Zarina 😊', updatedBy: null });
    expect(await readAgentPersonaName()).toBe('');
  });

  it('the run reads it once and the model\'s cached head carries it', async () => {
    await setAgentPersonaName(superAdmin(), 'Zarina', ctx());
    const anchor = await inbound('Assalomu alaykum, yuk bor');
    const heads: string[] = [];
    const model = (async (req: ModelRequest): Promise<ModelResponse> => {
      heads.push(String(req.systemCached ?? ''));
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'compose_reply',
            input: {
              reply_needed: true,
              reply_text: 'Assalomu alaykum! Yukingiz qayerdan?',
              language: 'uz',
              gloss_uz: '',
              category: 'qualification',
              confidence: 0.9,
              needs_owner: false,
              owner_question: '',
              next_step: 'qualify',
              actions: [],
              used_fact_ids: [],
              cited_message_refs: [],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }) as CallModel;
    expect(await handleInbound(job(anchor), { callModel: model })).toMatchObject({ outcome: 'draft' });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain('isming — Zarina');
    await setAgentPersonaName(superAdmin(), '', ctx());
  });
});
