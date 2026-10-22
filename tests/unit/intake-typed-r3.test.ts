import { describe, expect, it } from 'vitest';
import { landingItems, missingFields, parseClientHint, statesGoods } from '@/modules/wms/calc/intake';
import { looksLikeMaterial, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { codeIn, parseGoodsLine } from '@/modules/wms/calc/units';
import type { NeedLaw } from '@/modules/wms/calc/needs';

/**
 * The THIRD review of Sakkiz band round 1's typed half (2026-10-21,
 * R3-T1…T11). Every string here is one a reviewer typed into the shipped code;
 * the lead's decisions on the conflicting ones are in each block's comment.
 */

const noLaws: ReadonlyMap<string, NeedLaw> = new Map();
const names = (text: string, opts?: { labelledOnly?: boolean }) => readGoodsLines(text, opts).map((g) => g.name);
const GS = { prefix: 'GS' };

describe('R3-T1 — a label with no separator is read with the word list', () => {
  const totals = [
    'Tovar vazni 1200 kg',
    'Tovar hajmi 8 kub',
    'Tovar soni 300 dona',
    "Tovar og'irligi 1200 kg",
    'Товар вес 3500 кг',
    'Товар кол-во 300 шт',
    'Tovarlar vazni 1200 kg',
    'Mahsulot hajmi 3 kub',
    'Tovar umumiy vazni 1200 kg',
    'Products weight 1200 kg',
    'Goods volume 12 m3',
    'Tovar salom 5 kub',
  ];

  it('a total about the goods is never a product, with or without labelledOnly', () => {
    for (const line of totals) {
      expect(readGoodsLines(line), line).toEqual([]);
      expect(readGoodsLines(line, { labelledOnly: true }), line).toEqual([]);
    }
  });

  it('the card gets no invented rows', () => {
    const facts = parseManualFacts('Kurtka 300 dona\nTovar vazni 1200 kg\nTovar hajmi 8 kub');
    expect(landingItems(facts).map((i) => i.name)).toEqual(['Kurtka']);
  });

  it('his screenshot line still reads — none of its words is on the list', () => {
    const line = 'Tovar синтетическое компрессорное масло 1.1 kub 240 kg';
    for (const opts of [undefined, { labelledOnly: true }]) {
      expect(readGoodsLines(line, opts)).toEqual([
        expect.objectContaining({ name: 'синтетическое компрессорное масло', weightKg: 240, volumeM3: 1.1 }),
      ]);
    }
    expect(names('Tovar: Telefon 300 dona')).toEqual(['Telefon']);
    expect(names('Tovar: korobka 1000 dona')).toEqual(['korobka']);
    expect(names('Tovar: Total 200 litr')).toEqual(['Total']);
  });
});

describe('R3-T2 — a plain label over a bare name is the product', () => {
  it('a figure-less body is the name, model down or labelled-only', () => {
    for (const [line, name] of [
      ['Tovar: kurtka', 'kurtka'],
      ['Товар: куртка', 'куртка'],
      ['Tovar - kurtka', 'kurtka'],
      ['Tovar: ayollar kurtkasi', 'ayollar kurtkasi'],
      ['Goods: jackets', 'jackets'],
      ['Tovar: Ayollar kurtkasi va bolalar kiyimi', 'Ayollar kurtkasi va bolalar kiyimi'],
    ] as const) {
      expect(names(line), line).toEqual([name]);
      expect(names(line, { labelledOnly: true }), line).toEqual([name]);
    }
  });

  it('the block form reads its name, and the checklist stops asking for goods', () => {
    const uz = 'Tovar: kurtka\nSoni: 300 dona\nVazni: 150 kg\nHajmi: 3 kub';
    expect(names(uz)).toEqual(['kurtka']);
    expect(names('Товар: куртка женская\nКол-во: 300 шт\nВес: 150 кг')).toEqual(['куртка женская']);
    expect(missingFields('rastamojka', parseManualFacts(uz), noLaws)).not.toContain('goods');
  });

  it('a status, a time or a body opening with a number is still chat', () => {
    for (const not of [
      'Tovar: tayyor',
      'Товар: готов',
      'Tovar: keldi',
      'Tovar: qachon keladi',
      'Tovar: rasmi bor',
      'Mahsulot: 5 kun ichida',
      'Tovar: 3 xil',
      "Tovar: yo'q",
      "Tovar: jo'natildi",
      'Tovar: yana',
      'Товар: пришёл',
      'Товар: отправлен',
      'Goods: shipped',
      'Product: ready',
      'Tovar: 2-partiyada',
      'Tovar: Ali akaga berildi',
      'Товар: загружен',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
    // The stop-list takes a word's case endings, never a longer word.
    expect(names('Tovar: kungaboqar yog‘i')).toEqual(['kungaboqar yog‘i']);
  });

  it('a bare number in a figure-less body is part of the name, never a count', () => {
    expect(readGoodsLines('Tovar: Kurtka 1200')).toEqual([
      expect.objectContaining({ name: 'Kurtka 1200', quantity: null }),
    ]);
    expect(readGoodsLines('Название: iPhone 15')).toEqual([
      expect.objectContaining({ name: 'iPhone 15', quantity: null }),
    ]);
    // A unit still makes it a figure.
    expect(readGoodsLines('Tovar: Kurtka 1200 dona')).toEqual([
      expect.objectContaining({ name: 'Kurtka', quantity: 1200 }),
    ]);
  });

  it('a list splits under a plural label and stays whole under a singular or naming one', () => {
    expect(names('Mahsulotlar: shim, kurtka')).toEqual(['shim', 'kurtka']);
    expect(names('Товары: куртки, обувь')).toEqual(['куртки', 'обувь']);
    expect(names('Наименование: Куртка женская, зимняя')).toEqual(['Куртка женская, зимняя']);
    expect(names('Tovar: kurtka, shim')).toEqual(['kurtka, shim']);
    // Re-anchored (round 4, T-r1 ND4 fix): a FIGURED list under a plural
    // label splits too, each piece read as a line of its own.
    expect(readGoodsLines('Tovarlar: Kurtka 300 dona 150 kg, Shim 200 dona')).toEqual([
      expect.objectContaining({ name: 'Kurtka', quantity: 300, weightKg: 150 }),
      expect.objectContaining({ name: 'Shim', quantity: 200, weightKg: null }),
    ]);
  });

  it('a line opening with a goods label is material, never the customer', () => {
    for (const text of [
      'Tovar: kurtka',
      'Tovar: kurtka, shim',
      'Товар: куртка женская',
      'Tovar nomi: Kurtka, shim',
      'Mahsulotlar: shim, kurtka',
      'Товар - куртка',
      'Goods: jackets',
      'Tovar: Ayollar kurtkasi va bolalar kiyimi',
    ]) {
      expect(looksLikeMaterial(text, GS), text).toBe(true);
    }
    // …by its label, even where the body is not a product: it is about the
    // goods, and no customer is called «Tovar: tayyor».
    for (const text of ['Tovar: tayyor', 'Tovar: 3 xil', 'Товар: готов']) {
      expect(readGoodsLines(text), text).toEqual([]);
      expect(looksLikeMaterial(text, GS), text).toBe(true);
    }
    // A word that merely starts like the label is not one.
    expect(looksLikeMaterial('Tovarchi Bobur', GS)).toBe(false);
  });
});

describe('R3-T3 — a carton count is not a product', () => {
  it('a carton noun beside a count or total word', () => {
    for (const not of [
      'Karobka soni 45 ta',
      'Karobka soni: 45 ta',
      'Количество коробок 45 шт',
      'Jami karobka 45 ta',
      'Umumiy karobka 45 dona',
      'Qop soni 20 ta',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });

  it('a carton-only line gives way to the real product, which keeps the derived weight', () => {
    const facts = parseManualFacts('Kurtka 300 dona\nKarobka soni 45 ta\nJami 150 kg');
    expect(landingItems(facts)).toEqual([expect.objectContaining({ name: 'Kurtka', quantity: 300, weightKg: 150 })]);
    for (const text of ['Kurtka 300 dona\nKarobka 45 ta\nVazni 150 kg', 'Kurtka 300 dona\nКоробок 45 шт']) {
      expect(names(text), text).toEqual(['Kurtka']);
    }
    expect(names('Krossovka 200 juft\nQop 20 ta')).toEqual(['Krossovka']);
  });

  it('boxes for sale are still boxes: alone, or labelled', () => {
    expect(names('Korobka 1000 dona')).toEqual(['Korobka']);
    expect(names('Kurtka 300 dona\nTovar: korobka 1000 dona')).toEqual(['Kurtka', 'korobka']);
  });
});

describe('R3-T4 — a name and ten bare digits that are a phone or an order is not a goods line', () => {
  it('refused: a run opening 89, a person, contact or document word, a run with no heading', () => {
    for (const not of [
      'Murod aka 8901234567',
      'Ali 8901234567',
      'Ali aka 8901234567',
      'Bobur aka 9012345678',
      'Murojaat uchun 8901234567',
      'Buyurtma 1234567890',
      'Shartnoma 2026100001',
      'Ali 9100123456',
      'Ali 9912345678',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
    const facts = parseManualFacts('Ayollar kurtkasi 6201930000 300 dona\nMurod aka 8901234567');
    expect(landingItems(facts).map((i) => i.name)).toEqual(['Ayollar kurtkasi']);
  });

  it('kept: the commonest codes of this cargo, and every written or labelled form', () => {
    for (const [line, code] of [
      ['Kurtka 6201930000', '6201930000'],
      ['Mebel 9403600000', '9403600000'],
      ["O'yinchoq 9503007000", '9503007000'],
      ['Nasos 8413708100', '8413708100'],
      ['Kurtka tnved 8901234567', '8901234567'],
      ['Kema 8901.10.10.00', '8901101000'],
      ['Kurtka 6201.93.00.00', '6201930000'],
    ] as const) {
      expect(readGoodsLines(line), line).toEqual([expect.objectContaining({ tnvedCode: code })]);
    }
  });

  it('the residue, stated: a Russian mobile after a bare first name reads as a heading', () => {
    expect(names('Иван 9161234567')).toEqual(['Иван']);
  });
});

describe('R3-T5 — a row of plain numbers is not a printed code', () => {
  it('the first group is a real heading, and a spaced code is not followed by another bare number', () => {
    for (const line of ['Kurtka 1500 30 2400 12.5', 'Kurtka 1200 50 3000', 'Futbolka 2000 10 5000', 'Kurtka 1250 50 3000 12.5']) {
      expect(parseGoodsLine(line).tnvedCode, line).toBeNull();
      expect(statesGoods(line), line).toBe(false);
    }
    // The dotted and spaced 4-2-2 form obeys the same heading rule.
    expect(codeIn('Kurtka 1200 50 30')).toBeNull();
  });

  it('the printed forms still read', () => {
    for (const [line, code] of [
      ['Kurtka 6201.93.0000 300', '6201930000'],
      ['Kurtka 6201 93 0000', '6201930000'],
      ['Kurtka 6201 93 000 0', '6201930000'],
      ['Масло 2710 19 820 0', '2710198200'],
      ['Kurtka 6201 93 0000 300 dona', '6201930000'],
      ['Kurtka 6907 21 00 00', '6907210000'],
    ] as const) {
      expect(parseGoodsLine(line).tnvedCode, line).toBe(code);
    }
  });

  it('a row of plain figures is still material at the customer question, never a name', () => {
    for (const line of ['Kurtka 1200 50 3000', 'Futbolka 2000 10 5000', 'Kurtka 1500 30 2400 12.5']) {
      expect(parseClientHint(line, GS), line).toBeNull();
      expect(looksLikeMaterial(line, GS), line).toBe(true);
    }
    // A name carries one number at most.
    for (const name of ['OOO Asia Trade 2020', 'Ali aka 2']) expect(looksLikeMaterial(name, GS), name).toBe(false);
  });

  // Re-anchored (round 4): the residue round 3 stated is closed by the book's
  // own last heading per chapter — chapter 12 ends at 1214, so «1250» opens no
  // heading (R3-T5 names this very line as a row of figures).
  it('a row opening with a heading the book does not have is no code either', () => {
    expect(parseGoodsLine('Ayollar kurtkasi 1250 50 3000').tnvedCode).toBeNull();
    expect(parseGoodsLine('Kurtka 6201 93 0000').tnvedCode).toBe('6201930000');
  });
});

describe('R3-T6 — a request paragraph signed with a phone is material', () => {
  it('a greeting, a request word, a sentence or many words refuse the long branch', () => {
    for (const text of [
      'Здравствуйте, нужно растаможить куртки и обувь из Китая, мой номер +998 90 123 45 67',
      'Salom, bizga kurtka va shimlar keladi, iltimos hisoblab bering, tel 90 123 45 67',
      'Assalomu alaykum, Yiwudan kurtka va krossovkalar olib kelmoqchimiz, narxi qancha bo‘ladi. +998 90 123 45 67',
    ]) {
      expect(text.length).toBeGreaterThan(60);
      expect(parseClientHint(text, GS), text).toBeNull();
      expect(looksLikeMaterial(text, GS), text).toBe(true);
    }
  });

  it('a long line never names a code beside its phone', () => {
    const brother = 'Bu mijoz GS777 ning akasi, Chilonzor bozorida do‘koni bor, telefoni 90 123 45 67';
    expect(parseClientHint(brother, GS)?.code).toBeUndefined();
    // Contact-shaped, and still only the phone: past sixty characters a code
    // beside it is somebody's relation as often as the customer.
    const shop = 'Bobur aka GS777 Toshkent Chilonzor bozori 15-dokon +998 90 123 45 67';
    expect(shop.length).toBeGreaterThan(60);
    expect(parseClientHint(shop, GS)).toEqual({ phone: '+998 90 123 45 67' });
  });

  it('a long contact with an address is still the customer', () => {
    const line = 'Abdulloh aka Toshkent Chilonzor 9-kvartal dokoni +998 90 123 45 67';
    expect(parseClientHint(line, GS)).toEqual({ phone: '+998 90 123 45 67' });
    expect(looksLikeMaterial(line, GS)).toBe(false);
  });
});

describe('R3-T7 — a client label and digits is the company’s code', () => {
  it('completed with the prefix, and never material', () => {
    for (const [text, code] of [
      ['Mijoz 777', 'GS777'],
      ['Kod 777', 'GS777'],
      ['Klient 1234', 'GS1234'],
      ['Mijoz: 777', 'GS777'],
    ] as const) {
      expect(parseClientHint(text, GS), text).toEqual({ code });
      expect(looksLikeMaterial(text, GS), text).toBe(false);
    }
    // …and before a phone, as the prefix is (R3-T11).
    expect(parseClientHint('Mijoz 777 90 123 45 67', GS)).toEqual({ code: 'GS777', phone: '90 123 45 67' });
    // A label before a phone alone is no code.
    expect(parseClientHint('Mijoz 90 123 45 67', GS)).toEqual({ phone: '90 123 45 67' });
  });

  // Re-anchored (round 4, integration S-e): a company with no prefix mints
  // codes that ARE the digits, so the label names its code — null left
  // «Ali aka\nMijoz 777» no way to become the customer.
  it('with no prefix the digits are the code, and still not goods', () => {
    expect(parseClientHint('Mijoz 777', { prefix: null })).toEqual({ code: '777' });
    expect(parseClientHint('Ali aka\nMijoz 777', { prefix: null })).toEqual({ code: '777' });
    expect(parseClientHint('777', { prefix: null })).toBeNull();
    expect(looksLikeMaterial('Mijoz 777', { prefix: null })).toBe(false);
    // …and a product with its count stays material.
    expect(looksLikeMaterial('Shim 200', { prefix: null })).toBe(true);
  });
});

describe('R3-T8 — one chat word makes a figures-only line chat', () => {
  it('model down, every spelling', () => {
    for (const not of [
      'Salom aka, 12 kub 3500 kg',
      'Iltimos 12 kub 3500 kg',
      'Rahmat 12 kub',
      'Hisoblab bering 12 kub',
      'Bugun 5 kub',
      'Ertaga 5 kub',
      'Bizning yuk 12 kub',
      'Наш груз 12 куб',
      'Toshkent shahriga 12 kub',
      '重量：3500 kg',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });

  it('a vehicle or a place in a product’s name is still a product', () => {
    expect(names('Mashina moyi 1200 kg')).toEqual(['Mashina moyi']);
    expect(names('Andijon olmasi 500 kg')).toEqual(['Andijon olmasi']);
    // «yuk» before «mashina» is a truck: truck tyres.
    expect(names('Yuk mashina shinasi 150 kg')).toEqual(['Yuk mashina shinasi']);
    // A count keeps the line a goods line whatever else it says.
    expect(names('Kurtka 300 dona')).toEqual(['Kurtka']);
  });
});

describe('R3-T9 — with a prefix, capitals beside a word are a model, not a client code', () => {
  const models = [
    'Televizor LG55',
    'Printer HP400',
    'Samsung QE55',
    'Samsung SM54',
    'Lampa LED32',
    'Kurtka XL5',
    'Truba PPR20',
    'Nike AF1',
    'Bobur ABC777',
    'Kurtka\nLG55',
  ];

  it('never a code, and filed as material', () => {
    for (const text of models) {
      expect(parseClientHint(text, GS), text).toBeNull();
      expect(looksLikeMaterial(text, GS), text).toBe(true);
    }
  });

  it('other capitals stay a code alone or labelled; the prefix stays a code anywhere', () => {
    expect(parseClientHint('AB 123', GS)).toEqual({ code: 'AB123' });
    expect(parseClientHint('AB123', GS)).toEqual({ code: 'AB123' });
    expect(parseClientHint('Mijoz: AB123', GS)).toEqual({ code: 'AB123' });
    expect(parseClientHint('Ali aka\nMijoz: AB123', GS)).toEqual({ code: 'AB123' });
    expect(parseClientHint('Ali aka\nAB 123', GS)).toBeNull();
    expect(parseClientHint('Bobur aka GS777', GS)).toEqual({ code: 'GS777' });
    expect(parseClientHint('Bobur aka\nGS777', GS)).toEqual({ code: 'GS777' });
    // A company with no prefix keeps the capitals rule.
    expect(parseClientHint('Bobur AB123', { prefix: null })).toEqual({ code: 'AB123' });
  });
});

describe('R3-T10 — a stall number of two digits after the phone is not part of it', () => {
  it('a word follows, the head is a whole number and the whole run is not', () => {
    for (const [line, phone] of [
      ['Ali 90 123 45 67 12 rasta', '90 123 45 67'],
      ['+998 90 123 45 67 12 rasta', '+998 90 123 45 67'],
      ['Ali 90 123 45 67 15 rasta 3 qator', '90 123 45 67'],
    ] as const) {
      expect(parseClientHint(line, GS), line).toEqual({ phone });
    }
  });

  it('a whole international or trunk number keeps its last group', () => {
    for (const [line, phone] of [
      ['998 90 123 45 67 Ali', '998 90 123 45 67'],
      ['+7 701 234 56 78 Ivan', '+7 701 234 56 78'],
      ['8 90 123 45 67 Ali', '8 90 123 45 67'],
      ['+86 138 1234 5678 Wang', '+86 138 1234 5678'],
    ] as const) {
      expect(parseClientHint(line, GS), line).toEqual({ phone });
    }
  });
});

describe('R3-T11 — the prefix written apart before the phone is the code', () => {
  it('found and masked before the phone is read', () => {
    for (const [line, phone] of [
      ['GS 777 90 123 45 67', '90 123 45 67'],
      ['Bobur aka GS 777 90 123 45 67', '90 123 45 67'],
      ['Mijoz GS 777 90 123 45 67', '90 123 45 67'],
      ['GS-777 90 123 45 67', '90 123 45 67'],
      ['GS 777 901234567', '901234567'],
      ['GS 777 (90) 123-45-67', '(90) 123-45-67'],
      ['Bobur\nGS 777 90 123 45 67', '90 123 45 67'],
    ] as const) {
      expect(parseClientHint(line, GS), line).toEqual({ code: 'GS777', phone });
      expect(looksLikeMaterial(line, GS), line).toBe(false);
    }
  });
});
