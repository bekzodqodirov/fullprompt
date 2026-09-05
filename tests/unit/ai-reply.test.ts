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
  excisePct: null,
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
  hasCertificate: true,
  hasFreight: false,
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

  it('NEVER prices freight — it names who does', () => {
    const text = aiVedReplyText({ ...base, hasFreight: true });
    expect(text).toContain('Yo‘lkirani VED xodimi hisoblaydi.');
    // The owner's decision 8: not a figure, not a dash, not a list price.
    expect(text).not.toMatch(/yo‘lkira ~?\$/i);
  });

  it('a blocked line prints WHY and is counted out of the total', () => {
    const text = aiVedReplyText({
      ...base,
      lines: [line(), line({ label: 'Sumka', code: null, customsUsd: null, refusal: 'baza yo‘q' })],
    });
    expect(text).toContain('⚠️ baza yo‘q — VED xodimi qo‘yadi');
    expect(text).toContain('Rastamojka jami (1 ta qatordan, 1 tasi hisoblanmadi): ≈ $661.76');
    // Law 6: a refusal is never spelled as money.
    expect(text).not.toContain('$0.00');
  });

  it('uncoded items are NAMED, and counted as not calculated', () => {
    const text = aiVedReplyText({ ...base, ungrouped: ['Sumka', 'Choynak'] });
    expect(text).toContain('⚠️ Kod topilmadi: Sumka, Choynak');
    expect(text).toContain('(1 ta qatordan, 2 tasi hisoblanmadi)');
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
