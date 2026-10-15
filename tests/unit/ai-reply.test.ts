import { describe, expect, it } from 'vitest';
import { aiVedReplyText, MAX_REPLY_LINES, TELEGRAM_LIMIT, type AiVedLine } from '@/modules/wms/calc/ai-reply';

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
  ...over,
});

const base = {
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
};

describe('the AI-VED reply', () => {
  it('prints the line, the law in words and the figure', () => {
    const text = aiVedReplyText(base);
    expect(text).toContain('1. Monitor 24" · 8528520000 · 100 dona × $20/dona 🧠');
    expect(text).toContain('boj 10% · QQS 12% → $496.96');
    expect(text).toContain('Deklaratsiya yig‘imi (VMQ-55): 5 BHM ≈ $164.80');
    expect(text).toContain('Rastamojka jami: ≈ $661.76');
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
      freight: {
        ok: true,
        listUsd: 1920,
        routeLabel: 'Xitoy → O‘zbekiston',
        bandText: '180 kg/m³ · $160/m³ × 12 m³',
      },
    });
    expect(text).toContain('tahminiy podklyuch (rastamojka + yo‘lkira)');
    expect(text).toContain('Rastamojka jami: ≈ $661.76');
    expect(text).toContain('Yo‘lkira (Xitoy → O‘zbekiston, 180 kg/m³ · $160/m³ × 12 m³): ≈ $1920.00');
    expect(text).toContain('JAMI (rastamojka + yo‘lkira): ≈ $2581.76');
    // The caveat still closes the money, under the jami.
    expect(text.indexOf('JAMI')).toBeLessThan(text.indexOf('Rasmiy emas'));
  });

  it('a refused road is a sentence, and no JAMI is summed over half a price', () => {
    const text = aiVedReplyText({
      ...base,
      freight: { ok: false, refusal: 'og‘irlik yoki hajm yo‘q' },
    });
    expect(text).toContain('Yo‘lkira: ⚠️ og‘irlik yoki hajm yo‘q — VED xodimi hisoblaydi');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
    expect(text).not.toMatch(/JAMI \(rastamojka/);
    expect(text).not.toContain('$0.00');
  });

  it('a customs-only job never mentions the road at all', () => {
    const text = aiVedReplyText(base);
    expect(text).toContain('tahminiy rastamojka');
    expect(text).not.toContain('Yo‘lkira');
    expect(text).not.toContain('JAMI');
  });

  it('no customs total with a priced road still refuses the JAMI', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      freight: { ok: true, listUsd: 500, routeLabel: 'Qashg‘ar → O‘zbekiston', bandText: '90 kg/m³ · $70/m³ × 7 m³' },
    });
    expect(text).toContain('Yo‘lkira (Qashg‘ar → O‘zbekiston');
    expect(text).toContain('JAMI: hozircha hisoblab bo‘lmadi');
  });

  /*
   * Re-anchored deliberately (2026-10-09, judge MR-23): these two pinned a
   * PARTIAL total — «Rastamojka jami (1 ta qatordan, 1 tasi hisoblanmadi):
   * ≈ $661.76» — which the kernel's `requestCustomsFor` can no longer produce
   * (no partial sums: a refused or uncoded line means no total). The input is
   * now what the WORKSPACE hands the reply in that state — a null total and
   * the named lines — and the belt test below proves a caller that passes a
   * figure anyway still prints none.
   */
  it('a blocked line prints WHY, and there is no total while it stands', () => {
    const text = aiVedReplyText({
      ...base,
      totalUsd: null,
      lines: [line(), line({ label: 'Sumka', code: null, customsUsd: null, refusal: 'baza yo‘q' })],
    });
    expect(text).toContain('⚠️ baza yo‘q — VED xodimi qo‘yadi');
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
    expect(text).not.toMatch(/ta qatordan/);
    // Law 6: a refusal is never spelled as money.
    expect(text).not.toContain('$0.00');
  });

  it('uncoded items are NAMED, and no total stands over the rest', () => {
    const text = aiVedReplyText({ ...base, totalUsd: null, ungrouped: ['Sumka', 'Choynak'] });
    expect(text).toContain('⚠️ Kod topilmadi: Sumka, Choynak');
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
  });

  it('a partial figure handed in anyway is never printed — the belt (MR-23)', () => {
    // A caller that summed the priced lines itself: the reply refuses to
    // carry it, on a podklyuch job too (no JAMI over half a declaration).
    const text = aiVedReplyText({
      ...base,
      ungrouped: ['Sumka'],
      freight: { ok: true, listUsd: 500, routeLabel: 'Xitoy → O‘zbekiston', bandText: '90 kg/m³' },
    });
    expect(text).not.toContain('$661.76');
    expect(text).toContain('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
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
    expect(both).toContain('🧠 avvalgi muhrdan · 📥 bojxona faylidan');
    // A price the VED typed wears no mark and needs no legend line.
    expect(aiVedReplyText({ ...base, lines: [line({ bazaSource: 'typed' })] })).not.toContain(
      'avvalgi muhrdan',
    );
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
