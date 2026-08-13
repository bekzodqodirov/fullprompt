'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { Selection } from './selection';

export interface BulkStage {
  id: string;
  name: string;
  kind: string;
}

export interface BulkOutcome {
  ok?: boolean;
  done?: number;
  failed?: number;
  error?: string;
}

/**
 * The bar that appears once cards are ticked.
 *
 * It sits over the board rather than in it (the crate builder's shape), and
 * it reports COUNTS: twenty cards can include one that has moved on since the
 * board was drawn, and «19 moved, 1 refused» is the truth. A single red line
 * would either hide the nineteen that worked or claim a failure that did not
 * happen.
 *
 * A `lost` stage demands a reason here exactly as it does on one card — the
 * reason box appears when a lost stage is chosen, and the service refuses the
 * move without it whatever this screen sends.
 */
export function BulkBar({
  selection,
  stages,
  owners,
  onMove,
  onAssign,
  lostReasons,
}: {
  /**
   * The tick store (round 70). The bar reads the COUNT from it and the ids at
   * press time — the board's parent no longer holds either, which is what
   * stopped a tick from re-rendering 596 cards.
   */
  selection: Selection;
  stages: BulkStage[];
  /** Only the leads board has an owner to hand work to. */
  owners?: { id: string; name: string }[];
  onMove: (ids: string[], stageId: string, reason: string) => Promise<BulkOutcome>;
  onAssign?: (ids: string[], ownerId: string) => Promise<BulkOutcome>;
  /**
   * The owner's lost-reason list (round 98). Non-empty, the reason box is a
   * select of these — the service refuses anything else once the list exists,
   * so a free box here would be an input that can only fail.
   */
  lostReasons?: string[];
}) {
  const t = useTranslations('lists');
  const count = selection.useCount();
  const onClear = selection.clear;
  const [pending, start] = useTransition();
  const [stageId, setStageId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkOutcome | null>(null);

  const chosen = stages.find((stage) => stage.id === stageId);
  const needsReason = chosen?.kind === 'lost';

  function run(work: () => Promise<BulkOutcome>) {
    setResult(null);
    start(async () => {
      const outcome = await work();
      setResult(outcome);
      // Only a clean run clears the selection: leaving the ticks on after a
      // partial failure is what lets somebody try the ones that refused.
      if (outcome.ok) {
        setReason('');
        setStageId('');
        setOwnerId('');
        onClear();
      }
    });
  }

  // The bar outlives the selection by one press. A clean run clears the
  // ticks, and returning null on an empty selection took the answer away with
  // them: you pressed «Bajarish» and the bar vanished without ever saying
  // what it had done.
  if (count === 0 && !result) return null;

  return (
    <div
      data-testid="bulk-bar"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-raised p-3 shadow-pop md:bottom-4 md:left-1/2 md:w-[40rem] md:-translate-x-1/2 md:rounded-2xl md:border"
    >
      <div className={`flex flex-wrap items-center gap-2 ${count === 0 ? 'hidden' : ''}`}>
        <span className="chip chip-brand shrink-0" data-testid="bulk-count">
          {t('selected', { n: count })}
        </span>

        <select
          className="input !w-40"
          value={stageId}
          aria-label={t('moveTo')}
          data-testid="bulk-stage"
          onChange={(event) => setStageId(event.target.value)}
        >
          <option value="">{t('moveTo')}</option>
          {stages.map((stage) => (
            // `data-kind` so a test can name the lost column without knowing
            // what the owner called it, in whichever of four languages.
            <option key={stage.id} value={stage.id} data-kind={stage.kind}>
              {stage.name}
            </option>
          ))}
        </select>

        {needsReason &&
          (lostReasons && lostReasons.length > 0 ? (
            <select
              className="input !w-44"
              value={reason}
              aria-label={t('lostReason')}
              data-testid="bulk-reason"
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="">{t('lostReason')}</option>
              {lostReasons.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input !w-44"
              value={reason}
              placeholder={t('lostReason')}
              aria-label={t('lostReason')}
              data-testid="bulk-reason"
              onChange={(event) => setReason(event.target.value)}
            />
          ))}

        <button
          type="button"
          disabled={pending || !stageId || (needsReason && reason.trim().length < 2)}
          data-testid="bulk-move"
          onClick={() => run(() => onMove(selection.ids(), stageId, reason))}
          className="btn-primary !min-h-10"
        >
          {t('doMove')}
        </button>

        {owners && onAssign && (
          <>
            <select
              className="input !w-40"
              value={ownerId}
              aria-label={t('assignTo')}
              data-testid="bulk-owner"
              onChange={(event) => setOwnerId(event.target.value)}
            >
              <option value="">{t('assignTo')}</option>
              {owners.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !ownerId}
              data-testid="bulk-assign"
              onClick={() => run(() => onAssign(selection.ids(), ownerId))}
              className="btn-secondary !min-h-10"
            >
              {t('doAssign')}
            </button>
          </>
        )}

        <button
          type="button"
          onClick={onClear}
          data-testid="bulk-clear"
          className="btn-ghost !min-h-10"
        >
          {t('clearSelection')}
        </button>
      </div>

      {result && (
        <p
          data-testid="bulk-result"
          className={`flex items-center gap-2 text-sm ${count === 0 ? '' : 'mt-2'} ${
            result.failed ? 'text-warn' : 'text-good'
          }`}
        >
          {/* Counts, and one fixed sentence when some refused. The service's
              code is deliberately NOT rendered HERE, and the reason is about
              this screen rather than about codes: a sweep can refuse twenty
              rows for twenty reasons, and the ticks are still on screen to
              retry one at a time. A single DRAGGED card has no such second
              chance, so the board does name its refusal — `useMoveErrors` in
              components/kanban.tsx, a literal map for exactly the #163 reason
              this comment used to give. */}
          <span className="flex-1">
            {t('bulkDone', { done: result.done ?? 0, failed: result.failed ?? 0 })}
            {result.failed ? ` · ${t('bulkSomeRefused')}` : ''}
          </span>
          <button
            type="button"
            aria-label={t('clearSelection')}
            data-testid="bulk-dismiss"
            onClick={() => setResult(null)}
            className="btn-ghost btn-icon !min-h-8 shrink-0"
          >
            ✕
          </button>
        </p>
      )}
    </div>
  );
}
