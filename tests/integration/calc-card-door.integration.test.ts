import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  calcRequests,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  leads,
  notifications,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  calcCardExists,
  isCalcCardClient,
  kartaCardFor,
  leadEverPriced,
  mayOpenCalcCard,
  noteLinksFor,
} from '@/modules/wms/calc/card-door';
import { rekeyLeadCalcRequests } from '@/modules/wms/calc/service';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';
import { announceNote } from '@/modules/wms/crm/internal-chat';
import { userPermissions } from '@/modules/platform/rbac/authorize';

/**
 * The VED on the seller's card (the owner's 14a 15a 16a, docs/VED-TARIX.md
 * §10): ONE door — `ved.docs` AND a calculation on the card — asked by the
 * karta, the lenta, the file branch, the pulse and the note pings.
 *
 * Fixtures are this file's own and carry SEEDED roles, because the per-person
 * ping link reads each recipient's editable grants (`userPermissions`), and a
 * door about roles must be measured on the roles he edits (#170).
 */
const SUFFIX = String(Date.now()).slice(-7);
let seq = 0;
const phone = () => `+99891${SUFFIX.slice(-6)}${(seq += 1)}`;

let sellerId = '';
let vedId = '';
let accountantId = '';
let sellerName = '';
let vedName = '';
let leadId = '';
let bareLeadId = '';
let clientId = '';
let dealId = '';
let requestId = '';
let sellerNoteId = '';
let attachmentId = '';
const madeRequests: string[] = [];
const madeLeads: string[] = [];
const madeUsers: string[] = [];

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

async function request(entityId: string, entityType: 'lead' | 'deal' = 'lead', noteId?: string) {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType,
      entityId,
      requestedBy: sellerId,
      assigneeId: vedId,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
      noteId: noteId ?? null,
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(r!.id);
  return r!.id;
}

const actorOf = async (id: string) => ({
  id,
  permissions: await userPermissions(id),
  warehouseScoped: false,
  warehouseIds: [] as string[],
});

beforeAll(async () => {
  sellerName = `Karta Sotuvchi ${SUFFIX}`;
  vedName = `Karta Vedchi ${SUFFIX}`;
  sellerId = await userWithRole('sales_manager', sellerName);
  vedId = await userWithRole('ved_manager', vedName);
  accountantId = await userWithRole('accountant', `Karta Buxgalter ${SUFFIX}`);

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `KD${SUFFIX.slice(-6)}`, name: `Karta client ${SUFFIX}`, phones: [] })
    .returning({ id: clients.id });
  clientId = client!.id;

  const stage = await db.execute<{ id: string }>(
    `SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`,
  );
  const [lead] = await db
    .insert(leads)
    .values({ name: `Karta lead ${SUFFIX}`, stageId: stage[0]!.id, createdBy: sellerId, ownerId: sellerId, clientId })
    .returning({ id: leads.id });
  leadId = lead!.id;
  const [bare] = await db
    .insert(leads)
    .values({ name: `Karta bare ${SUFFIX}`, stageId: stage[0]!.id, createdBy: sellerId, ownerId: sellerId })
    .returning({ id: leads.id });
  bareLeadId = bare!.id;
  madeLeads.push(leadId, bareLeadId);

  // The seller's photo on the lead's lenta — what the VED must be able to open.
  const [note] = await db
    .insert(crmActivities)
    .values({ entityType: 'lead', entityId: leadId, kind: 'note', note: 'rasm', createdBy: sellerId })
    .returning({ id: crmActivities.id });
  sellerNoteId = note!.id;
  const [att] = await db
    .insert(attachments)
    .values({
      entityType: 'crm_activity',
      entityId: sellerNoteId,
      storageKey: `test/karta-${SUFFIX}-${uuidv4()}`,
      fileName: 'rasm.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
      uploadedBy: sellerId,
    })
    .returning({ id: attachments.id });
  attachmentId = att!.id;

  requestId = await request(leadId, 'lead', sellerNoteId);
});

afterAll(async () => {
  await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
  await db.delete(events).where(inArray(events.entityId, madeLeads));
  if (dealId) {
    await db.delete(events).where(eq(events.entityId, dealId));
    await db.delete(deals).where(eq(deals.id, dealId));
  }
  await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.delete(clients).where(eq(clients.id, clientId));
  // DEACTIVATED, not deleted — audit_log may point at them (round 107's rule).
  await db.delete(userRoles).where(inArray(userRoles.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('the ONE card door', () => {
  it('admits ved.docs on a card that carries a calculation, and nobody else through it', async () => {
    expect(await mayOpenCalcCard(await actorOf(vedId), { entityType: 'lead', entityId: leadId })).toBe(true);
    // No calculation on the card → the VED is not given the funnel.
    expect(await mayOpenCalcCard(await actorOf(vedId), { entityType: 'lead', entityId: bareLeadId })).toBe(false);
    // The seller and the accountant do not pass THIS door (the seller has his own).
    expect(await mayOpenCalcCard(await actorOf(sellerId), { entityType: 'lead', entityId: leadId })).toBe(false);
    expect(await mayOpenCalcCard(await actorOf(accountantId), { entityType: 'lead', entityId: leadId })).toBe(false);
  });

  it('the karta draws the request’s own lead and ignores a lid it has no link to', async () => {
    expect(await kartaCardFor(requestId)).toEqual({ kind: 'lead', leadId, requestId, wonDealId: null });
    expect(await kartaCardFor(requestId, bareLeadId)).toEqual({ kind: 'lead', leadId, requestId, wonDealId: null });
    expect(await kartaCardFor(uuidv4())).toBeNull();
  });

  it('opens the seller’s lenta photo for the VED, and only on a calc card', async () => {
    const att = { id: attachmentId, entityType: 'crm_activity', entityId: sellerNoteId, uploadedBy: sellerId };
    const ved = await actorOf(vedId);
    // A VED-only reader: the deal branch admits him already; the lead branch
    // must now admit the calc card's lead.
    await db.update(calcRequests).set({ noteId: null }).where(eq(calcRequests.id, requestId));
    try {
      expect((await decideAttachmentRead(ved, att)).rule).toBe('crm-activity-calc-card');
      const [other] = await db
        .insert(crmActivities)
        .values({ entityType: 'lead', entityId: bareLeadId, kind: 'note', note: 'x', createdBy: sellerId })
        .returning({ id: crmActivities.id });
      const bare = { ...att, entityId: other!.id };
      expect((await decideAttachmentRead(ved, bare)).allow).toBe(false);
    } finally {
      await db.update(calcRequests).set({ noteId: sellerNoteId }).where(eq(calcRequests.id, requestId));
    }
  });

  it('a calc card’s stored client is one the file branch answers for', async () => {
    expect(await isCalcCardClient(clientId)).toBe(true);
    expect(await isCalcCardClient(uuidv4())).toBe(false);
  });
});

describe('a note ping links each recipient to the door they have', () => {
  it('the seller to the CRM card, the VED to the karta, the accountant to nothing', async () => {
    const links = await noteLinksFor({ entityType: 'lead', entityId: leadId }, [sellerId, vedId, accountantId]);
    expect(links.get(sellerId)).toContain(`/crm/leads/${leadId}`);
    expect(links.get(vedId)).toContain(`/hisoblash/${requestId}/karta?lid=${leadId}`);
    expect(links.get(vedId)).not.toContain('/crm/leads/');
    expect(links.get(accountantId)).toBeNull();
  });

  it('the seller answers the VED’s question and the VED’s ping opens the karta', async () => {
    // The VED asked on the card — that makes him a participant of the thread.
    await db
      .insert(crmActivities)
      .values({ entityType: 'lead', entityId: leadId, kind: 'note', note: 'Necha kub?', createdBy: vedId });
    await announceNote({
      entityType: 'lead',
      entityId: leadId,
      note: '12 kub',
      authorId: sellerId,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, vedId), eq(notifications.type, 'InternalNote')));
    const texts = rows.map((r) => String((r.payload as { text?: string }).text ?? ''));
    expect(texts.some((t) => t.includes(`/hisoblash/${requestId}/karta`))).toBe(true);
    expect(texts.some((t) => t.includes(`/crm/leads/${leadId}`))).toBe(false);
  });

  it('a mention of the VED links him to the karta too', async () => {
    await announceNote({
      entityType: 'lead',
      entityId: leadId,
      note: `@${vedName} qarab bering`,
      authorId: sellerId,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, vedId), eq(notifications.type, 'MentionedInNote')));
    const texts = rows.map((r) => String((r.payload as { text?: string }).text ?? ''));
    expect(texts.some((t) => t.includes(`/hisoblash/${requestId}/karta`))).toBe(true);
  });
});

describe('the lead’s own quote column', () => {
  it('counts as the seller’s guess only until a calculation priced the card', async () => {
    expect(await leadEverPriced(leadId)).toBe(false);
    const answered = await request(leadId);
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'task', completedBy: vedId, answerAmount: '480', answerCurrency: 'USD' })
      .where(eq(calcRequests.id, answered));
    expect(await leadEverPriced(leadId)).toBe(true);
    // A task ✅ with no amount is not an answer — the 0093 body, not a guess.
    await db.update(calcRequests).set({ answerAmount: null }).where(eq(calcRequests.id, answered));
    expect(await leadEverPriced(leadId)).toBe(false);
    await db.delete(calcRequests).where(eq(calcRequests.id, answered));
  });
});

describe('after the lead is won (review tests-completeness-21)', () => {
  it('the lead keeps its karta through the request’s materials note, and the deal holds the price', async () => {
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const [deal] = await db
      .insert(deals)
      .values({ code: `KD-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Karta won', createdBy: sellerId })
      .returning({ id: deals.id });
    dealId = deal!.id;
    // A second request with NO materials note: the stated limit.
    const noNote = await request(leadId);
    await rekeyLeadCalcRequests(leadId, dealId);

    const ved = await actorOf(vedId);
    expect(await calcCardExists({ entityType: 'deal', entityId: dealId })).toBe(true);
    // Still a calc card — the note is the one stored link a won lead keeps.
    expect(await mayOpenCalcCard(ved, { entityType: 'lead', entityId: leadId })).toBe(true);
    expect(await kartaCardFor(requestId, leadId)).toEqual({ kind: 'lead', leadId, requestId, wonDealId: dealId });
    // Without the lid the request is the deal's, and the deal card is its karta.
    expect(await kartaCardFor(requestId)).toEqual({ kind: 'deal', dealId, requestId });
    // The request with no note now names no lead at all — stated, not built.
    expect(await kartaCardFor(noNote, leadId)).toEqual({ kind: 'deal', dealId, requestId: noNote });

    const att = { id: attachmentId, entityType: 'crm_activity', entityId: sellerNoteId, uploadedBy: sellerId };
    expect((await decideAttachmentRead(ved, att)).allow).toBe(true);
    const links = await noteLinksFor({ entityType: 'lead', entityId: leadId }, [vedId]);
    expect(links.get(vedId)).toContain(`?lid=${leadId}`);
  });
});
