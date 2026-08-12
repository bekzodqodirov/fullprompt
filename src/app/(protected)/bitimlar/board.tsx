'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage } from '@/components/kanban';
import { MetaLine } from '@/components/board-meta';
import { useMoveErrors } from '@/components/move-errors';
import { BulkBar } from '@/components/list/bulk-bar';
import { useSelection } from '@/components/list/selection';
import { bulkMoveDealsAction, moveDealAction } from './actions';

export interface BoardDeal {
  id: string;
  stageId: string;
  /** Where the owner put it in its column; null = nobody has (0075). */
  boardOrder: number | null;
  code: string;
  title: string | null;
  clientCode: string;
  clientName: string;
  ownerName: string | null;
  quotedAmount: string | null;
  quotedCurrency: string | null;
  /** Cubic metres quoted — off the card by default, switchable on. */
  quotedVolumeM3: string | null;
  quotedWeightKg: string | null;
  /** What the cargo is: the first goods line, or the typed title. */
  goods: string | null;
  /** How many more goods lines there are beyond the first. */
  goodsExtra: number;
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
  fields,
}: {
  stages: KanbanStage[];
  deals: BoardDeal[];
  /** Finished deals left off the board, per stage (round 47). */
  hidden?: Record<string, number>;
  archiveHref?: string;
  /** Which switchable lines this browser wants; code + title are never in it. */
  fields: Set<string>;
}) {
  // No bulk «assign», deliberately: a deal's owner is who is carrying the job
  // right now and changing it is a conversation, not a sweep. Stage moves are
  // the thing that happens twenty at a time (a truck lands, a batch is paid).
  // A STORE, not React state (round 70) — see `useSelection`: as state, a tick
  // re-rendered every card on the board to change one checkbox.
  const selection = useSelection();
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
        selection={{ store: selection, label: tl('select') }}
        hrefOf={(deal) => `/bitimlar/${deal.id}`}
        onMove={async (id, stageId, reason, beforeId) => {
          const result = await moveDealAction(id, stageId, reason, beforeId);
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
          nextStage: t('nextStage'),
          moveUp: tcrm('moveUp'),
          moveDown: tcrm('moveDown'),
        }}
        // The same five slots as the funnel card, so a person who works both
        // boards in one hour forms ONE habit for where each thing lives.
        renderCard={(deal) => (
          <>
            {/* WHO — the CLIENT CODE, and it is the biggest thing on the card.
                The owner reads the code, not the name: «GS code kattada
                yozilib klient ismi juda kichkinada yozilsa ham bo'ladi …
                klient kodi muhim». So the code is the identity line and the
                name drops to the muted row below, where it is a reminder
                rather than a heading. Our own deal number rides alongside it,
                small — it identifies the card in a link, not to a reader. */}
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono font-bold [overflow-wrap:anywhere]">
                {deal.clientCode}
              </span>
              <span className="font-mono text-[11px] text-ink-500">{deal.code}</span>
            </div>
            {/* WHAT — «tovar nomi muhim». The first goods line if hisoblash has
                filed any, otherwise the title somebody typed; «+N» when there
                are more goods than one line can hold. */}
            {deal.goods && (
              <div className="text-xs text-ink-700 [overflow-wrap:anywhere]">
                {deal.goods}
                {deal.goodsExtra > 0 && <span className="text-ink-400"> +{deal.goodsExtra}</span>}
              </div>
            )}
            {/* MONEY on its own full-width row and ALWAYS present, so the eye
                finds the number in the same place on every card and a column
                scans as a column. Sharing row 1 with the code is why it broke
                as «200.00 USD» / «· 0.06 m³» on the desktop board.
                An unpriced deal shows a dash here and nothing else: the words
                «no price» belong to the alarm row below, which used to say the
                same thing a second time in a second colour. */}
            {fields.has('amount') &&
              (deal.quotedAmount ? (
                // Summa · kub · kg on one line — the owner asked for all
                // three ON the card (round 73), so they are one fact, not
                // three switches.
                <div className="mt-1 font-mono text-xs font-bold tabular-nums">
                  {[
                    `${Number(deal.quotedAmount).toLocaleString('ru-RU')} ${deal.quotedCurrency}`,
                    deal.quotedVolumeM3 && `${Number(deal.quotedVolumeM3)} m³`,
                    deal.quotedWeightKg && `${Number(deal.quotedWeightKg)} kg`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : (
                <div className="mt-1 font-mono text-xs text-ink-400" title={t('notQuoted')}>
                  —
                </div>
              ))}
            <MetaLine
              parts={[
                // The client's NAME, kept small and kept here: the owner reads
                // the code, but a name is what tells two similar codes apart
                // when somebody is not sure. «Klient ismi juda kichkinada
                // yozilsa ham bo'ladi» — so it rides with the rest.
                fields.has('code') ? <span key="client">{deal.clientName}</span> : null,
                fields.has('owner') && deal.ownerName ? (
                  <span key="owner">{deal.ownerName}</span>
                ) : null,
                // The chat, on the card (owner, round 25).
                fields.has('chat') && deal.chat ? (
                  <span
                    key="chat"
                    className={deal.chat === 'waiting' ? 'font-semibold text-warn' : ''}
                  >
                    💬{deal.chat === 'waiting' && ' !'}
                  </span>
                ) : null,
              ]}
            />
            {/* The one line the board exists to surface. */}
            {fields.has('alarms') && deal.flag === 'deviation' && (
              <div className="mt-1 text-[11px] font-bold text-bad">
                ⚖️ {deal.flagPct !== null && deal.flagPct > 0 ? '+' : ''}
                {deal.flagPct?.toFixed(0)} % · {t('deviation')}
              </div>
            )}
            {fields.has('alarms') && deal.flag === 'unpriced' && (
              <div className="mt-1 text-[11px] font-bold text-bad">💰❓ {t('unpriced')}</div>
            )}
            {fields.has('alarms') && deal.deferred && (
              <div className="mt-1 text-[11px] font-semibold text-warn">⏳ {t('deferred')}</div>
            )}
          </>
        )}
      />

      <BulkBar
        selection={selection}
        stages={stages}
        onMove={(ids, stageId, reason) => bulkMoveDealsAction(ids, stageId, reason)}
      />
    </>
  );
}
