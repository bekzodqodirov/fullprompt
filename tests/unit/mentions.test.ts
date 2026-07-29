import { describe, expect, it } from 'vitest';
import { extractMentions, mentionCandidates } from '@/modules/wms/crm/mentions';

/**
 * The mention decision, pure. announceNote is fire-and-forget with a
 * swallowed catch — a parsing bug there never surfaces to the author — so
 * this file carries the correctness weight for who gets pinged.
 */

const people = [
  { id: 'aziz', name: 'Aziz' },
  { id: 'aziz-k', name: 'Aziz Karimov' },
  { id: 'dilnoza', name: 'Dilnoza Sattorova' },
  { id: 'wang', name: '王磊' },
];

describe('extractMentions', () => {
  it('finds a mention wherever it stands, case-insensitively', () => {
    expect(extractMentions('@aziz karimov narxni tekshiring', people)).toEqual(['aziz-k']);
    expect(extractMentions('bugun @Dilnoza Sattorova bilan gaplashdik', people)).toEqual([
      'dilnoza',
    ]);
  });

  it('the longest name claims the span — never a name plus a stray surname', () => {
    const ids = extractMentions('@Aziz Karimov yordam bering', people);
    expect(ids).toEqual(['aziz-k']);
    // The short Aziz alone still works.
    expect(extractMentions('@Aziz yordam bering', people)).toEqual(['aziz']);
  });

  it('an email address is not a mention', () => {
    expect(extractMentions('yozing: bekzod@aziz.uz', people)).toEqual([]);
  });

  it('trailing punctuation does not break a mention', () => {
    expect(extractMentions('rahmat, @Aziz!', people)).toEqual(['aziz']);
  });

  it('non-Latin names work — half the warehouse writes in Chinese', () => {
    expect(extractMentions('@王磊 请检查', people)).toEqual(['wang']);
  });

  it('two mentions, two people, each once', () => {
    const ids = extractMentions('@Aziz va @Dilnoza Sattorova, ko‘rib chiqinglar. @Aziz yana', people);
    expect(new Set(ids)).toEqual(new Set(['aziz', 'dilnoza']));
  });

  it('a duplicate full name pings every holder — better both than a guess', () => {
    const twins = [
      { id: 'a1', name: 'Aziz' },
      { id: 'a2', name: 'Aziz' },
    ];
    expect(new Set(extractMentions('@Aziz qarang', twins))).toEqual(new Set(['a1', 'a2']));
  });

  it('text without an @ passes through untouched', () => {
    expect(extractMentions('Aziz bilan gaplashdim, hammasi joyida', people)).toEqual([]);
  });
});

describe('mentionCandidates', () => {
  it('filters by any part of the name and caps the list', () => {
    expect(mentionCandidates('sat', people).map((p) => p.id)).toEqual(['dilnoza']);
    expect(mentionCandidates('aziz', people).map((p) => p.id)).toEqual(['aziz', 'aziz-k']);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `Ism ${i}` }));
    expect(mentionCandidates('', many)).toHaveLength(6);
  });
});
