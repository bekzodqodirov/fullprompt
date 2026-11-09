import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';

/**
 * Files and forwards sent with no collection open (docs/IKKI-ESHIK.md §4.1,
 * §4.2, §4.3, his 6a «ketma-ket yuborilgan fayllarga BITTA savol») — through
 * the SAME handler chain the server runs (bot-harness): ONE message per
 * burst, kept last; its buttons act on every part, read from the durable
 * wait by the pressed message; beside a parked collection that message is
 * the pause line, whose «▶️» takes the parts through the take's per-part
 * fence. The file store and the reading are stood in (a take files, it does
 * not read here); the offer query and the add door are real.
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
vi.mock('@/modules/platform/telegram/calc-files', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-files')>()),
  saveIntakeFile: vi.fn(async () => ({ isPhoto: true, body: Buffer.from(''), attachmentId: randomUUID() })),
  readIntakeFile: vi.fn(async () => ({ patch: {}, say: null })),
}));
vi.mock('@/modules/wms/calc/intake-land', async (original) => {
  const real = await original<typeof import('@/modules/wms/calc/intake-land')>();
  return { ...real, landIntake: vi.fn(real.landIntake) };
});

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequestItems, calcRequests, clients, crmActivities, deals, dealStages, roles, telegramLinks, userRoles, users } from '@/modules/platform/db/schema';
import { __resetAddOffers, addOfferRows } from '@/modules/platform/telegram/calc-amend';
import { saveIntakeFile } from '@/modules/platform/telegram/calc-files';
import { activeIntake, endIntake, HOLD_MS, holdingIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-store';
import { burstPauseLine, pauseKeyboard, pauseLine } from '@/modules/platform/telegram/calc-dialog';
import {
  BURST_FULL,
  BURST_FULL_TASK,
  BURST_GONE,
  BURST_IN_REQUEST,
  BURST_IN_TASK,
  BURST_NONE_TAKEN,
  BURST_TASK_CAP,
  readBurst,
} from '@/modules/platform/telegram/burst-wait';
import { drawOwedBursts } from '@/modules/platform/telegram/burst';
import { __forgetKeptLast } from '@/modules/platform/telegram/kept-last';
import { __resetDrafts, activeDraft, endDraft, MAX_DRAFT_SOURCES } from '@/modules/platform/telegram/task-draft';
import { CLIENT_QUESTION } from '@/modules/platform/telegram/calc-keyboards';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import { AGENT_WAIT_TTL_MS } from '@/modules/platform/telegram/agent-bot';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import {
  __forgetWaitMemory,
  armWait,
  dropWait,
  flushWaitWrites,
  hydrateWaits,
  nowSec,
  setDurableWaits,
} from '@/modules/platform/telegram/waits';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { botHarness, tg, type ApiCall, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerId = '';
let chat = 0;
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${STAMP}7`, fullName: `Burst ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = u!.id;
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: sellerId, roleId: role!.id });
  chat = Number(`93${STAMP}`);
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `BU${STAMP}`, name: `Burst mijoz ${STAMP}` }).returning();
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
  setDurableWaits(false);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id = ${String(chat)}::bigint`);
  h.restore();
  if (madeRequests.length) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  if (madeDeals.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(telegramLinks).set({ status: 'revoked' }).where(eq(telegramLinks.userId, sellerId));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  await pgClient.end();
});

/** An open request of his, on a fresh deal — what the ➕ rows offer. */
async function request(): Promise<{ id: string; card: string }> {
  const code = `BU-${STAMP}-${madeDeals.length}`;
  const [deal] = await db.insert(deals).values({ code, clientId, stageId, title: 'Burst', createdBy: sellerId }).returning();
  madeDeals.push(deal!.id);
  const r = await openCalcRequest(
    { intakeDoor: null, entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: 'Sumka', quantity: 10 }], source: 'card' },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  return { id: r.id, card: code };
}

type Msg = Record<string, unknown> & { message_id: number };
const msgOf = (u: Update) => (u as unknown as { message: Msg }).message;
/**
 * A photo, its own date by default; `group` an album's, `forwarded` a
 * forward's. `messageId` where it must be NEWER than a message the bot sent:
 * the harness numbers its own sends apart from the updates', and in a real
 * chat every id only grows.
 */
function photo(opts: { group?: string; forwarded?: boolean; date?: number; messageId?: number } = {}): Update {
  const u = tg.photo(chat, { forwarded: opts.forwarded, date: opts.date, messageId: opts.messageId });
  if (opts.group) msgOf(u).media_group_id = opts.group;
  return u;
}
const sends = (calls: ApiCall[]) => calls.filter((c) => c.method === 'sendMessage' && Number(c.payload.chat_id) === chat);
const rows = (c: ApiCall) => (c.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
const data = (c: ApiCall) => rows(c).flat().map((b) => b.callback_data);

/** Hand the parts over and settle; the ONE message they drew. */
async function burst(parts: Update[]): Promise<ApiCall[]> {
  const m = h.mark();
  for (const p of parts) await h.handle(p);
  await h.settle();
  return sends(h.since(m).api);
}

/** A collection opened on this chat and then parked (§2.7). */
async function parked(): Promise<void> {
  await h.handle(tg.text(chat, '🧮 Hisoblatish'));
  await h.handle(tg.callback(chat, 40_000 + Math.floor(Math.random() * 1000), 'c:rastamojka'));
  await h.handle(tg.text(chat, 'GS777'));
  await h.handle(tg.text(chat, 'Kurtka 300 dona'));
  // The collection's own prompt is drawn kept-last within a second of its
  // line (docs/IKKI-ESHIK.md §1.4) — thirty minutes before it parks.
  await h.settle();
  updateIntake(BigInt(chat), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
  expect(holdingIntake(BigInt(chat))).toBeNull();
}

describe('one question per burst (§4.1)', () => {
  it('an album of ten → ONE offer, below its newest part', async () => {
    const r = await request();
    const parts = Array.from({ length: 10 }, () => photo({ group: `al${STAMP}` }));
    const said = await burst(parts);
    expect(said.map((c) => c.payload.text)).toEqual(['➕ 10 ta faylni so‘rovga qo‘shamizmi?']);
    expect(said[0]!.payload.reply_parameters).toMatchObject({ message_id: msgOf(parts[9]!).message_id });
    expect(data(said[0]!)).toEqual([`cf:${r.id}`]);
  });

  it('three files and two forwards → ONE message, Door B’s and the ➕ rows; no 🔍 for two texts', async () => {
    const r = await request();
    const said = await burst([photo(), photo(), photo(), tg.forward(chat, `yuk 1 ${STAMP}`), tg.forward(chat, `yuk 2 ${STAMP}`)]);
    expect(said).toHaveLength(1);
    expect(said[0]!.payload.text).toBe('📌 5 ta xabar (3 tasi fayl) — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?');
    expect(data(said[0]!)).toEqual(['fb:task', `cf:${r.id}`]);
  });

  it('kept last: parts after the offer move it below them — the old copy deleted, ONE standing', async () => {
    await request();
    const first = await burst([photo(), photo()]);
    expect(first.map((c) => c.payload.text)).toEqual(['➕ 2 ta faylni so‘rovga qo‘shamizmi?']);
    const m = h.mark();
    const after = first[0]!.messageId!;
    const later = await burst([photo({ messageId: after + 1 }), tg.forward(chat, `mijoz ${STAMP}`, { messageId: after + 2 })]);
    expect(later.map((c) => c.payload.text)).toEqual(['📌 4 ta xabar (3 tasi fayl) — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?']);
    const deleted = h.since(m).api.filter((c) => c.method === 'deleteMessage');
    expect(deleted.map((c) => Number(c.payload.message_id))).toEqual([first[0]!.messageId]);
    expect(readBurst(chat)!.payload.offerIds).toEqual([later[0]!.messageId]);
  });

  it('a part two minutes after the previous one opens the NEXT burst', async () => {
    await request();
    const t = nowSec();
    const first = await burst([photo({ date: t - 200 }), photo({ date: t - 199 })]);
    expect(first.map((c) => c.payload.text)).toEqual(['➕ 2 ta faylni so‘rovga qo‘shamizmi?']);
    const next = await burst([photo({ date: t })]);
    expect(next.map((c) => c.payload.text)).toEqual(['➕ Bu faylni so‘rovga qo‘shamizmi?']);
    // A new message, and the old one is left alone: it is another burst's.
    expect(next[0]!.messageId).not.toBe(first[0]!.messageId);
  });

  it('a typed text, a press, or a collection opening ENDS it: the next file asks afresh', async () => {
    await request();
    const a = await burst([photo(), photo()]);
    await h.handle(tg.text(chat, 'bular GS777 niki'));
    const b = await burst([photo()]);
    expect(b.map((c) => c.payload.text)).toEqual(['➕ Bu faylni so‘rovga qo‘shamizmi?']);
    expect(b[0]!.messageId).not.toBe(a[0]!.messageId);
    await h.handle(tg.callback(chat, 1, 'c:cancel'));
    const c = await burst([photo()]);
    expect(c.map((x) => x.payload.text)).toEqual(['➕ Bu faylni so‘rovga qo‘shamizmi?']);
    expect(readBurst(chat)!.payload.open).toBe(true);
    startIntake(BigInt(chat), 'rastamojka', { staffId: sellerId });
    expect(readBurst(chat)!.payload.open).toBe(false);
  });

  it('the durable wait survives a restart: hydrated, the press still takes every part', async () => {
    const r = await request();
    setDurableWaits(true);
    try {
      const parts = [photo(), photo(), photo()];
      const [offer] = await burst(parts);
      await flushWaitWrites();
      __forgetWaitMemory();
      expect(readBurst(chat)).toBeNull();
      expect(await hydrateWaits()).toBeGreaterThan(0);
      expect(readBurst(chat)!.payload.parts).toHaveLength(3);
      await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
      await h.settle();
      expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
      expect(activeIntake(BigInt(chat))!.fileCount).toBe(3);
    } finally {
      setDurableWaits(false);
    }
  });
});

describe('the buttons act on the WHOLE burst, read by the pressed message (§4.1)', () => {
  it('➕ takes every part — the forwarded texts too — once; the prompt says what it took; a redelivered press is a no-op', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo(), tg.forward(chat, `20 karobka ${STAMP}`), tg.forward(chat, `brutto 300 kg ${STAMP}`)];
    const [offer] = await burst(parts);
    const press = tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[4]!) } });
    const m = h.mark();
    await h.handle(press);
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.amend?.requestId).toBe(r.id);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
    expect(live.fileCount).toBe(3);
    expect(live.material).toEqual([`20 karobka ${STAMP}`, `brutto 300 kg ${STAMP}`]);
    expect(live.repliedTaken.sort()).toEqual(parts.map((p) => msgOf(p).message_id).sort());
    // The take's line opens the ONE prompt — one message, never a second (§1.4).
    const prompt = sends(h.since(m).api).at(-1)!;
    expect(String(prompt.payload.text).startsWith('➕ 3 ta fayl va 2 ta xabar qo‘shildi.\n')).toBe(true);
    expect(String(prompt.payload.text)).toContain('Qabul qilindi:');
    expect(sends(h.since(m).api).filter((c) => String(c.payload.text).includes('qo‘shildi'))).toHaveLength(1);
    const again = h.mark();
    await h.handle(tg.again(press));
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(3);
    expect(sends(h.since(again).api).some((c) => String(c.payload.text).includes('qo‘shildi'))).toBe(false);
  });

  it('a take cut short (the third file’s save failed): the press again files ONLY that one — the per-part fence (review dur-2)', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo()];
    const [offer] = await burst(parts);
    const saved = async () => ({ isPhoto: true, body: Buffer.from(''), attachmentId: randomUUID() });
    let n = 0;
    vi.mocked(saveIntakeFile).mockImplementation(async () => {
      n += 1;
      if (n === 3) throw new Error('storage blip');
      return saved();
    });
    try {
      const press = tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } });
      const m = h.mark();
      await h.handle(press);
      await h.settle();
      expect(activeIntake(BigInt(chat))!.fileCount).toBe(2);
      expect(h.textsTo(chat, m)).toContain('Faylni saqlab bo‘lmadi — qayta bosing yoki matn bilan yozib yuboring.');
      await h.handle(tg.again(press));
      await h.settle();
      expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(4);
      expect(activeIntake(BigInt(chat))!.fileCount).toBe(3);
      expect(activeIntake(BigInt(chat))!.repliedTaken.sort()).toEqual(parts.map((p) => msgOf(p).message_id).sort());
    } finally {
      vi.mocked(saveIntakeFile).mockImplementation(saved);
    }
  });

  it('➕ beside a live collection asks first — and the «🗑 Ha» of that question takes the whole burst', async () => {
    const r = await request();
    const parts = [photo(), photo()];
    const [offer] = await burst(parts);
    // A collection opened and filled after the offer was drawn.
    await h.handle(tg.text(chat, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chat, 41_000, 'c:rastamojka'));
    await h.handle(tg.text(chat, 'GS777'));
    await h.handle(tg.text(chat, 'Kurtka 300 dona'));
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    const question = sends(h.since(m).api).find((c) => String(c.payload.text).includes('tugallanmagan yig‘ish'));
    expect(question, 'the question was asked').toBeDefined();
    expect(vi.mocked(saveIntakeFile)).not.toHaveBeenCalled();
    await h.handle(tg.callback(chat, question!.messageId!, `cg:${r.id}`, { message: { text: question!.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.amend?.requestId).toBe(r.id);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(2);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(2);
  });

  it('📌 takes every part as a source; over the topshiriq’s cap it says so as the FIRST line of the draft’s question (review PB-ADV-7)', async () => {
    // Re-anchored: the cap was a message of its own, sent BELOW «👤 Kimga?».
    const parts = Array.from({ length: 12 }, (_, i) => tg.forward(chat, `xabar ${i} ${STAMP}`));
    const [offer] = await burst(parts);
    expect(offer!.payload.text).toBe('📌 12 ta xabar — topshiriq qilamizmi?');
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[11]!) } }));
    await h.settle();
    const draft = activeDraft(BigInt(chat))!;
    expect(draft.sources).toHaveLength(MAX_DRAFT_SOURCES);
    expect(draft.sources.map((s) => s.messageId)).toEqual(parts.slice(0, MAX_DRAFT_SOURCES).map((p) => msgOf(p).message_id));
    expect(draft.dropped).toBe(2);
    const said = h.textsTo(chat, m);
    expect(said).toHaveLength(1);
    expect(said[0]!.startsWith(`${BURST_TASK_CAP(MAX_DRAFT_SOURCES)}\n👤 Kimga?`)).toBe(true);
    expect(readBurst(chat)!.payload).toMatchObject({ taken: true, intoTask: true });
  });

  it('12 forwarded PHOTOS: ten sources and ten files — a file never rides past its source’s cap (review PB-SPEC-6)', async () => {
    const parts = Array.from({ length: 12 }, () => photo({ forwarded: true }));
    const [offer] = await burst(parts);
    await h.handle(tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[11]!) } }));
    await h.settle();
    const draft = activeDraft(BigInt(chat))!;
    expect(draft.sources).toHaveLength(MAX_DRAFT_SOURCES);
    expect(draft.files).toHaveLength(MAX_DRAFT_SOURCES);
    expect(draft.dropped).toBe(2);
  });

  it('the wait gone: the press takes what it replies to, and SAYS so', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo()];
    const [offer] = await burst(parts);
    __forgetWaitMemory();
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(1);
    expect(activeIntake(BigInt(chat))!.repliedTaken).toEqual([msgOf(parts[2]!).message_id]);
    expect(h.textsTo(chat, m)).toContain(BURST_GONE);
  });

  it('…and 📌 says it too', async () => {
    const parts = [tg.forward(chat, `a ${STAMP}`), tg.forward(chat, `b ${STAMP}`)];
    const [offer] = await burst(parts);
    __forgetWaitMemory();
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    await h.settle();
    expect(activeDraft(BigInt(chat))!.sources.map((s) => s.messageId)).toEqual([msgOf(parts[1]!).message_id]);
    expect(h.textsTo(chat, m)).toContain(BURST_GONE);
  });
});

describe('beside a PARKED collection, the pause line is the burst’s ONE message (§4.2)', () => {
  it('three files → ONE pause line, kept last, with ▶️ (resume_take) and ✖️; nothing taken by itself', async () => {
    await parked();
    const before = activeIntake(BigInt(chat))!.fileCount;
    const said = await burst([photo(), photo(), photo()]);
    expect(said.map((c) => c.payload.text)).toEqual([burstPauseLine(3)]);
    expect(data(said[0]!)).toEqual(['c:resume_take', 'c:cancel']);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before);
    expect(holdingIntake(BigInt(chat))).toBeNull();
  });

  it('with a forward among them → «📌 Topshiriq qilish» too, still ONE line', async () => {
    await parked();
    const said = await burst([photo(), tg.forward(chat, `mijoz ${STAMP}`)]);
    expect(said.map((c) => c.payload.text)).toEqual([burstPauseLine(2)]);
    expect(data(said[0]!)).toEqual(['c:resume_take', 'fb:task', 'c:cancel']);
  });

  it('▶️ takes ONLY the parts its line spoke for, through the per-part fence; a NEW prompt; a redelivery is a no-op', async () => {
    await parked();
    const before = activeIntake(BigInt(chat))!.fileCount;
    const parts = [photo(), photo(), photo()];
    const [line] = await burst(parts);
    const press = tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[2]!) } });
    const m = h.mark();
    await h.handle(press);
    await h.settle();
    const live = activeIntake(BigInt(chat))!;
    expect(live.fileCount).toBe(before + 3);
    expect(holdingIntake(BigInt(chat))).not.toBeNull();
    // A NEW prompt, the take's line its first (§4.2) — one message.
    const said = sends(h.since(m).api);
    const prompt = said.at(-1)!;
    expect(String(prompt.payload.text).startsWith('▶️ Davom etamiz — 3 ta fayl qo‘shildi.\n')).toBe(true);
    expect(String(prompt.payload.text)).toContain('Qabul qilindi:');
    expect(String(prompt.payload.text)).toContain('Yana yuboring yoki «Bo‘ldi» ni bosing.');
    expect(said.filter((c) => String(c.payload.text).includes('Davom etamiz'))).toHaveLength(1);
    await h.handle(tg.again(press));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before + 3);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
  });

  it('beside a one-text wait (REG-2): refused in words before anything is taken', async () => {
    await parked();
    const before = activeIntake(BigInt(chat))!.fileCount;
    const [line] = await burst([photo(), photo()]);
    armWait(chat, 'agent_edit', { draftId: `b-${STAMP}` }, AGENT_WAIT_TTL_MS, nowSec());
    const m = h.mark();
    await h.handle(tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text } }));
    await h.settle();
    expect(h.textsTo(chat, m).some((t) => t.includes('AI sotuvchi so‘ragan javobni yozing'))).toBe(true);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before);
    expect(vi.mocked(saveIntakeFile)).not.toHaveBeenCalled();
    expect(holdingIntake(BigInt(chat))).toBeNull();
  });

  it('c:resume — the reminder’s, the restart’s — takes nothing: the press is his consent to the line that offers', async () => {
    await parked();
    const before = activeIntake(BigInt(chat))!.fileCount;
    await burst([photo(), photo()]);
    await h.handle(tg.callback(chat, 77, 'c:resume'));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before);
    expect(vi.mocked(saveIntakeFile)).not.toHaveBeenCalled();
    expect(readBurst(chat)!.payload.taken).toBe(false);
  });

  it('a typed table answer beside a waiting burst: the pause line invites no reply to the table', async () => {
    await parked();
    updateIntake(BigInt(chat), { stage: 'review', facts: { goods: [{ name: 'Kurtka', quantity: 300 }] } }, { quiet: true });
    // No burst: the table's own way back is named.
    let m = h.mark();
    await h.handle(tg.text(chat, '3500 kg'));
    expect(h.textsTo(chat, m)).toEqual([pauseLine('review', false)]);
    await burst([photo()]);
    m = h.mark();
    await h.handle(tg.text(chat, '3500 kg'));
    expect(h.textsTo(chat, m)).toEqual([pauseLine('review', true)]);
    expect(pauseLine('review', true)).not.toContain('jadvalga reply');
  });
});

describe('a just-landed request is offered at once (§4.3)', () => {
  it('the landing forgets the cached offer list', async () => {
    // A minute's cache that knows no request…
    expect(await addOfferRows(BigInt(chat))).toEqual([]);
    const r = await request();
    expect(await addOfferRows(BigInt(chat)), 'still the cached answer').toEqual([]);
    // …and the landing, whichever sender (the ✅, the sweep's resume), goes through landCollectedIntake.
    startIntake(BigInt(chat), 'rastamojka', { staffId: sellerId });
    vi.mocked(landIntake).mockResolvedValueOnce({ kind: 'deal', id: madeDeals.at(-1)!, label: 'x', leadOwnerId: null, requestId: r.id } as never);
    await landCollectedIntake(BigInt(chat), sellerId, 'Burst');
    // The ✅ ends the collection it landed; nothing then holds the chat.
    endIntake(BigInt(chat));
    expect((await addOfferRows(BigInt(chat))).flat().map((b) => b.callback_data)).toEqual([`cf:${r.id}`]);
  });
});

describe('a burst past its cap stands, and says the rest (review PB-ADV-1)', () => {
  it('25 forwards, no request: ONE message for the first twenty, the five said; 📌 takes the first ten', async () => {
    const parts = Array.from({ length: 25 }, (_, i) => tg.forward(chat, `uzun ${i} ${STAMP}`));
    const said = await burst(parts);
    // Re-anchored (as-built review BURST-2): a message whose only door is 📌
    // never tells him to send the rest again — the draft takes ten, and a
    // resend reaches nobody.
    expect(said.map((c) => c.payload.text)).toEqual([`📌 20 ta xabar — topshiriq qilamizmi?\n${BURST_FULL_TASK(MAX_DRAFT_SOURCES)}`]);
    // Below the newest message, as a reply to the newest PART it holds.
    expect(said[0]!.payload.reply_parameters).toMatchObject({ message_id: msgOf(parts[19]!).message_id });
    const held = readBurst(chat)!.payload;
    expect(held.id).toBe(msgOf(parts[0]!).message_id);
    expect(held.parts).toHaveLength(20);
    expect(held.overflow).toBe(5);
    await h.handle(tg.callback(chat, said[0]!.messageId!, 'fb:task', { message: { text: said[0]!.payload.text, reply_to_message: msgOf(parts[19]!) } }));
    await h.settle();
    expect(activeDraft(BigInt(chat))!.sources.map((x) => x.messageId)).toEqual(parts.slice(0, 10).map((p) => msgOf(p).message_id));
  });

  it('two albums and one more photo beside a request: ONE offer for twenty, the one said; ➕ files all twenty', async () => {
    const r = await request();
    const parts = [
      ...Array.from({ length: 10 }, () => photo({ group: `a1${STAMP}` })),
      ...Array.from({ length: 10 }, () => photo({ group: `a2${STAMP}` })),
      photo(),
    ];
    const said = await burst(parts);
    expect(said.map((c) => c.payload.text)).toEqual([`➕ 20 ta faylni so‘rovga qo‘shamizmi?\n${BURST_FULL(1)}`]);
    await h.handle(tg.callback(chat, said[0]!.messageId!, `cf:${r.id}`, { message: { text: said[0]!.payload.text, reply_to_message: msgOf(parts[19]!) } }));
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(20);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(20);
  });
});

describe('📌 and 🔍 on a burst’s ONE message act on what it counted (review PB-ADV-2)', () => {
  it('3 photos + 2 forwards beside a request: 📌 takes all FIVE, and the answered offer loses its buttons', async () => {
    await request();
    const parts = [photo(), photo(), photo(), tg.forward(chat, `f1 ${STAMP}`), tg.forward(chat, `f2 ${STAMP}`)];
    const [offer] = await burst(parts);
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[4]!) } }));
    await h.settle();
    const draft = activeDraft(BigInt(chat))!;
    expect(draft.sources.map((x) => x.messageId)).toEqual(parts.map((p) => msgOf(p).message_id));
    expect(draft.files).toHaveLength(3);
    const stripped = h.since(m).sent.filter((c) => c.method === 'editMessageReplyMarkup' && Number(c.body.message_id) === offer!.messageId);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]!.body.reply_markup).toBeUndefined();
  });

  it('beside a PARKED collection: 📌 takes every part, and the line becomes the collection’s plain pause line — its ▶️ and ✖️ still act', async () => {
    await parked();
    const parts = [photo(), photo(), tg.forward(chat, `mijoz ${STAMP}`)];
    const [line] = await burst(parts);
    const m = h.mark();
    await h.handle(tg.callback(chat, line!.messageId!, 'fb:task', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    expect(activeDraft(BigInt(chat))!.sources).toHaveLength(3);
    const redrawn = h.since(m).api.filter((c) => c.method === 'editMessageText' && Number(c.payload.message_id) === line!.messageId);
    expect(redrawn).toHaveLength(1);
    expect(redrawn[0]!.payload.text).toBe(pauseLine(activeIntake(BigInt(chat))!.stage, false));
    expect(redrawn[0]!.payload.reply_markup).toEqual(pauseKeyboard());
  });

  it('🔍 takes away only its own button: the ➕ and 📌 rows stay, the burst untaken', async () => {
    const r = await request();
    const parts = [photo(), photo(), tg.forward(chat, `GS777 qayerda ${STAMP}`)];
    const [offer] = await burst(parts);
    expect(data(offer!)).toEqual(['fb:task', 'fb:search', `cf:${r.id}`]);
    const m = h.mark();
    await h.handle(
      tg.callback(chat, offer!.messageId!, 'fb:search', {
        markup: offer!.payload.reply_markup,
        message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) },
      }),
    );
    await h.settle();
    const edit = h.since(m).sent.find((c) => c.method === 'editMessageReplyMarkup' && Number(c.body.message_id) === offer!.messageId);
    const kept = (edit!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data);
    expect(kept).toEqual(['fb:task', `cf:${r.id}`]);
    expect(readBurst(chat)!.payload.taken).toBe(false);
  });
});

describe('a burst is taken once into each kind (review PB-ADV-3)', () => {
  it('➕, the add collection filed, ➕ again: nothing filed twice, and it says so', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo()];
    const [offer] = await burst(parts);
    const press = () => tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } });
    await h.handle(press());
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
    // Its save wrote the request's note under the collection's id — filed.
    const noteId = activeIntake(BigInt(chat))!.noteId;
    await db.insert(crmActivities).values({ id: noteId, entityType: 'deal', entityId: madeDeals.at(-1)!, kind: 'note', note: `burst ${STAMP}`, createdBy: sellerId });
    endIntake(BigInt(chat));
    const m = h.mark();
    await h.handle(press());
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
    expect(activeIntake(BigInt(chat))).toBeNull();
    expect(h.textsTo(chat, m)).toContain(BURST_IN_REQUEST);
  });

  it('…a collection CANCELLED filed nothing: ➕ again takes them afresh', async () => {
    const r = await request();
    const parts = [photo(), photo()];
    const [offer] = await burst(parts);
    const press = () => tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } });
    await h.handle(press());
    await h.settle();
    endIntake(BigInt(chat));
    await h.handle(press());
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(4);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(2);
  });

  it('📌 twice: one draft — the second press says the messages are taken', async () => {
    const parts = [tg.forward(chat, `t1 ${STAMP}`), tg.forward(chat, `t2 ${STAMP}`)];
    const [offer] = await burst(parts);
    const press = () => tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } });
    await h.handle(press());
    await h.settle();
    expect(activeDraft(BigInt(chat))!.sources).toHaveLength(2);
    endDraft(BigInt(chat));
    const m = h.mark();
    await h.handle(press());
    await h.settle();
    expect(activeDraft(BigInt(chat))).toBeNull();
    expect(h.textsTo(chat, m)).toEqual([BURST_IN_TASK]);
  });
});

describe('the take’s other edges (review PB-ADV-4..6, PB-SPEC-1..4, PB-SPEC-7)', () => {
  it('▶️ pressed again once the collection parked anew: it goes on — the stage shown, nothing taken twice (PB-ADV-4)', async () => {
    await parked();
    const parts = [photo(), photo()];
    const [line] = await burst(parts);
    const press = () => tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[1]!) } });
    await h.handle(press());
    await h.settle();
    const files = activeIntake(BigInt(chat))!.fileCount;
    updateIntake(BigInt(chat), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    expect(holdingIntake(BigInt(chat))).toBeNull();
    const m = h.mark();
    await h.handle(press());
    await h.settle();
    expect(holdingIntake(BigInt(chat))).not.toBeNull();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(files);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(2);
    expect(h.since(m).api.some((c) => /Qabul qilindi/u.test(String(c.payload.text ?? '')))).toBe(true);
  });

  it('a draw the album still owes does not speak for parts this press is taking (PB-ADV-5)', async () => {
    await parked();
    const parts = [photo(), photo(), photo()];
    const [line] = await burst(parts);
    // A fourth part, its redraw still owed when ▶️ comes.
    const fourth = photo({ messageId: line!.messageId! + 1 });
    await h.handle(fourth);
    const saved = async () => ({ isPhoto: true, body: Buffer.from(''), attachmentId: randomUUID() });
    let first = true;
    vi.mocked(saveIntakeFile).mockImplementation(async () => {
      // The save is slow: the owed draw fires in the middle of the take.
      if (first) {
        first = false;
        await keptLastSettled();
      }
      return saved();
    });
    try {
      const m = h.mark();
      await h.handle(tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(fourth) } }));
      await h.settle();
      expect(h.textsTo(chat, m).some((t) => t.includes('Hozirgi 4 ta xabar'))).toBe(false);
      expect(activeIntake(BigInt(chat))!.repliedTaken).toEqual(expect.arrayContaining([...parts, fourth].map((p) => msgOf(p).message_id)));
    } finally {
      vi.mocked(saveIntakeFile).mockImplementation(saved);
    }
  });

  it('a forwarded contact card in a ➕ take is its line of material, counted (PB-ADV-6)', async () => {
    const r = await request();
    const parts = [photo(), photo(), tg.contact(chat, '+998901234567', { forwarded: true, userId: 12_345 })];
    const [offer] = await burst(parts);
    expect(offer!.payload.text).toBe('📌 3 ta xabar (2 tasi fayl) — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?');
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.material).toEqual(['👤 Kontakt: Test +998901234567']);
    expect(String(sends(h.since(m).api).at(-1)!.payload.text).startsWith('➕ 2 ta fayl va 1 ta xabar qo‘shildi.\n')).toBe(true);
  });

  it('➕ on a collection at its customer question: the take’s line opens that question, never silent (PB-SPEC-1)', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo()];
    const [offer] = await burst(parts);
    await h.handle(tg.callback(chat, 42_000, `ca:${r.id}`));
    await h.settle();
    updateIntake(BigInt(chat), { stage: 'client' }, { quiet: true });
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(3);
    // ONE customer question, counting what it holds, the take's line on top
    // (§1.5's counting question absorbs PB-SPEC-1's line — the merge, 89b1592).
    const asked = h.textsTo(chat, m).filter((t) => t.includes(CLIENT_QUESTION));
    expect(asked).toEqual([`➕ 3 ta fayl qo‘shildi.\n\nQabul qilindi: 📎 3 ta fayl.\n\n${CLIENT_QUESTION}`]);
  });

  it('▶️ beside a collection holding a «Bo‘ldi» prompt: the old prompt goes — ONE stands (PB-SPEC-2)', async () => {
    await parked();
    const old = activeIntake(BigInt(chat))!.promptMessageId;
    expect(old, 'the collection holds a prompt').not.toBeNull();
    const parts = [photo(), photo(), photo()];
    const [line] = await burst(parts);
    const m = h.mark();
    await h.handle(tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    const deleted = h.since(m).api.filter((c) => c.method === 'deleteMessage').map((c) => Number(c.payload.message_id));
    expect(deleted).toEqual([old]);
    const now = activeIntake(BigInt(chat))!.promptMessageId;
    expect(now).not.toBe(old);
    expect(sends(h.since(m).api).at(-1)!.messageId).toBe(now);
  });

  it('the restart question’s «🗑 Ha» after its burst was replaced: what it could not take is SAID (PB-SPEC-3)', async () => {
    const r = await request();
    const parts = [photo(), photo(), photo()];
    const [offer] = await burst(parts);
    // A collection opened and filled after the offer, then parked.
    await h.handle(tg.text(chat, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chat, 43_000, 'c:rastamojka'));
    await h.handle(tg.text(chat, 'GS777'));
    await h.handle(tg.text(chat, 'Kurtka 300 dona'));
    updateIntake(BigInt(chat), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    let m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    const question = sends(h.since(m).api).find((c) => String(c.payload.text).includes('tugallanmagan yig‘ish'));
    expect(question, 'the question was asked').toBeDefined();
    // Another photo beside the parked collection: a NEW burst takes the row.
    await burst([photo({ messageId: question!.messageId! + 1 })]);
    expect(readBurst(chat)!.payload.id).not.toBe(msgOf(parts[0]!).message_id);
    m = h.mark();
    await h.handle(tg.callback(chat, question!.messageId!, `cg:${r.id}`, { message: { text: question!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.amend?.requestId).toBe(r.id);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(1);
    expect(h.textsTo(chat, m)).toContain(BURST_GONE);
  });

  it('a typed table answer beside a waiting burst: its line is the burst’s too — its ▶️ takes the parts (PB-SPEC-4)', async () => {
    await parked();
    updateIntake(BigInt(chat), { stage: 'review', facts: { goods: [{ name: 'Kurtka', quantity: 300 }] } }, { quiet: true });
    const before = activeIntake(BigInt(chat))!.fileCount;
    await burst([photo(), photo()]);
    const m = h.mark();
    await h.handle(tg.text(chat, '3500 kg'));
    const [orphan] = sends(h.since(m).api);
    expect(orphan!.payload.text).toBe(pauseLine('review', true));
    expect(data(orphan!)).toEqual(['c:resume_take', 'c:cancel']);
    await h.handle(tg.callback(chat, orphan!.messageId!, 'c:resume_take', { message: { text: orphan!.payload.text } }));
    await h.settle();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before + 2);
  });

  it('a redelivered ➕ after every part was taken and before its prompt: ONE «Bo‘ldi» prompt, nothing taken again (PB-SPEC-7)', async () => {
    const r = await request();
    const parts = [photo(), photo()];
    const [offer] = await burst(parts);
    // The stop's state: the add collection open, every part taken in its own
    // patch, the prompt never sent.
    await h.handle(tg.callback(chat, 44_000, `ca:${r.id}`));
    await h.settle();
    updateIntake(
      BigInt(chat),
      { stage: 'material', fileCount: 2, repliedTaken: parts.map((p) => msgOf(p).message_id), promptMessageId: null },
      { quiet: true },
    );
    const m = h.mark();
    await h.handle(tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    await h.settle();
    expect(vi.mocked(saveIntakeFile)).not.toHaveBeenCalled();
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(2);
    const prompts = h.since(m).api.filter((c) => /Qabul qilindi[^]*«Bo‘ldi»/u.test(String(c.payload.text ?? '')));
    expect(prompts).toHaveLength(1);
  });
});


/** A forwarded voice note — a burst part no take can read. */
function voiceForward(): Update {
  const u = tg.forward(chat, 'x');
  const m = msgOf(u) as Record<string, unknown>;
  delete m.text;
  m.voice = { file_id: `VOICE${Math.random()}`, file_unique_id: `uv${Math.random()}`, duration: 3, mime_type: 'audio/ogg', file_size: 100 };
  return u;
}

describe('the as-built review’s burst fixes (BURST-2..8, DURABILITY-2, CHAT-7)', () => {
  it('BURST-2: 📌 on a full burst, then the five resent — the cap line once, never «📎 Qabul qilindi» for a part that went nowhere', async () => {
    const parts = Array.from({ length: 25 }, (_, i) => tg.forward(chat, `uzun ${i} ${STAMP}`));
    const [offer] = await burst(parts);
    await h.handle(tg.callback(chat, offer!.messageId!, 'fb:task', { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[19]!) } }));
    await h.settle();
    const m = h.mark();
    for (let i = 20; i < 25; i++) await h.handle(tg.forward(chat, `uzun ${i} ${STAMP} qayta`));
    await h.settle();
    const said = h.textsTo(chat, m);
    expect(said).toEqual([`⚠ Bitta topshiriqqa ko‘pi bilan ${MAX_DRAFT_SOURCES} ta xabar qo‘shiladi — qolganlari hodimga yuborilmaydi.`]);
    expect(said.some((t) => t.includes('Qabul qilindi'))).toBe(false);
    expect(activeDraft(BigInt(chat))!.sources).toHaveLength(MAX_DRAFT_SOURCES);
    endDraft(BigInt(chat));
  });

  it('BURST-2: a full burst beside a request keeps «qaytadan yuboring» — its ➕ takes the resend', async () => {
    await request();
    const parts = Array.from({ length: 21 }, () => tg.forward(chat, `f ${STAMP}`));
    const said = await burst(parts);
    expect(said.map((c) => c.payload.text)).toEqual([`📌 20 ta xabar — topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?\n${BURST_FULL(1)}`]);
  });

  it('BURST-3: ▶️ on the orphan pause line after its burst was replaced — nothing taken, and SAID', async () => {
    await parked();
    updateIntake(BigInt(chat), { stage: 'review', facts: { goods: [{ name: 'Kurtka', quantity: 300 }] } }, { quiet: true });
    const before = activeIntake(BigInt(chat))!.fileCount;
    await burst([photo(), photo()]);
    let m = h.mark();
    await h.handle(tg.text(chat, '3500 kg'));
    const [orphan] = sends(h.since(m).api);
    await burst([photo()]);
    expect(readBurst(chat)!.payload.previous?.ids).toContain(orphan!.messageId);
    m = h.mark();
    await h.handle(tg.callback(chat, orphan!.messageId!, 'c:resume_take', { message: { text: orphan!.payload.text } }));
    await h.settle();
    expect(h.textsTo(chat, m)).toContain(BURST_NONE_TAKEN);
    expect(activeIntake(BigInt(chat))!.fileCount).toBe(before);
  });

  it('BURST-4: after ▶️ took the parts, the pause line says so — its keyboard kept', async () => {
    await parked();
    const parts = [photo(), photo(), photo()];
    const [line] = await burst(parts);
    const m = h.mark();
    await h.handle(tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[2]!) } }));
    await h.settle();
    const edits = h.since(m).api.filter((c) => c.method === 'editMessageText' && Number(c.payload.message_id) === line!.messageId);
    expect(edits.map((c) => c.payload.text)).toEqual(['▶️ Davom etamiz — 3 ta fayl qo‘shildi.']);
    expect(edits[0]!.payload.reply_markup).toEqual(pauseKeyboard({ forwards: false }));
  });

  it('BURST-5: ➕ pressed twice — the «davom eting» line is the collection’s, and the ONE prompt moves below it', async () => {
    const r = await request();
    const parts = [photo(), photo()];
    const [offer] = await burst(parts);
    const press = () => tg.callback(chat, offer!.messageId!, `cf:${r.id}`, { message: { text: offer!.payload.text, reply_to_message: msgOf(parts[1]!) } });
    await h.handle(press());
    await h.settle();
    const prompt = activeIntake(BigInt(chat))!.promptMessageId;
    const m = h.mark();
    await h.handle(press());
    await h.settle();
    const out = sends(h.since(m).api);
    expect(out[0]!.payload.text).toBe('Shu so‘rovga qo‘shimcha yig‘ilmoqda — davom eting.');
    // The prompt is the chat's LAST message: sent below the line, the old copy deleted.
    expect(String(out.at(-1)!.payload.text)).toContain('Qabul qilindi');
    expect(activeIntake(BigInt(chat))!.promptMessageId).toBe(out.at(-1)!.messageId);
    expect(h.since(m).api.filter((c) => c.method === 'deleteMessage').map((c) => Number(c.payload.message_id))).toContain(prompt);
  });

  it('BURST-7: ▶️ that took nothing readable says «Davom etamiz.» on the prompt — even when a file right after coalesces the draw', async () => {
    await parked();
    const parts = [voiceForward(), voiceForward()];
    const [line] = await burst(parts);
    const m = h.mark();
    await h.handle(tg.callback(chat, line!.messageId!, 'c:resume_take', { message: { text: line!.payload.text, reply_to_message: msgOf(parts[1]!) } }));
    await h.handle(photo({ messageId: 990_000 + Math.floor(Math.random() * 1000) }));
    await h.settle();
    const prompts = sends(h.since(m).api).filter((c) => String(c.payload.text).includes('Qabul qilindi'));
    expect(prompts.at(-1)!.payload.text).toMatch(/^▶️ Davom etamiz\.\n/u);
  });

  it('BURST-8 / DURABILITY-2: a process killed inside the debounce — the owed message is drawn at the next boot, once', async () => {
    await request();
    setDurableWaits(true);
    try {
      const m = h.mark();
      for (const p of [photo(), photo(), photo()]) await h.handle(p);
      await flushWaitWrites();
      // The process dies here: its owed draws and its memory go with it.
      __forgetKeptLast();
      __forgetWaitMemory();
      expect(await hydrateWaits()).toBeGreaterThan(0);
      expect(drawOwedBursts(h.bot.api)).toBe(1);
      await h.settle();
      expect(sends(h.since(m).api).map((c) => c.payload.text)).toEqual(['➕ 3 ta faylni so‘rovga qo‘shamizmi?']);
      expect(readBurst(chat)!.payload.offerIds).toHaveLength(1);
      // Drawn: nothing is owed any more.
      expect(drawOwedBursts(h.bot.api)).toBe(0);
    } finally {
      setDurableWaits(false);
    }
  });

  it('BURST-8: a burst past its window is not asked about at boot', async () => {
    await request();
    for (const p of [photo(), photo()]) await h.handle(p);
    __forgetKeptLast();
    expect(readBurst(chat)!.payload.offerIds).toEqual([]);
    // Booted three minutes later: the row's two minutes have run out.
    const m = h.mark();
    expect(drawOwedBursts(h.bot.api, nowSec() + 180)).toBe(0);
    await h.settle();
    expect(sends(h.since(m).api)).toEqual([]);
  });

  it('CHAT-7: a file whose save fails — its refusal, then the ONE prompt below it', async () => {
    await h.handle(tg.text(chat, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chat, 45_000, 'c:rastamojka'));
    await h.handle(tg.text(chat, 'GS777'));
    await h.handle(tg.text(chat, 'Kurtka 300 dona'));
    await h.settle();
    const prompt = activeIntake(BigInt(chat))!.promptMessageId;
    vi.mocked(saveIntakeFile).mockRejectedValueOnce(new Error('getFile 400'));
    const m = h.mark();
    await h.handle(photo({ messageId: 995_000 + Math.floor(Math.random() * 1000) }));
    await h.settle();
    const out = sends(h.since(m).api).map((c) => String(c.payload.text));
    expect(out[0]).toBe('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
    expect(out.at(-1)).toContain('Qabul qilindi');
    expect(activeIntake(BigInt(chat))!.promptMessageId).not.toBe(prompt);
  });
});
