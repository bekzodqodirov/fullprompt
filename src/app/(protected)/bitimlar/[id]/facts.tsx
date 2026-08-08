import { getTranslations } from 'next-intl/server';
import { CardFacts } from '@/components/card-fact';

/**
 * What a deal is CALLED, and what somebody wrote down about it.
 *
 * The title was only in the page heading and the note was nowhere at all —
 * you had to unfold the ✏️ form to read either. They sit at the top of the
 * rail now, above the quote-versus-actual block.
 *
 * Read-only, like every fact on every card (owner, 2026-08-07): the ✏️ form
 * below is where a deal is corrected. The quote was never offered here even
 * when the facts were editable — the amount, the sizes and the currency are
 * the number a client was told, and `updateDeal` stamps who said it and when.
 *
 * The row itself is shared with the lead card (round 76, `CardFacts`): it was
 * the same component written out twice, so the fix for a long value rescaling
 * the page had been made in neither. The TITLE stays here even though the
 * header prints it too — the header falls back to the client's code when a
 * deal has no title, so it is not the unconditional duplicate the lead's name
 * was, and dropping it is the owner's call rather than mine.
 */
export async function DealFacts({ title, note }: { title: string; note: string }) {
  const t = await getTranslations('deals');
  const tc = await getTranslations('common');

  return (
    <div className="card" data-testid="deal-facts">
      <CardFacts
        missingLabel={tc('notFilled')}
        facts={[
          { label: t('dealTitle'), value: title, testId: 'fact-deal-title' },
          { label: t('note'), value: note, testId: 'fact-deal-note' },
        ]}
      />
    </div>
  );
}
