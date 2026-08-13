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
import { clientFeed, clientFeedHasAnything } from '@/modules/wms/crm/feed';
import { conversationFor } from '@/modules/wms/crm/conversations';

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
    const items = await clientFeed(clientId);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['charge', 'note']);
    // Newest first is the contract the flex-col-reverse rendering relies on.
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(items[i]!.at.getTime());
    }
  });

  it('pages by timestamp across sources, without duplication', async () => {
    const first = await clientFeed(clientId, { limit: 1 });
    expect(first).toHaveLength(1);
    const rest = await clientFeed(clientId, { before: first[0]!.at });
    expect(rest.map((i) => i.kind)).toEqual(['note']);
    // No row appears on both pages — the cutoff is strict.
    expect(rest.map((i) => i.id)).not.toContain(first[0]!.id);
  });

  it('knows whether there is anything at all', async () => {
    expect(await clientFeedHasAnything(clientId)).toBe(true);
  });

  /**
   * Round 21, the owner: «lenta va chatlar alohida tursin». The client HAS a
   * telegram message (inserted above) and the lenta still must not carry it
   * — the chat lives in its own panel with its own per-account rule (#383).
   */
  it('never carries telegram lines — the chat is a separate panel now', async () => {
    const kinds = (await clientFeed(clientId)).map((i) => String(i.kind));
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
    const items = await clientFeed(null, { leadId });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('note');
    expect(items[0]!.body).toBe('lid bilan gaplashdik');
  });

  it('merges the lead notes into the client feed once the lead is linked', async () => {
    // The converted-lead case: both halves of the history, one column.
    const items = await clientFeed(clientId, { leadId });
    expect(items.map((i) => i.kind)).toEqual(['note', 'charge', 'note']);
  });

  it('shows another lead nothing that is not its own', async () => {
    // A wrong id must yield an empty feed, not somebody else's notes.
    const items = await clientFeed(null, { leadId: clientId });
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
    const items = await clientFeed(clientId, { dealId });
    expect(items[0]!.body).toBe('bitim bo‘yicha izoh');
  });

  it('does NOT leak onto the plain client card', async () => {
    // Two deals with one client are two conversations; a price argument about
    // one must not surface everywhere the client appears.
    const items = await clientFeed(clientId);
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
    const items = await clientFeed(cargoClientId);
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
    const items = await clientFeed(cargoClientId);
    const notes = items.filter((i) => i.kind === 'note');
    expect(notes.map((n) => n.meta.authorId)).toContain(managerId);
    expect(notes.map((n) => n.meta.authorId)).toContain(null);
  });
});
