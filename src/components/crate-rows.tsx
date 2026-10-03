import Link from 'next/link';
import type { CrateStockRow } from '@/modules/wms/inventory/service';

/**
 * The crates standing here, or riding this truck, as PLACES (owner, round
 * 109: «tahta yashikga tirgandan keyin uni sklad stock mashina spiskasida
 * tahta yashikni mestasi kubi kg si korinsin, tegida ichidagi narsalarni
 * soni umumiy kub kilosi kichkina korinib tursa»).
 *
 * One list, both screens, because they answer the same question and must
 * never answer it differently. A row is «1 mesta» plus the size the crate
 * was MEASURED at — that is what a loader plans and a forwarder is charged
 * for — and beneath it, small, what is inside.
 *
 * Deliberately NOT added into the screens' Σ: the boxes inside are already
 * counted by the table above, and a crate row that joined the total would
 * double every crated cube — the tannarx reads those same numbers.
 *
 * It FOLDS (owner, 2026-10-03: «ostatkada yashiklar kop bolsa uzun yashiklar
 * korinib qolyabti colapsable bolsin»): a native `<details>`, open when there
 * are at most `FOLD_ABOVE` crates and closed above that. The summary carries
 * the count AND the over-capacity count, so the warning he asked to have on
 * top (round 109) is still on top while the list is folded.
 */
export const FOLD_ABOVE = 5;

export function CrateRows({
  rows,
  more,
  labels,
}: {
  rows: CrateStockRow[];
  /** True when the query hit its cap — «50+» rather than a false total. */
  more?: boolean;
  labels: { title: string; inside: string; over: string; place: string };
}) {
  if (rows.length === 0) return null;
  const overCount = rows.filter((crate) => crate.over).length;
  return (
    <details className="group space-y-1" data-testid="crate-rows" open={rows.length <= FOLD_ABOVE}>
      <summary
        className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs font-semibold text-ink-500 [&::-webkit-details-marker]:hidden"
        data-testid="crate-rows-summary"
      >
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        <span>
          🧰 {labels.title} ({more ? `${rows.length}+` : rows.length})
        </span>
        {overCount > 0 && (
          <span className="chip-warn" data-testid="crate-rows-over">
            ⚠ {labels.over} · {overCount}
          </span>
        )}
      </summary>
      <div className="divide-y divide-line rounded-xl border border-line">
        {rows.map((crate) => (
          <Link
            key={crate.id}
            href={`/crates/${crate.id}`}
            className="block px-3 py-1.5 hover:bg-surface-sunken"
            data-testid="crate-row"
          >
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <span className="font-mono font-bold text-brand-700">{crate.code}</span>
              <span className="font-mono font-semibold">{crate.clientCode}</span>
              <span className="text-ink-500">1 {labels.place}</span>
              {/* The measured size — the crate's own kub and kg, which is
                  what «yashikni kubi kg si» means. Unmeasured prints «—»
                  rather than a zero somebody would plan against. */}
              <span className="whitespace-nowrap font-mono tabular-nums">
                {crate.statedM3 !== null ? `${crate.statedM3} m³` : '—'}
                {' · '}
                {crate.statedKg !== null ? `${crate.statedKg} kg` : '—'}
              </span>
              {crate.over && (
                <span className="chip-warn" data-testid="crate-over">
                  ⚠ {labels.over}
                </span>
              )}
            </span>
            {/* Round 88's two-line row: each «·» inside the span that
                FOLLOWS it, so a wrap can never orphan a separator. */}
            <span className="flex flex-wrap text-2xs text-ink-500">
              <span className="whitespace-nowrap">
                {labels.inside}: {crate.boxCount} 📦
              </span>
              <span className="whitespace-nowrap">&nbsp;· {crate.m3} m³</span>
              <span className="whitespace-nowrap">&nbsp;· {crate.kg} kg</span>
            </span>
          </Link>
        ))}
      </div>
    </details>
  );
}
