import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clientTransactions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  expenseCategories,
  expenses,
  leads,
  moneyAccounts,
  settings,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  recordOffer,
  sealCalc,
  setFreightZone,
} from '@/modules/wms/calc/workspace';
import { payUpsale, upsaleRows } from '@/modules/wms/calc/upsale-service';
import { voidExpense } from '@/modules/wms/accounting/service';

/**
 * VED phase D — the upsale, against a real database.
 *
 * Everything here is about ONE question with a lot of ways to get it wrong:
 * which offer may be paid a commission, and once. The rules are law 4's, and
 * each of them has its own test because each of them is a way for the company
 * to pay money it does not owe.
 *
 * `upsale_expense_category_id` is a SETTING, i.e. one row the whole
 * installation shares — snapshotted and restored, like the review claim
 * (#653, #661). The category and the till this file mints are its own and are
 * deactivated at the end: an active extra cash box changes what every money
 * screen renders for the next spec (#183).
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDD-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let sellerId = '';
let clientId = '';
let dealId = '';
let leadId = '';
let accountId = '';
let categoryId = '';
const madeRequests: string[] = [];
const madeExpenses: string[] = [];
let categoryBefore: unknown;
let categoryExisted = false;
let fxId = '';
const ctx = () => ({ actorId });
const sellerCtx = () => ({ actorId: sellerId });

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ phone: `+99894${String(Date.now()).slice(-7)}`, fullName: `Upsale fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = a!.id;
  const [s] = await db
    .insert(users)
    .values({ phone: `+99895${String(Date.now()).slice(-7)}`, fullName: `Upsale seller ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  sellerId = s!.id;

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `UP${SUFFIX}`, name: `Upsale fixture ${SUFFIX}` })
    .returning();
  clientId = c!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({ code: `UP-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Upsale fixture', createdBy: actorId })
    .returning();
  dealId = d!.id;

  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [l] = await db
    .insert(leads)
    .values({ name: `Upsale lead ${SUFFIX}`, stageId: leadStage[0]!.id, createdBy: actorId })
    .returning();
  leadId = l!.id;

  const [acct] = await db
    .insert(moneyAccounts)
    .values({ name: `Upsale kassa ${SUFFIX}`, currency: 'USD' })
    .returning();
  accountId = acct!.id;

  const [cat] = await db
    .insert(expenseCategories)
    .values({ name: `Upsale ulushi ${SUFFIX}` })
    .returning();
  categoryId = cat!.id;

  const existing = await db.query.settings.findFirst({
    where: eq(settings.key, 'upsale_expense_category_id'),
  });
  categoryExisted = Boolean(existing);
  categoryBefore = existing?.value;
  await db
    .insert(settings)
    .values({ key: 'upsale_expense_category_id', value: categoryId, updatedBy: null })
    .onConflictDoUpdate({ target: settings.key, set: { value: categoryId } });

  // The USD rate the payout converts at. The seed carries one, but a test
  // that depends on somebody else's fixture is a test that fails for a reason
  // it cannot explain — so it makes sure of its own and takes the row with it.
  const [fx] = await db.execute<{ id: string }>(sql`
    INSERT INTO fx_rates (id, currency, rate_to_usd, effective_date, entered_by)
    VALUES (gen_random_uuid(), 'USD', 1, CURRENT_DATE, ${actorId}::uuid)
    ON CONFLICT (currency, effective_date) DO NOTHING
    RETURNING id
  `);
  // Only what this run created is cleaned up: an fx row is the company's,
  // and deleting one somebody else wrote would reprice their history.
  fxId = fx?.id ?? '';
});

afterAll(async () => {
  // The offers point AT the expenses (`calc_offers_payout_expense_id_fkey`),
  // so the pointer goes before the row it names — the cleanup found this
  // itself on its first run.
  if (madeExpenses.length > 0) {
    await db
      .update(calcOffers)
      .set({ payoutExpenseId: null, payoutAt: null, payoutBy: null, payoutUsd: null })
      .where(inArray(calcOffers.payoutExpenseId, madeExpenses));
    await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  }
  if (fxId) await db.execute(sql`DELETE FROM fx_rates WHERE id = ${fxId}::uuid`);
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  if (madeRequests.length > 0) {
    const vs = await db
      .select({ id: calcVersions.id })
      .from(calcVersions)
      .where(inArray(calcVersions.requestId, madeRequests));
    if (vs.length > 0) {
      await db.delete(calcOffers).where(inArray(calcOffers.versionId, vs.map((v) => v.id)));
    }
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    // A correction points at what it supersedes: children before parents.
    await db
      .update(calcRequests)
      .set({ supersedesRequestId: null })
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (categoryExisted) {
    await db
      .update(settings)
      .set({ value: categoryBefore })
      .where(eq(settings.key, 'upsale_expense_category_id'));
  } else {
    await db.delete(settings).where(eq(settings.key, 'upsale_expense_category_id'));
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(deals).where(eq(deals.id, dealId));
  // Configuration must not survive the run (#183): an extra live till and an
  // extra category change what every money screen renders next.
  await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, accountId));
  await db.update(expenseCategories).set({ active: false }).where(eq(expenseCategories.id, categoryId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, sellerId]));
  await pgClient.end();
});

/**
 * A sealed yolkira job — freight only, so the floor is the tariff's own
 * arithmetic and no baza or rate is needed to reach a price.
 */
async function sealedJob(
  opts: {
    onLead?: boolean;
    discountUsd?: number;
    bandOverrideMin?: number | null;
    weightKg?: number;
    volumeM3?: number;
  } = {},
) {
  const request = await openCalcRequest(
    {
      entityType: opts.onLead ? 'lead' : 'deal',
      entityId: opts.onLead ? leadId : dealId,
      section: 'yolkira',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: opts.weightKg ?? 1500,
      volumeM3: opts.volumeM3 ?? 30,
      items: [{ name: `tovar ${tag()}`, quantity: 10 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  await setFreightZone(request.id, 'cn', ctx());
  await sealCalc(
    request.id,
    {
      discountUsd: opts.discountUsd ?? 0,
      discountReason: opts.discountUsd ? 'test' : null,
      bandOverrideMin: opts.bandOverrideMin ?? null,
      bandOverrideReason: opts.bandOverrideMin ? 'test' : null,
    },
    ctx(),
  );
  const version = await db.query.calcVersions.findFirst({
    where: eq(calcVersions.requestId, request.id),
  });
  return { requestId: request.id, versionId: version!.id, floor: Number(version!.totalUsd) };
}

/**
 * A job that is payable end to end: sealed, quoted above the floor, invoiced
 * and collected.
 *
 * Built per test rather than leaned on from the block above, because a test
 * that depends on another test's leftovers fails for a reason it cannot
 * explain — and vitest orders files by a DURATION CACHE, so «the block above»
 * is not a promise (#380).
 */
async function payableJob(extra = 600) {
  const job = await sealedJob();
  const price = job.floor + extra;
  const offer = await recordOffer(job.versionId, { clientPriceUsd: price, locale: 'uz' }, sellerCtx());
  const day = new Date().toISOString().slice(0, 10);
  for (const type of ['charge', 'payment'] as const) {
    await db.insert(clientTransactions).values({
      clientId,
      dealId,
      type,
      amount: String(price),
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: String(price),
      txDate: day,
      note: `upsale test ${type}`,
      createdBy: actorId,
    });
  }
  return { offerId: offer.id, upsaleUsd: extra };
}

const mine = async (offerId: string) =>
  (await upsaleRows('all', actorId, {})).rows.find((r) => r.offerId === offerId) ?? null;

describe('law 4: any concession kills the upsale', () => {
  it('a clean job carries one', async () => {
    const job = await sealedJob();
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 700, locale: 'uz' },
      sellerCtx(),
    );
    const row = await mine(offer.id);
    expect(row).not.toBeNull();
    expect(row!.upsaleUsd).toBe(700);
    expect(row!.sellerId).toBe(sellerId);
  });

  it('a discounted job carries NONE, however small the concession', async () => {
    const job = await sealedJob({ discountUsd: 1 });
    // AT the discounted floor: round 112 refuses anything above it on a
    // discounted seal (the next test), and the point here — a concession pays
    // no commission even when the customer is charged the full floor — is
    // exactly the price a seller may still promise.
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor, locale: 'uz' },
      sellerCtx(),
    );
    expect(await mine(offer.id)).toBeNull();
  });

  it('above a discounted floor is REFUSED — the concession is the customer\'s (round 112)', async () => {
    // The VED lowered the floor for the customer. A seller quoting above it
    // would be selling the discount back — «VED xodimi skidka bersa sotuvchi
    // upsale qilish huquqi bo'lmasin». Below stays the approver's door.
    const job = await sealedJob({ discountUsd: 1 });
    await expect(
      recordOffer(job.versionId, { clientPriceUsd: job.floor + 0.5, locale: 'uz' }, sellerCtx()),
    ).rejects.toMatchObject({ code: 'discounted_no_upsale' });
    // Exactly the floor is allowed…
    const atFloor = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor, locale: 'uz' },
      sellerCtx(),
    );
    expect(atFloor.belowFloor).toBe(false);
    // …and an UNdiscounted seal is untouched by the rule.
    const clean = await sealedJob();
    const above = await recordOffer(
      clean.versionId,
      { clientPriceUsd: clean.floor + 700, locale: 'uz' },
      sellerCtx(),
    );
    expect(above.belowFloor).toBe(false);
  });

  it('a band override that LOWERS the freight is a concession', async () => {
    // 1500 kg over 30 m³ is 50 kg/m³. Forcing band 1 changes nothing; forcing
    // the job into a band below its own density buys a cheaper rate.
    const job = await sealedJob({ weightKg: 7500, volumeM3: 30, bandOverrideMin: 1 });
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 700, locale: 'uz' },
      sellerCtx(),
    );
    expect(await mine(offer.id)).toBeNull();
  });

  it('a band override that RAISES it is not — the VED charged MORE', async () => {
    const job = await sealedJob({ weightKg: 1500, volumeM3: 30, bandOverrideMin: 301 });
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 700, locale: 'uz' },
      sellerCtx(),
    );
    expect(await mine(offer.id)).not.toBeNull();
  });
});

describe('one sale, one commission', () => {
  it('re-quoting the same job replaces the payable, never adds one', async () => {
    const job = await sealedJob();
    const first = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 500, locale: 'uz' },
      sellerCtx(),
    );
    const second = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 900, locale: 'ru' },
      sellerCtx(),
    );
    // Re-offering is the designed workflow — the seller picks a language and
    // presses again — so without the per-request rank every re-quote is a
    // second commission on ONE sale.
    expect(await mine(first.id)).toBeNull();
    const row = await mine(second.id);
    expect(row!.upsaleUsd).toBe(900);
  });

  it('a CORRECTED job pays nothing — the promise that stands is the new one', async () => {
    const job = await sealedJob();
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 400, locale: 'uz' },
      sellerCtx(),
    );
    expect(await mine(offer.id)).not.toBeNull();

    const { recalcFromSealed } = await import('@/modules/wms/calc/workspace');
    const newId = await recalcFromSealed(job.requestId, ctx());
    madeRequests.push(newId);
    expect(await mine(offer.id)).toBeNull();
  });
});

describe('the three states before payable', () => {
  it('an offer on a LEAD is not payable — there is no job to invoice', async () => {
    const job = await sealedJob({ onLead: true });
    const offer = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor + 300, locale: 'uz' },
      sellerCtx(),
    );
    expect((await mine(offer.id))!.state).toBe('no_deal');
  });

  it('walks no_invoice → awaiting_payment → payable as the money arrives', async () => {
    const job = await sealedJob();
    const price = job.floor + 600;
    const offer = await recordOffer(job.versionId, { clientPriceUsd: price, locale: 'uz' }, sellerCtx());
    expect((await mine(offer.id))!.state).toBe('no_invoice');

    await db.insert(clientTransactions).values({
      clientId,
      dealId,
      type: 'charge',
      amount: String(price),
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: String(price),
      txDate: new Date().toISOString().slice(0, 10),
      note: 'upsale test charge',
      createdBy: actorId,
    });
    expect((await mine(offer.id))!.state).toBe('awaiting_payment');

    await db.insert(clientTransactions).values({
      clientId,
      dealId,
      type: 'payment',
      amount: String(price),
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: String(price),
      txDate: new Date().toISOString().slice(0, 10),
      note: 'upsale test payment',
      createdBy: actorId,
    });
    expect((await mine(offer.id))!.state).toBe('payable');
    return offer.id;
  });
});

describe('paying it', () => {
  it('pays the DERIVED amount once, and refuses the second press', async () => {
    const job = await payableJob(600);
    const ids = [job.offerId];
    const expected = job.upsaleUsd;
    expect((await mine(job.offerId))!.state).toBe('payable');

    const paid = await payUpsale(
      ids,
      { accountId, currency: 'USD', expenseDate: new Date().toISOString().slice(0, 10) },
      ctx(),
    );
    madeExpenses.push(paid.expenseId);
    // The accountant chose which jobs, the till and the day. The AMOUNT is
    // the server's — a typed one is how a screen says «$340 paid» while $200
    // leaves the till.
    expect(paid.paidUsd).toBe(expected);
    expect(paid.count).toBe(ids.length);

    const after = await db.query.expenses.findFirst({ where: eq(expenses.id, paid.expenseId) });
    expect(Number(after!.amountUsd)).toBe(expected);
    expect(after!.employeeId).toBe(sellerId);
    expect(after!.categoryId).toBe(categoryId);

    // The same press twice pays ONCE. Two fences stand behind that, and the
    // near one answers first: the pre-read finds the job no longer payable and
    // refuses before an expense is written at all. `offer_already_paid` is the
    // far one, in the claim itself, and only a genuine race reaches it — which
    // is why the assertion here is about the MONEY and not about which code
    // came back.
    const expensesBefore = await db
      .select({ n: sql<string>`count(*)` })
      .from(expenses)
      .where(eq(expenses.employeeId, sellerId));
    await expect(
      payUpsale(ids, { accountId, currency: 'USD', expenseDate: new Date().toISOString().slice(0, 10) }, ctx()),
    ).rejects.toMatchObject({ code: 'offer_not_payable' });
    const expensesAfter = await db
      .select({ n: sql<string>`count(*)` })
      .from(expenses)
      .where(eq(expenses.employeeId, sellerId));
    expect(expensesAfter[0]!.n).toBe(expensesBefore[0]!.n);

    const rowNow = (await upsaleRows('all', actorId, {})).rows.find((r) => r.offerId === ids[0]);
    expect(rowNow!.state).toBe('paid');
  });

  it('a taken-back payout re-opens its offers (#528’s pair)', async () => {
    const job = await payableJob(450);
    const paid = await payUpsale(
      [job.offerId],
      { accountId, currency: 'USD', expenseDate: new Date().toISOString().slice(0, 10) },
      ctx(),
    );
    madeExpenses.push(paid.expenseId);
    const expenseId = paid.expenseId;
    const before = await db
      .select({ n: sql<string>`count(*)` })
      .from(calcOffers)
      .where(eq(calcOffers.payoutExpenseId, expenseId));
    expect(Number(before[0]!.n)).toBeGreaterThan(0);

    await voidExpense(expenseId, 'xato to‘lov', ctx());

    const after = await db
      .select({ n: sql<string>`count(*)` })
      .from(calcOffers)
      .where(eq(calcOffers.payoutExpenseId, expenseId));
    // Without the re-open the seller reads «to'landi» for ever on work they
    // were never actually paid for.
    expect(Number(after[0]!.n)).toBe(0);
  });

  it('refuses to pay when the owner has named no category', async () => {
    await db.update(settings).set({ value: '' }).where(eq(settings.key, 'upsale_expense_category_id'));
    await expect(
      payUpsale(['00000000-0000-4000-8000-000000000000'], { accountId, currency: 'USD', expenseDate: '2026-08-23' }, ctx()),
    ).rejects.toMatchObject({ code: 'upsale_category_unset' });
    await db.update(settings).set({ value: categoryId }).where(eq(settings.key, 'upsale_expense_category_id'));
  });
});

describe('who may read it', () => {
  it('a seller sees only their own, and the VED sees none at all', async () => {
    const all = await upsaleRows('all', actorId, {});
    expect(all.rows.length).toBeGreaterThan(0);

    const own = await upsaleRows('own', sellerId, {});
    expect(own.rows.every((r) => r.sellerId === sellerId)).toBe(true);

    const otherSeller = await upsaleRows('own', actorId, {});
    expect(otherSeller.rows.some((r) => r.sellerId === sellerId)).toBe(false);

    // Law 4. Not filtered — not fetched.
    expect((await upsaleRows('none', actorId, {})).rows).toEqual([]);
  });
});

describe('the card carries what the CUSTOMER pays', () => {
  it('a released offer writes the client price onto the card, not the floor', async () => {
    const job = await sealedJob();
    const sealed = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    // The seal wrote the floor, which is what every revenue surface reads.
    expect(Number(sealed!.quotedAmount)).toBe(job.floor);

    await recordOffer(job.versionId, { clientPriceUsd: job.floor + 800, locale: 'uz' }, sellerCtx());
    const after = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    // Law 4: the client pays the VED price PLUS the upsale. Leaving the floor
    // here reports the company's own cost as its revenue.
    expect(Number(after!.quotedAmount)).toBe(job.floor + 800);
  });

  it('and the card can still be SAVED afterwards — the lock follows the card', async () => {
    // The trap: `quoteLockedFor` refuses a save whose posted amount differs
    // from the locked one, and the locked form re-posts what it renders. If
    // the lock kept answering «the floor» while the card showed the client
    // price, every later ✏️ save on a quoted card would be refused for ever.
    const { quoteLockedFor } = await import('@/modules/wms/crm/service');
    const job = await sealedJob();
    await recordOffer(job.versionId, { clientPriceUsd: job.floor + 250, locale: 'uz' }, sellerCtx());

    const locked = await quoteLockedFor('deal', dealId);
    const card = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(locked).toBe(Number(card!.quotedAmount));

    const { updateDeal } = await import('@/modules/wms/deals/service');
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    await updateDeal(
      dealId,
      {
        clientId,
        stageId: stage!.id,
        title: `renamed ${SUFFIX}`,
        quotedAmount: Number(card!.quotedAmount),
        quotedCurrency: 'USD',
        quotedVolumeM3: card!.quotedVolumeM3 === null ? null : Number(card!.quotedVolumeM3),
        quotedWeightKg: card!.quotedWeightKg === null ? null : Number(card!.quotedWeightKg),
      },
      ctx(),
    );
    const renamed = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(renamed!.title).toBe(`renamed ${SUFFIX}`);
  });
});

describe('law 4: a below-floor promise is admin-only', () => {
  it('a seller’s below-floor price is RECORDED and sends nothing', async () => {
    const job = await sealedJob();
    const res = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor - 300, locale: 'uz', belowFloorReason: 'doimiy mijoz', mayApprove: false },
      sellerCtx(),
    );
    // The row exists — that is how the owner sees who is discounting.
    expect(res.belowFloor).toBe(true);
    expect(res.pending).toBe(true);
    // …and there is nothing to forward, which is the whole of the lock.
    expect(res.text).toBeNull();
    expect(res.delivered).toBe(false);

    const stored = await db.query.calcOffers.findFirst({ where: eq(calcOffers.id, res.id) });
    expect(stored!.approvedAt).toBeNull();
    expect(stored!.belowFloorReason).toBe('doimiy mijoz');
    // A promise nobody allowed is not the card's price either.
    const card = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(card!.quotedAmount)).not.toBe(job.floor - 300);
    // …and it is never payable.
    expect(await mine(res.id)).toBeNull();
  });

  it('demands a reason, exactly as a discount does', async () => {
    const job = await sealedJob();
    await expect(
      recordOffer(job.versionId, { clientPriceUsd: job.floor - 100, locale: 'uz' }, sellerCtx()),
    ).rejects.toMatchObject({ code: 'below_floor_reason_required' });
  });

  it('an admin pressing it themselves is recorded AND released in one step', async () => {
    const job = await sealedJob();
    const res = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor - 200, locale: 'uz', belowFloorReason: 'rahbar qarori', mayApprove: true },
      ctx(),
    );
    expect(res.pending).toBe(false);
    expect(res.text).not.toBeNull();
    const stored = await db.query.calcOffers.findFirst({ where: eq(calcOffers.id, res.id) });
    expect(stored!.approvedAt).not.toBeNull();
  });

  it('releasing is single-shot, and the second press finds nothing', async () => {
    const job = await sealedJob();
    const res = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor - 400, locale: 'uz', belowFloorReason: 'sinov', mayApprove: false },
      sellerCtx(),
    );
    const { releaseOffer } = await import('@/modules/wms/calc/workspace');
    const released = await releaseOffer(res.id, ctx());
    expect(released.text).not.toBeNull();
    // Releasing is what sends the customer the message — two admins pressing
    // in the same second must not both send it.
    await expect(releaseOffer(res.id, ctx())).rejects.toMatchObject({ code: 'not_pending' });

    const card = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(card!.quotedAmount)).toBe(job.floor - 400);
    // A below-floor price is a concession by definition, so it carries no
    // upsale even once allowed — and the difference is negative anyway.
    expect(await mine(res.id)).toBeNull();
  });
});

/**
 * Choosing the category, which until now could only be done by typing a uuid
 * into the generic settings screen — i.e. by nobody.
 */
describe('naming the category the payout is booked under', () => {
  const read = async () =>
    String(
      (await db.query.settings.findFirst({ where: eq(settings.key, 'upsale_expense_category_id') }))
        ?.value ?? '',
    );

  it('writes the chosen category and reads back as the payout will read it', async () => {
    const { setUpsaleCategory } = await import('@/modules/wms/calc/upsale-service');
    await setUpsaleCategory('', ctx());
    expect(await read()).toBe('');

    await setUpsaleCategory(categoryId, ctx());
    expect(await read()).toBe(categoryId);
  });

  it('refuses an id no category has', async () => {
    const { setUpsaleCategory } = await import('@/modules/wms/calc/upsale-service');
    await expect(
      setUpsaleCategory('00000000-0000-4000-8000-000000000000', ctx()),
    ).rejects.toMatchObject({ code: 'category_not_found' });
    // The refusal must not have moved the live setting.
    expect(await read()).toBe(categoryId);
  });

  it('refuses a retired category', async () => {
    const { setUpsaleCategory } = await import('@/modules/wms/calc/upsale-service');
    const [dead] = await db
      .insert(expenseCategories)
      .values({ name: tag(), active: false })
      .returning();
    // Accepting it once would leave the payout pointing at a type nobody can
    // post into, and the refusal would come back months later as a mystery.
    await expect(setUpsaleCategory(dead!.id, ctx())).rejects.toMatchObject({
      code: 'category_not_found',
    });
    await db.delete(expenseCategories).where(eq(expenseCategories.id, dead!.id));
    expect(await read()).toBe(categoryId);
  });
});

/**
 * The whole-module audit's second confirmed defect: a correction sealed over
 * a card that already carried a released offer left the LOCK on the old
 * client price while the card carried the new floor — and updateLead, which
 * compares the posted value against the lock, refused every later ✏️ save
 * with quote_sealed for ever.
 */
describe('a correction retires the released offer', () => {
  async function corrected(requestId: string) {
    const { recalcFromSealed } = await import('@/modules/wms/calc/workspace');
    const freshId = await recalcFromSealed(requestId, ctx());
    madeRequests.push(freshId);
    await sealCalc(
      freshId,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const v = await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, freshId) });
    return { freshId, floor: Number(v!.totalUsd) };
  }

  it('the lock follows the card onto the new floor, so later saves still work', async () => {
    const job = await sealedJob();
    await recordOffer(job.versionId, { clientPriceUsd: job.floor + 500, locale: 'uz' }, sellerCtx());
    const { releasedPriceFor } = await import('@/modules/wms/calc/workspace');
    expect((await releasedPriceFor('deal', dealId))?.price).toBe(job.floor + 500);

    const next = await corrected(job.requestId);

    // The card carries the correction's floor and the superseded offer no
    // longer answers for the price. (An OLDER job's standing offer may still
    // exist on this shared deal — the earlier tests leave real ones — which
    // is exactly why the lock below decides by the clock, not by kind.)
    const card = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(card!.quotedAmount)).toBe(next.floor);
    expect((await releasedPriceFor('deal', dealId))?.price).not.toBe(job.floor + 500);

    // The accountant's both-figures strip follows the same standing rule:
    // the superseded promise is not one of the ledger's pairs either.
    const { bothFiguresForDeals } = await import('@/modules/wms/calc/upsale-service');
    const fig = (await bothFiguresForDeals([dealId])).get(dealId);
    expect(fig?.clientPriceUsd).not.toBe(job.floor + 500);

    // The LOCK and the CARD agree — this equality is exactly what updateLead
    // checks before letting a save through.
    const { quoteLockedFor } = await import('@/modules/wms/crm/service');
    expect(await quoteLockedFor('deal', dealId)).toBe(Number(card!.quotedAmount));
  });

  it('a stale pending below-floor promise cannot be released after the correction', async () => {
    const job = await sealedJob();
    const res = await recordOffer(
      job.versionId,
      { clientPriceUsd: job.floor - 300, locale: 'uz', belowFloorReason: 'sinov', mayApprove: false },
      sellerCtx(),
    );
    expect(res.pending).toBe(true);

    const next = await corrected(job.requestId);

    // Releasing a promise a correction replaced would write a dead quote's
    // price onto the card; the claim itself refuses, with its own sentence.
    const { releaseOffer } = await import('@/modules/wms/calc/workspace');
    await expect(releaseOffer(res.id, ctx())).rejects.toMatchObject({ code: 'superseded' });

    const card = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
    expect(Number(card!.quotedAmount)).toBe(next.floor);
  });
});
