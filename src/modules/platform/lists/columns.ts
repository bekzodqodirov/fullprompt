/**
 * Which columns a list shows, and in what order.
 *
 * Same philosophy as `fields/filter.ts`: this is NOT a table renderer. Every
 * list screen keeps its own hand-written query and its own JSX cells; what it
 * gets from here is the ANSWER to "may this person see this column, and did
 * they ask for it" — a small pure decision, so the screen stays readable and
 * the rule stays testable.
 *
 * A screen declares its core columns once as data. Custom fields (phase 2)
 * arrive as `cf_<uuid>` and are appended by the caller, so one list can carry
 * both kinds through one `?cols=` parameter.
 */

export interface ColumnDef {
  /** URL-safe and stable for life: `?cols=` stores these. */
  key: string;
  /**
   * A full i18n key including its namespace (`clients.code`).
   *
   * Full rather than namespace-relative because a runtime `t(...)` call is
   * invisible to the i18n tripwire — `tests/unit/list-columns.test.ts` reads
   * these strings and asserts each one resolves, which is the BRIDGE_LABELS
   * pattern (#163's fourth instance taught it).
   *
   * Absent for a column whose name is DATA: a custom field is labelled by the
   * owner, in his own words, and no bundle can carry it.
   */
  labelKey?: string;
  /** The ready-made label of a data-named column (a custom field). */
  label?: string;
  /** A column nobody may hide — the one that carries the link to the record. */
  always?: boolean;
  /** Hidden unless the viewer holds this permission (money, mostly). */
  permission?: string;
  /** Right-aligned tabular numerals. */
  numeric?: boolean;
  /** Off unless asked for: real but noisy columns start hidden. */
  optional?: boolean;
}

/** The `?cols=` value, or null when the screen was opened without one. */
export function parseCols(raw: string | string[] | undefined): string[] | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  // An explicit empty value is a deliberate "only the mandatory columns",
  // which is why this is not the same as no parameter at all.
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The columns to render: the viewer's choice, filtered by what they may see.
 *
 * Unknown keys are dropped rather than refused — a saved view outlives the
 * column it names when the owner retires a custom field, and a stale view
 * that shows one column too few is better than a screen that will not open.
 */
export function visibleColumns(
  defs: ColumnDef[],
  chosen: string[] | null,
  can: (permission: string) => boolean,
): ColumnDef[] {
  const allowed = defs.filter((def) => !def.permission || can(def.permission));
  if (chosen === null) return allowed.filter((def) => !def.optional);

  const wanted = new Set(chosen);
  // Order follows the SCREEN's declaration, not the URL: a list whose columns
  // jump about between saved views is harder to read than one that does not.
  return allowed.filter((def) => def.always || wanted.has(def.key));
}

/**
 * The columns a DOWNLOAD carries — which is not quite the screen's answer.
 *
 * `optional` exists to keep a phone-width table readable, not to keep
 * anything out of a spreadsheet: a sheet is read at a desk. So a plain
 * download (no `?cols=`, i.e. nobody chose a view) carries every column the
 * person may see, optional ones included, while a download OF a view carries
 * exactly that view.
 *
 * The permission filter is untouched in both branches — that is the rule this
 * must not weaken («an export that shows a column the page hides is a leak
 * with a filename»), and it is about what somebody may SEE, never about what
 * makes a narrow table tidy.
 *
 * Round 57 collapsed the two ideas into one call and the client book's
 * spreadsheet quietly lost its phone-numbers column — which is the file the
 * owner corrects the client book from.
 */
export function exportColumns(
  defs: ColumnDef[],
  chosen: string[] | null,
  can: (permission: string) => boolean,
): ColumnDef[] {
  if (chosen !== null) return visibleColumns(defs, chosen, can);
  return defs.filter((def) => !def.permission || can(def.permission));
}

/** The value to put in `?cols=` for a given selection. */
export function colsParam(defs: ColumnDef[], visible: ColumnDef[]): string {
  const shown = new Set(visible.map((def) => def.key));
  return defs
    .filter((def) => shown.has(def.key))
    .map((def) => def.key)
    .join(',');
}
