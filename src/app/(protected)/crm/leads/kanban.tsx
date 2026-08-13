'use client';

import { useTranslations } from 'next-intl';
import { KanbanBoard as Board, type KanbanStage } from '@/components/kanban';
import { MetaLine } from '@/components/board-meta';
import { useMoveErrors } from '@/components/move-errors';
import { BulkBar } from '@/components/list/bulk-bar';
import { useSelection } from '@/components/list/selection';
import { bulkAssignLeadsAction, bulkMoveLeadsAction, moveLeadAction } from '../actions';

export type { KanbanStage };

export interface KanbanLead {
  id: string;
  stageId: string;
  /** Where the owner put it in its column; null = nobody has (0075). */
  boardOrder: number | null;
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
  today,
  lostReasons,
}: {
  stages: KanbanStage[];
  leads: KanbanLead[];
  /** Finished leads left off the board, per stage (round 47). */
  hidden?: Record<string, number>;
  archiveHref?: string;
  /** Who a lead may be handed to; absent means no bulk assign is offered. */
  owners?: { id: string; name: string }[];
  /** The owner's lost-reason list; non-empty replaces the free-text prompt. */
  lostReasons?: string[];
  /** Which switchable lines this browser wants; the name is never in it. */
  fields: Set<string>;
  /**
   * The server's own «today», `YYYY-MM-DD`, for colouring the follow-up date.
   * It comes down as a prop rather than being read from `new Date()` here so
   * the server's HTML and the browser's first render agree — a component that
   * computes its own today paints a different colour after hydration for
   * anyone whose clock has crossed midnight against the server's.
   */
  today: string;
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
        lostReasons={lostReasons}
        items={leads}
        cardTestId="lead-card"
        selection={{ store: selection, label: tl('select') }}
        hrefOf={(lead) => `/crm/leads/${lead.id}`}
        // The action answers `{ ok?: boolean; error?: string }`. The CODE
        // travels with the verdict now: a card that jumps back under the word
        // «Xatolik» is the screen asking somebody to guess which of five
        // things went wrong.
        onMove={async (id, stageId, reason, beforeId) => {
          const result = await moveLeadAction(id, stageId, reason, beforeId);
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
          nextStage: t('nextStage'),
          moveUp: t('moveUp'),
          moveDown: t('moveDown'),
        }}
        // Five slots, always in this order, on both board shapes: WHO / WHAT /
        // MONEY / META / WHEN. The old card put company, phone, source, owner,
        // code and chat in four different typographic costumes across three
        // rows; a reader could not tell which grey word was the client's firm
        // and which was our salesman. One rule now: identity is the only
        // semibold line, money is the only mono line, everything descriptive
        // rides ONE muted line joined by « · », and colour is spent only on
        // urgency — the stage's own colours are drawn by the board, so a
        // second green/amber grammar on the card was two meanings for one hue.
        renderCard={(lead) => (
          <>
            {/* The NAME is not switchable. A card with nothing on it is not a
                card, and half the browser suite finds a board card by it.
                Deliberately NOT clamped: #571 measured and refused truncating
                the one field that says which record this is. */}
            <div className="font-semibold [overflow-wrap:anywhere]">{lead.name}</div>
            {fields.has('company') && lead.company && (
              // overflow-wrap because a company name can be one 45-character
              // token with no break opportunity, which takes the card past the
              // viewport and rescales the whole page (#400).
              <div className="text-xs text-ink-700 [overflow-wrap:anywhere]">{lead.company}</div>
            )}
            {/* The price the funnel now runs on (round 71): written after
                hisoblatish, read at a glance on the way to won/lost. Mono and
                tabular like every other number in the app — `.num` is not used
                because it forces text-right. */}
            {fields.has('quote') && lead.quotedAmount && (
              <div className="mt-1 font-mono text-xs font-bold tabular-nums">
                {[
                  `${Number(lead.quotedAmount).toLocaleString('ru-RU')} ${lead.quotedCurrency ?? 'USD'}`,
                  lead.quotedVolumeM3 && `${Number(lead.quotedVolumeM3)} m³`,
                  lead.quotedWeightKg && `${Number(lead.quotedWeightKg)} kg`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
            <MetaLine
              parts={[
                fields.has('code') && lead.clientCode ? (
                  <span key="code" className="font-mono font-semibold">
                    {lead.clientCode}
                  </span>
                ) : null,
                fields.has('phone') && lead.phone ? (
                  <span key="phone" className="font-mono">
                    {lead.phone}
                  </span>
                ) : null,
                fields.has('source') && lead.sourceName ? (
                  <span key="source">{lead.sourceName}</span>
                ) : null,
                fields.has('owner') && lead.ownerName ? (
                  <span key="owner">{lead.ownerName}</span>
                ) : null,
                // The chat, on the card (owner, round 25) — and whether it
                // waits on us, which is the one thing here that is urgent.
                fields.has('chat') && lead.chat ? (
                  <span
                    key="chat"
                    className={lead.chat === 'waiting' ? 'font-semibold text-warn' : ''}
                  >
                    💬{lead.chat === 'waiting' && ' !'}
                  </span>
                ) : null,
              ]}
            />
            {/* Coloured by lateness, not permanently amber: an orange date on
                every scheduled lead teaches the eye to skip the one colour the
                card uses for «act now». The column is a plain date, so the
                comparison is against the server's own today (UTC days, the
                convention /bugun measures against — round 47). */}
            {fields.has('nextAction') && lead.nextActionAt && (
              <div
                className={`mt-1 text-[11px] font-semibold ${
                  lead.nextActionAt < today
                    ? 'text-bad'
                    : lead.nextActionAt === today
                      ? 'text-warn'
                      : 'text-ink-500'
                }`}
              >
                📅 {lead.nextActionAt}
              </div>
            )}
          </>
        )}
      />

      <BulkBar
        selection={selection}
        lostReasons={lostReasons}
        stages={stages}
        owners={owners}
        onMove={(ids, stageId, reason) => bulkMoveLeadsAction(ids, stageId, reason)}
        onAssign={owners ? (ids, ownerId) => bulkAssignLeadsAction(ids, ownerId) : undefined}
      />
    </>
  );
}
