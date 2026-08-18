import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DUMP_RESERVE_BYTES,
  bytesAllowed,
  objectFileName,
  storageKeyFromFileName,
} from '@/modules/platform/backup/objects';
import { adoptRecentDump } from '@/modules/platform/backup/run';
import { inspectDump } from '@/modules/platform/backup/restore-test';

/**
 * The rules the object backup is made of, without a Google account and
 * without an object store.
 */

describe('the photographs may never crowd out the database', () => {
  const GB = 1024 * 1024 * 1024;

  it('keeps the reserve free whatever the cap allows', () => {
    // 5 GB free, 2 GB held back for the dump → 3 GB of photographs tonight.
    expect(bytesAllowed(5 * GB, DUMP_RESERVE_BYTES, 10 * GB)).toBe(3 * GB);
  });

  it('refuses outright once the reserve is all that is left', () => {
    expect(bytesAllowed(DUMP_RESERVE_BYTES, DUMP_RESERVE_BYTES, 10 * GB)).toBe(0);
    expect(bytesAllowed(1 * GB, DUMP_RESERVE_BYTES, 10 * GB)).toBe(0);
    // A destination that is already over is not a negative allowance.
    expect(bytesAllowed(0, DUMP_RESERVE_BYTES, 10 * GB)).toBe(0);
  });

  it('the per-run cap still applies when there is plenty of room', () => {
    expect(bytesAllowed(500 * GB, DUMP_RESERVE_BYTES, 4 * GB)).toBe(4 * GB);
  });

  it('a destination that reports no quota gets the cap and no invented fence', () => {
    // A bucket bills, it does not refuse — pretending to know its free space
    // would be a fence made of a guess.
    expect(bytesAllowed(null, DUMP_RESERVE_BYTES, 4 * GB)).toBe(4 * GB);
  });
});

describe('a storage key survives the trip to a flat destination and back', () => {
  it('round-trips the real key shape', () => {
    const key = 'receipt/6f1d2c9e-1111-4b2a-9c3d-000000000001/9a7b6c5d-2222-4e3f-8a9b-000000000002';
    expect(storageKeyFromFileName(objectFileName(key))).toBe(key);
    expect(objectFileName(key)).not.toContain('/');
  });

  it('refuses a key it could not reverse rather than writing an unrestorable name', () => {
    // Nothing produces a key with a tilde today; if anything ever does, the
    // backup must stop rather than store a file nobody can put back.
    expect(() => objectFileName('receipt/a~b/c')).toThrow();
  });
});

describe('what can be said about a dump without restoring it', () => {
  it('a file that is not a pg_dump is a failure, whatever its size', () => {
    expect(inspectDump(false, 500_000, null).ok).toBe(false);
  });

  it('an empty file is a failure', () => {
    expect(inspectDump(true, 0, null).ok).toBe(false);
  });

  it('a dump that suddenly halved is a failure — the shape a real disaster takes', () => {
    // Valid file, right name, right date, half the business missing.
    expect(inspectDump(true, 400_000, 1_000_000).ok).toBe(false);
    expect(inspectDump(true, 900_000, 1_000_000).ok).toBe(true);
  });

  it('the first ever dump has nothing to compare against and passes on its own merits', () => {
    expect(inspectDump(true, 1_000_000, null).ok).toBe(true);
    expect(inspectDump(true, 1_000_000, 0).ok).toBe(true);
  });
});

describe('adopting the dump another container took', () => {
  function dir(files: { name: string; bytes: number; ageHours: number }[]): string {
    const d = mkdtempSync(path.join(tmpdir(), 'gsr-adopt-'));
    for (const f of files) {
      const full = path.join(d, f.name);
      writeFileSync(full, Buffer.alloc(f.bytes, 1));
      const when = new Date(Date.now() - f.ageHours * 3600 * 1000);
      utimesSync(full, when, when);
    }
    return d;
  }

  it('takes the freshest dump of either naming scheme', () => {
    // The app writes gsr-YYYY-MM-DD, ops/backup.sh writes gsr-YYYYMMDD-HHMMSS.
    const d = dir([
      { name: 'gsr-2026-08-15.dump', bytes: 5000, ageHours: 20 },
      { name: 'gsr-20260816-020000.dump', bytes: 6000, ageHours: 2 },
    ]);
    expect(adoptRecentDump(d)?.file.endsWith('gsr-20260816-020000.dump')).toBe(true);
  });

  it('will not adopt a stale dump — an old copy shipped as tonight is a lie', () => {
    const d = dir([{ name: 'gsr-20260810-020000.dump', bytes: 6000, ageHours: 100 }]);
    expect(adoptRecentDump(d)).toBeNull();
  });

  it('will not adopt an empty file', () => {
    const d = dir([{ name: 'gsr-20260816-020000.dump', bytes: 0, ageHours: 1 }]);
    expect(adoptRecentDump(d)).toBeNull();
  });

  it('ignores anything that is not a dump, and a directory that is not there', () => {
    const d = dir([
      { name: 'notes.txt', bytes: 9000, ageHours: 1 },
      { name: 'gsr-backup.tar', bytes: 9000, ageHours: 1 },
    ]);
    expect(adoptRecentDump(d)).toBeNull();
    expect(adoptRecentDump(path.join(d, 'nope'))).toBeNull();
  });
});
