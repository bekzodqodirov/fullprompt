'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage } from '@/components/kanban';
import { moveDealAction } from './actions';

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
export function DealBoard({ stages, deals }: { stages: KanbanStage[]; deals: BoardDeal[] }) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');

  return (
    <Board
      stages={stages}
      items={deals}
      cardTestId="deal-card"
      hrefOf={(deal) => `/bitimlar/${deal.id}`}
      onMove={async (id, stageId, reason) => ({
        ok: Boolean((await moveDealAction(id, stageId, reason)).ok),
      })}
      labels={{
        lostReason: t('lostReason'),
        moveTo: t('moveTo'),
        cancelMove: t('cancelMove'),
        prevStage: t('prevStage'),
        nextStage: t('nextStage'),
        dragHint: t('dragHint'),
        empty: t('empty'),
        error: tc('error'),
        itemsWord: t('deals'),
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
              <span className="ml-auto text-[11px] font-semibold text-warn">{t('notQuoted')}</span>
            )}
          </div>
          <div className="font-semibold [overflow-wrap:anywhere]">
            {deal.title || deal.clientName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
            <span className="num font-bold text-good">{deal.clientCode}</span>
            {deal.ownerName && <span>{deal.ownerName}</span>}
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
  );
}
