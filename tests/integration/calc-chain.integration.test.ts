import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { chainOf, quoteNoFor, registryCounts, registryRows } from '@/modules/wms/calc/chain';
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
 * The correction CHAIN — what «V2» counts, and the registry that lists it.
 *
 * The owner: «qayta hisoblaganda V1 turibti … V2 bo'lib chiqishi kerak
 * emasmi? eski narxlar tarixi bo'lishi kerak emasmidi?» The stored
 * `version_no` counts seals of ONE request and a correction is a NEW request,
 * so the column reads 1 on every correction ever made — the first test pins
 * that premise on purpose, so the day somebody «fixes» the column the
 * derived number and the stored one are measured against each other.
 *
 * Fixtures are this file's own (#183): a sealed price writes onto the card.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDC-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let clientCode = '';
let dealId = '';
let leadId = '';
let leadName = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });
const NO_DISCOUNT = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };

beforeAll(async () => {
  const [fixtureActor] = await db
    .insert(users)
    .values({
      phone: `+99892${String(Date.now()).slice(-7)}`,
      fullName: `VED chain fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = fixtureActor!.id;

  clientCode = `VC${SUFFIX}`;
  const [client] = await db
    .insert(clients)
    .values({ clientCode, name: `VED chain client ${SUFFIX}` })
    .returning();
  clientId = client!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VC-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED chain fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;

  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  leadName = `VED chain lead ${SUFFIX}`;
  const [lead] = await db
    .insert(leads)
    .values({ name: leadName, stageId: leadStage[0]!.id, createdBy: actorId })
    .returning();
  leadId = lead!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    // Children before parents: a correction points at the request it
    // supersedes and the FK refuses the other order. Deleting in one
    // statement lets postgres order it — the FK is checked at the end.
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(overrides: Partial<Parameters<typeof openCalcRequest>[0]> = {}) {
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'podklyuch',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `monitor ${tag()}`, quantity: 100 }],
      source: 'card',
      ...overrides,
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result;
}

/** A request priced end to end and SEALED. */
async function sealed(overrides: Partial<Parameters<typeof openCalcRequest>[0]> = {}) {
  const request = await open(overrides);
  const groupId = await createGroup(request.id, { label: 'Monitorlar', tnvedCode: '8528520000' }, ctx());
  const workspace = await loadWorkspace(request.id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(request.id, item.seq, groupId, ctx());
    await setItemBaza(request.id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
  }
  await setGroupRates(
    groupId,
    { tnvedCode: '8528520000', dutyPct: 10, vatPct: 12, feeUsd: 0, dutyFree: false, vatFree: false, source: 'typed' },
    ctx(),
  );
  await setFreightZone(request.id, 'cn', ctx());
  await confirmAllGroups(request.id, ctx());
  await sealCalc(request.id, NO_DISCOUNT, ctx());
  return request.id;
}

/** A correction minted from `parentId` and sealed — the confirmation does
 * not travel (#767), so it is re-given before the seal. */
async function corrected(parentId: string) {
  const freshId = await recalcFromSealed(parentId, ctx());
  madeRequests.push(freshId);
  await confirmAllGroups(freshId, ctx());
  await sealCalc(freshId, NO_DISCOUNT, ctx());
  return freshId;
}

const versionOf = async (requestId: string) =>
  (await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, requestId) }))!;

describe('«V2» is the rank in the chain, not the stored counter', () => {
  it('a correction reads V2 and the old price keeps V1 — both from either end', async () => {
    const first = await sealed();
    const second = await corrected(first);

    // THE PREMISE: the stored column reads 1 on the correction. This is the
    // owner's «qayta hisoblaganda V1 turibti», kept as an assertion so a
    // later backfill cannot silently make two numbers mean one thing.
    const stored = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, second) });
    expect(stored!.currentVersionNo).toBe(1);

    const fromChild = await chainOf(second);
    expect(fromChild.map((v) => v.quoteNo)).toEqual([1, 2]);
    expect(fromChild.map((v) => v.requestId)).toEqual([first, second]);
    // Up-walk then down-walk: the parent answers the SAME chain.
    expect(await chainOf(first)).toEqual(fromChild);

    const [v1, v2] = fromChild;
    expect(v1!.superseded).toBe(true);
    expect(v1!.supersededByNo).toBe(2);
    expect(v1!.recalcOpen).toBe(false);
    expect(v2!.superseded).toBe(false);
    expect(v2!.supersededByNo).toBeNull();

    expect(await quoteNoFor((await versionOf(second)).id)).toBe(2);
    expect(await quoteNoFor((await versionOf(first)).id)).toBe(1);
  });

  it('an OPEN correction is «qayta hisoblanmoqda» and takes no number', async () => {
    const first = await sealed();
    const draft = await recalcFromSealed(first, ctx());
    madeRequests.push(draft);

    const chain = await chainOf(first);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.quoteNo).toBe(1);
    expect(chain[0]!.superseded).toBe(true);
    expect(chain[0]!.recalcOpen).toBe(true);
    expect(chain[0]!.supersededByNo).toBeNull();
    // And from the priceless child the chain is the same one link.
    expect(await chainOf(draft)).toEqual(chain);
    // A version that does not exist has no number, rather than 0.
    expect(await quoteNoFor('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('a correction starts from the chain\'s newest link', () => {
  it('refuses a SECOND child while the first is open — «finish that one»', async () => {
    const first = await sealed();
    const draft = await recalcFromSealed(first, ctx());
    madeRequests.push(draft);
    await expect(recalcFromSealed(first, ctx())).rejects.toMatchObject({ code: 'recalc_open' });
  });

  it('refuses a superseded parent — «recalc from the newest», which then works', async () => {
    const first = await sealed();
    const second = await corrected(first);
    await expect(recalcFromSealed(first, ctx())).rejects.toMatchObject({ code: 'recalc_superseded' });
    const third = await recalcFromSealed(second, ctx());
    madeRequests.push(third);
    expect((await chainOf(third)).map((v) => v.quoteNo)).toEqual([1, 2]);
  });

  it('refuses a request closed WITHOUT a price — its name promises a sealed parent', async () => {
    const request = await open();
    // What `endRequest({via:'returned'})` leaves behind: closed, no version.
    await db.update(calcRequests).set({ completedAt: new Date() }).where(eq(calcRequests.id, request.id));
    await expect(recalcFromSealed(request.id, ctx())).rejects.toMatchObject({ code: 'not_sealed' });
  });
});

describe('the registry', () => {
  const mine = (extra: Partial<Parameters<typeof registryRows>[0]> = {}) =>
    registryRows({ sealerId: actorId, leadsReadable: true, ...extra });

  it('lists one row per SEALED version, newest first, and counts jobs apart from versions', async () => {
    const first = await sealed();
    const second = await corrected(first);

    const rows = await mine({ q: clientCode });
    const ours = rows.filter((r) => r.requestId === first || r.requestId === second);
    expect(ours.map((r) => r.requestId)).toEqual([second, first]);
    expect(ours.map((r) => r.quoteNo)).toEqual([2, 1]);
    expect(ours[0]!.cardLabel).toBe(`${clientCode} · VED chain client ${SUFFIX}`);
    expect(ours[0]!.entityType).toBe('deal');
    expect(ours[0]!.totalUsd).toBeGreaterThan(0);

    // The counts run over the SAME predicate as the rows — a chain is two
    // versions and ONE job.
    const counts = await registryCounts({ sealerId: actorId, leadsReadable: true, q: clientCode });
    const plain = await db
      .select({ id: calcVersions.id })
      .from(calcVersions)
      .where(eq(calcVersions.sealedBy, actorId));
    expect(counts.versions).toBe(plain.length);
    expect(counts.versions).toBe(rows.length);
    expect(counts.jobs).toBeLessThan(counts.versions);
  });

  it('a LEAD is named only for a reader who may open leads, and is not searchable otherwise', async () => {
    const onLead = await sealed({ entityType: 'lead', entityId: leadId });

    const readable = (await mine({ q: leadName })).filter((r) => r.requestId === onLead);
    expect(readable).toHaveLength(1);
    expect(readable[0]!.cardLabel).toBe(leadName);

    // The row is still LISTED (it is a sealed price the company gave), but
    // it carries no name — and the name finds nothing (#514).
    const blind = (await mine({ leadsReadable: false })).filter((r) => r.requestId === onLead);
    expect(blind).toHaveLength(1);
    expect(blind[0]!.cardLabel).toBeNull();
    expect((await mine({ leadsReadable: false, q: leadName })).some((r) => r.requestId === onLead)).toBe(false);
  });

  it('section and date filters run in SQL', async () => {
    const first = await sealed();
    expect((await mine({ section: 'yolkira' })).some((r) => r.requestId === first)).toBe(false);
    expect((await mine({ section: 'podklyuch' })).some((r) => r.requestId === first)).toBe(true);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await mine({ from: tomorrow })).some((r) => r.requestId === first)).toBe(false);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await mine({ to: yesterday })).some((r) => r.requestId === first)).toBe(false);
    expect((await mine({ from: yesterday, to: tomorrow })).some((r) => r.requestId === first)).toBe(true);
  });
});
