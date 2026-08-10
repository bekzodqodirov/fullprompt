'use client';

/**
 * Offline scan outbox (spec §15, edge cases 13/14): scans queue in IndexedDB
 * with client-generated idempotency UUIDs and flush to /api/scan/sync when
 * online. Replays are safe — the server dedupes on the UUID.
 */

export interface OutboxScan {
  clientEventUuid: string;
  batchId: string;
  code: string;
  method: 'qr' | 'manual';
  manualReason?: string;
  addedOnSpot: boolean;
  addedReason?: string;
  scannedAt: string;
  scanType?: 'load' | 'unload';
}

export interface SyncAck {
  clientEventUuid: string;
  result: 'ok' | 'duplicate' | 'not_on_plan' | 'auto_transfer' | 'unknown_code' | 'rejected';
  detail?: string;
  boxes?: { shortCode: string; letter: string | null }[];
  /**
   * The code as it was scanned — a crate code stays a crate code.
   *
   * The screen needs it to re-open the not-on-plan confirm for the RIGHT
   * thing: re-sending a crate's member boxes one by one would lose the fact
   * that a crate was loaded, and the loader scanned a crate.
   */
  scannedCode?: string;
  /**
   * Boxes found inside a scanned CRATE that this truck's plan does not cover.
   *
   * The crate loaded — it is this truck's crate — but these particular boxes
   * did not, so the screen has to say so. Silence here is the failure mode
   * this whole area exists to prevent: cargo crossing a border that the
   * manifest and the customs invoice never heard of (#221).
   */
  unplanned?: string[];
}

/**
 * Did the server actually record this scan?
 *
 * The screen marks a box the instant it is scanned — that responsiveness is
 * the point — so every verdict has to be classified, and one that was
 * forgotten is a box on a truck the system does not know about. `not_on_plan`
 * was the forgotten one: the loading screen toasted only `unknown_code` and
 * `rejected`, so a refused crate kept its green tick and its place in the
 * count, and the outbox dropped it.
 *
 * Written as a function over the verdict union rather than as a condition
 * inside the component, so a verdict added later cannot be silently left out
 * of the classification — the test enumerates the union and fails if one is
 * unaccounted for (DECISIONS #163, #166).
 */
export function scanWasRecorded(result: SyncAck['result']): boolean {
  switch (result) {
    // Written now, written before, or written against the destination batch.
    case 'ok':
    case 'duplicate':
    case 'auto_transfer':
      return true;
    // Nothing was written. The screen must take its mark back.
    case 'not_on_plan':
    case 'unknown_code':
    case 'rejected':
      return false;
  }
}

/** Verdicts that mean "ask the loader whether to add it deliberately". */
export function scanNeedsConfirm(result: SyncAck['result']): boolean {
  return result === 'not_on_plan';
}

const DB_NAME = 'gsr-offline';
const STORE = 'scan-outbox';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'clientEventUuid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const dbHandle = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = dbHandle.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    tx.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
    tx.onerror = () => reject(tx.error);
  });
}

export async function enqueueScan(scan: OutboxScan): Promise<void> {
  await withStore('readwrite', (store) => {
    store.put(scan);
  });
}

export async function pendingScans(): Promise<OutboxScan[]> {
  return withStore<OutboxScan[]>('readonly', (store) => store.getAll() as IDBRequest<OutboxScan[]>);
}

export async function removeScans(uuids: string[]): Promise<void> {
  await withStore('readwrite', (store) => {
    for (const uuid of uuids) store.delete(uuid);
  });
}

/**
 * The server's own ceiling: `/api/scan/sync` validates `scans` as
 * `.min(1).max(200)`, so a 201st row makes it refuse the WHOLE body.
 */
export const MAX_PER_SYNC = 200;

/**
 * Codes the server can even consider. Mirrors `loadScanSchema`'s
 * `min(3).max(40)` — deliberately a restatement rather than an import,
 * because this file runs in the browser and must not pull the server's
 * schema module into the phone's bundle.
 *
 * The unload screen sends codes it does not recognise ON PURPOSE (reality
 * wins at unload: the server decides auto-transfer vs unknown). But a
 * supplier's own QR on a Chinese carton is a URL forty or more characters
 * long, and that one is not "unknown", it is unsendable — and queueing it
 * used to poison every scan behind it.
 */
export function isSendableCode(code: string): boolean {
  const clean = code.trim();
  return clean.length >= 3 && clean.length <= 40;
}

export interface FlushResult {
  acks: SyncAck[];
  /**
   * Rows the SERVER refused as malformed. They are out of the queue — they
   * were never going to be accepted, and retrying them for ever is what
   * jammed every scan behind them.
   */
  discarded: OutboxScan[];
  /**
   * The server said no to the person, not to the data (403 / session gone).
   * These stay queued: logging in again makes them sendable, and dropping a
   * real scan because a session expired would lose cargo.
   */
  refusedForbidden: boolean;
}

async function postSlice(scans: OutboxScan[]): Promise<Response> {
  return fetch('/api/scan/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scans }),
  });
}

/**
 * Send one slice, splitting it until the rows the server refuses are alone.
 *
 * A 400 is a verdict on the BODY, not on a row, so the whole slice used to
 * die together — and with it every good scan queued behind the bad one. The
 * bisection costs at most a handful of extra requests on a slice of 200 and
 * only happens when something is actually wrong.
 */
async function sendSlice(
  slice: OutboxScan[],
  out: { acks: SyncAck[]; discarded: OutboxScan[] },
): Promise<'ok' | 'forbidden'> {
  const res = await postSlice(slice);
  if (res.ok) {
    const { acks } = (await res.json()) as { acks: SyncAck[] };
    out.acks.push(...acks);
    await removeScans(acks.map((a) => a.clientEventUuid));
    return 'ok';
  }
  if (res.status === 401 || res.status === 403) return 'forbidden';
  if (res.status === 400) {
    if (slice.length === 1) {
      out.discarded.push(slice[0]!);
      await removeScans([slice[0]!.clientEventUuid]);
      return 'ok';
    }
    const half = Math.ceil(slice.length / 2);
    const a = await sendSlice(slice.slice(0, half), out);
    const b = await sendSlice(slice.slice(half), out);
    return a === 'forbidden' || b === 'forbidden' ? 'forbidden' : 'ok';
  }
  // 5xx and anything else: the server is having a bad minute, not a bad
  // opinion. Keep the rows and let the next tick try again.
  throw new Error(`sync ${res.status}`);
}

/**
 * Flush the queue. Every acked item leaves the outbox (the server made its
 * decision); acks are returned so the UI can react (rollback local marks on
 * rejects, etc.). Throws only on network failure — items stay queued.
 */
export async function flushScans(): Promise<FlushResult> {
  const scans = await pendingScans();
  const out: { acks: SyncAck[]; discarded: OutboxScan[] } = { acks: [], discarded: [] };
  if (scans.length === 0) return { ...out, refusedForbidden: false };
  let forbidden = false;
  for (let i = 0; i < scans.length; i += MAX_PER_SYNC) {
    const verdict = await sendSlice(scans.slice(i, i + MAX_PER_SYNC), out);
    if (verdict === 'forbidden') {
      forbidden = true;
      break;
    }
  }
  return { ...out, refusedForbidden: forbidden };
}

/**
 * Which boxes a scanned code puts on THIS truck.
 *
 * Extracted from the loading screen because it is the rule that stopped a
 * warehouse mid-load, and a rule that only exists inside a component is a
 * rule no test can call (#166).
 *
 * A loose box is itself. A crate is the boxes of it that this batch's plan
 * covers — NOT every box physically inside it. The loading snapshot ships the
 * crate's real contents, and a crate collects strays: one more fitted in
 * after the plan was approved, a lot the planner did not list. Demanding all
 * of them meant the operator held a crate the plan had asked for and the
 * phone answered "not on plan".
 *
 * An empty answer means "nothing here belongs to this truck" — the red
 * confirm — and is deliberately distinguished from a one-box answer, because
 * `[].every(...)` is `true` and would have waved the wrong crate straight
 * through.
 */
export function boxesForScan(
  code: string,
  crates: { code: string; boxShortCodes: string[] }[],
  onTruck: ReadonlySet<string>,
  quick: boolean,
): string[] {
  const crate = crates.find((c) => c.code === code);
  if (!crate) return [code];
  if (quick) return crate.boxShortCodes;
  return crate.boxShortCodes.filter((c) => onTruck.has(c));
}
