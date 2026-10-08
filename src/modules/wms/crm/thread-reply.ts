import { isServerBehind } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import type { ThreadPingType, ThreadRef } from '../../platform/notifications/thread-ref';
import { announceNote, cardLabel } from './internal-chat';
import { addThreadMessage, ThreadError } from './thread';
import { mayWriteThread, threadStanding } from './thread-door';

/**
 * A Telegram reply, landed on the card (the owner's E2 a, E3 a; the bot half
 * of the door is platform/telegram/reply-door.ts, which reaches this by
 * dynamic import — platform never imports wms statically).
 *
 * The door is the thread's own (`mayWriteThread`) with exactly two
 * exemptions, both re-derived from rows and never from the ping's payload:
 *   - the ping was a MENTION — E2 a: the named person may reply without the
 *     card (reply only; he sees nothing else of it);
 *   - the replier STANDS on the thread (`threadStanding`, G4 a): the record's
 *     current owner, and a calc request's non-CRM requester.
 * An InternalNote or CalcThread ping to somebody who lost the door since — the
 * handed-on seller (E9 a) — is refused in words.
 */

/** What the replied-to ping was: one of the thread's own, or the VED's bound calc task copy (E3 a). */
export type ReplyPing = ThreadPingType | 'calc_task';

export type ThreadReplyOutcome =
  | 'landed_card'
  | 'landed_calc'
  | 'duplicate'
  | 'no_door'
  | 'not_found'
  | 'empty'
  | 'too_long'
  | 'server_behind';

/**
 * Every outcome has its words — a `Record` over the closed union, so a new
 * code is a compile error and never a throw into `bot.catch` after the person
 * typed their answer (the `TASK_ANSWERS` idiom). `{label}` is filled below.
 */
export const THREAD_REPLY_WORDS: Record<ThreadReplyOutcome, string> = {
  landed_card: '✅ Javob kartaga yozildi: {label}',
  landed_calc: '✅ Hisob ostiga yozildi: {label}',
  duplicate: '✅ Bu javob allaqachon yozilgan.',
  no_door: 'Bu kartani endi ocha olmaysiz — javob yozilmadi.',
  not_found: 'Karta topilmadi — javob yozilmadi.',
  empty: 'Bo‘sh xabar.',
  too_long: 'Javob juda uzun — 4000 belgigacha yozing.',
  server_behind: 'Tizim yangilanmoqda — birozdan keyin qaytadan yozing.',
};

export async function landThreadReply(
  actor: { id: string; permissions: Set<string> },
  input: {
    ref: ThreadRef;
    ping: ReplyPing;
    text: string;
    tg: { chatId: bigint; messageId: number };
    /**
     * When the person WROTE it (Q5 a, ISO): a reply typed during a deploy is
     * filed at that moment on the card, not at the moment the bot came back.
     */
    writtenAt: string;
  },
): Promise<{ outcome: ThreadReplyOutcome; text: string }> {
  const say = (outcome: ThreadReplyOutcome, label = '') => ({
    outcome,
    text: THREAD_REPLY_WORDS[outcome].replace('{label}', label),
  });
  try {
    const admitted =
      (await mayWriteThread(actor, input.ref)) ||
      input.ping === 'MentionedInNote' ||
      (await threadStanding(actor.id, input.ref));
    if (!admitted) return say('no_door');

    const landed = await addThreadMessage(
      { ref: input.ref, body: input.text, tg: input.tg, writtenAt: input.writtenAt },
      { actorId: actor.id, ip: null, userAgent: null },
    );
    if (landed.duplicate) return say('duplicate');

    // Off the poller (#706): grammy's poller is sequential, and the announce
    // reads a permission set per recipient. A failure is logged, never thrown
    // at the person whose answer is already written.
    void announceNote({
      entityType: landed.entityType,
      entityId: landed.entityId,
      note: input.text.trim(),
      authorId: actor.id,
      activityId: landed.activityId,
      calcRequestId: landed.calcRequestId,
    }).catch((err: unknown) =>
      logger.warn({ err, activityId: landed.activityId }, '[thread] announce of a telegram reply failed'),
    );
    const label = await cardLabel(landed.entityType, landed.entityId).catch(() => '');
    return say(landed.calcRequestId ? 'landed_calc' : 'landed_card', label);
  } catch (err) {
    if (err instanceof ThreadError) {
      return say(err.code === 'forbidden' ? 'no_door' : err.code);
    }
    if (isServerBehind(err)) return say('server_behind');
    logger.error({ err }, '[thread] telegram reply not landed');
    return say('server_behind');
  }
}
