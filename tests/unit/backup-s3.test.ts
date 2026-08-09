import { describe, expect, it } from 'vitest';
import { backupS3Config, dumpsToPrune, type StoredDump } from '@/modules/platform/backup/s3';

/**
 * The off-site destination's decisions, without a bucket.
 *
 * What can be wrong here is small and expensive: a half-configured
 * destination that reads as «configured» takes a backup nowhere and says
 * nothing, and a prune that sorts by the wrong thing deletes the copy you
 * would have wanted.
 */

const FULL = {
  BACKUP_S3_ENDPOINT: 'https://eu2.contabostorage.com',
  BACKUP_S3_BUCKET: 'gsr',
  BACKUP_S3_KEY: 'key',
  BACKUP_S3_SECRET: 'secret',
};

describe('the destination is configured or it is not', () => {
  it('needs all four, and any one missing means not configured', () => {
    expect(backupS3Config(FULL)).not.toBeNull();
    for (const drop of Object.keys(FULL)) {
      const partial = { ...FULL, [drop]: undefined };
      expect(backupS3Config(partial), `missing ${drop}`).toBeNull();
    }
    // A variable somebody set to nothing is the shape a half-finished setup
    // actually takes, and it must read the same as absent.
    expect(backupS3Config({ ...FULL, BACKUP_S3_SECRET: '   ' })).toBeNull();
  });

  it('defaults the region and normalises the prefix', () => {
    // Most S3 clones ignore the region, but the SDK will not sign without one
    // — so it is a default rather than a fifth thing to get right.
    expect(backupS3Config(FULL)?.region).toBe('auto');
    expect(backupS3Config({ ...FULL, BACKUP_S3_REGION: 'eu-central-1' })?.region).toBe(
      'eu-central-1',
    );
    // Slashes typed either side of the prefix must not become an empty path
    // segment, which most buckets accept and then nobody can find the file.
    expect(backupS3Config({ ...FULL, BACKUP_S3_PREFIX: '/nusxa/' })?.prefix).toBe('nusxa');
    expect(backupS3Config(FULL)?.prefix).toBe('gsr-backups');
  });
});

describe('what gets pruned', () => {
  const dump = (key: string, iso: string): StoredDump => ({
    key,
    bytes: 10,
    modified: new Date(iso),
  });

  it('keeps the newest N by the bucket’s own timestamp, not by the name', () => {
    // A filename is a claim and a timestamp is a fact: a dump written under a
    // hand-typed name, or re-uploaded after a restore test, would otherwise
    // sort as though it were old and be the first thing deleted.
    const dumps = [
      dump('b/gsr-2026-08-01.dump', '2026-08-09T00:00:00Z'),
      dump('b/gsr-2026-08-09.dump', '2026-08-01T00:00:00Z'),
      dump('b/gsr-2026-08-05.dump', '2026-08-05T00:00:00Z'),
    ];
    expect(dumpsToPrune(dumps, 2).map((d) => d.key)).toEqual(['b/gsr-2026-08-09.dump']);
  });

  it('deletes nothing when there is nothing past the window', () => {
    const dumps = [dump('b/a.dump', '2026-08-09T00:00:00Z')];
    expect(dumpsToPrune(dumps, 30)).toEqual([]);
    expect(dumpsToPrune([], 30)).toEqual([]);
  });

  it('refuses to delete everything when retention is zero or negative', () => {
    // `keep = 0` through a plain slice would return the whole list — one
    // mistyped environment variable and every backup goes on the night it
    // was set. Nothing is a safer answer than everything.
    const dumps = [
      dump('b/a.dump', '2026-08-09T00:00:00Z'),
      dump('b/b.dump', '2026-08-08T00:00:00Z'),
    ];
    expect(dumpsToPrune(dumps, 0)).toEqual([]);
    expect(dumpsToPrune(dumps, -1)).toEqual([]);
  });
});
