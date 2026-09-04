import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockerText, prefillReplyText } from '@/modules/wms/calc/prefill-reply';
import type { SealBlocker } from '@/modules/wms/calc/workspace';

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
  hasCustoms: true,
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

describe('the pass names what it did NOT do', () => {
  it('a capped or refused pick is said out loud, never only logged', () => {
    // Law 6 applied to the pass's own decisions. `MAX_PICK_ROWS` is 40, so a
    // 60-line invoice leaves twenty rows unanswered — and the first version
    // reported that to `logger.info` alone, which made the reply read like a
    // complete answer with twenty rows silently baza-less.
    const text = prefillReplyText({
      customsUsd: 248,
      freightUsd: null,
      hasFreight: false,
      hasCustoms: true,
      blockers: [],
      codesStamped: 0,
      ratesPulled: 0,
      importFilled: 40,
      link: null,
      aiConfigured: true,
      pickCapped: 20,
      pickRefused: 3,
    });
    expect(text).toContain('20 ta qator');
    expect(text).toContain('3 ta taklif');
    // …and stays quiet when there is nothing to confess.
    const clean = prefillReplyText({
      customsUsd: 248,
      freightUsd: null,
      hasFreight: false,
      hasCustoms: true,
      blockers: [],
      codesStamped: 0,
      ratesPulled: 0,
      importFilled: 2,
      link: null,
      aiConfigured: true,
    });
    expect(clean).not.toContain('Bazasi qo‘yilmadi');
  });
});

describe('every refusal the engine can make has a sentence', () => {
  /**
   * The first version of these maps was `Record<string, string>` full of
   * plausible invented keys — `freight_zone_required`, `weight_missing`,
   * `tariff_missing` — and NOT ONE was a real `FreightRefusal`. The unit
   * test asserted on the same fabricated strings the map invented, which is
   * a test restating the code (#166): it passed while every bot-landed
   * podklyuch quote told the seller «yo'lkira: zone_required».
   *
   * So the oracle is the ENGINE's own union, read out of `pricing.ts`, and
   * not a list retyped here. `Record<Union, string>` already makes the drift
   * a compile error; this proves the words exist and that none of them is
   * the code itself.
   */
  const unionsOf = (source: string, name: string): string[] => {
    const at = source.indexOf(`export type ${name} =`);
    expect(at, `${name} has been renamed — re-anchor this fence`).toBeGreaterThan(-1);
    const decl = source.slice(at, source.indexOf(';', at));
    return [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  };

  it('freight, fee, customs and totals refusals all reach the seller in words', () => {
    const pricing = readFileSync('src/modules/wms/calc/pricing.ts', 'utf8');
    const band = unionsOf(pricing, 'BandRefusal');
    const cases: [SealBlocker['kind'], string[]][] = [
      ['customs', unionsOf(pricing, 'CustomsRefusal')],
      ['freight', [...unionsOf(pricing, 'FreightRefusal'), ...band]],
      ['fee', unionsOf(pricing, 'FeeRefusal')],
      ['totals', unionsOf(pricing, 'TotalsRefusal')],
    ];
    for (const [kind, reasons] of cases) {
      expect(reasons.length, `${kind} union looks empty`).toBeGreaterThan(0);
      for (const reason of reasons) {
        const text = blockerText({
          kind,
          reason,
          groupSeq: 1,
          groupLabel: 'Guruh',
          itemLabel: null,
        } as unknown as SealBlocker);
        // The code itself must not survive into the sentence — that IS the
        // defect, and «zone_required» would pass a bare truthiness check.
        expect(text, `${kind}/${reason} reached the seller as a code`).not.toContain(reason);
        expect(text.length).toBeGreaterThan(kind.length);
      }
    }
  });
});

describe('a section with no customs half says nothing about customs', () => {
  it('a yolkira job never leads with «rastamojka ~$0.00»', () => {
    // `loadWorkspace` answers `customsUsd: 0` — NOT null — for a section with
    // no customs (`parts.customs ? assembled.customsUsd : 0`), so the reply
    // read that as «priced, at zero» and led with it. On the freight-only
    // section the bot offers FIRST, and with the freight still unpriced, the
    // whole message was a $0: law 6 broken by the round whose law it is.
    const priced = prefillReplyText({
      ...base,
      hasCustoms: false,
      hasFreight: true,
      customsUsd: 0,
      freightUsd: 4800,
    });
    expect(priced).not.toContain('rastamojka');
    expect(priced).not.toContain('$0.00');
    expect(priced).toContain('yo‘lkira ~$4800.00');

    // …and with nothing priced at all it must refuse in words, not print $0.
    const bare = prefillReplyText({
      ...base,
      hasCustoms: false,
      hasFreight: true,
      customsUsd: 0,
      freightUsd: null,
    });
    expect(bare).not.toContain('$0.00');
    expect(bare).toContain('Hozircha hisoblab bo‘lmadi');

    // A real customs job with a genuine zero is a FACT and still prints — the
    // question was never «is it zero», it was «does this job have a customs
    // side at all».
    const genuine = prefillReplyText({ ...base, hasCustoms: true, customsUsd: 0 });
    expect(genuine).toContain('rastamojka ~$0.00');
  });
});
