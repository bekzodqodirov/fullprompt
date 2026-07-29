import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  clientTransactions,
  crmActivities,
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
    const items = await clientFeed(clientId, managerId);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['charge', 'note', 'tg_in']);
    // Newest first is the contract the flex-col-reverse rendering relies on.
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(items[i]!.at.getTime());
    }
  });

  it('pages by timestamp across sources, without duplication', async () => {
    const first = await clientFeed(clientId, managerId, { limit: 1 });
    expect(first).toHaveLength(1);
    const rest = await clientFeed(clientId, managerId, { before: first[0]!.at });
    expect(rest.map((i) => i.kind)).toEqual(['note', 'tg_in']);
    // No row appears on both pages — the cutoff is strict.
    expect(rest.map((i) => i.id)).not.toContain(first[0]!.id);
  });

  it('knows whether there is anything at all', async () => {
    expect(await clientFeedHasAnything(clientId)).toBe(true);
  });

  /**
   * The 2026-07-29 rule on the lenta: cargo, money and notes are the
   * company's shared record — a colleague sees them all — but the Telegram
   * lines are the manager's personal account and show only to their owner.
   */
  it("shows a colleague the shared record WITHOUT the manager's telegram lines", async () => {
    const [, second] = await db.select().from(users).limit(2);
    if (!second || second.id === managerId) return;
    const items = await clientFeed(clientId, second.id);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('charge');
    expect(kinds).toContain('note');
    expect(kinds).not.toContain('tg_in');
    expect(kinds).not.toContain('tg_pending');
  });
});

describe('a lead that is not a client yet — the case the owner caught', () => {
  it('still has a living lenta', async () => {
    // No client at all: every client-keyed branch compares against NULL and
    // yields nothing, and the lead's own notes are what remains.
    const items = await clientFeed(null, managerId, { leadId });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('note');
    expect(items[0]!.body).toBe('lid bilan gaplashdik');
  });

  it('merges the lead notes into the client feed once the lead is linked', async () => {
    // The converted-lead case: both halves of the history, one column.
    const items = await clientFeed(clientId, managerId, { leadId });
    expect(items.map((i) => i.kind)).toEqual(['note', 'charge', 'note', 'tg_in']);
  });

  it('shows another lead nothing that is not its own', async () => {
    // A wrong id must yield an empty feed, not somebody else's notes.
    const items = await clientFeed(null, managerId, { leadId: clientId });
    expect(items).toHaveLength(0);
  });
});

describe('a photographed message shows its photograph (item 15)', () => {
  it('the lenta carries the file pinned to the telegram row', async () => {
    const items = await clientFeed(clientId, managerId);
    const tg = items.find((i) => i.kind === 'tg_in');
    const files = tg!.meta.files as { id: string; image: boolean }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.image).toBe(true);
  });

  it('the thread does too, one query for the whole page', async () => {
    const messages = await conversationFor(clientId, managerId);
    expect(messages[0]!.photos).toHaveLength(1);
  });
});

describe('the deal’s own chat — per job, not per client', () => {
  it('shows on the deal card, merged with the client history', async () => {
    const items = await clientFeed(clientId, managerId, { dealId });
    expect(items[0]!.body).toBe('bitim bo‘yicha izoh');
  });

  it('does NOT leak onto the plain client card', async () => {
    // Two deals with one client are two conversations; a price argument about
    // one must not surface everywhere the client appears.
    const items = await clientFeed(clientId, managerId);
    expect(items.map((i) => i.body)).not.toContain('bitim bo‘yicha izoh');
  });
});
