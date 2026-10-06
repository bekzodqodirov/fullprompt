import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, openCalcRequest, takeCalcRequest } from '@/modules/wms/calc/service';
import { chainOf, chainVersionsFor } from '@/modules/wms/calc/chain';
import { calcRegistrySight } from '@/modules/wms/calc/control-scope';
import { calcSheetsForRequest, dealCalcSheets } from '@/modules/wms/calc/sheet';
import {
  confirmAllGroups,
  createGroup,
  loadWorkspace,
  moveItemToGroup,
  recalcFromSealed,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';

/**
 * «🧮 Bitim hisobi» (0119, 19/26a/27a) read back from real seals and real
 * Готово answers. The DISPLAY rule is not the money rule: a sheet prints
 * what was calculated and what was answered, and `answerFloorStandsSql` —
 * which decides what a commission is paid on — would hide answers a person
 * still needs to read. Fixtures are this file's own deals (#183: a seal
 * writes onto its card).
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `SHEET-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
const ctx = () => ({ actorId });
const NO_DISCOUNT = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };
const SIGHT = calcRegistrySight({ permissions: new Set(['finance.reports']) })!;

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `Sheet fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `SH${SUFFIX}`, name: `Sheet client ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeDeals.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
    await db.delete(deals).where(inArray(deals.id, madeDeals));
  }
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function mintDeal(): Promise<string> {
  const [deal] = await db
    .insert(deals)
    .values({ code: `SH-${SUFFIX}-${(seq += 1)}`, clientId, stageId, title: 'Sheet fixture', createdBy: actorId })
    .returning();
  madeDeals.push(deal!.id);
  return deal!.id;
}

async function open(dealId: string, section: 'rastamojka' | 'podklyuch' | 'yolkira') {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `monitor ${tag()}`, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result.id;
}

/** A Готово answer: a price a VED typed without sealing (27a). */
async function answered(dealId: string, amount: number, currency = 'USD') {
  const id = await open(dealId, 'rastamojka');
  await takeCalcRequest(id, ctx());
  await finishCalcRequest(id, { amountText: String(amount), currency, note: 'gotovo', internalNote: 'ichki: gotovo' }, ctx());
  return id;
}

/** A podklyuch request priced end to end and SEALED. */
async function sealed(dealId: string) {
  const id = await open(dealId, 'podklyuch');
  const groupId = await createGroup(id, { label: 'Monitorlar', tnvedCode: '8528520000' }, ctx());
  const workspace = await loadWorkspace(id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(id, item.seq, groupId, ctx());
    await setItemBaza(id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
  }
  await setGroupRates(
    groupId,
    { tnvedCode: '8528520000', dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: false, source: 'typed' },
    ctx(),
  );
  await setFreightZone(id, 'cn', ctx());
  await confirmAllGroups(id, ctx());
  await sealCalc(id, NO_DISCOUNT, ctx());
  return id;
}

async function sealedYolkira(dealId: string) {
  const id = await open(dealId, 'yolkira');
  await setFreightZone(id, 'cn', ctx());
  await sealCalc(id, NO_DISCOUNT, ctx());
  return id;
}

async function corrected(parentId: string) {
  const freshId = await recalcFromSealed(parentId, ctx());
  madeRequests.push(freshId);
  await confirmAllGroups(freshId, ctx());
  await sealCalc(freshId, NO_DISCOUNT, ctx());
  return freshId;
}

const sheetsOf = async (dealId: string) => (await dealCalcSheets([dealId], SIGHT)).get(dealId)!;

describe('a Готово answer is «muhrlanmagan», in any currency (27a)', () => {
  it('a standing USD answer and a UZS one both print, newest first, with no sheet', async () => {
    const dealId = await mintDeal();
    const usd = await answered(dealId, 450);
    const uzs = await answered(dealId, 5_600_000, 'UZS');
    const got = await sheetsOf(dealId);
    expect(got.sheets).toEqual([]);
    expect(got.answers.map((a) => [a.requestId, a.amount, a.currency])).toEqual([
      [uzs, 5_600_000, 'UZS'],
      [usd, 450, 'USD'],
    ]);
    expect(got.answers[0]!.completedAt).toBeInstanceOf(Date);
    expect(got.answers[0]!.byName).toBe(`Sheet fixture ${SUFFIX}`);
  });

  it('a rastamojka answer survives a LATER yo\'lkira seal on the same deal — another job, still its answer', async () => {
    const dealId = await mintDeal();
    const rast = await answered(dealId, 300);
    const yol = await sealedYolkira(dealId);
    const got = await sheetsOf(dealId);
    expect(got.sheets.map((s) => [s.requestId, s.section])).toEqual([[yol, 'yolkira']]);
    expect(got.answers.map((a) => a.requestId)).toEqual([rast]);
    // A yo'lkira seal has no groups: its goods come from the request's items (#874).
    expect(got.sheets[0]!.groups).toEqual([]);
    expect(got.sheets[0]!.goods).toHaveLength(1);
    expect(got.sheets[0]!.freight?.zone).toBe('cn');
  });
});

describe('the chain prints under the newest seal', () => {
  it('V2 stands and lists V1 under it', async () => {
    const dealId = await mintDeal();
    const first = await sealed(dealId);
    const second = await corrected(first);
    const got = await sheetsOf(dealId);
    expect(got.sheets).toHaveLength(1);
    const sheet = got.sheets[0]!;
    expect(sheet.requestId).toBe(second);
    expect(sheet.quoteNo).toBe(2);
    expect(sheet.status).toBe('stands');
    expect(sheet.previous.map((p) => p.quoteNo)).toEqual([1]);
    expect(sheet.sealedByName).toBe(`Sheet fixture ${SUFFIX}`);
    expect(sheet.groups[0]!.dutyText).toBe('10%');
    // The workspace mounts the same sheet for its own request.
    expect((await calcSheetsForRequest(second, SIGHT))!.quoteNo).toBe(2);
    expect((await calcSheetsForRequest(first, SIGHT))!.quoteNo).toBe(1);
  });

  it('a correction being written keeps V1 standing, marked «recalc_open»', async () => {
    const dealId = await mintDeal();
    const first = await sealed(dealId);
    const draft = await recalcFromSealed(first, ctx());
    madeRequests.push(draft);
    const got = await sheetsOf(dealId);
    expect(got.sheets.map((s) => [s.requestId, s.quoteNo, s.status])).toEqual([[first, 1, 'recalc_open']]);
    expect(await calcSheetsForRequest(draft, SIGHT)).toBeNull();
  });

  it('chainVersionsFor answers what chainOf answers, request by request, in ONE read', async () => {
    const dealId = await mintDeal();
    const first = await sealed(dealId);
    const second = await corrected(first);
    const draft = await recalcFromSealed(second, ctx());
    madeRequests.push(draft);
    const lone = await sealed(await mintDeal());
    const ids = [first, second, draft, lone];
    const batch = await chainVersionsFor(ids);
    for (const id of ids) expect(batch.get(id), id).toEqual(await chainOf(id));
  });
});
