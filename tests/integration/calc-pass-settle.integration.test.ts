import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The machine's pass and its seller (docs/SAKKIZ-R3.md §10, P5 «Son»): the
 * ticket that marks a pass owed and names its job, the settle that clears it
 * on every way out, the hands-off stamp every machine save moves inside its
 * own transaction, one message per PASS, the re-run's answer to a seller who
 * muted it, the road never priced on a total an addition left stale, and
 * Uch band's retried landings queueing the pass a cut left owed.
 *
 * pg-boss is stood in by a job table in memory (#530's idiom): `enqueue`
 * records a job under the id it is given, `jobState` answers from that
 * record, and a case moves a job to `failed` the way a killed pass ends — so
 * «busy» is asked of a JOB here exactly as in production, and no pg-boss
 * starts inside the test process. The add door's requeue (P4's) is a spy:
 * this file proves the settle CALLS it; what it writes is P4's to prove.
 */
type FakeJob = { queue: string; data: Record<string, unknown>; options: Record<string, unknown>; state: string };
const boss = vi.hoisted(() => ({ jobs: new Map<string, FakeJob>(), failNext: 0, hold: null as Promise<void> | null }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (queue: string, data: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    // Only a PASS's send fails on demand: the landing also enqueues its
    // events and its drain kick, which are not the cut under test.
    if (boss.failNext > 0 && (queue === 'calc.prefill' || queue === 'calc.tariff-reply')) {
      boss.failNext -= 1;
      throw new Error('pg-boss unreachable (test)');
    }
    // A send still in flight (the first after a deploy starts pg-boss): the
    // NEXT pass send waits on `hold` before its job exists. Taken once, so a
    // send the case did not mean to hold never waits.
    if (boss.hold && (queue === 'calc.prefill' || queue === 'calc.tariff-reply')) {
      const hold = boss.hold;
      boss.hold = null;
      await hold;
    }
    const id = (options.id as string | undefined) ?? globalThis.crypto.randomUUID();
    boss.jobs.set(id, { queue, data, options, state: 'created' });
    return id;
  }),
  jobState: vi.fn(async (queue: string, id: string) => {
    const job = boss.jobs.get(id);
    return job && job.queue === queue ? job.state : null;
  }),
}));
const amendSpy = vi.hoisted(() => ({ requeue: vi.fn(async (_requestId?: string) => 0) }));
vi.mock('@/modules/wms/calc/amend', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/amend')>()),
  requeueWaitingAmendments: amendSpy.requeue,
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcGroups,
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
  tasks,
  telegramLinks,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import {
  __resetTelegramPause,
  problemSince,
  sendPendingTelegram,
  telegramProblemSql,
} from '@/modules/platform/notifications/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import type { Actor } from '@/modules/platform/rbac/authorize';
import {
  openCalcRequest,
  requestAsks,
  returnCalcRequest,
  storedRequestFacts,
} from '@/modules/wms/calc/service';
import {
  applyProposal,
  loadWorkspace,
  priceProposedGroups,
  saveTable,
  setGroupRates,
} from '@/modules/wms/calc/workspace';
import { aiPrefill, prefillStanding, prefillTicket } from '@/modules/wms/calc/prefill';
import { TICKET_SEND_WINDOW_S, queueCalcPrefill, ticketStanding } from '@/modules/wms/calc/prefill-queue';
import { SILENT_DOOR_ERROR, sayOnce } from '@/modules/wms/calc/say-once';
import { amendStanding } from '@/modules/wms/calc/amend';
import { replyVerdictFor } from '@/modules/platform/telegram/reply-door';
import {
  JOB_CALC_PREFILL,
  JOB_CALC_TARIFF_REPLY,
  PASS_EXPIRE_S,
  TARIFF_EXPIRE_S,
  registerCalcPrefillWorker,
  type CalcPrefillJob,
} from '@/modules/wms/calc/jobs';
import { ROAD_STALE_LINE, SELLER_ASKS_HEAD } from '@/modules/wms/calc/ai-reply';
import { lawAsksInputOf, lawAsksInputOfStored, lawAsksOf } from '@/modules/wms/calc/law-asks';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { threadCalcSend } from '@/modules/wms/calc/from-thread';
import { AI_NOTE_HEAD, AI_REPLY_HEAD, RERUN_WORD, TARIFF_PRICED_HEAD } from '@/modules/wms/calc/reply-heads';
import { clientFeed, machineReplyOf } from '@/modules/wms/crm/feed';

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
let sellerId = '';
let mutedId = '';
let clientId = '';
let leadId = '';
const CHAT = 710_000_000 + Number(SUFFIX);
const madeDeals: string[] = [];
const madeRequests: string[] = [];
const madeNotes: string[] = [];
const madeTg: string[] = [];
const parked = new Set<string>();
/** Every user this file minted — a seller per block, under the open-request cap. */
const people: string[] = [];
const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

type Handler = (jobs: { id: string; name: string; data: CalcPrefillJob; retryCount: number }[]) => Promise<void>;
const handlers = new Map<string, Handler>();
const ctx = () => ({ actorId: sellerId });

async function mintUser(tag: string, extra: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Number(SUFFIX) * 10 + seq).slice(-7).padStart(7, '0')}`,
      fullName: `Pass ${tag} ${SUFFIX}`,
      passwordHash: 'x',
      active: true,
      ...extra,
    })
    .returning({ id: users.id });
  people.push(u!.id);
  return u!.id;
}

/** A fresh seller for a block: one requester holds at most MAX_OPEN_PER_REQUESTER open jobs. */
const freshSeller = () =>
  beforeAll(async () => {
    sellerId = await mintUser('seller');
  });

beforeAll(async () => {
  sellerId = await mintUser('seller');
  mutedId = await mintUser('muted', { mutedNotificationTypes: ['CalcPrefilled'] });
  await db
    .insert(telegramLinks)
    .values({ userId: mutedId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `PS${SUFFIX}`, name: `Pass mijoz ${SUFFIX}` }).returning();
  clientId = client!.id;
  const lstage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
  const [lead] = await db
    .insert(leads)
    .values({ name: `Pass lead ${SUFFIX}`, stageId: lstage!.id, createdBy: sellerId, ownerId: sellerId })
    .returning();
  leadId = lead!.id;
  // The worker exactly as `boss.ts` registers it — both queues.
  await registerCalcPrefillWorker({
    createQueue: vi.fn(async () => {}),
    work: vi.fn(async (name: string, _opts: unknown, handler: Handler) => {
      handlers.set(name, handler);
      return 'w';
    }),
  } as never);
});

afterAll(async () => {
  __setTelegramTransport(null);
  // Every job on this file's cards, not only the ones a helper saw.
  const cards = [
    ...(await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, clientId))).map((d) => d.id),
    ...madeDeals,
    leadId,
  ];
  for (const row of await db.select({ id: calcRequests.id }).from(calcRequests).where(inArray(calcRequests.entityId, cards))) {
    if (!madeRequests.includes(row.id)) madeRequests.push(row.id);
  }
  if (madeRequests.length > 0) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  // Hand-backs open the requester's own task — swept with the cards.
  const handBacks = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.entityId, cards));
  if (handBacks.length > 0) {
    await db.delete(events).where(inArray(events.entityId, handBacks.map((t) => t.id)));
    await db.delete(tasks).where(inArray(tasks.id, handBacks.map((t) => t.id)));
  }
  await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
  if (madeNotes.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.id, madeNotes));
  if (madeTg.length > 0) await db.delete(tgMessages).where(inArray(tgMessages.id, madeTg));
  await db.delete(notifications).where(inArray(notifications.userId, people));
  if (parked.size > 0) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
  await db.delete(deals).where(eq(deals.clientId, clientId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedEnv.app;
  await pgClient.end();
});

async function freshDeal(): Promise<string> {
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `PS-${SUFFIX}-${madeDeals.length}`, clientId, stageId: stage!.id, title: 'Pass fixture', createdBy: sellerId })
    .returning();
  madeDeals.push(deal!.id);
  return deal!.id;
}

type Item = Parameters<typeof openCalcRequest>[0]['items'][number];
async function open(
  section: 'rastamojka' | 'podklyuch' | 'yolkira',
  items: Item[],
  extra: Partial<Parameters<typeof openCalcRequest>[0]> = {},
  by = sellerId,
): Promise<string> {
  const dealId = await freshDeal();
  const r = await openCalcRequest(
    { intakeDoor: null, entityType: 'deal', entityId: dealId, section, items, source: 'card', ...extra },
    { actorId: by },
  );
  madeRequests.push(r.id);
  return r.id;
}

/** The request's pass columns — the ticket and the stamp. */
async function passOf(id: string) {
  const [row] = await db
    .select({
      rev: calcRequests.rev,
      handsoffRev: calcRequests.handsoffRev,
      aiPassRev: calcRequests.aiPassRev,
      aiPassAt: calcRequests.aiPassAt,
      aiPassJob: calcRequests.aiPassJob,
    })
    .from(calcRequests)
    .where(eq(calcRequests.id, id));
  return row!;
}

/** The pass jobs the stand-in queue holds for one request. */
const passJobs = (requestId: string) =>
  [...boss.jobs.entries()]
    .filter(([, j]) => (j.queue === JOB_CALC_PREFILL || j.queue === JOB_CALC_TARIFF_REPLY) && j.data.requestId === requestId)
    .map(([id, j]) => ({ id, ...j }));

/** Run a job through the registered worker, as pg-boss hands it over. */
async function runJob(job: { id: string; queue: string; data: Record<string, unknown> }, retryCount = 0): Promise<void> {
  await handlers.get(job.queue)!([{ id: job.id, name: job.queue, data: job.data as unknown as CalcPrefillJob, retryCount }]);
}

/** The machine's messages for one request — the rows the drain would send. */
const said = (requestId: string, userId = sellerId) =>
  db
    .select({ id: notifications.id, payload: notifications.payload, status: notifications.status, error: notifications.error })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, 'CalcPrefilled'),
        sql`${notifications}.payload->>'requestId' = ${requestId}`,
      ),
    );

describe('the ticket marks a pass owed and names its job (§10.2.1)', () => {
  freshSeller();
  it('the section picks the queue: yolkira → the tariff queue, every customs section → the pass queue; the ticket names the job', async () => {
    // Moved from calc-prefill-wire (re-check p5-p6-7): the payload carries
    // the pass, the options the ticket's own id and the queue's expiry.
    const cases = [
      { section: 'yolkira' as const, queue: JOB_CALC_TARIFF_REPLY, expire: TARIFF_EXPIRE_S },
      { section: 'rastamojka' as const, queue: JOB_CALC_PREFILL, expire: PASS_EXPIRE_S },
      { section: 'podklyuch' as const, queue: JOB_CALC_PREFILL, expire: PASS_EXPIRE_S },
    ];
    for (const c of cases) {
      const id = await open(c.section, [{ name: `Yuk ${c.section} ${SUFFIX}` }], c.section === 'rastamojka' ? {} : { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
      expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: c.section })).toBe(true);
      const [job] = passJobs(id);
      expect(job, c.section).toBeDefined();
      expect(job!.queue).toBe(c.queue);
      expect(job!.data).toEqual({ requestId: id, staffId: sellerId, rev: 0, section: c.section, pass: 'landing' });
      expect(job!.options).toEqual({ id: job!.id, expireInSeconds: c.expire });
      const p = await passOf(id);
      expect(p.aiPassJob).toBe(job!.id);
      expect(p.aiPassRev).toBe(0);
      expect(p.aiPassAt).not.toBeNull();
      // The clock is not the ticket's: it stays the person-touch detector.
      expect(p.rev).toBe(0);
    }
    // A section the caller does not know reads as customs — the only kind
    // queued before sections existed.
    const id = await open('rastamojka', [{ name: `Yuk null ${SUFFIX}` }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: null });
    expect(passJobs(id)[0]!.queue).toBe(JOB_CALC_PREFILL);
  });

  it('a pass that stands answers a second ask without a second job — the ✅ stays truthful', async () => {
    const id = await open('rastamojka', [{ name: `Ikki ${SUFFIX}` }]);
    expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' })).toBe(true);
    expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' })).toBe(true);
    expect(passJobs(id)).toHaveLength(1);
    expect(await ticketStanding(id)).toBe('live');
  });

  it('a DEAD ticket is cleared by its own job id, and the next ask takes a new one', async () => {
    const id = await open('rastamojka', [{ name: `Olik ${SUFFIX}` }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    const [dead] = passJobs(id);
    boss.jobs.get(dead!.id)!.state = 'failed';
    expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' })).toBe(true);
    const jobs = passJobs(id);
    expect(jobs).toHaveLength(2);
    const fresh = jobs.find((j) => j.id !== dead!.id)!;
    expect((await passOf(id)).aiPassJob).toBe(fresh.id);
    // A ticket whose job pg-boss no longer knows is just as dead — once it
    // is older than a send could take. Young, it is its own send in flight.
    boss.jobs.delete(fresh.id);
    expect(await ticketStanding(id)).toBe('live');
    await db.execute(
      sql`UPDATE calc_requests SET ai_pass_at = now() - make_interval(secs => ${TICKET_SEND_WINDOW_S + 1}) WHERE id = ${id}::uuid`,
    );
    expect(await ticketStanding(id)).toBe('none');
    expect((await passOf(id)).aiPassJob).toBeNull();
  });

  it('a ticket whose job is still being SENT stands: a second ask in that moment queues nothing (review p5-spec-1, p5-adv-4)', async () => {
    const id = await open('rastamojka', [{ name: `Yolda ${SUFFIX}` }]);
    let release: () => void = () => {};
    boss.hold = new Promise<void>((resolve) => (release = resolve));
    const first = queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    try {
      await vi.waitFor(async () => expect((await passOf(id)).aiPassJob).not.toBeNull());
      expect(passJobs(id), 'the premise: the ticket is taken, its job not sent yet').toHaveLength(0);
      // Read as dead, a second press of one note took a second ticket and
      // queued a second pass; an addition was written under the first.
      expect(await ticketStanding(id)).toBe('live');
      expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' })).toBe(true);
    } finally {
      release();
    }
    expect(await first).toBe(true);
    const jobs = passJobs(id);
    expect(jobs).toHaveLength(1);
    expect((await passOf(id)).aiPassJob).toBe(jobs[0]!.id);
  });

  it('an enqueue that throws clears the mark and answers false', async () => {
    const id = await open('rastamojka', [{ name: `Navbat ${SUFFIX}` }]);
    boss.failNext = 1;
    expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' })).toBe(false);
    const p = await passOf(id);
    expect([p.aiPassRev, p.aiPassAt, p.aiPassJob]).toEqual([null, null, null]);
    expect(passJobs(id)).toHaveLength(0);
  });

  it('a person who moved the request since `atRev` wins: no ticket, no job, false — and a closed request gets none', async () => {
    const id = await open('rastamojka', [{ name: `Odam ${SUFFIX}` }]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    expect(await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka', atRev: 0 })).toBe(false);
    expect((await passOf(id)).aiPassJob).toBeNull();
    expect(passJobs(id)).toHaveLength(0);
    const closed = await open('rastamojka', [{ name: `Yopiq ${SUFFIX}` }]);
    await returnCalcRequest(closed, 'VED qaytardi — test', { actorId: sellerId });
    expect(await queueCalcPrefill({ requestId: closed, staffId: sellerId, section: 'rastamojka' })).toBe(false);
    expect(passJobs(closed)).toHaveLength(0);
  });
});

describe('every machine save stamps itself; the settle only clears (§10.2.2-3)', () => {
  freshSeller();
  it('a customs pass that finishes through the worker → `handsoff_rev = rev`, the ticket cleared', async () => {
    const id = await open('rastamojka', [{ name: `Profil ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    const [job] = passJobs(id);
    amendSpy.requeue.mockClear();
    await runJob(job!);
    const p = await passOf(id);
    expect(p.rev, 'the premise: the pass saved').toBeGreaterThan(0);
    expect(p.handsoffRev).toBe(p.rev);
    expect([p.aiPassRev, p.aiPassAt, p.aiPassJob]).toEqual([null, null, null]);
    // …and an addition stored while it ran is handed to its own job (P4's).
    expect(amendSpy.requeue).toHaveBeenCalledWith(id);
  });

  it('the grouping’s whole chain stamps too — the proposal, the rates pulled, the pricing tail’s save, the sweep', async () => {
    // The model's answer stood in by a fixed proposal, written exactly as
    // `proposeGroups` writes one: `applyProposal`, then the pricing tail
    // (`priceProposedGroups` → the book's rates through `setGroupRates`'
    // `mutateRequest`, then its `saveTable`), each under the chain it is handed.
    const id = await open('rastamojka', [{ name: `Kodsiz ${SUFFIX}`, weightKg: 100 }]);
    const ticket = (await prefillTicket(id))!;
    let handed: { expectRev?: number; handsOff?: boolean } = {};
    await aiPrefill(
      id,
      { actorId: null },
      {
        configured: true,
        propose: async (requestId, c, o = {}) => {
          handed = o;
          const items = await db.select({ seq: calcRequestItems.seq }).from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId));
          const draft = { label: 'AI guruh', tnvedCode: '3916100000', itemSeqs: items.map((i) => i.seq), aiProposed: true, confidence: 'high' as const, aiDutyPct: null, note: null };
          const applied = await applyProposal(requestId, [draft], c, o);
          const priced = await priceProposedGroups(requestId, c, { expectRev: applied.rev, handsOff: o.handsOff });
          return { groups: 1, batches: 1, failed: 0, ...priced };
        },
        pick: async () => ({ answers: null, usage: null }),
      },
      { expectRev: ticket },
    );
    expect(handed, 'the pass hands the grouping its chain AND the stamp').toEqual({ expectRev: ticket, handsOff: true });
    const p = await passOf(id);
    expect(p.rev, 'the premise: proposal, rates, tail and sweep all wrote').toBeGreaterThanOrEqual(3);
    expect(p.handsoffRev).toBe(p.rev);
  });

  it('a person’s save mid-pass → overtaken, and the stamp stays behind `rev` for good', async () => {
    const id = await open('rastamojka', [{ name: `Ortda ${SUFFIX}`, weightKg: 100 }]);
    const ticket = (await prefillTicket(id))!;
    let machineWrote: number | null = null;
    let afterPerson: number | null = null;
    const out = await aiPrefill(
      id,
      { actorId: null },
      {
        configured: true,
        propose: async (requestId, c, o = {}) => {
          const items = await db.select({ seq: calcRequestItems.seq }).from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId));
          const draft = { label: 'AI guruh', tnvedCode: '3916100000', itemSeqs: items.map((i) => i.seq), aiProposed: true, confidence: 'high' as const, aiDutyPct: null, note: null };
          // The machine's proposal lands under the chain and stamps…
          const applied = await applyProposal(requestId, [draft], c, o);
          machineWrote = applied.rev;
          // …then a PERSON saves, before the pricing tail.
          await saveTable(requestId, { items: [], adds: [] }, ctx());
          afterPerson = await prefillTicket(requestId);
          const priced = await priceProposedGroups(requestId, c, { expectRev: applied.rev, handsOff: o.handsOff });
          return { groups: 1, batches: 1, failed: 0, ...priced };
        },
        pick: async () => ({ answers: null, usage: null }),
      },
      { expectRev: ticket },
    );
    expect(out.overtaken).toBe('step 1');
    const p = await passOf(id);
    expect(p.rev).toBe(afterPerson);
    expect(machineWrote, 'the premise: the machine wrote before the person').toBe(ticket + 1);
    expect(p.handsoffRev, 'the stamp is the machine’s own last write').toBe(machineWrote);
    expect(await prefillStanding(id, p.handsoffRev)).toBe('touched');
    // A later machine save whose chain STARTS at the person's revision (a
    // pass queued after the person) passes its compare-and-set — and still
    // never pulls the stamp up over the person's write (law-money-2).
    await saveTable(id, { items: [], adds: [] }, { actorId: null }, { expectRev: afterPerson!, handsOff: true });
    const later = await passOf(id);
    expect(later.rev).toBe(afterPerson! + 1);
    expect(later.handsoffRev).toBe(machineWrote);
  });

  it('a pass KILLED after its save (no settle ran, its job then fails): the stamp is the save’s, the dead ticket clears, the request reads open', async () => {
    const id = await open('rastamojka', [{ name: `Oldirilgan ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    const [job] = passJobs(id);
    // The pass's body, without the worker's `finally`: what a SIGTERM leaves.
    await aiPrefill(id, { actorId: null }, { configured: false }, { expectRev: job!.data.rev as number });
    boss.jobs.get(job!.id)!.state = 'failed';
    const p = await passOf(id);
    expect(p.aiPassJob, 'no settle ran').toBe(job!.id);
    expect(p.handsoffRev).toBe(p.rev);
    // `amendStanding` (P4) asks exactly these: the ticket, then the stamp.
    expect(await ticketStanding(id)).toBe('none');
    expect((await passOf(id)).aiPassJob).toBeNull();
    expect(await prefillStanding(id, p.handsoffRev)).toBe('ok');
    // …and over the merged tree, P4's own answer: the add door reads it open.
    expect((await amendStanding(id)).standing).toBe('open');
  });

  it('a tariff pass writes nothing — its stamp is unchanged', async () => {
    const id = await open('yolkira', [{ name: `Tarif ${SUFFIX}` }], { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'yolkira' });
    const [job] = passJobs(id);
    await runJob(job!);
    const p = await passOf(id);
    expect([p.rev, p.handsoffRev]).toEqual([0, 0]);
    expect(p.aiPassJob).toBeNull();
  });

  it('the settle runs on a stand-down too — the ticket of a request a person took is cleared', async () => {
    const id = await open('rastamojka', [{ name: `Turdi ${SUFFIX}` }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    const [job] = passJobs(id);
    await saveTable(id, { items: [], adds: [] }, ctx());
    amendSpy.requeue.mockClear();
    await runJob(job!);
    expect((await passOf(id)).aiPassJob).toBeNull();
    expect(amendSpy.requeue).toHaveBeenCalledWith(id);
  });
});

describe('one machine message per PASS (§10.2.4)', () => {
  freshSeller();
  it('a landing pass and then an addition’s pass → TWO answers; the addition’s job redelivered → still two', async () => {
    const id = await open('rastamojka', [{ name: `Ikki javob ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }]);
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka' });
    await runJob(passJobs(id)[0]!);
    expect(await said(id)).toHaveLength(1);
    const amendId = randomUUID();
    await queueCalcPrefill({ requestId: id, staffId: sellerId, section: 'rastamojka', pass: `amend:${amendId}` });
    const amendJob = passJobs(id).find((j) => j.data.pass === `amend:${amendId}`)!;
    expect(amendJob).toBeDefined();
    await runJob(amendJob);
    await runJob(amendJob, 1);
    const rows = await said(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.payload as { pass?: string }).pass).sort()).toEqual([`amend:${amendId}`, 'landing']);
    const rerun = rows.find((r) => (r.payload as { pass: string }).pass !== 'landing')!;
    expect((rerun.payload as { text: string }).text.split('\n')[0]).toContain(`· ${RERUN_WORD} ·`);
    // Both carry ➕: the request is still open.
    expect(rows.every((r) => (r.payload as { add?: boolean }).add === true)).toBe(true);
  });

  it('an addition’s pass on a request closed mid-run sends no reply (CONC-1 kept)', async () => {
    const id = await open('rastamojka', [{ name: `Yopildi ${SUFFIX}` }]);
    await returnCalcRequest(id, 'VED qaytardi — test', { actorId: sellerId });
    const reply = { userIds: [sellerId], type: 'CalcPrefilled', text: `${AI_REPLY_HEAD} · qayta` };
    expect(await sayOnce(id, `amend:${randomUUID()}`, reply, { whileOpen: true, direct: true })).toBe(false);
    expect(await said(id)).toHaveLength(0);
  });
});

describe('law-money-1: the road is never priced on a total an addition left stale (§10.2.9)', () => {
  freshSeller();
  /** An applied addition as P4's writer stores it — its write's `rev`, its `change`. */
  const amendment = async (requestId: string, rev: number, change: Record<string, unknown>) => {
    const amendId = randomUUID();
    await db.insert(calcAmendments).values({
      id: amendId,
      requestId,
      noteId: randomUUID(),
      staffId: sellerId,
      chatId: BigInt(CHAT),
      outcome: 'applied',
      rev,
      submission: {},
      change,
    });
    return amendId;
  };
  const staleAmendment = (requestId: string) => amendment(requestId, 1, { totalsStale: ['volumeM3'] });

  it('podklyuch: the landing prices the road; the re-run after a stale cube prints §2.5’s words and no figure', async () => {
    const id = await open('podklyuch', [{ name: `Stol ${SUFFIX}`, weightKg: 100 }], { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
    const landing = await aiPrefill(id, { actorId: null }, { configured: false });
    expect(landing.text, 'the control: the road is priced').toContain('Yo‘lkira: ≈');
    const amendId = await staleAmendment(id);
    const out = await aiPrefill(id, { actorId: null }, { configured: false }, { pass: `amend:${amendId}` });
    for (const text of [out.text, out.lentaText]) {
      expect(text).toContain(ROAD_STALE_LINE);
      expect(text).not.toContain('Yo‘lkira: ≈');
      expect(text).not.toContain('JAMI (rastamojka + yo‘lkira)');
    }
    expect(out.freightUsd).toBeNull();
  });

  it('a total stays stale through a later addition that did not re-answer it, and leaves with one that did (review p5-adv-1)', async () => {
    const id = await open('podklyuch', [{ name: `Divan ${SUFFIX}`, weightKg: 100 }], { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
    const pass = async (amendId: string) => aiPrefill(id, { actorId: null }, { configured: false }, { pass: `amend:${amendId}` });
    // A line added: the typed cube is stale. Then the 2.8 b block's own
    // invitation — «2: 40 juft» — touches no total, so ITS change lists none.
    await amendment(id, 1, { cargo: null, totalsStale: ['volumeM3'] });
    const counted = await amendment(id, 2, { cargo: null, totalsStale: [] });
    const second = await pass(counted);
    expect(second.text).toContain(ROAD_STALE_LINE);
    expect(second.text).not.toContain('Yo‘lkira: ≈');
    expect(second.freightUsd).toBeNull();
    // The seller answers «jami 12 kub»: the cube is his again, the road priced.
    const answered = await amendment(id, 3, { cargo: { volumeM3: 12 }, totalsStale: [] });
    const third = await pass(answered);
    expect(third.text).toContain('Yo‘lkira: ≈');
    expect(third.text).not.toContain(ROAD_STALE_LINE);
    // The fold stops at the pass's OWN addition: the second's re-run,
    // redelivered after the third was written, still reads stale.
    expect((await pass(counted)).text).toContain(ROAD_STALE_LINE);
  });

  it('yolkira: the tariff reply after a stale cube carries no dollar figure', async () => {
    const id = await open('yolkira', [{ name: `Yuk ${SUFFIX}` }], { freightZone: 'cn', weightKg: 500, volumeM3: 10 });
    const landing = await aiPrefill(id, { actorId: null }, { configured: false });
    expect(landing.text, 'the control: priced').toMatch(/\$\d/);
    const amendId = await staleAmendment(id);
    const out = await aiPrefill(id, { actorId: null }, { configured: false }, { pass: `amend:${amendId}` });
    expect(out.text).toContain(ROAD_STALE_LINE);
    expect(out.text).not.toMatch(/\$\d/);
    expect(out.lentaText).not.toMatch(/\$\d/);
    expect(out.freightUsd).toBeNull();
  });
});

describe('his ⭐ of Question 7: the re-run reaches a seller who muted the AI’s answers', () => {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 500;

  /** Only this case's rows are claimable while the drain runs (#713, #730). */
  const drain = async (mine: string[]) => {
    const others = await db
      .update(notifications)
      .set({ status: 'sending', claimedAt: new Date() })
      .where(
        and(
          eq(notifications.channel, 'telegram'),
          eq(notifications.status, 'pending'),
          mine.length ? notInArray(notifications.id, mine) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    for (const row of others) parked.add(row.id);
    await sendPendingTelegram().catch(() => {});
  };

  it('his `amend:*` answer is ONE pending row marked direct, which the drain SENDS; the landing’s stays muted', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    process.env.APP_URL = 'https://test.gsrwms.uz';
    __resetTelegramPause();
    __setTelegramTransport(async (url, init) => {
      sent.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: { message_id: (nextMessageId += 1) } }), { status: 200 });
    });
    const id = await open('rastamojka', [{ name: `Jim ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }], {}, mutedId);
    // The landing's pass: R2's mute holds — one muted claim row, nothing sent.
    await queueCalcPrefill({ requestId: id, staffId: mutedId, section: 'rastamojka' });
    await runJob(passJobs(id)[0]!);
    const landing = await said(id, mutedId);
    expect(landing).toHaveLength(1);
    expect(landing[0]).toMatchObject({ status: 'muted' });
    // The re-run he started himself with «✅ Qo‘shish».
    const amendId = randomUUID();
    await queueCalcPrefill({ requestId: id, staffId: mutedId, section: 'rastamojka', pass: `amend:${amendId}` });
    await runJob(passJobs(id).find((j) => j.data.pass === `amend:${amendId}`)!);
    const rerun = (await said(id, mutedId)).filter((r) => (r.payload as { pass: string }).pass === `amend:${amendId}`);
    expect(rerun).toHaveLength(1);
    expect(rerun[0]!.status).toBe('pending');
    expect((rerun[0]!.payload as { direct?: boolean }).direct).toBe(true);

    sent.length = 0;
    await drain([rerun[0]!.id]);
    const messages = sent.filter((c) => c.method === 'sendMessage');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body.chat_id).toBe(CHAT);
    // …with its ➕, and the row written as sent with its Telegram identity —
    // so a reply to it reaches the reply door like any sent ping (P4's door).
    expect(JSON.stringify(messages[0]!.body.reply_markup)).toContain(`ca:${id}`);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, rerun[0]!.id));
    expect(row!.status).toBe('sent');
    expect((row!.payload as { tg?: unknown }).tg).toEqual({ chatId: CHAT, messageId: nextMessageId });
    // …and P4's reply door reads that sent row as the add door on THIS
    // request — a reply «2: 40 juft» to it opens the add collection there
    // (the merged tree; calc-amend-bot.integration walks the handler chain).
    expect(await replyVerdictFor(BigInt(CHAT), nextMessageId, mutedId)).toEqual({ kind: 'calc_add', requestId: id });
    // The landing's muted row was never sent.
    const [mutedRow] = await db.select().from(notifications).where(eq(notifications.id, landing[0]!.id));
    expect(mutedRow!.status).toBe('muted');
    __setTelegramTransport(null);
  });
});

describe('the lenta’s chips still read a re-run (feed.ts, PF-9)', () => {
  freshSeller();
  it('a priced `amend:*` tariff note is «tariff», an `amend:*` AI note «ai»', async () => {
    // On the lead's card, written by the worker's own lenta copy.
    const tariffId = (
      await openCalcRequest(
        { intakeDoor: null, entityType: 'lead', entityId: leadId, section: 'yolkira', freightZone: 'cn', weightKg: 500, volumeM3: 10, items: [{ name: `Lenta tarif ${SUFFIX}` }], source: 'card' },
        ctx(),
      )
    ).id;
    madeRequests.push(tariffId);
    const aiId = (
      await openCalcRequest(
        { intakeDoor: null, entityType: 'lead', entityId: leadId, section: 'rastamojka', items: [{ name: `Lenta ai ${SUFFIX}`, tnvedCode: '3916100000', weightKg: 100 }], source: 'card' },
        ctx(),
      )
    ).id;
    madeRequests.push(aiId);
    for (const [id, section] of [[tariffId, 'yolkira'], [aiId, 'rastamojka']] as const) {
      await queueCalcPrefill({ requestId: id, staffId: sellerId, section, pass: `amend:${randomUUID()}` });
      await runJob(passJobs(id)[0]!);
    }
    // The machine's notes on the card — no author — found by their heading.
    const notes = await db
      .select({ id: crmActivities.id, note: crmActivities.note })
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityId, leadId), sql`${crmActivities.createdBy} IS NULL`));
    const tariffNote = notes.find((n) => (n.note ?? '').startsWith(TARIFF_PRICED_HEAD) && (n.note ?? '').includes(RERUN_WORD));
    const aiNote = notes.find((n) => (n.note ?? '').startsWith(AI_REPLY_HEAD) && (n.note ?? '').includes(RERUN_WORD));
    expect(tariffNote, 'the tariff re-run’s lenta note').toBeDefined();
    expect(aiNote, 'the AI re-run’s lenta note').toBeDefined();
    const items = await clientFeed(null, { money: false, leadId });
    const chipOf = (id: string) => {
      const item = items.find((i) => i.id === `ac-${id}`);
      expect(item, id).toBeTruthy();
      return machineReplyOf(item!);
    };
    expect(chipOf(tariffNote!.id)).toBe('tariff');
    expect(chipOf(aiNote!.id)).toBe('ai');
  });
});

describe('his 2.8 b in a real pass, and the stored request’s one reader', () => {
  freshSeller();
  /** A sweater whose law is «kamida $1/dona» (the seeded book), stating only its kilos. */
  const sweater = (by = sellerId) =>
    open('rastamojka', [{ name: `Sviter ${SUFFIX} ${seq++}`, weightKg: 150, tnvedCode: '6110200000' }], { weightKg: 150 }, by);
  /** The machine's notes on a request's card — no author. */
  const lentaOf = async (requestId: string) => {
    const [row] = await db.select({ entityId: calcRequests.entityId }).from(calcRequests).where(eq(calcRequests.id, requestId));
    const notes = await db
      .select({ note: crmActivities.note })
      .from(crmActivities)
      .where(and(eq(crmActivities.entityId, row!.entityId), sql`${crmActivities.createdBy} IS NULL`));
    return notes.map((n) => n.note ?? '').join('\n');
  };
  const worked = async (requestId: string, by: string, pass?: string) => {
    await queueCalcPrefill({ requestId, staffId: by, section: 'rastamojka', ...(pass ? { pass } : {}) });
    await runJob(passJobs(requestId).find((j) => j.data.pass === (pass ?? 'landing'))!);
  };

  it('the answer asks the count the law pins — by `seq`, in the chat block and the lenta line', async () => {
    const id = await sweater();
    const ticket = (await prefillTicket(id))!;
    const out = await aiPrefill(id, { actorId: null }, { configured: false }, { expectRev: ticket });
    expect(out.text).toContain('❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:');
    expect(out.text).toMatch(/· 1-qator «Sviter [^»]+»: soni \(dona\) — boj kamida \$1\/dona/);
    expect(out.text).toContain('«1: 300 dona»');
    expect(out.lentaText).toContain('❓ Sotuvchidan so‘raldi: 1-qator o‘lchovi (qonun so‘raydi).');
  });

  it('through the worker, the card’s lenta says the seller was asked only when his copy reaches him (review p5-adv-2)', async () => {
    // A linked seller who hears the answer: the line is true.
    const hears = await mintUser('hears');
    await db.insert(telegramLinks).values({ userId: hears, telegramChatId: BigInt(CHAT + 1), status: 'linked', linkedAt: new Date() });
    const asked = await sweater(hears);
    await worked(asked, hears);
    expect(await lentaOf(asked)).toContain('❓ Sotuvchidan so‘raldi: 1-qator o‘lchovi (qonun so‘raydi).');
    // The muted seller's landing, and a seller with no linked chat: a claim
    // row and no message — the VED must not wait on a question nobody got.
    for (const by of [mutedId, sellerId]) {
      const id = await sweater(by);
      await worked(id, by);
      const lenta = await lentaOf(id);
      expect(lenta, 'the premise: the answer is on the card').toContain(AI_REPLY_HEAD);
      expect(lenta).not.toContain('Sotuvchidan so‘raldi');
    }
    // A re-run the muted seller started himself goes past his mute (direct):
    // that copy reaches him, and the line is true again.
    const rerun = await sweater(mutedId);
    await worked(rerun, mutedId, `amend:${randomUUID()}`);
    expect(await lentaOf(rerun)).toContain('❓ Sotuvchidan so‘raldi: 1-qator');
  });

  it('…and asks nothing once a person has written since the machine (handsoff ≠ rev)', async () => {
    const id = await sweater();
    const ticket = (await prefillTicket(id))!;
    // The machine's save, then a person's, then the answer is read again.
    await saveTable(id, { items: [], adds: [] }, { actorId: null }, { expectRev: ticket, handsOff: true });
    await saveTable(id, { items: [], adds: [] }, ctx());
    const ws = await loadWorkspace(id);
    expect(ws!.handsoffRev).not.toBe(ws!.rev);
    expect(lawAsksInputOf(ws!)).toBeNull();
  });

  it('the workspace adapter and the stored-request adapter ask the same rows of one request (performance-9)', async () => {
    const id = await sweater();
    await saveTable(id, { items: [], adds: [] }, { actorId: null }, { expectRev: 0, handsOff: true });
    const fromWs = lawAsksOf(lawAsksInputOf((await loadWorkspace(id))!)!);
    const fromStored = lawAsksOf(lawAsksInputOfStored((await storedRequestFacts(id))!));
    expect(fromWs.map((a) => a.seq)).toEqual([1]);
    expect(fromWs).toEqual(fromStored);
  });

  it('`requestAsks` answers to the GROUP’s law once the row is grouped (judge S9, §10.2.7)', async () => {
    const id = await sweater();
    // Landed, ungrouped: the book's floor asks the count.
    expect((await requestAsks(id)).lines.map((l) => [l.seq, l.units])).toEqual([[1, ['dona']]]);
    await saveTable(id, { items: [], adds: [] }, ctx());
    const [group] = await db.select({ id: calcGroups.id }).from(calcGroups).where(eq(calcGroups.requestId, id));
    expect(group, 'the premise: the sweep grouped the coded row').toBeDefined();
    // The VED retypes the group's law to plain ad valorem: the floor is gone.
    await setGroupRates(
      group!.id,
      { tnvedCode: '6110200000', dutyPct: 20, vatPct: 12, dutyFree: false, vatFree: false, dutyMode: 'advalor', dutySpecific: null, dutyUnit: null },
      ctx(),
    );
    expect((await requestAsks(id)).lines.filter((l) => l.pinned.length > 0)).toEqual([]);
  });
});

describe('Uch band’s retried landings queue the pass a cut left owed (§10.2.1, p5-p6-6)', () => {
  freshSeller();
  const seller = (id: string): Actor =>
    ({
      id,
      fullName: `Pass sotuvchi ${SUFFIX}`,
      roles: ['sales_manager'],
      permissions: new Set(['crm.leads', 'clients.view_own', 'finance.view']),
    }) as unknown as Actor;
  const jobsOfNote = async (noteId: string) => {
    const reqs = await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    reqs.forEach((r) => madeRequests.push(r.id));
    return { requests: reqs.length, jobs: reqs.flatMap((r) => passJobs(r.id)).length };
  };

  it('the bot’s landing: a cut before the queue, then the same note again → exactly one pass; a second press while it stands → still one', async () => {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const noteId = randomUUID();
    madeNotes.push(noteId);
    const land = () =>
      landIntake({
        intakeDoor: null,
        noteId,
        section: 'rastamojka',
        facts: { weightKg: 100, goods: [{ name: `Kesilgan ${SUFFIX}`, weightKg: 100 }] },
        steps: [],
        fileCount: 0,
        collectedBy: sellerId,
        collectedByName: 'Pass xodim',
        client: { id: client!.id, clientCode: client!.clientCode, name: client!.name },
        leadName: client!.clientCode,
        leadPhone: null,
      });
    boss.failNext = 1;
    const first = await land();
    expect(first.queued).toBe(true);
    expect(first.replyQueued, 'the cut: no pass was queued').toBe(false);
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 0 });
    const retried = await land();
    expect(retried.outcome).toBe('retried');
    expect(retried.replyQueued).toBe(true);
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
    const again = await land();
    expect(again.replyQueued, 'the ✅ stays truthful: a pass stands').toBe(true);
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
    // The pass runs (its settle clears the ticket) and a VED then saves. A
    // later resume of the same note must not take a fresh ticket at the
    // VED's revision: `atRev: 0` is all that stops a second paid pass over
    // his work — `prefillStanding` compares the revision alone (review p5-adv-3).
    const [req] = await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    await runJob(passJobs(req!.id)[0]!);
    await saveTable(req!.id, { items: [], adds: [] }, ctx());
    expect((await land()).replyQueued).toBe(false);
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
  });

  it('the thread door from a CLIENT (the root branch): a cut, then the retried press → exactly one pass', async () => {
    const [msg] = await db
      .insert(tgMessages)
      .values({
        clientId,
        managerUserId: sellerId,
        peerId: 525252n,
        tgMessageId: BigInt(Math.floor(Math.random() * 1_000_000_000)),
        direction: 'in',
        body: '300 dona kurtka, 2 kub',
        sentAt: new Date(),
      })
      .returning({ id: tgMessages.id });
    madeTg.push(msg!.id);
    const noteId = randomUUID();
    madeNotes.push(noteId);
    const press = () =>
      threadCalcSend(
        seller(sellerId),
        { entity: { kind: 'client', id: clientId }, section: 'rastamojka', messageIds: [msg!.id], noteId },
        { actorId: sellerId, ip: null, userAgent: null },
      );
    boss.failNext = 1;
    await press();
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 0 });
    await press();
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
    await press();
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
    // …and after the pass ran and a VED saved, a re-press queues nothing
    // over his work (`atRev: 0`, review p5-adv-3).
    const [req] = await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    await runJob(passJobs(req!.id)[0]!);
    await saveTable(req!.id, { items: [], adds: [] }, ctx());
    await press();
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
  });

  it('the thread door from a DEAL card: a resend after the commit is `note_taken` — no second request, no second pass (the stated cut, §15)', async () => {
    const dealId = await freshDeal();
    const [msg] = await db
      .insert(tgMessages)
      .values({
        clientId,
        managerUserId: sellerId,
        peerId: 535353n,
        tgMessageId: BigInt(Math.floor(Math.random() * 1_000_000_000)),
        direction: 'in',
        body: '200 dona shim',
        sentAt: new Date(),
      })
      .returning({ id: tgMessages.id });
    madeTg.push(msg!.id);
    const noteId = randomUUID();
    madeNotes.push(noteId);
    const press = () =>
      threadCalcSend(
        seller(sellerId),
        { entity: { kind: 'deal', id: dealId }, section: 'rastamojka', messageIds: [msg!.id], noteId },
        { actorId: sellerId, ip: null, userAgent: null },
      );
    await press();
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
    await expect(press()).rejects.toMatchObject({ code: 'note_taken' });
    expect(await jobsOfNote(noteId)).toEqual({ requests: 1, jobs: 1 });
  });
});

/**
 * The two bot doors in a real pass, through the worker (docs/IKKI-ESHIK.md
 * §2.4, §2.6, §3.5, §3.6). «🧮 Hisoblatish» (his 3a): the pass still prepares
 * the card, and the seller hears NOTHING — every message goes through
 * `sayOnce`'s silent mode, a claim row written `muted` «oddiy eshik», which
 * the drain never sends and the problem counter never counts, and `spoke`
 * still gates the ONE lenta note a redelivery must not repeat. «🤖 AI
 * rastamojka»: the figure reaches him past his mute (his 4a of 2026-11-08,
 * §3.6) and — since docs/AI-SORAYDI.md §3.4 A1 (his 4a of 2026-11-11, review
 * JR-13, re-anchored from IKKI-ESHIK's 5a «asks nothing») — ASKS him again.
 * The sweater's law is «kamida $1/dona» and it states only kilos, so the
 * answer asks its count, as a request from before the doors does (2.8 b,
 * pinned above).
 */
describe('the two doors through the worker (Ikki eshik)', () => {
  freshSeller();
  let hears = '';
  beforeAll(async () => {
    // A linked seller who WOULD hear every message: the plain door's silence
    // is the door's, not a missing chat.
    hears = await mintUser('door-hears');
    await db.insert(telegramLinks).values({ userId: hears, telegramChatId: BigInt(CHAT + 7), status: 'linked', linkedAt: new Date() });
  });
  const sweaterAt = (door: 'plain' | 'ai', by: string) =>
    open('rastamojka', [{ name: `Sviter ${door} ${SUFFIX} ${seq++}`, weightKg: 150, tnvedCode: '6110200000' }], { weightKg: 150, intakeDoor: door }, by);
  const lentaOf = async (requestId: string) => {
    const [row] = await db.select({ entityId: calcRequests.entityId }).from(calcRequests).where(eq(calcRequests.id, requestId));
    return (
      await db
        .select({ note: crmActivities.note })
        .from(crmActivities)
        .where(and(eq(crmActivities.entityId, row!.entityId), sql`${crmActivities.createdBy} IS NULL`))
    ).map((n) => n.note ?? '');
  };
  const counted = async (id: string) =>
    (
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(telegramProblemSql(problemSince()), eq(notifications.id, id)))
    ).length;

  it('«🧮»: ONE silent claim — muted «oddiy eshik», never sent, never a problem — and ONE money-free note, a redelivery adding neither', async () => {
    const id = await sweaterAt('plain', hears);
    await queueCalcPrefill({ requestId: id, staffId: hears, section: 'rastamojka' });
    const job = passJobs(id)[0]!;
    await runJob(job);
    const rows = await said(id, hears);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'muted', error: SILENT_DOOR_ERROR });
    expect(await counted(rows[0]!.id)).toBe(0);
    // The claim's text is the VED's note — the estimate travels nowhere.
    const text = (rows[0]!.payload as { text: string }).text;
    expect(text.startsWith(AI_NOTE_HEAD)).toBe(true);
    const notes = (await lentaOf(id)).filter((n) => n.startsWith(AI_NOTE_HEAD));
    expect(notes).toHaveLength(1);
    // His 2.7: the count the law pins is named for the VED, never asked.
    expect(notes[0]).toMatch(/⚠️ VED uchun: 1-qator «Sviter plain [^»]+»: soni \(dona\)\./);
    for (const money of ['≈', 'Rastamojka jami', 'Taxminiy', 'Aniq', 'JAMI', '❓', 'reply qilib']) expect(notes[0], money).not.toContain(money);

    // The job re-delivered (the process died after the claim): nothing more —
    // whether the standing stands it down (its own writes moved the clock)…
    await runJob(job, 1);
    // …or lets it run to the reply again (a job queued before tickets carries
    // no revision, so nothing stands it down): the claim answers «said», and
    // `spoke` is what keeps the second note off the card.
    await runJob({ ...job, data: { ...job.data, rev: undefined } }, 1);
    expect(await said(id, hears)).toHaveLength(1);
    expect((await lentaOf(id)).filter((n) => n.startsWith(AI_NOTE_HEAD))).toHaveLength(1);
    // …and nothing at all ever answered under the AI-VED's heading.
    expect((await lentaOf(id)).some((n) => n.startsWith(AI_REPLY_HEAD))).toBe(false);
  });

  it('«🧮»: an addition’s re-run is silent too — `direct` on every other door, outranked here (§2.6)', async () => {
    const id = await sweaterAt('plain', hears);
    const amendId = randomUUID();
    await queueCalcPrefill({ requestId: id, staffId: hears, section: 'rastamojka', pass: `amend:${amendId}` });
    await runJob(passJobs(id).find((j) => j.data.pass === `amend:${amendId}`)!);
    const rows = await said(id, hears);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'muted', error: SILENT_DOOR_ERROR });
    expect((rows[0]!.payload as { direct?: boolean }).direct).toBeUndefined();
  });

  it('«🤖»: the figure reaches a seller who muted the answers — one pending direct row — and ASKS him (A1)', async () => {
    const id = await sweaterAt('ai', mutedId);
    await queueCalcPrefill({ requestId: id, staffId: mutedId, section: 'rastamojka' });
    await runJob(passJobs(id)[0]!);
    const rows = await said(id, mutedId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect((rows[0]!.payload as { direct?: boolean }).direct).toBe(true);
    const text = (rows[0]!.payload as { text: string }).text;
    expect(text.startsWith(AI_REPLY_HEAD)).toBe(true);
    // The AI door's own block — the law's count, the seller's to send.
    expect(text).toContain(SELLER_ASKS_HEAD);
    expect(text).toMatch(/^· 1-qator «Sviter ai [^»]+»: soni \(dona\) — boj kamida \$1\/dona$/m);
    expect(text).toContain('✍️ Shu xabarga reply qilib yozing: «1: 300 dona»');
    expect(text).not.toContain('sizdan so‘raydi');
    // He hears it (`direct`), so the card's copy says he WAS asked — not the VED's gaps.
    const lenta = (await lentaOf(id)).join('\n');
    expect(lenta).toContain('❓ Sotuvchidan so‘raldi: 1-qator.');
    expect(lenta).not.toContain('VED uchun');
  });

  it('«🤖» to a seller nobody reaches: the card carries the copy that asks nobody — the gaps named for the VED (A1)', async () => {
    // `lentaUnasked` is the AI door's too now: its answer asks, and a seller
    // who never got it must not be waited on — the card says the VED asks.
    const id = await sweaterAt('ai', sellerId);
    const ticket = (await prefillTicket(id))!;
    const out = await aiPrefill(id, { actorId: null }, { configured: false }, { expectRev: ticket });
    expect(out.lentaText).toContain('❓ Sotuvchidan so‘raldi: 1-qator.');
    expect(out.lentaUnasked).toMatch(/⚠️ VED uchun: 1-qator «Sviter ai [^»]+»: soni \(dona\)\./);
    expect(out.lentaUnasked).not.toContain('Sotuvchidan so‘raldi');
    const viaWorker = await sweaterAt('ai', sellerId);
    await queueCalcPrefill({ requestId: viaWorker, staffId: sellerId, section: 'rastamojka' });
    await runJob(passJobs(viaWorker)[0]!);
    const lenta = (await lentaOf(viaWorker)).join('\n');
    expect(lenta).toMatch(/⚠️ VED uchun: 1-qator «Sviter ai [^»]+»: soni \(dona\)\./);
    expect(lenta).not.toContain('Sotuvchidan so‘raldi');
  });

  it('`silent` keeps the claim’s two refusals: an earlier claim, and — under `whileOpen` — a closed request', async () => {
    const id = await sweaterAt('plain', sellerId);
    const reply = { userIds: [sellerId], type: 'CalcPrefilled', text: `${AI_NOTE_HEAD} · test` };
    expect(await sayOnce(id, 'landing', reply, { silent: true })).toBe(true);
    expect(await sayOnce(id, 'landing', reply, { silent: true })).toBe(false);
    expect(await said(id)).toHaveLength(1);
    const closed = await sweaterAt('plain', sellerId);
    await returnCalcRequest(closed, 'VED qaytardi — test', { actorId: sellerId });
    expect(await sayOnce(closed, 'landing', reply, { whileOpen: true, silent: true })).toBe(false);
    expect(await said(closed)).toHaveLength(0);
  });
});
