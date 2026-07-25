'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { moveLeadAction } from '../../actions';
import { stageClass } from '../../stage-color';

/**
 * One tap per stage.
 *
 * A dropdown would hide the funnel behind a click; the whole point of a
 * funnel is that you can see where the deal is and where it goes next. A
 * lost stage asks why before it moves — that answer is the only thing that
 * makes a lost-deal list worth reading later.
 */
export function StageMover({
  leadId,
  currentId,
  stages,
}: {
  leadId: string;
  currentId: string;
  stages: { id: string; name: string; kind: string; color: string }[];
}) {
  const t = useTranslations('crm');
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap gap-1.5">
      {stages.map((stage) => {
        const active = stage.id === currentId;
        return (
          <button
            key={stage.id}
            type="button"
            disabled={pending || active}
            data-testid={`stage-${stage.kind}`}
            onClick={() => {
              let reason = '';
              if (stage.kind === 'lost') {
                reason = window.prompt(t('lostReason')) ?? '';
                if (reason.trim().length < 2) return;
              }
              start(async () => {
                await moveLeadAction(leadId, stage.id, reason);
              });
            }}
            className={`rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-100 ${
              active ? `${stageClass(stage.color)} ring-2 ring-blue-600` : stageClass(stage.color)
            } ${pending ? 'opacity-50' : ''}`}
          >
            {stage.name}
          </button>
        );
      })}
    </div>
  );
}
