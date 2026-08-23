import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcBazas,
  calcExtras,
  calcGroups,
  calcRates,
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
import { quoteLockedFor } from '@/modules/wms/crm/service';
import { updateDeal } from '@/modules/wms/deals/service';
import { saveBaza, saveRates, onDate, tariffFor } from '@/modules/wms/calc/dictionaries';
import { bandFor } from '@/modules/wms/calc/pricing';
import {
  applyProposal,
  confirmAllGroups,
  createGroup,
  currentSealFor,
  loadWorkspace,
  moveItemToGroup,
  pullBazasFromDictionary,
  pullRatesFromDictionary,
  recalcFromSealed,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';

/**
 * VED phase B — the workspace and the seal against a real database.
 *
 * Its fixtures are its own for the same reason phase A's are (#183): a sealed
 * price writes onto the card, so a leftover would change what the funnel and
 * every card screen render for the next spec. The dictionaries are GLOBAL,
 * though, so this file's baza and rate rows are deleted by id in `afterAll`
 * and its product keys carry the run tag — a dictionary row left behind
 * silently prices somebody else's test (#653).
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDB-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
let leadId = '';
const madeRequests: string[] = [];
const madeBazas: string[] = [];
const madeRates: string[] = [];
const ctx = () => ({ actorId });
const TODAY = onDate();

beforeAll(async () => {
  const [fixtureActor] = await db
    .insert(users)
    .values({
      phone: `+99891${String(Date.now()).slice(-7)}`,
      fullName: `VED seal fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = fixtureActor!.id;

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VS${SUFFIX}`, name: `VED seal fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VS-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED seal fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;

  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [lead] = await db
    .insert(leads)
    .values({ name: `VED seal lead ${SUFFIX}`, stageId: leadStage[0]!.id, createdBy: actorId })
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
    // A correction points at the request it supersedes: the children have to
    // go before their parent or the FK refuses.
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeBazas.length > 0) await db.delete(calcBazas).where(inArray(calcBazas.id, madeBazas));
  if (madeRates.length > 0) await db.delete(calcRates).where(inArray(calcRates.id, madeRates));
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

/** A request priced end to end: one group, one confirmed rate, one baza. */
async function readyRequest(overrides: Partial<Parameters<typeof openCalcRequest>[0]> = {}) {
  const request = await open(overrides);
  const groupId = await createGroup(request.id, { label: 'Monitorlar', tnvedCode: '8528520000' }, ctx());
  const workspace = await loadWorkspace(request.id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(request.id, item.seq, groupId, ctx());
    await setItemBaza(request.id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
  }
  await setGroupRates(
    groupId,
    {
      tnvedCode: '8528520000',
      dutyPct: 10,
      vatPct: 12,
      feeUsd: 0,
      dutyFree: false,
      vatFree: false,
      source: 'typed',
    },
    ctx(),
  );
  await setFreightZone(request.id, 'cn', ctx());
  await confirmAllGroups(request.id, ctx());
  return { requestId: request.id, groupId };
}

describe('the workspace refuses rather than inventing a number', () => {
  it('an item with no baza blocks the seal and NAMES the item', async () => {
    const request = await open({ items: [{ name: `stul ${tag()}`, quantity: 40 }] });
    const groupId = await createGroup(request.id, { label: 'Stullar' }, ctx());
    const before = await loadWorkspace(request.id);
    await moveItemToGroup(request.id, before!.ungrouped[0]!.seq, groupId, ctx());
    await setGroupRates(
      groupId,
      { tnvedCode: '9401', dutyPct: 5, vatPct: 12, feeUsd: 0, dutyFree: false, vatFree: false, source: 'typed' },
      ctx(),
    );

    const workspace = await loadWorkspace(request.id);
    const group = workspace!.groups[0]!;
    expect(group.customs.ok).toBe(false);
    if (!group.customs.ok) expect(group.customs.reason).toBe('baza_missing');
    // And the total is absent, not zero: nothing may print «$0» here.
    expect(workspace!.customsUsd).toBeNull();
    expect(workspace!.blockers.some((b) => b.kind === 'customs')).toBe(true);

    await expect(
      sealCalc(request.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('an unconfirmed group blocks the seal — law 1', async () => {
    const request = await open();
    const groupId = await createGroup(request.id, { label: 'Monitorlar' }, ctx());
    const before = await loadWorkspace(request.id);
    await moveItemToGroup(request.id, before!.ungrouped[0]!.seq, groupId, ctx());
    await setItemBaza(request.id, before!.ungrouped[0]!.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    await setGroupRates(
      groupId,
      { tnvedCode: '8528', dutyPct: 10, vatPct: 12, feeUsd: 0, dutyFree: false, vatFree: false, source: 'typed' },
      ctx(),
    );
    await setFreightZone(request.id, 'cn', ctx());

    const workspace = await loadWorkspace(request.id);
    expect(workspace!.blockers).toContainEqual({ kind: 'groups_unconfirmed', count: 1 });
    await expect(
      sealCalc(request.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('changing a rate un-confirms the group — nobody confirmed THESE numbers', async () => {
    const { requestId, groupId } = await readyRequest();
    expect((await loadWorkspace(requestId))!.groups[0]!.confirmedAt).not.toBeNull();
    await setGroupRates(
      groupId,
      { tnvedCode: '8528520000', dutyPct: 20, vatPct: 12, feeUsd: 0, dutyFree: false, vatFree: false, source: 'typed' },
      ctx(),
    );
    expect((await loadWorkspace(requestId))!.groups[0]!.confirmedAt).toBeNull();
  });
});

describe('the freight zone is chosen, never inferred', () => {
  it('without a zone the price refuses, however the city reads', async () => {
    const request = await open({ fromCity: 'Yiwu' });
    const workspace = await loadWorkspace(request.id);
    // The city offers an answer…
    expect(workspace!.guessedZone).toBe('cn');
    // …and the price still refuses until somebody picks one.
    expect(workspace!.freightZone).toBeNull();
    expect(workspace!.freight).toMatchObject({ ok: false, reason: 'zone_required' });
  });

  it('prices the band he closed — 950 kg/m³ used to be covered by no row', async () => {
    // 28 500 kg over 30 m³ is 950 kg/m³. His first table had nothing between
    // 900 and 1000; his answer put it in the $320 band, and this reads the
    // SEEDED database rather than the module, so it also proves the seed
    // actually wrote what the module says.
    const request = await open({ weightKg: 28_500, volumeM3: 30 });
    await setFreightZone(request.id, 'cn', ctx());
    const workspace = await loadWorkspace(request.id);
    expect(workspace!.freight).toMatchObject({ ok: true, listUsd: 9600 });
  });

  it('the seeded tariff can price every whole density in both zones', async () => {
    const tariff = await tariffFor(onDate());
    const gaps: string[] = [];
    for (const zone of ['cn', 'kashgar']) {
      for (let d = 1; d <= 1500; d += 1) {
        if (!bandFor(tariff, zone, d).ok) gaps.push(`${zone}@${d}`);
      }
    }
    expect(gaps, 'densities the DATABASE cannot price').toEqual([]);
  });

  it('prices the ordinary case off his own table', async () => {
    const request = await open({ weightKg: 1500, volumeM3: 30 });
    await setFreightZone(request.id, 'cn', ctx());
    const workspace = await loadWorkspace(request.id);
    // 50 kg/m³ → the «1–100» row at $110/m³ × 30 m³.
    expect(workspace!.freight).toMatchObject({ ok: true, listUsd: 3300 });
  });
});

describe('the seal', () => {
  it('writes an immutable version, closes the request and locks the card', async () => {
    const { requestId } = await readyRequest();
    const result = await sealCalc(
      requestId,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    // customs: 100 × $20 = $2 000 value; duty 10 % = $200; VAT 12 % of
    // $2 200 = $264 → $464. freight: 50 kg/m³ → $110 × 30 m³ = $3 300.
    expect(result.versionNo).toBe(1);
    expect(result.totalUsd).toBe(3764);

    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, requestId));
    expect(Number(version!.customsUsd)).toBe(464);
    expect(Number(version!.freightUsd)).toBe(3300);
    expect(Number(version!.perM3Usd)).toBeCloseTo(125.47, 2);
    // The tariff row that made the price travels WITH it, so editing the
    // tariff tomorrow cannot change what this client was told.
    expect(Number(version!.freightRate)).toBe(110);
    expect(version!.freightPerKg).toBe(false);

    const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
    expect(request!.completedVia).toBe('sealed');
    expect(request!.currentVersionNo).toBe(1);
    // Phase A's answer columns stay empty: the card reads the VERSION.
    expect(request!.answerAmount).toBeNull();

    const deal = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(deal!.quotedAmount)).toBe(3764);
    expect(deal!.quotedCurrency).toBe('USD');
  });

  it('a second seal on the same request is refused, not a second version', async () => {
    const { requestId } = await readyRequest();
    await sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
    await expect(
      sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'already_closed' });
    const versions = await db.select().from(calcVersions).where(eq(calcVersions.requestId, requestId));
    expect(versions).toHaveLength(1);
  });

  it('a discount needs a reason, and lands on its own line', async () => {
    const { requestId } = await readyRequest();
    await expect(
      sealCalc(requestId, { discountUsd: 300, discountReason: '  ', bandOverrideMin: null, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'discount_reason_required' });

    const result = await sealCalc(
      requestId,
      { discountUsd: 300, discountReason: 'doimiy mijoz', bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    expect(result.totalUsd).toBe(3464);
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, requestId));
    // The concession is a LINE, not a smaller freight number — phase D reads
    // this column to withdraw the upsale right.
    expect(Number(version!.discountUsd)).toBe(300);
    expect(Number(version!.freightUsd)).toBe(3300);
    expect(version!.discountReason).toBe('doimiy mijoz');
  });

  it('a band override needs a reason, MOVES the band, and is NOT a discount', async () => {
    // 1500 kg over 30 m³ is 50 kg/m³ and prices itself perfectly well at
    // $110 × 30 = $3,300. The override is the VED saying this load really
    // belongs somewhere else — so the test is that the price CHANGED, which
    // is the only thing that proves the override did anything at all.
    const { requestId } = await readyRequest({ weightKg: 1500, volumeM3: 30 });
    const before = await loadWorkspace(requestId);
    expect(before!.freight).toMatchObject({ ok: true, listUsd: 3300 });

    await expect(
      sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: 950, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'band_reason_required' });

    const result = await sealCalc(
      requestId,
      { discountUsd: 0, discountReason: null, bandOverrideMin: 950, bandOverrideReason: 'yuk siqilgan' },
      ctx(),
    );
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, requestId));
    expect(Number(version!.freightUsd)).toBe(9600); // the 701-999 row, $320 × 30
    expect(Number(version!.discountUsd)).toBe(0);
    expect(Number(version!.bandOverrideMin)).toBe(950);
    // The real density stays on the record beside the band it was priced in.
    expect(Number(version!.density)).toBe(50);
    expect(result.totalUsd).toBe(10_064);
  });

  it('a rastamojka quote has no freight line at all', async () => {
    const { requestId } = await readyRequest({ section: 'rastamojka' });
    const workspace = await loadWorkspace(requestId);
    expect(workspace!.parts.freight).toBe(false);
    expect(workspace!.freight).toBeNull();
    const result = await sealCalc(
      requestId,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    expect(result.totalUsd).toBe(464);
    const [version] = await db.select().from(calcVersions).where(eq(calcVersions.requestId, requestId));
    expect(Number(version!.freightUsd)).toBe(0);
    expect(version!.freightRate).toBeNull();
  });
});

describe('the card reads the version', () => {
  it('currentSealFor answers with the newest sealed price on the card', async () => {
    const { requestId } = await readyRequest();
    await sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
    const seal = await currentSealFor('deal', dealId);
    expect(seal!.totalUsd).toBe(3764);
    expect(seal!.expired).toBe(false);
    expect(seal!.validUntil.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the lock is real', () => {
  it('the ✏️ form cannot change a sealed quote, and an ordinary save still works', async () => {
    const { requestId } = await readyRequest();
    await sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
    expect(await quoteLockedFor('deal', dealId)).toBe(3764);

    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const base = {
      clientId,
      stageId: stage!.id,
      title: 'VED seal fixture',
      quotedAmount: 3764,
      quotedCurrency: 'USD',
      quotedVolumeM3: 30,
      quotedWeightKg: 1500,
    };

    // A DIFFERENT number is refused…
    await expect(updateDeal(dealId, { ...base, quotedAmount: 1 }, ctx())).rejects.toMatchObject({
      code: 'quote_sealed',
    });

    // …and re-posting the sealed figure while fixing the title is not, which
    // is what makes the locked form's hidden inputs safe (#171).
    await updateDeal(dealId, { ...base, title: 'VED seal fixture 2' }, ctx());
    const after = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(after!.title).toBe('VED seal fixture 2');
    expect(Number(after!.quotedAmount)).toBe(3764);
  });
});

describe('what the shipped-code audit found', () => {
  it('a sealed price FOLLOWS the lead onto the deal that wins it', async () => {
    // The lock lives on the card the calc request points at. Re-keying only
    // OPEN requests handed the new deal the number with none of the lock —
    // and a won lead is exactly when the quote becomes the invoice.
    const request = await openCalcRequest(
      {
        entityType: 'lead',
        entityId: leadId,
        section: 'yolkira',
        fromCity: 'Yiwu',
        toCity: 'Toshkent',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name: `monitor ${tag()}`, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(request.id);
    await setFreightZone(request.id, 'cn', ctx());
    await sealCalc(request.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());
    expect(await quoteLockedFor('lead', leadId)).toBe(3300);

    const { rekeyLeadCalcRequests } = await import('@/modules/wms/calc/service');
    const moved = await rekeyLeadCalcRequests(leadId, dealId);
    expect(moved, 'a CLOSED, sealed request must move too').toBeGreaterThan(0);
    expect(await quoteLockedFor('deal', dealId)).toBe(3300);
  });

  it('changing a baza under a confirmed group takes the ✅ away', async () => {
    const { requestId } = await readyRequest();
    const before = await loadWorkspace(requestId);
    const seq = before!.groups[0]!.items[0]!.seq;
    expect(before!.groups[0]!.confirmedAt).not.toBeNull();

    await setItemBaza(requestId, seq, { bazaUsd: 25, basis: 'unit', source: 'typed' }, ctx());
    const after = await loadWorkspace(requestId);
    // The confirmation was about NUMBERS, and one of them just moved.
    expect(after!.groups[0]!.confirmedAt).toBeNull();
    expect(after!.blockers).toContainEqual({ kind: 'groups_unconfirmed', count: 1 });
  });

  it('«take the rates from the dictionary» reads the dictionary, not the caller', async () => {
    const code = `991${String((seq += 1)).padStart(4, '0')}`;
    madeRates.push(
      await saveRates({ tnvedCode: code, dutyPct: 3, vatPct: 12, feeUsd: 7, effectiveDate: TODAY }, ctx()),
    );
    const request = await open();
    const groupId = await createGroup(request.id, { label: 'X', tnvedCode: code }, ctx());
    await pullRatesFromDictionary(groupId, ctx());

    const ws = await loadWorkspace(request.id);
    const group = ws!.groups[0]!;
    expect(group.dutyPct).toBe(3);
    expect(group.feeUsd).toBe(7);
    expect(group.rateSource).toBe('dictionary');
  });

  it('refuses to claim the dictionary for a code the dictionary has never heard of', async () => {
    const request = await open();
    const groupId = await createGroup(request.id, { label: 'X', tnvedCode: '4242424242' }, ctx());
    await expect(pullRatesFromDictionary(groupId, ctx())).rejects.toMatchObject({
      code: 'rates_not_in_dictionary',
    });
  });

  it('a typo is refused before it is stored, never sealed as NaN', async () => {
    const { requestId, groupId } = await readyRequest();
    await expect(
      setGroupRates(
        groupId,
        { tnvedCode: '8528', dutyPct: NaN, vatPct: 12, feeUsd: 0, dutyFree: false, vatFree: false, source: 'typed' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'bad_number' });
    await expect(
      sealCalc(requestId, { discountUsd: NaN, discountReason: 'x', bandOverrideMin: null, bandOverrideReason: null }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_number' });
  });
});

describe('a correction is a NEW request', () => {
  it('copies the groups and items, and confirms NOTHING', async () => {
    const { requestId } = await readyRequest();
    await sealCalc(requestId, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx());

    const freshId = await recalcFromSealed(requestId, ctx());
    madeRequests.unshift(freshId); // deleted before the request it supersedes
    const fresh = await loadWorkspace(freshId);
    expect(fresh!.completedAt).toBeNull();
    expect(fresh!.groups).toHaveLength(1);
    expect(fresh!.groups[0]!.dutyPct).toBe(10);
    expect(fresh!.ungrouped).toHaveLength(0);
    expect(fresh!.groups[0]!.items[0]!.bazaUsd).toBe(20);
    // The confirmation does NOT travel: nobody has looked at this one yet.
    expect(fresh!.groups[0]!.confirmedAt).toBeNull();
    expect(fresh!.blockers).toContainEqual({ kind: 'groups_unconfirmed', count: 1 });

    // The old request stays closed with its price intact.
    const old = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, requestId) });
    expect(old!.completedAt).not.toBeNull();
  });

  it('refuses on a request that is still open', async () => {
    const { requestId } = await readyRequest();
    await expect(recalcFromSealed(requestId, ctx())).rejects.toMatchObject({ code: 'not_closed' });
  });
});

describe('the dictionaries', () => {
  it('a baza fills every item that has none, and the seal then works', async () => {
    const name = `televizor ${tag()}`;
    const request = await open({ items: [{ name, quantity: 50 }] });
    madeBazas.push(
      await saveBaza(
        { name, label: name, tnvedCode: '8528', bazaUsd: 12, basis: 'unit', effectiveDate: TODAY, note: null },
        ctx(),
      ),
    );
    const filled = await pullBazasFromDictionary(request.id, ctx());
    expect(filled).toBe(1);
    const workspace = await loadWorkspace(request.id);
    expect(workspace!.ungrouped[0]!.bazaUsd).toBe(12);
    expect(workspace!.ungrouped[0]!.bazaSource).toBe('dictionary');
  });

  it('a baza dated TOMORROW prices nothing today', async () => {
    const name = `kelajak mahsuloti ${tag()}`;
    const tomorrow = onDate(new Date(Date.now() + 86_400_000));
    const request = await open({ items: [{ name, quantity: 10 }] });
    madeBazas.push(
      await saveBaza(
        { name, label: name, tnvedCode: null, bazaUsd: 99, basis: 'unit', effectiveDate: tomorrow, note: null },
        ctx(),
      ),
    );
    // No earliest-row fallback: a future row is not today's answer.
    expect(await pullBazasFromDictionary(request.id, ctx())).toBe(0);
    const workspace = await loadWorkspace(request.id);
    expect(workspace!.ungrouped[0]!.bazaUsd).toBeNull();
  });

  it('the newest row on or before today wins', async () => {
    const name = `monitor tarixiy ${tag()}`;
    const request = await open({ items: [{ name, quantity: 10 }] });
    const older = onDate(new Date(Date.now() - 30 * 86_400_000));
    madeBazas.push(
      await saveBaza({ name, label: name, tnvedCode: null, bazaUsd: 5, basis: 'unit', effectiveDate: older, note: null }, ctx()),
      await saveBaza({ name, label: name, tnvedCode: null, bazaUsd: 8, basis: 'unit', effectiveDate: TODAY, note: null }, ctx()),
    );
    await pullBazasFromDictionary(request.id, ctx());
    expect((await loadWorkspace(request.id))!.ungrouped[0]!.bazaUsd).toBe(8);
  });

  it('the same rate corrected twice in one day is ONE row', async () => {
    const code = `990${String(seq += 1).padStart(4, '0')}`;
    const first = await saveRates(
      { tnvedCode: code, dutyPct: 5, vatPct: 12, feeUsd: 0, effectiveDate: TODAY },
      ctx(),
    );
    const second = await saveRates(
      { tnvedCode: code, dutyPct: 7, vatPct: 12, feeUsd: 0, effectiveDate: TODAY, source: 'correction' },
      ctx(),
    );
    madeRates.push(first, second);
    expect(second).toBe(first);
    const rows = await db.select().from(calcRates).where(eq(calcRates.tnvedCode, code));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.dutyPct)).toBe(7);
  });
});

describe('the model never reaches a sealed number', () => {
  it('a proposal lands groups with no rates at all', async () => {
    const request = await open({
      items: [{ name: `AI mol ${tag()}`, quantity: 10 }, { name: `AI mol 2 ${tag()}`, quantity: 5 }],
    });
    const workspace = await loadWorkspace(request.id);
    const seqs = workspace!.ungrouped.map((i) => i.seq);
    await applyProposal(
      request.id,
      [
        {
          label: 'Мониторы',
          tnvedCode: '8528520000',
          itemSeqs: seqs,
          confidence: 'medium',
          aiDutyPct: 10,
          aiProposed: true,
          note: 'экраны',
        },
      ],
      ctx(),
    );

    const after = await loadWorkspace(request.id);
    const group = after!.groups[0]!;
    expect(group.aiProposed).toBe(true);
    expect(group.aiDutyPct).toBe(10); // recorded…
    expect(group.dutyPct).toBeNull(); // …and NOT a rate
    expect(group.rateSource).toBeNull();
    expect(group.confirmedAt).toBeNull();
    // With no rate the group cannot be priced, so nothing can be sealed off
    // the model's estimate however hard a caller presses.
    expect(group.customs).toMatchObject({ ok: false, reason: 'rates_missing' });
  });

  it('refuses to re-propose once a person has confirmed anything', async () => {
    const { requestId } = await readyRequest();
    await expect(applyProposal(requestId, [], ctx())).rejects.toMatchObject({ code: 'groups_confirmed' });
  });
});
