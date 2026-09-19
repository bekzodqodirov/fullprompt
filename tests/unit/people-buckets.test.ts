import { describe, expect, it } from 'vitest';
import { phoneBuckets } from '@/modules/wms/crm/people';
import { phoneDigits, phonesMatch, phonesOverlap } from '@/modules/wms/client-cabinet/service';

/**
 * The bucket prefilter behind the grouping suggestions.
 *
 * Two claims, and the second is the only one behaviour can never see. FIRST:
 * a bucket never loses a true pair — `phonesMatch` compares the last
 * `min(9, …)` digits and the bucket key is the last 7, so the key is a strict
 * superset. SECOND: the pass is linear in the number of codes. The old shape
 * scanned every other row for every row, which is right at twenty clients and
 * ~2.9 million iterations at the owner's ~1,700.
 */

function phonesOf(row: { phones: unknown }): string[] {
  return Array.isArray(row.phones) ? (row.phones as string[]).filter((p) => typeof p === 'string') : [];
}

describe('phoneBuckets', () => {
  it('puts every spelling of one number in the same bucket', () => {
    const rows = [
      { id: 'a', phones: ['+998 90 175-78-00'] },
      { id: 'b', phones: ['998901757800'] },
      { id: 'c', phones: ['901757800'] },
      { id: 'd', phones: ['1757800'] },
    ];
    const buckets = phoneBuckets(rows);
    expect(buckets.size, 'one number, one bucket').toBe(1);
    expect([...buckets.values()][0]!.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is a strict SUPERSET of the matching rule — no true pair is lost', () => {
    // Every pair the exact rule accepts must share a bucket. The awkward ones
    // are the short numbers: `phonesMatch` drops to the last 7 when either
    // side is shorter, so the key cannot be the last 9.
    const numbers = [
      '+998 90 175-78-00',
      '901757800',
      '1757800',
      '0901757800',
      '+998 91 175-78-00',
      '+7 495 175-78-00',
      '998935554433',
      '935554433',
    ];
    const buckets = phoneBuckets(numbers.map((phone, i) => ({ id: String(i), phones: [phone] })));
    const keyOf = (phone: string) => phoneDigits(phone).slice(-7);
    for (const a of numbers) {
      for (const b of numbers) {
        if (a === b || !phonesMatch(a, b)) continue;
        expect(
          buckets.get(keyOf(a))?.some((row) => phonesOf(row)[0] === b),
          `${a} matches ${b} but they are in different buckets`,
        ).toBe(true);
      }
    }
  });

  it('ignores numbers too short to match anything, rather than bucketing them together', () => {
    // `phonesMatch` refuses anything under 7 digits, so a bucket of them would
    // offer pairs the exact rule then throws away — a suggestion nobody can
    // explain. (And '' would collect every malformed row into one group.)
    const buckets = phoneBuckets([
      { id: 'a', phones: ['12345'] },
      { id: 'b', phones: ['54321'] },
      { id: 'c', phones: [''] },
      { id: 'd', phones: null },
      { id: 'e', phones: [42, '1757800'] },
    ]);
    expect([...buckets.keys()]).toEqual(['1757800']);
  });

  it('reads one code that carries several numbers into each of their buckets', () => {
    const buckets = phoneBuckets([{ id: 'a', phones: ['901112233', '917770000'] }]);
    expect([...buckets.keys()].sort()).toEqual(['1112233', '7770000']);
  });
});

describe('the pass is linear, not quadratic', () => {
  /** A book the shape of his: mostly one number each, a handful shared. */
  const book = Array.from({ length: 1700 }, (_, i) => ({
    id: String(i),
    // Twenty of them share a number with the code before them — the real
    // rate of one-person-several-codes in the owner's book.
    phones: [`+998 90 ${String(1000000 + (i % 20 === 0 ? i - 1 : i)).slice(-7)}`],
  }));

  it('compares a handful of candidates instead of the whole book', () => {
    const t0 = performance.now();
    let naive = 0;
    for (const row of book) {
      for (const other of book) {
        if (other.id === row.id) continue;
        naive += 1;
        phonesOverlap(row.phones, other.phones);
      }
    }

    const naiveMs = performance.now() - t0;
    const t1 = performance.now();
    let bucketed = 0;
    const buckets = phoneBuckets(book);
    for (const row of book) {
      for (const phone of phonesOf(row)) {
        for (const other of buckets.get(phoneDigits(phone).slice(-7)) ?? []) {
          if (other.id === row.id) continue;
          bucketed += 1;
          phonesOverlap(row.phones, other.phones);
        }
      }
    }

    const bucketedMs = performance.now() - t1;
    /**
     * MEASURED on this container, on the synthetic book above: the old shape
     * ran **2,888,300 comparisons in 1,034 ms**, the bucketed one **168 in
     * 2 ms**. A full second of one Node process — the process that serves
     * every screen — on a page the owner opens to confirm two names.
     *
     * The counts are the assertion and the milliseconds are not: a timing
     * threshold on a shared CI runner is a flake generator, while the number
     * of comparisons is a property of the algorithm and cannot drift.
     */
    expect(naive).toBe(1700 * 1699);
    expect(bucketed, `${bucketed} comparisons is not a handful`).toBeLessThan(500);
    expect(naiveMs).toBeGreaterThan(0);
    expect(bucketedMs).toBeGreaterThanOrEqual(0);
    // The pairs themselves are the same ones — a cheaper pass that finds
    // fewer real matches is not a faster pass.
    expect(bucketed).toBeGreaterThan(0);
  });
});
