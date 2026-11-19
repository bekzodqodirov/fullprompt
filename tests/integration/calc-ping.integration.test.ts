import 'dotenv/config';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The drain kick and the agent's calc-answer job both go to pg-boss; nothing
// here runs a worker, so the queue is stood in for (agent-answers' shape).
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db } from '@/modules/platform/db/client';
import {
  agentCalcLinks,
  agentConfig,
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  dealStages,
  deals,
  events,
  leads,
  notifications,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, returnCalcRequest, takeCalcRequest } from '@/modules/wms/calc/service';
import { recalcFromSealed, sealCalc, setFreightZone } from '@/modules/wms/calc/workspace';
import { calcRequestFacts, sendCalcPing } from '@/modules/wms/calc/request-head';
import { agentSpeaksForCalc } from '@/modules/wms/agent/calc-loop';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { usd } from '@/modules/platform/telegram/format';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import { sawRev } from '../fixtures/calc-saw-rev';

/**
 * The five calc pings in the database (the owner's answers of 2026-11-19, his
 * 9 «$/kub ham qo‘shilsin»): who is told (the requester, and the card's
 * CURRENT owner when that is somebody else — never beside the AI sotuvchi),
 * what each of them reads behind the card's own door, the sealed V of the
 * CHAIN and the stored figure with its per-m³.
 *
 * Requests are inserted directly and held by this file's own VEDs, never the
 * rota's next seeded colleague (#154). agent_config is CONFIGURATION on the
 * one shared database (#183): its owner column is read first and put back.
 */
const SUFFIX = String(Date.now()).slice(-6);
const TOKEN = `cpg${SUFFIX}`;
const APP = 'https://gsr.test';
const NO_DISCOUNT = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };
let seq = 0;
const phone = () => `+99896${SUFFIX}${(seq += 1)}`;
const ctx = (actorId: string) => ({ actorId });

let sellerId = '';
let ownerId = '';
let vedId = '';
let ved2Id = '';
let clientId = '';
let reassignedDeal = '';
let reassignedCode = '';
let ownDeal = '';
let ownCode = '';
let leadId = '';
let leadName = '';
let agentOwnerBefore: string | null = null;
let appUrlBefore: string | undefined;
const madeUsers: string[] = [];
const madeRequests: string[] = [];
const madeDeals: string[] = [];

async function userWithRole(role: string, name: string): Promise<string> {
  const [u] = await db.insert(users).values({ phone: phone(), fullName: name, passwordHash: 'x' }).returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  madeUsers.push(u!.id);
  return u!.id;
}

async function job(opts: {
  section: 'yolkira' | 'rastamojka';
  entityType?: 'deal' | 'lead';
  entityId: string;
  requestedBy?: string;
  holder?: string | null;
  goods: string[];
  volumeM3?: string | null;
}): Promise<string> {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType: opts.entityType ?? 'deal',
      entityId: opts.entityId,
      requestedBy: opts.requestedBy ?? sellerId,
      assigneeId: opts.holder === undefined ? vedId : opts.holder,
      itemCount: opts.goods.length,
      section: opts.section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: '1500',
      volumeM3: opts.volumeM3 === undefined ? '30' : opts.volumeM3,
      dueAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: calcRequests.id });
  let n = 0;
  for (const name of opts.goods) {
    n += 1;
    await db.insert(calcRequestItems).values({ requestId: r!.id, seq: n, name, nameNorm: itemNameNorm(name), quantity: '10' });
  }
  madeRequests.push(r!.id);
  return r!.id;
}

/** Every ping of a type this file's people were sent, newest last — the text and the button's word. */
async function pings(type: string, userId: string, mark: string) {
  const rows = await db
    .select({ payload: notifications.payload, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)))
    .orderBy(notifications.createdAt);
  return rows
    .map((r) => r.payload as { text?: string; openAs?: string })
    .filter((p) => String(p.text ?? '').includes(mark))
    .map((p) => ({ text: String(p.text ?? ''), openAs: p.openAs ?? null }));
}

beforeAll(async () => {
  appUrlBefore = process.env.APP_URL;
  process.env.APP_URL = APP;
  const [cfg] = await db.select({ ownerUserId: agentConfig.ownerUserId }).from(agentConfig).where(eq(agentConfig.id, 1));
  agentOwnerBefore = cfg?.ownerUserId ?? null;

  sellerId = await userWithRole('sales_manager', `Ping Sotuvchi ${SUFFIX}`);
  ownerId = await userWithRole('sales_manager', `Ping Egasi ${SUFFIX}`);
  vedId = await userWithRole('ved_manager', `Ping Ved ${SUFFIX}`);
  ved2Id = await userWithRole('ved_manager', `Ping Ved2 ${SUFFIX}`);

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `PG${SUFFIX}`, name: `Ping mijoz ${SUFFIX}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  // The seller asked; the deal was then handed to a colleague — the case the
  // second recipient exists for.
  const [d1] = await db
    .insert(deals)
    .values({ code: `PG-R-${SUFFIX}`, clientId, stageId: stage!.id, title: `Kurtka ishi ${TOKEN}`, createdBy: sellerId, ownerId })
    .returning({ id: deals.id, code: deals.code });
  const [d2] = await db
    .insert(deals)
    .values({ code: `PG-O-${SUFFIX}`, clientId, stageId: stage!.id, title: `O‘z ishi ${TOKEN}`, createdBy: sellerId, ownerId: sellerId })
    .returning({ id: deals.id, code: deals.code });
  reassignedDeal = d1!.id;
  reassignedCode = d1!.code;
  ownDeal = d2!.id;
  ownCode = d2!.code;
  madeDeals.push(reassignedDeal, ownDeal);
  const leadStage = await db.execute<{ id: string }>(`SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`);
  leadName = `Pinglid${SUFFIX}`;
  const [l] = await db
    .insert(leads)
    .values({
      name: leadName,
      phone: `+99899${SUFFIX}77`,
      company: `Ping Savdo ${SUFFIX}`,
      stageId: leadStage[0]!.id,
      createdBy: sellerId,
      ownerId,
    })
    .returning({ id: leads.id });
  leadId = l!.id;
});

afterAll(async () => {
  await db.update(agentConfig).set({ ownerUserId: agentOwnerBefore }).where(eq(agentConfig.id, 1));
  if (appUrlBefore === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = appUrlBefore;
  const all = await db
    .select({ id: calcRequests.id, taskId: calcRequests.taskId })
    .from(calcRequests)
    .where(or(inArray(calcRequests.entityId, [...madeDeals, leadId]), inArray(calcRequests.id, madeRequests)));
  const ids = all.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.requestId, ids));
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, ids));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, ids));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, ids));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, ids));
    await db.update(calcRequests).set({ taskId: null }).where(inArray(calcRequests.id, ids));
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
  }
  // The take's task, the hand-back's «↩️ Ma'lumot to'ldiring» and the
  // correction's task — by the cards they point at and this file's people.
  const loose = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      or(
        inArray(tasks.entityId, [...madeDeals, leadId]),
        inArray(tasks.createdBy, madeUsers),
        inArray(tasks.assigneeId, madeUsers),
      ),
    );
  if (loose.length > 0) {
    const looseIds = loose.map((t) => t.id);
    await db.delete(notifications).where(sql`${notifications.payload}->>'taskId' IN (${sql.join(looseIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.delete(events).where(inArray(events.entityId, looseIds));
    await db.delete(tasks).where(inArray(tasks.id, looseIds));
  }
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.delete(events).where(inArray(events.entityId, [...madeDeals, leadId]));
  await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(userRoles).where(inArray(userRoles.userId, madeUsers));
  // DEACTIVATED, not deleted — audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
});

describe('the facts are read by named columns into the closed projection', () => {
  it('a deal job: the card, its client, its CURRENT owner and the goods — the same keys the type pins', async () => {
    const id = await job({ section: 'rastamojka', entityId: reassignedDeal, goods: ['Kurtka', 'Shim', 'Krossovka', `Kepka ${TOKEN}`] });
    const facts = (await calcRequestFacts(id))!;
    expect(Object.keys(facts).sort()).toEqual(
      [
        'cardLabel', 'cardOwnerId', 'clientCode', 'clientName', 'dealTitle', 'entityId', 'entityType', 'fromCity',
        'goodsCount', 'goodsFirst', 'leadCompany', 'leadOwnerId', 'leadPhone', 'requestId', 'requestedBy', 'section',
        'toCity', 'volumeM3', 'weightKg',
      ].sort(),
    );
    expect(facts).toMatchObject({
      entityType: 'deal',
      cardLabel: reassignedCode,
      clientCode: `PG${SUFFIX}`,
      cardOwnerId: ownerId,
      requestedBy: sellerId,
      weightKg: 1500,
      volumeM3: 30,
      goodsFirst: ['Kurtka', 'Shim', 'Krossovka'],
      goodsCount: 4,
      leadPhone: null,
    });
    expect(await calcRequestFacts('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('«✅ Hisoblash tayyor» — the requester AND the card’s current owner, in full', () => {
  it('both are told, each by his own door; the figure is the STORED one with its $/m³; never the internal note', async () => {
    const id = await job({ section: 'rastamojka', entityId: reassignedDeal, goods: [`Kurtka ${TOKEN}`] });
    await finishCalcRequest(
      id,
      { amountText: '480', currency: 'USD', note: 'Mijozga ayting', internalNote: `ichki sir ${TOKEN}` },
      ctx(vedId),
      await sawRev(id),
    );
    const forSeller = await pings('CalcDone', sellerId, reassignedCode);
    const forOwner = await pings('CalcDone', ownerId, reassignedCode);
    expect(forSeller).toHaveLength(1);
    expect(forOwner).toHaveLength(1);
    for (const ping of [...forSeller, ...forOwner]) {
      const lines = ping.text.split('\n');
      expect(lines[0]).toBe(`✅ Hisoblash tayyor: ${reassignedCode}`);
      expect(ping.text).toContain(`👤 Mijoz: PG${SUFFIX} · Ping mijoz ${SUFFIX}`);
      expect(ping.text).toContain(`📋 Kurtka ishi ${TOKEN}`);
      expect(ping.text).toContain('🛃 Rastamojka · Yiwu → Toshkent');
      expect(ping.text).toContain(`📦 Kurtka ${TOKEN} · 1 500 kg · 30 m³`);
      // 480 ÷ 30 m³ — the request's own volume (his 9).
      expect(ping.text).toContain('💵 480 USD · $16.00/m³');
      expect(ping.text).toContain('📝 Mijozga ayting');
      expect(lines.at(-1)).toBe(`${APP}/bitimlar/${reassignedDeal}`);
      expect(ping.openAs).toBe('deal');
      expect(ping.text).not.toContain('ichki sir');
    }
    // The VED who pressed «Готово» is not told what he did.
    expect(await pings('CalcDone', vedId, reassignedCode)).toHaveLength(0);
  });

  it('a card its requester still owns is told ONCE', async () => {
    const id = await job({ section: 'rastamojka', entityId: ownDeal, goods: [`Shim ${TOKEN}`], volumeM3: null });
    await finishCalcRequest(id, { amountText: '321', currency: 'USD', note: '', internalNote: 'x' }, ctx(vedId), await sawRev(id));
    const sent = await pings('CalcDone', sellerId, ownCode);
    expect(sent).toHaveLength(1);
    // No volume on the request → no per-m³ at all, never «$0.00/m³».
    expect(sent[0]!.text).toContain('💵 321 USD\n');
    expect(sent[0]!.text).not.toContain('/m³');
  });

  it('an AI sotuvchi job: the owner hears it as the agent’s own card, so the card’s owner gets no plain «💵»', async () => {
    const id = await job({ section: 'rastamojka', entityId: reassignedDeal, goods: [`Agent ${TOKEN}`] });
    await db.insert(agentCalcLinks).values({ requestId: id, rootRequestId: id, managerUserId: sellerId, peerId: BigInt(`77${SUFFIX}`) });
    await db.update(agentConfig).set({ ownerUserId: sellerId }).where(eq(agentConfig.id, 1));
    try {
      expect(await agentSpeaksForCalc(id)).toBe(true);
      const ownerBefore = (await pings('CalcDone', ownerId, reassignedCode)).length;
      const sellerBefore = (await pings('CalcDone', sellerId, reassignedCode)).length;
      await finishCalcRequest(id, { amountText: '700', currency: 'USD', note: '', internalNote: 'x' }, ctx(vedId), await sawRev(id));
      // The requester's own ping stands; the added recipient is the one left out.
      expect((await pings('CalcDone', sellerId, reassignedCode)).length).toBe(sellerBefore + 1);
      expect((await pings('CalcDone', ownerId, reassignedCode)).length).toBe(ownerBefore);
    } finally {
      await db.update(agentConfig).set({ ownerUserId: agentOwnerBefore }).where(eq(agentConfig.id, 1));
    }
    // A job the agent did not send is not its: the predicate says so.
    const plain = await job({ section: 'rastamojka', entityId: reassignedDeal, goods: [`Plain ${TOKEN}`] });
    expect(await agentSpeaksForCalc(plain)).toBe(false);
  });
});

describe('«🧮 Hisob tayyor» — the chain’s V, the engine’s per-m³, the last day', () => {
  it('V1 on the seal, V2 on its correction (never the per-request counter), with «qayta hisoblanmoqda» between', async () => {
    const id = await job({ section: 'yolkira', entityId: ownDeal, goods: [`Monitor ${TOKEN}`] });
    await setFreightZone(id, 'cn', ctx(vedId));
    const { totalUsd } = await sealCalc(id, { ...NO_DISCOUNT, sawRev: await sawRev(id) }, ctx(vedId));
    const version = (await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, id) }))!;
    const sealed = await pings('CalcSealed', sellerId, ownCode);
    expect(sealed).toHaveLength(1);
    const text = sealed[0]!.text;
    expect(text.split('\n')[0]).toBe(`🧮 Hisob tayyor — V1: ${ownCode}`);
    // The engine's own per-m³ — the figure the version stores.
    expect(version.perM3Usd).not.toBeNull();
    expect(text).toContain(`💵 ${usd(totalUsd)} · ${usd(Number(version.perM3Usd))}/m³`);
    const [, m, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(tashkentDay(version.validUntil))!;
    expect(text).toContain(`⏳ ${d}.${m}.${tashkentDay(version.validUntil).slice(0, 4)} gacha amal qiladi`);
    expect(text).toContain('🚚 Yo‘lkira · Yiwu → Toshkent');
    expect(text.split('\n').at(-1)).toBe(`${APP}/bitimlar/${ownDeal}`);
    expect(sealed[0]!.openAs).toBe('deal');

    const fresh = (await recalcFromSealed(id, ctx(vedId))).id;
    madeRequests.push(fresh);
    const recalc = await pings('CalcRecalc', sellerId, ownCode);
    expect(recalc.at(-1)!.text.split('\n')[0]).toBe(`🔄 ${ownCode}: narx qayta hisoblanmoqda — eski narx endi amal qilmaydi`);
    expect(recalc.at(-1)!.text).toContain(`📦 Monitor ${TOKEN}`);
    await setFreightZone(fresh, 'cn', ctx(vedId));
    await sealCalc(fresh, { ...NO_DISCOUNT, sawRev: await sawRev(fresh) }, ctx(vedId));
    // THE PREMISE: the stored counter reads 1 on the correction too (#923).
    const stored = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, fresh) });
    expect(stored!.currentVersionNo).toBe(1);
    const second = await pings('CalcSealed', sellerId, ownCode);
    expect(second).toHaveLength(2);
    expect(second[1]!.text.split('\n')[0]).toBe(`🧮 Hisob tayyor — V2: ${ownCode}`);
  });
});

describe('a lead job reads behind the LEAD card’s door, per recipient', () => {
  it('a hand-back: the owner reads the phone and his lead card; the requester who lost the lead reads neither', async () => {
    const id = await job({ section: 'rastamojka', entityType: 'lead', entityId: leadId, goods: [`Lid tovar ${TOKEN}`] });
    await returnCalcRequest(id, 'Tovar nomi yetarli emas', ctx(vedId));
    const forOwner = await pings('CalcReturned', ownerId, leadName);
    const forSeller = await pings('CalcReturned', sellerId, leadName);
    expect(forOwner).toHaveLength(1);
    expect(forSeller).toHaveLength(1);
    expect(forOwner[0]!.text.split('\n')[0]).toBe(`↩️ Hisoblash qaytarildi: ${leadName}`);
    expect(forOwner[0]!.text).toContain(`📞 +99899${SUFFIX}77 · 🏢 Ping Savdo ${SUFFIX}`);
    expect(forOwner[0]!.text).toContain('📝 Tovar nomi yetarli emas');
    expect(forOwner[0]!.text.split('\n').at(-1)).toBe(`${APP}/crm/leads/${leadId}`);
    expect(forOwner[0]!.openAs).toBe('lead');
    // A seller who does not own the lead is bounced by its card: no phone, no dead door.
    expect(forSeller[0]!.text).not.toContain(`+99899${SUFFIX}77`);
    expect(forSeller[0]!.text).not.toContain('Ping Savdo');
    expect(forSeller[0]!.text).not.toContain('https://');
    expect(forSeller[0]!.openAs).toBeNull();
  });

  it('a take: a VED who asked is linked to the calculation’s screen, the lead’s owner to the lead', async () => {
    const id = await job({
      section: 'rastamojka',
      entityType: 'lead',
      entityId: leadId,
      requestedBy: vedId,
      holder: null,
      goods: [`Olingan ${TOKEN}`],
    });
    await takeCalcRequest(id, ctx(ved2Id));
    const forVed = await pings('CalcTaken', vedId, leadName);
    const forOwner = await pings('CalcTaken', ownerId, leadName);
    expect(forVed).toHaveLength(1);
    expect(forOwner).toHaveLength(1);
    expect(forVed[0]!.text).toContain(`🙋 Oldi: Ping Ved2 ${SUFFIX}`);
    expect(forVed[0]!.text).not.toContain(`+99899${SUFFIX}77`);
    expect(forVed[0]!.text.split('\n').at(-1)).toBe(`${APP}/hisoblash/${id}`);
    expect(forVed[0]!.openAs).toBe('calc');
    expect(forOwner[0]!.text.split('\n').at(-1)).toBe(`${APP}/crm/leads/${leadId}`);
    expect(forOwner[0]!.openAs).toBe('lead');
    // The taker is not told he took it.
    expect(await pings('CalcTaken', ved2Id, leadName)).toHaveLength(0);
  });
});

describe('a read that fails costs lines, never the message (R12)', () => {
  it('a request that cannot be read — an id postgres refuses — still tells the requester, with no head and no link', async () => {
    const mark = `R12 ${TOKEN}`;
    await sendCalcPing({
      requestId: 'not-a-uuid',
      requestedBy: sellerId,
      ping: { type: 'CalcDone', amount: 555, currency: 'USD', sellerNote: mark },
      exceptUserId: null,
    });
    const sent = await pings('CalcDone', sellerId, mark);
    expect(sent).toEqual([{ text: `✅ Hisoblash tayyor: —\n💵 555 USD\n📝 ${mark}`, openAs: null }]);
  });
});
