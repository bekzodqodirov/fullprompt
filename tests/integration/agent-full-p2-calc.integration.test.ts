import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** pg-boss is never started in this process: every job a landing would queue (the AI VED pass, thumbnails) is caught here. */
const queued = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queued.push({ name, data });
  }),
}));

/**
 * Two seams in the machine's press, each a passthrough until a hook is armed — so «a ⏸ lands while the press is in
 * flight» is a deterministic interleaving, never a race:
 *  - `sendWindowFor` is asked by the gate's facts at the press and AGAIN by `decideDraft` just before it lands the
 *    calculation (`skip: 1` runs the hook on the second) — a stop there is a stop BEFORE the landing;
 *  - `landIntake` runs the hook after the real landing returned — a stop there is a stop AFTER the job exists and
 *    before the approval.
 */
const seam = vi.hoisted(() => ({
  window: null as null | { skip: number; run: () => Promise<void> },
  landed: null as null | (() => Promise<void>),
  /** Runs just before the real landing — after the press read the hand-back loop (fix pass 1). */
  beforeLand: null as null | (() => Promise<void>),
  /** The calculation's facts throw when armed — a db blip at the scheduling or the press (review tests). */
  factsThrow: false,
}));
vi.mock('@/modules/wms/agent/calc-submit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/agent/calc-submit')>();
  return {
    ...real,
    calcSubmitFacts: async (...args: Parameters<typeof real.calcSubmitFacts>) => {
      if (seam.factsThrow) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
      return real.calcSubmitFacts(...args);
    },
  };
});
vi.mock('@/modules/wms/agent/send-window', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/agent/send-window')>();
  return {
    ...real,
    sendWindowFor: async (...args: Parameters<typeof real.sendWindowFor>) => {
      const h = seam.window;
      if (h) {
        if (h.skip > 0) h.skip -= 1;
        else {
          seam.window = null;
          await h.run();
        }
      }
      return real.sendWindowFor(...args);
    },
  };
});
vi.mock('@/modules/wms/calc/intake-land', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/intake-land')>();
  return {
    ...real,
    landIntake: async (...args: Parameters<typeof real.landIntake>) => {
      const before = seam.beforeLand;
      if (before) {
        seam.beforeLand = null;
        await before();
      }
      const out = await real.landIntake(...args);
      const h = seam.landed;
      if (h) {
        seam.landed = null;
        await h();
      }
      return out;
    },
  };
});

import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoConfig,
  agentAutoVerdicts,
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  attachments,
  auditLog,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leadStages,
  leads,
  notifications,
  roles,
  tasks,
  tgAccountGuard,
  tgAccounts,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  tnvedAssignments,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { pressDueAutos, readAutoConfig, stopAuto, __restoreAutoConfig, type AutoConfig } from '@/modules/wms/agent/auto-send';
import { CALC_FILES_MAX, chatFilesForJob, copyChatFilesToNote } from '@/modules/wms/agent/calc-files';
import { calcLinkReplySent } from '@/modules/wms/agent/calc-loop';
import { renderDraftCard } from '@/modules/wms/agent/card-io';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { loadContext } from '@/modules/wms/agent/context';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { chatBlock } from '@/modules/wms/agent/prompt';
import { handleInbound, validateActions } from '@/modules/wms/agent/run';
import { runTool, type ToolEnv } from '@/modules/wms/agent/tools';
import { HAND_BACK_TASK_DONE, landIntake } from '@/modules/wms/calc/intake-land';
import { returnCalcRequest } from '@/modules/wms/calc/service';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * «Hisoblatishni o'zi yuboradi» against a real database (SPEC-P2-v2 §1, package P2): a calculation the machine lands
 * by itself — the gate's five facts at the scheduling and at the press, the landing race (the press asked again before
 * it lands; a job that landed while the reply did not go), the chat's files copied to the VED, the hand-back loop onto
 * the returned card, the law's figure asked before the job goes, the chain-following status, and the lead's stage on
 * the machine's own layer.
 *
 * The model is SCRIPTED (CI has no key). The machine's clock is `T0`, a daytime instant in the past (the gate refuses
 * the night); a person presses at the real now. CONFIGURATION is the next file's input on the one shared database
 * (#183): agent_config, agent_auto_config, the send switch and `crm_calc_stage` are snapshotted and put back, and the
 * stages, leads, clients and code this file mints are removed. Fixture people are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
let peerSeq = 0n;
const nextPeer = () => BigInt(`83${SUFFIX}`) * 100n + ++peerSeq;
const peers: bigint[] = [];

function machineClock(): Date {
  const now = new Date(Date.now() - 20 * 60_000);
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour >= 9 && hour < 20) return now;
  const t = new Date(now);
  t.setUTCHours(9, 0, 0, 0); // 14:00 Tashkent
  if (t.getTime() > now.getTime()) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
const T0 = machineClock();
const HOLD_MS = 120_000;
const DUE = new Date(T0.getTime() + HOLD_MS + 1_000);
const FOUR = ['greeting', 'qualification', 'faq', 'status'];
/** A second line in the same chat, five minutes after the first — still in the past. */
const LATER = new Date(T0.getTime() + 5 * 60_000);
const LATER_DUE = new Date(LATER.getTime() + HOLD_MS + 1_000);

let holderId = '';
let colleagueId = '';
let vedId = '';
let accountId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
let calcStageBefore: unknown = null;
let msgSeq = 9000n;
const stageIds = { start: '', calc: '', lost: '' };
const madeClients: string[] = [];
const madeLeads: string[] = [];
const madeStages: string[] = [];
const madeKeys: string[] = [];
let pivoName = '';

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function freshClient(seller: string | null = holderId): Promise<string> {
  const n = madeClients.length + 1;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `HC${SUFFIX}${n}`.slice(0, 10), name: `P2 hisob mijoz ${SUFFIX}-${n}`, phones: [`+99897${SUFFIX}${String(n).padStart(2, '0')}`], salesManagerId: seller })
    .returning({ id: clients.id });
  madeClients.push(c!.id);
  return c!.id;
}

async function freshLead(owner: string | null = holderId, stage: string = stageIds.start): Promise<string> {
  const [l] = await db
    .insert(leads)
    .values({ name: `P2 hisob lid ${SUFFIX}-${madeLeads.length + 1}`, stageId: stage, ownerId: owner, nextActionAt: '2026-12-30', nextActionNote: 'qo‘ng‘iroq' })
    .returning({ id: leads.id });
  madeLeads.push(l!.id);
  return l!.id;
}

type Owner = { clientId: string } | { leadId: string };

/** A customer's line in a chat, `ago` before T0 on the machine's clock. */
async function inbound(peer: bigint, owner: Owner, body: string, opts: { ago?: number; media?: boolean } = {}): Promise<{ tgId: bigint; rowId: string }> {
  msgSeq += 1n;
  const [row] = await db
    .insert(tgMessages)
    .values({
      ...('clientId' in owner ? { clientId: owner.clientId } : { leadId: owner.leadId }),
      managerUserId: holderId,
      peerId: peer,
      tgMessageId: msgSeq,
      direction: 'in',
      body,
      hasMedia: opts.media === true,
      sentAt: new Date(T0.getTime() - (opts.ago ?? 60_000)),
    })
    .returning({ id: tgMessages.id });
  return { tgId: msgSeq, rowId: row!.id };
}

/** A file this system KEPT from a customer's line — the bytes stored, the attachment on the message. */
async function keptFile(messageRowId: string, name = 'invoice.pdf'): Promise<string> {
  const key = `tg_message/${messageRowId}/p2-${SUFFIX}-${name}`;
  await getStorage().put(key, Buffer.from(`%PDF-1.4 ${name} ${SUFFIX}`), 'application/pdf');
  madeKeys.push(key);
  const [a] = await db
    .insert(attachments)
    .values({ entityType: 'tg_message', entityId: messageRowId, storageKey: key, fileName: name, contentType: 'application/pdf', sizeBytes: 20, uploadedBy: holderId })
    .returning({ id: attachments.id });
  return a!.id;
}

function scripted(steps: { name: string; input: Record<string, unknown> }[]): CallModel {
  let i = 0;
  return (async (_req: ModelRequest): Promise<ModelResponse> => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel;
}

/**
 * The submit reply — worded apart per draft: G10's same-text fuse WARNS from the fourth chat a day that got the very
 * same short text, and a warning refuses every machine press (that is a fact of production too, said in the report).
 */
let replySeq = 0;
const letters = (n: number) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');
function submitReply(): string {
  replySeq += 1;
  return `Hisoblatishga yubordim, javob kelishi bilan aytaman, ${letters(Number(SUFFIX))}${letters(replySeq)}.`;
}

function submitSteps(section: string, goods: Record<string, unknown>[], category = 'price') {
  return [
    { name: 'calc_checklist', input: { section, goods } },
    {
      name: 'compose_reply',
      input: {
        reply_needed: true,
        reply_text: submitReply(),
        language: 'uz',
        gloss_uz: '',
        // The model's label for a submit reply — the gate judges the draft by its ACTION (among the labels that go).
        category,
        confidence: 0.9,
        needs_owner: false,
        owner_question: '',
        next_step: 'calc',
        actions: [{ type: 'calc_submit', section, cited_message_refs: ['#1'], date: '', note: '' }],
        used_fact_ids: [],
        cited_message_refs: [],
      },
    },
  ];
}

const PODKLYUCH_LINE = 'Xitoydan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona';
const PODKLYUCH_GOODS = [{ name: 'kurtka', quantity: 100, unit: null, weight_kg: null }];

/** The customer's request and the inbound run that drafts it, on the machine's clock; its card reached him then. */
async function drafted(
  peer: bigint,
  owner: Owner,
  opts: { body?: string; section?: string; goods?: Record<string, unknown>[]; media?: boolean; file?: string; now?: Date; category?: string } = {},
) {
  const now = opts.now ?? T0;
  const { tgId, rowId } = await inbound(peer, owner, opts.body ?? PODKLYUCH_LINE, { media: opts.media || opts.file !== undefined, ago: T0.getTime() - now.getTime() + 60_000 });
  // The file the listener kept from that line, before any run reads the chat.
  if (opts.file !== undefined) await keptFile(rowId, opts.file);
  const out = await handleInbound(
    { managerUserId: holderId, peerId: String(peer), anchorTgMessageId: String(tgId), origin: 'live' },
    { callModel: scripted(submitSteps(opts.section ?? 'podklyuch', opts.goods ?? PODKLYUCH_GOODS, opts.category)), now: () => now },
  );
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const draftId = (out as { draftId: string }).draftId;
  await shown(draftId, now);
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  return { d: d!, rowId };
}

/** His Telegram shows this draft's card since `at` — what the staff drain writes when it sends it. */
let cardSeq = 500;
async function shown(draftId: string, at: Date) {
  cardSeq += 1;
  const merge = { tg: { chatId: 7_800_000_000 + Number(SUFFIX), messageId: cardSeq }, shown: { draftId, at: at.toISOString() } };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: at, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

const verdictOf = async (draftId: string) => (await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId)))[0] ?? null;
const draftOf = async (draftId: string) => (await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId)))[0]!;
const requestsOn = async (noteId: string) => db.select().from(calcRequests).where(eq(calcRequests.noteId, noteId));
const outboxOf = async (draftId: string) => db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
const person = () => ({ id: holderId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });

async function digestOf(draftId: string): Promise<string> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return (row!.payload as { digest: string }).digest;
}

async function armAuto(categories: string[] = [...FOUR, 'calc']) {
  await db
    .update(agentAutoConfig)
    .set({ armedAt: new Date(T0.getTime() - 3_600_000), armedBy: holderId, holdSec: HOLD_MS / 1000, perDay: null, maxChars: 400, minConfidence: '0.80', categories, disarmedAt: null, disarmReason: null })
    .where(eq(agentAutoConfig.id, 1));
}

async function cleanChats() {
  if (peers.length === 0) return;
  await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.peerId, peers));
  await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, peers));
  await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, peers));
  await db.delete(agentRuns).where(inArray(agentRuns.peerId, peers));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, peers));
  await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, peers));
  const msgs = (await db.select({ id: tgMessages.id }).from(tgMessages).where(inArray(tgMessages.peerId, peers))).map((m) => m.id);
  if (msgs.length) await db.delete(attachments).where(and(eq(attachments.entityType, 'tg_message'), inArray(attachments.entityId, msgs)));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, peers));
  await db.delete(notifications).where(and(inArray(notifications.userId, [holderId, colleagueId, vedId]), like(notifications.type, 'Agent%')));
}

function newPeer(): bigint {
  const p = nextPeer();
  peers.push(p);
  return p;
}

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  if (!agentSnapshot || !autoSnapshot) throw new Error('0138/0145 are not applied on this database');
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  calcStageBefore = await getSetting('crm_calc_stage');
  holderId = await makeUser(`P2 hisob egasi ${SUFFIX}`, 'super_admin', '01');
  colleagueId = await makeUser(`P2 hisob hamkasb ${SUFFIX}`, 'sales_manager', '02');
  vedId = await makeUser(`P2 hisob VED ${SUFFIX}`, 'ved_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: holderId, tgPhone: `+99892${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  for (const [key, kind, sortOrder] of [
    ['start', 'open', 9_201],
    ['calc', 'open', 9_202],
    ['lost', 'lost', 9_203],
  ] as const) {
    const [s] = await db.insert(leadStages).values({ name: `P2 hisob ${key} ${SUFFIX}`, kind, sortOrder }).returning({ id: leadStages.id });
    stageIds[key] = s!.id;
    madeStages.push(s!.id);
  }
  await setSetting('crm_calc_stage', stageIds.calc, holderId);
  // A product the exact-key book codes to a litre law (2203 — beer: «max» with $1/litr): the act asks its litres.
  pivoName = `Pivo${letters(Number(SUFFIX))}`;
  const { productKey } = await import('@/modules/wms/tnved/service');
  await db.insert(tnvedAssignments).values({ productKey: productKey(pivoName), productNameZh: pivoName, productNameRu: pivoName, tnvedCode: '2203001000', source: 'manual', assignedBy: holderId });
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: holderId,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: holderId,
      startedAt: new Date(Date.now() - 30 * 86_400_000),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
      humanPauseMin: 120,
    })
    .where(eq(agentConfig.id, 1));
  await setSetting('tg_sending_enabled', true, holderId);
});

beforeEach(async () => {
  seam.window = null;
  seam.landed = null;
  seam.beforeLand = null;
  seam.factsThrow = false;
  queued.length = 0;
  await armAuto();
  await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  seam.window = null;
  seam.landed = null;
  try {
    await cleanChats();
    const requests = await db
      .select({ id: calcRequests.id, taskId: calcRequests.taskId, noteId: calcRequests.noteId })
      .from(calcRequests)
      .where(inArray(calcRequests.requestedBy, [holderId, vedId, colleagueId]));
    const requestIds = requests.map((r) => r.id);
    const dealIds = madeClients.length ? (await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, madeClients))).map((d) => d.id) : [];
    const cards = [...dealIds, ...madeLeads];
    // The tasks this file's landings made — found by the requests and the cards, NEVER by assignee alone: the VED rota
    // hands a landed job to whoever holds the role, the seeded «VED Demo» included (review tests: 7 open «Hisoblash»
    // tasks per run were left on a person the browser suite logs in as, #154/#183).
    const taskIds = new Set(requests.map((r) => r.taskId).filter((id): id is string => id !== null));
    const byWhat = [inArray(tasks.assigneeId, [holderId, vedId, colleagueId])];
    if (requestIds.length) byWhat.push(inArray(tasks.boundId, requestIds));
    if (cards.length) byWhat.push(inArray(tasks.entityId, cards));
    for (const t of await db.select({ id: tasks.id }).from(tasks).where(or(...byWhat))) taskIds.add(t.id);
    if (requestIds.length) {
      await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
      await db.update(calcRequests).set({ supersedesRequestId: null }).where(inArray(calcRequests.id, requestIds));
      await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
    }
    if (taskIds.size) {
      await db.delete(events).where(inArray(events.entityId, [...taskIds]));
      await db.delete(notifications).where(sql`${notifications.payload}->>'taskId' IN (${sql.join([...taskIds].map((id) => sql`${id}`), sql`, `)})`);
      await db.delete(tasks).where(inArray(tasks.id, [...taskIds]));
    }
    if (cards.length) {
      const notes = (await db.select({ id: crmActivities.id }).from(crmActivities).where(inArray(crmActivities.entityId, cards))).map((n) => n.id);
      if (notes.length) {
        const copies = await db.select({ key: attachments.storageKey }).from(attachments).where(and(eq(attachments.entityType, 'crm_activity'), inArray(attachments.entityId, notes)));
        for (const c of copies) await getStorage().delete(c.key);
        await db.delete(attachments).where(and(eq(attachments.entityType, 'crm_activity'), inArray(attachments.entityId, notes)));
        await db.delete(crmActivities).where(inArray(crmActivities.id, notes));
      }
      await db.delete(events).where(inArray(events.entityId, cards));
    }
    if (dealIds.length) await db.delete(deals).where(inArray(deals.id, dealIds));
    if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
    if (madeStages.length) await db.delete(leadStages).where(inArray(leadStages.id, madeStages));
    if (madeClients.length) {
      await db.delete(events).where(inArray(events.entityId, madeClients));
      await db.delete(clients).where(inArray(clients.id, madeClients));
    }
    await db.delete(tnvedAssignments).where(eq(tnvedAssignments.productNameZh, pivoName));
    for (const key of madeKeys) await getStorage().delete(key);
    await db.delete(notifications).where(inArray(notifications.userId, [holderId, colleagueId, vedId]));
    await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
    await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  } finally {
    await __restoreAgentConfig(agentSnapshot);
    await __restoreAutoConfig(autoSnapshot);
    await setSetting('tg_sending_enabled', sendingBefore, null);
    await setSetting('crm_calc_stage', (calcStageBefore as string) ?? '', null);
    await db.update(users).set({ active: false }).where(inArray(users.id, [holderId, colleagueId, vedId]));
  }
});

describe('an auto submit with a complete checklist — landed, linked, the files copied, the reply sent (§1.1, §1.2, §1.4)', () => {
  it('one job, linked AT the landing, the neutral note, the chat’s file copied once, the reply queued', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const { d } = await drafted(peer, { clientId }, { file: 'invoice.pdf' });
    // The customer's burst carried a file: `media` is not asked of a calculation — the invoice goes to the VED.
    expect(await verdictOf(d.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await pressDueAutos(DUE)).toBe(1);
    const noteId = noteIdFor(d.id);
    const reqs = await requestsOn(noteId);
    expect(reqs).toHaveLength(1);
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, reqs[0]!.id));
    expect(link).toMatchObject({ draftId: d.id, rootRequestId: reqs[0]!.id, managerUserId: holderId, peerId: peer });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteId));
    expect(note!.note).toContain("AI sotuvchi mijozning Telegram suhbatidan yig'di.");
    expect(note!.note).not.toContain('egasi tasdiqladi');
    expect(note!.note).toContain('Chatdan 1 ta fayl VEDga biriktirildi: invoice.pdf.');
    const copies = await db.select().from(attachments).where(and(eq(attachments.entityType, 'crm_activity'), eq(attachments.entityId, noteId)));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ fileName: 'invoice.pdf', kind: 'file' });
    expect((await getStorage().get(copies[0]!.storageKey)).toString()).toContain(`invoice.pdf ${SUFFIX}`);
    // A re-press (or the K26 re-ask) copies nothing twice.
    await copyChatFilesToNote({ managerUserId: holderId, peerId: peer, noteId, draftId: d.id, uploadedBy: holderId });
    expect(await db.select().from(attachments).where(and(eq(attachments.entityType, 'crm_activity'), eq(attachments.entityId, noteId)))).toHaveLength(1);
    const out = await outboxOf(d.id);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatch(/^Hisoblatishga yubordim, javob kelishi bilan aytaman, [a-j]+\.$/u);
    expect((await verdictOf(d.id))!.state).toBe('pressed');
    // The link says whether its submitting reply WENT (§1.2) — through the draft's outbox row: queued is not sent.
    expect(await calcLinkReplySent(reqs[0]!.id)).toBe(false);
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.id, out[0]!.id));
    expect(await calcLinkReplySent(reqs[0]!.id)).toBe(true);
  });

  it('his ✅ copies the files too, and the material line says so (an intended change of his path)', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const { d } = await drafted(peer, { clientId }, { file: 'packing.pdf' });
    expect(await decideDraft(person(), d.id, 'send', { digest: await digestOf(d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d.id)));
    expect(note!.note).toContain('Chatdan 1 ta fayl VEDga biriktirildi: packing.pdf.');
    expect(note!.note).not.toContain('Telegram suhbatida.)');
  });
});

describe('the landing race (§1.2)', () => {
  it('⏸ between the landing and the approval: one job, linked, no reply, the card says «VEDga tushdi» — and a later ✅ reuses the job', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const { d } = await drafted(peer, { clientId });
    seam.landed = async () => {
      expect(await stopAuto(holderId, d.id)).toEqual({ ok: true });
    };
    expect(await pressDueAutos(DUE)).toBe(0);
    const noteId = noteIdFor(d.id);
    const reqs = await requestsOn(noteId);
    expect(reqs).toHaveLength(1);
    expect(await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, reqs[0]!.id))).toHaveLength(1);
    expect(await outboxOf(d.id)).toHaveLength(0);
    const after = await draftOf(d.id);
    expect(after).toMatchObject({ status: 'pending', actionError: 'landed_unsent' });
    const card = renderDraftCard(after, null);
    expect(card).toContain('🧮 VEDga tushdi');
    expect(card).not.toContain('navbatga qo‘yilmoqda');
    // His ✅ later: the same job, never a second one.
    expect(await decideDraft(person(), d.id, 'send', { digest: await digestOf(d.id) }, { actorId: holderId })).toMatchObject({ ok: true, requestId: reqs[0]!.id });
    expect(await requestsOn(noteId)).toHaveLength(1);
    expect(await outboxOf(d.id)).toHaveLength(1);
    expect((await draftOf(d.id)).actionError).toBeNull();
  });

  it('a stop that lands BEFORE the landing (asked again just before it): no job, no note, no link at all', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const { d } = await drafted(peer, { clientId });
    // The gate's facts ask the chat's window first; `decideDraft` asks it again right before the landing.
    seam.window = { skip: 1, run: async () => void (await stopAuto(holderId, d.id)) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await requestsOn(noteIdFor(d.id))).toHaveLength(0);
    expect(await db.select().from(crmActivities).where(eq(crmActivities.id, noteIdFor(d.id)))).toHaveLength(0);
    expect(await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.draftId, d.id))).toHaveLength(0);
    expect((await verdictOf(d.id))!.state).toBe('stopped');
  });
});

describe('the gate’s five facts (§1.1)', () => {
  it('a second request of the same section within 14 days waits (`calc_recent`) — his ✅ lands as today: a NEW deal', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    // The VED answered: the chain is no longer open — a second submit is a duplicate, not «one already waiting».
    await db.update(calcRequests).set({ completedAt: new Date(), completedVia: 'lines' }).where(eq(calcRequests.id, r1!.id));
    const second = await drafted(peer, { clientId }, { body: 'Yana podklyuch: 4 kub 600 kg, kurtka 150 dona, Xitoydan Toshkentga', goods: [{ name: 'kurtka', quantity: 150, unit: null, weight_kg: null }], now: LATER });
    const v = await verdictOf(second.d.id);
    expect(v!.eligible).toBe(false);
    expect(v!.reasons).toEqual(['calc_recent']);
    const [deal1] = await db.select({ code: deals.code }).from(deals).where(eq(deals.id, r1!.entityId));
    expect(((second.d.policy as { notes?: string[] }).notes ?? []).join(' ')).toContain(`🧮 14 kun ichida shu chatdan hisoblatish bor (${deal1!.code}): ✅ yangi so‘rov ochadi.`);
    expect(await decideDraft(person(), second.d.id, 'send', { digest: await digestOf(second.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    expect(await db.select().from(deals).where(eq(deals.clientId, clientId))).toHaveLength(2);
  });

  it('a member of a linked chain still open (a correction the VED opened) → waits', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    // Long answered — outside the 14 days on its own…
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(Date.now() - 20 * 86_400_000), completedVia: 'lines', requestedAt: new Date(Date.now() - 21 * 86_400_000) })
      .where(eq(calcRequests.id, r1!.id));
    await db.update(agentCalcLinks).set({ createdAt: new Date(Date.now() - 21 * 86_400_000) }).where(eq(agentCalcLinks.requestId, r1!.id));
    const second = await drafted(peer, { clientId }, { body: 'Yana podklyuch: 4 kub 600 kg, kurtka 150 dona, Xitoydan Toshkentga', goods: [{ name: 'kurtka', quantity: 150, unit: null, weight_kg: null }], now: LATER });
    expect(await verdictOf(second.d.id)).toMatchObject({ eligible: true, state: 'waiting' });
    // …and during the hold the VED opens a correction on it: at the press, the chain is open again.
    await db.execute(sql`
      INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, section, supersedes_request_id, note_id)
      SELECT entity_type, entity_id, ${vedId}::uuid, item_count, now() + interval '1 hour', section, id, note_id FROM calc_requests WHERE id = ${r1!.id}::uuid`);
    expect(await pressDueAutos(LATER_DUE)).toBe(0);
    expect((await verdictOf(second.d.id))!.reasons).toContain('calc_recent');
    expect(await requestsOn(noteIdFor(second.d.id))).toHaveLength(0);
  });

  it('a colleague’s job on the client’s deal within 14 days → waits', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const [c] = await db.select({ code: clients.clientCode, name: clients.name }).from(clients).where(eq(clients.id, clientId));
    // The VED's own request for this client, through the bot's door: a deal of the client, requested by somebody else.
    const landed = await landIntake({
      machine: false,
      noteId: randomUUID(),
      section: 'podklyuch',
      facts: { fromCity: 'Xitoy', toCity: 'Toshkent', weightKg: 300, volumeM3: 2, goods: [{ name: 'shim', quantity: 50 }] },
      steps: [],
      fileCount: 0,
      collectedBy: vedId,
      collectedByName: 'VED',
      client: { id: clientId, clientCode: c!.code, name: c!.name },
      leadName: '',
      leadPhone: null,
      intakeDoor: null,
    });
    expect(landed.kind).toBe('deal');
    const { d } = await drafted(peer, { clientId });
    expect((await verdictOf(d.id))!.reasons).toEqual(['calc_recent']);
  });

  it('a lead owned by a colleague → `calc_foreign`; a typed-code client never proven → `calc_identity`', async () => {
    const leadPeer = newPeer();
    const theirs = await freshLead(colleagueId);
    const a = await drafted(leadPeer, { leadId: theirs });
    expect((await verdictOf(a.d.id))!.reasons).toEqual(['calc_foreign']);

    const typedPeer = newPeer();
    const clientId = await freshClient();
    await db.insert(tgChatRules).values({ managerUserId: holderId, peerId: typedPeer, decision: 'include', clientId, peerTitle: 'Notanish', decidedBy: holderId, decidedAt: new Date() });
    await db.insert(agentConversations).values({ managerUserId: holderId, peerId: typedPeer, identityStrength: 'typed_code', identityClientId: clientId });
    const b = await drafted(typedPeer, { clientId });
    expect((await verdictOf(b.d.id))!.reasons).toContain('calc_identity');
  });

  it('a lead closed between the draft and the press → `calc_refused`, and nothing lands', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    const { d } = await drafted(peer, { leadId: lead });
    expect(await verdictOf(d.id)).toMatchObject({ eligible: true, state: 'waiting' });
    await db.update(leads).set({ stageId: stageIds.lost, lostReason: 'qimmat' }).where(eq(leads.id, lead));
    expect(await pressDueAutos(DUE)).toBe(0);
    expect((await verdictOf(d.id))!.reasons).toContain('calc_refused');
    expect(await requestsOn(noteIdFor(d.id))).toHaveLength(0);
  });

  it('a file the customer sent that this system did not keep → `calc_file_missing`, the card names its day', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const { d } = await drafted(peer, { clientId }, { media: true });
    const v = await verdictOf(d.id);
    expect(v!.reasons).toEqual(['calc_file_missing']);
    expect(((d.policy as { notes?: string[] }).notes ?? []).join(' ')).toMatch(/📎 \d\d\.\d\d dagi fayl saqlanmagan — ✅ bossangiz faylsiz yuboriladi; faylni VEDga o‘zingiz bering\./u);
  });

  it('a submit the model labelled «complaint» or «other» stays his — the arming words promise it (finding 8)', async () => {
    for (const category of ['complaint', 'other']) {
      const peer = newPeer();
      const clientId = await freshClient();
      const { d } = await drafted(peer, { clientId }, { body: `Oldingi safar narxingiz juda qimmat chiqdi, norozimiz! Yangi yuk: ${PODKLYUCH_LINE}`, category });
      expect((await verdictOf(d.id))!.reasons, category).toEqual(['category']);
    }
    expect(await pressDueAutos(DUE)).toBe(0);
  });

  it('«Hisoblatish» unticked: the calculation is judged exactly as before — an action, refused; no fact of it read', async () => {
    await armAuto([...FOUR]);
    const peer = newPeer();
    const lead = await freshLead(colleagueId);
    const { d } = await drafted(peer, { leadId: lead });
    // A colleague's lead would be `calc_foreign` — unticked, nothing of the calculation is asked.
    expect((await verdictOf(d.id))!.reasons).toEqual(['actions', 'category']);
  });
});

describe('the hand-back loop lands on the returned card (§1.5)', () => {
  it('VED «Qaytarish» → the customer answers → the machine resubmits ON THE SAME DEAL, the «↩️» task closed, no `calc_recent`', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await pressDueAutos(DUE)).toBe(1);
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    await returnCalcRequest(r1!.id, 'tovar nomi yetarli emas', { actorId: vedId });
    const [task] = await db.select().from(tasks).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, r1!.entityId)));
    expect(task).toMatchObject({ status: 'open', assigneeId: holderId });
    const later = LATER;
    const second = await drafted(peer, { clientId }, {
      body: 'Kurtka — erkaklar qishki kurtkasi, 100 dona; 3 kub 500 kg; Xitoydan Toshkentga podklyuch',
      goods: [{ name: 'erkaklar qishki kurtkasi', quantity: 100, unit: null, weight_kg: null }],
      now: later,
    });
    expect(await verdictOf(second.d.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await pressDueAutos(new Date(later.getTime() + HOLD_MS + 1_000))).toBe(1);
    const [r2] = await requestsOn(noteIdFor(second.d.id));
    expect(r2).toMatchObject({ entityType: 'deal', entityId: r1!.entityId });
    expect(r2!.supersedesRequestId).toBeNull();
    expect(await db.select().from(deals).where(eq(deals.clientId, clientId))).toHaveLength(1);
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, r2!.id));
    expect(link!.rootRequestId).toBe(r1!.id);
    const [closed] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(closed).toMatchObject({ status: 'done', result: HAND_BACK_TASK_DONE, doneBy: holderId });
    // The context reads ONE chain — the resubmission, open.
    const ctx = await loadContext(holderId, peer, null);
    expect(ctx.openCalcs).toHaveLength(1);
    expect(ctx.openCalcs[0]).toMatchObject({ requestId: r2!.id, status: 'open' });
  });
});

describe('the hand-back loop is bounded — an old return, a closed card, a closed ↩️ task are no loop (findings 7, 10)', () => {
  /** A podklyuch job the VED handed back, its card then left as `after` says — and the customer asks about a NEW shipment. */
  async function returnedThen(machine: boolean, after: { ageDays: number; lost?: boolean; taskDone?: boolean }) {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    if (machine) expect(await pressDueAutos(DUE)).toBe(1);
    else expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    await returnCalcRequest(r1!.id, 'tovar nomi yetarli emas', { actorId: vedId });
    if (after.ageDays > 0) {
      await db.execute(sql`UPDATE calc_requests SET requested_at = now() - make_interval(days => ${after.ageDays}), completed_at = now() - make_interval(days => ${after.ageDays - 1}) WHERE id = ${r1!.id}::uuid`);
      await db.execute(sql`UPDATE agent_calc_links SET created_at = now() - make_interval(days => ${after.ageDays}) WHERE request_id = ${r1!.id}::uuid`);
    }
    if (after.lost) {
      const { dealStages } = await import('@/modules/platform/db/schema');
      const [lost] = await db.select({ id: dealStages.id }).from(dealStages).where(eq(dealStages.kind, 'lost')).limit(1);
      await db.update(deals).set({ stageId: lost!.id }).where(eq(deals.id, r1!.entityId));
    }
    if (after.taskDone) {
      await db.update(tasks).set({ status: 'done', doneAt: new Date(), doneBy: holderId, result: 'o‘zim so‘radim' }).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, r1!.entityId)));
    }
    const second = await drafted(peer, { clientId }, {
      body: 'Yangi yuk: oyinchoqlar 2000 dona, 5 kub 900 kg, Xitoydan Toshkentga podklyuch',
      goods: [{ name: 'oyinchoqlar', quantity: 2000, unit: null, weight_kg: null }],
      now: LATER,
    });
    return { peer, clientId, r1: r1!, second: second.d };
  }

  it('returned 120 days ago, its deal lost: his ✅ opens a NEW deal and leaves the old ↩️ task alone', async () => {
    await armAuto([...FOUR]);
    const x = await returnedThen(false, { ageDays: 120, lost: true });
    expect(await decideDraft(person(), x.second.id, 'send', { digest: await digestOf(x.second.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r2] = await requestsOn(noteIdFor(x.second.id));
    expect(r2!.entityId).not.toBe(x.r1.entityId);
    expect(await db.select().from(deals).where(eq(deals.clientId, x.clientId))).toHaveLength(2);
    const [task] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, x.r1.entityId)));
    expect(task!.status).toBe('open');
  });

  it('returned 60 days ago, its deal lost: the machine lands the new shipment as a NEW job on a NEW deal', async () => {
    const x = await returnedThen(true, { ageDays: 60, lost: true });
    expect(await verdictOf(x.second.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await pressDueAutos(LATER_DUE)).toBe(1);
    const [r2] = await requestsOn(noteIdFor(x.second.id));
    expect(r2!.entityId).not.toBe(x.r1.entityId);
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, r2!.id));
    expect(link!.rootRequestId).toBe(r2!.id);
    const [task] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, x.r1.entityId)));
    expect(task!.status).toBe('open');
  });

  it('returned 30 days ago, its deal still open and its ↩️ task still open: no loop — the new shipment is a NEW job', async () => {
    const x = await returnedThen(true, { ageDays: 30 });
    expect(await verdictOf(x.second.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await pressDueAutos(LATER_DUE)).toBe(1);
    const [r2] = await requestsOn(noteIdFor(x.second.id));
    expect(r2!.entityId).not.toBe(x.r1.entityId);
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, r2!.id));
    expect(link!.rootRequestId).toBe(r2!.id);
  });

  it('returned yesterday but its deal lost since — no loop: the 14-day rule waits it for him', async () => {
    const x = await returnedThen(true, { ageDays: 0, lost: true });
    expect((await verdictOf(x.second.id))!.reasons).toEqual(['calc_recent']);
  });

  it('returned yesterday, the deal open, but he closed the ↩️ task himself — no loop: the 14-day rule waits it for him', async () => {
    const x = await returnedThen(true, { ageDays: 0, taskDone: true });
    expect((await verdictOf(x.second.id))!.reasons).toEqual(['calc_recent']);
  });

  it('the deal lost between the press reading the loop and the landing: a NEW deal, a chain of its own, the old task left open', async () => {
    const x = await returnedThen(true, { ageDays: 0 });
    expect(await verdictOf(x.second.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    const { dealStages } = await import('@/modules/platform/db/schema');
    const [lost] = await db.select({ id: dealStages.id }).from(dealStages).where(eq(dealStages.kind, 'lost')).limit(1);
    seam.beforeLand = async () => {
      await db.update(deals).set({ stageId: lost!.id }).where(eq(deals.id, x.r1.entityId));
    };
    expect(await pressDueAutos(LATER_DUE)).toBe(1);
    const [r2] = await requestsOn(noteIdFor(x.second.id));
    expect(r2!.entityId).not.toBe(x.r1.entityId);
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, r2!.id));
    expect(link!.rootRequestId).toBe(r2!.id);
    const [task] = await db.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, x.r1.entityId)));
    expect(task!.status).toBe('open');
  });
});

describe('the context follows the chain (§1.7)', () => {
  it('a correction open on a linked chain: the prompt says «VEDda kutilmoqda» and a second submit is dropped', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    await db.update(calcRequests).set({ completedAt: new Date(), completedVia: 'lines' }).where(eq(calcRequests.id, r1!.id));
    expect((await loadContext(holderId, peer, null)).openCalcs[0]!.status).toBe('answered');
    await db.execute(sql`
      INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, section, supersedes_request_id, note_id)
      SELECT entity_type, entity_id, ${vedId}::uuid, item_count, now() + interval '1 hour', section, id, note_id FROM calc_requests WHERE id = ${r1!.id}::uuid`);
    const ctx = await loadContext(holderId, peer, null);
    expect(ctx.openCalcs[0]!.status).toBe('open');
    expect(chatBlock(ctx)).toContain('podklyuch: VEDda kutilmoqda');
    const { actions, notes } = validateActions(
      { actions: [{ type: 'calc_submit', section: 'podklyuch', citedMessageRefs: [], date: '', note: '' }] } as unknown as Parameters<typeof validateActions>[0],
      ctx,
      [{ ok: true, text: '', sources: [], checklist: { section: 'podklyuch', facts: { fromCity: 'Xitoy', toCity: 'Toshkent', weightKg: 500, volumeM3: 3, goods: [{ name: 'kurtka', quantity: 100 }] }, complete: true, fromOurWarehouse: false } }],
      new Date(),
    );
    expect(actions).toHaveLength(0);
    expect(notes).toContain('Bu chatda ochiq hisoblatish bor — ikkinchisi yuborilmaydi.');
  });
});

describe('the law’s figure is asked before the job goes, while the act is armed (§1.6)', () => {
  async function checklistFor(peer: bigint, lines: string[], goods: Record<string, unknown>[], calcArmed: boolean) {
    const lead = await freshLead();
    for (const body of lines) await inbound(peer, { leadId: lead }, body);
    const ctx = await loadContext(holderId, peer, null);
    const env: ToolEnv = { ctx, day: '2026-11-14', aviaUsdPerKg: null, kb: async () => [], chinaPlaces: async () => new Set(), priceArmed: false, calcArmed, calcPricing: false };
    return runTool('calc_checklist', { section: 'rastamojka', goods }, env);
  }

  it('armed: «Pivo, 1100 kg» under a litre law is asked «hajmi (litr)»; «1000 litr» closes it', async () => {
    const peer = newPeer();
    const asked = await checklistFor(peer, ['Rastamojka kerak: 2 kub 1200 kg', `${pivoName} 1100 kg`], [{ name: pivoName, quantity: null, unit: null, weight_kg: 1100 }], true);
    expect(asked.checklist!.complete).toBe(false);
    expect(asked.text).toContain(`• «${pivoName}»: hajmi (litr)`);
    expect(asked.text).not.toContain('kod so‘ragan o‘lchov');
    // The code is used to read the law and never written onto the job's facts: the INSERT codes the row itself.
    expect(JSON.stringify(asked.checklist!.facts)).not.toContain('2203');
    const answered = await checklistFor(peer, ['1000 litr'], [{ name: pivoName, quantity: 1000, unit: 'litr', weight_kg: 1100 }], true);
    expect(answered.checklist!.complete, answered.text).toBe(true);
    expect(answered.checklist!.facts.goods![0]).toMatchObject({ measureUnit: 'litr', measureQty: 1000 });
  });

  it('disarmed: today’s checklist — the line’s kilos are enough', async () => {
    const peer = newPeer();
    const off = await checklistFor(peer, ['Rastamojka kerak: 2 kub 1200 kg', `${pivoName} 1100 kg`], [{ name: pivoName, quantity: null, unit: null, weight_kg: 1100 }], false);
    expect(off.checklist!.complete, off.text).toBe(true);
    expect(off.text).toMatch(/^To'liq\. rastamojka: /u);
  });

  it('«kafel 120 m2» lands as 120 m² — on his ✅ and on the machine’s press alike', async () => {
    for (const machine of [false, true]) {
      const peer = newPeer();
      const clientId = await freshClient();
      const { d } = await drafted(peer, { clientId }, { body: 'Rastamojka: kafel 120 m2, 1500 kg, 3 kub', section: 'rastamojka', goods: [{ name: 'kafel', quantity: 120, unit: 'm2', weight_kg: null }] });
      if (machine) expect(await pressDueAutos(DUE)).toBe(1);
      else expect(await decideDraft(person(), d.id, 'send', { digest: await digestOf(d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
      const [r] = await requestsOn(noteIdFor(d.id));
      const [item] = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, r!.id));
      expect(item, `machine=${machine}`).toMatchObject({ measureUnit: 'm2', quantity: null });
      expect(Number(item!.measureQty)).toBe(120);
    }
  });
});

describe('the lead’s stage on the machine’s own layer (§1.8)', () => {
  const auditsOf = (leadId: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.entityType, 'lead'), eq(auditLog.entityId, leadId), sql`${auditLog.after}->>'stageId' IS NOT NULL`));

  it('a machine landing on the holder’s lead: moved to the calc stage, the follow-up date kept, audited under no actor with via «ai»', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    await drafted(peer, { leadId: lead });
    expect(await pressDueAutos(DUE)).toBe(1);
    const [row] = await db.select({ stageId: leads.stageId, next: leads.nextActionAt }).from(leads).where(eq(leads.id, lead));
    expect(row!.stageId).toBe(stageIds.calc);
    expect(row!.next).not.toBeNull();
    const [audit] = await auditsOf(lead);
    expect(audit!.actorId).toBeNull();
    expect(audit!.after).toMatchObject({ stageId: stageIds.calc, via: 'ai', holder: holderId });
  });

  it('an owner changed to a colleague before the landing: the note and the job land, the stage does not move', async () => {
    const lead = await freshLead(colleagueId);
    const noteId = randomUUID();
    const target = await landIntake({
      machine: true,
      noteId,
      section: 'podklyuch',
      facts: { fromCity: 'Xitoy', toCity: 'Toshkent', weightKg: 500, volumeM3: 3, goods: [{ name: 'kurtka', quantity: 100 }] },
      steps: [],
      fileCount: 0,
      collectedBy: holderId,
      collectedByName: 'AI',
      client: null,
      lead: { id: lead, name: 'lid', ownerId: colleagueId },
      leadName: 'lid',
      leadPhone: null,
      intakeDoor: null,
    });
    expect(target).toMatchObject({ kind: 'lead', id: lead, queued: true });
    expect(await requestsOn(noteId)).toHaveLength(1);
    expect(await db.select().from(crmActivities).where(eq(crmActivities.id, noteId))).toHaveLength(1);
    expect((await db.select({ s: leads.stageId }).from(leads).where(eq(leads.id, lead)))[0]!.s).toBe(stageIds.start);
    expect(await auditsOf(lead)).toHaveLength(0);
  });

  it('his ✅ landing moves the stage exactly as today — under his name, no machine mark', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    const { d } = await drafted(peer, { leadId: lead });
    expect(await decideDraft(person(), d.id, 'send', { digest: await digestOf(d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    expect((await db.select({ s: leads.stageId }).from(leads).where(eq(leads.id, lead)))[0]!.s).toBe(stageIds.calc);
    const [audit] = await auditsOf(lead);
    expect(audit!.actorId).toBe(holderId);
    expect((audit!.after as Record<string, unknown>).via).toBeUndefined();
  });
});

describe('review — the calc gate’s untested halves (the tests lens)', () => {
  const RASTAMOJKA_LINE = 'Rastamojka: kafel 120 m2, 1500 kg, 3 kub';
  const RASTAMOJKA_GOODS = [{ name: 'kafel', quantity: 120, unit: 'm2', weight_kg: null }];
  const SECOND = { body: 'Yana podklyuch: 4 kub 600 kg, kurtka 150 dona, Xitoydan Toshkentga', goods: [{ name: 'kurtka', quantity: 150, unit: null, weight_kg: null }], now: LATER };

  it('a request on the chat’s LEAD within 14 days that no link names (a seller’s own 🧮) → `calc_recent` (s10)', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    await db.execute(sql`
      INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, section)
      VALUES ('lead', ${lead}::uuid, ${vedId}::uuid, 1, now() + interval '1 hour', 'podklyuch')`);
    const { d } = await drafted(peer, { leadId: lead });
    expect((await verdictOf(d.id))!.reasons).toEqual(['calc_recent']);
  });

  it('a coded client whose seller is a colleague → `calc_foreign`; a client with no seller is the machine’s to touch (s03)', async () => {
    const theirs = await drafted(newPeer(), { clientId: await freshClient(colleagueId) });
    expect((await verdictOf(theirs.d.id))!.reasons).toEqual(['calc_foreign']);
    const nobodys = await drafted(newPeer(), { clientId: await freshClient(null) });
    expect(await verdictOf(nobodys.d.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await stopAuto(holderId, nobodys.d.id)).toEqual({ ok: true });
  });

  /** His machine's job handed back by the VED, its deal then moved by `move` — and the customer answers. */
  async function handedBackThen(move: (r1: typeof calcRequests.$inferSelect, clientId: string) => Promise<void>) {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await pressDueAutos(DUE)).toBe(1);
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    await returnCalcRequest(r1!.id, 'tovar nomi yetarli emas', { actorId: vedId });
    await move(r1!, clientId);
    const second = await drafted(peer, { clientId }, {
      body: 'Kurtka — erkaklar qishki kurtkasi, 100 dona; 3 kub 500 kg; Xitoydan Toshkentga podklyuch',
      goods: [{ name: 'erkaklar qishki kurtkasi', quantity: 100, unit: null, weight_kg: null }],
      now: LATER,
    });
    return { r1: r1!, second };
  }

  it('the hand-back loop onto a deal a colleague now owns, or whose client a colleague now sells → `calc_foreign`, nothing lands (s02)', async () => {
    const owned = await handedBackThen(async (r1) => {
      await db.update(deals).set({ ownerId: colleagueId }).where(eq(deals.id, r1.entityId));
    });
    expect((await verdictOf(owned.second.d.id))!.reasons).toEqual(['calc_foreign']);
    const sold = await handedBackThen(async (_r1, clientId) => {
      await db.update(clients).set({ salesManagerId: colleagueId }).where(eq(clients.id, clientId));
    });
    expect((await verdictOf(sold.second.d.id))!.reasons).toContain('calc_foreign');
    expect(await pressDueAutos(LATER_DUE)).toBe(0);
    expect(await requestsOn(noteIdFor(owned.second.d.id))).toHaveLength(0);
    expect(await requestsOn(noteIdFor(sold.second.d.id))).toHaveLength(0);
  });

  it('the loop closes only the holder’s own «↩️» task — never a colleague’s, never his other tasks on the card (k42, k43)', async () => {
    const made: string[] = [];
    const { r1, second } = await handedBackThen(async (r) => {
      const rows = await db
        .insert(tasks)
        .values([
          { title: 'Ma’lumot to‘ldiring (hamkasb)', assigneeId: colleagueId, createdBy: vedId, origin: 'calc_return', entityType: 'deal', entityId: r.entityId },
          { title: 'Qo‘ng‘iroq qilish', assigneeId: holderId, createdBy: holderId, origin: 'hand', entityType: 'deal', entityId: r.entityId },
        ])
        .returning({ id: tasks.id });
      made.push(...rows.map((t) => t.id));
    });
    expect(await pressDueAutos(LATER_DUE)).toBe(1);
    const [r2] = await requestsOn(noteIdFor(second.d.id));
    expect(r2).toMatchObject({ entityType: 'deal', entityId: r1.entityId });
    const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id)))[0]!.s;
    expect(await statusOf(made[0]!)).toBe('open');
    expect(await statusOf(made[1]!)).toBe('open');
    // The control: his own «↩️» task is the one the loop closed.
    const [own] = await db.select().from(tasks).where(and(eq(tasks.origin, 'calc_return'), eq(tasks.entityId, r1.entityId), eq(tasks.assigneeId, holderId)));
    expect(own).toMatchObject({ status: 'done', result: HAND_BACK_TASK_DONE });
  });

  it('the holder at the people’s open cap → `calc_refused` at the scheduling; one under it the countdown runs (s05)', async () => {
    const lead = await freshLead();
    const openOf = async () => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM calc_requests WHERE requested_by = ${holderId}::uuid AND completed_at IS NULL`))[0]!.n);
    const filler: string[] = [];
    const fill = async (to: number) => {
      for (let n = await openOf(); n < to; n++) {
        const [row] = await db.execute<{ id: string }>(sql`
          INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, section)
          VALUES ('lead', ${lead}::uuid, ${holderId}::uuid, 1, now() + interval '1 hour', 'yolkira') RETURNING id::text`);
        filler.push(row!.id);
      }
    };
    try {
      await fill(19);
      const under = await drafted(newPeer(), { leadId: await freshLead() });
      expect((await verdictOf(under.d.id))!.reasons).not.toContain('calc_refused');
      expect(await stopAuto(holderId, under.d.id)).toEqual({ ok: true });
      await fill(20);
      const at = await drafted(newPeer(), { leadId: await freshLead() });
      expect((await verdictOf(at.d.id))!.reasons).toEqual(['calc_refused']);
    } finally {
      if (filler.length) await db.delete(calcRequests).where(inArray(calcRequests.id, filler));
    }
  });

  it('a chain landed on a lead, the chat later taken onto a client WITHOUT a win → `calc_recent` (only the chain’s own age sees it)', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    const first = await drafted(peer, { leadId: lead });
    expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    expect(r1).toMatchObject({ entityType: 'lead', entityId: lead });
    await db.update(calcRequests).set({ completedAt: new Date(), completedVia: 'lines' }).where(eq(calcRequests.id, r1!.id));
    const clientId = await freshClient();
    const [c] = await db.select({ phones: clients.phones }).from(clients).where(eq(clients.id, clientId));
    await db.insert(tgChatRules).values({ managerUserId: holderId, peerId: peer, decision: 'include', clientId, peerPhone: (c!.phones as string[])[0]!, peerTitle: 'C', decidedBy: holderId, decidedAt: new Date() });
    const second = await drafted(peer, { clientId }, SECOND);
    expect((await verdictOf(second.d.id))!.reasons).toEqual(['calc_recent']);
  });

  it('a podklyuch job, then a RASTAMOJKA submit on the same chat within 14 days → no `calc_recent` (each section its own job)', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const first = await drafted(peer, { clientId });
    expect(await decideDraft(person(), first.d.id, 'send', { digest: await digestOf(first.d.id) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [r1] = await requestsOn(noteIdFor(first.d.id));
    expect(r1).toMatchObject({ entityType: 'deal', section: 'podklyuch' });
    await db.update(calcRequests).set({ completedAt: new Date(), completedVia: 'lines' }).where(eq(calcRequests.id, r1!.id));
    const second = await drafted(peer, { clientId }, { body: RASTAMOJKA_LINE, section: 'rastamojka', goods: RASTAMOJKA_GOODS, now: LATER });
    expect(await verdictOf(second.d.id)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await stopAuto(holderId, second.d.id)).toEqual({ ok: true });
  });

  it('the calculation’s facts cannot be read at the press: every calc refusal at once, nothing lands (review tests: the fail-closed catch)', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    const { d } = await drafted(peer, { leadId: lead });
    expect(await verdictOf(d.id)).toMatchObject({ eligible: true, state: 'waiting' });
    seam.factsThrow = true;
    try {
      expect(await pressDueAutos(DUE)).toBe(0);
    } finally {
      seam.factsThrow = false;
    }
    expect((await verdictOf(d.id))!.reasons).toEqual(expect.arrayContaining(['calc_identity', 'calc_foreign', 'calc_refused', 'calc_recent', 'calc_file_missing']));
    expect(await requestsOn(noteIdFor(d.id))).toHaveLength(0);
  });
});

describe('the returned card’s own fences — his ✅ is gated by them alone, never by the machine’s facts (review nit)', () => {
  const FACTS = { fromCity: 'Xitoy', toCity: 'Toshkent', weightKg: 300, volumeM3: 2, goods: [{ name: 'shim', quantity: 50 }] };
  type LandInput = Parameters<typeof landIntake>[0];
  const land = (over: Partial<LandInput>) =>
    landIntake({
      machine: false,
      noteId: randomUUID(),
      section: 'podklyuch',
      facts: FACTS,
      steps: [],
      fileCount: 0,
      collectedBy: holderId,
      collectedByName: 'P2',
      client: null,
      leadName: '',
      leadPhone: null,
      intakeDoor: null,
      ...over,
    });
  const noteWritten = async (noteId: string) => (await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteId))).length > 0;
  const refusalOf = (p: Promise<unknown>) => p.then(() => 'landed', (e: unknown) => (e as { code?: string }).code ?? String(e));
  let dealSeq = 0;
  async function openDealOf(clientId: string): Promise<string> {
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    dealSeq += 1;
    const [d] = await db
      .insert(deals)
      .values({ code: `RC-${SUFFIX}-${dealSeq}`, clientId, stageId: stage!.id, title: 'P2 qaytgan', createdBy: holderId })
      .returning({ id: deals.id });
    return d!.id;
  }
  async function clientOf(id: string) {
    const [c] = await db.select({ id: clients.id, clientCode: clients.clientCode, name: clients.name }).from(clients).where(eq(clients.id, id));
    return c!;
  }
  const leadRef = async (id: string) => {
    const [l] = await db.select({ id: leads.id, name: leads.name, ownerId: leads.ownerId }).from(leads).where(eq(leads.id, id));
    return l!;
  };

  it('another client’s deal, a lead the chat does not name, the requester at his cap, a lead lost since — each refused, no note written', async () => {
    const mine = await clientOf(await freshClient());
    const theirs = await clientOf(await freshClient());
    // The control: this client's own open deal takes the job.
    const ownDeal = await openDealOf(mine.id);
    const ok = await land({ client: mine, onCard: { kind: 'deal', id: ownDeal } });
    expect(ok).toMatchObject({ kind: 'deal', id: ownDeal, outcome: 'returned_card' });

    const foreignDeal = await openDealOf(theirs.id);
    const a = randomUUID();
    expect(await refusalOf(land({ noteId: a, client: mine, onCard: { kind: 'deal', id: foreignDeal } }))).toBe('note_foreign');
    expect(await noteWritten(a)).toBe(false);

    const named = await leadRef(await freshLead());
    const other = await freshLead();
    const b = randomUUID();
    expect(await refusalOf(land({ noteId: b, lead: named, onCard: { kind: 'lead', id: other } }))).toBe('note_foreign');
    expect(await noteWritten(b)).toBe(false);

    const lost = await leadRef(await freshLead());
    await db.update(leads).set({ stageId: stageIds.lost, lostReason: 'qimmat' }).where(eq(leads.id, lost.id));
    const c = randomUUID();
    expect(await refusalOf(land({ noteId: c, lead: lost, onCard: { kind: 'lead', id: lost.id } }))).toBe('lead_closed');
    expect(await noteWritten(c)).toBe(false);

    const filler: string[] = [];
    try {
      const open = async () => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM calc_requests WHERE requested_by = ${holderId}::uuid AND completed_at IS NULL`))[0]!.n);
      for (let n = await open(); n < 20; n++) {
        const [row] = await db.execute<{ id: string }>(sql`
          INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, section)
          VALUES ('deal', ${ownDeal}::uuid, ${holderId}::uuid, 1, now() + interval '1 hour', 'yolkira') RETURNING id::text`);
        filler.push(row!.id);
      }
      const d = randomUUID();
      expect(await refusalOf(land({ noteId: d, client: mine, onCard: { kind: 'deal', id: ownDeal } }))).toBe('too_many_open');
      expect(await noteWritten(d)).toBe(false);
    } finally {
      if (filler.length) await db.delete(calcRequests).where(inArray(calcRequests.id, filler));
    }
  });
});

describe('which of the chat’s files go with a job (review nit: each fence of the window)', () => {
  it('the customer’s kept files since the chat’s last landed job — not ours, not a deleted line’s, not older, at most the newest ten', async () => {
    const peer = newPeer();
    const lead = await freshLead();
    const owner = { leadId: lead };
    const HOUR = 3_600_000;
    // Before the chat's last landed job: the window starts after it.
    const before = await inbound(peer, owner, 'eski invoys', { ago: 5 * HOUR, media: true });
    const older = await keptFile(before.rowId, 'old.pdf');
    const [r] = await db
      .insert(calcRequests)
      .values({ entityType: 'lead', entityId: lead, requestedBy: holderId, itemCount: 1, section: 'podklyuch', dueAt: new Date(T0.getTime() + HOUR), completedAt: new Date(T0.getTime() - 4 * HOUR), completedVia: 'lines' })
      .returning({ id: calcRequests.id });
    // The landed job's link names the draft that landed it, as every landing writes it.
    const [landed] = await db
      .insert(agentDrafts)
      .values({ managerUserId: holderId, peerId: peer, leadId: lead, anchorTgMessageId: before.tgId, status: 'approved', kind: 'reply', proposedBody: 'Hisoblatishga yubordim.' })
      .returning({ id: agentDrafts.id });
    await db.insert(agentCalcLinks).values({ requestId: r!.id, rootRequestId: r!.id, managerUserId: holderId, peerId: peer, draftId: landed!.id, createdAt: new Date(T0.getTime() - 4 * HOUR) });
    // A line the customer deleted, and our own outgoing file, inside the window.
    const gone = await inbound(peer, owner, 'xato fayl', { ago: 3 * HOUR, media: true });
    const deleted = await keptFile(gone.rowId, 'deleted.pdf');
    await db.insert(tgMessageFlags).values({ messageId: gone.rowId, deletedAt: new Date() });
    msgSeq += 1n;
    const [out] = await db
      .insert(tgMessages)
      .values({ leadId: lead, managerUserId: holderId, peerId: peer, tgMessageId: msgSeq, direction: 'out', body: 'bizning prays', hasMedia: true, sentAt: new Date(T0.getTime() - 3 * HOUR) })
      .returning({ id: tgMessages.id });
    const ours = await keptFile(out!.id, 'ours.pdf');
    // Three of the customer's kept files after the job: exactly those go, oldest first — under the cap, so a fence
    // that let one of the three above in would show (the cap must not be what hides them).
    const kept: string[] = [];
    const add = async (i: number) => {
      const line = await inbound(peer, owner, `invoys ${i}`, { ago: 2 * HOUR - i * 60_000, media: true });
      kept.push(await keptFile(line.rowId, `inv-${i}.pdf`));
    };
    for (let i = 0; i < 3; i++) await add(i);
    expect((await chatFilesForJob(holderId, peer, null)).map((f) => f.id)).toEqual(kept);
    // Twelve: the newest ten go, oldest first.
    for (let i = 3; i < 12; i++) await add(i);
    const files = await chatFilesForJob(holderId, peer, null);
    expect(files.map((f) => f.id)).toEqual(kept.slice(-CALC_FILES_MAX));
    for (const not of [older, deleted, ours]) expect(files.map((f) => f.id)).not.toContain(not);
  });
});
