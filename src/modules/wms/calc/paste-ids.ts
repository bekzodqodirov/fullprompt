/**
 * Which client id each line of a pasted goods list carries (phase 0 of the
 * phone round). Zero imports: the browser runs it, and the test calls it.
 *
 * A paste whose answer was lost has already landed under the last press's
 * ids, and the screen says «save failed» — so the second press must post
 * those same ids or the server cannot know the rows are already there. Keyed
 * per whole TEXT, a single typo fixed in between re-minted every id and the
 * request held the paste twice (review units-2). Now, in order:
 *   1. a line identical to one the last press sent keeps that line's id
 *      (identical lines consume their ids in order);
 *   2. a line that matches nothing takes the next id the last press used
 *      that this one has not matched — the corrected line becomes an EDIT of
 *      the row its typo'd self landed as, which `saveTable` applies;
 *   3. only a line beyond both mints a new id.
 * A line DELETED between the presses leaves its id unused: the row it
 * landed as stays (a removal is a delete, never a side effect of a retry).
 */
export function pasteIdsFor(
  prev: { keys: string[]; ids: (string | null)[] },
  keys: string[],
  mint: () => string | null,
): (string | null)[] {
  const byKey = new Map<string, number[]>();
  prev.keys.forEach((k, i) => {
    const list = byKey.get(k) ?? [];
    list.push(i);
    byKey.set(k, list);
  });
  const used = new Set<number>();
  const out: (string | null | undefined)[] = keys.map((k) => {
    const i = byKey.get(k)?.shift();
    if (i === undefined) return undefined;
    used.add(i);
    return prev.ids[i] ?? null;
  });
  const leftovers = prev.ids.map((_, i) => i).filter((i) => !used.has(i));
  return out.map((v) => {
    if (v !== undefined) return v;
    const i = leftovers.shift();
    return i === undefined ? mint() : (prev.ids[i] ?? mint());
  });
}
