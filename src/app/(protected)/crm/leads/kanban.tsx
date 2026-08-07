'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage, useMoveErrors } from '@/components/kanban';
import { BulkBar } from '@/components/list/bulk-bar';
import { useSelection } from '@/components/list/selection';
import { bulkAssignLeadsAction, bulkMoveLeadsAction, moveLeadAction } from '../actions';

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
  /** The service price after hisoblatish (round 71); numeric arrives a string. */
  quotedAmount: string | null;
  quotedCurrency: string | null;
  quotedVolumeM3: string | null;
  quotedWeightKg: string | null;
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
  owners,
  fields,
}: {
  stages: KanbanStage[];
  leads: KanbanLead[];
  /** Finished leads left off the board, per stage (round 47). */
  hidden?: Record<string, number>;
  archiveHref?: string;
  /** Who a lead may be handed to; absent means no bulk assign is offered. */
  owners?: { id: string; name: string }[];
  /** Which switchable lines this browser wants; the name is never in it. */
  fields: Set<string>;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const moveErrors = useMoveErrors();
  const tl = useTranslations('lists');
  // The SELECTION lives here, not in the shared board: only this screen knows
  // what «assign to» means for a lead, so the actions and the ticks that feed
  // them belong together. It is a STORE and not React state (round 70): as
  // state, every tick re-rendered this component and through it all 596 live
  // cards, which is the freeze the owner reported.
  const selection = useSelection();

  return (
    <>
      <Board
        stages={stages}
        hidden={hidden}
        archiveHref={archiveHref}
        items={leads}
        cardTestId="lead-card"
        selection={{ store: selection, label: tl('select') }}
        hrefOf={(lead) => `/crm/leads/${lead.id}`}
        // The action answers `{ ok?: boolean; error?: string }`. The CODE
        // travels with the verdict now: a card that jumps back under the word
        // «Xatolik» is the screen asking somebody to guess which of five
        // things went wrong.
        onMove={async (id, stageId, reason) => {
          const result = await moveLeadAction(id, stageId, reason);
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
          showAll: t('showAll'),
        }}
        renderCard={(lead) => (
          <>
            {/* The NAME is not switchable. A card with nothing on it is not a
                card, and half the browser suite finds a board card by it. */}
            <div className="font-semibold [overflow-wrap:anywhere]">{lead.name}</div>
            {fields.has('company') && lead.company && (
              <div className="text-xs text-ink-700">{lead.company}</div>
            )}
            {fields.has('phone') && lead.phone && (
              <div className="font-mono text-xs">{lead.phone}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
              {fields.has('source') && lead.sourceName && (
                <span className="rounded bg-surface-sunken px-1.5">{lead.sourceName}</span>
              )}
              {fields.has('owner') && lead.ownerName && <span>{lead.ownerName}</span>}
              {fields.has('code') && lead.clientCode && (
                <span className="font-mono font-bold text-good">{lead.clientCode}</span>
              )}
              {/* The chat, on the card (owner, round 25) — and whether it waits on us. */}
              {fields.has('chat') && lead.chat && (
                <span className={lead.chat === 'waiting' ? 'font-semibold text-warn' : ''}>
                  💬{lead.chat === 'waiting' && ' !'}
                </span>
              )}
            </div>
            {/* The price the funnel now runs on (round 71): written after
                hisoblatish, read at a glance on the way to won/lost. */}
            {fields.has('quote') && lead.quotedAmount && (
              <div className="mt-1 text-[12px] font-bold tabular-nums text-good">
                {[
                  `${Number(lead.quotedAmount).toLocaleString('ru-RU')} ${lead.quotedCurrency ?? 'USD'}`,
                  lead.quotedVolumeM3 && `${Number(lead.quotedVolumeM3)} m³`,
                  lead.quotedWeightKg && `${Number(lead.quotedWeightKg)} kg`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            {fields.has('nextAction') && lead.nextActionAt && (
              <div className="mt-1 text-[11px] font-semibold text-warn">📅 {lead.nextActionAt}</div>
            )}
          </>
        )}
      />

      <BulkBar
        selection={selection}
        stages={stages}
        owners={owners}
        onMove={(ids, stageId, reason) => bulkMoveLeadsAction(ids, stageId, reason)}
        onAssign={owners ? (ids, ownerId) => bulkAssignLeadsAction(ids, ownerId) : undefined}
      />
    </>
  );
}
