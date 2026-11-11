import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';

/**
 * A file past Telegram's 20 MB at the collector's doors (docs/FAYL-OQISH.md
 * §3.4, pdfimg-5, judge model-20mb-refusal) — through the SAME handler chain
 * the server runs (bot-harness). Telegram hands a bot nothing past 20 MB: the
 * refusal used to be learned as a bare null and said «Faylni saqlab bo‘lmadi —
 * matn bilan yozib yuboring» (an invitation to send it again), the caption
 * typed under it was lost, and nothing remembered the file — so «Bo‘ldi»
 * answered «Hali hech narsa yuborilmadi». Now the size is read off the
 * message, nothing is asked of Telegram, the refusal is said in its own
 * words, the caption is material, and the file is NAMED (`refusedFiles`),
 * never counted.
 *
 * The file door runs the REAL saveIntakeFile (its size check is the subject);
 * the burst take's door sees the same refusal through a stand-in.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));
vi.mock('@/modules/platform/telegram/calc-files', async (original) => {
  const real = await original<typeof import('@/modules/platform/telegram/calc-files')>();
  return { ...real, saveIntakeFile: vi.fn(real.saveIntakeFile) };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { __resetAddOffers } from '@/modules/platform/telegram/calc-amend';
import { saveIntakeFile, TOO_BIG_SAY } from '@/modules/platform/telegram/calc-files';
import { activeIntake, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-store';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { __forgetWaitMemory, dropWait } from '@/modules/platform/telegram/waits';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { botHarness, tg, type ApiCall, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-6);
const BIG = 25 * 1024 * 1024;
let h: BotHarness;
let sellerId = '';
let chat = 0;
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
/** Collections whose files the REAL save stored — their attachments go in `afterAll`. */
const storedNotes: string[] = [];

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99892${STAMP}8`, fullName: `Fayl ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: sellerId, roleId: role!.id });
  chat = Number(`94${STAMP}`);
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `FO${STAMP}`, name: `Fayl mijoz ${STAMP}` }).returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  h = botHarness();
});

beforeEach(() => {
  __forgetWaitMemory();
  __resetAddOffers();
  __resetDrafts();
  vi.mocked(saveIntakeFile).mockClear();
});

afterEach(async () => {
  await keptLastSettled();
  endIntake(BigInt(chat));
  dropWait(chat, 'agent_edit');
  if (madeRequests.length) {
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'lines' })
      .where(sql`${calcRequests.id} IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)}) AND ${calcRequests.completedAt} IS NULL`);
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id = ${String(chat)}::bigint`);
  h.restore();
  if (madeRequests.length) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  if (madeDeals.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  if (storedNotes.length) {
    const rows = await db.select({ key: attachments.storageKey }).from(attachments).where(inArray(attachments.entityId, storedNotes));
    for (const row of rows) await getStorage().delete(row.key).catch(() => {});
    await db.delete(attachments).where(inArray(attachments.entityId, storedNotes));
  }
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(telegramLinks).set({ status: 'revoked' }).where(eq(telegramLinks.userId, sellerId));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  await pgClient.end();
});

type Msg = Record<string, unknown> & { message_id: number; document?: Record<string, unknown> };
const msgOf = (u: Update) => (u as unknown as { message: Msg }).message;
const sends = (calls: ApiCall[]) => calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === chat);
/** A document past Telegram's bot limit, as Telegram describes it. */
function bigDocument(name: string, caption?: string): Update {
  const u = tg.document(chat, `big-${name}-${STAMP}`, { fileName: name, mime: 'application/pdf', ...(caption ? { caption } : {}) });
  msgOf(u).document!.file_size = BIG;
  return u;
}

describe('the collector’s file door (staff-handlers)', () => {
  it('a 25 MB invoice: said in its own words, nothing asked of Telegram, the caption read, the file named and not counted', async () => {
    startIntake(BigInt(chat), 'rastamojka', { ai: true, staffId: sellerId });
    updateIntake(BigInt(chat), { stage: 'material' });
    const m = h.mark();
    await h.handle(bigDocument('CI-2611.pdf', 'Kurtka 300 dona'));
    await h.settle();
    const said = sends(h.since(m).api).map((c) => String(c.payload.text));
    expect(said[0]).toBe(TOO_BIG_SAY);
    expect(said.join('\n')).not.toContain('Faylni saqlab bo‘lmadi');
    expect(h.since(m).sent.some((c) => c.method === 'getFile'), 'Telegram is asked nothing').toBe(false);
    const live = activeIntake(BigInt(chat))!;
    expect(live.refusedFiles).toEqual([{ name: 'CI-2611.pdf', why: '20 MB dan katta' }]);
    expect(live.material).toEqual(['Kurtka 300 dona']);
    expect(live.fileCount).toBe(0);
    expect(live.pdfs).toEqual([]);
  });
});

describe('a file the save refused — a re-send heals it, or none will (review model-break-caption-kept-then-retyped, model-break-unknown-type-unnamed)', () => {
  it('a FAILED download takes nothing: the same message re-sent brings the file and its caption — read once', async () => {
    startIntake(BigInt(chat), 'rastamojka', { ai: true, staffId: sellerId });
    updateIntake(BigInt(chat), { stage: 'material' });
    storedNotes.push(activeIntake(BigInt(chat))!.noteId);
    const caption = `Kurtka 300 dona 150 kg ${STAMP}`;
    vi.mocked(saveIntakeFile).mockResolvedValueOnce({ refused: 'download_failed' });
    const m = h.mark();
    await h.handle(tg.document(chat, `ci-a-${STAMP}`, { fileName: 'CI.pdf', mime: 'application/pdf', caption }));
    await h.settle();
    expect(sends(h.since(m).api).map((c) => String(c.payload.text))[0]).toBe('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
    expect(activeIntake(BigInt(chat))!.material).toEqual([]);
    expect(activeIntake(BigInt(chat))!.refusedFiles).toEqual([]);
    // He does what he was told: the same file and caption again, and it saves.
    h.serveFile(`ci-b-${STAMP}`, Buffer.from('%PDF-1.4 kurtka'));
    await h.handle(tg.document(chat, `ci-b-${STAMP}`, { fileName: 'CI.pdf', mime: 'application/pdf', caption }));
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.material).toEqual([caption]);
    expect(live.fileCount).toBe(1);
    expect(live.pdfs.map((p) => p.name)).toEqual(['CI.pdf']);
  });

  it('a type storage keeps no attachment of: said in words, never «qayta yuboring»; the caption read, the file named, never counted', async () => {
    startIntake(BigInt(chat), 'rastamojka', { ai: true, staffId: sellerId });
    updateIntake(BigInt(chat), { stage: 'material' });
    storedNotes.push(activeIntake(BigInt(chat))!.noteId);
    h.serveFile(`dwg-${STAMP}`, Buffer.from([0x41, 0x43, 0x31, 0x30, 0, 0, 0xff, 0xfe, 1, 2]));
    const m = h.mark();
    await h.handle(tg.document(chat, `dwg-${STAMP}`, { fileName: 'chizma.dwg', mime: 'application/octet-stream', caption: 'Shim 20 dona' }));
    await h.settle();
    const said = sends(h.since(m).api).map((c) => String(c.payload.text));
    expect(said[0]).toBe('📎 «chizma.dwg» kartada saqlanmadi: faylning bu turi o‘qilmaydi — rasm, PDF va Excel/CSV yuboring.');
    expect(said.join('\n')).not.toContain('Faylni saqlab bo‘lmadi');
    const live = activeIntake(BigInt(chat))!;
    expect(live.refusedFiles).toEqual([{ name: 'chizma.dwg', why: 'noma’lum fayl turi' }]);
    expect(live.material).toEqual(['Shim 20 dona']);
    expect(live.fileCount).toBe(0);
  });
});

describe('the add door’s media reply (calc-amend openAmendFromMedia)', () => {
  /** A landed request of this seller's, and the AI answer that carries ➕ (its message id). */
  async function answered(): Promise<number> {
    const [deal] = await db
      .insert(deals)
      .values({ code: `FO-${STAMP}-${madeDeals.length}`, clientId, stageId, title: 'Fayl', createdBy: sellerId })
      .returning();
    madeDeals.push(deal!.id);
    const r = await openCalcRequest(
      { intakeDoor: null, entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: 'Sumka', quantity: 10 }], source: 'card' },
      { actorId: sellerId },
    );
    madeRequests.push(r.id);
    const answerId = 880_000 + madeRequests.length;
    await db.insert(notifications).values({
      userId: sellerId,
      channel: 'telegram',
      type: 'CalcPrefilled',
      status: 'sent',
      payload: { add: true, requestId: r.id, tg: { chatId: String(chat), messageId: answerId } },
    });
    return answerId;
  }

  it('a failed download takes nothing — the caption waits for the re-send; past 20 MB the caption is read and the file named', async () => {
    const caption = `Shim 20 dona ${STAMP}`;
    vi.mocked(saveIntakeFile).mockResolvedValueOnce({ refused: 'download_failed' });
    const m = h.mark();
    await h.handle(tg.photo(chat, { caption, replyTo: await answered() }));
    await h.settle();
    expect(sends(h.since(m).api).map((c) => String(c.payload.text))).toContain('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
    expect(activeIntake(BigInt(chat))!.material).toEqual([]);
    endIntake(BigInt(chat));
    vi.mocked(saveIntakeFile).mockResolvedValueOnce({ refused: 'too_big' });
    const m2 = h.mark();
    await h.handle(tg.photo(chat, { caption, replyTo: await answered() }));
    await h.settle();
    expect(sends(h.since(m2).api).map((c) => String(c.payload.text))).toContain(TOO_BIG_SAY);
    const live = activeIntake(BigInt(chat))!;
    expect(live.material).toEqual([caption]);
    expect(live.refusedFiles).toEqual([{ name: 'rasm', why: '20 MB dan katta' }]);
    expect(live.fileCount).toBe(0);
  });
});

describe('the burst take’s door (calc-amend takeParts)', () => {
  it('a part past 20 MB is TAKEN with its text and named — never «qayta bosing», never a file', async () => {
    const code = `FO-${STAMP}-${madeDeals.length}`;
    const [deal] = await db.insert(deals).values({ code, clientId, stageId, title: 'Fayl', createdBy: sellerId }).returning();
    madeDeals.push(deal!.id);
    const r = await openCalcRequest(
      { intakeDoor: null, entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: 'Sumka', quantity: 10 }], source: 'card' },
      { actorId: sellerId },
    );
    madeRequests.push(r.id);
    const parts = [tg.photo(chat), tg.photo(chat, { caption: `Shim 20 dona ${STAMP}` })];
    const m0 = h.mark();
    for (const p of parts) await h.handle(p);
    await h.settle();
    const offer = sends(h.since(m0).api).at(-1)!;
    // The first part is stored as ever; the second is past the limit.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } }).jpeg().toBuffer();
    vi.mocked(saveIntakeFile)
      .mockResolvedValueOnce({ isPhoto: true, body: jpeg, attachmentId: '00000000-0000-4000-8000-0000000000a1' })
      .mockResolvedValueOnce({ refused: 'too_big' });
    const m = h.mark();
    await h.handle(tg.callback(chat, offer.messageId!, `cf:${r.id}`, { message: { text: offer.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    await h.settle();
    const said = sends(h.since(m).api).map((c) => String(c.payload.text));
    expect(said).toContain(TOO_BIG_SAY);
    expect(said.join('\n')).not.toContain('qayta bosing');
    const live = activeIntake(BigInt(chat))!;
    expect(live.fileCount).toBe(1);
    expect(live.refusedFiles).toEqual([{ name: 'rasm', why: '20 MB dan katta' }]);
    expect(live.material).toEqual([`Shim 20 dona ${STAMP}`]);
    expect(live.repliedTaken.sort()).toEqual(parts.map((p) => msgOf(p).message_id).sort());
  });

  it('a part’s own size is read before Telegram is asked — the take refuses a 25 MB part with no getFile (review model-break-burst-size-unused)', async () => {
    const code = `FO-${STAMP}-${madeDeals.length}`;
    const [deal] = await db.insert(deals).values({ code, clientId, stageId, title: 'Fayl', createdBy: sellerId }).returning();
    madeDeals.push(deal!.id);
    const r = await openCalcRequest(
      { intakeDoor: null, entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: 'Sumka', quantity: 10 }], source: 'card' },
      { actorId: sellerId },
    );
    madeRequests.push(r.id);
    const part = bigDocument('CI-burst.pdf', `Kurtka 5 dona ${STAMP}`);
    const m0 = h.mark();
    await h.handle(part);
    await h.settle();
    const offer = sends(h.since(m0).api).at(-1)!;
    const m = h.mark();
    await h.handle(tg.callback(chat, offer.messageId!, `cf:${r.id}`, { message: { text: offer.payload.text, reply_to_message: msgOf(part) } }));
    await h.settle();
    expect(h.since(m).sent.some((c) => c.method === 'getFile'), 'Telegram is asked nothing').toBe(false);
    expect(sends(h.since(m).api).map((c) => String(c.payload.text))).toContain(TOO_BIG_SAY);
    const live = activeIntake(BigInt(chat))!;
    expect(live.refusedFiles).toEqual([{ name: 'CI-burst.pdf', why: '20 MB dan katta' }]);
    expect(live.material).toEqual([`Kurtka 5 dona ${STAMP}`]);
  });
});
