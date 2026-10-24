import { describe, expect, it } from 'vitest';
import { clipCodePoints, wellFormed, wellFormedJson } from '@/modules/platform/text/clip';
import { capturePairs, normalizeKey } from '@/modules/wms/crm/field-map';

/**
 * Text bound for a jsonb column (review, 2026-10-24). Postgres refuses a lone
 * surrogate there, and the two ways one appears are a UTF-16 `slice` through
 * an emoji and a JSON body that carries one outright.
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('clipCodePoints', () => {
  it('cuts by code points — never half an emoji — and leaves short text alone', () => {
    const edge = `${'x'.repeat(119)}😀 tail`; // the emoji is UTF-16 units 119-120
    expect(edge.slice(0, 120)).toMatch(LONE); // what the old cut left
    const cut = clipCodePoints(edge, 120);
    expect(cut).toBe(`${'x'.repeat(119)}😀`);
    expect(cut).not.toMatch(LONE);
    expect(clipCodePoints('Namuna Savdo', 120)).toBe('Namuna Savdo');
    expect(clipCodePoints('', 5)).toBe('');
  });

  it('a lone half the sender put in the text itself becomes U+FFFD', () => {
    expect(clipCodePoints('a\ud83d', 10)).toBe('a\ufffd');
    expect(wellFormed('b\udc00c')).toBe('b\ufffdc');
    expect(wellFormed('ok 😀')).toBe('ok 😀');
  });
});

describe('wellFormedJson', () => {
  it('serialises a well-formed value exactly as JSON.stringify does', () => {
    const body = {
      name: 'Aziz',
      fields: [{ key: 'kub', value: '5 😀' }],
      n: 3,
      ok: true,
      none: null,
    };
    expect(wellFormedJson(body)).toBe(JSON.stringify(body));
  });

  it('makes every string well-formed — values and keys, at any depth', () => {
    const text = wellFormedJson({ 'k\ud83d': ['v\udc00', { deep: 'x\ud83d' }] });
    // JSON.stringify writes a lone half as an escape; none may survive.
    expect(text).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    expect(JSON.parse(text)).toEqual({ 'k\ufffd': ['v\ufffd', { deep: 'x\ufffd' }] });
  });
});

describe('the field map cuts by code points', () => {
  it('a 300-character answer with an emoji at the edge keeps the whole emoji', () => {
    const value = `${'y'.repeat(299)}🔥🔥`; // the first emoji is units 299-300
    const [pair] = capturePairs([{ key: 'evidence', value }])!;
    expect(pair!.value).toBe(`${'y'.repeat(299)}🔥`);
    expect(pair!.value).not.toMatch(LONE);
  });

  it('…and so does an 80-character key', () => {
    const key = normalizeKey(`${'k'.repeat(79)}😀z`);
    expect(key).toBe(`${'k'.repeat(79)}😀`);
    expect(key).not.toMatch(LONE);
  });
});
