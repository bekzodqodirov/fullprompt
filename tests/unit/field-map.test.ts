import { describe, expect, it } from 'vitest';
import {
  applyFieldMap,
  capturePairs,
  MAX_MEASURE,
  MAX_PAIRS,
  normalizeKey,
  parseMeasure,
  parseYesNo,
  textVolume,
  type MapRow,
} from '@/modules/wms/crm/field-map';

/**
 * The tarjimon's pure decisions (round 97). The rule the adversarial review
 * made structural: nothing here may throw, and nothing here may hand the
 * database a value it cannot hold — a refused parse is an answer that STAYS
 * on the note, never a lost arrival.
 */

let seq = 0;
const rule = (over: Partial<MapRow>): MapRow => ({
  id: `m${seq++}`,
  key: 'k',
  target: 'note',
  fieldId: null,
  ...over,
});

describe('a measure out of a human answer', () => {
  it('reads the shapes people actually type', () => {
    expect(parseMeasure('5')).toBe(5);
    expect(parseMeasure('5 kub')).toBe(5);
    expect(parseMeasure('10,5')).toBe(10.5);
    expect(parseMeasure('taxminan 20 m3')).toBe(20);
    // A range answers with its lower bound — the honest minimum.
    expect(parseMeasure('5-10')).toBe(5);
  });

  it('refuses what the numeric column could not hold, and non-answers', () => {
    // numeric(12,3) holds nine integer digits; a pasted PHONE must not abort
    // the landing with a database overflow (the review's blocker).
    expect(parseMeasure('89901234567')).toBeNull();
    expect(parseMeasure(String(MAX_MEASURE))).toBeNull();
    expect(parseMeasure('bilmayman')).toBeNull();
    expect(parseMeasure('0')).toBeNull();
    expect(parseMeasure('')).toBeNull();
    expect(parseMeasure(null)).toBeNull();
  });
});

describe('ha/yo`q in the languages the forms arrive in', () => {
  it('reads both answers and refuses everything else', () => {
    expect(parseYesNo('Ha')).toBe(true);
    expect(parseYesNo('да')).toBe(true);
    expect(parseYesNo("yo'q")).toBe(false);
    expect(parseYesNo('нет')).toBe(false);
    // An unreadable answer is SKIPPED by the caller, never written as «no».
    expect(parseYesNo('balki')).toBeNull();
    expect(parseYesNo('')).toBeNull();
  });
});

describe('what of a stranger`s pairs is kept', () => {
  it('caps the count and the sizes', () => {
    const flood = Array.from({ length: 100 }, (_, i) => ({
      key: `k${i}` + 'x'.repeat(200),
      value: 'v'.repeat(1000),
    }));
    const kept = capturePairs(flood)!;
    expect(kept).toHaveLength(MAX_PAIRS);
    expect(kept[0]!.key.length).toBeLessThanOrEqual(80);
    expect(kept[0]!.value.length).toBeLessThanOrEqual(300);
  });

  it('drops the names a shared secret travels under', () => {
    const kept = capturePairs([
      { key: 'google_key', value: 'sekret' },
      { key: 'KEY', value: 'sekret' },
      { key: 'token', value: 'sekret' },
      { key: 'kub', value: '5' },
    ]);
    expect(kept).toEqual([{ key: 'kub', value: '5' }]);
  });

  it('answers null over nothing — the column stays honest about absence', () => {
    expect(capturePairs([])).toBeNull();
    expect(capturePairs(null)).toBeNull();
    expect(capturePairs([{ key: '', value: 'x' }])).toBeNull();
  });
});

describe('applying the map', () => {
  const active = new Set(['f1']);

  it('keys match case-insensitively — the map and the arrival must agree on one spelling', () => {
    const out = applyFieldMap(
      [{ key: 'Necha_KUB', value: '7 kub' }],
      [rule({ key: normalizeKey('necha_kub'), target: 'kub' })],
      active,
    );
    expect(out.volumeM3).toBe(7);
  });

  it('kub, kg and field targets each land; note is a decision that changes nothing', () => {
    const out = applyFieldMap(
      [
        { key: 'kub', value: '5' },
        { key: 'kg', value: '120 kg' },
        { key: 'bazada', value: 'ha' },
        { key: 'shahar', value: 'Toshkent' },
      ],
      [
        rule({ key: 'kub', target: 'kub' }),
        rule({ key: 'kg', target: 'kg' }),
        rule({ key: 'bazada', target: 'field', fieldId: 'f1' }),
        rule({ key: 'shahar', target: 'note' }),
      ],
      active,
    );
    expect(out.volumeM3).toBe(5);
    expect(out.weightKg).toBe(120);
    expect(out.custom).toEqual([{ fieldId: 'f1', value: 'ha' }]);
  });

  it('a mapping whose field was deactivated degrades to note-only', () => {
    // The write path would store a value no card renders, silently, for ever.
    const out = applyFieldMap(
      [{ key: 'bazada', value: 'ha' }],
      [rule({ key: 'bazada', target: 'field', fieldId: 'f_dead' })],
      active,
    );
    expect(out.custom).toEqual([]);
  });

  it('an unparseable kub answer maps to nothing — the note keeps it', () => {
    const out = applyFieldMap(
      [{ key: 'kub', value: 'katta yuk' }],
      [rule({ key: 'kub', target: 'kub' })],
      active,
    );
    expect(out.volumeM3).toBeNull();
  });
});

describe('a volume out of free text — the routing fallback', () => {
  it('finds «25 kub» however the door spelled it', () => {
    expect(textVolume('Aziz', '25 kub yuk bor')).toBe(25);
    expect(textVolume(null, 'примерно 12 куб')).toBe(12);
    expect(textVolume('10 m3 kerak')).toBe(10);
  });

  it('a bare number is NOT a volume — only a number that names its unit', () => {
    // «25» in a note could be boxes, kilos or a house number; guessing here
    // routes a lead by a coin flip.
    expect(textVolume('25 quti yuk')).toBeNull();
    expect(textVolume(null, null)).toBeNull();
  });
});
