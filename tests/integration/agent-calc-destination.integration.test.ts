import 'dotenv/config';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** pg-boss is never started in this process: the jobs a landing queues (the AI VED pass) are caught here. */
const queued = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queued.push({ name, data });
  }),
}));

import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoConfig,
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  events,
  notifications,
  roles,
  tasks,
  tgAccountGuard,
  tgAccounts,
  tgChatRules,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { AVIA_DAYS_DEFAULT, getSetting, setSetting } from '@/modules/platform/settings/service';
import { readAutoConfig, __restoreAutoConfig, type AutoConfig } from '@/modules/wms/agent/auto-send';
import { ASSUMED_DESTINATION_NOTE } from '@/modules/wms/agent/calc-destination';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { loadContext } from '@/modules/wms/agent/context';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { CUSTOMS_OFFER_SENTENCE } from '@/modules/wms/agent/policy';
import { handleInbound } from '@/modules/wms/agent/run';
import { ourChinaPlaces, runTool, type ToolEnv } from '@/modules/wms/agent/tools';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * His «T a» (2026-11-21), end to end against a real database: the whole conversation the stage never had a test for —
 * a priced reply with the customs offer, «ha», the checklist asking the goods line, the count, the checklist COMPLETE
 * with the destination nobody said taken as Tashkent, the submit composed, his ✅, and a `calc_requests` row whose
 * note tells the VED «Manzil aytilmagan — Toshkent deb olindi». Then a destination said alone in Cyrillic: read, and
 * nothing taken.
 *
 * Before his answer the checklist read the destination only through the staff intake's Latin «A → B» route reader, so
 * a truck job where the customer named no city — or named it alone, or in Cyrillic — asked «qaysi shaharga» for ever
 * and no job ever landed. The model is SCRIPTED (CI has no key); every reply is approved by his ✅ (`decideDraft` as the
 * holder) and «sent» the way the listener records it (the outbox row sent, its echo stored), so each run reads the
 * conversation a real one would.
 *
 * CONFIGURATION is the next file's input on the one shared database (#183): agent_config, the auto layer's row and the
 * send switch are snapshotted and put back; the clients, deals, requests, tasks and notes this file makes are removed;
 * fixture people are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
const peers: bigint[] = [];
let peerSeq = 0n;
function newPeer(): bigint {
  peerSeq += 1n;
  const p = BigInt(`84${SUFFIX}`) * 100n + peerSeq;
  peers.push(p);
  return p;
}

/** A daytime instant in the past — the clock the runs draft on (night rules stay out of this file's subject). */
function machineClock(): Date {
  const now = new Date(Date.now() - 40 * 60_000);
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour >= 9 && hour < 19) return now;
  const t = new Date(now);
  t.setUTCHours(8, 0, 0, 0); // 13:00 Tashkent
  if (t.getTime() > now.getTime()) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
const T0 = machineClock();
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let holderId = '';
let accountId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
let msgSeq = 7000n;
const madeClients: string[] = [];

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function freshClient(): Promise<string> {
  const n = madeClients.length + 1;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `TA${SUFFIX}${n}`.slice(0, 10), name: `T a mijoz ${SUFFIX}-${n}`, phones: [`+99896${SUFFIX}${String(n).padStart(2, '0')}`], salesManagerId: holderId })
    .returning({ id: clients.id });
  madeClients.push(c!.id);
  return c!.id;
}

/** The customer's line at `when`. */
async function inbound(peer: bigint, clientId: string, body: string, when: Date): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({ clientId, managerUserId: holderId, peerId: peer, tgMessageId: msgSeq, direction: 'in', body, sentAt: when });
  return msgSeq;
}

type Step = { name: string; input: Record<string, unknown> } | ((req: ModelRequest) => { name: string; input: Record<string, unknown> });

/** The model, scripted; every tool result it is handed is kept in `seen`, in order. */
function scripted(steps: Step[], seen: string[]): CallModel {
  let i = 0;
  return (async (req: ModelRequest): Promise<ModelResponse> => {
    const last = req.messages.at(-1);
    for (const b of last?.content ?? []) if (b.type === 'tool_result') seen.push(b.content);
    const raw = steps[Math.min(i, steps.length - 1)]!;
    const step = typeof raw === 'function' ? raw(req) : raw;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel;
}

function compose(text: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'compose_reply',
    input: {
      reply_needed: true,
      reply_text: text,
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
      ...extra,
    },
  };
}

/** The truck tool's own figure, read off the result it handed the model — the quote states what the tool priced. */
function quoteFromTool(req: ModelRequest) {
  const result = req.messages
    .at(-1)!
    .content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []))
    .join('\n');
  const total = /Taxminiy yo'lkira \([^)]*\): ([\d.]+) \$/u.exec(result)?.[1];
  if (!total) throw new Error(`the truck tool priced nothing: ${result}`);
  return compose(
    `3 kub, 450 kg yukingiz uchun Toshkentgacha yo'lkira taxminan ${total} $ bo'ladi. Boj va QQS alohida hisoblanadi. ${CUSTOMS_OFFER_SENTENCE.uz}`,
    { category: 'price', next_step: 'quote' },
  );
}

/** The checklist's own environment, as a run hands it — the China places from the warehouses table. */
const envOf = (ctx: Awaited<ReturnType<typeof loadContext>>): ToolEnv => ({
  ctx,
  day: '2026-11-21',
  aviaUsdPerKg: null,
  kb: async () => [],
  chinaPlaces: ourChinaPlaces,
  priceArmed: false,
  calcArmed: false,
  calcPricing: false,
  aviaDays: AVIA_DAYS_DEFAULT,
});

const person = () => ({ id: holderId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });

async function digestOf(draftId: string): Promise<string> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return (row!.payload as { digest: string }).digest;
}

/** One run over the customer's newest line, on the machine's clock; its draft. */
async function run(peer: bigint, anchor: bigint, steps: Step[], now: Date, seen: string[] = []) {
  const out = await handleInbound(
    { managerUserId: holderId, peerId: String(peer), anchorTgMessageId: String(anchor), origin: 'live' },
    { callModel: scripted(steps, seen), now: () => now },
  );
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, (out as { draftId: string }).draftId));
  return d!;
}

/** His ✅, then the reply «sent» as the listener records it: the outbox row sent, its echo in the chat. */
async function approvedAndSent(peer: bigint, clientId: string, draftId: string, when: Date) {
  const decided = await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId });
  expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  msgSeq += 1n;
  await db.update(agentOutbox).set({ status: 'sent', sentAt: when, tgMessageId: msgSeq }).where(eq(agentOutbox.id, o!.id));
  await db.insert(tgMessages).values({ clientId, managerUserId: holderId, peerId: peer, tgMessageId: msgSeq, direction: 'out', body: o!.body, sentAt: when });
  return decided;
}

const requestsOn = async (noteId: string) => db.select().from(calcRequests).where(eq(calcRequests.noteId, noteId));
const noteOf = async (noteId: string) => (await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteId)))[0]?.note ?? null;

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  if (!agentSnapshot || !autoSnapshot) throw new Error('0138/0145 are not applied on this database');
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  holderId = await makeUser(`T a egasi ${SUFFIX}`, 'super_admin', '01');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: holderId, tgPhone: `+99894${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
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
  // His ✅ presses every reply here: the machine's layer is off, so nothing is pressed behind the test's back.
  await db.update(agentAutoConfig).set({ armedAt: null, armedBy: null }).where(eq(agentAutoConfig.id, 1));
  await setSetting('tg_sending_enabled', true, holderId);
});

beforeEach(async () => {
  queued.length = 0;
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  try {
    if (peers.length) {
      await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.peerId, peers));
      await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, peers));
      await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, peers));
      await db.delete(agentRuns).where(inArray(agentRuns.peerId, peers));
      await db.delete(agentConversations).where(inArray(agentConversations.peerId, peers));
      await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, peers));
      await db.delete(tgMessages).where(inArray(tgMessages.peerId, peers));
    }
    const requests = await db.select({ id: calcRequests.id, taskId: calcRequests.taskId }).from(calcRequests).where(eq(calcRequests.requestedBy, holderId));
    const requestIds = requests.map((r) => r.id);
    const dealIds = madeClients.length ? (await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, madeClients))).map((d) => d.id) : [];
    // The tasks the landings made — by the requests and the cards, never by assignee alone: the VED rota hands a job
    // to whoever holds the role, the seeded VED included (#154/#183).
    const taskIds = new Set(requests.map((r) => r.taskId).filter((id): id is string => id !== null));
    const byWhat = [eq(tasks.assigneeId, holderId)];
    if (requestIds.length) byWhat.push(inArray(tasks.boundId, requestIds));
    if (dealIds.length) byWhat.push(inArray(tasks.entityId, dealIds));
    for (const t of await db.select({ id: tasks.id }).from(tasks).where(or(...byWhat))) taskIds.add(t.id);
    if (requestIds.length) {
      await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
      await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
    }
    if (taskIds.size) {
      await db.delete(events).where(inArray(events.entityId, [...taskIds]));
      await db.delete(notifications).where(sql`${notifications.payload}->>'taskId' IN (${sql.join([...taskIds].map((id) => sql`${id}`), sql`, `)})`);
      await db.delete(tasks).where(inArray(tasks.id, [...taskIds]));
    }
    if (dealIds.length) {
      await db.delete(crmActivities).where(inArray(crmActivities.entityId, dealIds));
      await db.delete(events).where(inArray(events.entityId, dealIds));
      await db.delete(deals).where(inArray(deals.id, dealIds));
    }
    if (madeClients.length) {
      await db.delete(events).where(inArray(events.entityId, madeClients));
      await db.delete(clients).where(inArray(clients.id, madeClients));
    }
    await db.delete(notifications).where(eq(notifications.userId, holderId));
    await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
    await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  } finally {
    await __restoreAgentConfig(agentSnapshot);
    await __restoreAutoConfig(autoSnapshot);
    await setSetting('tg_sending_enabled', sendingBefore, null);
    await db.update(users).set({ active: false }).where(eq(users.id, holderId));
  }
});

const SUBMIT = (refs: string[], cyrillic = false) =>
  compose(cyrillic ? 'Ҳисоблатишга юбордим, жавоб келиши билан айтаман.' : 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', {
    ...(cyrillic ? { language: 'uz_cyrl' } : {}),
    category: 'price',
    next_step: 'calc',
    actions: [{ type: 'calc_submit', section: 'podklyuch', cited_message_refs: refs, date: '', note: '' }],
  });

describe('his «T a»: «ha» all the way to a landed job', () => {
  it('no destination said: the checklist takes Tashkent and stops asking «qaysi shaharga»; his ✅ lands the job and the VED reads «Manzil aytilmagan — Toshkent deb olindi»', async () => {
    const peer = newPeer();
    const clientId = await freshClient();

    // 1. The price, with the customs offer.
    const a1 = await inbound(peer, clientId, 'Ivudan 3 kub 450 kg kiyim, narxi qancha?', at(0));
    const d1 = await run(peer, a1, [{ name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } }, quoteFromTool], at(0.5));
    expect(d1.proposedBody).toContain(CUSTOMS_OFFER_SENTENCE.uz);
    await approvedAndSent(peer, clientId, d1.id, at(1));

    // 2. «ha» → podklyuch: the checklist asks the goods line — and never the city.
    const a2 = await inbound(peer, clientId, 'ha', at(2));
    const seen2: string[] = [];
    const d2 = await run(
      peer,
      a2,
      [{ name: 'calc_checklist', input: { section: 'podklyuch', goods: [] } }, compose('Qanday kiyim va nechta dona? Yozsangiz, hisoblatishga yuboraman.')],
      at(2.5),
      seen2,
    );
    const asked = seen2.find((t) => t.startsWith('Yetishmaydi'));
    expect(asked, seen2.join('\n---\n')).toBeDefined();
    expect(asked).toContain('tovar nomi');
    expect(asked).not.toContain('qaysi shaharga');
    // The model is told the city was taken, not said — never to name it nor ask it.
    expect(asked).toContain('«Toshkent deb olindi»');
    await approvedAndSent(peer, clientId, d2.id, at(3));

    // 3. The count: the checklist is complete with Tashkent TAKEN, and the submit is composed.
    const a3 = await inbound(peer, clientId, '200 dona', at(4));
    const ctx = await loadContext(holderId, peer, a3);
    const lineRef = ctx.messages.find((m) => m.direction === 'in' && m.body === 'Ivudan 3 kub 450 kg kiyim, narxi qancha?')!.ref;
    const countRef = ctx.messages.find((m) => m.direction === 'in' && m.body === '200 dona')!.ref;
    const seen3: string[] = [];
    const d3 = await run(
      peer,
      a3,
      [{ name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kiyim', quantity: 200, unit: 'dona', weight_kg: null }] } }, SUBMIT([lineRef, countRef])],
      at(4.5),
      seen3,
    );
    const done = seen3.find((t) => t.startsWith("To'liq."));
    expect(done, seen3.join('\n---\n')).toBeDefined();
    // The facts the MODEL reads carry no destination: it is never handed a city to say.
    expect(done).toContain('"toCity":null');
    expect((d3.policy as { noteCodes?: string[] } | null)?.noteCodes ?? []).not.toContain('calc_incomplete');
    const submit = (d3.actions as { type: string; facts?: { toCity?: string }; toCityAssumed?: boolean }[]).find((a) => a.type === 'calc_submit');
    expect(submit, JSON.stringify(d3.actions)).toMatchObject({ facts: { toCity: 'Toshkent', fromCity: 'Yiwu', weightKg: 450, volumeM3: 3 }, toCityAssumed: true });

    // 4. His ✅ lands it: one request, Tashkent on it, the VED's note says it was taken.
    await approvedAndSent(peer, clientId, d3.id, at(5));
    const noteId = noteIdFor(d3.id);
    const reqs = await requestsOn(noteId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ section: 'podklyuch', toCity: 'Toshkent', fromCity: 'Yiwu' });
    expect(await noteOf(noteId)).toContain(ASSUMED_DESTINATION_NOTE);
    expect(ASSUMED_DESTINATION_NOTE).toBe('Manzil aytilmagan — Toshkent deb olindi.');
  });

  it('«Тошкентга» said alone in its own message: read — nothing taken, no «Manzil aytilmagan» for the VED', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const a1 = await inbound(peer, clientId, 'Иудан 3 куб 450 кг кийим бор, 200 дона', at(10));
    const a2 = await inbound(peer, clientId, 'Тошкентга', at(10.2));
    expect(a2).toBeGreaterThan(a1);
    const ctx = await loadContext(holderId, peer, a2);
    const refs = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.ref);
    const seen: string[] = [];
    const d = await run(
      peer,
      a2,
      [{ name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'кийим', quantity: 200, unit: 'dona', weight_kg: null }] } }, SUBMIT(refs, true)],
      at(10.5),
      seen,
    );
    const done = seen.find((t) => t.startsWith("To'liq."));
    expect(done, seen.join('\n---\n')).toBeDefined();
    expect(done).toContain('"toCity":"Toshkent"');
    expect(done).not.toContain('Toshkent deb olindi');
    const submit = (d.actions as { type: string; toCityAssumed?: boolean }[]).find((a) => a.type === 'calc_submit');
    expect(submit).toBeDefined();
    expect(submit!.toCityAssumed).toBeUndefined();
    await approvedAndSent(peer, clientId, d.id, at(11));
    const noteId = noteIdFor(d.id);
    const reqs = await requestsOn(noteId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ toCity: 'Toshkent' });
    expect(await noteOf(noteId)).not.toContain('Manzil aytilmagan');
  });

  it('a city other than Tashkent said alone in Cyrillic («Андижонга») is read — the checklist does not ask it again, and takes no Tashkent', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    await inbound(peer, clientId, 'Иудан 3 куб 450 кг кийим бор, 200 дона', at(20));
    const anchor = await inbound(peer, clientId, 'Андижонга', at(20.2));
    const ctx = await loadContext(holderId, peer, anchor);
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods: [{ name: 'кийим', quantity: 200, unit: 'dona', weight_kg: null }] }, envOf(ctx));
    expect(out.text).not.toContain('qaysi shaharga');
    expect(out.checklist).toMatchObject({ complete: true, toCityAssumed: false, facts: { toCity: 'Андижон' } });
  });

  it('a city named outside Uzbekistan is never defaulted to Tashkent: the city the customer did not say as a destination is asked', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    await inbound(peer, clientId, 'Иудан 3 куб 450 кг кийим бор, 200 дона', at(30));
    const anchor = await inbound(peer, clientId, 'Olmaotada turaman', at(30.2));
    const ctx = await loadContext(holderId, peer, anchor);
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods: [{ name: 'кийим', quantity: 200, unit: 'dona', weight_kg: null }] }, envOf(ctx));
    expect(out.text).toContain('qaysi shaharga');
    expect(out.checklist).toMatchObject({ complete: false, toCityAssumed: false, facts: { toCity: null } });
  });
});
