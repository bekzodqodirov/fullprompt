import 'dotenv/config';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  notifications,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { __resetTelegramPause, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  createGroup,
  loadWorkspace,
  moveItemToGroup,
  recordOffer,
  releaseOffer,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { offerFileName, offerSheetFile } from '@/modules/wms/calc/offer-sheet-file';

/**
 * The seller's offer arrives WITH its sheet (his 2026-10-27: «narx taklifi
 * text bolib sotuvchi telegramiga kelyabti pdf ham birga kelsin telegramga
 * shu telegramni ozini jonatish imkoni uchun»).
 *
 * The drain as Telegram sees it — the transport is a recorder, as in
 * staff-drain.integration — and the claim is shared with every other file's
 * leftovers, so foreign pending rows are parked for the run and put back
 * exactly as found (#713, #730).
 */

const SUFFIX = String(Date.now()).slice(-6);
const CHAT = 710_000_000 + Number(SUFFIX);

interface Call {
  method: string;
  /** JSON body, or the FormData's text fields. */
  fields: Record<string, string>;
  file: { name: string; type: string; head: string } | null;
}
let calls: Call[] = [];
let answers: { status: number; json: unknown }[] = [];
let nextMessageId = 500;

let sellerId = '';
let clientId = '';
let dealId = '';
let dealCode = '';
const madeRequests: string[] = [];
const parked = new Set<string>();
const ctx = () => ({ actorId: sellerId });

beforeAll(async () => {
  const [seller] = await db
    .insert(users)
    .values({
      phone: `+99894${SUFFIX.padStart(7, '0')}`,
      fullName: `Taklif sotuvchi ${SUFFIX}`,
      passwordHash: 'x',
      locale: 'uz',
    })
    .returning();
  sellerId = seller!.id;
  await db
    .insert(telegramLinks)
    .values({ userId: sellerId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `OS${SUFFIX}`, name: `Taklif mijoz ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  dealCode = `OS-${SUFFIX}`;
  const [deal] = await db
    .insert(deals)
    .values({ code: dealCode, clientId, stageId: stage!.id, title: 'Offer sheet fixture', createdBy: sellerId })
    .returning();
  dealId = deal!.id;
});

beforeEach(() => {
  calls = [];
  answers = [];
  __resetTelegramPause();
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  __setTelegramTransport(async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const fields: Record<string, string> = {};
    let file: Call['file'] = null;
    if (init.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        if (typeof value === 'string') fields[key] = value;
        else {
          const bytes = new Uint8Array(await value.arrayBuffer());
          file = { name: value.name, type: value.type, head: new TextDecoder().decode(bytes.slice(0, 5)) };
        }
      }
    } else {
      for (const [key, value] of Object.entries(JSON.parse(String(init.body)) as Record<string, unknown>)) {
        fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    calls.push({ method, fields, file });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: (nextMessageId += 1) } } };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(async () => {
  __setTelegramTransport(null);
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
});

const savedToken = process.env.TELEGRAM_BOT_TOKEN;

afterAll(async () => {
  if (parked.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  if (madeRequests.length > 0) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
    const versionIds = (
      await db.select({ id: calcVersions.id }).from(calcVersions).where(inArray(calcVersions.requestId, madeRequests))
    ).map((r) => r.id);
    if (versionIds.length) await db.delete(calcOffers).where(inArray(calcOffers.versionId, versionIds));
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
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, sellerId));
  // Audited actor: deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await pgClient.end();
});

/** A request priced end to end and SEALED — what an offer hangs on. */
async function sealed() {
  const request = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'podklyuch',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `Stul ${SUFFIX}`, quantity: 100 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  const groupId = await createGroup(request.id, { label: 'Guruh', tnvedCode: `9401${SUFFIX}` }, ctx());
  const workspace = await loadWorkspace(request.id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(request.id, item.seq, groupId, ctx());
    await setItemBaza(request.id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
  }
  await setGroupRates(
    groupId,
    { tnvedCode: `9401${SUFFIX}`, dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: false, source: 'typed' },
    ctx(),
  );
  await setFreightZone(request.id, 'cn', ctx());
  await confirmAllGroups(request.id, ctx());
  await sealCalc(
    request.id,
    { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
    ctx(),
  );
  const version = await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, request.id) });
  return { versionId: version!.id, floor: Number(version!.totalUsd) };
}

/** Only this seller's rows are claimable while the drain runs. */
async function drain(): Promise<void> {
  const others = await db
    .update(notifications)
    .set({ status: 'sending', claimedAt: new Date() })
    .where(
      and(
        eq(notifications.channel, 'telegram'),
        eq(notifications.status, 'pending'),
        notInArray(notifications.userId, [sellerId]),
      ),
    )
    .returning({ id: notifications.id });
  for (const row of others) parked.add(row.id);
  await sendPendingTelegram().catch(() => {});
}

async function sellerRows() {
  return db.select().from(notifications).where(eq(notifications.userId, sellerId));
}

describe('the offer reaches the seller as ONE message: the sheet with the text under it', () => {
  it('sends the PDF with the offer text as its caption, and the row carries the offer id', async () => {
    const { versionId, floor } = await sealed();
    const result = await recordOffer({ versionId }, { clientPriceUsd: floor + 300, locale: 'uz', clientName: 'Ali aka' }, ctx());
    expect(result.delivered).toBe(true);

    const [row] = await sellerRows();
    expect((row!.payload as { offerId?: string }).offerId).toBe(result.id);

    await drain();
    expect(calls.map((c) => c.method)).toEqual(['sendDocument']);
    const [call] = calls;
    expect(call!.fields.chat_id).toBe(String(CHAT));
    expect(call!.fields.parse_mode).toBe('HTML');
    // The caption IS the offer text — the string the seller used to forward.
    expect(call!.fields.caption).toContain('Ali aka');
    expect(call!.fields.caption).toContain('Narx taklifi');
    expect(call!.file).toEqual({ name: `GSR-taklif-${dealCode}.pdf`, type: 'application/pdf', head: '%PDF-' });

    const [after] = await sellerRows();
    expect(after!.status).toBe('sent');
  });

  it('a refused FILE sends the words alone — the sheet is an addition, never the delivery', async () => {
    const { versionId, floor } = await sealed();
    await recordOffer({ versionId }, { clientPriceUsd: floor + 200, locale: 'ru', clientName: 'Bobur' }, ctx());
    answers = [{ status: 400, json: { ok: false, description: 'Bad Request: file is too big' } }];
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['sendDocument', 'sendMessage']);
    expect(calls[1]!.fields.text).toContain('Bobur');
    const [after] = await sellerRows();
    expect(after!.status).toBe('sent');
  });

  it('a busy moment (429) is the drain’s pause, not a text-only send', async () => {
    const { versionId, floor } = await sealed();
    await recordOffer({ versionId }, { clientPriceUsd: floor + 100, locale: 'uz', clientName: 'Sardor' }, ctx());
    answers = [{ status: 429, json: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } } }];
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['sendDocument']);
    const [after] = await sellerRows();
    // Put back for the next run, the sheet still owed.
    expect(after!.status).toBe('pending');
  });

  it('a pending below-floor promise prints no sheet; its release sends the sheet with the text', async () => {
    const { versionId, floor } = await sealed();
    const pending = await recordOffer(
      { versionId },
      { clientPriceUsd: floor - 50, locale: 'uz', clientName: 'Kamol', belowFloorReason: 'doimiy mijoz' },
      ctx(),
    );
    expect(pending.pending).toBe(true);
    // The lock waits on the PROMISE: no sheet exists for it, by URL or here.
    expect(await offerSheetFile(pending.id)).toBeNull();

    await releaseOffer(pending.id, ctx());
    await drain();
    const doc = calls.find((c) => c.method === 'sendDocument');
    expect(doc?.fields.caption).toContain('Kamol');
    expect(doc?.file?.head).toBe('%PDF-');
  });

  it('a row with no offer id (queued before this round) goes as the text it always was', async () => {
    await db.insert(notifications).values({
      userId: sellerId,
      channel: 'telegram',
      type: 'CalcOffer',
      payload: { text: 'Eski taklif matni' },
      status: 'pending',
    });
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(calls[0]!.fields.text).toContain('Eski taklif matni');
  });
});

describe('the file name the customer reads', () => {
  it('is ASCII, in the offer’s language, with the deal code', () => {
    expect(offerFileName('B-00123', 'uz')).toBe('GSR-taklif-B-00123.pdf');
    expect(offerFileName('B-00123', 'ru')).toBe('GSR-predlozhenie-B-00123.pdf');
    expect(offerFileName(null, 'en')).toBe('GSR-offer.pdf');
    expect(offerFileName('Б/12 "x"', 'uz')).toBe('GSR-taklif-12x.pdf');
  });
});
