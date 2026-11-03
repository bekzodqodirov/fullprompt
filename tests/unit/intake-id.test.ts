import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  externalIdSpellings,
  INDEX_SAFE_ID_BYTES,
  oversizeIdSpelling,
} from '@/modules/wms/crm/inbound';

/**
 * The spelling an arrival's external id is stored under when the ledger's
 * unique index refuses its own (fourth review, 2026-10-24;
 * docs/AGENT-FEED.md §1). The expected hash is computed here from its
 * definition — the hex SHA-256 of the id's UTF-8 bytes — not by the code
 * under test.
 */
const sha = (id: string) =>
  `sha256:${createHash('sha256').update(Buffer.from(id, 'utf8')).digest('hex')}`;

describe('an id the index always takes', () => {
  it('has no second spelling — at the limit counted in UTF-8 bytes, not in characters', () => {
    for (const id of [
      'cs:00000000-0000-4000-8000-000000000001:202610',
      'x'.repeat(INDEX_SAFE_ID_BYTES),
      // Four bytes each: 512 emoji are exactly the limit.
      '😀'.repeat(INDEX_SAFE_ID_BYTES / 4),
      // Two bytes each.
      'ж'.repeat(INDEX_SAFE_ID_BYTES / 2),
    ]) {
      expect(oversizeIdSpelling(id), id.slice(0, 20)).toBeNull();
      expect(externalIdSpellings(id)).toEqual([id]);
    }
  });
});

describe('an id the index may refuse', () => {
  it('is spelled `sha256:` and the hex digest of its bytes, one byte past the limit', () => {
    for (const id of [
      'x'.repeat(INDEX_SAFE_ID_BYTES + 1),
      `a${'😀'.repeat(INDEX_SAFE_ID_BYTES / 4)}`,
      `ж${'ж'.repeat(INDEX_SAFE_ID_BYTES / 2)}`,
    ]) {
      expect(oversizeIdSpelling(id)).toBe(sha(id));
      expect(oversizeIdSpelling(id)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(externalIdSpellings(id)).toEqual([id, sha(id)]);
    }
  });

  it('is the same spelling every time, and two ids stay two (a clip would merge them)', () => {
    const base = 'y'.repeat(INDEX_SAFE_ID_BYTES + 100);
    expect(oversizeIdSpelling(base)).toBe(oversizeIdSpelling(`${base}`));
    expect(oversizeIdSpelling(`${base}1`)).not.toBe(oversizeIdSpelling(`${base}2`));
  });

  it('leaves the measured edge of the index well clear — 2,680 random bytes on the longest channel name', () => {
    // Measured 2026-10-24 on postgres 16: the index took 2,684 random bytes
    // on every channel but `telegram` (2,680). The integration test lands a
    // longer id than this limit and finds it stored as sent.
    expect(INDEX_SAFE_ID_BYTES).toBeLessThanOrEqual(2680 - 512);
  });
});
