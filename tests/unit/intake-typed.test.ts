import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_READ_FAILURE,
  landingItems,
  missingFields,
  parseClientHint,
  type AiReadFailure,
} from '@/modules/wms/calc/intake';
import { looksLikeMaterial, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { threadAiAdvice } from '@/modules/wms/calc/from-thread';
import type { NeedLaw } from '@/modules/wms/calc/needs';

/**
 * The as-built review of Sakkiz band round 1 (2026-10-21), the TYPED half:
 * what a person types is read as goods only when it IS goods, a customer's
 * answer is the customer whatever shape it is written in, and a failed AI
 * reading gives advice that can actually help.
 */

const noLaws: ReadonlyMap<string, NeedLaw> = new Map();
const names = (text: string, opts?: { labelledOnly?: boolean }) => readGoodsLines(text, opts).map((g) => g.name);
const read = (p: string) => readFileSync(p, 'utf8');
// A source-shape pin reads CODE, never a comment quoting it (T14, #725/#919):
// thread-calc-wire.test.ts's stripper, so a deleted line cannot stay green
// because a comment still says it.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const source = (p: string) => code(read(p));

describe('a goods label is a whole word with its separator (review #25)', () => {
  it('«Tovarlar: …» is the label, not «lar Kurtka»', () => {
    expect(readGoodsLines('Tovarlar: Kurtka 300 dona')).toEqual([
      expect.objectContaining({ name: 'Kurtka', quantity: 300 }),
    ]);
    expect(names('Assalomu alaykum\nTovarlar:\nKurtka 300 dona 150 kg\nShim 200 dona 80 kg')).toEqual([
      'Kurtka',
      'Shim',
    ]);
  });

  it('a chat sentence that starts with the word is not a product', () => {
    for (const not of [
      'Tovarlar ro‘yxati:',
      'Tovar keldimi?',
      'Tovarni rasmi',
      'Товар готов, можно забирать',
      'Mahsulot sifati yaxshi',
      'Tovar narxi 1200$',
      'Product photos attached',
      'Tovar: qachon keladi?',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
    expect(looksLikeMaterial('Tovarchi Bobur')).toBe(false);
  });

  it('his screenshot still reads, with or without a separator, and counts as labelled', () => {
    const line = 'Tovar синтетическое компрессорное масло 1.1 kub 240 kg';
    for (const opts of [undefined, { labelledOnly: true }]) {
      expect(readGoodsLines(line, opts)).toEqual([
        expect.objectContaining({ name: 'синтетическое компрессорное масло', weightKg: 240, volumeM3: 1.1 }),
      ]);
    }
    // Under a plain label the product carries its figure; a bare name needs
    // the NAMING label (T7 — «Товар - куртка» is the shape of «Товар: готов»).
    expect(names('Товар - куртка 300 шт\nTovar nomi: shim', { labelledOnly: true })).toEqual(['куртка', 'shim']);
  });
});

describe('a bare trailing number is never a goods line (review #24)', () => {
  it('a phone, a code, an order, a rate or a date beside a word is not a product', () => {
    for (const not of [
      'Tel 90 123 45 67',
      'Mening raqamim 90 123 45 67',
      'Mijoz: GS777',
      'Partiya YW-123',
      'Zakaz № 12345',
      'Invoice No. 20231015',
      'Kurs 12650',
      'INN 301234567',
      'Sana 21.10.2026',
      'Kurtka 45 karobka',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });

  it('the phone line no longer steals the real line’s weight', () => {
    const facts = parseManualFacts('Tovar: Kurtka 300 dona\nJami 3 kub 150 kg\nTel 90 123 45 67');
    expect(facts.goods?.map((g) => g.name)).toEqual(['Kurtka']);
    // One line, so the shipment's weight is its own — labelled as derived.
    expect(landingItems(facts)).toEqual([expect.objectContaining({ name: 'Kurtka', quantity: 300, weightKg: 150 })]);
  });

  it('a supplier’s «Кол-во» / «Мест» lines are fields of the product, and cartons are never pieces', () => {
    expect(readGoodsLines('Наименование: куртка женская\nКол-во: 300 шт\nМест: 45')).toEqual([
      expect.objectContaining({ name: 'куртка женская', quantity: null }),
    ]);
    expect(names('Tovar nomi: kurtka\nSoni: 300 dona\nVazni: 150 kg\nHajmi: 3 kub')).toEqual(['kurtka']);
  });

  it('two products welded onto one line are left to the model, not read as «Kurtka Shim»', () => {
    expect(readGoodsLines('Tovarlar: Kurtka 300 dona 150 kg, Shim 200 dona')).toEqual([]);
  });

  it('a real line still reads — a code inside its name, a dash, a count after the code', () => {
    expect(readGoodsLines('iPhone15 300 dona')).toEqual([expect.objectContaining({ name: 'iPhone15', quantity: 300 })]);
    // The figures start at the first digit that starts a TOKEN: «A4»'s digit
    // is part of the name, and the line's count is «500».
    expect(readGoodsLines('A4 qog‘oz 500 dona')).toEqual([expect.objectContaining({ name: 'A4 qog‘oz', quantity: 500 })]);
    expect(names('Samsung A54 300 dona')).toEqual(['Samsung A54']);
    expect(names('Futbolka - oq 300 dona')).toEqual(['Futbolka - oq']);
    expect(readGoodsLines('Kurtka 6201930000 300 dona')).toEqual([
      expect.objectContaining({ name: 'Kurtka', quantity: 300, tnvedCode: '6201930000' }),
    ]);
  });
});

describe('totals, greetings and routes are never a product (review #22)', () => {
  it('typed totals in every spelling a phone produces', () => {
    for (const not of [
      'Salom, 12 kub 3500 kg',
      'Taxminan 12 kub',
      'Hammasi bo‘lib 12 kub 3500 kg',
      'Guangzhou - Toshkent 12 kub 3500 kg',
      'Кубатура: 12 м3',
      'Og’irligi 3500 kg',
      'Umumiy ogʻirligi 3500 kg',
      'Вес груза: 3500 кг',
      'Объем груза 12 м3',
      'Обьем: 12 м3',
      'Yukning vazni 3500 kg',
      'Ves 3500 kg',
      '毛重 3500 kg',
      'Mijoz GS777 12 kub 3500 kg',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });

  it('the checklist still asks for the product', () => {
    const facts = parseManualFacts('Guangzhou → Toshkent\nSalom, 12 kub 3500 kg');
    expect(missingFields('yolkira', facts, noLaws)).toEqual(['goods']);
  });

  it('when the model READ, only a line that names itself goods answers', () => {
    // With the model down every typed line answers — and a destination with
    // its totals is still not one of them (T1/T8); a product line is.
    const text = 'Andijonga 5 kub 1200 kg\nShim 200 dona\nTovar: kurtka 300 dona';
    expect(names(text)).toEqual(['Shim', 'kurtka']);
    expect(names(text, { labelledOnly: true })).toEqual(['kurtka']);
  });

  it('the chat door reads labelled lines only when the model read', () => {
    const service = source('src/modules/wms/calc/from-thread.ts');
    expect(service).toContain("readGoodsLines(material.bodies.join('\\n'), { labelledOnly: ai !== null })");
    // …and reads them AFTER the model answered, or `ai` is not yet known.
    expect(service.indexOf('const typedGoods')).toBeGreaterThan(service.indexOf('const ai = outcome.ok'));
  });
});

describe('the customer’s answer is the customer (review #6, #16, #23, #26)', () => {
  it('a code with a space, a hyphen, a label or a name beside it', () => {
    for (const hint of [
      'GS 777',
      'gs 777',
      'GS-777',
      'Mijoz: GS777',
      'Klient GS777',
      'Mijoz kodi: GS 777',
      'Bobur aka GS777',
      'GS777 Bobur',
    ]) {
      expect(parseClientHint(hint), hint).toEqual({ code: 'GS777' });
      expect(looksLikeMaterial(hint), hint).toBe(false);
    }
    // …and never a goods line «GS» × 777 when it reaches the material anyway.
    expect(names('GS 777\nBobur aka GS777\nKurtka 300 dona')).toEqual(['Kurtka']);
  });

  it('a figure in a unit is not a code', () => {
    expect(parseClientHint('kg 5')).toBeNull();
    expect(parseClientHint('Jasur M2')).toBeNull();
    expect(looksLikeMaterial('Kamola 40 juft')).toBe(true);
  });

  it('a name and a phone on two lines, the phone as its number run', () => {
    expect(parseClientHint('Ali aka\n+998 90 123 45 67')).toEqual({ phone: '+998 90 123 45 67' });
    expect(parseClientHint('Bobur\nGS777')).toEqual({ code: 'GS777' });
    expect(looksLikeMaterial('Ali aka\n+998 90 123 45 67')).toBe(false);
    // Two lines with digits is a list, not a contact.
    expect(parseClientHint('Ali 901234567\nKurtka 4202')).toBeNull();
  });

  it('a name with a number in it is a name, not material', () => {
    expect(looksLikeMaterial('Ali aka 2')).toBe(false);
    expect(looksLikeMaterial('OOO Asia Trade 2020')).toBe(false);
  });

  it('a phone written with its 8, spaced, is a phone; ten glued digits after a word are a code', () => {
    expect(parseClientHint('Ali aka 8 90 123 45 67')).toEqual({ phone: '8 90 123 45 67' });
    expect(parseClientHint('Ivan 912 345 67 89')).toEqual({ phone: '912 345 67 89' });
    expect(parseClientHint('Kurtka 6201930000')).toBeNull();
  });

  it('a goods line holding a code and a count is never a phone (#16)', () => {
    for (const goods of ['Kurtka 6201930000 300 dona', 'Kurtka 6201930000 300ta', 'Shim 620342 500 dona', 'Масло 2710198200 240']) {
      expect(parseClientHint(goods), goods).toBeNull();
      expect(looksLikeMaterial(goods), goods).toBe(true);
    }
    expect(looksLikeMaterial('Kurtka 6201.93.0000 300 dona')).toBe(true);
    for (const [hint, phone] of [
      ['Ali 998 901234567', '998 901234567'],
      ['Bobur 93 555 12 34', '93 555 12 34'],
      ['Ali 90 1234567', '90 1234567'],
    ]) {
      expect(parseClientHint(hint!), hint).toEqual({ phone });
    }
  });

  it('a stall number beside the phone and a dotted phone still resolve (#26)', () => {
    expect(parseClientHint('Dilshod (Andijon, 5-rasta) 90 123 45 67')).toEqual({ phone: '90 123 45 67' });
    expect(parseClientHint('Ali 90.123.45.67')).toEqual({ phone: '90.123.45.67' });
    expect(parseClientHint('90.175.78.00')).toEqual({ phone: '90.175.78.00' });
    expect(parseClientHint('Sardor (90) 123-45-67')).toEqual({ phone: '(90) 123-45-67' });
    // An order number beside it makes the line something else.
    expect(parseClientHint('Zakaz 12345 tel 901234567')).toBeNull();
  });
});

describe('the advice follows the failure (review #20, #21)', () => {
  it('a cut answer is not offered a re-read of the same material', () => {
    expect(AI_READ_FAILURE.truncated.retry).toBe(false);
    expect(AI_READ_FAILURE.truncated.text).toContain('Kamroq sahifa yoki Excel');
  });

  it('the chat door says «later» only where a retry can help', () => {
    const never: AiReadFailure[] = ['not_configured', 'auth', 'refused', 'rejected', 'truncated', 'budget'];
    const later: AiReadFailure[] = ['timeout', 'network', 'rate_limited', 'overloaded', 'unreadable'];
    for (const f of never) expect(threadAiAdvice(f), f).not.toBe('retry');
    for (const f of later) expect(threadAiAdvice(f), f).toBe('retry');
    expect(threadAiAdvice(null)).toBeNull();
  });

  it('the preview carries the flag and the island words both cases, in every bundle', () => {
    expect(source('src/modules/wms/calc/from-thread.ts')).toContain(
      'aiAdvice: threadAiAdvice(outcome.ok ? null : outcome.failure)',
    );
    // The island words the advice — and only after the failure line (T13).
    const island = source('src/components/thread-calc.tsx');
    const line = island.slice(island.indexOf("{t('threadAiFailed')}"));
    expect(line.slice(0, 300)).toContain("preview.aiAdvice === 'retry'");
    expect(line.slice(0, 300)).toContain("? t('threadAiRetry')");
    expect(line.slice(0, 300)).toContain(": t('threadAiNoRetry')");
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const calc = JSON.parse(read(`messages/${locale}.json`)).calc as Record<string, string>;
      expect(calc.threadAiRetry, locale).toBeTruthy();
      expect(calc.threadAiNoRetry, locale).toBeTruthy();
      // The failure line no longer promises a retry by itself.
      expect(calc.threadAiFailed, locale).not.toContain(calc.threadAiRetry!.replace(/[.。]$/u, ''));
    }
  });
});
