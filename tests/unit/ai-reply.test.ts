import { describe, expect, it } from 'vitest';
import {
  aiVedReplyText,
  MAX_REPLY_LINES,
  TELEGRAM_LIMIT,
  pickLeftOf,
  LAW_ASKS_NAMED,
  ROAD_STALE_LINE,
  SELLER_ASKS_HEAD,
  SELLER_WORDS_HEAD,
  WHAT_ANSWER_LINE,
  AI_QUESTION_ANSWER_LINE,
  sellerAsksBlock,
  sellerAsksLentaLine,
  lineNumber,
  CODING_FAILED_LINE,
  type AiVedEstimate,
  type AiVedFreight,
  type AiVedLine,
  type AiVedReplyInput,
} from '@/modules/wms/calc/ai-reply';
import { AI_REPLY_HEAD, MACHINE_REPLY_HEADS, RERUN_WORD, VED_ESTIMATE_MARK } from '@/modules/wms/calc/reply-heads';
import type { LawAsk, SellerAsk } from '@/modules/wms/calc/law-asks';
import { parseTableAnswer, type TableRef } from '@/modules/wms/calc/line-address';

/**
 * What the seller reads in Telegram — the whole of the round's promise, and
 * the one place its three laws are visible at once.
 *
 * The figures are the ENGINE's; this file is about the words that carry them,
 * so every assertion here is about a sentence the owner's own staff will read
 * to a customer.
 */
const line = (over: Partial<AiVedLine> = {}): AiVedLine => ({
  // Row 1 of the request unless a case numbers it (docs/AI-SORAYDI.md §3.4 A3).
  seqs: [1],
  label: 'Monitor 24"',
  code: '8528520000',
  aiCode: false,
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
  // The coding call answered (A6's failure has its own cases below).
  proposeFailed: false,
  fee: { bhm: 5, usd: 164.8 },
  totalUsd: 661.76,
  feeRefusal: null,
  hasCertificate: true,
  freight: null,
  link: 'https://gsrwms.uz/bitimlar/x',
  aiConfigured: true,
  estimate: null,
  pickLeft: null,
  // REQUIRED since round 3 (docs/SAKKIZ-R3.md §10.2.6): the landing's pass,
  // nothing asked — the 2.8 b block and the re-run heading have their own
  // cases at the end of this file.
  asks: null,
  // The AI door's own list (docs/AI-SORAYDI.md §3.4 A2) — its cases are at
  // the end of this file.
  sellerAsks: null,
  pass: 'landing',
  audience: 'chat',
  // A request from before the doors (docs/IKKI-ESHIK.md §0.2): today's words.
  // The two doors' own words have their cases at the end of this file.
  noAsk: false,
};

/** An estimated group's line — 📊 beside a figure from the medians. */
const estimatedLine = (over: Partial<AiVedLine> = {}): AiVedLine =>
  line({
    // Rows 2 and 3 of the request, one code — the line opens «2-3.» (A3).
    seqs: [2, 3],
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

  it('uncoded items are NAMED in their place by their own number, and Taxminiy waits for their code', () => {
    // Re-anchored for docs/AI-SORAYDI.md §3.4 A3 (PA-3): the old pin read
    // «⚠️ Kod topilmadi: Sumka, Choynak» UNDER the list — a list of names no
    // «2: …» could reach. Each uncoded row now stands on its own line by its
    // seq, in row order among the priced lines, and says who codes it.
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      ungrouped: [
        { seq: 3, name: 'Choynak' },
        { seq: 2, name: 'Sumka' },
      ],
      estimate: twoTotals({
        rows: 3,
        exactRows: 1,
        exactUsd: 496.96,
        taxminiyUsd: null,
        taxminiyFee: null,
        taxminiyBlock: 'kodsiz qator bor (VED kod qo‘yadi)',
      }),
    });
    // Row 1 is the priced Monitor (`line()`), then rows 2 and 3 in order —
    // whatever order they were handed in.
    expect(text).toContain(
      [
        '1. Monitor 24" · 8528520000 · 100 dona × $20/dona 🧠',
        '   boj 10% · QQS 12% → $496.96',
        '2. Sumka — kod yo‘q — VED xodimi qo‘yadi',
        '3. Choynak — kod yo‘q — VED xodimi qo‘yadi',
      ].join('\n'),
    );
    expect(text).not.toContain('Kod topilmadi');
    expect(text).toContain('  Aniq: $496.96 (3 tadan 1 qator, yig‘imsiz)');
    expect(text).toContain('  Taxminiy: hisoblab bo‘lmadi — kodsiz qator bor (VED kod qo‘yadi)');
  });

  it('a partial figure handed in anyway is never printed as the total — the belt (MR-23)', () => {
    // A caller that summed the priced lines itself: the reply refuses to
    // carry it, on a podklyuch job too (no JAMI over half a declaration).
    const text = aiVedReplyText({
      ...base,
      ungrouped: [{ seq: 2, name: 'Sumka' }],
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
      line({ seqs: [i + 1], label: `Tovar ${i + 1}` }),
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
      // The CHAT's words since round 3 (estimate.ts's `refused_measure.chat`).
      '⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
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
    expect(text).toContain('2-3. Shim, Ko‘ylak · 6203420000 · 120 kg × $3.8/kg 📊');
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
    expect(text).toContain('2-3. Shim, Ko‘ylak · 6203420000 🧠 📊');
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
    // Re-anchored for round 3 (docs/SAKKIZ-R3.md §2.5): in the CHAT the
    // seller is pointed at «➕» under the message; the lenta keeps R2's words.
    expect(text).toContain(
      '   ⚠️ Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    );
    expect(text).toContain('   ⚠️ Sumka: baza yo‘q — Sumka — VED xodimi qo‘yadi');
    const lenta = aiVedReplyText({
      ...estimated,
      link: null,
      audience: 'lenta',
      lines: [
        line({
          label: 'Kurtka',
          customsUsd: null,
          refusal: 'Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona',
          refusalTail: 'seller',
        }),
      ],
      estimate: twoTotals({ exactRows: 0, exactUsd: null, taxminiyUsd: null, taxminiyFee: null, taxminiyBlock: 'x' }),
    });
    expect(lenta).toContain('— boj kamida $3/dona — mijozdan so‘rab, kartadagi lentaga yozing');
    expect(lenta).not.toContain('«➕');
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
    // Re-anchored for round 3 (§2.5): the chat's seller tail is «➕»'s.
    expect(seller).toContain(
      'Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    );
    const sellerLenta = aiVedReplyText({
      ...base,
      link: null,
      audience: 'lenta',
      freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
    });
    expect(sellerLenta).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, kartadagi lentaga yozing');
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
    const left = { capped: 12, refused: 2, overtaken: 0, timedOut: 1, unanswered: 0, skipped: false };
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
    const left = pickLeftOf({ capped: 0, refused: 0, overtaken: 0, timedOut: 1, pastDeadline: 2, unanswered: 0 });
    expect(aiVedReplyText({ ...base, pickLeft: left })).toContain(
      '⚠️ AI bazasini qo‘ymadi: 3 tasini bojxona faylidan o‘qib ulgurilmadi — VED to‘ldiradi',
    );
    // The pick DID run: the «vaqt yetmadi — tanlamadi» words are the
    // skipped pick's alone.
    expect(left.skipped).toBe(false);
  });

  it('a pick call that gave no answer says so in A6’s words — never «baza yo‘q» alone (docs/AI-SORAYDI.md §3.4 A12, PR-9)', () => {
    // Four rows were asked and the call was cut at max_tokens: the four rows
    // had declarations to choose from, and the model never chose.
    const left = pickLeftOf({ capped: 0, refused: 0, overtaken: 0, timedOut: 0, pastDeadline: 0, unanswered: 4 });
    expect(left.unanswered).toBe(4);
    expect(aiVedReplyText({ ...base, pickLeft: left })).toContain('⚠️ AI bazasini qo‘ymadi: 4 tasiga javob bermadi — VED to‘ldiradi');
    // …beside the other confessions, after the skipped pick's words and
    // before the capped rows', in the line's one order.
    const both = pickLeftOf({ capped: 2, refused: 0, overtaken: 0, timedOut: 0, pastDeadline: 0, unanswered: 4 });
    expect(aiVedReplyText({ ...base, pickLeft: both })).toContain(
      '⚠️ AI bazasini qo‘ymadi: 4 tasiga javob bermadi, 2 ta qator ko‘rilmadi (juda ko‘p) — VED to‘ldiradi',
    );
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
      // The chat's seller tail since round 3 (§2.5).
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi — VED xodimi hisoblaydi\n' +
        '⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
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

/**
 * His 2.8 b (docs/SAKKIZ-R3.md §2.5): the figures the law pins, asked in the
 * AI answer — the words typed from the spec, so a change here changes the
 * spec first. The rows are numbered by `seq`, the number the add table and
 * the VED's screen print.
 */
describe('the 2.8 b block and the re-run heading (round 3)', () => {
  const ask = (seq: number, name: string, needs: LawAsk['needs']): LawAsk => ({ itemId: `i${seq}`, seq, name, needs });
  const asks: LawAsk[] = [
    ask(2, 'Krossovka', [{ unit: 'juft', why: 'duty', present: false, rate: 3 }]),
    ask(5, 'Kurtka', [{ unit: 'dona', why: 'duty', present: false, rate: 2 }]),
  ];

  it('the chat carries the block exactly as §2.5 prints it, after the lines and before the totals', () => {
    const text = aiVedReplyText({ ...base, asks });
    const block = [
      '❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:',
      '· 2-qator «Krossovka»: juft soni — boj kamida $3/juft',
      '· 5-qator «Kurtka»: soni (dona) — boj kamida $2/dona',
      '✍️ Shu xabarga reply qilib yozing: «2: 40 juft; 5: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.',
    ].join('\n');
    expect(text).toContain(block);
    expect(text.indexOf('1. Monitor 24"')).toBeLessThan(text.indexOf('❓ Hisob'));
    expect(text.indexOf('❓ Hisob')).toBeLessThan(text.indexOf('Rastamojka jami'));
    // Not on the lenta: the VED's copy carries one line instead.
    expect(aiVedReplyText({ ...base, link: null, audience: 'lenta', asks })).not.toContain('❓ Hisob');
  });

  it('the lenta carries ONE line under its heading: which rows the seller was asked', () => {
    const lenta = aiVedReplyText({ ...base, link: null, audience: 'lenta', asks }).split('\n');
    expect(lenta[1]).toBe('❓ Sotuvchidan so‘raldi: 2, 5-qator o‘lchovi (qonun so‘raydi).');
    expect(aiVedReplyText({ ...base, asks })).not.toContain('Sotuvchidan so‘raldi');
  });

  it('nothing asked — no block at all, in either rendering', () => {
    for (const a of [null, []]) {
      expect(aiVedReplyText({ ...base, asks: a })).not.toContain('❓');
      expect(aiVedReplyText({ ...base, link: null, audience: 'lenta', asks: a })).not.toContain('❓');
    }
  });

  it('at most eight rows are named, the rest counted; several figures on one row in one line', () => {
    const many = Array.from({ length: 11 }, (_, k) => ask(k + 1, `Tovar ${k + 1}`, [{ unit: 'dona', why: 'duty', present: false, rate: 1 }]));
    many[0] = ask(1, 'Kafel', [
      { unit: 'm2', why: 'duty', present: false, rate: 0.5 },
      { unit: 'kg', why: 'excise', present: false, rate: 0.1 },
    ]);
    const text = aiVedReplyText({ ...base, asks: many });
    expect(text.split('\n').filter((l) => /^· \d+-qator/.test(l))).toHaveLength(LAW_ASKS_NAMED);
    expect(text).toContain('· … yana 3 ta qator — «➕» jadvalida');
    expect(text).toContain('· 1-qator «Kafel»: maydoni (m²) — boj kamida $0.5/m²; sof og‘irligi (kg) — aksiz $0.1/kg');
    // The example takes each row's first pinned unit.
    expect(text).toContain('«1: 120 m²; 2: 300 dona»');
  });

  it('the lenta’s one line is capped like the block: 900 asked rows keep the card’s copy whole (review p5-adv-5)', () => {
    const many = Array.from({ length: 900 }, (_, k) => ask(k + 1, `Tufli ${k + 1}`, [{ unit: 'juft', why: 'duty', present: false, rate: 1 }]));
    const lenta = aiVedReplyText({ ...base, link: null, audience: 'lenta', asks: many });
    expect(lenta.split('\n')[1]).toBe('❓ Sotuvchidan so‘raldi: 1, 2, 3, 4, 5, 6, 7, 8, …-qator o‘lchovi (qonun so‘raydi).');
    // The groups and the totals are still on the card's copy.
    expect(lenta).toContain('Rastamojka jami');
  });

  it('a re-run says «qayta hisob» after the title phrase — the head still the chip’s anchor', () => {
    const rerun = aiVedReplyText({ ...base, pass: 'amend' }).split('\n')[0]!;
    expect(rerun).toBe(`${AI_REPLY_HEAD} · taxminiy rastamojka · ${RERUN_WORD} · GS323 · B-000067`);
    expect(rerun.startsWith(MACHINE_REPLY_HEADS.ai)).toBe(true);
    const podklyuch = aiVedReplyText({
      ...base,
      pass: 'amend',
      freight: road({ listUsd: 1920, routeLabel: 'Xitoy → O‘zbekiston', bandText: '180 kg/m³ · $160/m³ × 12 m³' }),
    }).split('\n')[0];
    expect(podklyuch).toBe(`${AI_REPLY_HEAD} · taxminiy podklyuch (rastamojka + yo‘lkira) · ${RERUN_WORD} · GS323 · B-000067`);
    expect(aiVedReplyText(base).split('\n')[0]).not.toContain(RERUN_WORD);
  });

  it('a stale total after an addition: the road line is §2.5’s words, no figure and no JAMI sum', () => {
    for (const audience of ['chat', 'lenta'] as const) {
      const text = aiVedReplyText({
        ...base,
        pass: 'amend',
        audience,
        freight: { ok: false, refusal: 'x', tail: 'ved', stale: true },
      });
      expect(text).toContain(ROAD_STALE_LINE);
      expect(text).not.toContain('Yo‘lkira: ≈');
      expect(text).not.toContain('JAMI (rastamojka + yo‘lkira)');
    }
  });
});

/**
 * Where NOBODY asks the seller (docs/IKKI-ESHIK.md §3.5, his 4a and 5a,
 * 2026-11-08): `noAsk` is the one switch — no ❓ block, a seller's fact reads
 * «— VED xodimi sizdan so‘raydi», the VED's own gaps keep their words, the
 * JAMI that cannot be made is the VED's, and the lenta names the same gaps
 * under «⚠️ VED uchun:». The words are the spec's, typed from it. It was
 * both bot doors' answer; since docs/AI-SORAYDI.md §3.4 A1 (his 4a of
 * 2026-11-11, review JR-13) it is the plain door's — and the AI door's card
 * copy for a seller nobody reached (`lentaUnasked`). The AI door's answer
 * asks again (the block after this one); a request from before the doors
 * (NULL, `noAsk` false) keeps every word above this block — the cases above
 * are its pins.
 */
describe('where nobody asks the seller (`noAsk`, §3.5)', () => {
  const ask = (seq: number, name: string, needs: LawAsk['needs']): LawAsk => ({ itemId: `i${seq}`, seq, name, needs });
  const asks: LawAsk[] = [
    ask(2, 'Krossovka', [{ unit: 'juft', why: 'duty', present: false, rate: 3 }]),
    ask(5, 'Kurtka', [{ unit: 'dona', why: 'duty', present: false, rate: 2 }]),
  ];
  const door: AiVedReplyInput = { ...base, noAsk: true };
  const sellerLine = line({
    customsUsd: null,
    refusal: 'Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona',
    refusalTail: 'seller',
  });
  const vedLine = line({ label: 'Sumka', customsUsd: null, refusal: 'baza yo‘q', refusalTail: 'ved' });
  const ASK_WORDS = ['❓', 'mijozdan so‘rab', '«➕ Shu so‘rovga qo‘shish» bilan yuboring', 'kartadagi lentaga yozing', 'reply qilib yozing', 'to‘ldiring'];

  it('the ❓ block is gone — the rows the law wants are not asked of the seller (the plain door, his 2a/3a)', () => {
    const chat = aiVedReplyText({ ...door, asks });
    expect(chat).not.toContain('❓');
    expect(chat).not.toContain('Hisob to‘liq bo‘lishi uchun');
    // …while a request from before the doors still asks it, word for word.
    expect(aiVedReplyText({ ...base, asks })).toContain('❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak');
  });

  it('a seller’s fact on a customs line: «— VED xodimi sizdan so‘raydi»; the VED’s own gap keeps «— VED xodimi qo‘yadi»', () => {
    const chat = aiVedReplyText({ ...door, lines: [sellerLine, vedLine], totalUsd: null });
    expect(chat).toContain('   ⚠️ Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona — VED xodimi sizdan so‘raydi');
    expect(chat).toContain('   ⚠️ baza yo‘q — VED xodimi qo‘yadi');
    for (const w of ASK_WORDS) expect(chat, w).not.toContain(w);
    // The lenta's reader is the VED: «so‘raydi», nobody's chat.
    const lenta = aiVedReplyText({ ...door, link: null, audience: 'lenta', lines: [sellerLine], totalUsd: null });
    expect(lenta).toContain('kamida $3/dona — VED xodimi so‘raydi');
    expect(lenta).not.toContain('sizdan');
  });

  it('the road’s seller facts — brutto, cube, both, the city — say the VED asks; the VED’s own refusals are his', () => {
    for (const refusal of [
      'umumiy brutto og‘irlik (kg) yo‘q',
      'umumiy hajm (m³) yo‘q',
      'umumiy hajm (m³) va brutto og‘irlik (kg) yo‘q',
      'yo‘nalish (zona) tanlanmagan — qaysi shahardan ekani yozilmagan',
    ]) {
      const chat = aiVedReplyText({ ...door, freight: { ok: false, refusal, tail: 'seller' } });
      expect(chat).toContain(`Yo‘lkira: ⚠️ ${refusal} — VED xodimi sizdan so‘raydi`);
      for (const w of ASK_WORDS) expect(chat, w).not.toContain(w);
    }
    const zone = aiVedReplyText({
      ...door,
      freight: {
        ok: false,
        refusal: 'yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi',
        tail: 'ved',
        also: { refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
      },
    });
    expect(zone).toContain(
      'Yo‘lkira: ⚠️ yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi — VED xodimi hisoblaydi\n' +
        '⚠️ umumiy brutto og‘irlik (kg) yo‘q — VED xodimi sizdan so‘raydi',
    );
  });

  it('a podklyuch JAMI that cannot be made is the VED’s: «JAMI: hozircha hisoblab bo‘lmadi — VED xodimi hisoblaydi.»', () => {
    const refused = { ok: false as const, refusal: 'umumiy hajm (m³) yo‘q', tail: 'seller' as const };
    expect(aiVedReplyText({ ...door, freight: refused })).toContain('JAMI: hozircha hisoblab bo‘lmadi — VED xodimi hisoblaydi.');
    // NULL keeps today's «…to‘ldiring».
    expect(aiVedReplyText({ ...base, freight: refused })).toContain(
      'JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.',
    );
  });

  it('the figure still goes out — the estimate and its caveat, asked or not', () => {
    const chat = aiVedReplyText(door);
    expect(chat).toContain('Rastamojka jami: ≈ $661.76');
    expect(chat).toContain('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
  });

  it('the lenta names the same gaps under «⚠️ VED uchun:» — never «Sotuvchidan so‘raldi»', () => {
    const lenta = aiVedReplyText({
      ...door,
      link: null,
      audience: 'lenta',
      asks,
      freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
    }).split('\n');
    expect(lenta[1]).toBe('⚠️ VED uchun: 2-qator «Krossovka»: juft soni; 5-qator «Kurtka»: soni (dona); umumiy brutto og‘irlik (kg) yo‘q.');
    expect(lenta.join('\n')).not.toContain('Sotuvchidan so‘raldi');
    // No gaps, no line; and the chat never carries it.
    expect(aiVedReplyText({ ...door, link: null, audience: 'lenta' })).not.toContain('VED uchun:');
    expect(aiVedReplyText({ ...door, asks })).not.toContain('⚠️ VED uchun');
  });

  it('a code the model proposed while reading wears «(AI taklifi)» in the chat and on the lenta, as the table prints it (§3.1)', () => {
    const ai = line({ aiCode: true });
    for (const audience of ['chat', 'lenta'] as const) {
      const text = aiVedReplyText({ ...door, audience, lines: [ai] });
      expect(text).toContain('1. Monitor 24" · 8528520000 (AI taklifi) · 100 dona × $20/dona 🧠');
    }
    // Not on a code the file or a memory stated — and the NULL door marks it too.
    expect(aiVedReplyText(door)).not.toContain('(AI taklifi)');
    expect(aiVedReplyText({ ...base, lines: [ai] })).toContain('8528520000 (AI taklifi)');
  });
});

/**
 * The AI door ASKS AGAIN after «Tasdiqlash» (docs/AI-SORAYDI.md §3.4 A1-A2,
 * his 4a of 2026-11-11: «yetishmayotgan narsa bo‘lsa … so‘rasin va
 * to‘ldirsin», reversing IKKI-ESHIK's 5a for this door; review JR-13 — one
 * list per door, JS-25 — the block's cap on the UNION). Everything the
 * seller can give, in the NULL door's tails, never «VED xodimi sizdan
 * so‘raydi» about a figure only he has. The words are the spec's and the
 * judge's, typed from them.
 */
describe('the AI door asks again (A1, A2)', () => {
  const ask = (seq: number | null, kind: SellerAsk['kind'], text: string, needs: SellerAsk['needs'] = []): SellerAsk => ({
    itemId: seq === null ? null : `i${seq}`,
    seq,
    kind,
    text,
    needs,
  });
  const LAW = ask(1, 'law', '1-qator «Kurtka»: soni (dona) — boj kamida $3/dona', ['dona']);
  const MEASURE = ask(2, 'measure', '2-qator «Ryukzak»: soni (dona) yoki sof og‘irligi (kg)', ['dona', 'kg']);
  const what = (seq: number) => ask(seq, 'what', `${seq}-qator «Zapchast ${seq}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`);
  const AI = ask(5, 'ai', '5-qator «Stul»: Stul nimadan qilingan?');
  const BRUTTO = ask(null, 'total', 'umumiy brutto og‘irligi (kg, qadoq bilan) — yo‘lkira shunga bog‘liq', ['kg']);
  const PLUS = '— yoki «➕ Shu so‘rovga qo‘shish» ni bosing.';
  const aiDoor: AiVedReplyInput = { ...base, asks: null, sellerAsks: [LAW, MEASURE, what(3), AI, BRUTTO] };

  it('the block: its own head, a row with no figure FIRST, then the law’s, «what», the AI’s, the totals — and how to answer', () => {
    expect(sellerAsksBlock(aiDoor.sellerAsks!)).toEqual([
      '❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:',
      '· 2-qator «Ryukzak»: soni (dona) yoki sof og‘irligi (kg)',
      '· 1-qator «Kurtka»: soni (dona) — boj kamida $3/dona',
      '· 3-qator «Zapchast 3»: bu nima — nimadan qilingan, nima uchun ishlatiladi?',
      '· 5-qator «Stul»: Stul nimadan qilingan?',
      '· umumiy brutto og‘irligi (kg, qadoq bilan) — yo‘lkira shunga bog‘liq',
      // The first two FIGURE asks in that order: row 2's count, row 1's count.
      `✍️ Shu xabarga reply qilib yozing: «2: 300 dona; 1: 300 dona» ${PLUS}`,
      // Re-anchored (review ask-break-1): row 3's words have no reply form in
      // this release — they go to the card's lenta, and the VED codes it.
      '📝 Nima tovar ekanini (nimadan, nima uchun) kartadagi lentaga yozing — kodni VED xodimi qo‘yadi.',
    ]);
  });

  it('the chat carries the block; the lenta says who was asked — never «VED uchun», never the law-only block', () => {
    const chat = aiVedReplyText(aiDoor);
    for (const l of sellerAsksBlock(aiDoor.sellerAsks!)) expect(chat).toContain(l);
    expect(chat).not.toContain('Hisob to‘liq bo‘lishi uchun');
    const lenta = aiVedReplyText({ ...aiDoor, link: null, audience: 'lenta' }).split('\n');
    // Rows 1, 2, 3, 5 asked (one run 1-3, then 5), and the brutto.
    expect(lenta[1]).toBe('❓ Sotuvchidan so‘raldi: 1-3, 5-qator; umumiy brutto.');
    expect(lenta.join('\n')).not.toContain('VED uchun');
    expect(lenta.join('\n')).not.toContain(SELLER_ASKS_HEAD);
  });

  it('the AI door’s list REPLACES the law’s: a law-only `asks` beside it is not drawn', () => {
    const lawOnly: LawAsk[] = [{ itemId: 'i9', seq: 9, name: 'Boshqa', needs: [{ unit: 'juft', why: 'duty', present: false, rate: 3 }] }];
    const chat = aiVedReplyText({ ...aiDoor, asks: lawOnly });
    expect(chat).not.toContain('9-qator');
    // Nothing owed on the AI door: no block at all — and no fallback to the law's.
    expect(aiVedReplyText({ ...aiDoor, asks: lawOnly, sellerAsks: [] })).not.toContain('❓');
  });

  it('a seller’s fact keeps the NULL door’s tail — «mijozdan so‘rab, «➕» bilan yuboring», never «VED xodimi sizdan so‘raydi»', () => {
    const sellerLine = line({ customsUsd: null, refusal: 'Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona', refusalTail: 'seller' });
    const chat = aiVedReplyText({ ...aiDoor, lines: [sellerLine], totalUsd: null, freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' } });
    expect(chat).toContain('kamida $3/dona — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    expect(chat).toContain('Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    expect(chat).toContain('JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.');
    expect(chat).not.toContain('sizdan so‘raydi');
  });

  it('`noAsk` wins: the card copy for a seller nobody reached draws no block even when handed one', () => {
    const quiet = aiVedReplyText({ ...aiDoor, noAsk: true });
    expect(quiet).not.toContain('❓');
    expect(quiet).not.toContain('reply qilib');
  });

  it('more than three uncoded rows fold into ONE line, by their numbers (review JS-25)', () => {
    // Rows 2, 5, 6, 7, 9 → «2, 5-7, 9».
    const block = sellerAsksBlock([2, 5, 6, 7, 9].map(what));
    expect(block).toEqual([
      // Re-anchored (review ask-break-1, ask-spec-1): words only — no «javob
      // yozsangiz qayta hisoblaydi» (nothing re-runs on words in this
      // release), no words example (the add table refuses it «name_mismatch»),
      // and where the words do go.
      '❓ AI so‘raydi:',
      '· 2, 5-7, 9-qator: nima tovar ekanini yozing (nimadan, nima uchun)',
      '📝 Nima tovar ekanini (nimadan, nima uchun) kartadagi lentaga yozing — kodni VED xodimi qo‘yadi.',
    ]);
    // Three stay three lines.
    expect(sellerAsksBlock([2, 5, 6].map(what)).filter((l) => l.startsWith('· '))).toHaveLength(3);
  });

  it('the cap of 8 is on the UNION, in rank order — the rest counted «… yana N ta — «➕» jadvalida»', () => {
    const measures = Array.from({ length: 10 }, (_, k) => ask(k + 1, 'measure', `${k + 1}-qator «Tovar ${k + 1}»: soni (dona) yoki sof og‘irligi (kg)`, ['dona', 'kg']));
    // 10 measures, 2 whats and the brutto: the 8 first measures named;
    // 2 measures + 2 whats + the brutto = 5 counted.
    const block = sellerAsksBlock([...measures, what(11), what(12), BRUTTO]);
    expect(block.filter((l) => /^· \d+-qator/.test(l))).toHaveLength(LAW_ASKS_NAMED);
    // The count ends the asks; the ✍️ line and the words' line follow it.
    expect(block.at(-3)).toBe('· … yana 5 ta — «➕» jadvalida');
    // With five whats the fold is ONE entry standing for five: 7 + 1 = 8, none counted.
    const folded = sellerAsksBlock([...measures.slice(0, 7), ...[11, 12, 13, 14, 15].map(what)]);
    expect(folded).toContain('· 11-15-qator: nima tovar ekanini yozing (nimadan, nima uchun)');
    expect(folded.some((l) => l.includes('yana'))).toBe(false);
  });

  it('a total’s example is the add table’s own «jami …»', () => {
    expect(sellerAsksBlock([BRUTTO]).at(-1)).toBe(`✍️ Shu xabarga reply qilib yozing: «jami 3500 kg» ${PLUS}`);
  });

  /**
   * Review ask-break-1 / ask-spec-1: the block told the seller to reply
   * «2: metall, tormoz kolodkasi», and the add table that reply opens (stage
   * `review`, calc-amend.ts `openAdd`) refused it «name_mismatch» — words on a
   * stored row are A5, release 2. So every example the block teaches is fed
   * to the table's own reader over the rows it names, and none may be
   * refused; and a block that asks only words teaches no reply at all.
   */
  it('every ✍️ example the block teaches is an answer the add table takes — and words get none', () => {
    // The table the reply opens: rows 1-3 as the asks name them — row 1 owes
    // the law's count, row 2 a count or a weight, row 3 words only (no figure
    // owed) — plus the brutto the road needs.
    const table: TableRef = {
      rows: [
        { no: 1, index: 0, seq: 1, name: 'Kurtka', needs: ['dona'] },
        { no: 2, index: 1, seq: 2, name: 'Ryukzak', needs: ['dona', 'kg'] },
        { no: 3, index: 2, seq: 3, name: 'Zapchast 3', needs: [] },
      ],
      open: [{ line: 1 }, { line: 2 }, { totals: 'weightKg' }],
      preferred: [{ line: 1 }, { line: 2 }],
      stage: 'review',
    };
    const blocks = [
      sellerAsksBlock([LAW, MEASURE, what(3), BRUTTO]),
      sellerAsksBlock([what(3)]),
      sellerAsksBlock([BRUTTO]),
      sellerAsksBlock([MEASURE, AI]),
    ];
    const examples = blocks
      .flat()
      .filter((l) => l.startsWith('✍️'))
      .flatMap((l) => /«([^»]*)»/.exec(l)![1]!.split('; '));
    // Typed from the asks, in ASK_RANK's order and at most two a block: the
    // first block's row 2 (no figure ranks first) and row 1 — its brutto is
    // the third figure ask and not shown; the words-only block none; the
    // brutto's own «jami 3500 kg»; row 2's «300 dona» beside the AI's
    // question. Never row 3's words.
    expect(examples).toEqual(['2: 300 dona', '1: 300 dona', 'jami 3500 kg', '2: 300 dona']);
    for (const e of examples) {
      const { segments } = parseTableAnswer(e, table);
      expect(segments.length, e).toBeGreaterThan(0);
      for (const seg of segments) expect(seg.refused, e).toBeNull();
    }
    // A words-only block: no reply form, no promise of a re-run, and where the
    // words go instead — the reading's own question likewise.
    const words = sellerAsksBlock([what(3)]);
    expect(words[0]).toBe(SELLER_WORDS_HEAD);
    expect(words.some((l) => l.includes('reply qilib'))).toBe(false);
    expect(words.at(-1)).toBe(WHAT_ANSWER_LINE);
    expect(sellerAsksBlock([AI])).toEqual([SELLER_WORDS_HEAD, `· ${AI.text}`, AI_QUESTION_ANSWER_LINE]);
    // A block that asks a figure keeps the judge's head (JS-25).
    expect(sellerAsksBlock([LAW, what(3)])[0]).toBe(SELLER_ASKS_HEAD);
  });

  it('the lenta line: the rows by run, then the totals', () => {
    expect(sellerAsksLentaLine([what(4), MEASURE, BRUTTO, ask(null, 'total', 'umumiy hajmi (kub) — yo‘lkira shunga bog‘liq', ['m3'])])).toBe(
      '❓ Sotuvchidan so‘raldi: 2, 4-qator; umumiy brutto; umumiy hajm.',
    );
  });

  it('FORTY uncoded rows: the JAMI line, the caveat and the ➕ line all survive the 4096 fit (review JS-25)', () => {
    const names = Array.from({ length: 40 }, (_, k) => `Zapchast avtomobil uchun, model XJ-${200 + k}, metall va plastikdan, katta`);
    const rows = names.map((n, k) => ({ seq: k + 1, name: n }));
    // Each uncoded row also states no figure — 80 asks, every one ~120 characters.
    const asks: SellerAsk[] = rows.flatMap((r) => [
      ask(r.seq, 'measure', `${r.seq}-qator «${r.name}»: soni (dona) yoki sof og‘irligi (kg)`, ['dona', 'kg']),
      ask(r.seq, 'what', `${r.seq}-qator «${r.name}»: bu nima — nimadan qilingan, nima uchun ishlatiladi?`),
    ]);
    const text = aiVedReplyText({
      ...aiDoor,
      lines: [],
      ungrouped: rows,
      totalUsd: null,
      fee: null,
      freight: { ok: false, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' },
      sellerAsks: [...asks, BRUTTO],
    });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.');
    expect(text).toContain('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
    expect(text).toContain(PLUS);
    // 8 measures named; 32 measures + the folded 40 whats + the brutto = 73 counted.
    expect(text).toContain('· … yana 73 ta — «➕» jadvalida');
  });
});

/**
 * ONE numbering in the whole message (docs/AI-SORAYDI.md §3.4 A3 — PA-3,
 * reproduced end to end in the diagnosis): the answer numbered its lines by
 * GROUP («2. Куртка…») while every answer is addressed by the row's `seq`,
 * so «2: 300 dona» typed against line 2 overwrote row 2's count (10 → 300).
 * Every literal below is the row numbers typed by hand.
 */
describe('the number in front of a line is the number an answer is addressed by (A3)', () => {
  it('lineNumber: one row, a run, rows apart, and past five pieces a count — never a range over a gap', () => {
    expect(lineNumber([3])).toBe('3.');
    // Handed out of order and twice: sorted, each once.
    expect(lineNumber([2, 1, 2])).toBe('1-2.');
    expect(lineNumber([1, 3])).toBe('1, 3.');
    expect(lineNumber([1, 2, 3, 5])).toBe('1-3, 5.');
    // Seven rows apart: five pieces shown (1, 3, 5, 7, 9), rows 11 and 13 counted.
    expect(lineNumber([1, 3, 5, 7, 9, 11, 13])).toBe('1, 3, 5, 7, 9 (+2).');
    // A run among the hidden pieces counts each of its rows: 13-15 is three.
    expect(lineNumber([1, 3, 5, 7, 9, 11, 13, 14, 15])).toBe('1, 3, 5, 7, 9 (+4).');
    // A group of no rows has nothing to address.
    expect(lineNumber([])).toBe('·');
  });

  // PA-3's three rows: 1 the priced dishes, 2 an uncoded part, 3 the jacket
  // the law wants counted. On the AI door the block asks row 3's count and
  // what row 2 is.
  const dishes = line({
    seqs: [1],
    label: 'Посуда пластиковая хозяйственная',
    code: '3924100000',
    measureText: '500 kg × $2/kg',
    bazaSource: 'import',
    dutyText: '20%',
    customsUsd: 344,
  });
  const jacket = line({
    seqs: [3],
    label: 'Куртка мужская зимняя',
    code: '6201400000',
    measureText: '120 kg × $5/kg',
    bazaSource: 'import',
    dutyText: '20% / min 4 $/dona',
    customsUsd: null,
    refusal: 'soni (dona) kiritilmagan — boj kamida $4/dona',
    refusalTail: 'seller',
  });
  const asked: SellerAsk[] = [
    { itemId: 'i2', seq: 2, kind: 'what', text: '2-qator «Zapchast XJ-200»: bu nima — nimadan qilingan, nima uchun ishlatiladi?', needs: [] },
    { itemId: 'i3', seq: 3, kind: 'law', text: '3-qator «Куртка мужская зимняя»: soni (dona) — boj kamida $4/dona', needs: ['dona'] },
  ];
  const mixed: AiVedReplyInput = {
    ...base,
    totalUsd: null,
    fee: null,
    lines: [dishes, jacket],
    ungrouped: [{ seq: 2, name: 'Zapchast XJ-200' }],
    sellerAsks: asked,
  };

  it('PA-3: every line opens with its row’s own number, the uncoded row in its place — and the ❓ block and its example say the same numbers', () => {
    const text = aiVedReplyText(mixed);
    const lines = text.split('\n');
    expect(lines).toContain('1. Посуда пластиковая хозяйственная · 3924100000 · 500 kg × $2/kg 📥');
    // Asked what it is below: no «VED xodimi qo‘yadi» on its own line.
    expect(lines).toContain('2. Zapchast XJ-200 — kod yo‘q');
    expect(lines).toContain('3. Куртка мужская зимняя · 6201400000 · 120 kg × $5/kg 📥');
    expect(lines).toContain('   ⚠️ soni (dona) kiritilmagan — boj kamida $4/dona — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring');
    // The old numbering's tell: the jacket as line «2.».
    expect(text).not.toContain('2. Куртка');
    expect(text).not.toContain('Kod topilmadi');
    // The line heads, in order, are the rows 1, 2, 3 — the numbers the block asks by.
    expect(lines.filter((l) => /^\d+\. /.test(l)).map((l) => l.split('.')[0])).toEqual(['1', '2', '3']);
    expect(lines).toContain('· 3-qator «Куртка мужская зимняя»: soni (dona) — boj kamida $4/dona');
    expect(lines).toContain('· 2-qator «Zapchast XJ-200»: bu nima — nimadan qilingan, nima uchun ishlatiladi?');
    expect(text).toContain('✍️ Shu xabarga reply qilib yozing: «3: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.');
  });

  it('the lines are in row order whatever order the groups come in', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      lines: [line({ seqs: [4, 5], label: 'B, B2' }), line({ seqs: [1], label: 'A' })],
      ungrouped: [{ seq: 3, name: 'C' }],
    });
    const heads = text.split('\n').filter((l) => /^[\d, -]+\. /.test(l));
    expect(heads.map((l) => l.split(' ')[0])).toEqual(['1.', '3.', '4-5.']);
  });

  it('an uncoded row the fit cut off a long invoice is still named — by its number, where the fit never cuts', () => {
    // Thirty priced rows (1-30), then two uncoded ones (31, 32): row order puts
    // them past MAX_REPLY_LINES (25), which the old list under the lines never was.
    const many = Array.from({ length: 30 }, (_, i) => line({ seqs: [i + 1], label: `Tovar ${i + 1}` }));
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      lines: many,
      ungrouped: [
        { seq: 31, name: 'Sumka' },
        { seq: 32, name: 'Choynak' },
      ],
    });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(text).toContain('… va yana');
    expect(text).not.toContain('31. Sumka');
    expect(text).toContain('⚠️ Kod yo‘q: 31-32-qator — VED xodimi qo‘yadi');
    // Nothing cut, nothing named twice.
    expect(aiVedReplyText({ ...base, ungrouped: [{ seq: 2, name: 'Sumka' }] })).not.toContain('⚠️ Kod yo‘q');
  });

  it('an uncoded row nobody asks about says who codes it — on the NULL door, and on the card copy nobody reached', () => {
    const legacy = aiVedReplyText({ ...mixed, sellerAsks: null });
    expect(legacy.split('\n')).toContain('2. Zapchast XJ-200 — kod yo‘q — VED xodimi qo‘yadi');
    const unasked = aiVedReplyText({ ...mixed, noAsk: true, audience: 'lenta', link: null });
    expect(unasked.split('\n')).toContain('2. Zapchast XJ-200 — kod yo‘q — VED xodimi qo‘yadi');
  });
});

/**
 * A coding call that did not answer says what is TRUE (docs/AI-SORAYDI.md
 * §3.4 A6, review JS-15 — binding): the request is in the VED's queue and
 * the VED codes it. Never «Kod topilmadi: Куртка мужская зимняя» about a
 * jacket the model never looked at (PA-4), and never «🔄 … qayta urinib
 * ko‘ring», which names a button the answer does not carry.
 */
describe('a coding call that failed says so (A6)', () => {
  const failed: AiVedReplyInput = {
    ...base,
    totalUsd: null,
    fee: null,
    lines: [],
    ungrouped: [{ seq: 1, name: 'Куртка мужская зимняя' }],
    proposeFailed: true,
  };

  it('the ruling’s sentence, once; the row says only «kod yo‘q»; no «Kod topilmadi», no 🔄', () => {
    expect(CODING_FAILED_LINE).toBe('⚠️ AI kod qo‘ya olmadi (javob bermadi) — so‘rov VED navbatida, kodni VED xodimi qo‘yadi');
    for (const audience of ['chat', 'lenta'] as const) {
      const text = aiVedReplyText({ ...failed, audience, link: null });
      const lines = text.split('\n');
      expect(lines.filter((l) => l === CODING_FAILED_LINE), audience).toHaveLength(1);
      expect(lines).toContain('1. Куртка мужская зимняя — kod yo‘q');
      for (const w of ['Kod topilmadi', '🔄', 'qayta urinib']) expect(text, `${audience}: ${w}`).not.toContain(w);
    }
  });

  it('with every row coded there is nothing to say about a code', () => {
    expect(aiVedReplyText({ ...base, proposeFailed: true })).not.toContain(CODING_FAILED_LINE);
  });
});
