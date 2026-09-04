'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';
import type { BazaBasis } from '@/modules/wms/calc/pricing';

/**
 * «Qaysi deklaratsiya bu tovarni narxlaydi?» — the customs file's own rows,
 * in a room of their own.
 *
 * It used to be a `max-h-48` scroller at the bottom of the row's ⋯ popover,
 * inside the grid's `overflow-x-auto` wrapper. CSS computes the other axis to
 * `auto` when one is not `visible`, so that popover was clipped on BOTH — and
 * the candidate list, being the last thing in it under the note and the
 * delete, fell entirely below the clip line. The owner's own words were «when
 * I search the baza the bazas become invisible»: he pressed 📥 and the panel
 * visibly did nothing. One cause, two symptoms — his screenshot showed the
 * delete button cut off by the same edge.
 *
 * So the list LEAVES the table. Not a bigger popover and not a resizable one:
 * both are still clipped, and either would have shipped and not worked. A
 * portal cannot be clipped by anything, and choosing which of two hundred
 * declarations prices a customer's cargo is a decision with alternatives —
 * a decision gets a room, with what he is pricing written at the top and the
 * names he picks by actually readable.
 */

export interface ImportCandidate {
  id: string;
  name: string;
  basis: BazaBasis;
  pricePerUnitUsd: number;
  weightPerUnitKg: number | null;
  unit: string;
  declaredAt: string | null;
  sender: string | null;
  unitMatches: boolean;
}

interface PickerAnswer {
  state: 'ok' | 'no_batch' | 'no_code' | 'behind';
  candidates: ImportCandidate[];
  total: number;
  source: string | null;
  basis: BazaBasis | null;
}

export interface PickerTarget {
  itemId: string;
  name: string;
  tnvedCode: string;
}

/** Fold a declaration paragraph into what a person scans, without hiding it. */
const CLAMP = 'line-clamp-3 break-words';

export function ImportBazaDialog({
  target,
  onClose,
  onPick,
}: {
  /** null while closed — the dialog stays MOUNTED (#684: Overlay's
   * close-on-navigation effect runs on mount, so a conditionally rendered
   * open dialog shuts itself on the frame it appears). */
  target: PickerTarget | null;
  onClose: () => void;
  onPick: (itemId: string, row: { id: string; pricePerUnitUsd: number; basis: BazaBasis }) => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [answer, setAnswer] = useState<PickerAnswer | null>(null);
  // Starts true, and is never set synchronously in the effect: the caller
  // keys this component on the item, so a different row is a fresh mount
  // with fresh state and there is nothing to reset.
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Which request the answer on screen belongs to — an out-of-order reply
   * for the row he has already left must not render under this header. */
  const asked = useRef(0);

  const itemId = target?.itemId ?? null;
  useEffect(() => {
    if (itemId === null) return;
    // A ticket, because re-opening the SAME row does not remount: two
    // answers can be in flight and only the newest may render.
    const ticket = ++asked.current;
    void (async () => {
      try {
        const res = await fetch(`/api/calc/import-baza?item=${itemId}`);
        // `fetch` does not throw on 4xx: a 403 body has no candidates, and
        // reading that as «nothing imported» would send him to upload a file
        // he is not allowed to upload.
        if (!res.ok) {
          if (ticket === asked.current) setAnswer({ state: 'behind', candidates: [], total: 0, source: null, basis: null });
          return;
        }
        const data = (await res.json()) as Partial<PickerAnswer>;
        if (ticket !== asked.current) return;
        setAnswer({
          state: data.state ?? 'ok',
          candidates: data.candidates ?? [],
          total: data.total ?? 0,
          source: data.source ?? null,
          basis: data.basis ?? null,
        });
      } catch {
        if (ticket === asked.current) setAnswer({ state: 'behind', candidates: [], total: 0, source: null, basis: null });
      } finally {
        if (ticket === asked.current) setLoading(false);
      }
    })();
  }, [itemId]);

  const needle = q.trim().toLowerCase();
  const shown = (answer?.candidates ?? []).filter(
    (c) => needle === '' || c.name.toLowerCase().includes(needle),
  );

  return (
    <Overlay
      open={target !== null}
      onClose={() => {
        onClose();
        return true;
      }}
      closeLabel={t('importClose')}
      testId="calc-import-dialog"
      // A bottom sheet below `md` and a centred panel above it, keyed on the
      // breakpoint the GRID uses (`hidden md:block`, 768) rather than on
      // `sm`: between 640 and 768 the editable table does not exist, and
      // between 768 and 1024 a centred 640px box beside a 224px sidebar is
      // what a narrow laptop actually gets. Only the LIST scrolls, so the
      // header, the search and the footer stay put under a keyboard.
      className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-pop md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[80dvh] md:w-[40rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
    >
      <div className="shrink-0">
        <h2 className="min-w-0 break-words text-sm font-semibold" data-testid="calc-import-title">
          {target?.name}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-ink-500">
          <span className="shrink-0 font-mono">{target?.tnvedCode}</span>
          {answer?.basis ? <span className="shrink-0">· $/{answer.basis === 'unit' ? t('perUnit') : answer.basis}</span> : null}
          {answer?.source ? <span className="shrink-0">· {answer.source}</span> : null}
        </p>
        <input
          className="input input-sm mt-2"
          data-testid="calc-import-search"
          placeholder={t('importSearch')}
          aria-label={t('importSearch')}
          value={q}
          disabled={loading}
          onChange={(e) => setQ(e.target.value)}
        />
        {answer && answer.total > answer.candidates.length ? (
          <p className="mt-1 text-2xs text-ink-500" data-testid="calc-import-count">
            {t('importCount', { total: answer.total, shown: answer.candidates.length })}
          </p>
        ) : null}
      </div>

      {/* `min-h-0` or the list refuses to shrink below its content and the
          panel grows past its own max-height, taking the footer off-screen —
          a flex item's min-height defaults to `auto`. */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loading ? (
          <p className="p-2 text-2xs text-ink-500">{tc('loading')}</p>
        ) : answer === null ? null : answer.state === 'behind' ? (
          <p className="p-2 text-2xs text-warn" data-testid="calc-import-failed">
            {t('importFailed')}
          </p>
        ) : answer.state === 'no_batch' ? (
          <p className="p-2 text-2xs text-ink-500" data-testid="calc-import-nobatch">
            {t('importNoBatch')}
          </p>
        ) : answer.candidates.length === 0 ? (
          <p className="p-2 text-2xs text-ink-500" data-testid="calc-import-empty">
            {t('importNone')}
          </p>
        ) : shown.length === 0 ? (
          <p className="p-2 text-2xs text-ink-500" data-testid="calc-import-nomatch">
            {t('importNoMatch', { q: q.trim() })}
          </p>
        ) : (
          shown.map((c) => (
            <div key={c.id} className="rounded-xl border border-line">
              <button
                type="button"
                className="block w-full min-h-12 p-2 text-left hover:bg-surface-sunken"
                data-testid="calc-import-candidate"
                onClick={() => {
                  onPick(target!.itemId, {
                    id: c.id,
                    pricePerUnitUsd: c.pricePerUnitUsd,
                    basis: c.basis,
                  });
                  onClose();
                }}
              >
                <span className="flex flex-wrap items-center gap-1">
                  <span className="font-mono tabular-nums text-sm">
                    ${c.pricePerUnitUsd} / {c.basis === 'unit' ? t('perUnit') : c.basis}
                  </span>
                  {/* A bare ⚠ said nothing. The mismatch is the one thing on
                      this row that can be off by the weight of the goods. */}
                  {!c.unitMatches ? (
                    <span className="chip chip-warn" data-testid="calc-import-unitwarn">
                      {t('importUnitMismatch', { unit: c.unit })}
                    </span>
                  ) : null}
                </span>
                {/* No `block` beside the clamp: `display` is emitted after
                    `line-clamp` in Tailwind's own order, so `block` would win
                    and the clamp would do nothing (style-cascade's sixth). */}
                <span
                  className={`mt-0.5 text-2xs text-ink-500 ${expanded === c.id ? 'break-words' : CLAMP}`}
                  title={c.name}
                >
                  {c.name}
                </span>
                <span className="mt-0.5 block text-2xs text-ink-400">
                  {[
                    c.weightPerUnitKg !== null ? `${c.weightPerUnitKg} kg/${t('perUnit')}` : null,
                    c.declaredAt,
                    c.sender,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              {/* His last and most specific ask was «nomlari yaxshiroq
                  korinsin». Three clamped lines is ~250 characters of a name
                  his file writes 500 of, and a hover title is the affordance
                  that failed him — so the name opens IN PLACE. */}
              {c.name.length > 160 ? (
                <button
                  type="button"
                  className="px-2 pb-1 text-2xs text-brand-600"
                  data-testid="calc-import-name-more"
                  onClick={() => setExpanded((v) => (v === c.id ? null : c.id))}
                >
                  {expanded === c.id ? t('importNameLess') : t('importNameMore')}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* His own rule deserves a button, not only an ✕: «agar to'g'ri
          bo'lmasa baza yo'q deb VED hodimi o'zi qo'yadi». */}
      <button
        type="button"
        className="btn-ghost mt-2 w-full shrink-0"
        data-testid="calc-import-cancel"
        onClick={onClose}
      >
        {t('importOwnBaza')}
      </button>
    </Overlay>
  );
}
