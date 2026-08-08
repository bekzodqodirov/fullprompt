import { getTranslations } from 'next-intl/server';
import { CardFacts } from '@/components/card-fact';

/**
 * What a lead IS, readable without opening anything.
 *
 * Until round 61 the rail carried no facts at all: a salesperson wanting the
 * phone number of the person they were about to ring had to unfold the ✏️
 * form and read it out of an input. That is what this block fixes, and all it
 * does — every one of these values is READ here and written in the ✏️ form
 * below.
 *
 * Nothing on this card turns into an input when pressed (owner, 2026-08-07:
 * «contactlarni ustiga bosib o'zgartirish featureni … hammasini olib
 * tashla»). The name went first, one round earlier, for the reason that ended
 * up applying to all of them: a card is read far more often than it is
 * corrected, and a value that becomes an editor under a thumb is a value
 * nobody can read safely.
 *
 * Round 76 took the height out of it (owner: «umumiy inoflari mobileda
 * boshqacharoq ihcham dizayda bolsin» — nine rows, 474 px, above everything
 * the card is opened for). Two rows are gone because the screen already
 * carries them: the NAME is the page's h1 a hundred pixels above, and the
 * STAGE is the chip on the fold at the top, which is printed whether that
 * fold is open or shut. The rest is `CardFacts`: an empty fact costs one
 * word on a shared line instead of a row of its own — except the phone,
 * which is printed even when it is missing, because a lead nobody can ring
 * is the thing a seller has to notice.
 */
export async function LeadFacts({
  values,
  sourceName,
  ownerName,
  quote,
  nextAction,
}: {
  values: { phone: string; company: string; note: string };
  sourceName: string;
  ownerName: string;
  /** «1 500 USD · 12 m³ · 3 400 kg» — empty until hisoblatish has answered. */
  quote: string;
  nextAction: string;
}) {
  const t = await getTranslations('crm');
  const tc = await getTranslations('common');

  return (
    <div className="card" data-testid="lead-facts">
      <CardFacts
        missingLabel={tc('notFilled')}
        facts={[
          { label: t('phone'), value: values.phone, testId: 'fact-phone', always: true, tel: true },
          { label: t('company'), value: values.company, testId: 'fact-company' },
          { label: t('note'), value: values.note, testId: 'fact-note' },
          { label: t('quotedAmount'), value: quote, testId: 'fact-quote' },
          { label: t('source'), value: sourceName, testId: 'fact-source' },
          { label: t('owner'), value: ownerName, testId: 'fact-owner' },
          { label: t('nextAction'), value: nextAction, testId: 'fact-next' },
        ]}
      />
    </div>
  );
}
