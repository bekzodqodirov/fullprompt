'use client';

import { useTranslations } from 'next-intl';
import { InlineField } from '@/components/inline-field';
import { patchDealFieldAction } from '../actions';

/**
 * What a deal is CALLED, and what somebody wrote down about it.
 *
 * The title was only in the page heading and the note was nowhere at all —
 * you had to unfold the ✏️ form to read either. They sit at the top of the
 * rail now, above the quote-versus-actual block, and are correctable where
 * they are read.
 *
 * The quote is NOT here and never will be: the amount, the sizes and the
 * currency are the number a client was told, and `updateDeal` stamps who said
 * it and when. That stamp is the deal's whole reason for existing, so
 * re-pricing keeps the form that does it properly.
 */
export function DealFacts({
  dealId,
  editable,
  title,
  note,
}: {
  dealId: string;
  editable: boolean;
  title: string;
  note: string;
}) {
  const t = useTranslations('deals');
  const save = (field: string) => (next: string) => patchDealFieldAction(dealId, field, next);

  return (
    <div className="card" data-testid="deal-facts">
      <InlineField
        label={t('dealTitle')}
        value={title}
        editable={editable}
        testId="fact-deal-title"
        onSave={save('title')}
      />
      <InlineField
        label={t('note')}
        value={note}
        multiline
        editable={editable}
        testId="fact-deal-note"
        onSave={save('note')}
      />
    </div>
  );
}
