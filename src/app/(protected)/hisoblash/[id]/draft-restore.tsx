'use client';

import { useTranslations } from 'next-intl';
import { restorableCount, type RestorePlan } from '@/modules/wms/calc/draft-store';
import { useFieldWord } from './field-words';

/**
 * His B5 a, in his own words: «Saqlanmagan o'zgarishlar bor — tiklaymi?».
 *
 * NEVER applied by itself. What a closed tab left behind is offered; what a
 * colleague changed meanwhile is NAMED and not offered (restoring it would
 * overwrite them unseen); what his own save already landed is counted and
 * blamed on nobody. Shown in the bar area at both widths — the drafts are one
 * state behind two renders.
 */
export function DraftRestore({
  plan,
  onRestore,
  onDiscard,
}: {
  plan: RestorePlan;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations('calc');
  const word = useFieldWord();
  const count = restorableCount(plan);
  return (
    <div className="card space-y-1 !p-3 text-sm" data-testid="calc-restore">
      {count > 0 ? <p className="font-semibold">{t('restore.prompt', { count })}</p> : null}
      {plan.skipped.length > 0 ? (
        <p className="text-2xs text-warn" data-testid="calc-restore-skipped">
          {t('restore.skipped', {
            rows: plan.skipped.map((s) => `${s.seq}: ${word(s.field)} ${s.before} → ${s.after}`).join('; '),
          })}
        </p>
      ) : null}
      {plan.alreadySaved > 0 ? (
        <p className="text-2xs text-ink-500" data-testid="calc-restore-saved">
          {t('restore.alreadySaved', { count: plan.alreadySaved })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {count > 0 ? (
          <button type="button" className="btn-primary !min-h-11" data-testid="calc-restore-yes" onClick={onRestore}>
            {t('restore.yes')}
          </button>
        ) : null}
        <button type="button" className="btn-secondary !min-h-11" data-testid="calc-restore-no" onClick={onDiscard}>
          {t('restore.no')}
        </button>
      </div>
    </div>
  );
}
