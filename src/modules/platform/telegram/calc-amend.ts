import type PgBoss from 'pg-boss';
import { randomUUID } from 'node:crypto';
import type { Message } from 'grammy/types';
import type { AmendBase, AmendSubmission } from '../../wms/calc/amend-types';
import type { AmendChange, AmendOutcome, AmendRowAnswer, AmendStanding, CalcAmendmentRow } from '../../wms/calc/amend';
import type { CalcEnding } from '../../wms/calc/service';
import type { SaveTableRefusal } from '../../wms/calc/workspace';
import { db } from '../db/client';
import { isServerBehind } from '../db/errors';
import { enqueue, jobState } from '../jobs/boss';
import { logger } from '../logger';
import type { InlineKeyboard, IntakeState } from './calc-intake';
import { activeIntake, endIntake, flushIntakeWrites, loadIntake, noteOwnMessage, startIntake, updateIntake } from './calc-store';
import { deliverNextStep, routeCollectorText, type CollectorReply, type EditApi, type PressCtx } from './calc-dialog';
import { fileOf, readIntakeFile, saveIntakeFile, type BotFile } from './calc-files';
import { pressResume } from './calc-intake-sweep';
import { CLIENT_QUESTION } from './calc-keyboards';
import { isBacklog } from './lifecycle';
import { activeCapture, refuseWhileCapturing } from './note-capture';
import { claimOnce, type OnceKey } from './once';
import { answerPress } from './press';
import { botCall, sendText } from './send';
import { staffForChat } from './staff-bot';
import { activeDraft, forwardAlbumOf } from './task-draft';

/**
 * «➕ Shu so‘rovga qo‘shish» — the add door (docs/SAKKIZ-R3.md §9, his 1.9 a):
 * what a seller learns after his request landed — the count the law asked, a
 * line he forgot, the second factory's packing list — joins THAT request.
 *
 * This file is the bot's half: the press and its refusals, the replies and
 * files that open the door without a press, the offers where extra
 * information arrives with nothing open, and the save — a pg-boss job, never
 * a `void` promise (a graceful deploy drains no `void` work). The writer is
 * wms's (`amendRequest`), reached by the collector's dynamic-import idiom:
 * platform never imports wms at run time.
 */

/** Uch band's conc-13 sentence, verbatim — what a press about no live collection hears. */
const NO_COLLECTION =
  'Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.';

/** The press refusals (§2.4), each the words the press is answered with and sends. */
export const ADD_REFUSAL = {
  notLinked: 'Ulanmagan',
  notYours: 'Bu so‘rov sizniki emas — qo‘shimchani so‘rovni yuborgan xodim qo‘sha oladi.',
  notFound: 'So‘rov topilmadi (o‘chirilgan bo‘lishi mumkin).',
  closed:
    'Bu so‘rov yopilgan (javob berilgan). Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring; VED ga savol bo‘lsa — kartadagi «Savol-javob».',
  closedUnpriced: 'Bu so‘rov narxsiz yopilgan. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.',
  leadClosed: 'Lid yopilgan — unga qo‘shimcha yozilmaydi; yutilgan bo‘lsa, uning bitimidan yuboring.',
  sameLive: 'Shu so‘rovga qo‘shimcha yig‘ilmoqda — davom eting.',
} as const;

/** The line above the add table, by where the request stood when the door opened (§2.4). */
export const STANDING_LINE: Record<AmendStanding, string | null> = {
  open: null,
  started: 'ℹ️ VED bu so‘rov ustida ishlayapti — qo‘shimchangiz VED ga yuboriladi, o‘zgartirishni VED o‘zi kiritadi.',
  busy: '⏳ AI hali hisoblayapti — «✅ Qo‘shish» dan keyin qo‘shimchangiz saqlanadi va AI tugatgach so‘rovga avtomatik yoziladi.',
  // Neither opens the door — refused before (`closed` re-read at the open).
  closed: null,
  not_found: null,
};

/** The save's own sentences (§2.4). */
export const SAVE_WORDS = {
  saving: '⏳ Qo‘shilmoqda…',
  failed: 'Qo‘shib bo‘lmadi — «✅ Qo‘shish» ni qayta bosing.',
  already: '✅ Bu qo‘shimcha allaqachon yuborilgan.',
  empty:
    'Hech narsa o‘zgarmadi — qatorga javob yozing («3: 50 dona») yoki «➕ Yana ma’lumot» bilan fayl yoki tovar yuboring.',
  aiLine: '\n🤖 AI qayta hisoblayapti — natija shu yerga keladi.',
  tariffLine: '\n🧮 Yo‘lkira tarif bo‘yicha qayta hisoblanmoqda — natija shu yerga keladi.',
  queueRefused: '\n⚠️ Qayta hisoblash navbatga tushmadi — narxni VED beradi.',
} as const;

/**
 * Every refusal `saveTable` can throw, in the seller's words (law-money-4) —
 * a missing sentence is a compile error, never a code on a phone. Some never
 * reach him (the outcome is re-read instead); their words say what they mean
 * for the day one does. `server_behind` is no throw site: the job's catch
 * names a non-`CalcError` so, as the landing does.
 */
export const AMEND_REFUSAL: Record<SaveTableRefusal | 'server_behind', string> = {
  too_many_items: 'tovarlar juda ko‘p (1000 dan ortiq).',
  server_behind: 'tizim yangilanmoqda — birozdan keyin qayta bosing.',
  name_required: 'yangi qatorga tovar nomi yozing.',
  // Never reaches him: the `not_found` outcome answers first.
  not_found: 'so‘rov topilmadi.',
  // The add door posts no `importRowId`, `bazaUsd`, `bazaBasis` or
  // `shownBasis`, and `doorRow` gives a pair unit only from its own list:
  // these four are unreachable from here.
  import_row_missing: 'bojxona bazasi qatori topilmadi.',
  bad_basis: 'birlik noto‘g‘ri.',
  baza_positive: 'baza 0 dan katta bo‘lishi kerak.',
  basis_shown_changed: 'birlik o‘zgargan — qatorni qayta yozing.',
  bad_number: 'son noto‘g‘ri — qatorni qayta yozing.',
  measure_positive: 'son 0 dan katta bo‘lishi kerak.',
  bad_code: 'TNVED kod noto‘g‘ri — 10 ta raqam bo‘lishi kerak, masalan «3: kod 6403990000».',
  // Never reaches him (law-money-7): the standing is read again — a machine
  // pass waits, a person's ✨ is the VED's branch.
  ai_running: 'AI yoki VED shu so‘rovni guruhlayapti.',
  // Never reaches him: the VED's branch, `closed`, re-reading the ending.
  already_closed: 'so‘rov yopilgan.',
  // Never reach him: the VED's branch, `started`.
  conflict: 'VED shu paytda saqladi.',
  changed_under: 'VED shu paytda saqladi.',
};

/** How long one save job may run, and its own wall clock inside it. */
export const AMEND_SAVE_EXPIRE_S = 120;
const AMEND_SAVE_DEADLINE_MS = 110_000;
/** Retries after the first attempt — the last one says so in words. */
export const AMEND_SAVE_RETRIES = 3;
/** How far back a request may be offered to a forward or a file (product-fit-16). */
export const ADD_OFFER_DAYS = 7;

/**
 * The add table's keyboard: «✅ Qo‘shish» — or, when the VED has started on
 * the job, «📨 VED ga yuborish», because nothing will be written into it
 * (product-fit-18). No certificate toggle: an addition never changes it.
 */
export function amendKeyboard(standingAtOpen: IntakeState['standingAtOpen']): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: standingAtOpen === 'started' ? '📨 VED ga yuborish' : '✅ Qo‘shish', callback_data: 'c:save' }],
      [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/** The ✅ landing reply's inline markup, or null = today's persistent-keyboard re-send. */
export function landedReplyMarkup(target: { queued?: boolean; requestId?: string | null }): InlineKeyboard | null {
  if (!target.queued || !target.requestId) return null;
  return { inline_keyboard: [[{ text: '➕ Shu so‘rovga qo‘shish', callback_data: `ca:${target.requestId}` }]] };
}

/**
 * What an add collection hands the wms writer (§9.5) — so wms never names the
 * bot's `IntakeState`. Pure:
 *  - stored rows' answers by item id, and a conflict the seller answered
 *    «qo‘shilsin» (stored + read) or «o‘rniga» (read) as an answer of its row;
 *  - the lines the collection read or was told that are no stored row;
 *  - totals and the route ONLY from table answers — never what a reading
 *    found (§0.1(2)), and never a totals answer later material doubts: that
 *    one reaches the VED as words (`doubtedTotals`);
 *  - the unresolved conflicts, the seller's words and the file count.
 */
export function amendSubmissionOf(state: IntakeState): AmendSubmission {
  const items = state.amend?.items ?? [];
  const seqOf = new Map(items.map((i) => [i.itemId, i]));
  const answers = new Map<string, AmendRowAnswer>();
  const fields = ['quantity', 'weightKg', 'volumeM3', 'measureUnit', 'measureQty', 'tnvedCode'] as const;
  for (const c of state.conflicts) {
    if (c.choice !== 'add' && c.choice !== 'rep') continue;
    const value = c.choice === 'add' ? (c.stored ?? 0) + c.read : c.read;
    const patch: AmendRowAnswer['patch'] =
      c.field === 'measureQty' ? { measureUnit: c.unit as never, measureQty: value } : { [c.field]: value };
    const prev = answers.get(c.itemId);
    answers.set(c.itemId, {
      itemId: c.itemId,
      patch: { ...(prev?.patch ?? {}), ...patch },
      ...(c.choice === 'add' && c.stored !== null ? { sum: { field: c.field, unit: c.unit, stored: c.stored, read: c.read } } : {}),
    });
  }
  for (const entry of state.lineAnswers) {
    if (!entry.itemId) continue;
    const patch: AmendRowAnswer['patch'] = {};
    for (const key of fields) {
      const v = entry.patch[key];
      if (v !== undefined && v !== null) (patch as Record<string, unknown>)[key] = v;
    }
    if (Object.keys(patch).length === 0) continue;
    const prev = answers.get(entry.itemId);
    // A typed answer to a conflicted row resolves it: the answer wins.
    answers.set(entry.itemId, { ...(prev ?? {}), itemId: entry.itemId, patch: { ...(prev?.patch ?? {}), ...patch } });
  }
  const doubted = new Set(state.ambiguousTotals.map((a) => a.field));
  const totals: { weightKg?: number; volumeM3?: number } = {};
  if (state.totalsAnswer.weightKg !== null && !doubted.has('weightKg')) totals.weightKg = state.totalsAnswer.weightKg;
  if (state.totalsAnswer.volumeM3 !== null && !doubted.has('volumeM3')) totals.volumeM3 = state.totalsAnswer.volumeM3;
  const doubtedTotals: AmendSubmission['doubtedTotals'] = [];
  for (const a of state.ambiguousTotals) {
    if ('answered' in a) doubtedTotals.push({ field: a.field, asked: a.answered, read: a.stated });
  }
  const route: { fromCity?: string; toCity?: string } = {};
  if (state.routeAnswer?.fromCity) route.fromCity = state.routeAnswer.fromCity;
  if (state.routeAnswer?.toCity) route.toCity = state.routeAnswer.toCity;
  return {
    rowAnswers: [...answers.values()],
    newLines: (state.facts.goods ?? []).filter((g) => !g.itemId),
    totals: Object.keys(totals).length > 0 ? totals : null,
    route: Object.keys(route).length > 0 ? route : null,
    conflicts: state.conflicts
      .filter((c) => c.choice === null || c.choice === 'ved')
      .map((c) => ({
        itemId: c.itemId,
        seq: c.seq,
        name: seqOf.get(c.itemId)?.name ?? '',
        field: c.field,
        unit: c.unit,
        stored: c.stored,
        read: c.read,
      })),
    doubtedTotals,
    material: [...state.material, ...state.answers],
    fileCount: state.fileCount,
  };
}

// ---------------------------------------------------------------------------
// Speaking — through the press's ctx, or by chat id where there is none.
// ---------------------------------------------------------------------------

/** Who the door speaks through: a ctx's reply, and — for a press — its one answer. */
interface Speaker extends CollectorReply {
  api: EditApi;
  /** Answer the press (once); a message opening the door has none. */
  answer(toast?: string): Promise<void>;
}

/** A chat-id sender with the collector's ctx shape (the reply door, the job: no ctx). */
function chatSender(chatId: bigint): CollectorReply & { api: EditApi } {
  return {
    async reply(text, extra) {
      const answer = await botCall('sendMessage', { chat_id: chatId.toString(), text, ...(extra ?? {}) }, 10_000);
      if (!answer.ok) logger.warn({ status: answer.status, description: answer.description }, '[calc-amend] chat send refused');
      return { message_id: (answer.result as { message_id?: number } | null)?.message_id ?? 0 };
    },
    api: {
      async editMessageText(chat, messageId, text, extra) {
        return botCall('editMessageText', { chat_id: chat, message_id: messageId, text, ...(extra ?? {}) }, 10_000);
      },
    },
  };
}

function pressSpeaker(ctx: PressCtx, chatId: bigint): Speaker {
  let answered = false;
  const sender = chatSender(chatId);
  return {
    reply: (text, extra) => ctx.reply(text, extra),
    api: (ctx as PressCtx & { api?: EditApi }).api ?? sender.api,
    async answer(toast) {
      if (answered) return;
      answered = true;
      await answerPress(ctx, toast);
    },
  };
}

function messageSpeaker(chatId: bigint, ctx?: CollectorReply & { api?: EditApi }): Speaker {
  const sender = chatSender(chatId);
  return {
    reply: ctx ? (text, extra) => ctx.reply(text, extra) : sender.reply,
    api: ctx?.api ?? sender.api,
    async answer() {},
  };
}

/** A refusal: the press is answered with the words, and they are sent. */
async function refuse(sp: Speaker, words: string, extra?: Record<string, unknown>): Promise<void> {
  await sp.answer(words);
  await sp.reply(words, extra);
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

type Stored = NonNullable<Awaited<ReturnType<typeof import('../../wms/calc/service').storedRequestFacts>>>;

/**
 * The door's checks, in §2.4's order, and the open — or the resume, or the
 * one question. Null = refused (said); otherwise the live collection.
 * `restart`: the `cg:` press, which ends the other collection (its claim
 * spent once: a redelivered «🗑 Ha» resumes rather than wiping again).
 */
async function openDoor(
  chatId: bigint,
  requestId: string,
  sp: Speaker,
  opts: { openedBy: number | null; restart: boolean; restartKey: OnceKey | null },
): Promise<{ state: IntakeState; opened: boolean } | null> {
  const staff = await staffForChat(chatId);
  if (!staff) {
    await refuse(sp, ADD_REFUSAL.notLinked);
    return null;
  }
  const { storedRequestFacts } = await import('../../wms/calc/service');
  const stored = await storedRequestFacts(requestId);
  if (!stored) {
    await refuse(sp, ADD_REFUSAL.notFound);
    return null;
  }
  if (stored.requestedBy !== staff.id) {
    await refuse(sp, ADD_REFUSAL.notYours);
    return null;
  }
  // Keyed on HOW it ended — five endings, not three: a price-less close is
  // never «javob berilgan» (re-check p4-15).
  const ending = stored.ending;
  if (ending === 'answered' || ending === 'sealed') {
    await refuse(sp, ADD_REFUSAL.closed);
    return null;
  }
  if (ending === 'unpriced_lines' || ending === 'unpriced_task') {
    await refuse(sp, ADD_REFUSAL.closedUnpriced);
    return null;
  }
  // ⭐ of Question 6: a returned request cannot be reopened; a NEW collection
  // carries its rows and lands where Uch band puts any «🧮».
  const returned = ending === 'returned';
  if (!returned && stored.base.leadOpen === false) {
    await refuse(sp, ADD_REFUSAL.leadClosed);
    return null;
  }
  // One collector at a time — and their words are imported, never restated.
  if (activeDraft(chatId)) {
    const { BUSY_DRAFT } = await import('./task-handlers');
    await refuse(sp, `Hozir topshiriq yozilyapti. ${BUSY_DRAFT}`);
    return null;
  }
  if (activeCapture(chatId)) {
    await sp.answer();
    await refuseWhileCapturing(sp, chatId);
    return null;
  }
  const live = activeIntake(chatId);
  if (live && !returned && live.amend?.requestId === requestId) {
    // This request's own add collection: a resume (P1 un-parks it there).
    await sp.answer();
    await sp.reply(ADD_REFUSAL.sameLive);
    await pressResume(sp, chatId);
    return { state: activeIntake(chatId) ?? live, opened: false };
  }
  if (live) {
    if (!opts.restart) {
      const card = stored.base.cardLabel;
      await sp.answer();
      const sent = await sp.reply(
        `Sizda tugallanmagan yig‘ish bor. Uni o‘chirib, ${card} so‘roviga qo‘shimcha boshlaymizmi? Yuborilgan hamma narsa o‘chadi.`,
        { reply_markup: restartQuestionKeyboard(requestId) },
      );
      noteOwnMessage(chatId, sent.message_id);
      return null;
    }
    // One «🗑 Ha» wipes once: its claim already held means this press already
    // ended the other collection and opened this one (or a newer one stands).
    if (opts.restartKey && !(await claimOnce(db, opts.restartKey))) {
      await sp.answer();
      await pressResume(sp, chatId);
      return null;
    }
    endIntake(chatId);
  }
  return returned ? openSeeded(chatId, stored, staff.id, sp, opts.openedBy) : openAdd(chatId, stored, staff.id, sp, opts.openedBy);
}

/** «🗑 Ha, uni o‘chirib qo‘shimchaga o‘tamiz» / «▶️ Yo‘q, davom etaman». */
function restartQuestionKeyboard(requestId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '🗑 Ha, uni o‘chirib qo‘shimchaga o‘tamiz', callback_data: `cg:${requestId}` }],
      [{ text: '▶️ Yo‘q, davom etaman', callback_data: 'c:resume' }],
    ],
  };
}

/**
 * The add collection on a stored request: the rows by `seq` with their item
 * ids and laws, the asked rows (the law's count, P5's `lawAsksOf` — what the
 * law asks NOW, never read back from a message), and where the request stood.
 * A stored m³ that is the lines' Σ is left to the lines, so the table shows
 * the Σ as lines are added (law-money-1); a typed one is kept.
 */
async function openAdd(
  chatId: bigint,
  stored: Stored,
  staffId: string,
  sp: Speaker,
  openedBy: number | null,
): Promise<{ state: IntakeState; opened: boolean } | null> {
  const { amendStanding } = await import('../../wms/calc/amend');
  const standing = await amendStanding(stored.base.requestId);
  if (standing.standing === 'not_found') {
    await refuse(sp, ADD_REFUSAL.notFound);
    return null;
  }
  if (standing.standing === 'closed') {
    await refuse(
      sp,
      standing.ending === 'unpriced_lines' || standing.ending === 'unpriced_task' ? ADD_REFUSAL.closedUnpriced : ADD_REFUSAL.closed,
    );
    return null;
  }
  const atOpen = standing.standing;
  const { lawAsksOf } = await import('../../wms/calc/law-asks');
  const { volumeIsLinesSum } = await import('../../wms/calc/line-totals');
  const base = stored.base;
  const bookLaws = new Map(
    base.items.filter((i) => i.tnvedCode && i.law).map((i) => [i.tnvedCode!, i.law!] as const),
  );
  const asks = lawAsksOf({
    section: base.section,
    facts: stored.facts,
    bookLaws,
    confirmedSeqs: new Set(base.items.filter((i) => i.confirmed).map((i) => i.seq)),
  });
  const sum = volumeIsLinesSum(base.volumeM3, base.items);
  const facts: IntakeState['facts'] = {
    ...stored.facts,
    // A stored row's weight is its own — never one copied from the brutto.
    lineWeightsStated: true,
    totalsStored: !sum,
    volumeM3: sum ? null : stored.facts.volumeM3,
  };
  startIntake(chatId, base.section, { ai: true, staffId, amend: base, openedBy });
  const state = updateIntake(chatId, {
    stage: 'review',
    facts,
    clientHintRaw: base.clientLabel ?? '',
    askedSeqs: asks.length > 0 ? asks.map((a) => a.seq) : null,
    standingAtOpen: atOpen,
  });
  if (!state) return null;
  await sp.answer();
  const line = STANDING_LINE[atOpen];
  if (line) noteOwnMessage(chatId, (await sp.reply(line)).message_id);
  await deliverNextStep(sp, chatId, state);
  return { state: activeIntake(chatId) ?? state, opened: true };
}

/**
 * ⭐ of Question 6: a request the VED RETURNED cannot be reopened
 * (`recalcFromSealed` refuses a returned parent), so «➕» opens a NEW «🧮»
 * collection already filled with its rows, figures, codes and customer. It
 * lands through `landIntake` like any other — Uch band decides the card; the
 * returned request, its note and its files stay on the old card.
 */
async function openSeeded(
  chatId: bigint,
  stored: Stored,
  staffId: string,
  sp: Speaker,
  openedBy: number | null,
): Promise<{ state: IntakeState; opened: boolean } | null> {
  const { returnedClientHint } = await import('../../wms/calc/amend');
  const hint = await returnedClientHint(stored.base);
  const lines = (stored.facts.goods ?? []).map((g) => {
    const line = { ...g };
    delete line.itemId;
    delete line.seq;
    return line;
  });
  startIntake(chatId, stored.base.section, { ai: true, staffId, amend: null, openedBy });
  const state = updateIntake(chatId, {
    stage: hint ? 'review' : 'client',
    facts: {
      fromCity: stored.base.fromCity,
      toCity: stored.base.toCity,
      weightKg: stored.base.weightKg,
      volumeM3: stored.base.volumeM3,
      goods: lines,
      lineWeightsStated: true,
    },
    seed: lines,
    clientHintRaw: hint,
  });
  if (!state) return null;
  await sp.answer();
  noteOwnMessage(
    chatId,
    (
      await sp.reply(
        `📨 VED bu so‘rovni qaytargan: «${stored.returnReason ?? '—'}». Yetishmaganini qo‘shing — «✅ Tasdiqlash» yangi so‘rov bo‘lib VED ga boradi.`,
      )
    ).message_id,
  );
  if (hint) await deliverNextStep(sp, chatId, state);
  else await sp.reply(CLIENT_QUESTION, { parse_mode: 'Markdown' });
  return { state: activeIntake(chatId) ?? state, opened: true };
}

/**
 * «➕ Shu so‘rovga qo‘shish». `mode`: 'plain' (`ca:`), 'restart' (`cg:`, the
 * «🗑 Ha, uni o‘chirib …» twin), 'replied' (`cf:`, an offer under a forward or
 * a plain file — the message the offer replies to becomes the first
 * material). `restartKey`: the dispatcher's claim for the restart form.
 * NOT pre-answered: every path answers the press once, through `answerPress`.
 */
export async function pressAdd(
  ctx: PressCtx,
  chatId: bigint,
  requestId: string,
  mode: 'plain' | 'restart' | 'replied',
  restartKey: OnceKey | null,
): Promise<void> {
  const sp = pressSpeaker(ctx, chatId);
  try {
    const pressed = ctx.callbackQuery?.message?.message_id ?? null;
    const out = await openDoor(chatId, requestId, sp, { openedBy: pressed, restart: mode === 'restart', restartKey });
    if (out && mode === 'replied') {
      const original = ctx.callbackQuery?.message?.reply_to_message;
      await takeReplied(chatId, sp, out.state, original ?? null);
    }
  } catch (err) {
    logger.warn({ err, requestId }, '[calc-amend] the add door failed');
    await sp.answer();
    await sp.reply(isServerBehind(err) ? AMEND_REFUSAL.server_behind : ADD_REFUSAL.notFound).catch(() => {});
  } finally {
    await sp.answer();
  }
}

/**
 * The message a `cf:` offer replies to, as the add collection's material: its
 * text, its file — and, for a forwarded or a plain album, the other parts the
 * album memory still holds. It is OLDER than what the collection may already
 * have applied, so `takenUpTo` cannot fence it: `repliedTaken` does, and the
 * file's attachment id is the message's either way (K5).
 */
async function takeReplied(chatId: bigint, sp: Speaker, state: IntakeState, original: Message | null): Promise<void> {
  if (!original) {
    noteOwnMessage(chatId, (await sp.reply('Asl xabar topilmadi — qaytadan yuboring.')).message_id);
    return;
  }
  if (state.repliedTaken.includes(original.message_id)) return;
  const group = original.media_group_id ?? null;
  const parts: { messageId: number; file: BotFile | null; name: string; mime: string | null }[] = [];
  const first = fileOf(original);
  parts.push({
    messageId: original.message_id,
    file: first,
    name: original.document?.file_name ?? '',
    mime: original.document?.mime_type ?? null,
  });
  // A forwarded album's parts are Door B's memory (`forwardAlbumOf`), a plain
  // one's this file's own — the same file per part either way.
  const forwarded = group
    ? (forwardAlbumOf(chatId, group)?.map((p) => ({
        messageId: p.messageId,
        file: fileOf(p),
        name: p.file?.name ?? '',
        mime: p.file?.mime ?? null,
      })) ?? null)
    : null;
  const plain = group ? plainAlbumOf(chatId, group) : null;
  const album = forwarded ?? plain;
  for (const part of album ?? []) {
    if (part.messageId === original.message_id) continue;
    parts.push(part);
  }
  const staffId = state.staffId;
  const text = (original.text ?? original.caption ?? '').trim();
  let live = state;
  let files = 0;
  for (const part of parts) {
    if (!part.file) continue;
    const saved = await saveIntakeFile({}, live.noteId, staffId, part.file).catch((err: unknown) => {
      logger.warn({ err }, '[calc-amend] replied file save failed');
      return null;
    });
    if (!saved) continue;
    const read = await readIntakeFile(saved, part.name, part.mime, live);
    files += 1;
    live =
      updateIntake(chatId, { ...read.patch, fileCount: live.fileCount + 1 }) ?? { ...live, ...read.patch, fileCount: live.fileCount + 1 };
    if (read.say) noteOwnMessage(chatId, (await sp.reply(read.say, read.keyboard ? { reply_markup: read.keyboard } : undefined)).message_id);
  }
  updateIntake(chatId, {
    material: text ? [...live.material, text] : live.material,
    repliedTaken: [...live.repliedTaken, original.message_id].slice(-20),
  });
  if (group && !album) noteOwnMessage(chatId, (await sp.reply('📎 Albom bo‘lsa, qolgan rasmlarni shu yerga yuboring.')).message_id);
  if (!text && files === 0) logger.info({ chatId: chatId.toString() }, '[calc-amend] replied message carried nothing to take');
}

/**
 * A TEXT sent as a REPLY to an AI answer that carries ➕: the door's checks,
 * then the add collection open (or resumed) in its table, `takenUpTo` at this
 * message, and the text through the collector's own answer path — never a
 * second one. Everything is said by chat id, so the reply door answers
 * HANDLED with no text (regression-2: «2: 40 juft» must reach neither Door B,
 * nor an armed «Bajarildi», nor the paid assistant).
 */
export async function openAmendFromReply(
  chatId: bigint,
  requestId: string,
  msg: { text: string | null; date: number; messageId: number },
): Promise<void> {
  const sp = messageSpeaker(chatId);
  try {
    const out = await openDoor(chatId, requestId, sp, { openedBy: msg.messageId, restart: false, restartKey: null });
    if (!out) return;
    const state = updateIntake(chatId, { takenUpTo: Math.max(out.state.takenUpTo, msg.messageId) }, { quiet: true }) ?? out.state;
    const text = msg.text?.trim();
    if (!text) return;
    await routeCollectorText(sp, chatId, state, text, {
      date: msg.date,
      messageId: msg.messageId,
      forwarded: false,
      // The reply OPENED this collection: it is its own message, never a
      // reply to somebody else's (regression-5's rule reads null as that).
      replyTo: null,
    });
  } catch (err) {
    logger.warn({ err, requestId }, '[calc-amend] reply to the AI answer failed');
    await sp.reply(isServerBehind(err) ? AMEND_REFUSAL.server_behind : ADD_REFUSAL.notFound).catch(() => {});
  }
}

/**
 * A photo or document sent as a reply to a ➕-bearing message: the door, then
 * the file filed as the add collection's material (K5's own save and read).
 * The caller decided it is not a voice note and not the backlog.
 */
export async function openAmendFromMedia(
  ctx: CollectorReply & { api?: EditApi; message?: Message },
  chatId: bigint,
  requestId: string,
): Promise<void> {
  const sp = messageSpeaker(chatId, ctx);
  const message = ctx.message;
  if (!message) return;
  try {
    const out = await openDoor(chatId, requestId, sp, { openedBy: message.message_id, restart: false, restartKey: null });
    if (!out) return;
    let live = updateIntake(chatId, { takenUpTo: Math.max(out.state.takenUpTo, message.message_id) }, { quiet: true }) ?? out.state;
    const file = fileOf(message);
    if (file) {
      const saved = await saveIntakeFile({ message }, live.noteId, live.staffId, file).catch((err: unknown) => {
        logger.warn({ err }, '[calc-amend] replied media save failed');
        return null;
      });
      if (!saved) {
        await sp.reply('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
        return;
      }
      const read = await readIntakeFile(saved, message.document?.file_name ?? '', message.document?.mime_type ?? null, live);
      live = updateIntake(chatId, { ...read.patch, fileCount: live.fileCount + 1 }) ?? live;
      if (read.say) await sp.reply(read.say, read.keyboard ? { reply_markup: read.keyboard } : undefined);
    }
    const caption = message.caption?.trim();
    if (caption) updateIntake(chatId, { material: [...live.material, caption] });
  } catch (err) {
    logger.warn({ err, requestId }, '[calc-amend] media reply to the AI answer failed');
  }
}

/**
 * A text replying to ANOTHER request's ➕-bearing message while a collection
 * is live (regression-5, product-fit-5): words naming both, nothing written —
 * the answer is never applied to the wrong job. B's own add collection takes
 * it as a table answer (false here).
 */
export async function foreignAddReply(
  ctx: CollectorReply,
  chatId: bigint,
  intake: IntakeState,
  replyTo: number | null,
): Promise<boolean> {
  if (replyTo === null) return false;
  try {
    const { replyVerdictFor } = await import('./reply-door');
    const verdict = await replyVerdictFor(chatId, replyTo, intake.staffId);
    if (verdict?.kind !== 'calc_add' || verdict.requestId === intake.amend?.requestId) return false;
    const { storedRequestFacts } = await import('../../wms/calc/service');
    const { SECTION_LABEL } = await import('../../wms/calc/intake');
    const b = (await storedRequestFacts(verdict.requestId))?.base.cardLabel ?? 'boshqa';
    const a = intake.amend?.cardLabel ?? SECTION_LABEL[intake.section];
    const sent = await ctx.reply(
      `Sizda ${a} bo‘yicha yig‘ish ochiq — bu javob ${b} so‘roviga tegishli, hech narsa yozilmadi. ${b} ga qo‘shish uchun:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🔄 Ha, ochiq yig‘ishni o‘chirib ${b} ga qo‘shamiz`, callback_data: `cg:${verdict.requestId}` }],
            [{ text: '▶️ Yo‘q, davom etaman', callback_data: 'c:resume' }],
          ],
        },
      },
    );
    noteOwnMessage(chatId, sent.message_id);
    return true;
  } catch (err) {
    logger.warn({ err }, '[calc-amend] foreign reply check failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Where extra information arrives with nothing open (product-fit-16).
// ---------------------------------------------------------------------------

/** Per chat, the open requests an offer may name — a minute, because Door B and the media handler are on the poller. */
const offerCache = new Map<string, { at: number; rows: { text: string; callback_data: string }[][] }>();
const OFFER_CACHE_MS = 60_000;

/** A plain album's parts, so the one offer's press can take every part (a per-chat 10-minute memory, like Door B's). */
interface PlainAlbum {
  parts: { messageId: number; file: BotFile | null; name: string; mime: string | null }[];
  offered: boolean;
  expires: number;
}
const plainAlbums = new Map<string, Map<string, PlainAlbum>>();
const PLAIN_ALBUM_TTL_MS = 10 * 60_000;

function plainAlbumOf(chatId: bigint, group: string): PlainAlbum['parts'] | null {
  const album = plainAlbums.get(String(chatId))?.get(group);
  if (!album || album.expires <= Date.now()) return null;
  return [...album.parts].sort((x, y) => x.messageId - y.messageId);
}

/** Tests only: a clean slate. */
export function __resetAddOffers(): void {
  offerCache.clear();
  plainAlbums.clear();
}

/**
 * Door B's extra rows: one `➕ {card} so‘roviga qo‘shish` (`cf:<id>`) per
 * open request the staff member sent in the last `ADD_OFFER_DAYS` (at most
 * two, newest first). Never fails Door B: any error answers none.
 */
export async function addOfferRows(chatId: bigint): Promise<{ text: string; callback_data: string }[][]> {
  try {
    const key = String(chatId);
    const hit = offerCache.get(key);
    if (hit && hit.at > Date.now() - OFFER_CACHE_MS) return hit.rows;
    // A live collector takes the message first; nothing is offered beside it.
    if (activeIntake(chatId) || activeDraft(chatId) || activeCapture(chatId)) return [];
    const staff = await staffForChat(chatId);
    if (!staff) return [];
    const { openRequestsToOffer } = await import('../../wms/calc/amend');
    const open = await openRequestsToOffer(staff.id, ADD_OFFER_DAYS);
    const rows = open.map((r) => [{ text: `➕ ${clipLabel(r.card)} so‘roviga qo‘shish`, callback_data: `cf:${r.id}` }]);
    offerCache.set(key, { at: Date.now(), rows });
    return rows;
  } catch (err) {
    logger.warn({ err }, '[calc-amend] offer rows failed');
    return [];
  }
}

const clipLabel = (label: string) => (label.length > 30 ? `${label.slice(0, 29)}…` : label);

/**
 * A plain photo or document with nothing to take it — which today gets
 * silence, because the cabinet answers a staff chat with nothing — gets one
 * offer line as a reply to it, when the sender has an open request it could
 * join. One per album, as a reply to its first part; the other parts are
 * remembered for the press. Never a reply, a forward (Door B's), the
 * backlog, or a voice note. True = answered.
 */
export async function offerAddForMedia(ctx: CollectorReply & { message: unknown }, chatId: bigint): Promise<boolean> {
  const message = ctx.message as Message | undefined;
  if (!message || message.reply_to_message || message.forward_origin || isBacklog(message.date)) return false;
  const file = fileOf(message);
  if (!file) return false;
  if (activeIntake(chatId) || activeDraft(chatId) || activeCapture(chatId)) return false;
  const group = message.media_group_id ?? null;
  let album: PlainAlbum | null = null;
  if (group) {
    const key = String(chatId);
    const now = Date.now();
    const byGroup = plainAlbums.get(key) ?? new Map<string, PlainAlbum>();
    for (const [id, a] of byGroup) if (a.expires <= now) byGroup.delete(id);
    album = byGroup.get(group) ?? null;
    const part = {
      messageId: message.message_id,
      file,
      name: message.document?.file_name ?? '',
      mime: message.document?.mime_type ?? null,
    };
    if (album) {
      if (!album.parts.some((p) => p.messageId === part.messageId)) album.parts.push(part);
      // The album's first part asked already: the rest only join it.
      return album.offered;
    }
    album = { parts: [part], offered: false, expires: now + PLAIN_ALBUM_TTL_MS };
    byGroup.set(group, album);
    plainAlbums.set(key, byGroup);
  }
  const rows = await addOfferRows(chatId);
  if (rows.length === 0) return false;
  if (album) album.offered = true;
  await ctx.reply('➕ Bu faylni so‘rovga qo‘shamizmi?', {
    reply_markup: { inline_keyboard: rows },
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
  return true;
}

// ---------------------------------------------------------------------------
// The save.
// ---------------------------------------------------------------------------

/**
 * «✅ Qo‘shish» on an add collection: the collection is FROZEN under a token,
 * this chat's write is flushed, and the save is a pg-boss job (durability-4:
 * a `void` save died with every graceful deploy). The dispatcher's guards ran
 * first (the reading, the stage, a save already running).
 */
export async function saveAmendment(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void> {
  if (!state.amend) {
    await ctx.reply(NO_COLLECTION);
    return;
  }
  const token = randomUUID();
  const jobId = randomUUID();
  updateIntake(chatId, { saving: { token, at: Date.now(), jobId } });
  await flushIntakeWrites(chatId);
  const job = saveJobOf(chatId, state, state.amend, token);
  try {
    await enqueueSave(job, jobId);
  } catch (err) {
    logger.warn({ err, requestId: job.requestId }, '[calc-amend] the save could not be queued');
    releaseSaving(chatId, state.noteId);
    await ctx.reply(SAVE_WORDS.failed);
    return;
  }
  const sent = await ctx.reply(SAVE_WORDS.saving);
  noteOwnMessage(chatId, sent.message_id);
}

/** A frozen collection's job, as the press builds it and the hydrate rebuilds it. */
function saveJobOf(chatId: bigint, state: IntakeState, amend: AmendBase, token: string): AmendSaveJob {
  return {
    chatId: chatId.toString(),
    staffId: state.staffId,
    requestId: amend.requestId,
    noteId: state.noteId,
    submission: amendSubmissionOf(state),
    amendmentId: null,
    savingToken: token,
  };
}

/** No `singletonKey`: the once-fence of an addition is its note id (re-check p4-2). */
async function enqueueSave(job: AmendSaveJob, jobId: string): Promise<void> {
  await enqueue(JOB_CALC_AMEND_SAVE, job, { id: jobId, expireInSeconds: AMEND_SAVE_EXPIRE_S, retryLimit: AMEND_SAVE_RETRIES });
}

/**
 * The hydrate's half of durability-4 (P1's `hydrateIntakes` calls it for an
 * add collection whose amendment exists and was never told, or that was
 * frozen with no amendment yet): the job again, with the save job's own
 * options and a fresh job id — the old one may be `completed` or `failed`,
 * and pg-boss refuses a second job under a used id. A duplicate is harmless:
 * it answers `duplicate` off the note id and redoes only what is missing.
 * Answers false when there is nothing to re-enqueue or the queue refused.
 */
export async function requeueAmendSave(chatId: bigint, state: IntakeState): Promise<boolean> {
  if (!state.amend || !state.saving) return false;
  const jobId = randomUUID();
  const job = saveJobOf(chatId, state, state.amend, state.saving.token);
  updateIntake(chatId, { saving: { ...state.saving, jobId } }, { quiet: true });
  try {
    await enqueueSave(job, jobId);
    return true;
  } catch (err) {
    logger.warn({ err, requestId: job.requestId }, '[calc-amend] the save could not be re-queued');
    return false;
  }
}

/** The frozen collection let go — only the collection this note is. */
function releaseSaving(chatId: bigint, noteId: string): void {
  const live = activeIntake(chatId);
  if (live && live.noteId === noteId && live.saving) updateIntake(chatId, { saving: null }, { quiet: true });
}

/** End the collection the save answered for — never a newer one in the chat. */
function endIfOurs(chatId: bigint, noteId: string): void {
  if (activeIntake(chatId)?.noteId === noteId) endIntake(chatId);
}

/** The sweep's view of a frozen add collection: is its save job alive? */
export async function savingAlive(state: IntakeState): Promise<boolean> {
  if (!state.saving) return true;
  if (!state.saving.jobId) return Date.now() - state.saving.at < AMEND_SAVE_EXPIRE_S * 1000;
  try {
    const at = await jobState(JOB_CALC_AMEND_SAVE, state.saving.jobId);
    return at === 'created' || at === 'retry' || at === 'active';
  } catch (err) {
    // A blip in the queue is not a dead save.
    logger.warn({ err }, '[calc-amend] save job state unreadable');
    return true;
  }
}

/** The sweep's release of a dead save: the collection is let go and told. */
export async function releaseDeadSave(chatId: bigint, state: IntakeState): Promise<void> {
  releaseSaving(chatId, state.noteId);
  await sendWords(chatId, SAVE_WORDS.failed);
}

/** The add door's save as a pg-boss job. */
export const JOB_CALC_AMEND_SAVE = 'calc.amend-save';

export interface AmendSaveJob {
  chatId: string;
  staffId: string;
  requestId: string;
  noteId: string;
  /** A fresh press carries the submission; a stored («waiting») one carries its row id. */
  submission: AmendSubmission | null;
  amendmentId: string | null;
  savingToken: string | null;
}

/** Words by chat id, under the job's own send deadline. */
async function sendWords(chatId: bigint, text: string): Promise<{ ok: boolean; permanent: boolean }> {
  const sent = await sendText({ chatId, text, timeoutMs: 10_000 });
  if (!sent.ok) logger.warn({ status: sent.status, description: sent.description }, '[calc-amend] words not sent');
  return { ok: sent.ok, permanent: sent.permanent };
}

/** «… qo‘shimchangiz …» — or, for a stored addition the job wrote later, «Kutib turgan qo‘shimchangiz». */
const waitedWord = (text: string, waited: boolean) =>
  waited ? text.replace('qo‘shimchangiz', 'Kutib turgan qo‘shimchangiz') : text;

/** The closed words, keyed on how the request ENDED (re-check p4-15). */
function closedWords(ending: CalcEnding | null): string {
  if (ending === 'returned') {
    return '📨 VED bu so‘rovni sizga qaytargan — qo‘shimchangiz VED ga yozildi. Hisob qayta kerak bo‘lsa «🧮 Hisoblatish» dan yangi so‘rov yuboring.';
  }
  if (ending === 'unpriced_lines' || ending === 'unpriced_task') {
    return '📨 Bu so‘rov narxsiz yopilgan — qo‘shimchangiz VED ga yozildi. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.';
  }
  return '📨 Bu so‘rov yopilgan (javob berilgan) — qo‘shimchangiz VED ga yozildi. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.';
}

const withLines = (head: string, lines: readonly string[]) => (lines.length ? `${head}\n${lines.join('\n')}` : head);

/** The AI line after an applied addition — the tariff's on a section with no customs part. */
async function repassLine(change: AmendChange, queued: boolean): Promise<string> {
  if (!queued) return SAVE_WORDS.queueRefused;
  const { sectionParts } = await import('../../wms/calc/pricing');
  return sectionParts(change.section).customs ? SAVE_WORDS.aiLine : SAVE_WORDS.tariffLine;
}

export type Told = Exclude<AmendOutcome, { kind: 'empty' | 'duplicate' | 'not_yours' | 'not_found' | 'refused' }>;

/**
 * The seller's words for an outcome (§2.4) — one per kind, a `Record` so a
 * new kind without words is a compile error. `waited`: a stored addition the
 * job wrote after the machine's pass ended.
 */
const OUTCOME_WORDS: { [K in Told['kind']]: (o: Extract<Told, { kind: K }>, waited: boolean) => Promise<string> } = {
  async applied(o, waited) {
    const line = await repassLine(o.change, o.queued);
    return waited
      ? `✅ Kutib turgan qo‘shimchangiz so‘rovga yozildi (${o.change.card}).${line}`
      : `${withLines(`✅ So‘rovga qo‘shildi (${o.change.card}):`, o.lines)}${line}`;
  },
  async to_ved(o, waited) {
    if (o.reason === 'started') {
      return withLines(
        waitedWord('📨 VED bu so‘rov ustida ishlayapti — qo‘shimchangiz VED ga yuborildi, o‘zgartirishni VED o‘zi kiritadi:', waited),
        o.lines,
      );
    }
    if (o.reason === 'lead_closed') {
      return withLines(waitedWord('📨 Lid yopilgan — qo‘shimchangiz so‘rovga yozilmadi, VED ga yozildi.', waited), o.lines);
    }
    return waitedWord(closedWords(o.ending), waited);
  },
  async waiting(o) {
    return withLines(
      `⏳ AI hali hisoblayapti — qo‘shimchangiz saqlandi va AI tugatgach so‘rovga avtomatik yoziladi (${o.change.card}):`,
      o.lines,
    );
  },
  async noted(o) {
    return withLines(
      `📎 Qo‘shimcha kartaga qo‘shildi va VED ga yozildi (${o.change.card}) — so‘rovdagi qatorlar o‘zgarmadi, AI qayta hisoblamaydi.`,
      o.lines,
    );
  },
};

/** Words for any told outcome, by its kind (exported for the tests that read them). */
export function amendWords(o: Told, waited: boolean): Promise<string> {
  return (OUTCOME_WORDS[o.kind] as (o: Told, waited: boolean) => Promise<string>)(o, waited);
}

/** The outcome a stored row records, rebuilt — what a redo says when the words were never sent. */
async function toldOfRow(row: CalcAmendmentRow): Promise<Told | null> {
  const { amendChangeText } = await import('../../wms/calc/amend');
  const change = row.change as AmendChange;
  const fileCount = (row.submission as AmendSubmission).fileCount;
  const lines = amendChangeText(change, fileCount);
  switch (row.outcome) {
    case 'applied':
      return { kind: 'applied', amendmentId: row.id, rev: row.rev ?? 0, queued: change.repassQueued === true, lines, change };
    case 'to_ved':
      return {
        kind: 'to_ved',
        amendmentId: row.id,
        reason: change.told?.reason ?? 'started',
        ending: change.told?.ending ?? null,
        returnReason: change.told?.returnReason ?? null,
        lines,
        change,
      };
    case 'waiting':
      return { kind: 'waiting', amendmentId: row.id, lines, change, stillWaiting: false };
    case 'noted':
      return { kind: 'noted', amendmentId: row.id, lines, change };
    default:
      return null;
  }
}

/**
 * One save job — under the reading's two fences (durability-15): an
 * in-process set of note ids in flight (a second run of the same note in this
 * process returns at once; the first one answers), and ONE wall clock checked
 * between steps. A job fetched before this process restored its collections
 * waits for that (`loadIntake`, durability-9) — or throws, never answering
 * off an empty memory.
 */
export async function runAmendSave(data: AmendSaveJob, retryCount: number): Promise<void> {
  const g = globalThis as unknown as { __calcAmendInFlight?: Set<string> };
  const inFlight = (g.__calcAmendInFlight ??= new Set<string>());
  if (inFlight.has(data.noteId)) return;
  inFlight.add(data.noteId);
  try {
    await runAmendSaveOnce(data, retryCount);
  } finally {
    inFlight.delete(data.noteId);
  }
}

async function runAmendSaveOnce(data: AmendSaveJob, retryCount: number): Promise<void> {
  const deadline = Date.now() + AMEND_SAVE_DEADLINE_MS;
  const chatId = BigInt(data.chatId);
  // A stored «waiting» addition the job writes later: no collection is its.
  const waitedRun = data.amendmentId !== null;
  const last = retryCount >= AMEND_SAVE_RETRIES;
  if (!waitedRun) await loadIntake(chatId);
  const amend = await import('../../wms/calc/amend');
  let outcome: AmendOutcome;
  try {
    outcome = await amend.amendRequest({
      requestId: data.requestId,
      staffId: data.staffId,
      staffName: await amend.staffNameOf(data.staffId),
      noteId: data.noteId,
      chatId,
      submission: data.submission,
      ...(waitedRun ? { waitingId: data.amendmentId! } : {}),
    });
  } catch (err) {
    if (isServerBehind(err)) {
      logger.warn({ err, requestId: data.requestId }, '[calc-amend] save met a schema one release behind');
      if (!waitedRun) {
        releaseSaving(chatId, data.noteId);
        await sendWords(chatId, `Qo‘shib bo‘lmadi: ${AMEND_REFUSAL.server_behind}`);
      }
      return;
    }
    if (last && !waitedRun) {
      releaseSaving(chatId, data.noteId);
      await sendWords(chatId, SAVE_WORDS.failed);
    }
    throw err;
  }
  // Past the job's own clock: the write (if any) is committed — a retry finds
  // it (`duplicate`) and redoes only what is missing.
  if (Date.now() > deadline) throw new Error('amend save deadline');

  switch (outcome.kind) {
    case 'applied':
    case 'to_ved':
    case 'noted':
    case 'waiting': {
      // A stored addition whose pass is still running stays stored, unsaid.
      if (outcome.kind === 'waiting' && outcome.stillWaiting) return;
      const sent = await sendWords(chatId, await amendWords(outcome, waitedRun));
      // Not delivered and worth another try: the retry is a `duplicate` and
      // says exactly these words, once.
      if (!sent.ok && !sent.permanent) throw new Error('amend words not delivered');
      await amend.stampTold(outcome.amendmentId);
      if (!waitedRun) endIfOurs(chatId, data.noteId);
      return;
    }
    case 'duplicate':
      await redo(chatId, data, outcome.row, waitedRun);
      return;
    case 'empty':
      if (!waitedRun) {
        releaseSaving(chatId, data.noteId);
        await sendWords(chatId, SAVE_WORDS.empty);
      }
      return;
    case 'refused':
      if (!waitedRun) {
        releaseSaving(chatId, data.noteId);
        await sendWords(chatId, `Qo‘shib bo‘lmadi: ${AMEND_REFUSAL[outcome.code]}`);
      }
      return;
    case 'not_yours':
    case 'not_found':
      if (!waitedRun) {
        endIfOurs(chatId, data.noteId);
        await sendWords(chatId, outcome.kind === 'not_yours' ? ADD_REFUSAL.notYours : ADD_REFUSAL.notFound);
      }
      return;
    default: {
      const never: never = outcome;
      void never;
    }
  }
}

/**
 * A repeat of one note redoes only what is missing (durability-5): the
 * re-pass and the ping (wms's), then the seller's words when they were never
 * sent, then the collection. Words already said are not said twice; a
 * collection still frozen on this note hears that it was sent.
 */
async function redo(chatId: bigint, data: AmendSaveJob, stored: CalcAmendmentRow, waitedRun: boolean): Promise<void> {
  const amend = await import('../../wms/calc/amend');
  const row = await amend.redoAmendment(stored, data.staffId);
  const target = waitedRun ? row.chatId : chatId;
  if (row.outcomeSentAt === null) {
    const told = await toldOfRow(row);
    if (told) {
      const sent = await sendWords(target, await amendWords(told, waitedRun));
      if (!sent.ok && !sent.permanent) throw new Error('amend words not delivered');
      await amend.stampTold(row.id);
    }
  } else if (!waitedRun && activeIntake(chatId)?.noteId === data.noteId) {
    await sendWords(chatId, SAVE_WORDS.already);
  }
  if (!waitedRun) endIfOurs(chatId, data.noteId);
}

/** The save's queue and its one worker (boss.ts registers it). */
export async function registerCalcAmendSaveWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_AMEND_SAVE);
  await boss.work<AmendSaveJob>(JOB_CALC_AMEND_SAVE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runAmendSave(job.data, job.retryCount ?? 0);
  });
}

/** Re-exported for the reply door's media branch and the tests. */
export type { AmendBase };
