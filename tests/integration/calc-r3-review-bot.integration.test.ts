import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The merged round's review, its bot half (ship's review-verified.json) —
 * every case through the SAME handler chain the server runs (bot-harness),
 * the collector's table-answer path real (COMP-1: the case no package could
 * write alone), the durable store on, and a crash a forgotten memory plus a
 * later boot (the redelivery cases).
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

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcAmendments,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  leads,
  leadStages,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import {
  __forgetIntakeMemory,
  activeIntake,
  endIntake,
  flushIntakeWrites,
  HOLD_MS,
  holdingIntake,
  hydrateIntakes,
  markIntakesHydrated,
  setDurableIntakes,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __resetDrafts, activeDraft } from '@/modules/platform/telegram/task-draft';
import { TOPSHIRIQ } from '@/modules/platform/telegram/staff-bot';
import { armWait, dropWait, nowSec } from '@/modules/platform/telegram/waits';
import { AGENT_WAIT_TTL_MS } from '@/modules/platform/telegram/agent-bot';
import { ADD_REFUSAL, JOB_CALC_AMEND_SAVE, __resetAddOffers, runAmendSave, type AmendSaveJob } from '@/modules/platform/telegram/calc-amend';
import { PAUSE_LINE } from '@/modules/platform/telegram/calc-dialog';
import { readingAlive } from '@/modules/platform/telegram/calc-read';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-6);
let h: BotHarness;
let sellerA = '';
let sellerB = '';
/** Seller A sends requests; seller B has none, so no «➕» offer stands in for what is asserted. */
let chatA = 0;
let chatB = 0;
let clientId = '';
let stageId = '';
let leadStageId = '';
const madeDeals: string[] = [];
const madeLeads: string[] = [];
const madeRequests: string[] = [];
let seq = 50_000;

const RESUME_BUSY = 'Avval topshiriqni (zametkani) tugating yoki bekor qiling — keyin «▶️ Davom etamiz».';

/** send.ts's transport, stood in here: getFile answered, one sendMessage carrying `hang.needle` held for ever. */
const hang = { on: false, chat: 0, needle: '', reached: false };
let msgSeq = 980_000;
function installTransport(): void {
  __setTelegramTransport(async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === 'getFile') {
      const fileId = String(body.file_id);
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: fileId, file_unique_id: fileId, file_path: `served/${encodeURIComponent(fileId)}` } }),
        { status: 200 },
      );
    }
    if (hang.on && method === 'sendMessage' && Number(body.chat_id) === hang.chat && String(body.text ?? '').includes(hang.needle)) {
      hang.on = false;
      hang.reached = true;
      await new Promise<never>(() => {});
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: (msgSeq += 1), date: nowSec(), chat: { id: Number(body.chat_id ?? 0) } } }),
      { status: 200 },
    );
  });
}

async function staffMember(phoneTail: string, name: string): Promise<{ id: string; chat: number }> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+9989${phoneTail}${STAMP}`, fullName: `${name} ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  const role = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
  const chat = Number(`9${phoneTail}${STAMP}`);
  await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  return { id: u!.id, chat };
}

beforeAll(async () => {
  ({ id: sellerA, chat: chatA } = await staffMember('71', 'R3 bot A'));
  ({ id: sellerB, chat: chatB } = await staffMember('72', 'R3 bot B'));
  const [client] = await db.insert(clients).values({ clientCode: `RB${STAMP}`, name: `R3 bot mijoz ${STAMP}` }).returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  leadStageId = (await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') }))!.id;
  setDurableIntakes(true);
  h = botHarness();
  installTransport();
  // grammy's own calls (ctx.reply) held the same way.
  h.bot.api.config.use(async (prev, method, payload, signal) => {
    const body = (payload ?? {}) as Record<string, unknown>;
    if (hang.on && method === 'sendMessage' && Number(body.chat_id) === hang.chat && String(body.text ?? '').includes(hang.needle)) {
      hang.on = false;
      hang.reached = true;
      await new Promise<never>(() => {});
    }
    return prev(method, payload, signal);
  });
});

beforeEach(() => {
  __forgetIntakeMemory();
  __resetLifecycle();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
  __resetAddOffers();
  markBoot(new Date(Date.now() - 60_000));
  markIntakesHydrated();
  hang.on = false;
  hang.needle = '';
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  setDurableIntakes(false);
  for (const chat of [chatA, chatB]) {
    endIntake(BigInt(chat));
    dropWait(chat, 'agent_edit');
  }
  __resetDrafts();
  await flushIntakeWrites();
  h.restore();
  await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id IN (${String(chatA)}::bigint, ${String(chatB)}::bigint)`);
  await db.delete(notifications).where(inArray(notifications.userId, [sellerA, sellerB]));
  if (madeRequests.length) {
    await db.delete(calcAmendments).where(inArray(calcAmendments.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  }
  if (madeDeals.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  if (madeLeads.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
  await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, [sellerA, sellerB]));
  // DEACTIVATED, not deleted: audit_log points at them (round 107's rule).
  await db.update(users).set({ active: false }).where(inArray(users.id, [sellerA, sellerB]));
  await pgClient.end();
});

/** Seller A's landed request, and the AI answer under it that carries ➕ (its message id). */
async function answered(
  section: 'rastamojka' | 'yolkira' | 'podklyuch' = 'rastamojka',
  opts: { on?: 'deal' | 'lead' } = {},
): Promise<{ requestId: string; answerId: number }> {
  let entity: { entityType: 'deal' | 'lead'; entityId: string };
  if (opts.on === 'lead') {
    const [lead] = await db.insert(leads).values({ name: `R3 lid ${STAMP}`, stageId: leadStageId, ownerId: sellerA }).returning();
    madeLeads.push(lead!.id);
    entity = { entityType: 'lead', entityId: lead!.id };
  } else {
    const [deal] = await db
      .insert(deals)
      .values({ code: `RB-${STAMP}-${madeDeals.length}`, clientId, stageId, title: 'R3 bot', createdBy: sellerA })
      .returning();
    madeDeals.push(deal!.id);
    entity = { entityType: 'deal', entityId: deal!.id };
  }
  const r = await openCalcRequest(
    {
      intakeDoor: null,
      ...entity,
      section,
      fromCity: section === 'rastamojka' ? null : 'Yiwu',
      toCity: section === 'rastamojka' ? null : 'Toshkent',
      weightKg: section === 'rastamojka' ? null : 300,
      volumeM3: section === 'rastamojka' ? null : 2,
      items: [{ name: 'Sumka', quantity: 10 }, { name: 'Krossovka', quantity: 20 }],
      source: 'card',
    },
    { actorId: sellerA },
  );
  madeRequests.push(r.id);
  const answerId = (seq += 1);
  await db.insert(notifications).values({
    userId: sellerA,
    channel: 'telegram',
    type: 'CalcPrefilled',
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', add: true, requestId: r.id, tg: { chatId: String(chatA), messageId: answerId } },
  });
  return { requestId: r.id, answerId };
}

async function returned(requestId: string): Promise<void> {
  await db
    .update(calcRequests)
    .set({ completedAt: new Date(), completedVia: 'returned', returnReason: 'kod yo‘q' })
    .where(eq(calcRequests.id, requestId));
}

/** A process that died: memory, presses and lifecycle gone, a later boot, the table restored. */
async function crashAndRestart(): Promise<void> {
  __forgetIntakeMemory();
  __resetLifecycle();
  __resetPresses();
  __resetBacklog();
  markBoot(new Date(Date.now() + 2_000));
  await hydrateIntakes();
  markIntakesHydrated();
}

const answersOf = (chat: number) =>
  (activeIntake(BigInt(chat))?.lineAnswers ?? []).map((e) => [e.name, e.patch.quantity ?? null]);

/** A collection opened on seller B's chat — «🧮» → «🛃» on message `openedBy` → a customer → a line — then parked. */
async function parkedB(openedBy: number): Promise<void> {
  await h.handle(tg.text(chatB, '🧮 Hisoblatish'));
  await h.handle(tg.callback(chatB, openedBy, 'c:rastamojka'));
  await h.handle(tg.text(chatB, 'GS777'));
  await h.handle(tg.text(chatB, 'Kurtka 300 dona'));
  updateIntake(BigInt(chatB), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
  expect(activeIntake(BigInt(chatB))).not.toBeNull();
  expect(holdingIntake(BigInt(chatB))).toBeNull();
}

describe('replies to ONE ➕ answer are the add table’s answers, by row (review PF-1, COMP-1)', () => {
  it('two replies → two rows written; «✅ Qo‘shish» → the job applies both', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.text(chatA, '1: 50 dona', { replyTo: answerId }));
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    await h.settle();
    expect(answersOf(chatA)).toEqual([
      ['Sumka', 50],
      ['Krossovka', 40],
    ]);
    const live = activeIntake(BigInt(chatA))!;
    expect(live.amend?.requestId).toBe(requestId);
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:save'));
    const job = vi.mocked(enqueue).mock.calls.find((c) => c[0] === JOB_CALC_AMEND_SAVE)?.[1] as AmendSaveJob | undefined;
    expect(job, 'the save went to its job').toBeDefined();
    await runAmendSave(job!, 0);
    const [amendment] = await db.select().from(calcAmendments).where(eq(calcAmendments.noteId, live.noteId));
    expect(amendment!.outcome).toBe('applied');
    const rows = await db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);
    expect(rows.map((r) => Number(r.quantity))).toEqual([50, 40]);
  });

  it('«➕» pressed under the answer, then a reply to it → written (the press’s message is not a drawn one)', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    expect(activeIntake(BigInt(chatA))!.amend?.requestId).toBe(requestId);
    const m = h.mark();
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    await h.settle();
    expect(answersOf(chatA)).toEqual([['Krossovka', 40]]);
    expect(h.textsTo(chatA, m).some((t) => t.includes('Qaysi qatorga?'))).toBe(false);
  });
});

describe('the reply that opened the add door, redelivered after a crash (review dur-1)', () => {
  // Dated not before the opening's second, the redelivery is the open
  // collection's to take (`intakeTakes` rule 2 is strict) — the branch the
  // ➕ answer met «Qaysi qatorga?» on (PF-1); dated earlier, it passes to the
  // reply door, which resumes the same collection.
  for (const [label, shift] of [
    // A few seconds ahead, so a second boundary crossed while the door
    // opens can never put the opening after it (the strict rule's flake).
    ['dated in the opening second', 5],
    ['dated seconds before it opened', -2],
  ] as const) {
    it(`${label}: the table’s send held, a flush, a restart → the answer is written ONCE`, async () => {
      const { requestId, answerId } = await answered();
      const U = tg.text(chatA, '2: 40 dona', { replyTo: answerId, date: nowSec() + shift });
      hang.chat = chatA;
      hang.needle = 'Qo‘shimcha';
      hang.on = true;
      hang.reached = false;
      void h.handle(U).catch(() => {});
      await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
      const mid = activeIntake(BigInt(chatA))!;
      expect(mid.amend?.requestId).toBe(requestId);
      // The opening took nothing: only the answer's own write takes the message.
      expect(mid.takenUpTo).toBe(0);
      expect(await flushIntakeWrites()).toBe(true);
      await crashAndRestart();
      await h.handle(tg.again(U));
      await h.settle();
      expect(answersOf(chatA)).toEqual([['Krossovka', 40]]);
      // …and a second redelivery is `seen`.
      await h.handle(tg.again(U));
      await h.settle();
      expect(answersOf(chatA)).toEqual([['Krossovka', 40]]);
    });
  }
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

function fileMessage(chat: number, fileId: string, name = 'a.pdf') {
  return {
    message_id: (seq += 1),
    date: nowSec() - 30,
    chat: { id: chat, type: 'private' },
    from: { id: chat, is_bot: false, first_name: 'T' },
    document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: name, mime_type: 'application/pdf', file_size: PDF.length },
  };
}

describe('«➕ … so‘roviga qo‘shish» under a plain file, redelivered (review dur-2)', () => {
  it('the file’s words held, a flush, a restart, the press again → ONE file, once in `pdfs`', async () => {
    const { requestId } = await answered();
    const fileId = `r3pdf-${STAMP}-b`;
    h.serveFile(fileId, PDF);
    const original = fileMessage(chatA, fileId);
    const press = tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: original } });
    hang.chat = chatA;
    hang.needle = 'AI o‘qiydi';
    hang.on = true;
    hang.reached = false;
    void h.handle(press).catch(() => {});
    await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
    expect(activeIntake(BigInt(chatA))!.repliedTaken).toContain(original.message_id);
    expect(await flushIntakeWrites()).toBe(true);
    await crashAndRestart();
    hang.needle = '';
    await h.handle(tg.again(press));
    await h.settle();
    const after = activeIntake(BigInt(chatA))!;
    expect(after.fileCount).toBe(1);
    expect(after.pdfs).toHaveLength(1);
    // The taken file is unread: the collection waits for «Bo‘ldi», never under the stored table's «✅ Qo‘shish».
    expect(after.stage).toBe('material');
  });
});

describe('«✅ Bo‘ldi» whose press died with the old process (review dur-3)', () => {
  it('the redelivered press takes the reading over at once; the sweep finds the old token dead', async () => {
    const c = BigInt(chatB);
    await h.handle(tg.text(chatB, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chatB, (seq += 1), 'c:rastamojka'));
    await h.handle(tg.text(chatB, 'GS777'));
    const m0 = h.mark();
    await h.handle(tg.text(chatB, 'Kurtka 300 dona'));
    const prompt =
      h.since(m0).api.filter((x) => x.method === 'sendMessage' && JSON.stringify(x.payload.reply_markup ?? '').includes('c:done')).at(-1)
        ?.messageId ?? activeIntake(c)!.promptMessageId!;
    hang.chat = chatB;
    hang.needle = 'AI o‘qiyapti';
    hang.on = true;
    hang.reached = false;
    const press = tg.callback(chatB, prompt, 'c:done');
    void h.handle(press).catch(() => {});
    await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
    const old = activeIntake(c)!.analysing;
    expect(old).not.toBeNull();
    expect(await flushIntakeWrites()).toBe(true);
    await crashAndRestart();
    const hydrated = activeIntake(c)!;
    expect(hydrated.analysing).toBe(old);
    expect(await readingAlive(hydrated)).toBe(false);
    hang.needle = '';
    const m = h.mark();
    await h.handle(tg.again(press));
    await h.settle();
    expect(h.textsTo(chatB, m)).not.toContain('⏳ Tahlil davom etmoqda — natijani kuting.');
    expect(activeIntake(c)!.analysing).not.toBe(old);
    endIntake(c);
  });
});

describe('a PARKED collection beside another collector (review REG-2, COMP-5)', () => {
  it('a task draft live: its buttons refuse in words, write nothing; the draft keeps its next line', async () => {
    await parkedB(4242);
    const before = activeIntake(BigInt(chatB))!.material.length;
    await h.handle(tg.text(chatB, TOPSHIRIQ));
    expect(activeDraft(BigInt(chatB))).not.toBeNull();
    const m = h.mark();
    await h.handle(tg.callback(chatB, 4242, 'c:more'));
    expect(h.textsTo(chatB, m)).toContain(RESUME_BUSY);
    expect(holdingIntake(BigInt(chatB)), 'still parked').toBeNull();
    await h.handle(tg.text(chatB, 'Logist Demo'));
    await h.settle();
    expect(activeIntake(BigInt(chatB))!.material.length).toBe(before);
    expect(activeDraft(BigInt(chatB))).not.toBeNull();
    __resetDrafts();
  });

  it('a reply to the parked table while the draft is live is refused too, never filed', async () => {
    await parkedB(4343);
    const own = activeIntake(BigInt(chatB))!.promptMessageId!;
    const before = activeIntake(BigInt(chatB))!.material.length;
    await h.handle(tg.text(chatB, TOPSHIRIQ));
    const m = h.mark();
    await h.handle(tg.text(chatB, 'Shim 20 dona', { replyTo: own }));
    expect(h.textsTo(chatB, m)).toContain(RESUME_BUSY);
    expect(activeIntake(BigInt(chatB))!.material.length).toBe(before);
    expect(holdingIntake(BigInt(chatB))).toBeNull();
    __resetDrafts();
  });

  it('an AI sotuvchi ✏️ wait armed: «▶️ Davom etamiz» refuses, the collection stays parked', async () => {
    await parkedB(4444);
    armWait(chatB, 'agent_edit', { draftId: `r3-${STAMP}` }, AGENT_WAIT_TTL_MS, nowSec());
    const m = h.mark();
    await h.handle(tg.callback(chatB, 4444, 'c:resume'));
    expect(h.textsTo(chatB, m).some((t) => t.includes('AI sotuvchi so‘ragan javobni yozing'))).toBe(true);
    expect(holdingIntake(BigInt(chatB))).toBeNull();
    dropWait(chatB, 'agent_edit');
  });
});

describe('a file into a PARKED collection is told so (review PF-2)', () => {
  it('the pause line, as a reply to the file; nothing filed', async () => {
    await parkedB(4545);
    const before = activeIntake(BigInt(chatB))!.fileCount;
    const photo = tg.photo(chatB);
    const photoId = (photo as unknown as { message: { message_id: number } }).message.message_id;
    const m = h.mark();
    await h.handle(photo);
    await h.settle();
    const said = h.since(m).api.filter((x) => x.method === 'sendMessage' && x.payload.text === PAUSE_LINE);
    expect(said).toHaveLength(1);
    expect((said[0]!.payload.reply_parameters as { message_id: number }).message_id).toBe(photoId);
    expect(activeIntake(BigInt(chatB))!.fileCount).toBe(before);
  });
});

describe('the «another collection» question about an offered file carries it (review PF-3)', () => {
  it('cf: under a file → the question replies to the file → «🗑 Ha» takes it into the add collection', async () => {
    const { requestId } = await answered();
    // An older collection with something in it, parked: the question is asked.
    await h.handle(tg.text(chatA, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chatA, (seq += 1), 'c:rastamojka'));
    await h.handle(tg.text(chatA, 'GS777'));
    await h.handle(tg.text(chatA, 'Shim 20 dona'));
    updateIntake(BigInt(chatA), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    const fileId = `r3pdf-${STAMP}-c`;
    h.serveFile(fileId, PDF);
    const original = fileMessage(chatA, fileId, 'packing.pdf');
    const m = h.mark();
    await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: original } }));
    const question = h.since(m).api.find((x) => x.method === 'sendMessage' && String(x.payload.text).includes('tugallanmagan yig‘ish'));
    expect(question, 'the question was asked').toBeDefined();
    expect((question!.payload.reply_parameters as { message_id: number }).message_id).toBe(original.message_id);
    await h.handle(tg.callback(chatA, question!.messageId!, `cg:${requestId}`, { message: { reply_to_message: original } }));
    await h.settle();
    const live = activeIntake(BigInt(chatA))!;
    expect(live.amend?.requestId).toBe(requestId);
    expect(live.fileCount).toBe(1);
    expect(live.repliedTaken).toContain(original.message_id);
  });
});

describe('a RETURNED request’s seeded collection is its own (review COMP-3)', () => {
  it('a second ➕ resumes it, never the wipe question; a reply to the old answer writes nothing', async () => {
    const { requestId, answerId } = await answered();
    await returned(requestId);
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const seeded = activeIntake(BigInt(chatA))!;
    expect(seeded.amend).toBeNull();
    expect(seeded.seededFrom).toBe(requestId);
    const m = h.mark();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const said = h.textsTo(chatA, m);
    expect(said).toContain(ADD_REFUSAL.sameLive);
    expect(said.some((t) => t.includes('Yuborilgan hamma narsa o‘chadi'))).toBe(false);
    expect(activeIntake(BigInt(chatA))!.noteId).toBe(seeded.noteId);
    const m2 = h.mark();
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    expect(h.textsTo(chatA, m2)).toContain(ADD_REFUSAL.seededReply);
    expect(activeIntake(BigInt(chatA))!.lineAnswers).toEqual([]);
  });
});

describe('a seeded table says nothing about a reading it never had (review PF-7)', () => {
  it('yo‘lkira: no «AI ulanmagan», no certificate line or button', async () => {
    const { requestId, answerId } = await answered('yolkira');
    await returned(requestId);
    const m = h.mark();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const table = h.since(m).api.find((x) => x.method === 'sendMessage' && String(x.payload.text).includes('Tovarlar ('));
    expect(table, 'the seeded table').toBeDefined();
    expect(String(table!.payload.text)).not.toContain('AI ulanmagan');
    expect(String(table!.payload.text)).not.toContain('Sertifikat');
    expect(JSON.stringify(table!.payload.reply_markup)).not.toContain('c:cert_');
  });

  it('rastamojka: no «AI ulanmagan», the certificate kept', async () => {
    const { requestId, answerId } = await answered('rastamojka');
    await returned(requestId);
    const m = h.mark();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const table = h.since(m).api.find((x) => x.method === 'sendMessage' && String(x.payload.text).includes('Tovarlar ('));
    expect(String(table!.payload.text)).not.toContain('AI ulanmagan');
    expect(String(table!.payload.text)).toContain('Sertifikat');
  });
});

describe('a collection carrying rows reaches its table, never a loop of refusals (review PF-8)', () => {
  it('an add collection: «➕ Yana ma’lumot», nothing sent, «Bo‘ldi» → its table again', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const live = activeIntake(BigInt(chatA))!;
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:more'));
    const m = h.mark();
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:done'));
    const said = h.textsTo(chatA, m);
    expect(said).not.toContain('Hali hech narsa yuborilmadi.');
    expect(said.some((t) => t.startsWith('➕ Qo‘shimcha'))).toBe(true);
    expect(activeIntake(BigInt(chatA))!.stage).toBe('review');
  });

  it('a seeded collection with no customer: the customer named → its table, not «send the goods»', async () => {
    const { requestId, answerId } = await answered('rastamojka', { on: 'lead' });
    await returned(requestId);
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    expect(activeIntake(BigInt(chatA))!.stage).toBe('client');
    const m = h.mark();
    await h.handle(tg.text(chatA, 'Ali aka'));
    const said = h.textsTo(chatA, m);
    expect(said.some((t) => t.includes('Tovarlar (2)'))).toBe(true);
    expect(activeIntake(BigInt(chatA))!.stage).toBe('review');
  });
});
