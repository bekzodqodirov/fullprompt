import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockerText, tariffReplyText } from '@/modules/wms/calc/prefill-reply';
import type { SealBlocker } from '@/modules/wms/calc/workspace';
import type { AiVedFreight } from '@/modules/wms/calc/ai-reply';
import { TARIFF_REPLY_HEAD, VED_ESTIMATE_MARK } from '@/modules/wms/calc/reply-heads';

/**
 * What the AI VED hodimi says back into the staff chat.
 *
 * Pure on purpose: the numbers come from the engine and the words come from
 * here, so a wording change can never move a figure. What these assertions
 * protect is law 6 (never a $0, never a silence) and the owner's own answer
 * 6 — the figure is TAHMINIY and the official price is the seal.
 */

/*
 * Re-anchored for round 2 (docs/SAKKIZ-R2.md §6.7): `prefillReplyText` — the
 * summary a freight-only job used to get — is DELETED with its only caller;
 * a yolkira job is now answered by `tariffReplyText` from the tariff table
 * (his 2.5 b). The figure-and-caveat and the no-$0 cases follow it there.
 * The cases about the summary's customs figure, its blocker list, its «AI
 * qo‘ydi» counts and its pick confessions die with their subject: a
 * customs job has used the AI-VED's per-line reply since sub-round C, which
 * carries all of that in its own words (ai-reply.test.ts), and the per-
 * blocker words below stay on `blockerText`.
 */
const priced = (over: Partial<Extract<AiVedFreight, { ok: true }>> = {}): AiVedFreight => ({
  ok: true,
  listUsd: 1920,
  routeLabel: 'Xitoy → O‘zbekiston',
  bandText: '180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)',
  zoneGuessed: true,
  zoneReadFrom: 'Yiwu',
  volumeFromLines: true,
  exact: false,
  small: false,
  ...over,
});
const tariff = { clientLabel: 'GS777', cardLabel: 'B-000067', link: 'https://gsrwms.uz/bitimlar/x', audience: 'chat' as const };

describe('a yolkira job answered from the tariff table (his 2.5 b, §2.4)', () => {
  it('the figure, the route as read, the band — and the caveat right under the figure', () => {
    const t = tariffReplyText({ ...tariff, freight: priced() });
    expect(t).toBe(
      [
        `${TARIFF_REPLY_HEAD} (tarif bo‘yicha) · taxminiy · GS777 · B-000067`,
        'Xitoy → O‘zbekiston — zona «Yiwu»dan taxmin',
        '180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)',
        'Yo‘lkira: ≈ $1920.00',
        '⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.',
        'Karta: https://gsrwms.uz/bitimlar/x',
      ].join('\n'),
    );
  });

  it('a stored zone is printed bare; a tiny load is flagged', () => {
    const t = tariffReplyText({ ...tariff, freight: priced({ zoneGuessed: false, zoneReadFrom: null, listUsd: 32, small: true }) });
    expect(t.split('\n')[1]).toBe('Xitoy → O‘zbekiston');
    expect(t).toContain('⚠️ Juda kichik yuk (yo‘lkira $50 dan kam) — VED ko‘rib chiqadi.');
  });

  it('a refusal is a sentence naming who fixes it — never a $0, never «taxminiy» over nothing', () => {
    const t = tariffReplyText({
      ...tariff,
      freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
    });
    expect(t).toBe(
      [
        `${TARIFF_REPLY_HEAD} (tarif bo‘yicha) · GS777 · B-000067`,
        'Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, kartadagi lentaga yozing',
        'Karta: https://gsrwms.uz/bitimlar/x',
      ].join('\n'),
    );
    expect(t).not.toContain('$0');
  });

  it('it never speaks of customs, the AI or a budget — this pass asked no model', () => {
    for (const freight of [priced(), { ok: false as const, refusal: 'bu zichlikka tarif yo‘q', tail: 'ved' as const }]) {
      const t = tariffReplyText({ ...tariff, freight });
      expect(t).not.toContain('rastamojka');
      expect(t).not.toContain('AI');
      expect(t).not.toContain('limit');
    }
  });

  it('the card’s copy: no link, and the VED’s own line under the heading when the zone was guessed', () => {
    const lenta = tariffReplyText({ ...tariff, link: null, audience: 'lenta', freight: priced() }).split('\n');
    expect(lenta[1]).toBe(`${VED_ESTIMATE_MARK} zona «Yiwu»dan taxmin, rasmiy emas — zonani o‘zingiz tanlang.`);
    expect(lenta.join('\n')).not.toContain('Karta:');
    const stored = tariffReplyText({ ...tariff, link: null, audience: 'lenta', freight: priced({ zoneGuessed: false, zoneReadFrom: null }) });
    expect(stored).not.toContain(VED_ESTIMATE_MARK);
  });
});

describe('what is missing is said in WORDS', () => {
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

  it('a missing figure names the row, the figure and why — the kg-and-dona row (2026-10-09)', () => {
    // «o‘lchov yo‘q» alone left the seller guessing whether the count or the
    // weight was wanted on exactly the rows the owner asked about.
    expect(
      blockerText({
        kind: 'customs',
        groupSeq: 1,
        groupLabel: '6201',
        reason: 'measure_missing',
        itemLabel: 'Kurtka',
        itemSeq: 3,
        unit: 'dona',
        half: 'duty',
        rate: 3,
      }),
    ).toBe('6201: 3-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona');
    // The baza's own unit, spelled as stored ('unit'), reads as a count.
    expect(
      blockerText({
        kind: 'customs',
        groupSeq: 1,
        groupLabel: '9403',
        reason: 'measure_missing',
        itemLabel: 'Stol',
        itemSeq: 1,
        unit: 'unit',
        half: 'baza',
        rate: null,
      }),
    ).toBe('9403: 1-qator «Stol»: soni (dona) kiritilmagan — baza dona bo‘yicha');
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

describe('the fee’s blocker names whose job it is', () => {
  it('a fee blocked by the BHM setting names the admin’s job, not a typo', () => {
    expect(blockerText({ kind: 'fee', reason: 'fee_bhm_bad' })).toBe(
      'bojxona yig‘imi: BHM sozlamasi noto‘g‘ri — admin tuzatadi',
    );
  });
});
