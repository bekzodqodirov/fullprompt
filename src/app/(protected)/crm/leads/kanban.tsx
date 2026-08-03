'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage } from '@/components/kanban';
import { moveLeadAction } from '../actions';

export type { KanbanStage };

export interface KanbanLead {
  id: string;
  stageId: string;
  name: string;
  company: string | null;
  phone: string | null;
  sourceName: string | null;
  ownerName: string | null;
  clientCode: string | null;
  nextActionAt: string | null;
  /** The viewer holds a Telegram chat with this client; 'waiting' = client spoke last. */
  chat: 'waiting' | 'yes' | null;
}

/**
 * The funnel board — the lead-shaped skin on the shared kanban.
 *
 * The board itself moved to `components/kanban.tsx` when the deal board
 * arrived: the two differ only in what a card SAYS, and a second copy of four
 * hundred lines of pointer handling would have been two boards that drift
 * apart at the first bug fix. What stays here is what is genuinely about
 * leads — the card, and which action moves one.
 */
export function KanbanBoard({
  stages,
  leads,
  hidden,
  archiveHref,
}: {
  stages: KanbanStage[];
  leads: KanbanLead[];
  /** Finished leads left off the board, per stage (round 47). */
  hidden?: Record<string, number>;
  archiveHref?: string;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');

  return (
    <Board
      stages={stages}
      hidden={hidden}
      archiveHref={archiveHref}
      items={leads}
      cardTestId="lead-card"
      hrefOf={(lead) => `/crm/leads/${lead.id}`}
      // The CRM actions answer `{ ok?: boolean; error?: string }`; the board
      // only asks "did it stick", and a missing `ok` means it did not.
      onMove={async (id, stageId, reason) => ({
        ok: Boolean((await moveLeadAction(id, stageId, reason)).ok),
      })}
      labels={{
        lostReason: t('lostReason'),
        moveTo: t('moveTo'),
        cancelMove: t('cancelMove'),
        dragHint: t('dragHint'),
        empty: t('empty'),
        error: tc('error'),
        showAll: t('showAll'),
      }}
      renderCard={(lead) => (
        <>
          <div className="font-semibold [overflow-wrap:anywhere]">{lead.name}</div>
          {lead.company && <div className="text-xs text-ink-700">{lead.company}</div>}
          {lead.phone && <div className="font-mono text-xs">{lead.phone}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
            {lead.sourceName && (
              <span className="rounded bg-surface-sunken px-1.5">{lead.sourceName}</span>
            )}
            {lead.ownerName && <span>{lead.ownerName}</span>}
            {lead.clientCode && (
              <span className="font-mono font-bold text-good">{lead.clientCode}</span>
            )}
            {/* The chat, on the card (owner, round 25) — and whether it waits on us. */}
            {lead.chat && (
              <span className={lead.chat === 'waiting' ? 'font-semibold text-warn' : ''}>
                💬{lead.chat === 'waiting' && ' !'}
              </span>
            )}
          </div>
          {lead.nextActionAt && (
            <div className="mt-1 text-[11px] font-semibold text-warn">📅 {lead.nextActionAt}</div>
          )}
        </>
      )}
    />
  );
}
