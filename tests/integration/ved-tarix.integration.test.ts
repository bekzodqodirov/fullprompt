import 'dotenv/config';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
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
import { calcSpeed, finishCalcRequest, returnCalcRequest, vedRotaPool } from '@/modules/wms/calc/service';
import { recalcFromSealed, recordOffer, sealCalc, setFreightZone, standingAnchorsFor } from '@/modules/wms/calc/workspace';
import { isRegistryRequest, registryCounts, registryRows, type RegistryAnswerRow } from '@/modules/wms/calc/chain';
import {
  calcCardExists,
  isCalcCardClient,
  kartaCardFor,
  leadEverPriced,
  newestRequestOn,
} from '@/modules/wms/calc/card-door';
import { creditTotals } from '@/modules/wms/calc/credit';
import { calcRegistrySight, internalNoteSight } from '@/modules/wms/calc/control-scope';
import { dealCalcSheets, requestGoodsSheet } from '@/modules/wms/calc/sheet';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import { quoteLockedFor, updateLead } from '@/modules/wms/crm/service';

/**
 * The owner's 7a 8a 9a 10a 12a 13c in the database (docs/VED-TARIX.md §2-§7):
 * a Готово answer is a row of the history beside the seals, credited to the
 * person who PRICED it and never to whoever held it; its internal note opens
 * only behind its own sight; a correction from an answer keeps the seller and
 * stops the old price standing; the typed amount is refused in words.
 *
 * Requests are inserted directly, assigned to this file's own VEDs — the rota
 * would hand a job to a SEEDED colleague and leave a task and a push on him
 * for the e2e run on the same database to inherit (#154).
 */
const SUFFIX = String(Date.now()).slice(-6);
const TOKEN = `zqv${SUFFIX}`;
const NO_DISCOUNT = { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null };
let seq = 0;
const phone = () => `+99895${SUFFIX}${(seq += 1)}`;

let sellerId = '';
let vedAId = '';
let vedBId = '';
let vedAName = '';
let adminVedId = '';
let clientId = '';
let dealId = '';
let deal2Id = '';
let leadId = '';
let leadName = '';
const madeUsers: string[] = [];
const madeRequests: string[] = [];
const madeDeals: string[] = [];
const madeLeads: string[] = [];
const ctx = (actorId: string) => ({ actorId });

async function userWithRole(role: string, name: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: phone(), fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  madeUsers.push(u!.id);
  return u!.id;
}

async function job(opts: {
  section: 'yolkira' | 'rastamojka';
  entityType?: 'deal' | 'lead';
  entityId?: string;
  holder: string;
  goods: string;
  tnvedCode?: string;
  volumeM3?: string;
}): Promise<string> {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType: opts.entityType ?? 'deal',
      entityId: opts.entityId ?? dealId,
      requestedBy: sellerId,
      assigneeId: opts.holder,
      itemCount: 1,
      section: opts.section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: '1500',
      volumeM3: opts.volumeM3 ?? '30',
      dueAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: calcRequests.id });
  await db.insert(calcRequestItems).values({
    requestId: r!.id,
    seq: 1,
    name: opts.goods,
    nameNorm: itemNameNorm(opts.goods),
    quantity: '10',
    tnvedCode: opts.tnvedCode ?? null,
  });
  madeRequests.push(r!.id);
  return r!.id;
}

const registryReader = { permissions: { has: (c: string) => c === 'ved.docs' } };
const vedSight = () => internalNoteSight({ permissions: { has: (c: string) => c === 'ved.docs' } })!;

beforeAll(async () => {
  sellerId = await userWithRole('sales_manager', `Tarix Sotuvchi ${SUFFIX}`);
  vedAName = `Tarix VedA ${SUFFIX}`;
  vedAId = await userWithRole('ved_manager', vedAName);
  vedBId = await userWithRole('ved_manager', `Tarix VedB ${SUFFIX}`);
  adminVedId = await userWithRole('admin', `Tarix Admin ${SUFFIX}`);

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `VT${SUFFIX}`, name: `Tarix client ${SUFFIX}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  for (const tag of ['A', 'B']) {
    const [d] = await db
      .insert(deals)
      .values({ code: `VT-${tag}-${SUFFIX}`, clientId, stageId: stage!.id, title: `Tarix ${tag}`, createdBy: sellerId, ownerId: sellerId })
      .returning({ id: deals.id });
    madeDeals.push(d!.id);
  }
  [dealId, deal2Id] = madeDeals as [string, string];
  const leadStage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  leadName = `Tarixlid${SUFFIX}`;
  const [l] = await db
    .insert(leads)
    .values({ name: leadName, stageId: leadStage[0]!.id, createdBy: sellerId, ownerId: sellerId })
    .returning({ id: leads.id });
  leadId = l!.id;
});

afterAll(async () => {
  // Every request this file's people touched — the corrections included.
  const all = await db
    .select({ id: calcRequests.id, taskId: calcRequests.taskId })
    .from(calcRequests)
    .where(
      or(
        inArray(calcRequests.entityId, [...madeDeals, leadId, ...madeLeads]),
        inArray(calcRequests.id, madeRequests.length ? madeRequests : ['00000000-0000-0000-0000-000000000000']),
      ),
    );
  const ids = all.map((r) => r.id);
  // Offers point at a version or a request, so they go first.
  await db.delete(calcOffers).where(inArray(calcOffers.entityId, [...madeDeals, leadId, ...madeLeads]));
  if (ids.length > 0) {
    const bound = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.boundId, ids));
    const taskIds = [...new Set([...bound.map((t) => t.id), ...(all.map((r) => r.taskId).filter(Boolean) as string[])])];
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, ids));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, ids));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, ids));
    await db.update(calcRequests).set({ taskId: null }).where(inArray(calcRequests.id, ids));
    await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  // The hand-back's «↩️ Ma'lumot to'ldiring» is the SELLER's own to-do: no
  // bound_id and on no request's task_id, so both reads above miss it and
  // every run left one OPEN on the seller's day (review integration-7). By
  // the card it points at, or by this file's own people.
  const loose = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      or(
        inArray(tasks.entityId, [...madeDeals, leadId, ...madeLeads]),
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
  await db.delete(events).where(inArray(events.entityId, [...madeDeals, leadId, ...madeLeads]));
  await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(leads).where(inArray(leads.id, [leadId, ...madeLeads]));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(userRoles).where(inArray(userRoles.userId, madeUsers));
  // DEACTIVATED, not deleted — audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('«Готово» refuses in words, in the agreed order (9a)', () => {
  it('reads the amount as typed and names what is wrong', async () => {
    const id = await job({ section: 'rastamojka', holder: vedAId, goods: `refusal ${TOKEN}` });
    const answer = (amountText: string, internalNote = 'ichki') =>
      finishCalcRequest(id, { amountText, currency: 'USD', note: '', internalNote }, ctx(vedAId));
    await expect(answer('')).rejects.toMatchObject({ code: 'answer_amount_required' });
    await expect(answer('1200$')).rejects.toMatchObject({ code: 'answer_amount_unreadable' });
    await expect(answer('0')).rejects.toMatchObject({ code: 'answer_positive' });
    await expect(answer('480', '   ')).rejects.toMatchObject({ code: 'internal_note_required' });
    await expect(
      finishCalcRequest(id, { amountText: '480', currency: 'EUR', note: '', internalNote: 'x' }, ctx(vedAId)),
    ).rejects.toMatchObject({ code: 'validation' });
    const still = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(still!.completedAt, 'a refusal closes nothing').toBeNull();
    // The office's spelling is the server's to read: a space between thousands.
    await answer('1 200');
    const done = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(Number(done!.answerAmount)).toBe(1200);
    // A closed job answers «closed» before it reads the amount.
    await expect(answer('')).rejects.toMatchObject({ code: 'already_closed' });
  });

  it('guards the STORED figure, numeric(14,2), and says it in words (ved-money-3)', async () => {
    // Held and answered by the admin: the credit totals below count A and B.
    const id = await job({ section: 'rastamojka', holder: adminVedId, goods: `scale ${TOKEN}` });
    const answer = (amountText: string) =>
      finishCalcRequest(id, { amountText, currency: 'USD', note: '', internalNote: 'x' }, ctx(adminVedId));
    // 0.004 is > 0 in JS and 0.00 in the column — 0093's CHECK would answer
    // with a raw 23514; and .995 on twelve nines rounds past the column.
    await expect(answer('0,004')).rejects.toMatchObject({ code: 'answer_positive' });
    await expect(answer('999 999 999 999,995')).rejects.toMatchObject({ code: 'amount_range' });
    await answer('1200,456');
    const done = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(done!.answerAmount).toBe('1200.46');
    // The seller is told the number that was STORED, not the one typed.
    const pushed = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, sellerId), eq(notifications.type, 'CalcDone')));
    const texts = pushed.map((p) => String((p.payload as { text?: string }).text ?? ''));
    expect(texts.some((t) => t.includes('💵 1200.46 USD'))).toBe(true);
    expect(texts.some((t) => t.includes('1200.456'))).toBe(false);
  });

  it('a long internal note is clipped by code point, and the seller is still told (ved-money-4)', async () => {
    const id = await job({ section: 'rastamojka', holder: adminVedId, goods: `emoji ${TOKEN}` });
    // 1999 letters and an emoji: `slice(0, 2000)` keeps the emoji's first
    // UTF-16 half alone, and jsonb refuses that in the audit row.
    const internalNote = `${'a'.repeat(1999)}😀 qolgani ${TOKEN}`;
    await finishCalcRequest(id, { amountText: '321', currency: 'USD', note: '', internalNote }, ctx(adminVedId));
    const done = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(done!.completedAt).not.toBeNull();
    expect(Array.from(done!.answerInternalNote ?? '')).toHaveLength(2000);
    expect(done!.answerInternalNote).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const pushed = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, sellerId), eq(notifications.type, 'CalcDone')));
    expect(pushed.some((p) => String((p.payload as { text?: string }).text ?? '').includes('💵 321 USD'))).toBe(true);
  });

  it('a sealable job says «Muhrlang» before it asks for the note', async () => {
    const id = await job({ section: 'yolkira', holder: vedAId, goods: `sealable ${TOKEN}`, entityId: deal2Id });
    await setFreightZone(id, 'cn', ctx(vedAId));
    await expect(
      finishCalcRequest(id, { amountText: '480', currency: 'USD', note: '', internalNote: '' }, ctx(vedAId)),
    ).rejects.toMatchObject({ code: 'seal_instead' });
    // Leave nothing open on deal2 for the lock test below.
    await db.delete(calcRequestItems).where(eq(calcRequestItems.requestId, id));
    await db.delete(calcRequests).where(eq(calcRequests.id, id));
  });
});

describe('the history holds answers beside seals (7a 8a 12a)', () => {
  let answeredId = '';
  let sealedId = '';

  beforeAll(async () => {
    // HELD by B, ANSWERED by A — the credit rule's whole question.
    answeredId = await job({ section: 'rastamojka', holder: vedBId, goods: `Kurtka ${TOKEN}`, tnvedCode: '6201409000' });
    await finishCalcRequest(
      answeredId,
      { amountText: '900', currency: 'USD', note: 'sotuvchiga', internalNote: `ichki sir ${TOKEN}` },
      ctx(vedAId),
    );
    // Held by A, SEALED by B.
    sealedId = await job({ section: 'yolkira', holder: vedAId, goods: `Monitor ${TOKEN}` });
    await setFreightZone(sealedId, 'cn', ctx(vedBId));
    await sealCalc(sealedId, NO_DISCOUNT, ctx(vedBId));
  });

  it('both kinds come back, and an answer carries no V number and no customs sum', async () => {
    const rows = await registryRows({ q: TOKEN, leadNamesReadable: true }, { noteSight: null });
    const answer = rows.find((r) => r.kind === 'answer' && r.requestId === answeredId) as RegistryAnswerRow;
    expect(answer).toBeTruthy();
    expect(answer.amount).toBe(900);
    expect(answer.answeredByName).toBe(vedAName);
    expect(answer.sellerNote).toBe('sotuvchiga');
    expect(answer).not.toHaveProperty('quoteNo');
    expect(answer).not.toHaveProperty('totalUsd');
    expect(rows.some((r) => r.kind === 'sealed' && r.requestId === sealedId)).toBe(true);
  });

  it('the internal note is null without the sight and the VED’s words with it', async () => {
    const without = await registryRows({ q: TOKEN, kind: 'answer', leadNamesReadable: true }, { noteSight: null });
    const withSight = await registryRows({ q: TOKEN, kind: 'answer', leadNamesReadable: true }, { noteSight: vedSight() });
    const find = (rows: typeof without) => rows.find((r) => r.kind === 'answer' && r.requestId === answeredId) as RegistryAnswerRow;
    expect(find(without).internalNote).toBeNull();
    expect(find(withSight).internalNote).toBe(`ichki sir ${TOKEN}`);
  });

  it('«Turi» and «Kim» filter by kind and by the CREDIT, never by the holder', async () => {
    const answersOnly = await registryRows({ q: TOKEN, kind: 'answer', leadNamesReadable: true }, { noteSight: null });
    expect(answersOnly.every((r) => r.kind === 'answer')).toBe(true);
    const sealsOnly = await registryRows({ q: TOKEN, kind: 'sealed', leadNamesReadable: true }, { noteSight: null });
    expect(sealsOnly.every((r) => r.kind === 'sealed')).toBe(true);
    expect(sealsOnly.some((r) => r.requestId === sealedId)).toBe(true);

    const byA = await registryRows({ q: TOKEN, personId: vedAId, leadNamesReadable: true }, { noteSight: null });
    expect(byA.map((r) => r.requestId)).toContain(answeredId);
    expect(byA.map((r) => r.requestId), 'A held the sealed job and did not seal it').not.toContain(sealedId);
    const byB = await registryRows({ q: TOKEN, personId: vedBId, leadNamesReadable: true }, { noteSight: null });
    expect(byB.map((r) => r.requestId)).toContain(sealedId);
    expect(byB.map((r) => r.requestId), 'B held the answered job and did not answer it').not.toContain(answeredId);
  });

  it('the counts name versions, answers and jobs', async () => {
    const counts = await registryCounts({ q: `Kurtka ${TOKEN}`, leadNamesReadable: true });
    expect(counts).toEqual({ versions: 0, answers: 1, jobs: 1 });
    const both = await registryCounts({ q: TOKEN, leadNamesReadable: true });
    expect(both.versions).toBeGreaterThanOrEqual(1);
    expect(both.answers).toBeGreaterThanOrEqual(2);
  });

  it('finds a job by its goods name and by a TNVED prefix of four digits and up', async () => {
    const byName = await registryRows({ q: `kurtka ${TOKEN}`, leadNamesReadable: true }, { noteSight: null });
    expect(byName.map((r) => r.requestId)).toContain(answeredId);
    const byCode = await registryRows({ q: '620140', personId: vedAId, leadNamesReadable: true }, { noteSight: null });
    expect(byCode.map((r) => r.requestId)).toContain(answeredId);
    const byHeading = await registryRows({ q: '6201', personId: vedAId, leadNamesReadable: true }, { noteSight: null });
    expect(byHeading.map((r) => r.requestId)).toContain(answeredId);
  });

  it('the goods fold opens only a registry row, and an answer’s goods carry no customs sum (7a)', async () => {
    // Review access-money-21: the route serves the registry, nothing wider —
    // an open job is no row of the history, so the accountant's door stays shut.
    const open = await job({ section: 'rastamojka', holder: vedAId, goods: `open ${TOKEN}` });
    expect(await isRegistryRequest(open)).toBe(false);
    expect(await isRegistryRequest(answeredId)).toBe(true);
    expect(await isRegistryRequest(sealedId)).toBe(true);
    const goods = await requestGoodsSheet(answeredId, calcRegistrySight(registryReader)!);
    const items = [...goods.groups.flatMap((g) => g.items), ...goods.ungrouped];
    expect(items.map((i) => [i.name, i.tnvedCode])).toEqual([[`Kurtka ${TOKEN}`, '6201409000']]);
    expect(JSON.stringify(goods)).not.toMatch(/customs|valueUsd/i);
  });

  it('credits the pricer in the totals and in the speed table, never the holder', async () => {
    const from = new Date(Date.now() - 3_600_000);
    const to = new Date(Date.now() + 3_600_000);
    const totals = await creditTotals({ from, to });
    const a = totals.find((t) => t.personId === vedAId);
    const b = totals.find((t) => t.personId === vedBId);
    // A answered the refusal job ('1 200') and the Kurtka job; B sealed one.
    expect(a).toMatchObject({ sealed: 0, answered: 2 });
    expect(b).toMatchObject({ sealed: 1, answered: 0 });
    const speed = await calcSpeed(from);
    expect(speed.find((s) => s.assigneeId === vedAId)?.done).toBe(2);
    expect(speed.find((s) => s.assigneeId === vedBId)?.done).toBe(1);
  });
});

describe('a lead’s name on the history (§10, access-money-14)', () => {
  it('is searchable and printed for the VED, «Lid» and unsearchable for the accountant', async () => {
    const id = await job({ section: 'rastamojka', entityType: 'lead', entityId: leadId, holder: vedAId, goods: `lid tovar ${SUFFIX}` });
    await finishCalcRequest(id, { amountText: '100', currency: 'USD', note: '', internalNote: 'x' }, ctx(vedAId));
    const ved = await registryRows({ q: leadName, leadNamesReadable: true }, { noteSight: null });
    const row = ved.find((r) => r.requestId === id);
    expect(row?.cardLabel).toBe(leadName);
    const accountant = await registryRows({ q: leadName, leadNamesReadable: false }, { noteSight: null });
    expect(accountant.map((r) => r.requestId)).not.toContain(id);
    const byGoods = await registryRows({ q: `lid tovar ${SUFFIX}`, leadNamesReadable: false }, { noteSight: null });
    expect(byGoods.find((r) => r.requestId === id)?.cardLabel).toBeNull();
  });
});

describe('a correction from an answer (10a)', () => {
  it('keeps the root seller, goes to the VED who priced it, and stops the old price standing', async () => {
    const answered = await job({ section: 'rastamojka', holder: vedBId, goods: `recalc ${TOKEN}` });
    await finishCalcRequest(answered, { amountText: '700', currency: 'USD', note: '', internalNote: 'x' }, ctx(vedAId));
    expect((await standingAnchorsFor('deal', dealId)).answers.map((a) => a.requestId)).toContain(answered);

    // The VED re-opens it (the presser is never told what they just did).
    const child = (await recalcFromSealed(answered, ctx(vedAId))).id;
    madeRequests.push(child);
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, child) });
    expect(row!.supersedesRequestId).toBe(answered);
    expect(row!.requestedBy).toBe(sellerId);
    // The pricer, not the holder and not the rota's next.
    expect(row!.assigneeId).toBe(vedAId);
    const task = await db.query.tasks.findFirst({ where: eq(tasks.boundId, child) });
    expect(task).toMatchObject({ origin: 'calc', assigneeId: vedAId, status: 'open' });
    const pushed = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, sellerId), eq(notifications.type, 'CalcRecalc')));
    expect(pushed.length).toBeGreaterThan(0);
    // The old answer is no floor any more — the correction replaced it — and
    // every surface says so in the chain's one vocabulary (ved-correctness-2):
    // the panel's standing list, the registry row and the deal sheet.
    expect((await standingAnchorsFor('deal', dealId)).answers.map((a) => a.requestId)).not.toContain(answered);
    const reg = (await registryRows({ q: `recalc ${TOKEN}`, kind: 'answer', leadNamesReadable: true }, { noteSight: null }))
      .find((r) => r.requestId === answered) as RegistryAnswerRow;
    expect(reg).toMatchObject({ superseded: true, recalcOpen: true, childState: 'open' });
    const sheet = (await dealCalcSheets([dealId], calcRegistrySight(registryReader)!)).get(dealId)!;
    expect(sheet.answers.find((a) => a.requestId === answered)?.childState).toBe('open');
    await expect(recalcFromSealed(answered, ctx(sellerId))).rejects.toMatchObject({ code: 'recalc_open' });

    // Handed back: the only way on is a new request from the card.
    await returnCalcRequest(child, 'material yetmaydi', ctx(vedAId));
    await expect(recalcFromSealed(answered, ctx(sellerId))).rejects.toMatchObject({ code: 'recalc_returned' });
  });

  it('the rota a correction falls to never holds an admin or the owner', async () => {
    const pool = await vedRotaPool();
    expect(pool).toContain(vedAId);
    // An admin holds every grant, ved.docs included — and is not a calculator.
    expect(pool).not.toContain(adminVedId);
  });

  it('the quote lock follows what STANDS: a seal locks, its correction releases', async () => {
    const sealed = await job({ section: 'yolkira', entityId: deal2Id, holder: vedBId, goods: `lock ${TOKEN}` });
    await setFreightZone(sealed, 'cn', ctx(vedBId));
    const { totalUsd } = await sealCalc(sealed, NO_DISCOUNT, ctx(vedBId));
    expect(await quoteLockedFor('deal', deal2Id)).toBe(totalUsd);
    const child = (await recalcFromSealed(sealed, ctx(sellerId))).id;
    madeRequests.push(child);
    expect(await quoteLockedFor('deal', deal2Id), 'nothing stands, nothing is locked').toBeNull();
  });
});

/**
 * Review ved-money-1: the lock holds the number the CARD carries, which is
 * whatever wrote `quoted_amount` last — a seal (sealCalc) or a released offer
 * (applyOfferToCard) — and only while that writer stands. A card carries
 * several jobs (0085), so «the newest standing seal» is a different job's
 * floor the moment the job that wrote the card is recalculated: the ✏️ form
 * re-posts what the card shows (#171) and every save came back quote_sealed,
 * for ever if the correction ended as an answer or a hand-back (neither one
 * rewrites the card).
 */
describe('the quote lock follows the card’s LAST WRITER (ved-money-1)', () => {
  async function freshLead(tag: string): Promise<string> {
    const stage = await db.execute<{ id: string }>(
      `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
    );
    const [l] = await db
      .insert(leads)
      .values({ name: `Qulf ${tag} ${SUFFIX}`, stageId: stage[0]!.id, createdBy: sellerId, ownerId: sellerId })
      .returning({ id: leads.id });
    madeLeads.push(l!.id);
    return l!.id;
  }

  /** The ✏️ form's save: what the card shows re-posted, only the phone corrected. */
  async function saveShownQuote(id: string, newPhone: string) {
    const card = await db.query.leads.findFirst({ where: eq(leads.id, id) });
    await updateLead(
      id,
      {
        name: card!.name,
        phone: newPhone,
        stageId: card!.stageId,
        ownerId: sellerId,
        quotedAmount: card!.quotedAmount === null ? null : Number(card!.quotedAmount),
        quotedCurrency: 'USD',
        quotedVolumeM3: card!.quotedVolumeM3 === null ? null : Number(card!.quotedVolumeM3),
        quotedWeightKg: card!.quotedWeightKg === null ? null : Number(card!.quotedWeightKg),
      },
      ctx(sellerId),
    );
    return db.query.leads.findFirst({ where: eq(leads.id, id) });
  }

  async function sealedYolkira(entityId: string, volumeM3: string, goods: string) {
    const id = await job({ section: 'yolkira', entityType: 'lead', entityId, holder: vedAId, goods, volumeM3 });
    await setFreightZone(id, 'cn', ctx(vedAId));
    const { totalUsd } = await sealCalc(id, NO_DISCOUNT, ctx(vedAId));
    return { id, totalUsd };
  }

  it('two sealed jobs, the newer one recalculated: the card is unlocked, not held on the other floor', async () => {
    const lead = await freshLead('ikki');
    const a = await sealedYolkira(lead, '30', `qulf A ${TOKEN}`);
    const b = await sealedYolkira(lead, '10', `qulf B ${TOKEN}`);
    expect(a.totalUsd, 'the fixture needs two different floors').not.toBe(b.totalUsd);
    const card = await db.query.leads.findFirst({ where: eq(leads.id, lead) });
    expect(Number(card!.quotedAmount)).toBe(b.totalUsd);
    expect(await quoteLockedFor('lead', lead)).toBe(b.totalUsd);

    madeRequests.push((await recalcFromSealed(b.id, ctx(vedAId))).id);
    // B wrote the card and B no longer stands; A stands but is not on the card.
    expect(await quoteLockedFor('lead', lead)).toBeNull();
    const saved = await saveShownQuote(lead, '+998901112233');
    expect(saved!.phone).toBe('+998901112233');
    expect(Number(saved!.quotedAmount)).toBe(b.totalUsd);
  });

  it('a sealed job and an answered job with a released offer, the answer recalculated', async () => {
    const lead = await freshLead('javob');
    const a = await sealedYolkira(lead, '30', `qulf C ${TOKEN}`);
    const answered = await job({ section: 'rastamojka', entityType: 'lead', entityId: lead, holder: vedAId, goods: `qulf D ${TOKEN}` });
    await finishCalcRequest(answered, { amountText: '500', currency: 'USD', note: '', internalNote: 'x' }, ctx(vedAId));
    await recordOffer({ requestId: answered }, { clientPriceUsd: 650, locale: 'uz' }, ctx(sellerId));
    const card = await db.query.leads.findFirst({ where: eq(leads.id, lead) });
    expect(Number(card!.quotedAmount)).toBe(650);
    expect(await quoteLockedFor('lead', lead)).toBe(650);

    madeRequests.push((await recalcFromSealed(answered, ctx(vedAId))).id);
    expect(await quoteLockedFor('lead', lead), `not A's ${a.totalUsd}: A is not on the card`).toBeNull();
    const saved = await saveShownQuote(lead, '+998901114455');
    expect(saved!.phone).toBe('+998901114455');
    expect(Number(saved!.quotedAmount)).toBe(650);
  });

  it('a standing writer still locks: a different number is refused', async () => {
    const lead = await freshLead('turibdi');
    await sealedYolkira(lead, '30', `qulf E ${TOKEN}`);
    const b = await sealedYolkira(lead, '10', `qulf F ${TOKEN}`);
    const card = await db.query.leads.findFirst({ where: eq(leads.id, lead) });
    await expect(
      updateLead(lead, { name: card!.name, stageId: card!.stageId, ownerId: sellerId, quotedAmount: b.totalUsd + 1 }, ctx(sellerId)),
    ).rejects.toMatchObject({ code: 'quote_sealed' });
    // …and re-posting the card's own figure is an ordinary save.
    expect((await saveShownQuote(lead, '+998901116677'))!.phone).toBe('+998901116677');
  });
});

/**
 * Review access-6: a hand-typed URL of 36 hex digits and dashes passed the
 * doors' loose shape check and reached postgres as `::uuid`, which raises
 * 22P02 — an error page where the answer is «no such card» (#514).
 */
describe('a 36-character id that is not a uuid is no card, never a 500 (access-6)', () => {
  for (const id of ['a'.repeat(36), '-'.repeat(36)]) {
    it(`answers «none» for ${id.slice(0, 6)}…`, async () => {
      expect(await kartaCardFor(id)).toBeNull();
      expect(await kartaCardFor(madeRequests[0]!, id)).not.toBeNull();
      expect(await calcCardExists({ entityType: 'lead', entityId: id })).toBe(false);
      expect(await isCalcCardClient(id)).toBe(false);
      expect(await leadEverPriced(id)).toBe(false);
      expect(await newestRequestOn({ entityType: 'deal', entityId: id })).toBeNull();
      expect(await isRegistryRequest(id)).toBe(false);
    });
  }
});

/**
 * Review integration-5: the seal closes the VED's task with its own UPDATE,
 * and — unlike `endRequest`, the release and the take — never retired the
 * task's Telegram copies, so a queued «✅ Bajarildi» still went out for a job
 * that was already sealed.
 */
describe('the seal retires its task’s Telegram copies (integration-5)', () => {
  it('a queued copy of the sealed job’s task is muted, not sent', async () => {
    const stage = await db.execute<{ id: string }>(
      `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
    );
    const [l] = await db
      .insert(leads)
      .values({ name: `Muhr vazifa ${SUFFIX}`, stageId: stage[0]!.id, createdBy: sellerId, ownerId: sellerId })
      .returning({ id: leads.id });
    madeLeads.push(l!.id);
    const first = await job({ section: 'yolkira', entityType: 'lead', entityId: l!.id, holder: vedAId, goods: `muhr ${TOKEN}` });
    await setFreightZone(first, 'cn', ctx(vedAId));
    await sealCalc(first, NO_DISCOUNT, ctx(vedAId));
    // A correction is the cheap way to a request with a real task bound to it.
    const child = (await recalcFromSealed(first, ctx(vedAId))).id;
    madeRequests.push(child);
    const task = await db.query.tasks.findFirst({ where: eq(tasks.boundId, child) });
    expect(task?.status).toBe('open');
    // The copy still waiting in the drain's queue.
    const [copy] = await db
      .insert(notifications)
      .values({
        userId: task!.assigneeId,
        channel: 'telegram',
        type: 'TaskAssigned',
        status: 'pending',
        payload: { taskId: task!.id, text: `vazifa ${TOKEN}` },
      })
      .returning({ id: notifications.id });

    await setFreightZone(child, 'cn', ctx(vedAId));
    await sealCalc(child, NO_DISCOUNT, ctx(vedAId));
    expect((await db.query.tasks.findFirst({ where: eq(tasks.id, task!.id) }))?.status).toBe('done');
    // The retire is the void form, off the request: wait for it, briefly.
    let status = 'pending';
    for (let i = 0; i < 40 && status === 'pending'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await db.query.notifications.findFirst({ where: eq(notifications.id, copy!.id) }))!.status;
    }
    expect(status).toBe('muted');
  });
});
