import type { ReactNode } from 'react';

/**
 * The card shape the owner asked for by naming where he had it before
 * (2026-07-28): "kartani ichiga kirganda … shu kartaga bog'liq chatlar,
 * tasklar, notelar oynaning bir tarafida, zametkalar va mijoz infolar
 * glavniyda turar edi" — amoCRM's card. The LENTA is the working surface and
 * takes the width; the facts about the record sit in a rail on the right
 * that stays put (and scrolls inside itself) while you read the history.
 *
 * On a phone there are no two columns to have: the rail renders first —
 * the numbers a person opens a card to check — and the lenta follows,
 * which is the order these cards already had.
 *
 * `tail` is the third slot, added when the owner pointed at the audit
 * history: «istoriya tarix mobileda eng pastda bo'lishi kerak, hozir
 * o'rtada bo'lib qolgan». It was at the BOTTOM OF THE RAIL, which on a
 * phone means the middle of the page — after the facts and the forms, but
 * still above the lenta a card is opened to read. Anything in `tail` comes
 * last on a phone and keeps its place under the rail on a desktop.
 *
 * DOM order is rail → main → tail, so the phone needs no rules at all; the
 * desktop grid places all three explicitly. ONE markup, no duplicated node
 * for a locator to find twice (#509) and no window measuring.
 */
export function CardCols({
  main,
  rail,
  tail,
}: {
  main: ReactNode;
  rail: ReactNode;
  /** Rendered last on a phone; under the rail on a desktop. */
  tail?: ReactNode;
}) {
  return (
    <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_24rem] md:items-start md:gap-4 md:space-y-0">
      <div className="space-y-4 md:col-start-2 md:row-start-1 md:sticky md:top-16 md:max-h-[calc(100dvh-4.5rem)] md:overflow-y-auto md:pr-0.5">
        {rail}
      </div>
      <div className="min-w-0 space-y-4 md:col-start-1 md:row-start-1">{main}</div>
      {tail && <div className="space-y-4 md:col-start-2 md:row-start-2">{tail}</div>}
    </div>
  );
}
