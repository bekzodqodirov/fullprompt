import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { landingItems, missingFields, parseClientHint, statesGoods } from '@/modules/wms/calc/intake';
import { looksLikeMaterial, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { threadAiAdvice } from '@/modules/wms/calc/from-thread';
import { codeIn, parseGoodsLine } from '@/modules/wms/calc/units';
import type { NeedLaw } from '@/modules/wms/calc/needs';

/**
 * The SECOND review of Sakkiz band round 1's typed half (2026-10-21, T1-T14):
 * the fixes of the first review read too much as a customer and too little as
 * goods. Every string here is one a reviewer typed into the shipped code.
 */

const noLaws: ReadonlyMap<string, NeedLaw> = new Map();
const names = (text: string, opts?: { labelledOnly?: boolean }) => readGoodsLines(text, opts).map((g) => g.name);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (p: string) => code(readFileSync(p, 'utf8'));
const GS = { prefix: 'GS' };

describe('T3 — the printed TNVED forms are goods, never a phone', () => {
  const printed: [string, string][] = [
    ['Kurtka 6201 93 000 0', '6201930000'],
    ['Масло 2710 19 820 0', '2710198200'],
    ['Kurtka 6201 93 0000', '6201930000'],
    ['Kurtka 6201.93.0000', '6201930000'],
    ['Kurtka 6201.93.000.0 300', '6201930000'],
    ['Kurtka 6201.93.0000 300', '6201930000'],
  ];

  it('the kernel reads 4-2-4 and 4-2-3-1, spaced or dotted', () => {
    for (const [line, tnved] of printed) expect(parseGoodsLine(line).tnvedCode, line).toBe(tnved);
    expect(codeIn('6201.93.0000')?.code).toBe('6201930000');
    expect(codeIn('2710 19 820 0')?.code).toBe('2710198200');
    // A label points at the whole printed code, not its first four digits.
    expect(parseGoodsLine('Kurtka tnved 6201.93.0000 300 dona')).toMatchObject({
      tnvedCode: '6201930000',
      quantity: 300,
      name: 'Kurtka',
    });
  });

  it('a count in a unit after a subheading is a count, not the code’s last group', () => {
    expect(parseGoodsLine('Kurtka 6201 93 3000 dona').tnvedCode).toBeNull();
    expect(codeIn('1200 50 1000 kg')).toBeNull();
  });

  it('all six lines are material, never the customer’s phone', () => {
    for (const [line] of printed) {
      expect(statesGoods(line), line).toBe(true);
      expect(parseClientHint(line), line).toBeNull();
      expect(looksLikeMaterial(line), line).toBe(true);
    }
  });

  it('a printed code typed with no word beside it is goods too — no phone is written 4-2', () => {
    for (const bare of ['6201.93.0000', '2710 19 820 0', '6201 93 000 0']) {
      expect(statesGoods(bare), bare).toBe(true);
      expect(parseClientHint(bare), bare).toBeNull();
      expect(looksLikeMaterial(bare), bare).toBe(true);
    }
    // …and a 4-2 run that is not a whole code is still not a phone.
    expect(parseClientHint('Ali 6201 93 000')).toBeNull();
    // A phone stays a phone.
    expect(statesGoods('+998 90 123 45 67')).toBe(false);
    expect(statesGoods('90.175.78.00')).toBe(false);
  });
});

describe('T4 / T10 — a product and its count is not a client code', () => {
  const notCustomers = [
    'Shim 200',
    'Moy 240',
    'Stol 20',
    'Choy 50',
    'Stol 1000',
    'Olma 300',
    'Samsung A54',
    'Xiaomi Redmi K60',
    'Kurtka va shim\nJami 300',
    'Ayollar kiyimi\nSoni 300',
    'Kurtka\nShim 200',
    'Kurtka\nSamsung A54',
  ];

  it('never a code, with the company prefix or the default', () => {
    for (const text of notCustomers) {
      expect(parseClientHint(text, GS), text).toBeNull();
      expect(parseClientHint(text), text).toBeNull();
    }
    expect(parseClientHint('Uy 5', GS)).toBeNull();
  });

  it('and filed as material, not as the customer’s name', () => {
    for (const text of notCustomers) expect(looksLikeMaterial(text, GS), text).toBe(true);
  });

  it('the company’s own prefix is a code in any case and any separator; other letters only as 2-3 capitals', () => {
    for (const hint of ['GS 777', 'gs 777', 'Gs-777', 'GS777', 'Bobur aka GS777', 'Bobur aka gs 777', 'Mijoz: GS 777']) {
      expect(parseClientHint(hint, GS), hint).toEqual({ code: 'GS777' });
      expect(looksLikeMaterial(hint, GS), hint).toBe(false);
    }
    expect(parseClientHint('AB 123', GS)).toEqual({ code: 'AB123' });
    expect(parseClientHint('Bobur ABC777', GS)).toEqual({ code: 'ABC777' });
    // Another company's prefix is read as ITS code, and «GS» then is not special.
    expect(parseClientHint('xy 45', { prefix: 'XY' })).toEqual({ code: 'XY45' });
    expect(parseClientHint('gs 45', { prefix: 'XY' })).toBeNull();
    // A prefix ending in a digit (round 103).
    expect(parseClientHint('Bobur G1 777', { prefix: 'G1' })).toEqual({ code: 'G1777' });
  });

  it('a total or count word is never a code, however it is cased', () => {
    // Separated, glued on its own, and glued among words — three paths.
    for (const not of ['JAMI 300', 'SONI 300', 'VES 300', 'Jami300', 'Bobur VES300', 'Kurtka JOY 45', 'KUB 5']) {
      expect(parseClientHint(not, GS), not).toBeNull();
    }
  });

  it('a name with a small number is still a name (review #23 stays closed)', () => {
    for (const name of ['Ali aka 2', 'OOO Asia Trade 2020', 'Yiwu ofis 85123456', 'Uy 5']) {
      expect(looksLikeMaterial(name, GS), name).toBe(false);
    }
  });
});

describe('T5 / T9 — the phone is its own digits, and a code beside it is kept', () => {
  it('a stall or shop number after the phone is not part of it', () => {
    for (const [line, phone] of [
      ['Dilshod 90 123 45 67 (5-rasta)', '90 123 45 67'],
      ['Ali 90 123 45 67 2-do‘kon', '90 123 45 67'],
      ['Ali aka 90 123 45 67 5 rasta', '90 123 45 67'],
      ['Ali 90 123 45 67 12-rasta', '90 123 45 67'],
      ['Dilshod (Andijon, 5-rasta) 90 123 45 67', '90 123 45 67'],
      ['+998 90 123 45 67 Ali aka', '+998 90 123 45 67'],
    ] as const) {
      expect(parseClientHint(line, GS), line).toEqual({ phone });
    }
  });

  it('a code and a phone on one line or two return both', () => {
    for (const [text, phone] of [
      ['GS777 901234567', '901234567'],
      ['GS777 +998 90 123 45 67', '+998 90 123 45 67'],
      ['Bobur GS777 90 123 45 67', '90 123 45 67'],
      ['Bobur GS777 90 123 45 67 (5-rasta)', '90 123 45 67'],
      ['Ali aka (GS777) 90 123 45 67', '90 123 45 67'],
      ['GS777\n+998 90 123 45 67', '+998 90 123 45 67'],
      ['Bobur aka\nGS777 90 123 45 67', '90 123 45 67'],
      ['GS 777\n90 123 45 67', '90 123 45 67'],
    ] as const) {
      expect(parseClientHint(text, GS), text).toEqual({ code: 'GS777', phone });
      expect(looksLikeMaterial(text, GS), text).toBe(false);
    }
    // Code-shaped digits never count as «another number» that refuses the line.
    expect(parseClientHint('GS1234 90 123 45 67', GS)).toEqual({ code: 'GS1234', phone: '90 123 45 67' });
  });

  it('two codes or two phones over two lines are a list, not a contact', () => {
    expect(parseClientHint('GS777\nGS555', GS)).toBeNull();
    expect(parseClientHint('Ali 901234567\nVali 931234567', GS)).toBeNull();
  });
});

describe('T2 — a long name-and-phone line is the customer', () => {
  it('one phone, no goods, past sixty characters', () => {
    const line = 'Abdulloh aka Toshkent Chilonzor 9-kvartal dokoni +998 90 123 45 67';
    expect(line.length).toBeGreaterThan(60);
    expect(parseClientHint(line, GS)).toEqual({ phone: '+998 90 123 45 67' });
    expect(looksLikeMaterial(line, GS)).toBe(false);
  });

  it('two phones on a long line, or goods on it, stay material', () => {
    expect(
      parseClientHint('Abdulloh aka Toshkent Chilonzor 9-kvartal dokoni +998 90 123 45 67, 93 555 12 34', GS),
    ).toBeNull();
    expect(looksLikeMaterial('Abdulloh aka Toshkent Chilonzor dokoni, kurtka 300 dona, +998 90 123 45 67', GS)).toBe(
      true,
    );
  });
});

describe('T6 / T12 — real products named like a field or a carton are goods again', () => {
  it('unlabelled and labelled', () => {
    for (const [line, name] of [
      ['Telefon 300 dona', 'Telefon'],
      ['Телефон 500 шт', 'Телефон'],
      ['Telefon 300 dona 150 kg', 'Telefon'],
      ['Tovar: Telefon 300 dona', 'Telefon'],
      ['Korobka 1000 dona', 'Korobka'],
      ['Коробка 1000 шт', 'Коробка'],
      ['Qop 500 dona', 'Qop'],
      ['Karobka 1000 dona', 'Karobka'],
      ['Tovar: korobka 1000 dona', 'korobka'],
      ['LED32 100 dona', 'LED32'],
    ] as const) {
      expect(names(line), line).toEqual([name]);
    }
    // The list judges UNLABELLED lines only: «Total» is a motor oil when a
    // label names it, and a total when nothing does.
    expect(names('Tovar: Total 200 litr')).toEqual(['Total']);
    expect(names('Total 200 litr')).toEqual([]);
  });

  it('a carton count is still not a product: its only figure, or a carton field', () => {
    for (const not of ['Мест: 45', 'Kurtka 45 karobka', 'Karobka: 45 ta', 'Коробок: 45 шт', 'Tel 90 123 45 67']) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
    // A client code beside totals is still not a product.
    expect(readGoodsLines('Mijoz GS777 12 kub 3500 kg')).toEqual([]);
  });
});

describe('T7 — a goods label names the goods only when what follows is a product', () => {
  it('a status, a time or a variety count under «Tovar:» is chat', () => {
    for (const not of [
      'Tovar: tayyor',
      'Товар: готов',
      'Tovar: keldi',
      'Tovar: qachon keladi',
      'Tovar: rasmi bor',
      'Mahsulot: 5 kun ichida',
      'Tovar: 3 xil',
      'Tovar: kurtka',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
      expect(readGoodsLines(not, { labelledOnly: true }), not).toEqual([]);
    }
  });

  it('a naming label takes a bare name; a list with no figures goes to the model, never welded', () => {
    expect(names('Tovar nomi: shim')).toEqual(['shim']);
    expect(names('Наименование: куртка женская', { labelledOnly: true })).toEqual(['куртка женская']);
    expect(names('Название: iPhone 15 Pro')).toEqual(['iPhone 15 Pro']);
    expect(names('Product name: LED lamp')).toEqual(['LED lamp']);
    expect(names('品名: 外套')).toEqual(['外套']);
    for (const list of ['Mahsulotlar: shim, kurtka', 'Tovar nomi: shim, kurtka', 'Наименование: шорты; куртки']) {
      expect(readGoodsLines(list), list).toEqual([]);
    }
  });

  it('under a plain label a product with its figure still reads', () => {
    expect(names('Tovar: Kurtka 300 dona')).toEqual(['Kurtka']);
    expect(names('Товар - куртка 300 шт', { labelledOnly: true })).toEqual(['куртка']);
    expect(names('Tovar: Kurtka 6201930000')).toEqual(['Kurtka']);
  });
});

describe('T11 — a name and its TNVED code is a goods line', () => {
  it('ten digits, printed, dotted or labelled', () => {
    for (const line of ['Kurtka 6201930000', 'Kurtka 6201.93.00.00', 'Kurtka tnved 6201930000', 'Kurtka 6201 93 000 0']) {
      expect(readGoodsLines(line), line).toEqual([
        expect.objectContaining({ name: 'Kurtka', tnvedCode: '6201930000', quantity: null }),
      ]);
    }
  });

  it('the two readers agree', () => {
    expect(statesGoods('Kurtka 6201930000')).toBe(true);
    expect(looksLikeMaterial('Kurtka 6201930000')).toBe(true);
  });

  it('a field word beside ten digits is a number, not a product', () => {
    for (const not of ['Tel 8901234567', 'Telefon 8901234567', 'Mening raqamim 8901234567', 'Zakaz 1234567890']) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });
});

describe('T1 / T8 — with the model down, a totals line is never a product', () => {
  const totals = [
    'Andijonga 5 kub 1200 kg',
    'Xitoydan 12 kub 3500 kg',
    'Toshkentga 12 kub',
    'Hayrli kun, 12 kub 3500 kg',
    'Assalomu aleykum, 12 kub 3500 kg',
    'Hello 12 cbm 3500 kg',
    'Добрый день, 12 кубов 3500 кг',
    'Yukimiz 12 kub 3500 kg',
    'Yuk 12 kub',
    'Yana 5 kub',
    'Guangzhou-Toshkent 12 kub 3500 kg',
    'Yiwudan Andijonga 5 kub',
    'Xitoydan kelgan yuk 12 kub',
    "O'g'irligi 3500 kg",
    'Oʻgʻirligi 3500 kg',
    '总重量 3500 kg',
    'Из Китая 12 кубов',
  ];

  it('every spelling, unlabelled and labelled-only', () => {
    for (const not of totals) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });

  it('the checklist still asks for the product, and nothing lands as an item', () => {
    for (const not of totals) {
      const facts = parseManualFacts(`Guangzhou → Toshkent\n${not}`);
      expect(missingFields('yolkira', facts, noLaws), not).toContain('goods');
      expect(landingItems(facts), not).toEqual([]);
    }
  });

  it('a product with only a weight or a volume is still a product', () => {
    expect(readGoodsLines('Kurtka 150 kg')).toEqual([expect.objectContaining({ name: 'Kurtka', weightKg: 150 })]);
    expect(readGoodsLines('Kafel 120 m2')).toEqual([
      expect.objectContaining({ name: 'Kafel', measureUnit: 'm2', measureQty: 120 }),
    ]);
    expect(readGoodsLines('Kafel 12 kub')).toEqual([expect.objectContaining({ name: 'Kafel', volumeM3: 12 })]);
    expect(names('Chemodan 150 kg\nOsh tuzi 500 kg\nCoca-Cola 300 dona')).toEqual(['Chemodan', 'Osh tuzi', 'Coca-Cola']);
  });
});

describe('T13 — the chat door’s advice follows the reason', () => {
  it('too big asks for less; a dead key or a refusal asks the admin; a blip asks for later', () => {
    expect(threadAiAdvice('truncated')).toBe('smaller');
    expect(threadAiAdvice('rejected')).toBe('smaller');
    for (const f of ['not_configured', 'auth', 'refused', 'budget'] as const) expect(threadAiAdvice(f), f).toBe('admin');
    for (const f of ['timeout', 'network', 'rate_limited', 'overloaded', 'unreadable'] as const) {
      expect(threadAiAdvice(f), f).toBe('retry');
    }
    expect(threadAiAdvice(null)).toBeNull();
    expect(threadAiAdvice('nothing_to_read')).toBeNull();
  });

  it('the preview carries it and the island words all three, in every bundle', () => {
    expect(read('src/modules/wms/calc/from-thread.ts')).toContain(
      'aiAdvice: threadAiAdvice(outcome.ok ? null : outcome.failure)',
    );
    const island = read('src/components/thread-calc.tsx');
    expect(island).toContain("preview.aiAdvice === 'retry'");
    expect(island).toContain("t('threadAiRetry')");
    expect(island).toContain("preview.aiAdvice === 'smaller'");
    expect(island).toContain("t('threadAiTooBig')");
    expect(island).toContain("t('threadAiNoRetry')");
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const calc = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).calc as Record<string, string>;
      expect(calc.threadAiTooBig, locale).toBeTruthy();
      expect(calc.threadAiTooBig, locale).not.toBe(calc.threadAiNoRetry);
    }
  });
});
