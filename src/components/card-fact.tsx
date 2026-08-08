/**
 * One fact on a card: a label, and the value under it.
 *
 * Shared because the lead card and the deal card carried the same component
 * twice, character for character — so the two things wrong with it had been
 * fixed in neither. A long unbroken value (an e-mail address pasted into a
 * note) pushed the card past 360 px, and mobile Chrome answers that by
 * zooming the WHOLE page out, which moves every tap target on it (#400).
 *
 * The row stays STACKED — label above value. Putting them on one line was
 * measured and refused: `ru` is the default locale and «СЛЕДУЮЩИЙ КОНТАКТ»
 * needs 165 px of the 294 px a phone has, so the compact row saves ~24 px on
 * a lead that has data and truncates in the language most staff read. The
 * height came from removing rows instead — the ones that print something the
 * screen already shows, and the empty ones.
 *
 * Read-only, and it must STAY read-only: `tests/unit/card-facts.test.ts`
 * covers this file for the same reason it covers its two callers (owner,
 * 2026-08-07: «contactlarni ustiga bosib o'zgartirish featureni … hammasini
 * olib tashla»).
 */

export interface CardFactDef {
  label: string;
  value: string;
  testId: string;
  /** Printed even when empty — a lead nobody can ring is itself the fact. */
  always?: boolean;
  /** Dialable: the value becomes a `tel:` link. */
  tel?: boolean;
}

export function CardFacts({
  facts,
  missingLabel,
}: {
  facts: CardFactDef[];
  missingLabel: string;
}) {
  const shown = facts.filter((fact) => fact.value || fact.always);
  const missing = facts.filter((fact) => !fact.value && !fact.always);

  return (
    <>
      {shown.map((fact) => (
        <Fact key={fact.testId} {...fact} />
      ))}
      {/* One line instead of four rows of «—». What is NOT filled in is still
          work — no price means hisoblatish has not answered yet — so it is
          named rather than dropped. */}
      {missing.length > 0 && (
        <p className="pt-1.5 text-2xs text-ink-400" data-testid="facts-missing">
          {missingLabel}: {missing.map((fact) => fact.label).join(', ')}
        </p>
      )}
    </>
  );
}

function Fact({ label, value, testId, tel }: CardFactDef) {
  return (
    <div className="border-b border-line/70 py-1 last:border-b-0" data-testid={testId}>
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</div>
      {/* pre-wrap: a note written on several lines is read on several lines.
          overflow-wrap: see the header — without it one long token rescales
          the entire page. */}
      <p
        className={`whitespace-pre-wrap text-sm [overflow-wrap:anywhere] ${
          value ? '' : 'text-ink-400'
        }`}
      >
        {tel && value ? (
          // The sales day is phone calls — «Bugun qo'ng'iroq», the call list,
          // the recorder app — and until now no number anywhere in the system
          // could be dialled by pressing it.
          <a href={`tel:${value.replace(/[^\d+]/g, '')}`} className="font-semibold text-brand-700">
            {value}
          </a>
        ) : (
          value || '—'
        )}
      </p>
    </div>
  );
}
