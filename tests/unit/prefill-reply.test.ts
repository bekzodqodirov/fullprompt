import { describe, expect, it } from 'vitest';
import { blockerText, prefillReplyText } from '@/modules/wms/calc/prefill-reply';

/**
 * What the AI VED hodimi says back into the staff chat.
 *
 * Pure on purpose: the numbers come from the engine and the words come from
 * here, so a wording change can never move a figure. What these assertions
 * protect is law 6 (never a $0, never a silence) and the owner's own answer
 * 6 — the figure is TAHMINIY and the official price is the seal.
 */

const base = {
  customsUsd: null as number | null,
  freightUsd: null as number | null,
  hasFreight: false,
  blockers: [],
  codesStamped: 0,
  ratesPulled: 0,
  importFilled: 0,
  link: null as string | null,
  aiConfigured: true,
};

describe('a figure never travels without the word «tahminiy»', () => {
  it('states the estimate and the caveat together', () => {
    const t = prefillReplyText({ ...base, customsUsd: 248 });
    expect(t).toContain('Tahminiy');
    expect(t).toContain('$248.00');
    // The caveat is its own line, right under the number: a screenshot of
    // the figure cannot lose it.
    expect(t.split('\n')[1]).toContain('Rasmiy emas');
  });

  it('names BOTH halves on a podklyuch quote', () => {
    const t = prefillReplyText({ ...base, hasFreight: true, customsUsd: 248, freightUsd: 4800 });
    expect(t).toContain('rastamojka ~$248.00');
    expect(t).toContain('yo‘lkira ~$4800.00');
  });

  it('says so when the freight half is MISSING rather than printing customs alone', () => {
    // «rastamojka ~$248» by itself reads as the whole price on a podklyuch
    // quote — the gap has to be a sentence.
    const t = prefillReplyText({ ...base, hasFreight: true, customsUsd: 248, freightUsd: null });
    expect(t).toContain('Yo‘lkira hali hisoblanmadi');
  });

  it('never invents a zero when nothing could be priced', () => {
    const t = prefillReplyText({ ...base });
    expect(t).not.toContain('$0');
    expect(t).toContain('hisoblab bo‘lmadi');
  });
});

describe('what is missing is said in WORDS', () => {
  it('names each blocker rather than counting them', () => {
    const t = prefillReplyText({
      ...base,
      customsUsd: 100,
      blockers: [
        { kind: 'customs', groupSeq: 1, groupLabel: 'Plitka', reason: 'baza_missing', itemLabel: 'Plitka keramik' },
        { kind: 'groups_unconfirmed', count: 2 },
      ],
    });
    expect(t).toContain('baza yo‘q');
    expect(t).toContain('Plitka keramik');
    expect(t).toContain('tasdiqlanmagan');
    // «3 ta muammo» is not something a seller can act on.
    expect(t).not.toMatch(/\d+ ta muammo/);
  });

  it('every blocker kind has words of its own', () => {
    const kinds: Parameters<typeof blockerText>[0][] = [
      { kind: 'section_missing' },
      { kind: 'no_groups' },
      { kind: 'ungrouped_items', count: 3 },
      { kind: 'groups_unconfirmed', count: 1 },
      { kind: 'customs', groupSeq: 1, groupLabel: 'G', reason: 'rates_missing' },
      { kind: 'freight', reason: 'freight_zone_required' },
      { kind: 'fee', reason: 'fee_fx_missing' },
      { kind: 'totals', reason: 'unpriced' },
      { kind: 'customs_on_yolkira' },
    ];
    for (const k of kinds) {
      const words = blockerText(k);
      expect(words, `${k.kind} has no words`).toBeTruthy();
      expect(words).not.toBe('noma’lum');
    }
  });

  it('an unknown reason prints the code rather than swallowing it', () => {
    // A refusal this map has not learned must still reach the person: a
    // silent blocker is worse than an untranslated one.
    expect(blockerText({ kind: 'customs', groupSeq: 1, groupLabel: 'G', reason: 'brand_new' })).toContain(
      'brand_new',
    );
  });

  it('a long list is cut with a mark, never silently', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: 'customs' as const,
      groupSeq: i,
      groupLabel: `G${i}`,
      reason: 'baza_missing',
    }));
    const t = prefillReplyText({ ...base, blockers: many });
    expect(t).toContain('…');
  });
});

describe('the honest degradations', () => {
  it('says the key is missing rather than half-answering', () => {
    const t = prefillReplyText({ ...base, aiConfigured: false });
    expect(t).toContain('sozlanmagan');
  });

  it('reports what the machine actually did, so the VED knows what to check', () => {
    const t = prefillReplyText({ ...base, customsUsd: 10, codesStamped: 4, ratesPulled: 3, importFilled: 2 });
    expect(t).toContain('4 ta kod');
    expect(t).toContain('3 ta stavka');
    expect(t).toContain('2 ta baza (import)');
  });

  it('stays quiet about work it did not do', () => {
    const t = prefillReplyText({ ...base, customsUsd: 10 });
    expect(t).not.toContain('AI qo‘ydi');
  });
});
