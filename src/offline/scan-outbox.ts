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
 * Flush the queue. Every acked item leaves the outbox (the server made its
 * decision); acks are returned so the UI can react (rollback local marks on
 * rejects, etc.). Throws only on network failure — items stay queued.
 */
export async function flushScans(): Promise<SyncAck[]> {
  const scans = await pendingScans();
  if (scans.length === 0) return [];
  const res = await fetch('/api/scan/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scans }),
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  const { acks } = (await res.json()) as { acks: SyncAck[] };
  await removeScans(acks.map((a) => a.clientEventUuid));
  return acks;
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
