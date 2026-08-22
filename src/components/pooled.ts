/**
 * Run one job per item, at most `limit` of them at a time.
 *
 * Written for the receive wizard's photographs (owner, go-live day:
 * «rasimlarni yuklaganda juda sekin yuklayabti»), where the items are ten to
 * twenty pictures that each need compressing on the phone and uploading from
 * China to a European server. Serially that is the SUM of twenty high-latency
 * round trips; overlapped it is roughly the slowest few.
 *
 * Bounded on purpose, and the bound protects two different things at once: a
 * warehouse Android compressing twenty 12-megapixel photographs at the same
 * moment runs out of memory, and twenty simultaneous uploads over a thin
 * connection finish later than four do.
 *
 * `work` is expected to handle its own failures — this returns when every
 * item has been attempted, and one item's rejection must not cancel the rest
 * (a dropped photo is not a reason to drop the nineteen behind it).
 */
export async function runPooled<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const workers = Array.from({ length: size }, async () => {
    // Each worker takes the next index until they run out; `next++` is safe
    // because JavaScript runs this synchronously between awaits.
    for (let i = next++; i < items.length; i = next++) {
      await work(items[i]!).catch(() => {});
    }
  });
  await Promise.all(workers);
}

/**
 * Four at a time. Measured against nothing — it is a judgement, not a
 * finding: enough to hide the latency of a slow link, few enough that a cheap
 * phone still has memory for the compressor and the operator sees the first
 * thumbnails appear quickly rather than all of them at the end.
 */
export const PHOTO_UPLOAD_CONCURRENCY = 4;
