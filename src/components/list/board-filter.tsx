import Link from 'next/link';

/**
 * The board's filter row: a search box and, for whoever may see everybody's
 * work, one colleague.
 *
 * Rendered by the PAGE, above the board, never inside `components/kanban.tsx`
 * — that component puts BOTH shapes into the DOM and toggles them with CSS,
 * so a control living there would exist twice and every existing locator in
 * m8 / m9zc / m9zd / m9ze would go ambiguous.
 *
 * A plain GET form, so the filter is a URL: shareable, walking with the back
 * button, and already savable by `normalizeQuery` if the boards ever grow
 * saved views. The two boxes are on their own lines because a select and a
 * search input sharing a row at 360 px is the shape that has now shipped as a
 * defect three times (#419, #421, #400).
 */
export function BoardFilter({
  q,
  hodim,
  people,
  hidden,
  labels,
}: {
  q: string;
  hodim: string;
  /** Empty ⇒ this actor may only see their own, so no picker is offered. */
  people: { id: string; fullName: string }[];
  /** The params this form must carry through, since it replaces the URL. */
  hidden: Record<string, string>;
  labels: { search: string; everyone: string; apply: string; clear: string };
}) {
  const active = q !== '' || hodim !== '';
  return (
    <form className="card space-y-2 !p-2" data-testid="board-filter">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* The box and its button share a row — an icon button is narrow and
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
