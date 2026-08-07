import Link from 'next/link';

/**
 * The board's ONE filter door (round 72).
 *
 * Round 71 built the advanced panel and left the search box, the mine/all
 * tabs and the colleague picker as their own rows above the board; the owner
 * refused the stack outright — «qidiruv va hodimlar bo'yicha filterni ham
 * o'zing qilganni ichiga tiq … urg'u kanban view'ga berilsin». So the search
 * box, the whose-work choice and the colleague picker now LIVE IN the panel,
 * the trigger is one toolbar button wearing a badge that counts every active
 * constraint, and the chips row under the toolbar names them while the panel
 * is closed.
 *
 * Rendered by the PAGE, above the board, never inside `components/kanban.tsx`
 * — that component puts BOTH board shapes into the DOM and toggles them with
 * CSS, so a control living there would exist twice and every existing locator
 * in m8 / m9zc / m9zd / m9ze would go ambiguous.
 *
 * A plain GET form, so the filter is a URL: shareable, walking with the back
 * button, and savable as a VIEW. The form REPLACES the URL, which is why the
 * q / scope / hodim inputs must be REAL inputs inside it — a control that
 * posts nothing reads as «remove» (#171) — and why `hidden` carries whatever
 * else the screen's address holds (arxiv).
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

export interface BoardFilterLabels {
  search: string;
  /** Section label over the scope radios + colleague picker. */
  whose: string;
  mine: string;
  all: string;
  everyone: string;
  apply: string;
  clear: string;
}

export function BoardFilter({
  q,
  scope,
  hodim,
  people,
  hidden,
  labels,
  advanced,
}: {
  q: string;
  /** 'all' or '' — only meaningful for a view_all holder. */
  scope: string;
  hodim: string;
  /** Empty ⇒ this actor may only see their own, so no whose-work block. */
  people: { id: string; fullName: string }[];
  /** The params this form must carry through, since it replaces the URL. */
  hidden: Record<string, string>;
  labels: BoardFilterLabels;
  advanced: {
    values: Partial<Record<BoardFilterKey, string>>;
    /** Lead board only — a deal has no source. */
    sources?: { id: string; name: string }[];
    labels: AdvancedLabels;
  };
}) {
  // The badge counts every constraint narrowing the board, not just the
  // advanced ones — a search typed into a closed panel must not look like
  // «no filters».
  const activeCount =
    Object.keys(advanced.values).length + (q ? 1 : 0) + (hodim ? 1 : 0);
  const active = activeCount > 0 || scope === 'all';
  const value = (key: BoardFilterKey) => advanced.values[key] ?? '';

  const range = (nameMin: BoardFilterKey, nameMax: BoardFilterKey, label: string) => (
    <div>
      <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          name={nameMin}
          defaultValue={value(nameMin)}
          placeholder={advanced.labels.min}
          aria-label={`${label} ${advanced.labels.min}`}
          data-testid={`bf-${nameMin}`}
          className="input min-w-0 flex-1"
        />
        <span className="text-ink-400">–</span>
        <input
          type="text"
          inputMode="decimal"
          name={nameMax}
          defaultValue={value(nameMax)}
          placeholder={advanced.labels.max}
          aria-label={`${label} ${advanced.labels.max}`}
          data-testid={`bf-${nameMax}`}
          className="input min-w-0 flex-1"
        />
      </div>
    </div>
  );

  return (
    <details data-testid="board-filters-fold">
      <summary
        className="btn-secondary btn-icon cursor-pointer list-none marker:content-none"
        aria-label={advanced.labels.filters}
        data-testid="board-filters-toggle"
      >
        ⚲
        {activeCount > 0 && (
          <span className="ml-0.5 text-xs font-bold text-brand-700">{activeCount}</span>
        )}
      </summary>
      {/* On a phone the panel is a FIXED bottom sheet (the dock's shape):
          anchored under the toolbar it overflowed the viewport, so the apply
          button sat below the fold and under the z-30 tab bar — visible in a
          screenshot, unpressable by a thumb (#547). bottom-16 clears the tab
          bar; z-40 outranks it. From `md` up the tab bar is gone and the
          panel anchors to the toolbar row (the row carries `relative`). */}
      <form
        className="fixed inset-x-2 bottom-16 z-40 max-h-[70dvh] space-y-2.5 overflow-y-auto rounded-xl border border-line bg-surface-raised p-3 shadow-pop md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-1 md:w-96 md:max-h-[70dvh]"
        data-testid="board-filters-panel"
      >
        {Object.entries(hidden).map(([name, hiddenValue]) => (
          <input key={name} type="hidden" name={name} value={hiddenValue} />
        ))}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={labels.search}
          aria-label={labels.search}
          data-testid="board-q"
          className="input w-full"
        />
        {people.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">
              {labels.whose}
            </span>
            {/* Two honest controls, not one clever select: the radios post
                `scope` and the picker posts `hodim`, exactly the params the
                round-57/71 saved views already store — one merged control
                would have needed a third spelling of the same question. */}
            {/* peer-checked, not server-computed classes: a GET form gives no
                feedback until submit, so the tick itself must restyle the
                box — with zero JavaScript, like every other fold here. */}
            <div className="flex gap-1.5">
              {[
                { v: '', label: labels.mine },
                { v: 'all', label: labels.all },
              ].map((option) => (
                <label key={option.v || 'mine'} className="flex-1 cursor-pointer">
                  <input
                    type="radio"
                    name="scope"
                    value={option.v}
                    defaultChecked={(scope === 'all') === (option.v === 'all')}
                    className="peer sr-only"
                  />
                  <span className="block rounded-xl border border-line bg-surface-raised px-3 py-2 text-center text-sm font-semibold peer-checked:border-brand-600 peer-checked:bg-brand-50 peer-checked:text-brand-800">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>
            <select
              name="hodim"
              defaultValue={hodim}
              aria-label={labels.everyone}
              data-testid="board-hodim"
              className="input w-full"
            >
              <option value="">{labels.everyone}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </select>
          </div>
        )}
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
        {/* Sticky INSIDE the scroll container: the panel scrolls when the
            keyboard halves the viewport, and #547's lesson is that an apply
            button below the fold is unpressable for a thumb even when a
            robot can reach it. */}
        <div className="sticky bottom-0 -mx-3 -mb-3 flex items-center gap-2 rounded-b-xl bg-surface-raised px-3 py-2.5">
          <button type="submit" data-testid="bf-apply" className="btn-primary flex-1">
            {labels.apply}
          </button>
          {active && (
            // Clear drops the FILTERS, not whose work the board shows: a
            // supervisor on «hammasi» must still be on «hammasi» after it
            // (#171 — the regression judge's find). For a mine-scope board
            // it lands on the bare address, which for a default-view holder
            // means «back to my default view» — stated, not accidental.
            <Link
              href={hrefWith({ ...hidden, ...(scope === 'all' ? { scope: 'all' } : {}) }, {})}
              data-testid="board-filter-clear"
              className="btn-ghost shrink-0"
            >
              {labels.clear}
            </Link>
          )}
        </div>
      </form>
    </details>
  );
}

/**
 * The toolbar's own search box, from `md` up (round 72, the desktop judge's
 * point): on a laptop the fold saves no height — the toolbar row exists
 * anyway — while search is the most-pressed control on the board. A phone
 * keeps it in the panel; this whole form is `hidden` below `md`, and a
 * hidden form cannot be submitted, so the two q inputs never post together.
 *
 * Its OWN little GET form, carrying the rest of the current query as hidden
 * inputs — the form replaces the URL (#171).
 */
export function InlineSearch({
  q,
  carried,
  label,
}: {
  q: string;
  /** Everything else the address currently holds, re-posted untouched. */
  carried: Record<string, string>;
  label: string;
}) {
  return (
    <form className="hidden min-w-0 max-w-xs flex-1 md:block">
      {Object.entries(carried).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder={label}
        aria-label={label}
        data-testid="board-q-inline"
        className="input !min-h-9 w-full"
      />
    </form>
  );
}

/**
 * The chips under the toolbar: every active constraint by name, each one a
 * LINK that removes exactly that answer. On a phone a separate 12 px ✕
 * target is a miss waiting to happen, so the whole chip is the link.
 *
 * Rendered only when something is on, so the closed state costs the board
 * no height — and the page charges for it in --board-extra when it does.
 */
export function BoardChips({
  q,
  scope,
  hodim,
  hodimName,
  values,
  sources,
  labels,
  current,
}: {
  q: string;
  /** 'all' shows as a removable chip — an invisible widening is the hidden-
      filter confusion this row exists to prevent. */
  scope: string;
  hodim: string;
  /** The picked colleague's name — an id on a chip reads as broken. */
  hodimName: string | null;
  values: Partial<Record<BoardFilterKey, string>>;
  sources?: { id: string; name: string }[];
  labels: AdvancedLabels & { search: string; all: string };
  /** The full current query, so removing one key keeps the rest. */
  current: Record<string, string>;
}) {
  const chips: { key: string; text: string }[] = [];
  if (scope === 'all') chips.push({ key: 'scope', text: `👥 ${labels.all}` });
  if (q) chips.push({ key: 'q', text: `🔍 ${q}` });
  if (hodim) chips.push({ key: 'hodim', text: `👤 ${hodimName ?? '…'}` });
  const named: Partial<Record<BoardFilterKey, string>> = {
    manba: sources?.find((s) => s.id === values.manba)?.name ?? labels.source,
    dan: `${labels.dateFrom} ${values.dan}`,
    gacha: `${labels.dateTo} ${values.gacha}`,
    narx_min: `${labels.price} ≥ ${values.narx_min}`,
    narx_max: `${labels.price} ≤ ${values.narx_max}`,
    kub_min: `${labels.volume} ≥ ${values.kub_min}`,
    kub_max: `${labels.volume} ≤ ${values.kub_max}`,
    kg_min: `${labels.weight} ≥ ${values.kg_min}`,
    kg_max: `${labels.weight} ≤ ${values.kg_max}`,
    lenta: `💬 ${values.lenta}`,
  };
  for (const key of BOARD_FILTER_KEYS) {
    if (values[key]) chips.push({ key, text: named[key] ?? values[key]! });
  }
  if (chips.length === 0) return null;

  return (
    // ONE row that scrolls sideways (SubNav's shape), never wraps: the board
    // charges a flat height for this row, and a wrapped second line would
    // eat the board's bottom edge exactly when the owner filters hardest.
    <div
      className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4"
      data-testid="board-filter-chips"
    >
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={hrefWith(current, { [chip.key]: undefined })}
          data-testid={`bf-chip-${chip.key}`}
          className="chip chip-brand shrink-0 max-w-56"
        >
          <span className="truncate">{chip.text}</span>
          <span aria-hidden className="ml-1 font-bold">
            ×
          </span>
        </Link>
      ))}
    </div>
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
