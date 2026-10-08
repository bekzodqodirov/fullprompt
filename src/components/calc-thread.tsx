import { getTranslations } from 'next-intl/server';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { calcThreadMessages } from '@/modules/wms/crm/thread';
import { CalcThreadBox } from './calc-thread-box';
import { ThreadBubbles } from './thread-bubbles';

/**
 * One calculation's Q&A — the list and its composer (§3.5). ONE component
 * with two mounts, the calc page's «❓ Savol-javob» and the card's fold, so
 * the VED and the seller read the same list from the same read (#513).
 *
 * E5 a: ONLY that calculation's messages (`calc_request_id`), never the
 * card's other notes. The bubbles are `ThreadBubbles` — one look for every
 * thread, the prixod's and the truck's included (round 2).
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
      <ThreadBubbles messages={messages} viewerId={viewerId} prefix="calc-thread" emptyText={t('empty')} />
      {composer ? <CalcThreadBox requestId={requestId} people={await mentionablePeople()} hint={hint} /> : null}
    </div>
  );
}
