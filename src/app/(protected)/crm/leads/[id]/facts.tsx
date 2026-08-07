import { getTranslations } from 'next-intl/server';

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
 */
export async function LeadFacts({
  values,
  stageName,
  sourceName,
  ownerName,
  quote,
  nextAction,
}: {
  values: { name: string; phone: string; company: string; note: string };
  stageName: string;
  sourceName: string;
  ownerName: string;
  /** «1 500 USD · 12 m³ · 3 400 kg» — empty until hisoblatish has answered. */
  quote: string;
  nextAction: string;
}) {
  const t = await getTranslations('crm');

  return (
    <div className="card" data-testid="lead-facts">
      <Fact label={t('name')} value={values.name} testId="fact-name" />
      <Fact label={t('phone')} value={values.phone} testId="fact-phone" />
      <Fact label={t('company')} value={values.company} testId="fact-company" />
      <Fact label={t('note')} value={values.note} testId="fact-note" />
      <Fact label={t('quotedAmount')} value={quote} testId="fact-quote" />
      <Fact label={t('stage')} value={stageName} testId="fact-stage" />
      <Fact label={t('source')} value={sourceName} testId="fact-source" />
      <Fact label={t('owner')} value={ownerName} testId="fact-owner" />
      <Fact label={t('nextAction')} value={nextAction} testId="fact-next" />
    </div>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="border-b border-line/70 py-1.5 last:border-b-0" data-testid={testId}>
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</div>
      {/* pre-wrap: a note written on several lines is read on several lines. */}
      <p className={`whitespace-pre-wrap text-sm ${value ? '' : 'text-ink-400'}`}>{value || '—'}</p>
    </div>
  );
}
