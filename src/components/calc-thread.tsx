import { getFormatter, getTranslations } from 'next-intl/server';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { calcThreadMessages } from '@/modules/wms/crm/thread';
import { CalcThreadBox } from './calc-thread-box';

/**
 * One calculation's Q&A — the list and its composer (§3.5). ONE component
 * with two mounts, the calc page's «❓ Savol-javob» and the card's fold, so
 * the VED and the seller read the same list from the same read (#513).
 *
 * E5 a: ONLY that calculation's messages (`calc_request_id`), never the
 * card's other notes. Bubbles the lenta's way: the reader's own on the right,
 * the tone REPLACED rather than appended (two background utilities resolve by
 * stylesheet order), and every body wraps — a pasted unbroken token must not
 * widen the phone page (#570).
 *
 * It CATCHES its own read: the tag is 0127's, and on a database one migration
 * behind the rest of the page must still render around one muted line.
 */
export async function CalcThread({
  requestId,
  viewerId,
  composer,
  hint = null,
}: {
  requestId: string;
  viewerId: string;
  /** Draw the box — whoever `mayWriteThread(calc)` admits; the caller asked. */
  composer: boolean;
  hint?: string | null;
}) {
  const t = await getTranslations('threads');
  const format = await getFormatter();
  let messages: Awaited<ReturnType<typeof calcThreadMessages>>;
  try {
    messages = await calcThreadMessages(requestId);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, requestId }, '[thread] calc thread: server behind');
    return (
      <p className="text-xs text-ink-500" data-testid="calc-thread-behind">
        {t('errors.server_behind')}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {messages.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="calc-thread-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto" data-testid="calc-thread-list">
          {messages.map((message) => {
            const own = message.authorId === viewerId;
            return (
              <div
                key={message.id}
                className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
                  own ? 'ml-auto bg-brand-50' : 'bg-surface-sunken'
                }`}
                data-testid="calc-thread-message"
              >
                <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                  <span className="font-semibold">{message.authorName ?? '—'}</span>
                  <span className="whitespace-nowrap">
                    {format.dateTime(message.at, { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  {message.viaTelegram ? (
                    <span className="chip chip-neutral" data-testid="calc-thread-via-telegram">
                      {t('viaTelegram')}
                    </span>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
              </div>
            );
          })}
        </div>
      )}
      {composer ? <CalcThreadBox requestId={requestId} people={await mentionablePeople()} hint={hint} /> : null}
    </div>
  );
}
