import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  clientTransactions,
  crmActivities,
  receiptLots,
  receipts,
  dealStages,
  deals,
  leads,
  leadStages,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import { clientFeed, clientFeedHasAnything, machineReplyOf } from '@/modules/wms/crm/feed';
import { conversationFor } from '@/modules/wms/crm/conversations';
import { addActivity } from '@/modules/wms/crm/service';
import { aiVedReplyText } from '@/modules/wms/calc/ai-reply';
import {
  AI_REPLY_HEAD,
  TARIFF_REPLY_HEAD,
  VED_ESTIMATE_MARK,
} from '@/modules/wms/calc/reply-heads';

/**
 * The «lenta» against a real database.
 *
 * It had shipped with no test of its own — probed by hand, screenshotted, and
 * declared done — and the first thing the owner found was a case the probing
 * never touched: a LEAD card, where the client is usually null and the whole
 * panel silently rendered nothing. "Qo'shilmadi", he said, and from where he
 * sat it hadn't been. These tests exist so the next gap fails here first.
 */

const STAMP = Date.now();
const at = (minutesAgo: number) => new Date(STAMP - minutesAgo * 60_000);

let managerId: string;
let clientId: string;
let leadId: string;
let dealId: string;
let tgMessageId: string;

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  managerId = staff!.id;

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `FD${STAMP}`.slice(0, 12), name: `Feed ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;

  const [stage] = await db.select().from(leadStages).limit(1);
  const [l] = await db
    .insert(leads)
    .values({ name: `Lead ${STAMP}`, stageId: stage!.id, createdBy: managerId })
    .returning({ id: leads.id });
  leadId = l!.id;

  // Three different sources for the client, in a KNOWN time order.
  const [tgRow] = await db
    .insert(tgMessages)
    .values({
      clientId,
      managerUserId: managerId,
      peerId: BigInt(STAMP),
      tgMessageId: 1n,
      direction: 'in',
      body: 'salom',
      sentAt: at(30),
    })
    .returning({ id: tgMessages.id });
  tgMessageId = tgRow!.id;
  // A downloaded photo pinned to that message (item 15).
  await db.insert(attachments).values({
    entityType: 'tg_message',
    entityId: tgMessageId,
    kind: 'photo',
    storageKey: `feedtest/${tgMessageId}`,
    fileName: 'photo_1.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: managerId,
  });
  await db.insert(crmActivities).values({
    entityType: 'client',
    entityId: clientId,
    kind: 'note',
    note: 'mijoz haqida izoh',
    happenedAt: at(20),
    createdBy: managerId,
  });
  await db.insert(clientTransactions).values({
    clientId,
    type: 'charge',
    amount: '150.00',
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: '150.00',
    txDate: '2026-07-28',
    createdBy: managerId,
    createdAt: at(10),
  });
  const [dstage] = await db.select().from(dealStages).limit(1);
  const [d] = await db
    .insert(deals)
    .values({
      code: `B-FD${STAMP}`.slice(0, 14),
      clientId,
      stageId: dstage!.id,
      createdBy: managerId,
    })
    .returning({ id: deals.id });
  dealId = d!.id;
  await db.insert(crmActivities).values({
    entityType: 'deal',
    entityId: dealId,
    kind: 'note',
    note: 'bitim bo‘yicha izoh',
    happenedAt: at(3),
    createdBy: managerId,
  });

  // And one note on the LEAD — the case that used to vanish.
  await db.insert(crmActivities).values({
    entityType: 'lead',
    entityId: leadId,
    kind: 'note',
    note: 'lid bilan gaplashdik',
    happenedAt: at(5),
    createdBy: managerId,
  });
});

afterAll(async () => {
  await db.delete(attachments).where(eq(attachments.entityId, tgMessageId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, clientId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, leadId));
  await db.delete(tgMessages).where(eq(tgMessages.clientId, clientId));
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('one client, several sources, one order', () => {
  it('merges the sources newest-first', async () => {
    const items = await clientFeed(clientId, { money: true });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['charge', 'note']);
    // Newest first is the contract the flex-col-reverse rendering relies on.
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(items[i]!.at.getTime());
    }
  });

  it('pages by timestamp across sources, without duplication', async () => {
    const first = await clientFeed(clientId, { money: true, limit: 1 });
    expect(first).toHaveLength(1);
    const rest = await clientFeed(clientId, { money: true, before: first[0]!.at });
    expect(rest.map((i) => i.kind)).toEqual(['note']);
    // No row appears on both pages — the cutoff is strict.
    expect(rest.map((i) => i.id)).not.toContain(first[0]!.id);
  });

  it('knows whether there is anything at all', async () => {
    expect(await clientFeedHasAnything(clientId, { money: true })).toBe(true);
  });

  /**
   * Round 21, the owner: «lenta va chatlar alohida tursin». The client HAS a
   * telegram message (inserted above) and the lenta still must not carry it
   * — the chat lives in its own panel with its own per-account rule (#383).
   */
  it('never carries telegram lines — the chat is a separate panel now', async () => {
    const kinds = (await clientFeed(clientId, { money: true })).map((i) => String(i.kind));
    expect(kinds).toContain('charge');
    expect(kinds).toContain('note');
    expect(kinds).not.toContain('tg_in');
    expect(kinds).not.toContain('tg_out');
    expect(kinds).not.toContain('tg_pending');
  });
});

describe('a lead that is not a client yet — the case the owner caught', () => {
  it('still has a living lenta', async () => {
    // No client at all: every client-keyed branch compares against NULL and
    // yields nothing, and the lead's own notes are what remains.
    const items = await clientFeed(null, { money: true, leadId });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('note');
    expect(items[0]!.body).toBe('lid bilan gaplashdik');
  });

  it('merges the lead notes into the client feed once the lead is linked', async () => {
    // The converted-lead case: both halves of the history, one column.
    const items = await clientFeed(clientId, { money: true, leadId });
    expect(items.map((i) => i.kind)).toEqual(['note', 'charge', 'note']);
  });

  it('shows another lead nothing that is not its own', async () => {
    // A wrong id must yield an empty feed, not somebody else's notes.
    const items = await clientFeed(null, { money: true, leadId: clientId });
    expect(items).toHaveLength(0);
  });
});

describe('a photographed message shows its photograph (item 15)', () => {
  it('the thread carries it, one query for the whole page', async () => {
    const messages = await conversationFor(clientId, { id: managerId });
    expect(messages[0]!.photos).toHaveLength(1);
  });
});

describe('the deal’s own chat — per job, not per client', () => {
  it('shows on the deal card, merged with the client history', async () => {
    const items = await clientFeed(clientId, { money: true, dealId });
    expect(items[0]!.body).toBe('bitim bo‘yicha izoh');
  });

  it('does NOT leak onto the plain client card', async () => {
    // Two deals with one client are two conversations; a price argument about
    // one must not surface everywhere the client appears.
    const items = await clientFeed(clientId, { money: true });
    expect(items.map((i) => i.body)).not.toContain('bitim bo‘yicha izoh');
  });
});

/**
 * Round 100 (1A): the cargo entry carries the goods, and a note knows its
 * author.
 *
 * Its OWN client on purpose: the shared fixture above is read by exact
 * kind-sequence assertions (['charge','note'] …), and a confirmed receipt on
 * that client would add a 'cargo' row to every one of them — the design
 * review caught exactly that. The fixture is raw rows because the feed reads
 * tables; confirmReceipt's own rules are proven in its own files.
 */
describe('cargo detail and note authorship (round 100, 1A)', () => {
  let cargoClientId = '';
  let receiptId = '';
  const noteIds: string[] = [];

  beforeAll(async () => {
    const [c] = await db
      .insert(clients)
      .values({ clientCode: `FC${STAMP}`.slice(0, 12), name: `FeedCargo ${STAMP}`, phones: [] })
      .returning({ id: clients.id });
    cargoClientId = c!.id;

    const wh = (await db.query.warehouses.findFirst())!;
    receiptId = crypto.randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      number: `FC-${STAMP}`,
      warehouseId: wh.id,
      clientId: cargoClientId,
      status: 'confirmed',
      confirmedAt: at(10),
      confirmedBy: managerId,
      createdBy: managerId,
    });
    await db.insert(receiptLots).values([
      {
        receiptId,
        seq: 1,
        letter: 'A',
        productNameZh: '手机壳',
        productNameRu: 'Чехлы',
        boxCount: 6,
        dimsMode: 'mixed',
        totalWeightKg: '48.5',
        totalVolumeM3: '0.6',
      },
      {
        receiptId,
        seq: 2,
        letter: 'B',
        productNameZh: '杂货',
        boxCount: 4,
        dimsMode: 'mixed',
        totalWeightKg: '20',
        totalVolumeM3: '0.4',
      },
    ]);

    const [mine] = await db
      .insert(crmActivities)
      .values({
        entityType: 'client',
        entityId: cargoClientId,
        kind: 'note',
        note: 'mening izohim',
        happenedAt: at(5),
        createdBy: managerId,
      })
      .returning({ id: crmActivities.id });
    const [machine] = await db
      .insert(crmActivities)
      .values({
        entityType: 'client',
        entityId: cargoClientId,
        kind: 'note',
        note: 'reklamadan kelgan xabar',
        happenedAt: at(4),
        createdBy: null,
      })
      .returning({ id: crmActivities.id });
    noteIds.push(mine!.id, machine!.id);
  });

  afterAll(async () => {
    await db.delete(crmActivities).where(inArray(crmActivities.id, noteIds));
    await db.delete(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(clients).where(eq(clients.id, cargoClientId));
  });

  it('the arrival names WHAT arrived — goods, kilos, cubes — not just a box count', async () => {
    const items = await clientFeed(cargoClientId, { money: true });
    const cargo = items.find((i) => i.kind === 'cargo')!;
    expect(cargo).toBeTruthy();
    // Russian name preferred; Chinese kept only where nothing else exists.
    expect(String(cargo.meta.goods)).toContain('Чехлы');
    expect(String(cargo.meta.goods)).toContain('杂货');
    expect(String(cargo.meta.goods)).not.toContain('手机壳');
    expect(Number(cargo.meta.boxes)).toBe(10);
    expect(Number(cargo.meta.kg)).toBeCloseTo(68.5, 1);
    expect(Number(cargo.meta.m3)).toBeCloseTo(1, 2);
  });

  it('a note carries its author id, and a machine note carries none', async () => {
    const items = await clientFeed(cargoClientId, { money: true });
    const notes = items.filter((i) => i.kind === 'note');
    expect(notes.map((n) => n.meta.authorId)).toContain(managerId);
    expect(notes.map((n) => n.meta.authorId)).toContain(null);
  });
});

/**
 * The lenta leaked money (docs/CARD-TABS.md): it printed every charge,
 * payment, refund and compensation to anyone who could read it — a seller on
 * ANY client's card — while since round 91 a seller reads only their own
 * clients' money. The caller now answers with the ledger's door, and a «no»
 * must take the money out of the QUERY: a page holding the rows is one
 * render away from printing them.
 *
 * Its own clients, for the reason the cargo block above has its own: the
 * shared fixture is read by exact kind sequences.
 */
describe('the lenta’s money is the ledger’s audience', () => {
  const MONEY_KINDS = ['charge', 'payment', 'refund', 'compensation'];
  let mixedClientId = '';
  let moneyOnlyClientId = '';

  beforeAll(async () => {
    const [mixed] = await db
      .insert(clients)
      .values({ clientCode: `FM${STAMP}`.slice(0, 12), name: `FeedMoney ${STAMP}`, phones: [] })
      .returning({ id: clients.id });
    mixedClientId = mixed!.id;
    const [only] = await db
      .insert(clients)
      .values({ clientCode: `FN${STAMP}`.slice(0, 12), name: `FeedMoneyOnly ${STAMP}`, phones: [] })
      .returning({ id: clients.id });
    moneyOnlyClientId = only!.id;

    await db.insert(crmActivities).values({
      entityType: 'client',
      entityId: mixedClientId,
      kind: 'note',
      note: 'pul haqida emas',
      happenedAt: at(30),
      createdBy: managerId,
    });
    const tx = (clientId: string, type: 'charge' | 'payment', amount: string, minutesAgo: number) => ({
      clientId,
      type,
      amount,
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: amount,
      method: type === 'payment' ? 'cash' : null,
      txDate: '2026-07-28',
      createdBy: managerId,
      createdAt: at(minutesAgo),
    });
    await db
      .insert(clientTransactions)
      .values([
        tx(mixedClientId, 'charge', '200.00', 20),
        tx(mixedClientId, 'payment', '50.00', 10),
        tx(moneyOnlyClientId, 'charge', '75.00', 15),
      ]);
  });

  afterAll(async () => {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, mixedClientId));
    await db
      .delete(clientTransactions)
      .where(inArray(clientTransactions.clientId, [mixedClientId, moneyOnlyClientId]));
    await db.delete(clients).where(inArray(clients.id, [mixedClientId, moneyOnlyClientId]));
  });

  it('a reader the ledger admits sees the charges and payments beside the note', async () => {
    const kinds = (await clientFeed(mixedClientId, { money: true })).map((i) => String(i.kind));
    expect(kinds).toEqual(['payment', 'charge', 'note']);
  });

  it('anyone else gets the same lenta with no money in it — not an empty one', async () => {
    const items = await clientFeed(mixedClientId, { money: false });
    expect(items.map((i) => String(i.kind))).toEqual(['note']);
    for (const kind of MONEY_KINDS) expect(items.some((i) => i.kind === kind), kind).toBe(false);
    // No amount travels by another road either: nothing left carries one.
    expect(items.some((i) => 'amount' in i.meta || 'amountUsd' in i.meta)).toBe(false);
  });

  it('«is there anything» does not answer for money it may not show', async () => {
    // A client whose ONLY history is a charge: to a reader the ledger does
    // not admit, the lenta is empty, and «there is something» would say
    // there is money there.
    expect(await clientFeedHasAnything(moneyOnlyClientId, { money: true })).toBe(true);
    expect(await clientFeedHasAnything(moneyOnlyClientId, { money: false })).toBe(false);
    // …and it still finds everything that is not money.
    expect(await clientFeedHasAnything(mixedClientId, { money: false })).toBe(true);
  });
});

/**
 * His 2.4 c (docs/SAKKIZ-R2.md §9): the machine's calculation answer goes onto
 * the card's lenta in full, with a mark — and a reply carrying an estimate (a
 * 📊 median or a guessed zone) must not wear the same mark as an exact one.
 *
 * The notes are written through the lenta's real door for a machine
 * (`addActivity` under `{ actorId: null }, { system: true }` — the writer the
 * prefill job uses), and the AI reply is the REAL renderer's text, so a
 * heading reworded in `ai-reply.ts` without `reply-heads.ts` turns this red.
 * The estimate fixture is built from the kernel's constants alone: it does
 * not wait on the package that renders the VED line.
 *
 * Its own lead, for the reason the cargo block has its own client: the shared
 * fixture above is read by exact kind sequences.
 */
describe('a machine’s calculation answer wears its mark (his 2.4 c)', () => {
  let machineLeadId = '';
  const ids = {
    ai: '',
    tariff: '',
    estimate: '',
    tariffEstimate: '',
    personAi: '',
    personEstimate: '',
    personTariff: '',
    personTariffEstimate: '',
    advert: '',
    advertTariff: '',
    advertTariffEstimate: '',
    plain: '',
  };

  const aiText = aiVedReplyText({
    clientLabel: 'GS777',
    cardLabel: 'B-000067',
    lines: [
      {
        label: 'Monitor 24"',
        code: '8528520000',
        measureText: '100 dona × $20/dona',
        bazaSource: 'memory',
        dutyText: '10%',
        addDutyPct: 0,
        exciseText: null,
        vatPct: 12,
        customsUsd: 496.96,
        refusal: null,
        estimated: null,
        weightFromTotal: false,
      },
    ],
    ungrouped: [],
    fee: { bhm: 5, usd: 164.8 },
    totalUsd: 661.76,
    feeRefusal: null,
    hasCertificate: true,
    freight: null,
    link: null,
    aiConfigured: true,
    estimate: null,
    audience: 'lenta',
  });
  // §2.4's yolkira reply, the stored-zone shape: no VED line.
  const tariffText = [
    `${TARIFF_REPLY_HEAD} (tarif bo‘yicha) · taxminiy · GS777 · B-000067`,
    'Xitoy → O‘zbekiston',
    '180 kg/m³ · $160/m³ × 12 m³',
    'Yo‘lkira: ≈ $1920.00',
    '⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.',
  ].join('\n');
  // §2.6: the VED line sits on line 2, directly under the heading.
  const estimateText = [
    `${AI_REPLY_HEAD} · tahminiy rastamojka · GS777 · B-000067`,
    `${VED_ESTIMATE_MARK} bu AI taxmini, rasmiy emas — 📊 baza deklaratsiyalar medianasidan. Muhrlash yoki «Готово»dan oldin o‘zingiz tekshiring.`,
    '1. Kurtka · 6201400000 · 300 kg × $3.80/kg 📊',
  ].join('\n');
  const tariffEstimateText = [
    `${TARIFF_REPLY_HEAD} (tarif bo‘yicha) · taxminiy · GS777`,
    `${VED_ESTIMATE_MARK} zona «Yiwu»dan taxmin, rasmiy emas — zonani o‘zingiz tanlang.`,
    'Xitoy → O‘zbekiston — zona «Yiwu»dan taxmin',
  ].join('\n');

  const machine = async (note: string) =>
    (
      await addActivity(
        { entityType: 'lead', entityId: machineLeadId, kind: 'note', note },
        { actorId: null },
        { system: true },
      )
    ).id;
  const person = async (note: string) =>
    (
      await addActivity(
        { entityType: 'lead', entityId: machineLeadId, kind: 'note', note },
        { actorId: managerId },
      )
    ).id;

  beforeAll(async () => {
    const [stage] = await db.select().from(leadStages).limit(1);
    const [l] = await db
      .insert(leads)
      .values({ name: `Machine ${STAMP}`, stageId: stage!.id, createdBy: managerId })
      .returning({ id: leads.id });
    machineLeadId = l!.id;

    ids.ai = await machine(aiText);
    ids.tariff = await machine(tariffText);
    ids.estimate = await machine(estimateText);
    ids.tariffEstimate = await machine(tariffEstimateText);
    // A person who pastes the machine's reply into a note has written a note.
    ids.personAi = await person(aiText);
    ids.personEstimate = await person(estimateText);
    // The likelier paste of the two: a refused yolkira reply ends «— mijozdan
    // so‘rab, kartadagi lentaga yozing», which sends the seller to this very
    // lenta with the reply in front of him.
    ids.personTariff = await person(tariffText);
    ids.personTariffEstimate = await person(tariffEstimateText);
    // An advert's system note (crm/inbound.ts `inboundNote`): no author
    // either, and the customer's own words may carry the heading and the mark
    // — inside the note, never at its start.
    ids.advert = await machine(
      `📣 instagram\nNarxi qancha? ${AI_REPLY_HEAD} dedi: ${VED_ESTIMATE_MARK} kerak`,
    );
    // The tariff heading mid-text, with and without the mark: each branch that
    // names it is anchored on its own — 'tariff' and the estimate's second half.
    ids.advertTariff = await machine(`📣 sayt\nNarxi qancha? ${TARIFF_REPLY_HEAD} kerak`);
    ids.advertTariffEstimate = await machine(
      `📣 sayt\nNarx? ${TARIFF_REPLY_HEAD} ${VED_ESTIMATE_MARK} kerak`,
    );
    ids.plain = await person('mijoz ertaga qo‘ng‘iroq qiladi');
  });

  afterAll(async () => {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, machineLeadId));
    await db.delete(leads).where(eq(leads.id, machineLeadId));
  });

  const chipOf = async (id: string) => {
    const items = await clientFeed(null, { money: false, leadId: machineLeadId });
    const item = items.find((i) => i.id === `ac-${id}`);
    expect(item, id).toBeTruthy();
    return { raw: item!.meta.machineReply, chip: machineReplyOf(item!) };
  };

  it('the real AI reply, written by the machine, is «ai»', async () => {
    expect(aiText.startsWith(AI_REPLY_HEAD)).toBe(true);
    expect(await chipOf(ids.ai)).toEqual({ raw: 'ai', chip: 'ai' });
  });

  it('a tariff reply is «tariff»', async () => {
    expect(await chipOf(ids.tariff)).toEqual({ raw: 'tariff', chip: 'tariff' });
  });

  it('a reply carrying the VED line is «estimate» — under either heading', async () => {
    expect(await chipOf(ids.estimate)).toEqual({ raw: 'estimate', chip: 'estimate' });
    expect(await chipOf(ids.tariffEstimate)).toEqual({ raw: 'estimate', chip: 'estimate' });
  });

  it('a PERSON’s note with the machine’s very text wears no chip', async () => {
    expect(await chipOf(ids.personAi)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.personEstimate)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.personTariff)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.personTariffEstimate)).toEqual({ raw: null, chip: null });
  });

  it('an advert’s system note wears no chip, whatever its words contain', async () => {
    expect(await chipOf(ids.advert)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.advertTariff)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.advertTariffEstimate)).toEqual({ raw: null, chip: null });
    expect(await chipOf(ids.plain)).toEqual({ raw: null, chip: null });
  });
});
