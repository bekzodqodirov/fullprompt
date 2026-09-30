import Link from 'next/link';
import { seqRanges, type RowCrates } from '@/modules/wms/inventory/crate-grouping';

/**
 * The crates one stock row's cartons stand in (owner, 2026-09-30, his «B»:
 * «qolgan tovarlar spiskasi bilan birga turadi, faqat ichini ko'radigan
 * bo'ladi»). The row stays the lot at its warehouse; this is the fold under
 * its code — «🧰 7 yashik + 30 📦» — that opens to the crates, each with the
 * row's cartons in it by their label numbers (his 2a: «GS777-A · 10 📦 ·
 * №1–10»), and each a door to that crate's own carton list.
 *
 * A native `<details>`, the fold idiom here (Panel, chat-menu): it works in a
 * server component, costs no hydration root per row — 120 rows a page — and
 * opens with no round trip, which matters where the cargo is received. It
 * sits BESIDE the code's link, never inside it: an interactive element inside
 * an anchor is invalid HTML, and the tap would navigate instead of opening.
 *
 * A mixed crate is listed under every row it holds cartons of, and says so
 * both ways — what else is inside, and which row counts it as the one place
 * it is on the shelf (`groupCrates`' single owner) — so the Ostatka's pieces
 * add up to the pieces the skladchi counts.
 */
export function RowCratesFold({
  crates,
  loose,
  labels,
}: {
  crates: RowCrates;
  /** This row's cartons standing loose, outside any crate. */
  loose: number;
  labels: {
    summary: string;
    over: string;
    loose: string;
    also: (list: string) => string;
    countedAt: (code: string) => string;
    kind: (kind: string) => string | null;
  };
}) {
  const anyOver = crates.crates.some((crate) => crate.over);
  return (
    <details className="mt-1 font-sans" data-testid="stock-crates">
      <summary
        className="cursor-pointer select-none text-xs font-semibold text-ink-700"
        data-testid="stock-crates-open"
      >
        {labels.summary}
        {anyOver && <span className="ml-1 text-warn">⚠</span>}
      </summary>
      {/* Wraps inside a capped width: the cell is `whitespace-nowrap` for the
          code, and one long «also inside» line would otherwise stretch the
          whole column across the table. */}
      <ul className="mt-1 max-w-72 space-y-1 whitespace-normal text-xs">
        {crates.crates.map((crate) => {
          const kind = labels.kind(crate.kind);
          return (
            <li key={crate.id} data-testid="stock-crate">
              {/* One line per crate: the table scrolls sideways anyway, and a
                  crate broken over two lines reads as two things. */}
              <span className="whitespace-nowrap">
                <Link
                  href={`/stock?crate=${crate.id}`}
                  className="font-mono font-bold text-brand-700"
                  data-testid="stock-crate-link"
                >
                  {crate.code}
                </Link>
                {kind && <span className="ml-1 text-2xs font-semibold text-ink-500">{kind}</span>}{' '}
                {/* «n/total» only when a search hid part of the crate — a
                    mixed crate with nothing hidden names its other contents
                    on the line below instead. */}
                {crate.n}
                {crate.unseen > 0 ? `/${crate.total}` : ''} 📦{' '}
                <span className="text-ink-500">№{seqRanges(crate.seqs)}</span>
              </span>{' '}
              {crate.over && (
                <span className="chip-warn" data-testid="stock-crate-over">
                  ⚠ {labels.over}
                </span>
              )}
              {crate.others.length > 0 && (
                <span className="block text-2xs text-ink-500">
                  {labels.also(
                    crate.others.map((other) => `${other.code} ${other.n} 📦`).join(', '),
                  )}
                </span>
              )}
              {!crate.owned && crate.ownerCode && (
                <span className="block text-2xs text-ink-500" data-testid="stock-crate-counted-at">
                  {labels.countedAt(crate.ownerCode)}
                </span>
              )}
            </li>
          );
        })}
        {loose > 0 && (
          <li className="text-ink-500" data-testid="stock-crates-loose">
            {labels.loose}
          </li>
        )}
      </ul>
    </details>
  );
}
