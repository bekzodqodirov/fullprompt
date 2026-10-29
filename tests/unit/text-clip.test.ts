import { describe, expect, it } from 'vitest';
import { clipUnits, storableJson, storableText } from '@/modules/platform/text/clip';
import { capturePairs, normalizeKey } from '@/modules/wms/crm/field-map';

/**
 * Text bound for postgres (reviews, 2026-10-24). jsonb refuses a lone
 * surrogate, a text column and jsonb both refuse NUL, and a JSON body carries
 * either outright; a UTF-16 `slice` through an emoji makes the first. The cut
 * keeps the old UTF-16 budget, so every spelling the old cut stored is the
 * same today (the third review: a field-map key saved last month).
 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('clipUnits', () => {
  it('leaves an emoji that does not fit out whole — never half of it — and short text alone', () => {
    const edge = `${'x'.repeat(119)}😀 tail`; // the emoji is UTF-16 units 119-120
    expect(edge.slice(0, 120)).toMatch(LONE); // what the old cut left
    const cut = clipUnits(edge, 120);
    expect(cut).toBe('x'.repeat(119));
    expect(clipUnits(`${'x'.repeat(118)}😀 tail`, 120)).toBe(`${'x'.repeat(118)}😀`);
    expect(clipUnits('Namuna Savdo', 120)).toBe('Namuna Savdo');
    expect(clipUnits('', 5)).toBe('');
  });

  it('is the old `slice` for every text that slice could store — the budget is UTF-16 units', () => {
    const question =
      '📦 yukingiz taxminan necha kub bo‘ladi? (bilmasangiz «bilmayman» deb yozing, menejer hisoblab beradi) 1234567';
    expect(question.length).toBeGreaterThan(100);
    for (const text of [
      question,
      '🌸'.repeat(110) + ' Dilnoza opa',
      '✅ Ha 🚚 ' + 'x'.repeat(320),
      '𠮷野家 '.repeat(40),
      'plain ascii '.repeat(30),
    ]) {
      for (const max of [80, 120, 200, 300]) {
        const old = text.slice(0, max);
        if (LONE.test(old)) continue; // the case that used to throw — the only one that changes
        expect(clipUnits(text, max), `${max}: ${text.slice(0, 12)}`).toBe(old);
      }
      // …and none is ever longer than the budget a schema or a field counts.
      expect(clipUnits(text, 120).length).toBeLessThanOrEqual(120);
    }
  });

  it('a lone half or a NUL the sender put in the text itself becomes U+FFFD, one unit for one', () => {
    expect(clipUnits('a\ud83d', 10)).toBe('a�');
    expect(storableText('b\udc00c')).toBe('b�c');
    expect(storableText('ok 😀')).toBe('ok 😀');
    expect(storableText('salom \u0000 dunyo')).toBe('salom � dunyo');
    expect(clipUnits('a\u0000b', 2)).toBe('a�');
  });
});

describe('storableJson', () => {
  it('serialises a value with nothing to fix exactly as JSON.stringify does — escapes and backslashes included', () => {
    const body = {
      name: 'Aziz',
      fields: [{ key: 'kub', value: '5 😀' }],
      n: 3,
      ok: true,
      none: null,
      // The LETTERS «\u0000» and «\ud83d» after a typed backslash are text,
      // not an escape, and stay as typed.
      typed: 'a\\u0000 b\\\\ud83d \t\n\u0001',
    };
    expect(storableJson(body)).toBe(JSON.stringify(body));
    expect(JSON.parse(storableJson(body))).toEqual(body);
  });

  it('makes every string storable — values and keys, at any depth', () => {
    const text = storableJson({
      'k\ud83d': ['v\udc00', { deep: 'x\ud83d', nul: 'a\u0000b', 'n\u0000': 'after\\\u0000' }],
    });
    // JSON.stringify writes a lone half and a NUL as escapes; none may survive.
    expect(text).not.toMatch(/(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/i);
    expect(JSON.parse(text)).toEqual({
      'k�': ['v�', { deep: 'x�', nul: 'a�b', 'n�': 'after\\�' }],
    });
  });

  it('nests as deep as JSON.stringify does — it costs the serialiser no stack of its own', () => {
    const nested = (depth: number) => {
      let value: unknown = 'x';
      for (let i = 0; i < depth; i++) value = [value];
      return { meta: value };
    };
    const writes = (fn: (v: unknown) => string, depth: number) => {
      try {
        fn(nested(depth));
        return true;
      } catch {
        return false;
      }
    };
    // The deepest body JSON.stringify writes here, found by halving.
    let ok = 1;
    let bad = 1 << 16;
    while (bad - ok > 1) {
      const mid = (ok + bad) >> 1;
      if (writes(JSON.stringify, mid)) ok = mid;
      else bad = mid;
    }
    expect(ok).toBeGreaterThan(1000);
    // A replacer function cost about half of it (the third review measured
    // 6,000 → 3,000); a tenth's margin for the stack this call stands on.
    expect(writes(storableJson, Math.floor(ok * 0.9))).toBe(true);
  });
});

describe('the field map keeps the old budget', () => {
  it('a long question with an emoji in its first 80 units is spelled as the old cut spelled it', () => {
    const question = `📦 yukingiz taxminan necha kub bo‘ladi? (bilmasangiz «bilmayman» deb yozing, menejer hisoblab beradi) 1`;
    const saved = question.trim().toLowerCase().slice(0, 80); // what a mapping saved before this release holds
    expect(normalizeKey(question)).toBe(saved);
    expect(normalizeKey(saved)).toBe(saved);
  });

  it('a 300-unit answer with an emoji at the edge leaves it out whole, and never passes 300 units', () => {
    const value = `${'y'.repeat(299)}🔥🔥`; // the first emoji is units 299-300
    const [pair] = capturePairs([{ key: 'evidence', value }])!;
    expect(pair!.value).toBe('y'.repeat(299));
    const [astral] = capturePairs([{ key: 'javob', value: '✅ Ha 🚚 ' + 'x'.repeat(320) }])!;
    expect(astral!.value.length).toBe(300);
  });

  it('…and an 80-unit key, and a NUL in either', () => {
    expect(normalizeKey(`${'k'.repeat(79)}😀z`)).toBe('k'.repeat(79));
    expect(capturePairs([{ key: 'k\u0000', value: 'v\u0000' }])).toEqual([
      { key: 'k�', value: 'v�' },
    ]);
  });
});
