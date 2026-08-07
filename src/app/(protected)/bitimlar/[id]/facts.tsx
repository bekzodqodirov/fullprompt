import { getTranslations } from 'next-intl/server';

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
 */
export async function DealFacts({ title, note }: { title: string; note: string }) {
  const t = await getTranslations('deals');

  return (
    <div className="card" data-testid="deal-facts">
      <Fact label={t('dealTitle')} value={title} testId="fact-deal-title" />
      <Fact label={t('note')} value={note} testId="fact-deal-note" />
    </div>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="border-b border-line/70 py-1.5 last:border-b-0" data-testid={testId}>
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</div>
      <p className={`whitespace-pre-wrap text-sm ${value ? '' : 'text-ink-400'}`}>{value || '—'}</p>
    </div>
  );
}
