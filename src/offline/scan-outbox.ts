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
}

export interface SyncAck {
  clientEventUuid: string;
  result: 'ok' | 'duplicate' | 'not_on_plan' | 'unknown_code' | 'rejected';
  detail?: string;
  boxes?: { shortCode: string; letter: string | null }[];
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
