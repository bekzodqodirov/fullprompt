/**
 * The query string a saved view stores.
 *
 * A view is what was in the address bar, minus the things that were an ACT
 * rather than a state: the id of the view being applied, and the control
 * params the save form itself posts. Storing those would make a view that
 * re-saves itself every time somebody opens it.
 *
 * Keys are sorted so the same list state always produces the same string —
 * which is what lets a screen tell "this is my saved view" from "I have
 * changed something since".
 */

/** Params that describe an action, never a list state. */
export const CONTROL_PARAMS = ['view', 'viewName', 'savedView', 'public', 'makeDefault'] as const;

export function normalizeQuery(
  params: Record<string, string | string[] | undefined>,
  drop: readonly string[] = CONTROL_PARAMS,
): string {
  const dropped = new Set<string>(drop);
  const pairs: [string, string][] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (dropped.has(key)) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    // An empty box is not a filter. Storing `q=` would make a view that looks
    // different from the identical list reached by not typing anything.
    if (value === undefined || value === '') continue;
    pairs.push([key, value]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const search = new URLSearchParams();
  for (const [key, value] of pairs) search.set(key, value);
  return search.toString();
}

/** True when the screen is showing exactly what the view stored. */
export function isSameQuery(current: string, saved: string): boolean {
  return current === saved;
}

/**
 * Publishing a view to everyone is an admin act.
 *
 * Not a new permission (#170: a permission the seed does not know about is a
 * permission nobody can grant) — the same gate that owns the other
 * company-wide settings owns this one.
 */
export const PUBLISH_VIEWS_PERMISSION = 'admin.settings.manage';

export function canPublishViews(permissions: Set<string>): boolean {
  return permissions.has(PUBLISH_VIEWS_PERMISSION);
}
