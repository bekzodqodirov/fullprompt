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
 * DOM order is rail-then-main; the desktop grid swaps them with `order`,
 * so both shapes come from ONE markup and no window measuring (#kanban).
 */
export function CardCols({ main, rail }: { main: ReactNode; rail: ReactNode }) {
  return (
    <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_24rem] md:items-start md:gap-4 md:space-y-0">
      <div className="space-y-4 md:order-2 md:sticky md:top-16 md:max-h-[calc(100dvh-4.5rem)] md:overflow-y-auto md:pr-0.5">
        {rail}
      </div>
      <div className="min-w-0 space-y-4 md:order-1">{main}</div>
    </div>
  );
}
