'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';
import { LostReasonDialog } from '@/components/lost-reason-dialog';
import { WonDialog, type WonDialogLead } from '@/components/won-dialog';
import { useMoveErrors } from '@/components/move-errors';
import { moveLeadAction } from '../../actions';
import { stageClass } from '../../stage-color';

/**
 * Where the lead IS, where it goes NEXT, and every other stage one tap away.
 *
 * This was one button per stage, always open. At eight stages that is four
 * rows and 170 px at 360 px, sitting on top of everything a salesperson opens
 * the card to do (owner, round 76: «varonka kartasini ichidagi etaplar
 * colapse bolsin»).
 *
 * The comment that stood here argued the opposite — that a fold «would hide
 * the funnel behind a click, and the whole point of a funnel is that you can
 * see where the deal is and where it goes next». That objection is answered
 * rather than overruled: the SUMMARY carries both halves of it, the current
 * stage as its own chip and the forward move as the button the boards have
 * had since round 14. Only the jump to a non-adjacent stage folds away.
 *
 * A lost stage still asks why before it moves — that answer is the only thing
 * that makes a lost-deal list worth reading later.
 */
export function StageMover({
  leadId,
  currentId,
  stages,
  lostReasons,
  defaultName,
  clientCode,
}: {
  leadId: string;
  currentId: string;
  stages: { id: string; name: string; kind: string; color: string }[];
  /** The owner's lost-reason list; non-empty replaces the free-text prompt. */
  lostReasons?: string[];
  /** Prefill for the won dialog's mint mode (round 107). */
  defaultName: string;
  /** The lead's client code when it already has one — confirm-only win. */
  clientCode: string | null;
}) {
  const t = useTranslations('crm');
  const router = useRouter();
  const moveErrors = useMoveErrors();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  // A lost move waiting for its reason to be picked from the dictionary.
  const [pendingLostId, setPendingLostId] = useState<string | null>(null);
  // A won move waiting for its ceremony — the client and the deal (round 107).
  const [pendingWon, setPendingWon] = useState<WonDialogLead | null>(null);

  const current = stages.find((stage) => stage.id === currentId);
  const next = stages[stages.findIndex((stage) => stage.id === currentId) + 1];

  function go(stage: { id: string; kind: string }) {
    let reason = '';
    if (stage.kind === 'won') {
      setPendingWon({ id: leadId, defaultName, clientCode, stageId: stage.id });
      return;
    }
    if (stage.kind === 'lost') {
      if (lostReasons && lostReasons.length > 0) {
        setPendingLostId(stage.id);
        return;
      }
      reason = window.prompt(t('lostReason')) ?? '';
      if (reason.trim().length < 2) return;
    }
    commit(stage.id, reason);
  }

  function commit(stageId: string, reason: string) {
    setError('');
    start(async () => {
      // A refused move used to be a tap that did nothing: the action's coded
      // refusal was awaited and thrown away. The boards learned to say it in
      // #512 and this door was not included.
      const res = await moveLeadAction(leadId, stageId, reason);
      if (res?.error) setError(moveErrors[res.error] ?? res.error);
    });
  }

  return (
    <div className="space-y-1.5">
      {/* key: the move revalidates SOFTLY (crm/actions.ts), so React would
          keep whatever `open` the reader left behind — remounting on the new
          stage shuts the fold on the answer it was opened to give. */}
      <details key={currentId} className="card !p-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-3 marker:content-none">
          <span
            className={`max-w-[40%] shrink-0 truncate rounded-lg border px-2 py-1 text-sm font-semibold ${stageClass(
              current?.color ?? 'gray',
            )}`}
            data-testid="stage-current"
          >
            {current?.name}
          </span>
          {next && (
            <button
              type="button"
              disabled={pending}
              data-testid="stage-next"
              // preventDefault, or the click bubbles to the <summary> and the
              // fold opens under the finger that has just moved the lead.
              onClick={(event) => {
                event.preventDefault();
                go(next);
              }}
              className="btn-secondary min-w-0 flex-1 !justify-start"
            >
              <Icon name="chevronRight" className="h-4 w-4 shrink-0" />
              <span className="truncate">{next.name}</span>
            </button>
          )}
          {/* The testid is on the ⋯ and NOT on the summary: Playwright clicks
              an element's centre, and the centre of this row is the move
              button beside it. */}
          <span
            data-testid="stage-fold"
            aria-label={t('moveTo')}
            className="btn-secondary btn-icon shrink-0"
          >
            ⋯
          </span>
        </summary>
        <div className="flex flex-wrap gap-1.5 border-t border-line p-3">
          {stages.map((stage) => {
            const active = stage.id === currentId;
            return (
              <button
                key={stage.id}
                type="button"
                disabled={pending || active}
                data-testid={`stage-${stage.kind}`}
                onClick={() => go(stage)}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-100 ${
                  active ? `${stageClass(stage.color)} ring-2 ring-brand-500` : stageClass(stage.color)
                } ${pending ? 'opacity-50' : ''}`}
              >
                {stage.name}
              </button>
            );
          })}
        </div>
      </details>
      {/* Outside the fold: a refusal from the summary's own button has to be
          readable with the fold shut. */}
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="stage-move-error">
          {error}
        </p>
      )}
      {lostReasons && lostReasons.length > 0 && (
        <LostReasonDialog
          open={Boolean(pendingLostId)}
          reasons={lostReasons}
          title={t('lostReason')}
          closeLabel={t('cancelMove')}
          onPick={(reason) => {
            const stageId = pendingLostId;
            setPendingLostId(null);
            if (stageId) commit(stageId, reason);
          }}
          onCancel={() => setPendingLostId(null)}
        />
      )}
      <WonDialog
        open={Boolean(pendingWon)}
        lead={pendingWon}
        onClose={() => setPendingWon(null)}
        onWon={() => {
          setPendingWon(null);
          router.refresh();
        }}
      />
    </div>
  );
}
