'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage, useMoveErrors } from '@/components/kanban';
import { BulkBar } from '@/components/list/bulk-bar';
import { bulkMoveDealsAction, moveDealAction } from './actions';

export interface BoardDeal {
  id: string;
  stageId: string;
  code: string;
  title: string | null;
  clientCode: string;
  clientName: string;
  ownerName: string | null;
  quotedAmount: string | null;
  quotedCurrency: string | null;
  deferred: boolean;
  /** Set when the cargo landed outside the threshold, or landed unpriced. */
  flag: 'deviation' | 'unpriced' | null;
  flagPct: number | null;
  /** The viewer holds a Telegram chat with this client; 'waiting' = client spoke last. */
  chat: 'waiting' | 'yes' | null;
}

/**
 * The deal board.
 *
 * The owner's people already know this shape from the lead funnel, so it is
 * the same board — the pointer handling lives in `components/kanban.tsx` and
 * only the card differs. What a deal card must say at a glance is not what a
 * lead card says: the client, the money, and above all whether this job has
 * gone WRONG, which is the reason the whole feature exists.
 */
export function DealBoard({
  stages,
  deals,
  hidden,
  archiveHref,
}: {
  stages: KanbanStage[];
  deals: BoardDeal[];
  /** Finished deals left off the board, per stage (round 47). */
  hidden?: Record<string, number>;
  archiveHref?: string;
}) {
  // No bulk «assign», deliberately: a deal's owner is who is carrying the job
  // right now and changing it is a conversation, not a sweep. Stage moves are
  // the thing that happens twenty at a time (a truck lands, a batch is paid).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const tl = useTranslations('lists');
  const t = useTranslations('deals');
  const tcrm = useTranslations('crm');
  const tc = useTranslations('common');
  const moveErrors = useMoveErrors();

  return (
    <>
      <Board
        stages={stages}
        hidden={hidden}
        archiveHref={archiveHref}
        items={deals}
        cardTestId="deal-card"
        selection={{ ids: picked, toggle, label: tl('select') }}
        hrefOf={(deal) => `/bitimlar/${deal.id}`}
        onMove={async (id, stageId, reason) => {
          const result = await moveDealAction(id, stageId, reason);
          return { ok: Boolean(result.ok), error: result.error };
        }}
        labels={{
          lostReason: t('lostReason'),
          moveTo: t('moveTo'),
          cancelMove: t('cancelMove'),
          dragHint: t('dragHint'),
          empty: t('empty'),
          error: tc('error'),
          moveErrors,
          showAll: tcrm('showAll'),
        }}
        renderCard={(deal) => (
          <>
            <div className="flex items-baseline gap-2">
              <span className="num text-xs font-bold text-ink-500">{deal.code}</span>
              {deal.quotedAmount ? (
                <span className="num ml-auto font-bold">
                  {deal.quotedAmount} {deal.quotedCurrency}
                </span>
              ) : (
                <span className="ml-auto text-[11px] font-semibold text-warn">
                  {t('notQuoted')}
                </span>
              )}
            </div>
            <div className="font-semibold [overflow-wrap:anywhere]">
              {deal.title || deal.clientName}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
              <span className="num font-bold text-good">{deal.clientCode}</span>
              {deal.ownerName && <span>{deal.ownerName}</span>}
              {/* The chat, on the card (owner, round 25). */}
              {deal.chat && (
                <span className={deal.chat === 'waiting' ? 'font-semibold text-warn' : ''}>
                  💬{deal.chat === 'waiting' && ' !'}
                </span>
              )}
            </div>
            {/* The one line the board exists to surface. */}
            {deal.flag === 'deviation' && (
              <div className="mt-1 text-[11px] font-bold text-bad">
                ⚖️ {deal.flagPct !== null && deal.flagPct > 0 ? '+' : ''}
                {deal.flagPct?.toFixed(0)} % · {t('deviation')}
              </div>
            )}
            {deal.flag === 'unpriced' && (
              <div className="mt-1 text-[11px] font-bold text-bad">💰❓ {t('unpriced')}</div>
            )}
            {deal.deferred && (
              <div className="mt-1 text-[11px] font-semibold text-warn">⏳ {t('deferred')}</div>
            )}
          </>
        )}
      />

      <BulkBar
        count={picked.size}
        stages={stages}
        onMove={(stageId, reason) => bulkMoveDealsAction([...picked], stageId, reason)}
        onClear={() => setPicked(new Set())}
      />
    </>
  );
}
