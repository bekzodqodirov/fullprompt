import Link from 'next/link';

/**
 * The board's filter row: a search box, an advanced panel, and — for whoever
 * may see everybody's work — one colleague.
 *
 * Rendered by the PAGE, above the board, never inside `components/kanban.tsx`
 * — that component puts BOTH shapes into the DOM and toggles them with CSS,
 * so a control living there would exist twice and every existing locator in
 * m8 / m9zc / m9zd / m9ze would go ambiguous.
 *
 * A plain GET form, so the filter is a URL: shareable, walking with the back
 * button, and savable as a VIEW by `normalizeQuery` — which round 71 turned
 * on for the boards. The advanced panel is a native `<details>` whose body is
 * ABSOLUTELY positioned over the board: the board's height is a viewport
 * calculation (`--board-extra`), so a panel that pushed it down would grow
 * the second scrollbar #515 was written about. Its inputs stay in the DOM
 * (details hides, never unmounts), so one submit carries everything.
 */

/** The advanced params, in the order the chips print. */
export const BOARD_FILTER_KEYS = [
  'manba',
  'dan',
  'gacha',
  'narx_min',
  'narx_max',
  'kub_min',
  'kub_max',
  'kg_min',
  'kg_max',
  'lenta',
] as const;
export type BoardFilterKey = (typeof BOARD_FILTER_KEYS)[number];

/**
 * The URL's answers, checked rather than trusted: a range is a finite
 * non-negative number or it is not a filter, a date is a calendar day or
 * nothing, and `manba` must look like an id — a URL param is a forged post
 * (#514), and these reach SQL fragments.
 */
export function readBoardFilters(params: Record<string, string | string[] | undefined>) {
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  };
  const num = (key: string) => {
    const text = get(key).replace(',', '.');
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const date = (key: string) => (/^\d{4}-\d{2}-\d{2}$/.test(get(key)) ? get(key) : undefined);

  const raw: Partial<Record<BoardFilterKey, string>> = {};
  for (const key of BOARD_FILTER_KEYS) if (get(key)) raw[key] = get(key);
  return {
    /** What the chips and the carried links echo back — only what was set. */
    raw,
    sourceId: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(get('manba')) ? get('manba') : undefined,
    createdFrom: date('dan'),
    createdTo: date('gacha'),
    amountMin: num('narx_min'),
    amountMax: num('narx_max'),
    volMin: num('kub_min'),
    volMax: num('kub_max'),
    kgMin: num('kg_min'),
    kgMax: num('kg_max'),
    lenta: get('lenta') || undefined,
  };
}

export interface AdvancedLabels {
  filters: string;
  source: string;
  dateFrom: string;
  dateTo: string;
  price: string;
  volume: string;
  weight: string;
  lentaSearch: string;
  min: string;
  max: string;
}

export function BoardFilter({
  q,
  hodim,
  people,
  hidden,
  labels,
  advanced,
}: {
  q: string;
  hodim: string;
  /** Empty ⇒ this actor may only see their own, so no picker is offered. */
  people: { id: string; fullName: string }[];
  /** The params this form must carry through, since it replaces the URL. */
  hidden: Record<string, string>;
  labels: { search: string; everyone: string; apply: string; clear: string };
  /** The round-71 panel; absent keeps the plain two-row filter. */
  advanced?: {
    values: Partial<Record<BoardFilterKey, string>>;
    /** Lead board only — a deal has no source. */
    sources?: { id: string; name: string }[];
    labels: AdvancedLabels;
  };
}) {
  const advancedOn = Object.keys(advanced?.values ?? {}).length;
  const active = q !== '' || hodim !== '' || advancedOn > 0;
  const value = (key: BoardFilterKey) => advanced?.values[key] ?? '';

  // The chips name what is filtering the board while the panel is closed —
  // and each ✕ is a LINK that removes exactly one answer.
  const chipText = (key: BoardFilterKey, text: string) => {
    if (!advanced) return text;
    const a = advanced.labels;
    const named: Partial<Record<BoardFilterKey, string>> = {
      manba: advanced.sources?.find((s) => s.id === text)?.name ?? a.source,
      dan: `${a.dateFrom} ${text}`,
      gacha: `${a.dateTo} ${text}`,
      narx_min: `${a.price} ≥ ${text}`,
      narx_max: `${a.price} ≤ ${text}`,
      kub_min: `${a.volume} ≥ ${text}`,
      kub_max: `${a.volume} ≤ ${text}`,
      kg_min: `${a.weight} ≥ ${text}`,
      kg_max: `${a.weight} ≤ ${text}`,
      lenta: `💬 ${text}`,
    };
    return named[key] ?? text;
  };

  const range = (nameMin: BoardFilterKey, nameMax: BoardFilterKey, label: string) => (
    <div>
      <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          name={nameMin}
          defaultValue={value(nameMin)}
          placeholder={advanced!.labels.min}
          aria-label={`${label} ${advanced!.labels.min}`}
          data-testid={`bf-${nameMin}`}
          className="input min-w-0 flex-1"
        />
        <span className="text-ink-400">–</span>
        <input
          type="text"
          inputMode="decimal"
          name={nameMax}
          defaultValue={value(nameMax)}
          placeholder={advanced!.labels.max}
          aria-label={`${label} ${advanced!.labels.max}`}
          data-testid={`bf-${nameMax}`}
          className="input min-w-0 flex-1"
        />
      </div>
    </div>
  );

  return (
    // `relative` on the FORM, not on the toggle: the panel anchors to the
    // row's full width, which is the only anchor that survives 360 px (#471).
    <form className="card relative space-y-2 !p-2" data-testid="board-filter">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* The box and its buttons share a row — icon buttons are narrow and
          this is the whole feature on a phone. The PICKER gets its own line
          below: a select beside a search box at 360 px is the shape that has
          shipped as a defect three times (#419, #421, #400). */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={labels.search}
          aria-label={labels.search}
          data-testid="board-q"
          className="input min-w-0 flex-1"
        />
        <button
          type="submit"
          data-testid="board-filter-apply"
          aria-label={labels.apply}
          className="btn-secondary btn-icon shrink-0"
        >
          🔍
        </button>
        {advanced && (
          <details className="shrink-0" data-testid="board-filters-fold">
            <summary
              className="btn-secondary btn-icon cursor-pointer list-none marker:content-none"
              aria-label={advanced.labels.filters}
              data-testid="board-filters-toggle"
            >
              ⚲{advancedOn > 0 && <span className="ml-0.5 text-xs font-bold">{advancedOn}</span>}
            </summary>
            {/* Over the board, never above it: the board's height budget
                (--board-extra) is set by the page and cannot follow a fold.
                On a phone the panel is a FIXED bottom sheet (the dock's
                shape): anchored under the form it overflowed the viewport,
                so «Qo'llash» sat below the fold and under the z-30 tab bar —
                visible in a screenshot, unpressable by a thumb. bottom-16
                clears the tab bar; z-40 outranks it. From `md` up the tab
                bar is gone and the panel anchors to the row again. */}
            <div
              className="fixed inset-x-2 bottom-16 z-40 max-h-[70dvh] space-y-2.5 overflow-y-auto rounded-xl border border-line bg-surface-raised p-3 shadow-pop md:absolute md:inset-x-0 md:bottom-auto md:top-full md:mt-1 md:max-h-[65dvh]"
              data-testid="board-filters-panel"
            >
              <p className="text-sm font-bold">{advanced.labels.filters}</p>
              {advanced.sources && advanced.sources.length > 0 && (
                <div>
                  <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                    {advanced.labels.source}
                  </span>
                  <select
                    name="manba"
                    defaultValue={value('manba')}
                    aria-label={advanced.labels.source}
                    data-testid="bf-manba"
                    className="input w-full"
                  >
                    <option value="">—</option>
                    {advanced.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                  {advanced.labels.dateFrom} — {advanced.labels.dateTo}
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    name="dan"
                    defaultValue={value('dan')}
                    aria-label={advanced.labels.dateFrom}
                    data-testid="bf-dan"
                    className="input min-w-0 flex-1"
                  />
                  <span className="text-ink-400">–</span>
                  <input
                    type="date"
                    name="gacha"
                    defaultValue={value('gacha')}
                    aria-label={advanced.labels.dateTo}
                    data-testid="bf-gacha"
                    className="input min-w-0 flex-1"
                  />
                </div>
              </div>
              {range('narx_min', 'narx_max', advanced.labels.price)}
              {range('kub_min', 'kub_max', advanced.labels.volume)}
              {range('kg_min', 'kg_max', advanced.labels.weight)}
              <div>
                <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
                  {advanced.labels.lentaSearch}
                </span>
                <input
                  type="search"
                  name="lenta"
                  defaultValue={value('lenta')}
                  aria-label={advanced.labels.lentaSearch}
                  data-testid="bf-lenta"
                  className="input w-full"
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button type="submit" data-testid="bf-apply" className="btn-primary flex-1">
                  {labels.apply}
                </button>
                {active && (
                  <Link href={hrefWith(hidden, {})} className="btn-ghost shrink-0">
                    {labels.clear}
                  </Link>
                )}
              </div>
            </div>
          </details>
        )}
      </div>
      {(people.length > 0 || active) && (
        <div className="flex flex-wrap items-center gap-2">
          {people.length > 0 && (
            <select
              name="hodim"
              defaultValue={hodim}
              aria-label={labels.everyone}
              data-testid="board-hodim"
              className="input !w-auto min-w-0 flex-1"
            >
              <option value="">{labels.everyone}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </select>
          )}
          {/* Only once something is on, and it is a LINK: a reset button would
              clear the boxes without reloading the board underneath them. */}
          {active && (
            <Link
              href={hrefWith(hidden, {})}
              data-testid="board-filter-clear"
              className="btn-ghost shrink-0"
            >
              {labels.clear}
            </Link>
          )}
        </div>
      )}
      {advancedOn > 0 && advanced && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="board-filter-chips">
          {(Object.entries(advanced.values) as [BoardFilterKey, string][]).map(([key, text]) => (
            <Link
              key={key}
              // The chip's whole body is the remove link: on a phone a
              // separate 12 px ✕ target is a miss waiting to happen.
              href={hrefWith({ ...hidden, q, hodim, ...advanced.values }, { [key]: undefined })}
              data-testid={`bf-chip-${key}`}
              className="chip chip-brand max-w-full"
            >
              <span className="truncate">{chipText(key, text)}</span>
              <span aria-hidden className="ml-1 font-bold">
                ×
              </span>
            </Link>
          ))}
        </div>
      )}
    </form>
  );
}

/**
 * A board link that keeps the filter.
 *
 * The mine/all tabs and the «+N · show all» footer were literal strings, so
 * the first tap on any of them dropped whatever was typed — and loaded four
 * hundred unfiltered closed cards, which reads as the filter being broken.
 */
export function hrefWith(
  current: Record<string, string>,
  patch: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...patch })) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '?';
}
