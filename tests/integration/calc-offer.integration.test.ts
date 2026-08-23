import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcPriceBook,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  settings,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { onDate, priceBookAt, savePriceBook, listPriceBook } from '@/modules/wms/calc/dictionaries';
import {
  confirmAllGroups,
  createGroup,
  loadWorkspace,
  moveItemToGroup,
  recordOffer,
  offersFor,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { lastQuotesByCode, quoteHistoryFor } from '@/modules/wms/calc/history';
import { claimReviewMonth, reviewMonth } from '@/modules/wms/calc/review';

/**
 * VED phase C — the offer, the price book and the history, against a real db.
 *
 * The price book is a GLOBAL dictionary, so every row this file writes is
 * deleted by id in `afterAll` and every code carries the run tag: a
 * dictionary row left behind silently prices somebody else's test (#653), and
 * the workspace screen reads the book for every code on it.
 *
 * The review CLAIM is a setting, i.e. one row the whole installation shares.
 * It is snapshotted and restored for the same reason — a test that leaves it
 * holding this month silences the real reminder (#653, #661).
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDC-${SUFFIX}-${(seq += 1)}`;
const CODE_A = `9403${SUFFIX}`;
const CODE_B = `8528${SUFFIX}`;

let actorId = '';
let clientId = '';
let dealId = '';
let leadId = '';
const madeRequests: string[] = [];
const madePrices: string[] = [];
let claimBefore: unknown;
let claimExisted = false;
const ctx = () => ({ actorId });
const TODAY = onDate();

beforeAll(async () => {
  const [fixtureActor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `VED offer fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = fixtureActor!.id;

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VC${SUFFIX}`, name: `VED offer fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VC-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED offer fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;

  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [lead] = await db
    .insert(leads)
    .values({ name: `VED offer lead ${SUFFIX}`, stageId: leadStage[0]!.id, createdBy: actorId })
    .returning();
  leadId = lead!.id;

  const existing = await db.query.settings.findFirst({
    where: eq(settings.key, 'calc_review_notified_month'),
  });
  claimExisted = Boolean(existing);
  claimBefore = existing?.value;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(
      inArray(
        calcOffers.versionId,
        (
          await db
            .select({ id: calcVersions.id })
            .from(calcVersions)
            .where(inArray(calcVersions.requestId, madeRequests))
        ).map((r) => r.id),
      ),
    );
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
  if (madePrices.length > 0) {
    await db.delete(calcPriceBook).where(inArray(calcPriceBook.id, madePrices));
  }
  // The claim is the installation's, not this file's.
  if (claimExisted) {
    await db
      .update(settings)
      .set({ value: claimBefore })
      .where(eq(settings.key, 'calc_review_notified_month'));
  } else {
    await db.delete(settings).where(eq(settings.key, 'calc_review_notified_month'));
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

/** A request priced end to end and SEALED — the only thing an offer can hang on. */
async function sealed(
  opts: { code?: string; volumeM3?: number; weightKg?: number; onLead?: boolean } = {},
) {
  const code = opts.code ?? CODE_A;
  const request = await openCalcRequest(
    {
      entityType: opts.onLead ? 'lead' : 'deal',
      entityId: opts.onLead ? leadId : dealId,
      section: 'podklyuch',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: opts.weightKg ?? 1500,
      volumeM3: opts.volumeM3 ?? 30,
      items: [{ name: `tovar ${tag()}`, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  const groupId = await createGroup(request.id, { label: 'Guruh', tnvedCode: code }, ctx());
  const workspace = await loadWorkspace(request.id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(request.id, item.seq, groupId, ctx());
    await setItemBaza(request.id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
  }
  await setGroupRates(
    groupId,
    {
      tnvedCode: code,
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
  const versionNo = await sealCalc(
    request.id,
    { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
    ctx(),
  );
  const version = await db.query.calcVersions.findFirst({
    where: eq(calcVersions.requestId, request.id),
  });
  return { requestId: request.id, versionId: version!.id, version: version!, versionNo };
}

describe('the offer is the SELLER’s price, and the seal is only its floor', () => {
  it('records a price ABOVE the floor and never prints the sealed total', async () => {
    const { versionId, version } = await sealed();
    const floor = Number(version.totalUsd);
    const result = await recordOffer(
      versionId,
      { clientPriceUsd: floor + 500, locale: 'uz', clientName: 'Ali aka' },
      ctx(),
    );
    expect(result.belowFloor).toBe(false);
    expect(result.text).toContain('Ali aka');
    // The floor is what the calculation cost. It is the seller's business and
    // must not reach the customer's sheet.
    expect(result.text).not.toContain(floor.toFixed(2));
    expect(result.text).toContain((floor + 500).toFixed(2).split('.')[0]!.slice(0, 2));
  });

  it('FLAGS a price below the floor instead of refusing it', async () => {
    // Still true after phase D, and deliberately so: what law 4 locks is the
    // PROMISE, never the record. The row is always written, because the flag
    // is how the owner sees who is discounting — a door in front of a seller
    // with a customer on the phone is a door they walk around by not using
    // the screen. Phase D added the two things around it: a mandatory reason,
    // and `mayApprove` deciding whether anything is actually sent.
    const { versionId, version } = await sealed();
    const result = await recordOffer(
      versionId,
      {
        clientPriceUsd: Number(version.totalUsd) / 2,
        locale: 'ru',
        belowFloorReason: 'doimiy mijoz',
        mayApprove: true,
      },
      ctx(),
    );
    expect(result.belowFloor).toBe(true);
    const stored = await db.query.calcOffers.findFirst({ where: eq(calcOffers.id, result.id) });
    expect(stored!.belowFloor).toBe(true);
    expect(stored!.belowFloorReason).toBe('doimiy mijoz');
  });

  it('refuses a price that is not a number rather than storing NaN', async () => {
    const { versionId } = await sealed();
    // The CODE matters, not merely that it threw: the money column's CHECK
    // refuses NaN too, but a 23514 reaches the seller as a white page while
    // `CalcError` reaches them as a sentence (#472's rule). The first version
    // of this test asserted `rejects.toThrow()` and STAYED GREEN with the
    // engine's fence stripped — it was measuring the database.
    await expect(
      recordOffer(versionId, { clientPriceUsd: Number('1 000'), locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'bad_number' });
    await expect(
      recordOffer(versionId, { clientPriceUsd: 0, locale: 'uz' }, ctx()),
    ).rejects.toMatchObject({ code: 'price_positive' });
  });

  it('refuses a version that belongs to a different card', async () => {
    const { versionId } = await sealed();
    await expect(
      recordOffer(
        versionId,
        {
          clientPriceUsd: 1000,
          locale: 'uz',
          expect: { entityType: 'lead', entityId: clientId },
        },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it('lists every offer made against the card, newest first', async () => {
    const { versionId } = await sealed();
    await recordOffer(versionId, { clientPriceUsd: 4000, locale: 'uz' }, ctx());
    await recordOffer(versionId, { clientPriceUsd: 4200, locale: 'uz' }, ctx());
    const list = await offersFor('deal', dealId);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(Number(list[0]!.clientPriceUsd)).toBe(4200);
  });
});

describe('the price book', () => {
  it('reads the newest row on or before the day, and has NO earliest-row fallback', async () => {
    madePrices.push(
      await savePriceBook(
        { tnvedCode: CODE_A, label: 'Stul', priceUsd: 300, unit: 'm3', effectiveDate: '2026-01-01' },
        ctx(),
      ),
      await savePriceBook(
        { tnvedCode: CODE_A, label: 'Stul', priceUsd: 330, unit: 'm3', effectiveDate: '2026-06-01' },
        ctx(),
      ),
    );
    expect((await priceBookAt(CODE_A, '2026-03-01'))!.priceUsd).toBe(300);
    expect((await priceBookAt(CODE_A, TODAY))!.priceUsd).toBe(330);
    // Before the first row there is no answer at all — nobody has ever priced
    // this, and inventing the earliest row would date a price to before it
    // existed (the rule the three phase-B dictionaries were built on).
    expect(await priceBookAt(CODE_A, '2025-12-31')).toBeNull();
  });

  it('a same-day correction UPDATES the row instead of minting a second one', async () => {
    const first = await savePriceBook(
      { tnvedCode: CODE_B, label: 'Monitor', priceUsd: 250, unit: 'm3', effectiveDate: TODAY },
      ctx(),
    );
    const second = await savePriceBook(
      { tnvedCode: CODE_B, label: 'Monitor', priceUsd: 265, unit: 'm3', effectiveDate: TODAY },
      ctx(),
    );
    madePrices.push(first, second);
    expect(second).toBe(first);
    expect((await priceBookAt(CODE_B, TODAY))!.priceUsd).toBe(265);
  });

  it('refuses a price that is not a positive number', async () => {
    await expect(
      savePriceBook(
        { tnvedCode: CODE_B, label: 'X', priceUsd: Number('abc'), unit: 'm3', effectiveDate: TODAY },
        ctx(),
      ),
    ).rejects.toThrow();
    await expect(
      savePriceBook(
        { tnvedCode: '', label: 'X', priceUsd: 10, unit: 'm3', effectiveDate: TODAY },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it('lists the book and marks nothing this run wrote as stale', async () => {
    const rows = await listPriceBook();
    const mine = rows.find((r) => r.tnvedCode === CODE_B);
    expect(mine).toBeTruthy();
    expect(mine!.stale).toBe(false);
  });
});

describe('the price history', () => {
  it('finds every sealed quote that priced the code, and the newest first', async () => {
    const code = `7318${SUFFIX}`;
    const first = await sealed({ code });
    const second = await sealed({ code });
    const rows = await quoteHistoryFor(code, { scope: 'all', limit: 5 });
    expect(rows.map((r) => r.versionId)).toEqual([second.versionId, first.versionId]);
    expect(rows[0]!.section).toBe('podklyuch');
    expect(rows[0]!.totalUsd).toBeGreaterThan(0);
  });

  it('carries the offer a seller actually made, when there is one', async () => {
    const code = `6109${SUFFIX}`;
    const { versionId } = await sealed({ code });
    await recordOffer(versionId, { clientPriceUsd: 9999, locale: 'uz' }, ctx());
    const rows = await quoteHistoryFor(code, { scope: 'all' });
    expect(rows[0]!.clientPriceUsd).toBe(9999);
  });

  it('answers about a code nobody has priced with nothing, never with somebody else’s quote', async () => {
    expect(await quoteHistoryFor(`0000${SUFFIX}`, { scope: 'all' })).toEqual([]);
    expect(await quoteHistoryFor('   ', { scope: 'all' })).toEqual([]);
  });

  it('gives EACH code its own newest N — a busy code does not crowd out a quiet one', async () => {
    const busy = `4202${SUFFIX}`;
    const quiet = `3926${SUFFIX}`;
    await sealed({ code: busy });
    await sealed({ code: busy });
    await sealed({ code: busy });
    const quietOne = await sealed({ code: quiet });

    const map = await lastQuotesByCode([busy, quiet], 2);
    expect(map.get(busy)!.length).toBe(2);
    expect(map.get(quiet)!.map((q) => q.versionId)).toEqual([quietOne.versionId]);
    // Every row is labelled with the section that produced it — a per-cube
    // figure means three different services across the three sections.
    expect(map.get(busy)!.every((q) => q.section === 'podklyuch')).toBe(true);
  });

  it('reads nothing for an empty list rather than every code in the book', async () => {
    expect((await lastQuotesByCode([])).size).toBe(0);
    expect((await lastQuotesByCode(['', '  '])).size).toBe(0);
  });
});

describe('the monthly review claim', () => {
  it('is won ONCE per month, whoever asks second', async () => {
    const month = reviewMonth(new Date('2026-03-15T06:00:00Z'));
    expect(month).toBe('2026-03');
    expect(await claimReviewMonth(month)).toBe(true);
    // The second caller is the overlapping sweep on the same morning. It must
    // get nothing back, or the reminder goes out twice.
    expect(await claimReviewMonth(month)).toBe(false);
    // A new month is a new claim.
    expect(await claimReviewMonth('2026-04')).toBe(true);
  });

  it('reads the month in the OFFICE’s zone, not in UTC', async () => {
    // 31 March, 23:00 in Tashkent is still March there and already April 1st
    // nowhere — but 1 April 04:00 UTC is 09:00 Tashkent, i.e. April.
    expect(reviewMonth(new Date('2026-03-31T19:30:00Z'))).toBe('2026-04');
    expect(reviewMonth(new Date('2026-03-31T18:00:00Z'))).toBe('2026-03');
  });
});

describe('an offer follows the lead onto the deal that wins it', () => {
  it('MEASURED: the offer is orphaned on the dead lead when only the request moves', async () => {
    // The same shape as #770, one table over. `recordOffer` denormalises the
    // card onto `calc_offers` so the card panel can read its own offers in one
    // indexed query — and `rekeyLeadCalcRequests` moved `calc_requests` alone.
    // A won lead is exactly the moment a quote becomes an invoice, and the
    // seller's own record of what they promised the customer disappeared from
    // the only card that still exists.
    const { versionId } = await sealed({ onLead: true, code: `8471${SUFFIX}` });
    await recordOffer(versionId, { clientPriceUsd: 7777, locale: 'uz' }, ctx());
    expect((await offersFor('lead', leadId)).length).toBe(1);

    const { rekeyLeadCalcRequests } = await import('@/modules/wms/calc/service');
    const moved = await rekeyLeadCalcRequests(leadId, dealId);
    expect(moved).toBeGreaterThan(0);

    // The deal is the live record. It must carry what the customer was told.
    const onDeal = await offersFor('deal', dealId);
    expect(onDeal.some((o) => Number(o.clientPriceUsd) === 7777)).toBe(true);
    // And the dead lead must not still claim it, or two cards answer for one
    // promise and a phase-D payout could be keyed off either.
    expect(await offersFor('lead', leadId)).toEqual([]);
  });
});

describe('law 4: the VED never sees what the customer was charged', () => {
  it('hides the client price from the VED and keeps the cost side', async () => {
    const code = `8517${SUFFIX}`;
    const { versionId } = await sealed({ code });
    await recordOffer(versionId, { clientPriceUsd: 8888, locale: 'uz' }, ctx());

    // The VED computed the floor themselves. Handing them the client price
    // hands them the upsale by subtraction, which is the whole of law 4.
    const asVed = await quoteHistoryFor(code, { scope: 'none' });
    expect(asVed[0]!.clientPriceUsd).toBeNull();
    expect(asVed[0]!.belowFloor).toBe(false);
    // …and law 10 still gives them the cost side, which is their own work.
    expect(asVed[0]!.totalUsd).toBeGreaterThan(0);
    expect(asVed[0]!.groupCustomsUsd).toBeGreaterThan(0);
  });

  it('hides the cost side from a seller — the WHOLE derived family, not the total', async () => {
    const code = `6203${SUFFIX}`;
    const { versionId } = await sealed({ code });
    await recordOffer(versionId, { clientPriceUsd: 9100, locale: 'uz' }, ctx());

    const asSeller = await quoteHistoryFor(code, { scope: 'own' });
    const row = asSeller[0]!;
    expect(row.clientPriceUsd).toBe(9100);
    // Nulling the total alone leaves the floor one multiplication away: the
    // row prints per-m³ and per-kg beside the volume and the weight.
    expect(row.totalUsd).toBeNull();
    expect(row.perM3Usd).toBeNull();
    expect(row.perKgUsd).toBeNull();
    expect(row.groupCustomsUsd).toBeNull();
    expect(row.groupCustomsPerM3).toBeNull();
    // And the card link is a door to the same number.
    expect(row.cardReadable).toBe(false);
    // The consignment stays, or the prices beside it cannot be read at all.
    expect(row.volumeM3).toBe(30);
    expect(row.weightKg).toBe(1500);
  });

  it('gives the owner and the accountant both halves', async () => {
    const code = `7013${SUFFIX}`;
    const { versionId } = await sealed({ code });
    await recordOffer(versionId, { clientPriceUsd: 9500, locale: 'uz' }, ctx());

    const row = (await quoteHistoryFor(code, { scope: 'all' }))[0]!;
    expect(row.clientPriceUsd).toBe(9500);
    expect(row.totalUsd).toBeGreaterThan(0);
    expect(row.cardReadable).toBe(true);
  });
});
