import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fix review of the merged review's fixes, its bot half (fixrev's
 * confirmed.json) — every case through the SAME handler chain the server
 * runs (bot-harness), the durable store on, and a crash a forgotten memory
 * plus a later boot. The review's own pins stay in
 * calc-r3-review-bot.integration.test.ts; these are what its fixes missed.
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
  intakeIsEmpty,
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
import { AGENT_WAIT_TTL_MS, waitingAnswerWords } from '@/modules/platform/telegram/agent-bot';
import { noteReplyPending } from '@/modules/platform/telegram/staff-bot';
import { ADD_REFUSAL, JOB_CALC_AMEND_SAVE, REPLIED_TAKEN_KEPT, __resetAddOffers } from '@/modules/platform/telegram/calc-amend';
import { BURST_GONE } from '@/modules/platform/telegram/burst-wait';
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
let seq = 60_000;

const RESUME_BUSY = 'Avval topshiriqni (zametkani) tugating yoki bekor qiling — keyin «▶️ Davom etamiz».';

/** send.ts's transport, stood in here: getFile answered, one sendMessage carrying `hang.needle` held for ever. */
const hang = { on: false, chat: 0, needle: '', reached: false };
let msgSeq = 990_000;
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
    if (method === 'sendMessage') sentTexts.push({ chat: Number(body.chat_id ?? 0), text: String(body.text ?? '') });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: (msgSeq += 1), date: nowSec(), chat: { id: Number(body.chat_id ?? 0) } } }),
      { status: 200 },
    );
  });
}

/** What send.ts sent by chat id (the add door's and the sweep's own words) — grammy's replies are the harness's. */
const sentTexts: { chat: number; text: string }[] = [];
const mark = () => ({ m: h.mark(), s: sentTexts.length });
/** Every text a chat was told since `k`: grammy's replies and send.ts's sends. */
const saidTo = (chat: number, k: ReturnType<typeof mark>) => [
  ...h.textsTo(chat, k.m),
  ...sentTexts.slice(k.s).filter((x) => x.chat === chat).map((x) => x.text),
];

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
  ({ id: sellerA, chat: chatA } = await staffMember('75', 'R3 fixrev A'));
  ({ id: sellerB, chat: chatB } = await staffMember('76', 'R3 fixrev B'));
  const [client] = await db.insert(clients).values({ clientCode: `RF${STAMP}`, name: `R3 fixrev mijoz ${STAMP}` }).returning();
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
    const [lead] = await db.insert(leads).values({ name: `R3 fixrev lid ${STAMP}`, stageId: leadStageId, ownerId: sellerA }).returning();
    madeLeads.push(lead!.id);
    entity = { entityType: 'lead', entityId: lead!.id };
  } else {
    const [deal] = await db
      .insert(deals)
      .values({ code: `RF-${STAMP}-${madeDeals.length}`, clientId, stageId, title: 'R3 fixrev', createdBy: sellerA })
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


const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

function fileMessage(chat: number, fileId: string, name = 'a.pdf', extra: Record<string, unknown> = {}) {
  return {
    message_id: (seq += 1),
    date: nowSec() - 30,
    chat: { id: chat, type: 'private' },
    from: { id: chat, is_bot: false, first_name: 'T' },
    document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: name, mime_type: 'application/pdf', file_size: PDF.length },
    ...extra,
  };
}

/** Seller A's add collection on a fresh request, opened by «➕» under its answer, then parked. */
async function parkedAdd(): Promise<{ requestId: string; answerId: number }> {
  const out = await answered();
  await h.handle(tg.callback(chatA, out.answerId, `ca:${out.requestId}`));
  expect(activeIntake(BigInt(chatA))!.amend?.requestId).toBe(out.requestId);
  updateIntake(BigInt(chatA), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
  expect(holdingIntake(BigInt(chatA))).toBeNull();
  return out;
}

const BUSY_AGENT_PART = 'AI sotuvchi so‘ragan javobni yozing';

describe('the add door beside a one-text wait (fix review FR-1)', () => {
  it('a reply to the ➕ answer of a PARKED add collection: refused BEFORE anything is said or written; the wait keeps its text', async () => {
    const { answerId } = await parkedAdd();
    armWait(chatA, 'agent_edit', { draftId: `rf-${STAMP}-1` }, AGENT_WAIT_TTL_MS, nowSec());
    try {
      const m = mark();
      await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
      await h.settle();
      const said = saidTo(chatA, m);
      expect(said.some((t) => t.includes(BUSY_AGENT_PART))).toBe(true);
      expect(said).not.toContain(ADD_REFUSAL.sameLive);
      expect(said.some((t) => t.includes('yozildi'))).toBe(false);
      expect(answersOf(chatA)).toEqual([]);
      expect(holdingIntake(BigInt(chatA)), 'still parked').toBeNull();
      expect(waitingAnswerWords(BigInt(chatA)), 'the wait stands').not.toBeNull();
    } finally {
      dropWait(chatA, 'agent_edit');
    }
  });

  it('a file replying to it, and a «cf:» press under a file, take nothing either', async () => {
    const { requestId, answerId } = await parkedAdd();
    armWait(chatA, 'agent_edit', { draftId: `rf-${STAMP}-2` }, AGENT_WAIT_TTL_MS, nowSec());
    try {
      const fileId = `rfpdf-${STAMP}-a`;
      h.serveFile(fileId, PDF);
      await h.handle(tg.document(chatA, fileId, { replyTo: answerId, fileName: 'packing.pdf', mime: 'application/pdf', caption: 'Shim 20 dona' }));
      await h.settle();
      const original = fileMessage(chatA, fileId, 'packing.pdf');
      await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: original } }));
      await h.settle();
      const live = activeIntake(BigInt(chatA))!;
      expect(live.fileCount).toBe(0);
      expect(live.material).toEqual([]);
      expect(holdingIntake(BigInt(chatA))).toBeNull();
    } finally {
      dropWait(chatA, 'agent_edit');
    }
  });

  it('a «💬 Javob yozish» wait the door refused beside is KEPT — its words said «avval … javobni yozing»', async () => {
    const { answerId } = await parkedAdd();
    noteReplyPending(BigInt(chatA), 777_001);
    try {
      const m = mark();
      await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
      await h.settle();
      expect(saidTo(chatA, m).some((t) => t.includes('«💬 Javob yozish» so'))).toBe(true);
      expect(answersOf(chatA)).toEqual([]);
      expect(waitingAnswerWords(BigInt(chatA)), 'the 💬 wait stands').not.toBeNull();
    } finally {
      dropWait(chatA, 'task');
    }
  });
});

describe('the add door’s resume that did not resume (fix review FR-1)', () => {
  it('a reply to the ➕ answer of a PARKED collection being READ: the reading’s word, and nothing written into it', async () => {
    const { answerId } = await parkedAdd();
    updateIntake(BigInt(chatA), { analysing: `rf-${STAMP}`, analysingAt: Date.now(), analysingJob: null }, { quiet: true });
    const m = mark();
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    await h.settle();
    expect(saidTo(chatA, m)).toContain('⏳ Tahlil davom etmoqda — natijani kuting.');
    expect(saidTo(chatA, m)).not.toContain(ADD_REFUSAL.sameLive);
    expect(answersOf(chatA)).toEqual([]);
    updateIntake(BigInt(chatA), { analysing: null }, { quiet: true });
  });
});

describe('a zone press of a PARKED collection beside a task draft (fix review FR-2)', () => {
  it('refused in words; the collection stays at «qayerdan?» and the draft keeps its next line', async () => {
    const c = BigInt(chatB);
    await h.handle(tg.text(chatB, '🧮 Hisoblatish'));
    const m0 = h.mark();
    await h.handle(tg.callback(chatB, (seq += 1), 'c:aipk'));
    const zoneMsg =
      h.since(m0).api.filter((x) => x.method === 'sendMessage' && JSON.stringify(x.payload.reply_markup ?? '').includes('c:zone_')).at(-1)
        ?.messageId ?? (seq += 1);
    expect(activeIntake(c)!.stage).toBe('section');
    updateIntake(c, { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    await h.handle(tg.text(chatB, TOPSHIRIQ));
    expect(activeDraft(c)).not.toBeNull();
    const m = mark();
    await h.handle(tg.callback(chatB, zoneMsg, 'c:zone_cn'));
    expect(saidTo(chatB, m)).toContain(RESUME_BUSY);
    expect(holdingIntake(c), 'still parked').toBeNull();
    expect(activeIntake(c)!.stage).toBe('section');
    await h.handle(tg.text(chatB, 'Logist Demo'));
    await h.settle();
    expect(activeIntake(c)!.clientHintRaw).toBe('');
    __resetDrafts();
    endIntake(c);
  });
});

describe('«↩️» of a PARKED collection beside a task draft (fix review W-15)', () => {
  it('refused in words; the answer it would undo stands and the collection stays parked', async () => {
    const { answerId } = await answered();
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    await h.settle();
    const live = activeIntake(BigInt(chatA))!;
    expect(answersOf(chatA)).toEqual([['Krossovka', 40]]);
    const echo = live.echoes.at(-1)!;
    updateIntake(BigInt(chatA), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    await h.handle(tg.text(chatA, TOPSHIRIQ));
    expect(activeDraft(BigInt(chatA))).not.toBeNull();
    const m = mark();
    await h.handle(tg.callback(chatA, echo.messageId ?? (seq += 1), `cu:${echo.tag}`));
    expect(saidTo(chatA, m)).toContain(RESUME_BUSY);
    expect(answersOf(chatA)).toEqual([['Krossovka', 40]]);
    expect(holdingIntake(BigInt(chatA))).toBeNull();
    __resetDrafts();
  });
});

describe('a file replying to the ➕ answer: ONE patch carries the file, its caption and the move to «material» (fix review FR-5, fdur-1)', () => {
  it('the prompt after the file held, a flush, a restart, the redelivery: the caption kept, the save waits for «Bo‘ldi»', async () => {
    const { answerId } = await answered();
    const fileId = `rfpdf-${STAMP}-b`;
    h.serveFile(fileId, PDF);
    const U = tg.document(chatA, fileId, { replyTo: answerId, fileName: 'packing.pdf', mime: 'application/pdf', caption: 'Shim 20 dona' });
    hang.chat = chatA;
    // The file's «AI o‘qiydi» is a line of the ONE prompt now (his 1a,
    // docs/IKKI-ESHIK.md §1.4) — the first send after the file's patch.
    hang.needle = 'Qabul qilindi';
    hang.on = true;
    hang.reached = false;
    void h.handle(U).catch(() => {});
    await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
    const mid = activeIntake(BigInt(chatA))!;
    expect(mid.fileCount).toBe(1);
    expect(mid.stage).toBe('material');
    expect(mid.material).toEqual(['Shim 20 dona']);
    expect(await flushIntakeWrites()).toBe(true);
    await crashAndRestart();
    hang.needle = '';
    await h.handle(tg.again(U));
    await h.settle();
    const after = activeIntake(BigInt(chatA))!;
    expect(after.fileCount).toBe(1);
    expect(after.material).toEqual(['Shim 20 dona']);
    expect(after.stage).toBe('material');
    const m = mark();
    await h.handle(tg.callback(chatA, after.tableMessageId!, 'c:save'));
    expect(saidTo(chatA, m).some((t) => t.includes('avval «Bo‘ldi»'))).toBe(true);
    expect(vi.mocked(enqueue).mock.calls.some((c) => c[0] === JOB_CALC_AMEND_SAVE)).toBe(false);
  });
});

describe('the file that OPENED the add collection, redelivered dated before the opening second (fix review fdur-2)', () => {
  it('the table’s send held, a flush, a restart → the redelivered PDF is taken, never «kept» and lost', async () => {
    const { requestId, answerId } = await answered();
    const fileId = `rfpdf-${STAMP}-c`;
    h.serveFile(fileId, PDF);
    const U = tg.document(chatA, fileId, { replyTo: answerId, fileName: 'inv.pdf', mime: 'application/pdf', date: nowSec() - 2 });
    hang.chat = chatA;
    hang.needle = 'Qo‘shimcha';
    hang.on = true;
    hang.reached = false;
    void h.handle(U).catch(() => {});
    await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
    expect(activeIntake(BigInt(chatA))!.amend?.requestId).toBe(requestId);
    expect(activeIntake(BigInt(chatA))!.fileCount).toBe(0);
    expect(await flushIntakeWrites()).toBe(true);
    await crashAndRestart();
    hang.needle = '';
    await h.handle(tg.again(U));
    await h.settle();
    const after = activeIntake(BigInt(chatA))!;
    expect(after.fileCount).toBe(1);
    expect(after.pdfs).toHaveLength(1);
    // …and once more is `seen`.
    await h.handle(tg.again(U));
    await h.settle();
    expect(activeIntake(BigInt(chatA))!.fileCount).toBe(1);
  });
});

describe('«🗑 Ha» redelivered after its open and before its take (fix review fdur-3)', () => {
  it('the redelivery resumes the collection it opened AND takes the file the question was about', async () => {
    const { requestId } = await answered();
    await h.handle(tg.text(chatA, '🧮 Hisoblatish'));
    await h.handle(tg.callback(chatA, (seq += 1), 'c:rastamojka'));
    await h.handle(tg.text(chatA, 'GS777'));
    await h.handle(tg.text(chatA, 'Shim 20 dona'));
    updateIntake(BigInt(chatA), { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    const fileId = `rfpdf-${STAMP}-d`;
    h.serveFile(fileId, PDF);
    const original = fileMessage(chatA, fileId, 'packing.pdf');
    const m = mark();
    await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: original } }));
    const question = h.since(m.m).api.find((x) => x.method === 'sendMessage' && String(x.payload.text).includes('tugallanmagan yig‘ish'));
    expect(question, 'the question was asked').toBeDefined();
    const press = tg.callback(chatA, question!.messageId!, `cg:${requestId}`, { message: { reply_to_message: original } });
    hang.chat = chatA;
    hang.needle = 'Qo‘shimcha';
    hang.on = true;
    hang.reached = false;
    void h.handle(press).catch(() => {});
    await vi.waitFor(() => expect(hang.reached).toBe(true), { timeout: 15_000 });
    expect(activeIntake(BigInt(chatA))!.amend?.requestId).toBe(requestId);
    expect(activeIntake(BigInt(chatA))!.fileCount).toBe(0);
    expect(await flushIntakeWrites()).toBe(true);
    await crashAndRestart();
    hang.needle = '';
    await h.handle(tg.again(press));
    await h.settle();
    const after = activeIntake(BigInt(chatA))!;
    expect(after.amend?.requestId).toBe(requestId);
    expect(after.fileCount).toBe(1);
    expect(after.repliedTaken).toContain(original.message_id);
  });
});

describe('an album press whose memory died with the process (fix review fdur-4)', () => {
  it('every part it knows already taken: the burst-gone line is said, never silence about the rest (docs/IKKI-ESHIK.md §4.1)', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const fileId = `rfpdf-${STAMP}-e`;
    h.serveFile(fileId, PDF);
    const original = fileMessage(chatA, fileId, 'p1.pdf', { media_group_id: `g${STAMP}` });
    updateIntake(BigInt(chatA), { repliedTaken: [original.message_id], fileCount: 1, stage: 'material' }, { quiet: true });
    __resetAddOffers();
    const m = mark();
    await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: original } }));
    await h.settle();
    expect(saidTo(chatA, m)).toContain(BURST_GONE);
    expect(activeIntake(BigInt(chatA))!.fileCount).toBe(1);
  });
});

describe('`repliedTaken` holds more than two albums (fix review fdur-8)', () => {
  it('twenty-five parts taken, one more, and the FIRST is still fenced', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const firstId = `rfpdf-${STAMP}-f`;
    h.serveFile(firstId, PDF);
    const first = fileMessage(chatA, firstId, 'first.pdf');
    const fillers = Array.from({ length: 24 }, (_, i) => 700_000 + i);
    updateIntake(BigInt(chatA), { repliedTaken: [first.message_id, ...fillers], fileCount: 25 }, { quiet: true });
    const nextId = `rfpdf-${STAMP}-g`;
    h.serveFile(nextId, PDF);
    await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: fileMessage(chatA, nextId, 'next.pdf') } }));
    await h.settle();
    expect(activeIntake(BigInt(chatA))!.fileCount).toBe(26);
    await h.handle(tg.callback(chatA, (seq += 1), `cf:${requestId}`, { message: { reply_to_message: first } }));
    await h.settle();
    expect(activeIntake(BigInt(chatA))!.fileCount, 'the first offer re-tapped takes nothing again').toBe(26);
    expect(REPLIED_TAKEN_KEPT).toBeGreaterThan(20);
  });
});

describe('«✅ Qo‘shish» after «➕ Yana ma’lumot» with nothing sent (fix review W-11)', () => {
  it('saves the table he saw — never «Yangi ma’lumot hali o‘qilmagan» about nothing', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    await h.handle(tg.text(chatA, '2: 40 dona', { replyTo: answerId }));
    await h.settle();
    const live = activeIntake(BigInt(chatA))!;
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:more'));
    expect(activeIntake(BigInt(chatA))!.stage).toBe('material');
    const m = mark();
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:save'));
    expect(saidTo(chatA, m).some((t) => t.includes('hali o‘qilmagan'))).toBe(false);
    expect(vi.mocked(enqueue).mock.calls.some((c) => c[0] === JOB_CALC_AMEND_SAVE)).toBe(true);
  });

  it('anything sent after it is still read first', async () => {
    const { requestId, answerId } = await answered();
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const live = activeIntake(BigInt(chatA))!;
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:more'));
    await h.handle(tg.text(chatA, 'Shim 20 dona'));
    const m = mark();
    await h.handle(tg.callback(chatA, live.tableMessageId!, 'c:save'));
    expect(saidTo(chatA, m).some((t) => t.includes('hali o‘qilmagan'))).toBe(true);
    expect(vi.mocked(enqueue).mock.calls.some((c) => c[0] === JOB_CALC_AMEND_SAVE)).toBe(false);
  });
});

describe('a seeded collection’s certificate press is the seller’s content (fix review FR-10)', () => {
  it('opened with the request’s answer; pressed the other way, it is not «empty»', async () => {
    const { requestId, answerId } = await answered('rastamojka');
    await returned(requestId);
    await h.handle(tg.callback(chatA, answerId, `ca:${requestId}`));
    const seeded = activeIntake(BigInt(chatA))!;
    expect(seeded.certificateAtOpen).toBe(seeded.hasCertificate);
    expect(intakeIsEmpty(seeded)).toBe(true);
    await h.handle(tg.callback(chatA, seeded.tableMessageId!, seeded.hasCertificate ? 'c:cert_n' : 'c:cert_y'));
    const pressed = activeIntake(BigInt(chatA))!;
    expect(pressed.hasCertificate).toBe(!seeded.hasCertificate);
    expect(intakeIsEmpty(pressed)).toBe(false);
  });
});
