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
import { ASSUMED_DESTINATION_NOTE, saidDestinationNote } from '@/modules/wms/agent/calc-destination';
import { calcPriceGateFacts, destinationReadings, takenDestinationRequests } from '@/modules/wms/agent/calc-price';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { loadContext } from '@/modules/wms/agent/context';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { CUSTOMS_OFFER_SENTENCE } from '@/modules/wms/agent/policy';
import { handleInbound } from '@/modules/wms/agent/run';
import { ASSUMED_DESTINATION_TOOL_WORDS, CALC_DESTINATION_TAKEN_WORDS, ourChinaPlaces, runTool, type ToolEnv } from '@/modules/wms/agent/tools';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * His «T a» (2026-11-21) under the lead's ruling on the three checks, end to end against a real database: the MODEL
 * names the destination in the checklist (`to_city` + the customer's words, `to_city_words`) and the code lands it only
 * when those words are in one of the customer's own lines and hold the city (calc-destination `jobDestination`). The
 * cases are the ruling's: (a) a city quoted from his line lands as said, the VED shown his words; (b) the whole
 * conversation with no city — a priced reply with the customs offer, «ha», the goods asked (never the city), the count,
 * the checklist COMPLETE with Tashkent taken, his ✅, a `calc_requests` row whose note says «Manzil o‘qilmadi — Toshkent
 * deb olindi, mijoz so‘zlarini tekshiring»; (c) a city the model invents, (d) one quoted from OUR line — both taken;
 * (e) a city outside Uzbekistan — asked; (f) «Из Иу в Андижан 3 куба» — the volume read, the city said. Then «taken» as
 * the chain's NEWEST landing while its request still carries Tashkent — a VED who types the real city, or a hand-back
 * loop's resubmission with it, ends it.
 *
 * The model is SCRIPTED (CI has no key); every reply is approved by his ✅ (`decideDraft` as the holder) and «sent» the
 * way the listener records it (the outbox row sent, its echo stored), so each run reads the conversation a real one
 * would.
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

/** What the model put in the checklist about the destination — nothing, by default. */
type Claim = { to_city: string; to_city_words: string };
const NO_CLAIM: Claim = { to_city: '', to_city_words: '' };
const CHECKLIST = (claim: Claim = NO_CLAIM) => ({
  name: 'calc_checklist',
  input: { section: 'podklyuch', goods: [{ name: 'кийим', quantity: 200, unit: 'dona', weight_kg: null }], ...claim },
});

type Submit = { type: string; facts?: { toCity?: string | null; volumeM3?: number | null }; toCityAssumed?: boolean; toCitySaid?: string };

/** One landing over these lines: the checklist with the model's claim, the submit, his ✅; the request, note, submit. */
async function landWith(lines: string[], claim: Claim, start: number) {
  const peer = newPeer();
  const clientId = await freshClient();
  let anchor = 0n;
  for (const [i, line] of lines.entries()) anchor = await inbound(peer, clientId, line, at(start + i * 0.1));
  const ctx = await loadContext(holderId, peer, anchor);
  const refs = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.ref);
  const seen: string[] = [];
  // The submit answers in the customer's script, as a reply the policy passes must.
  const d = await run(peer, anchor, [CHECKLIST(claim), SUBMIT(refs, /\p{Script=Cyrillic}/u.test(lines.join(' ')))], at(start + 0.5), seen);
  const submit = (d.actions as Submit[]).find((a) => a.type === 'calc_submit');
  expect(submit, `${JSON.stringify(d.actions)}\n${seen.join('\n---\n')}`).toBeDefined();
  await approvedAndSent(peer, clientId, d.id, at(start + 1));
  const noteId = noteIdFor(d.id);
  const reqs = await requestsOn(noteId);
  expect(reqs, 'the job landed').toHaveLength(1);
  return { peer, clientId, req: reqs[0]!, note: await noteOf(noteId), submit: submit!, seen, draft: d };
}

describe('the lead’s ruling: the model names the destination, the code verifies it is the customer’s', () => {
  it('(a) «Andijonga 3 kub qachon keladi» quoted from his line: the job lands on Andijon, and the VED reads his words', async () => {
    const words = 'Andijonga 3 kub qachon keladi';
    const { req, note, submit, seen } = await landWith(['Ivudan Andijonga 3 kub qachon keladi? 450 kg kiyim bor, 200 dona'], { to_city: 'Andijon', to_city_words: words }, 0);
    const done = seen.find((t) => t.startsWith("To'liq."));
    expect(done, seen.join('\n---\n')).toContain('"toCity":"Andijon"');
    expect(done).not.toContain('Toshkent deb olindi');
    expect(submit).toMatchObject({ facts: { toCity: 'Andijon' }, toCitySaid: words });
    expect(submit.toCityAssumed).toBeUndefined();
    expect(req).toMatchObject({ section: 'podklyuch', toCity: 'Andijon' });
    expect(note).toContain(saidDestinationNote(words));
    expect(note).not.toContain(ASSUMED_DESTINATION_NOTE);
    expect((await destinationReadings([req.id])).get(req.id)).toEqual({ taken: false, evidence: words });
  });

  it('(b) no destination said: the checklist takes Tashkent and stops asking «qaysi shaharga»; his ✅ lands the job and the VED reads «Manzil o‘qilmadi — Toshkent deb olindi, …»', async () => {
    const peer = newPeer();
    const clientId = await freshClient();

    // 1. The price, with the customs offer.
    const a1 = await inbound(peer, clientId, 'Ivudan 3 kub 450 kg kiyim, narxi qancha?', at(10));
    const d1 = await run(peer, a1, [{ name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } }, quoteFromTool], at(10.5));
    expect(d1.proposedBody).toContain(CUSTOMS_OFFER_SENTENCE.uz);
    await approvedAndSent(peer, clientId, d1.id, at(11));

    // 2. «ha» → podklyuch: the checklist asks the goods line — and never the city.
    const a2 = await inbound(peer, clientId, 'ha', at(12));
    const seen2: string[] = [];
    const d2 = await run(
      peer,
      a2,
      [{ name: 'calc_checklist', input: { section: 'podklyuch', goods: [], ...NO_CLAIM } }, compose('Qanday kiyim va nechta dona? Yozsangiz, hisoblatishga yuboraman.')],
      at(12.5),
      seen2,
    );
    const asked = seen2.find((t) => t.startsWith('Yetishmaydi'));
    expect(asked, seen2.join('\n---\n')).toBeDefined();
    expect(asked).toContain('tovar nomi');
    expect(asked).not.toContain('qaysi shaharga');
    // The model is told the city was taken, not read — never to ask it nor say it as his.
    expect(asked).toContain(ASSUMED_DESTINATION_TOOL_WORDS);
    await approvedAndSent(peer, clientId, d2.id, at(13));

    // 3. The count: the checklist is complete with Tashkent TAKEN, and the submit is composed.
    const a3 = await inbound(peer, clientId, '200 dona', at(14));
    const ctx = await loadContext(holderId, peer, a3);
    const lineRef = ctx.messages.find((m) => m.direction === 'in' && m.body === 'Ivudan 3 kub 450 kg kiyim, narxi qancha?')!.ref;
    const countRef = ctx.messages.find((m) => m.direction === 'in' && m.body === '200 dona')!.ref;
    const seen3: string[] = [];
    const d3 = await run(
      peer,
      a3,
      [{ name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kiyim', quantity: 200, unit: 'dona', weight_kg: null }], ...NO_CLAIM } }, SUBMIT([lineRef, countRef])],
      at(14.5),
      seen3,
    );
    const done = seen3.find((t) => t.startsWith("To'liq."));
    expect(done, seen3.join('\n---\n')).toBeDefined();
    // The facts the MODEL reads carry no destination: it is never handed a city to say.
    expect(done).toContain('"toCity":null');
    expect((d3.policy as { noteCodes?: string[] } | null)?.noteCodes ?? []).not.toContain('calc_incomplete');
    const submit = (d3.actions as Submit[]).find((a) => a.type === 'calc_submit');
    expect(submit, JSON.stringify(d3.actions)).toMatchObject({ facts: { toCity: 'Toshkent', fromCity: 'Yiwu', weightKg: 450, volumeM3: 3 }, toCityAssumed: true });

    // 4. His ✅ lands it: one request, Tashkent on it, the VED's note says it was taken.
    await approvedAndSent(peer, clientId, d3.id, at(15));
    const noteId = noteIdFor(d3.id);
    const reqs = await requestsOn(noteId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ section: 'podklyuch', toCity: 'Toshkent', fromCity: 'Yiwu' });
    expect(await noteOf(noteId)).toContain(ASSUMED_DESTINATION_NOTE);
    expect(ASSUMED_DESTINATION_NOTE).toBe('Manzil o‘qilmadi — Toshkent deb olindi, mijoz so‘zlarini tekshiring');
    expect(await noteOf(noteId)).not.toContain('Manzil mijoz xabaridan');
    expect((await destinationReadings([reqs[0]!.id])).get(reqs[0]!.id)).toEqual({ taken: true });
  });

  it('(c) a city the model invents — its words in no customer line — is never landed as his: Tashkent taken, and the model told why', async () => {
    const { req, note, submit, seen } = await landWith(['Иудан 3 куб 450 кг кийим бор, 200 дона'], { to_city: 'Samarqand', to_city_words: 'Samarqandga' }, 20);
    expect(seen.find((t) => t.startsWith("To'liq."))).toContain("to_city_words mijozning xabarlarida so'zma-so'z topilmadi");
    expect(submit).toMatchObject({ facts: { toCity: 'Toshkent' }, toCityAssumed: true });
    expect(submit.toCitySaid).toBeUndefined();
    expect(req).toMatchObject({ toCity: 'Toshkent' });
    expect(note).toContain(ASSUMED_DESTINATION_NOTE);
    expect(note).not.toContain('Samarqand');
    expect((await destinationReadings([req.id])).get(req.id)).toEqual({ taken: true });
  });

  it('(c2) the city not in the words it quotes — «Ivudan» for Andijon — is never landed: Tashkent taken', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const anchor = await inbound(peer, clientId, 'Ivudan 3 kub 450 kg kiyim, 200 dona', at(25));
    const ctx = await loadContext(holderId, peer, anchor);
    const out = await runTool('calc_checklist', CHECKLIST({ to_city: 'Andijon', to_city_words: 'Ivudan' }).input, envOf(ctx));
    expect(out.text).toContain("to_city to_city_words ichida yo'q");
    expect(out.checklist).toMatchObject({ toCityAssumed: true, facts: { toCity: 'Toshkent' } });
    expect(out.checklist?.toCityEvidence).toBeUndefined();
  });

  it('(d) words only in OUR line — our own «Toshkentgacha» — are never the customer’s destination: Tashkent taken, not said', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    // Our priced reply says «Toshkentgacha», sent with his ✅ — the chat's only «Toshkent» is ours.
    const a1 = await inbound(peer, clientId, 'Ivudan 3 kub 450 kg kiyim, narxi qancha?', at(30));
    const d1 = await run(peer, a1, [{ name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } }, quoteFromTool], at(30.5));
    await approvedAndSent(peer, clientId, d1.id, at(31));
    const ours = (await db.select({ body: tgMessages.body }).from(tgMessages).where(and(eq(tgMessages.peerId, peer), eq(tgMessages.direction, 'out'))))[0]!.body;
    expect(ours).toContain('Toshkentgacha');
    const a2 = await inbound(peer, clientId, 'ha, podklyuch, 200 dona', at(32));
    const ctx = await loadContext(holderId, peer, a2);
    const refs = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.ref);
    const claim = { to_city: 'Toshkent', to_city_words: 'Toshkentgacha' };
    const d2 = await run(peer, a2, [{ ...CHECKLIST(claim), input: { ...CHECKLIST(claim).input, goods: [{ name: 'kiyim', quantity: 200, unit: 'dona', weight_kg: null }] } }, SUBMIT(refs)], at(32.5));
    const submit = (d2.actions as Submit[]).find((a) => a.type === 'calc_submit');
    expect(submit, JSON.stringify(d2.actions)).toMatchObject({ facts: { toCity: 'Toshkent' }, toCityAssumed: true });
    expect(submit!.toCitySaid).toBeUndefined();
    await approvedAndSent(peer, clientId, d2.id, at(33));
    const noteId = noteIdFor(d2.id);
    const [req] = await requestsOn(noteId);
    expect(req, 'the job landed').toBeDefined();
    const note = await noteOf(noteId);
    expect(note).toContain(ASSUMED_DESTINATION_NOTE);
    expect(note).not.toContain('Manzil mijoz xabaridan');
    expect((await destinationReadings([req!.id])).get(req!.id)).toEqual({ taken: true });
  });

  it('(e) a city outside Uzbekistan is never landed — not as his, not as Tashkent: the checklist asks', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    await inbound(peer, clientId, 'Иудан 3 куб 450 кг кийим бор, 200 дона', at(40));
    const anchor = await inbound(peer, clientId, 'Almatiga', at(40.2));
    const ctx = await loadContext(holderId, peer, anchor);
    const out = await runTool('calc_checklist', CHECKLIST({ to_city: 'Almaty', to_city_words: 'Almatiga' }).input, envOf(ctx));
    expect(out.text).toContain('qaysi shaharga');
    expect(out.text).toContain("«Almaty» O'zbekistondan tashqarida");
    expect(out.checklist).toMatchObject({ complete: false, toCityAssumed: false, facts: { toCity: null } });
  });

  it('(f) «Из Иу в Андижан 3 куба»: the volume is read, the city said — the job complete', async () => {
    const peer = newPeer();
    const clientId = await freshClient();
    const anchor = await inbound(peer, clientId, 'Из Иу в Андижан 3 куба, 450 кг одежда', at(50));
    const ctx = await loadContext(holderId, peer, anchor);
    const out = await runTool(
      'calc_checklist',
      { section: 'yolkira', goods: [{ name: 'одежда', quantity: null, unit: 'kg', weight_kg: 450 }], to_city: 'Андижан', to_city_words: 'в Андижан' },
      envOf(ctx),
    );
    expect(out.text).not.toContain('qaysi shaharga');
    expect(out.checklist).toMatchObject({ complete: true, toCityAssumed: false, toCityEvidence: 'в Андижан', facts: { toCity: 'Андижан', volumeM3: 3, weightKg: 450 } });
  });

  it('a city said alone in Cyrillic («Тошкентга») and quoted so: said, nothing taken — the city as the model wrote it', async () => {
    const { req, note, submit } = await landWith(['Иудан 3 куб 450 кг кийим бор, 200 дона', 'Тошкентга'], { to_city: 'Тошкент', to_city_words: 'Тошкентга' }, 60);
    expect(submit).toMatchObject({ facts: { toCity: 'Тошкент' }, toCitySaid: 'Тошкентга' });
    expect(submit.toCityAssumed).toBeUndefined();
    expect(req).toMatchObject({ toCity: 'Тошкент' });
    expect(note).toContain(saidDestinationNote('Тошкентга'));
    expect((await destinationReadings([req.id])).get(req.id)).toEqual({ taken: false, evidence: 'Тошкентга' });
  });
});

/** The VED's «Готово» answer on a request, as the p2 price test writes it. */
async function answered(requestId: string, amount: string) {
  await db
    .update(calcRequests)
    .set({ completedAt: new Date(Date.now() - 30 * 60_000), completedVia: 'task', answerAmount: amount, answerCurrency: 'USD', status: 'completed' } as never)
    .where(eq(calcRequests.id, requestId));
}

/** `calc_price` read after the VED answered, and the gate's facts and the VED screens' reading of `requestId`. */
async function pricedNow(peer: bigint, clientId: string, requestId: string, when: number) {
  const asked = await inbound(peer, clientId, 'нима бўлди?', at(when));
  const ctx = await loadContext(holderId, peer, asked);
  const out = await runTool('calc_price', {}, { ...envOf(ctx), calcPricing: true });
  expect(out.ok, out.text).toBe(true);
  const facts = await calcPriceGateFacts(out.calcPrices, { managerUserId: holderId, peerId: peer }, new Date());
  return { out, facts, reading: (await destinationReadings([requestId])).get(requestId) ?? null };
}

describe('the VED’s answer to a job whose destination was taken reaches the customer as «Toshkentgacha» (review F2)', () => {
  it('taken: the tool says «Toshkentgacha» and the gate’s facts carry it — the machine never relays the Tashkent figure as his city’s', async () => {
    const { peer, clientId, req, submit } = await landWith(['Иудан 3 куб 450 кг кийим бор, 200 дона, подключ билан канча?'], NO_CLAIM, 70);
    expect(submit.toCityAssumed).toBe(true);
    await answered(req.id, '1000');
    const { out, facts } = await pricedNow(peer, clientId, req.id, 72);
    expect(out.text).toContain(CALC_DESTINATION_TAKEN_WORDS);
    expect(facts.destinationTaken).toBe(true);
    // …and the VED's queue and workspace mark the route as taken (review F4), not only the note that folds shut.
    expect(await takenDestinationRequests([req.id])).toEqual(new Set([req.id]));
  });

  it('said: neither — «Тошкентга» was his own word', async () => {
    const { peer, clientId, req, submit } = await landWith(
      ['Иудан 3 куб 450 кг кийим бор, 200 дона, подключ билан канча?', 'Тошкентга'],
      { to_city: 'Тошкент', to_city_words: 'Тошкентга' },
      80,
    );
    expect(submit.toCityAssumed).toBeUndefined();
    await answered(req.id, '1000');
    const { out, facts } = await pricedNow(peer, clientId, req.id, 82);
    expect(out.text).not.toContain(CALC_DESTINATION_TAKEN_WORDS);
    expect(facts.destinationTaken).toBe(false);
    expect(await takenDestinationRequests([req.id])).toEqual(new Set());
  });
});

describe('the T check, regression 4: «taken» is the chain’s NEWEST landing, while its request still carries Tashkent', () => {
  it('the VED types the real city on a taken job: the price no longer says «Toshkentgacha», the gate and the screens no longer call it taken', async () => {
    const { peer, clientId, req, submit } = await landWith(['Иудан 3 куб 450 кг кийим бор, 200 дона, подключ билан канча?'], NO_CLAIM, 120);
    expect(submit.toCityAssumed).toBe(true);
    // The VED reads «Manzil o‘qilmadi …», asks the customer, and types the city on the workspace.
    const { setCargoFacts } = await import('@/modules/wms/calc/workspace');
    await setCargoFacts(req.id, { fromCity: req.fromCity, toCity: 'Andijon', weightKg: 450, volumeM3: 3 }, { actorId: holderId, ip: null, userAgent: null } as never);
    await answered(req.id, '1000');
    const { out, facts, reading } = await pricedNow(peer, clientId, req.id, 122);
    expect(out.text).not.toContain(CALC_DESTINATION_TAKEN_WORDS);
    expect(facts.destinationTaken).toBe(false);
    // The city is the VED's own now — no mark speaks for it (neither «taxmin» nor the customer's words).
    expect(reading).toBeNull();
  });

  /** The hand-back loop: a taken job returned, then the customer's answer resubmitted onto the same chat. */
  async function handedBack(answer: string, claim: Claim, start: number) {
    const { returnCalcRequest } = await import('@/modules/wms/calc/service');
    const first = await landWith(['Иудан 3 куб 450 кг кийим бор, 200 дона, подключ билан канча?'], NO_CLAIM, start);
    expect(first.submit.toCityAssumed).toBe(true);
    await returnCalcRequest(first.req.id, 'mijoz qaysi shaharga? manzil o‘qilmadi', { actorId: holderId, ip: null, userAgent: null } as never);
    const anchor = await inbound(first.peer, first.clientId, answer, at(start + 10));
    const ctx = await loadContext(holderId, first.peer, anchor);
    const refs = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.ref);
    const d = await run(first.peer, anchor, [CHECKLIST(claim), SUBMIT(refs, true)], at(start + 10.5));
    await approvedAndSent(first.peer, first.clientId, d.id, at(start + 11));
    const [req] = await requestsOn(noteIdFor(d.id));
    expect(req, 'the resubmission landed').toBeDefined();
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, req!.id));
    expect(link?.rootRequestId, 'the resubmission is the same chain').toBe(first.req.id);
    return { first, req: req!, submit: (d.actions as Submit[]).find((a) => a.type === 'calc_submit') };
  }

  it('the hand-back loop: a taken job returned «qaysi shaharga?», «Андижонга» answers it — the resubmission is said, and the price is no «Toshkentgacha»', async () => {
    const { first, req, submit } = await handedBack('Андижонга', { to_city: 'Андижон', to_city_words: 'Андижонга' }, 130);
    expect(submit).toMatchObject({ facts: { toCity: 'Андижон' }, toCitySaid: 'Андижонга' });
    expect(submit?.toCityAssumed).toBeUndefined();
    await answered(req.id, '1200');
    const { out, facts, reading } = await pricedNow(first.peer, first.clientId, req.id, 142);
    expect(out.text).not.toContain(CALC_DESTINATION_TAKEN_WORDS);
    expect(facts.destinationTaken).toBe(false);
    expect(reading).toEqual({ taken: false, evidence: 'Андижонга' });
    // The first landing's own mark is its history — it WAS taken.
    expect(await takenDestinationRequests([first.req.id])).toEqual(new Set([first.req.id]));
  });

  it('the hand-back answered «Toshkentga»: the same city, now SAID — the newest landing decides, never the first one’s «taken»', async () => {
    const { first, req, submit } = await handedBack('Toshkentga', { to_city: 'Toshkent', to_city_words: 'Toshkentga' }, 160);
    expect(submit).toMatchObject({ facts: { toCity: 'Toshkent' }, toCitySaid: 'Toshkentga' });
    expect(req.toCity, 'the city on the request is the taken one’s spelling — only the landing tells them apart').toBe('Toshkent');
    await answered(req.id, '1100');
    const { out, facts } = await pricedNow(first.peer, first.clientId, req.id, 172);
    expect(out.text).not.toContain(CALC_DESTINATION_TAKEN_WORDS);
    expect(facts.destinationTaken).toBe(false);
  });
});

describe('the third T check’s common lines: the model quotes the city, the job lands on it — or, quoting none, on Tashkent taken', () => {
  const cases: [string[], Claim, string, boolean][] = [
    [['Ivudan Andijonga 3 kub qachon keladi, 450 kg kiyim'], { to_city: 'Andijon', to_city_words: 'Andijonga 3 kub qachon keladi' }, 'Andijon', false],
    [['Ivudan, Andijon 3 kub 450 kg kiyim'], { to_city: 'Andijon', to_city_words: 'Andijon 3 kub' }, 'Andijon', false],
    [['Ivudan 3 kub 450 kg kiyim', 'manzil Andijon'], { to_city: 'Andijon', to_city_words: 'manzil Andijon' }, 'Andijon', false],
    [['Guanchjoudan Andijon viloyati, 3 kub 450 kg kiyim'], { to_city: 'Andijon', to_city_words: 'Andijon viloyati' }, 'Andijon', false],
    [['Из Иу в Андижан 3 куба 450 кг одежда, сколько стоит и когда будет?'], { to_city: 'Андижан', to_city_words: 'в Андижан' }, 'Андижан', false],
    // The route reader's far end once landed «kelishi»: the model names nothing, Tashkent is taken.
    [['Ivudan Toshkentga kelishi qancha, 3 kub 450 kg kiyim'], NO_CLAIM, 'Toshkent', true],
    [['Xitoydan tashishga necha pul, 3 kub 450 kg kiyim'], NO_CLAIM, 'Toshkent', true],
    [['Ivudan 3 kub 450 kg kiyim, narxi qancha?', 'Ertaga'], NO_CLAIM, 'Toshkent', true],
  ];
  for (const [ls, claim, city, taken] of cases) {
    it(`${ls.join(' / ')} → ${city}${taken ? ' (taken)' : ''}`, async () => {
      const peer = newPeer();
      const clientId = await freshClient();
      let anchor = 0n;
      for (const [i, line] of ls.entries()) anchor = await inbound(peer, clientId, line, at(150 + i * 0.1));
      const ctx = await loadContext(holderId, peer, anchor);
      const out = await runTool('calc_checklist', { section: 'yolkira', goods: [{ name: 'kiyim', quantity: null, unit: 'kg', weight_kg: 450 }], ...claim }, envOf(ctx));
      expect(out.text).not.toContain('qaysi shaharga');
      expect(out.checklist).toMatchObject({ complete: true, toCityAssumed: taken, facts: { toCity: city, volumeM3: 3 } });
    });
  }
});
