import { describe, expect, it } from 'vitest';
import {
  aiVedReplyText,
  MAX_REPLY_LINES,
  TELEGRAM_LIMIT,
  pickLeftOf,
  type AiVedEstimate,
  type AiVedFreight,
  type AiVedLine,
  type AiVedReplyInput,
} from '@/modules/wms/calc/ai-reply';
import { VED_ESTIMATE_MARK } from '@/modules/wms/calc/reply-heads';

/**
 * What the seller reads in Telegram — the whole of the round's promise, and
 * the one place its three laws are visible at once.
 *
 * The figures are the ENGINE's; this file is about the words that carry them,
 * so every assertion here is about a sentence the owner's own staff will read
 * to a customer.
 */
const line = (over: Partial<AiVedLine> = {}): AiVedLine => ({
  label: 'Monitor 24"',
  code: '8528520000',
  measureText: '100 dona × $20/dona',
  bazaSource: 'memory',
  dutyText: '10%',
  addDutyPct: 0,
  exciseText: null,
  vatPct: 12,
  customsUsd: 496.96,
  refusal: null,
  refusalTail: 'ved',
  estimated: null,
  weightFromTotal: null,
  staleBaza: false,
  ...over,
});

/** A priced road with round 2's labels all off. */
const road = (
  over: Pick<Extract<AiVedFreight, { ok: true }>, 'listUsd' | 'routeLabel' | 'bandText'> &
    Partial<Extract<AiVedFreight, { ok: true }>>,
): AiVedFreight => ({
  ok: true,
  zoneGuessed: false,
  zoneReadFrom: null,
  volumeFromLines: false,
  // The workspace's own road unless a case says otherwise (§0.1(4)).
  exact: true,
  small: false,
  ...over,
});

const base: AiVedReplyInput = {
  clientLabel: 'GS323',
  cardLabel: 'B-000067',
  lines: [line()],
  ungrouped: [],
  fee: { bhm: 5, usd: 164.8 },
  totalUsd: 661.76,
  feeRefusal: null,
  hasCertificate: true,
  freight: null,
  link: 'https://gsrwms.uz/bitimlar/x',
  aiConfigured: true,
  estimate: null,
  pickLeft: null,
  audience: 'chat',
};

/** An estimated group's line — 📊 beside a figure from the medians. */
const estimatedLine = (over: Partial<AiVedLine> = {}): AiVedLine =>
  line({
    label: 'Shim, Ko‘ylak',
    code: '6203420000',
    measureText: null,
    bazaSource: null,
    addDutyPct: 10,
    customsUsd: null,
    refusal: null,
    estimated: { priced: true, customsUsd: 142.3, measureText: '120 kg × $3.8/kg', declarations: [23], oldFileEnd: null },
    ...over,
  });

/** The workspace state of (a): 10 rows, 7 exact, the rest on medians. */
const twoTotals = (over: Partial<AiVedEstimate> = {}): AiVedEstimate => ({
  rows: 10,
  exactRows: 7,
  exactUsd: 1234,
  taxminiyUsd: 1980,
  taxminiyFee: { bhm: 1.5, usd: 50 },
  taxminiyBlock: null,
  ...over,
});

describe('the AI-VED reply', () => {
  it('prints the line, the law in words and the figure', () => {
    const text = aiVedReplyText(base);
    expect(text).toContain('1. Monitor 24" · 8528520000 · 100 dona × $20/dona 🧠');
    expect(text).toContain('boj 10% · QQS 12% → $496.96');
    expect(text).toContain('Deklaratsiya yig‘imi (VMQ-55): 5 BHM ≈ $164.80');
    // The complete-total line, UNCHANGED by round 2.
    expect(text).toContain('Rastamojka jami: ≈ $661.76');
    expect(text).not.toContain('Aniq');
  });

  it('carries the caveat on its own line, always', () => {
    // The seller repeats this to a customer, and a screenshot of the number
    // must not be able to lose the word.
    expect(aiVedReplyText(base)).toContain('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
  });

  // Decision 8 («no freight, ever») was OVERTURNED by the owner on
  // 2026-09-26 (item 13): a podklyuch job carries the road at the tariff's
  // list price, with the band beside it, and a JAMI of both halves.
  it('a podklyuch job prints rastamojka, yo‘lkira and jami — three lines', () => {
    const text = aiVedReplyText({
      ...base,
      freight: road({
        listUsd: 1920,
        routeLabel: 'Xitoy → O‘zbekiston',
        bandText: '180 kg/m³ · $160/m³ × 12 m³',
      }),
    });
    expect(text).toContain('taxminiy podklyuch (rastamojka + yo‘lkira)');
    expect(text).toContain('Rastamojka jami: ≈ $661.76');
    // Re-anchored (R2 late pass, review product-fit-13): the road one fact a
    // line — the yolkira reply's own shape — never nested in one bracket.
    expect(text).toContain('Xitoy → O‘zbekiston\n180 kg/m³ · $160/m³ × 12 m³\nYo‘lkira: ≈ $1920.00');
    expect(text).toContain('JAMI (rastamojka + yo‘lkira): ≈ $2581.76');
    // The caveat still closes the money, under the jami.
    expect(text.indexOf('JAMI')).toBeLessThan(text.indexOf('Rasmiy emas'));
  });

  it('a refused road is a sentence, and no JAMI is summed over half a price', () => {
    const text = aiVedReplyText({
      ...base,
      freight: { ok: false, refusal: 'bu zichlikka tarif yo‘q', tail: 'ved' },
    });
    expect(text).toContain('Yo‘lkira: ⚠️ bu zichlikka tarif yo‘q — VED xodimi hisoblaydi');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
    expect(text).not.toMatch(/JAMI \(rastamojka/);
    expect(text).not.toContain('$0.00');
  });

  it('a customs-only job never mentions the road at all', () => {
    const text = aiVedReplyText(base);
    expect(text).toContain('taxminiy rastamojka');
    expect(text).not.toContain('Yo‘lkira');
    expect(text).not.toContain('JAMI');
  });

  it('no customs figure at all with a priced road still refuses the JAMI', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      freight: road({ listUsd: 500, routeLabel: 'Qashg‘ar → O‘zbekiston', bandText: '90 kg/m³ · $70/m³ × 7 m³' }),
    });
    expect(text).toContain('Qashg‘ar → O‘zbekiston\n90 kg/m³ · $70/m³ × 7 m³\nYo‘lkira: ≈ $500.00');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
  });

  /*
   * Re-anchored twice. 2026-10-09 (judge MR-23): these pinned a PARTIAL
   * total under the job's name, which `requestCustomsFor` can no longer
   * produce. Round 2 (his 2.2 b): with some groups EXACT, the reply now
   * prints the two-figure block — a NAMED partial «Aniq» (its own row count,
   * no fee) and a «Taxminiy» that is whole or absent, here absent with the
   * reason in words. The input is what the WORKSPACE and the estimate hand
   * the reply in that state.
   */
  it('a blocked line prints WHY, and the totals say what each figure is', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      lines: [line(), line({ label: 'Sumka', code: null, customsUsd: null, refusal: 'baza yo‘q' })],
      estimate: twoTotals({
        rows: 2,
        exactRows: 1,
        exactUsd: 496.96,
        taxminiyUsd: null,
        taxminiyFee: null,
        taxminiyBlock: '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi',
      }),
    });
    expect(text).toContain('⚠️ baza yo‘q — VED xodimi qo‘yadi');
    expect(text).toContain(
      'Rastamojka jami:\n  Aniq: $496.96 (2 tadan 1 qator, yig‘imsiz)\n  Taxminiy: hisoblab bo‘lmadi — ⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi',
    );
    expect(text).not.toMatch(/ta qatordan/);
    // Law 6: a refusal is never spelled as money.
    expect(text).not.toContain('$0.00');
  });

  it('uncoded items are NAMED, and Taxminiy waits for their code', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      ungrouped: ['Sumka', 'Choynak'],
      estimate: twoTotals({
        rows: 3,
        exactRows: 1,
        exactUsd: 496.96,
        taxminiyUsd: null,
        taxminiyFee: null,
        taxminiyBlock: 'kodsiz qator bor (VED kod qo‘yadi)',
      }),
    });
    expect(text).toContain('⚠️ Kod topilmadi: Sumka, Choynak');
    expect(text).toContain('  Aniq: $496.96 (3 tadan 1 qator, yig‘imsiz)');
    expect(text).toContain('  Taxminiy: hisoblab bo‘lmadi — kodsiz qator bor (VED kod qo‘yadi)');
  });

  it('a partial figure handed in anyway is never printed as the total — the belt (MR-23)', () => {
    // A caller that summed the priced lines itself: the reply refuses to
    // carry it, on a podklyuch job too (no JAMI over half a declaration).
    const text = aiVedReplyText({
      ...base,
      ungrouped: ['Sumka'],
      freight: road({ listUsd: 500, routeLabel: 'Xitoy → O‘zbekiston', bandText: '90 kg/m³' }),
      estimate: twoTotals({
        rows: 2,
        exactRows: 1,
        exactUsd: 496.96,
        taxminiyUsd: null,
        taxminiyFee: null,
        taxminiyBlock: 'kodsiz qator bor (VED kod qo‘yadi)',
      }),
    });
    expect(text).not.toContain('$661.76');
    expect(text).not.toContain('Rastamojka jami: ≈');
    expect(text).toContain('  Aniq: $496.96 (2 tadan 1 qator, yig‘imsiz)');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
  });

  it('when ONLY the fee refuses, its reason is the line that says why (P2.9)', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      fee: null,
      feeRefusal: 'so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi',
    });
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).toContain('⚠️ Bojxona yig‘imi: so‘m kursi yo‘q');
    // A blocked LINE is the reason when there is one — the fee line is not.
    const both = aiVedReplyText({
      ...base,
      totalUsd: null,
      feeRefusal: 'so‘m kursi yo‘q',
      lines: [line({ customsUsd: null, refusal: 'baza yo‘q' })],
    });
    expect(both).not.toContain('Bojxona yig‘imi:');
  });

  it('an excise prints in its own words — a percentage or per unit (0131)', () => {
    expect(aiVedReplyText({ ...base, lines: [line({ exciseText: 'aksiz $0.5/litr' })] })).toContain(
      'boj 10% · aksiz $0.5/litr · QQS 12% → $496.96',
    );
  });

  it('no total at all is a sentence, never a zero', () => {
    const text = aiVedReplyText({ ...base, totalUsd: null, fee: null });
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).not.toContain('$0');
  });

  it('the additional duty is printed with its reason, and only when it bites', () => {
    expect(aiVedReplyText({ ...base, hasCertificate: false, lines: [line({ addDutyPct: 15 })] }))
      .toContain('qo‘shimcha boj 15% (sertifikat yo‘q)');
    expect(aiVedReplyText(base)).not.toContain('qo‘shimcha boj');
  });

  it('the certificate assumption is stated either way', () => {
    expect(aiVedReplyText(base)).toContain('📄 Sertifikat: bor (deb hisoblandi)');
    expect(aiVedReplyText({ ...base, hasCertificate: false })).toContain(
      '📄 Sertifikat: yo‘q (deb hisoblandi)',
    );
  });

  it('the legend names only the sources actually used', () => {
    expect(aiVedReplyText(base)).toContain('🧠 avvalgi muhrdan');
    expect(aiVedReplyText(base)).not.toContain('📥 bojxona faylidan');
    const both = aiVedReplyText({ ...base, lines: [line(), line({ bazaSource: 'import' })] });
    // Re-anchored (review product-fit-9): the screen calls a 📥 baza «importdan
    // (taxmin)» — the legend says what that is while it stands under «Aniq».
    expect(both).toContain('🧠 avvalgi muhrdan · 📥 bojxona faylidan tanlangan (VED tasdiqlaguncha taxmin)');
    // A price the VED typed wears no mark and needs no legend line.
    expect(aiVedReplyText({ ...base, lines: [line({ bazaSource: 'typed' })] })).not.toContain(
      'avvalgi muhrdan',
    );
    expect(aiVedReplyText(base)).not.toContain('📊');
  });

  it('a long list collapses with a count, never in silence', () => {
    const many = Array.from({ length: MAX_REPLY_LINES + 7 }, (_, i) =>
      line({ label: `Tovar ${i + 1}` }),
    );
    const text = aiVedReplyText({ ...base, lines: many });
    expect(text).toContain('… va yana 7 ta qator');
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });

  it('a long invoice description is collapsed to one readable line', () => {
    // MEASURED on the round's own fixture: a real customs description is 300
    // characters and carries its OWN newlines, so the numbering came apart —
    // «1. Нетканый материал…\n…2516 кг» and then a «2.» that looked like part
    // of it. The list stopped being a list.
    const text = aiVedReplyText({
      ...base,
      lines: [line({ label: 'Нетканый материал\nиз химических нитей '.repeat(12) })],
    });
    const numbered = text.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(numbered).toHaveLength(1);
    expect(numbered[0]!.length).toBeLessThan(120);
    expect(numbered[0]).toContain('…');
  });

  it('never exceeds what Telegram will accept', () => {
    const huge = Array.from({ length: 20 }, (_, i) =>
      line({ label: 'X'.repeat(300), code: `${i}`.padStart(10, '8') }),
    );
    expect(aiVedReplyText({ ...base, lines: huge }).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });

  it('says so plainly when there is no key on the server', () => {
    expect(aiVedReplyText({ ...base, aiConfigured: false })).toContain('AI sozlanmagan');
  });
});

describe('two customs totals (his 2.2 b, docs/SAKKIZ-R2.md §2.2)', () => {
  const estimated = { ...base, totalUsd: null, fee: null, lines: [line(), estimatedLine()] };

  it('the three-line block: Aniq without the fee, Taxminiy with it', () => {
    const text = aiVedReplyText({ ...estimated, estimate: twoTotals() });
    expect(text).toContain(
      'Rastamojka jami:\n  Aniq: $1234.00 (10 tadan 7 qator, yig‘imsiz)\n  Taxminiy ≈ $1980.00 (yig‘im 1.5 BHM ≈ $50.00 bilan)',
    );
    // No literal «JAMI» on a customs-only reply (`Rastamojka jami` is lower case).
    expect(text).not.toContain('JAMI');
  });

  it('a typed fee override is said as a figure, with no BHM', () => {
    expect(aiVedReplyText({ ...estimated, estimate: twoTotals({ taxminiyFee: { bhm: null, usd: 40 } }) })).toContain(
      '  Taxminiy ≈ $1980.00 (yig‘im ≈ $40.00 bilan)',
    );
  });

  it('no row exact, a Taxminiy standing: «Aniq: hali yo‘q»', () => {
    const text = aiVedReplyText({
      ...estimated,
      lines: [estimatedLine()],
      estimate: twoTotals({ rows: 3, exactRows: 0, exactUsd: null, taxminiyUsd: 175.26 }),
    });
    expect(text).toContain('  Aniq: hali yo‘q (3 tadan 0 qator)');
    expect(text).toContain('  Taxminiy ≈ $175.26');
  });

  it('no row exact and no Taxminiy: the unchanged «hozircha» line', () => {
    const text = aiVedReplyText({
      ...estimated,
      lines: [line({ customsUsd: null, refusal: 'baza yo‘q' })],
      estimate: twoTotals({ rows: 1, exactRows: 0, exactUsd: null, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi' }),
    });
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).not.toContain('Aniq');
  });

  it('every reason Taxminiy is absent reaches the seller in words, each naming whose job it is', () => {
    const reasons = [
      'kodsiz qator bor (VED kod qo‘yadi)',
      '⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, kartadagi lentaga yozing',
      'vaqt yetmadi, statistika o‘qilmadi',
      '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi',
      'bojxona yig‘imi: so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi',
    ];
    for (const why of reasons) {
      const text = aiVedReplyText({
        ...estimated,
        estimate: twoTotals({ taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: why }),
      });
      expect(text).toContain(`  Taxminiy: hisoblab bo‘lmadi — ${why}`);
    }
  });

  it('an estimated group: 📊 beside the measure, «≈» and the declarations on the figure', () => {
    const text = aiVedReplyText({ ...estimated, estimate: twoTotals() });
    expect(text).toContain('2. Shim, Ko‘ylak · 6203420000 · 120 kg × $3.8/kg 📊');
    expect(text).toContain(
      '   boj 10% · qo‘shimcha boj 10% (sertifikat yo‘q) · QQS 12% → ≈ $142.30 (taxminiy, 23 ta deklaratsiyadan)',
    );
    expect(text).toContain('📊 deklaratsiyalar medianasi (taxminiy)');
  });

  it('several medians, an old file, and a group mixing 🧠 with 📊', () => {
    const text = aiVedReplyText({
      ...estimated,
      lines: [
        estimatedLine({
          bazaSource: 'memory',
          estimated: { priced: true, customsUsd: 142.3, measureText: null, declarations: [23, 8], oldFileEnd: '2025-12-31' },
        }),
      ],
      estimate: twoTotals(),
    });
    expect(text).toContain('1. Shim, Ko‘ylak · 6203420000 🧠 📊');
    expect(text).toContain('(taxminiy: 23 va 8 ta deklaratsiyadan · eski fayl, 2025-12-31 gacha)');
    expect(text).toContain('🧠 avvalgi muhrdan · 📊 deklaratsiyalar medianasi (taxminiy)');
    const four = aiVedReplyText({
      ...estimated,
      lines: [
        estimatedLine({
          estimated: { priced: true, customsUsd: 142.3, measureText: null, declarations: [23, 8, 6, 5], oldFileEnd: null },
        }),
      ],
      estimate: twoTotals(),
    });
    expect(four).toContain('(taxminiy: 23, 8, 6 … ta deklaratsiyadan)');
  });

  it('a refused group names the rows the medians could not answer — three, then «…»', () => {
    const text = aiVedReplyText({
      ...estimated,
      lines: [
        line({
          label: 'Kurtka',
          customsUsd: null,
          refusal: 'Kurtka: baza yo‘q — Kurtka qishki',
          estimated: {
            priced: false,
            misses: [
              '2-qator — faqat 3 ta deklaratsiya (kamida 5 kerak)',
              '3-qator — bu kodda Xitoy deklaratsiyasi yo‘q',
              '4-qator — kod to‘liq emas (10 xonali kod kerak)',
              '5-qator — vaqt yetmadi — statistika o‘qilmadi',
            ],
          },
        }),
      ],
      estimate: twoTotals({ exactRows: 0, exactUsd: null, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: 'x' }),
    });
    expect(text).toContain('   ⚠️ Kurtka: baza yo‘q — Kurtka qishki — VED xodimi qo‘yadi');
    expect(text).toContain(
      '   📊 taxmin yo‘q: 2-qator — faqat 3 ta deklaratsiya (kamida 5 kerak); 3-qator — bu kodda Xitoy deklaratsiyasi yo‘q; 4-qator — kod to‘liq emas (10 xonali kod kerak) …',
    );
  });

  it('a refusal names WHO fixes it — the customer’s missing count goes to the seller, a baza to the VED', () => {
    // §0.1(7), and the Taxminiy block's own split: one reply must not send
    // the same missing count to the VED on the line and to the seller below.
    const text = aiVedReplyText({
      ...estimated,
      lines: [
        line({
          label: 'Kurtka',
          customsUsd: null,
          refusal: 'Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona',
          refusalTail: 'seller',
        }),
        line({ label: 'Sumka', customsUsd: null, refusal: 'Sumka: baza yo‘q — Sumka', refusalTail: 'ved' }),
      ],
      estimate: twoTotals({ exactRows: 0, exactUsd: null, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: 'x' }),
    });
    expect(text).toContain(
      '   ⚠️ Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona — mijozdan so‘rab, kartadagi lentaga yozing',
    );
    expect(text).toContain('   ⚠️ Sumka: baza yo‘q — Sumka — VED xodimi qo‘yadi');
  });

  it('a row priced on an OLD baza says so in the line’s head — exact, refused alike (review law-money-R2-2)', () => {
    // The figure is the screen's own and stays; the age is what the screen's
    // ⚠ chip says beside it, and the seller repeats the figure.
    const exact = aiVedReplyText({ ...base, lines: [line({ bazaSource: 'import', staleBaza: true })] });
    expect(exact).toContain('1. Monitor 24" · 8528520000 · 100 dona × $20/dona 📥 · ⚠ eski baza\n');
    expect(exact).toContain('boj 10% · QQS 12% → $496.96');
    const refused = aiVedReplyText({
      ...base,
      totalUsd: null,
      lines: [line({ staleBaza: true, customsUsd: null, refusal: 'boj kamida $3/dona', refusalTail: 'seller' })],
    });
    expect(refused).toContain('🧠 · ⚠ eski baza\n   ⚠️ boj kamida $3/dona');
    // A fresh baza wears nothing.
    expect(aiVedReplyText(base)).not.toContain('eski baza');
  });

  it('a weight copied from the shipment’s brutto total is said beside the measure (⭐ of his Question 4)', () => {
    const text = aiVedReplyText({
      ...base,
      lines: [line({ label: 'Kurtka', code: '6201400000', measureText: '300 kg × $4.1/kg', weightFromTotal: 'brutto' })],
    });
    expect(text).toContain('1. Kurtka · 6201400000 · 300 kg (og‘irlik bruttodan) × $4.1/kg 🧠');
  });

  it('…and «og‘irlik nettodan» where that total was itself netto (review PF-3)', () => {
    const text = aiVedReplyText({
      ...base,
      lines: [line({ label: 'Kurtka', code: '6201400000', measureText: '300 kg × $4.1/kg', weightFromTotal: 'netto' })],
    });
    expect(text).toContain('1. Kurtka · 6201400000 · 300 kg (og‘irlik nettodan) × $4.1/kg 🧠');
    expect(text).not.toContain('bruttodan');
  });
});

describe('the road: the guess said, who fixes a refusal, and the JAMI that knows (§2.3)', () => {
  const guessed = road({
    listUsd: 1920,
    routeLabel: 'Qashg‘ar → O‘zbekiston',
    bandText: '180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)',
    zoneGuessed: true,
    zoneReadFrom: 'Китай, Кашгар',
    volumeFromLines: true,
  });

  it('a guessed route prints what was READ — and the JAMI says «taxminiy»', () => {
    const text = aiVedReplyText({ ...base, freight: guessed });
    expect(text).toContain(
      'Qashg‘ar → O‘zbekiston — zona «Китай, Кашгар»dan taxmin\n180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)\nYo‘lkira: ≈ $1920.00',
    );
    // An exact customs total and a guessed zone: the sum is still an estimate.
    expect(text).toContain('JAMI taxminiy (rastamojka + yo‘lkira): ≈ $2581.76');
    expect(text).not.toContain('JAMI (');
  });

  it('a road on the lines’ Σ for a cube the request lacks → never the plain «JAMI» (review law-money-R2-1)', () => {
    // An exact customs total, a STORED zone, and a cube the request does not
    // hold: the VED's own freight refuses it, so «JAMI (…)» would print a sum
    // that is on no screen. The estimate says so, and the lenta tells the VED.
    const fromLines = road({
      listUsd: 448,
      routeLabel: 'Xitoy → O‘zbekiston',
      bandText: '180 kg/m³ · $160/m³ × 2.8 m³ (qatorlardan)',
      volumeFromLines: true,
      exact: false,
    });
    const chat = aiVedReplyText({ ...base, freight: fromLines });
    expect(chat).toContain('JAMI taxminiy (rastamojka + yo‘lkira): ≈ $1109.76');
    expect(chat).not.toContain('JAMI (');
    const lenta = aiVedReplyText({ ...base, link: null, audience: 'lenta', freight: fromLines }).split('\n');
    expect(lenta[1]).toBe(
      `${VED_ESTIMATE_MARK} bu taxminiy javob, rasmiy emas — yo‘lkira hajmi qatorlardan — so‘rovda umumiy hajm yo‘q. Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin o‘zingiz tekshiring.`,
    );
  });

  it('Taxminiy plus a stored-zone road → JAMI taxminiy on the estimate', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      fee: null,
      lines: [line(), estimatedLine()],
      estimate: twoTotals(),
      freight: road({ listUsd: 1920, routeLabel: 'Xitoy → O‘zbekiston', bandText: '180 kg/m³ · $160/m³ × 12 m³' }),
    });
    // 1980 + 1920
    expect(text).toContain('JAMI taxminiy (rastamojka + yo‘lkira): ≈ $3900.00');
  });

  it('a refusal only the seller can fix sends him to the customer; a tariff hole stays the VED’s', () => {
    const seller = aiVedReplyText({
      ...base,
      freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
    });
    expect(seller).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, kartadagi lentaga yozing');
    const ved = aiVedReplyText({ ...base, freight: { ok: false, refusal: 'bu zichlikka tarif yo‘q', tail: 'ved' } });
    expect(ved).toContain('Yo‘lkira: ⚠️ bu zichlikka tarif yo‘q — VED xodimi hisoblaydi');
  });

  it('a very small load is priced and flagged', () => {
    const text = aiVedReplyText({
      ...base,
      freight: road({ listUsd: 32, routeLabel: 'Xitoy → O‘zbekiston', bandText: '180 kg/m³ · $160/m³ × 0.2 m³', small: true }),
    });
    expect(text).toContain('⚠️ Juda kichik yuk (yo‘lkira $50 dan kam) — VED ko‘rib chiqadi.');
  });
});

describe('the card’s copy: the VED’s line under its heading (his 2.4 c, §2.6)', () => {
  const withEstimate: AiVedReplyInput = {
    ...base,
    totalUsd: null,
    fee: null,
    lines: [line(), estimatedLine()],
    estimate: twoTotals(),
    link: null,
  };

  it('is LINE 2, directly under the heading — only on the lenta, only with an estimate', () => {
    const lenta = aiVedReplyText({ ...withEstimate, audience: 'lenta' }).split('\n');
    expect(lenta[1]).toBe(
      `${VED_ESTIMATE_MARK} bu taxminiy javob, rasmiy emas — 📊 baza deklaratsiyalar medianasidan (AI emas). Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin o‘zingiz tekshiring.`,
    );
    expect(lenta.filter((l) => l.startsWith(VED_ESTIMATE_MARK))).toHaveLength(1);
    // The chat never carries it…
    expect(aiVedReplyText({ ...withEstimate, audience: 'chat' })).not.toContain(VED_ESTIMATE_MARK);
    // …and a fully exact reply on the lenta carries none either.
    expect(aiVedReplyText({ ...base, link: null, audience: 'lenta' })).not.toContain(VED_ESTIMATE_MARK);
  });

  it('a guessed zone is named too, joined to the median part', () => {
    const lenta = aiVedReplyText({
      ...withEstimate,
      audience: 'lenta',
      freight: road({
        listUsd: 1920,
        routeLabel: 'Xitoy → O‘zbekiston',
        bandText: '180 kg/m³',
        zoneGuessed: true,
        zoneReadFrom: 'Yiwu',
      }),
    }).split('\n');
    expect(lenta[1]).toBe(
      `${VED_ESTIMATE_MARK} bu taxminiy javob, rasmiy emas — 📊 baza deklaratsiyalar medianasidan (AI emas) · zona «Yiwu»dan taxmin. Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin o‘zingiz tekshiring.`,
    );
  });

  it('the lenta copy is the chat text without its «Karta:» line, plus that one line', () => {
    const chat = aiVedReplyText({ ...withEstimate, link: 'https://gsrwms.uz/hisoblash/x' }).split('\n');
    const lenta = aiVedReplyText({ ...withEstimate, audience: 'lenta' }).split('\n');
    expect(chat.at(-1)).toBe('Karta: https://gsrwms.uz/hisoblash/x');
    expect([lenta[0], ...lenta.slice(2)]).toEqual(chat.slice(0, -1));
  });
});

describe('Telegram’s 4096 characters never cost the end of the message (§2.9)', () => {
  it('60 long lines and two totals: the LIST shrinks, the totals and the caveat stay', () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      line({
        label: `Tovar ${i + 1}`,
        customsUsd: null,
        refusal: `Guruh ${i + 1}: ${'juda uzun sabab, '.repeat(18)}`,
      }),
    );
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      fee: null,
      lines,
      estimate: twoTotals({ rows: 70, exactRows: 0, exactUsd: null, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi' }),
    });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(text).toMatch(/… va yana \d+ ta qator/);
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).toContain('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
    expect(text).toContain('Karta: https://gsrwms.uz/bitimlar/x');

    const withTotals = aiVedReplyText({
      ...base,
      totalUsd: null,
      fee: null,
      lines: [line(), ...lines],
      estimate: twoTotals({ rows: 61, exactRows: 1, exactUsd: 496.96, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: '⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi' }),
    });
    expect(withTotals.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(withTotals).toContain('Taxminiy');
    expect(withTotals).toContain('Rasmiy emas');
  });
});

describe('R2 late pass — the reply says what it is', () => {
  it('every row exact and only the FEE refusing: the old two lines, never «Taxminiy: hisoblab bo‘lmadi» (review law-money-8)', () => {
    // The estimate shape `estimateCustoms` really hands in for this state —
    // every row exact, nothing estimated, the block the fee's reason — not
    // the `estimate: null` the earlier fee-only case was built on.
    const feeWords = 'bojxona yig‘imi: so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi';
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      fee: null,
      feeRefusal: 'so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi',
      lines: [line(), line({ label: 'Sumka' })],
      estimate: twoTotals({ rows: 2, exactRows: 2, exactUsd: 993.92, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: feeWords }),
    });
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.\n⚠️ Bojxona yig‘imi: so‘m kursi yo‘q');
    expect(text).not.toContain('Aniq:');
    expect(text).not.toContain('Taxminiy');
  });

  it('the pick’s confessions are said under the totals, in one line (review regression-10)', () => {
    const left = { capped: 12, refused: 2, overtaken: 0, timedOut: 1, skipped: false };
    const text = aiVedReplyText({ ...base, pickLeft: left });
    expect(text).toContain(
      '⚠️ AI bazasini qo‘ymadi: 12 ta qator ko‘rilmadi (juda ko‘p), 2 tasida tanlangan deklaratsiya o‘lchovi mos kelmadi, 1 tasini bojxona faylidan o‘qib ulgurilmadi — VED to‘ldiradi',
    );
    expect(aiVedReplyText({ ...base, pickLeft: { ...left, capped: 0, refused: 0, timedOut: 0, skipped: true } })).toContain(
      '⚠️ AI bazasini qo‘ymadi: vaqt yetmadi — AI deklaratsiya tanlamadi — VED to‘ldiradi',
    );
    // Nothing left unsaid, or no pick at all: no line.
    expect(aiVedReplyText({ ...base, pickLeft: { ...left, capped: 0, refused: 0, timedOut: 0 } })).not.toContain('AI bazasini');
    expect(aiVedReplyText(base)).not.toContain('AI bazasini');
  });

  it('a row the deadline left unread mid-pick is said with the reads that ran out of time (the merge’s seam)', () => {
    const left = pickLeftOf({ capped: 0, refused: 0, overtaken: 0, timedOut: 1, pastDeadline: 2 });
    expect(aiVedReplyText({ ...base, pickLeft: left })).toContain(
      '⚠️ AI bazasini qo‘ymadi: 3 tasini bojxona faylidan o‘qib ulgurilmadi — VED to‘ldiradi',
    );
    // The pick DID run: the «vaqt yetmadi — tanlamadi» words are the
    // skipped pick's alone.
    expect(left.skipped).toBe(false);
  });

  it('a VED zone refusal still names the seller’s own missing kilos, on its own line (review PF-5)', () => {
    const text = aiVedReplyText({
      ...base,
      freight: {
        ok: false,
        refusal: 'yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi',
        tail: 'ved',
        also: { refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
      },
    });
    expect(text).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi — VED xodimi hisoblaydi\n' +
        '⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, kartadagi lentaga yozing',
    );
  });

  it('the brutto mark never sits between a COUNT and its price (review REG-4)', () => {
    const text = aiVedReplyText({
      ...base,
      lines: [line({ measureText: '300 dona × $2/dona', weightFromTotal: 'brutto' })],
    });
    expect(text).not.toContain('300 dona (og‘irlik');
    expect(text).toContain('300 dona × $2/dona · og‘irlik bruttodan');
  });
});
