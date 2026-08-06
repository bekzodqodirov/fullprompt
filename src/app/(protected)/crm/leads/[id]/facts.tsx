'use client';

import { useTranslations } from 'next-intl';
import { InlineField } from '@/components/inline-field';
import { patchLeadFieldAction } from '../../actions';

/**
 * What a lead IS, readable without opening anything.
 *
 * Until now the rail carried no facts at all: a salesperson wanting the phone
 * number of the person they were about to ring had to unfold the ✏️ form and
 * read it out of an input. The facts are the top of the rail now, and the
 * plain-text ones are correctable where they are read.
 *
 * The NAME is not one of them (owner, 2026-08-06: «lead kartochkasida nomni
 * ustiga bosib o'zgartirish … buni umuman olib tashla»). It is the one field
 * on this card that is also its TITLE — the `<h1>` sits directly above this
 * rail — so nothing is hidden by making it read-only, and a tap on a record's
 * title should never turn the title into an input. It is still correctable in
 * the ✏️ form, where changing what a record is called is a deliberate act.
 *
 * The other five stay in the form on purpose too — a stage is a move, an owner
 * is a handover, and the follow-up date and its note are written as a pair, so
 * a one-field patch of either leaves a stale reminder on a new date.
 */
export function LeadFacts({
  leadId,
  editable,
  values,
  stageName,
  sourceName,
  ownerName,
  quote,
  nextAction,
}: {
  leadId: string;
  editable: boolean;
  values: { name: string; phone: string; company: string; note: string };
  stageName: string;
  sourceName: string;
  ownerName: string;
  /** «1 500 USD · 12 m³ · 3 400 kg» — empty until hisoblatish has answered. */
  quote: string;
  nextAction: string;
}) {
  const t = useTranslations('crm');
  const save = (field: string) => (next: string) =>
    patchLeadFieldAction(leadId, field, next);

  return (
    <div className="card" data-testid="lead-facts">
      <ReadOnly label={t('name')} value={values.name} />
      <InlineField
        label={t('phone')}
        value={values.phone}
        editable={editable}
        testId="fact-phone"
        onSave={save('phone')}
      />
      <InlineField
        label={t('company')}
        value={values.company}
        editable={editable}
        testId="fact-company"
        onSave={save('company')}
      />
      <InlineField
        label={t('note')}
        value={values.note}
        multiline
        editable={editable}
        testId="fact-note"
        onSave={save('note')}
      />

      {/* Read-only here, and each has its own control elsewhere on the card:
          the stage chips above, the ✏️ form below — the quote too, because a
          price is written deliberately, not corrected on a tap. */}
      <ReadOnly label={t('quotedAmount')} value={quote} />
      <ReadOnly label={t('stage')} value={stageName} />
      <ReadOnly label={t('source')} value={sourceName} />
      <ReadOnly label={t('owner')} value={ownerName} />
      <ReadOnly label={t('nextAction')} value={nextAction} />
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-line/70 py-1.5 last:border-b-0">
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</div>
      <p className={`text-sm ${value ? '' : 'text-ink-400'}`}>{value || '—'}</p>
    </div>
  );
}
