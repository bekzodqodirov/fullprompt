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
 * last on a phone.
 *
 * On a DESKTOP it follows the lenta, in column one. It was first put under
 * the rail so that nothing about the desktop moved, and that was the wrong
 * trade: «pcda ong taraf menu orqasiga otib qolyabti pasga tushgan sari».
 * He meant it literally. Measured at 1280×900 on a card with a short lenta
 * and a long history, the tail and the rail are in the same column and
 * overlap by 303 px — `elementsFromPoint` at the top of the history returns
 * the FACTS PANEL. A sticky item's travel is NOT confined to its grid row
 * here, so the rail stays pinned at y=64 while the history scrolls up
 * underneath it, and a positioned element paints over a static sibling. (A
 * first measurement said otherwise and was wrong: the local card's history
 * is 46 px tall and can never rise high enough to reach the rail. A layout
 * defect needs the content that provokes it.) Even where they do not touch,
 * the history was stranded at the bottom of the 24rem column with ~450 px
 * of nothing above it. Under the lenta it simply comes next.
 *
 * It lives INSIDE the main cell rather than in a grid row of its own, and
 * that difference is invisible until the RAIL is the taller column — which
 * is the deal card's ordinary state, its rail carrying facts, lookback,
 * lines, discount, receipts, charge, profit, tasks and custom fields. A row
 * two starts below the tallest thing in row one, so measured at 1280×900
 * with a 60 px lenta and a rail past its cap: as a grid row the history
 * opened **548 px of nothing** above itself and sat at y=1129 in a 1723 px
 * page; inside the cell it follows the lenta by the grid's own 16 px gap at
 * y=597 in a 1191 px page. Same width, same column, no overlap either way —
 * half a screen less scrolling to reach the thing he said he could not
 * reach. (A first comparison said the two were identical. It grew the LENTA,
 * so row one was never the rail: the same mistake as the first overlap
 * measurement, one shape further along.)
 *
 * DOM order is still rail → main → tail, so the phone needs no rules at all.
 * ONE markup, no duplicated node for a locator to find twice (#509) and no
 * window measuring.
 */
export function CardCols({
  main,
  rail,
  tail,
}: {
  main: ReactNode;
  rail: ReactNode;
  /** Rendered last on a phone, and last under the lenta on a desktop. */
  tail?: ReactNode;
}) {
  return (
    <div className="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_24rem] md:items-start md:gap-4 md:space-y-0">
      <div
        data-cardcols="rail"
        className="space-y-4 md:col-start-2 md:row-start-1 md:sticky md:top-16 md:max-h-[calc(100dvh-4.5rem)] md:overflow-y-auto md:pr-0.5"
      >
        {rail}
      </div>
      <div data-cardcols="main" className="min-w-0 space-y-4 md:col-start-1 md:row-start-1">
        {main}
        {tail && (
          <div data-cardcols="tail" className="min-w-0 space-y-4">
            {tail}
          </div>
        )}
      </div>
    </div>
  );
}
