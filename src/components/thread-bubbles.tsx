import { getFormatter, getTranslations } from 'next-intl/server';
import type { ThreadMessage } from '@/modules/wms/crm/thread';

/**
 * A staff thread's message list — ONE bubble look for every thread (#513):
 * the calculation's Q&A (`prefix="calc-thread"`) and the prixod's and the
 * truck's «❓ Savol-javob» (`prefix="cargo-thread"`). Bubbles the lenta's way:
 * the reader's own on the right, the tone REPLACED rather than appended (two
 * background utilities resolve by stylesheet order), and every body wraps — a
 * pasted unbroken token must not widen the phone page (#570). The testids are
 * the prefix's, so the calc DOM is byte-identical to what it was.
 */
export async function ThreadBubbles({
  messages,
  viewerId,
  prefix,
  emptyText,
}: {
  messages: ThreadMessage[];
  viewerId: string;
  prefix: string;
  emptyText: string;
}) {
  const t = await getTranslations('threads');
  const format = await getFormatter();
  if (messages.length === 0) {
    return (
      <p className="text-sm text-ink-500" data-testid={`${prefix}-empty`}>
        {emptyText}
      </p>
    );
  }
  return (
    <div className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto" data-testid={`${prefix}-list`}>
      {messages.map((message) => {
        const own = message.authorId === viewerId;
        return (
          <div
            key={message.id}
            className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${own ? 'ml-auto bg-brand-50' : 'bg-surface-sunken'}`}
            data-testid={`${prefix}-message`}
          >
            <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
              <span className="font-semibold">{message.authorName ?? '—'}</span>
              <span className="whitespace-nowrap">
                {format.dateTime(message.at, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              {message.viaTelegram ? (
                <span className="chip chip-neutral" data-testid={`${prefix}-via-telegram`}>
                  {t('viaTelegram')}
                </span>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
          </div>
        );
      })}
    </div>
  );
}
