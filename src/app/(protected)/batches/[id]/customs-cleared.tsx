'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setCustomsClearedAction } from '../batch-actions-server';

/**
 * «Rastamojka tugadi» — one tap, and the only thing in the system that knows
 * a declaration cleared.
 *
 * It sits inside the customs panel rather than beside the map's position pins
 * on purpose: those three answer «where is the truck» and each of them
 * re-anchors the map's clock, while this one answers «is the paperwork done»
 * and moves no estimate at all. Its reader is the customs manager, whose
 * panel this is.
 *
 * Pressing it again clears the stamp, because a person who marked the wrong
 * truck must be able to say so — and because the customer's timeline reads
 * NULL as «nobody has said», never as «not cleared».
 */
export function CustomsCleared({
  batchId,
  clearedAt,
  canEdit,
}: {
  batchId: string;
  clearedAt: Date | null;
  canEdit: boolean;
}) {
  const t = useTranslations('batches');
  const [pending, startTransition] = useTransition();

  const stamp = clearedAt
    ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(
        new Date(clearedAt),
      )
    : null;

  if (!canEdit) {
    return (
      <div className="text-sm" data-testid="customs-cleared-read">
        {stamp ? `✅ ${t('customsCleared')} · ${stamp}` : `⏳ ${t('customsPending')}`}
      </div>
    );
  }

  return (
    <form
      action={(fd) => startTransition(() => setCustomsClearedAction(fd))}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="batchId" value={batchId} />
      <button
        type="submit"
        disabled={pending}
        // The pressed state carries its own date, so the button IS the record
        // — there is no second line to read and no way for the two to differ.
        className={`flex-1 whitespace-nowrap rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
          clearedAt ? 'border-good bg-good/10 text-good' : 'border-line text-ink-700'
        }`}
        data-testid="customs-cleared"
      >
        {clearedAt ? `✅ ${t('customsCleared')} · ${stamp}` : `🛃 ${t('customsClearedSet')}`}
      </button>
    </form>
  );
}
