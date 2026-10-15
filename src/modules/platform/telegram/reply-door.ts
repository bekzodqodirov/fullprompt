import type { Context } from 'grammy';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, tasks } from '../db/schema';
import { isServerBehind } from '../db/errors';
import { logger } from '../logger';
import { reachLine } from '../notifications/staff';
import {
  THREAD_PING_TYPES,
  THREAD_UUID,
  isCargoKind,
  threadOfPayload,
  type ThreadPingType,
  type ThreadRef,
} from '../notifications/thread-ref';
import { onceKey, readyKey } from './once';
import {
  answerFromBot,
  askFromBot,
  botActorFor,
  dropTaskPending,
  peekTaskPendingAny,
  refusalFor,
  staffForChat,
  type ReachedResult,
} from './staff-bot';

/**
 * The reply door: a Telegram reply to a ping lands back where the ping came
 * from (the owner's E2 a, E3 a, E4 a, 2026-10-07).
 *
 * The bot NEVER trusts an id from the chat. A reply names the message it
 * answers; that message is resolved to the person's OWN notification row by
 * the `payload.tg` the drain wrote when it sent it (`{chatId, messageId}`,
 * notifications/service.ts) — another person's ping can never be named, and a
 * row's word for its thread is then re-checked against the thread's door.
 *
 * NO age window, on purpose: nothing prunes `notifications`, the door is
 * re-asked at reply time, and a window only turned an old ping into «no row»,
 * which falls through to the paid AI.
 */

/** What the replied-to message was. */
export type ReplyVerdict =
  | { kind: 'thread'; ref: ThreadRef; ping: ThreadPingType }
  /** E3 a — the VED's own bound «Hisoblash: …» task copy: a question to the seller. */
  | { kind: 'calc_task'; requestId: string; taskId: string }
  /** E4 a — any other task copy of the assignee's: a question to the giver, the task stays open. */
  | { kind: 'task_question'; taskId: string }
  /** The author's copy of a question: the reply IS the answer. */
  | { kind: 'task_answer'; taskId: string }
  /** A thread ping sent before 0127 — it names no thread. */
  | { kind: 'old_ping' }
  /** A customer's own message (`ClientBotMessage`) — a reply here reaches nobody. */
  | { kind: 'customer' }
  /** A row of any other type. */
  | { kind: 'not_replyable' };

/** The sentences (Uzbek, like every staff message). */
export const REPLY_SENTENCES = {
  old_ping: 'Bu xabar yangilanishdan oldin yuborilgan — javobni kartaning o‘zida yozing.',
  not_replyable: 'Bu xabarga javob tizimga tushmaydi. Savolni kartada yozing yoki «➕ Topshiriq» bering.',
  customer:
    'Bu mijozning xabari — bu yerdan mijozga javob bormaydi. Mijozga kartadagi chatdan yoki o‘z Telegramingizdan yozing.',
  forwarded:
    'Bu yo‘naltirilgan (forward) xabar — javob tizimga tushmaydi. Asosiy xabarga reply qiling; mijozga esa kartadagi chatdan yozing.',
  waitNoTarget: 'Xabar topilmadi — javobni kartada yozing.',
  mediaCard: 'Hozircha javob faqat matn bilan qabul qilinadi — rasm yoki faylni kartaning o‘zida qo‘shing.',
  // A prixod's or a truck's thread has no 📎 on the card either (E10 a):
  // «add it on the card» would send the person to a box that refuses files.
  mediaCargo: 'Bu yozishmaga hozircha faqat matn yoziladi (rasm keyingi bosqichda) — javobni matn bilan yozing.',
  mediaTask:
    'Hozircha javob faqat matn bilan qabul qilinadi — savolni matn bilan yozing, faylni topshiriq sahifasida qo‘shing.',
  pressPrompt: '💬 Javobingizni yozing:',
  otherResultPending:
    'Eslatma: boshqa topshiriq natijasi hali kutilmoqda — keyingi oddiy xabaringiz natija bo‘ladi.',
  serverBehind: 'Tizim yangilanmoqda — birozdan keyin qaytadan yozing.',
  notLinked: 'Ulanmagan',
} as const;

/**
 * A live calc intake refuses the «💬 Javob yozish» press — the calc intake has
 * no exported sentence of its own (the draft's is `BUSY_DRAFT`, the zametka's
 * `refuseWhileCapturing`). A live collector sits above the one-text wait in
 * the ladder and would eat the next text, leaving the armed reply wait to
 * catch a LATER unrelated text as a reply.
 */
export const BUSY_INTAKE = 'Avval hisoblatishni tugating yoki bekor qiling.';

/** The task copies a reply turns into a question (E4 a) or, for a bound calc task, into the calc thread (E3 a). */
const ASSIGNEE_COPIES = ['TaskAssigned', 'TaskReminder', 'TaskAnswer'];

/**
 * Which ping the replied-to message was — the person's OWN row, by the
 * message id the drain stored. Null = no such row (a bot prompt, a lookup
 * answer, a forwarded original — the drain stores only the sentence after it).
 */
export async function replyVerdictFor(
  chatId: bigint,
  messageId: number,
  staffId?: string,
): Promise<ReplyVerdict | null> {
  const who = staffId ?? (await staffForChat(chatId))?.id;
  if (!who) return null;
  const [row] = await db
    .select({ type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        // The chat's own person — never anybody else's ping.
        eq(notifications.userId, who),
        eq(notifications.channel, 'telegram'),
        eq(notifications.status, 'sent'),
        sql`${notifications.payload} -> 'tg' ->> 'chatId' = ${chatId.toString()}`,
        sql`${notifications.payload} -> 'tg' ->> 'messageId' = ${String(messageId)}`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (!row) return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if ((THREAD_PING_TYPES as readonly string[]).includes(row.type)) {
    const thread = threadOfPayload(payload);
    return thread
      ? { kind: 'thread', ref: { kind: thread.kind, id: thread.id }, ping: row.type as ThreadPingType }
      : { kind: 'old_ping' };
  }
  if (row.type === 'ClientBotMessage') return { kind: 'customer' };
  const taskId = typeof payload.taskId === 'string' && THREAD_UUID.test(payload.taskId) ? payload.taskId : null;
  if (taskId && row.type === 'TaskQuestion') return { kind: 'task_answer', taskId };
  if (taskId && ASSIGNEE_COPIES.includes(row.type)) {
    // The TASK's word for what it is, never the payload's (a payload is
    // whatever was true when the copy was queued).
    const [task] = await db
      .select({ origin: tasks.origin, boundId: tasks.boundId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) return { kind: 'not_replyable' };
    if (task.origin === 'calc' && task.boundId) {
      return { kind: 'calc_task', requestId: task.boundId, taskId };
    }
    return { kind: 'task_question', taskId };
  }
  return { kind: 'not_replyable' };
}

/**
 * The sentence a photo, file or voice reply to this verdict is refused with —
 * or null when the verdict is not one this door owns (the handler falls
 * through). A cargo thread's words are its own: its card has no 📎 either.
 * Pure; the cargo test is `isCargoKind`, never a kind literal.
 */
export function mediaSentenceFor(verdict: ReplyVerdict): string | null {
  switch (verdict.kind) {
    case 'thread':
      return isCargoKind(verdict.ref.kind) ? REPLY_SENTENCES.mediaCargo : REPLY_SENTENCES.mediaCard;
    case 'calc_task':
      return REPLY_SENTENCES.mediaCard;
    case 'task_question':
    case 'task_answer':
      return REPLY_SENTENCES.mediaTask;
    case 'old_ping':
    case 'customer':
    case 'not_replyable':
      return null;
    default: {
      const never: never = verdict;
      void never;
      return null;
    }
  }
}

/** The sentence a refused or unlandable verdict reads — or null when it is one that lands. */
export function verdictSentence(verdict: ReplyVerdict): string | null {
  if (verdict.kind === 'old_ping') return REPLY_SENTENCES.old_ping;
  if (verdict.kind === 'customer') return REPLY_SENTENCES.customer;
  if (verdict.kind === 'not_replyable') return REPLY_SENTENCES.not_replyable;
  return null;
}

/** «✅ Savol yuborildi.» — and, when the other side will not hear it, who and why (spec §4 of the topshiriq round). */
function reachedText(done: string, out: ReachedResult): string {
  const line = out.reach ? reachLine(out.name ?? 'Hodim', out.reach) : null;
  return line ? `${done}\n${line}` : done;
}

/**
 * A text reply to a bot message, from a staff chat. Null = NOT HANDLED, and
 * the ladder falls through unchanged; otherwise the answer to send. Never
 * throws — every failure is a sentence.
 *
 * The order is the design:
 *   1. a chat with no colleague behind it is not handled;
 *   2. THE ARMED WAIT WINS: people press «✅ Bajarildi» / «💬 Savol» and then
 *      swipe-reply to the very message they pressed (or to its prompt). That
 *      text is the wait's — a result closes the task, a question is asked once
 *      — and turning it into a thread reply would leave the wait armed to
 *      swallow the NEXT text (the judge's blocker). Not applied when this is
 *      the reply wait itself being served (`fromWait`);
 *   3. no row: a reply to a FORWARDED message (a customer's original or a
 *      task's sources — the drain keeps no id for those) is told so; any other
 *      bot message (a prompt, a lookup) falls through untouched — except from
 *      the reply wait, which must answer in words;
 *   4. a thread ping lands in its thread; the VED's bound calc task copy lands
 *      in that calculation's Q&A (E3 a — never through `askAboutTask`, which
 *      refuses an open calc job); another task copy asks the giver (E4 a);
 *      the author's question copy answers it;
 *   5. after ANY landing an armed reply wait is dropped — one gesture, one
 *      landing — and a result wait for ANOTHER task is named, so the person
 *      knows their next plain text closes it.
 */
export async function threadReplyFromBot(
  chatId: bigint,
  input: {
    replyToMessageId: number;
    replyToForwarded: boolean;
    text: string;
    incomingMessageId: number;
    /**
     * The incoming message's own `date` (unix seconds), REQUIRED (Q5 a): a
     * backlog reply is judged against the wait by when it was WRITTEN, and
     * lands on the card at that moment.
     */
    messageDate: number;
    /** True when called from the 'reply' wait (the person pressed «💬 Javob yozish»): never fall through. */
    fromWait?: boolean;
  },
): Promise<{ text: string } | null> {
  try {
    const staff = await staffForChat(chatId);
    if (!staff) return null;
    // Step 2 over the wait AND how this message relates to it (judge Q5H-3):
    // an EARLY wait — a ✅ pressed during the outage, its prompt sent after
    // this backlog reply was written — guards exactly like an armed one, so
    // the reply falls to the wait (which stays) and never becomes an E4
    // question carrying the result text.
    const seen = input.fromWait ? null : peekTaskPendingAny(chatId, input.messageDate);
    const pending = seen?.verdict === 'answers' ? seen.pending : null;
    const armed = seen && seen.pending.kind !== 'reply' ? seen.pending : null;
    if (
      armed &&
      (armed.pressed?.messageId === input.replyToMessageId ||
        (armed.promptMessageId ?? null) === input.replyToMessageId)
    ) {
      return null;
    }

    const verdict = await replyVerdictFor(chatId, input.replyToMessageId, staff.id);
    if (armed && verdict !== null && 'taskId' in verdict && verdict.taskId === armed.taskId) return null;
    if (!verdict) {
      if (input.replyToForwarded) return { text: REPLY_SENTENCES.forwarded };
      return input.fromWait ? { text: REPLY_SENTENCES.waitNoTarget } : null;
    }
    const refused = verdictSentence(verdict);
    if (refused) return { text: refused };

    let answer: string;
    if (verdict.kind === 'thread' || verdict.kind === 'calc_task') {
      const actor = await botActorFor(chatId);
      if (!actor) return { text: REPLY_SENTENCES.notLinked };
      // platform never imports wms statically — the landing is wms's.
      const { landThreadReply } = await import('../../wms/crm/thread-reply');
      // The WHOLE actor: the cargo door is a question about where he works,
      // and `botActorFor` already carries the scope (`actorGrants`).
      const out = await landThreadReply(
        actor,
        {
          ref: verdict.kind === 'thread' ? verdict.ref : { kind: 'calc', id: verdict.requestId },
          ping: verdict.kind === 'thread' ? verdict.ping : 'calc_task',
          text: input.text,
          tg: { chatId, messageId: input.incomingMessageId },
          writtenAt: new Date(input.messageDate * 1000).toISOString(),
        },
      );
      answer = out.text;
    } else if (verdict.kind === 'task_question') {
      // E4 a: a question to the task's giver — the task stays OPEN. Every
      // refusal has its words (`refusalFor` — an open calc job's carries its page).
      // Keyed by the incoming message (Q5 a): a redelivered reply asks once.
      // The SAME effect name as the wait's question — one message is one
      // question whichever door took it.
      const out = await askFromBot(
        chatId,
        verdict.taskId,
        input.text,
        input.incomingMessageId ? await readyKey(() => onceKey.message(chatId, input.incomingMessageId, 'ask')) : null,
        new Date(input.messageDate * 1000),
      );
      answer =
        out.result === 'done' ? reachedText('✅ Savol yuborildi.', out) : await refusalFor(verdict.taskId, out.result);
    } else if (verdict.kind === 'task_answer') {
      const out = await answerFromBot(
        chatId,
        verdict.taskId,
        input.text,
        input.incomingMessageId ? await readyKey(() => onceKey.message(chatId, input.incomingMessageId, 'answer')) : null,
        new Date(input.messageDate * 1000),
      );
      answer =
        out.result === 'done' ? reachedText('✅ Javob yuborildi.', out) : await refusalFor(verdict.taskId, out.result);
    } else {
      // `verdictSentence` answered every other kind above; said, never dropped.
      return { text: REPLY_SENTENCES.not_replyable };
    }

    if (pending?.kind === 'reply') dropTaskPending(chatId);
    if (pending?.kind === 'result') answer = `${answer}\n${REPLY_SENTENCES.otherResultPending}`;
    return { text: answer };
  } catch (err) {
    // A database that is a release behind, or a blip: the same sentence —
    // «send it again in a moment» is the right advice for both.
    logger.warn({ err, chatId: chatId.toString(), behind: isServerBehind(err) }, '[thread] reply door failed');
    return { text: REPLY_SENTENCES.serverBehind };
  }
}

/**
 * A photo, a file or a voice note sent as a REPLY to a thread or task ping
 * (E10 a — text first). Asked only after every collector declined it (a live
 * draft's photo joins the draft), immediately before the handler's last
 * `next()`. True = refused in words and handled; false = not a reply this
 * door owns, and the handler falls through as today.
 */
export async function refuseMediaReply(ctx: Context, chatId: bigint): Promise<boolean> {
  const replied = ctx.message?.reply_to_message;
  if (!replied || replied.from?.id !== ctx.me?.id) return false;
  try {
    const staff = await staffForChat(chatId);
    if (!staff) return false;
    const verdict = await replyVerdictFor(chatId, replied.message_id, staff.id);
    if (!verdict) return false;
    const sentence = mediaSentenceFor(verdict);
    if (!sentence) return false;
    await ctx.reply(sentence);
    return true;
  } catch (err) {
    logger.warn({ err }, '[thread] media reply check failed');
    return false;
  }
}
