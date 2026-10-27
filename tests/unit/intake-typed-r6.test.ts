import { describe, expect, it } from 'vitest';
import { parseClientHint, statesGoods } from '@/modules/wms/calc/intake';
import { figureRow, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * Round 6 of the typed readers — the round-5 probers' regressions — where the
 * rule reaches past the cases the regression corpus (fixtures/intake-corpus.ts)
 * pins: the corpus says what each prober's input must read; these say what
 * each narrowed rule must still refuse, and what it must not reach.
 */
const GS = { prefix: 'GS' };
const names = (text: string) => readGoodsLines(text).map((g) => g.name);
const codes = (text: string) => readGoodsLines(text).map((g) => [g.name, g.tnvedCode]);

describe('a status sentence under a goods label', () => {
  it('names no product in any of the four languages, however it is worded', () => {
    expect(names('Товар: скину вечером')).toEqual([]);
    expect(names('Товар: сейчас скину фото')).toEqual([]);
    expect(names('Наименование: согласно спецификации')).toEqual([]);
    expect(names('Товар: эртага айтаман')).toEqual([]);
    expect(names('Tovar: invoysga qarang')).toEqual([]);
    expect(names('Goods: TBA')).toEqual([]);
    expect(names('Goods: will confirm later')).toEqual([]);
  });

  it('says it in Chinese with no space to split by', () => {
    expect(names('品名: 见附件')).toEqual([]);
    expect(names('品名: 待定')).toEqual([]);
    expect(names('品名: 手机壳')).toEqual(['手机壳']);
  });

  it('keeps the product whose name has one noun among the status words', () => {
    expect(names('Наименование: Рамка для фото')).toEqual(['Рамка для фото']);
    expect(names('Товар: Скинали кухонные')).toEqual(['Скинали кухонные']);
    expect(names('Tovar: Shokoladi')).toEqual(['Shokoladi']);
    expect(names('Goods: Photo frames')).toEqual(['Photo frames']);
  });

  it('reads a finite verb only where it ends a sentence; alone its ending is a noun’s', () => {
    expect(names('Tovar: kecha yubordik')).toEqual([]);
    expect(names('Tovar: ertaga yuboramiz')).toEqual([]);
    expect(names('Товар: Бодик')).toEqual(['Бодик']);
    expect(names('Tovar: Sandik')).toEqual(['Sandik']);
  });
});

describe('a contact word before a TNVED code', () => {
  it('in an Uzbek case before a noun says what the product is for, or whose part it is', () => {
    expect(codes('Telefonning chexoli 4202320000')).toEqual([['Telefonning chexoli', '4202320000']]);
    expect(codes('Телефонга чехол 4202320000')).toEqual([['Телефонга чехол', '4202320000']]);
  });

  it('before a verb is still where the number goes, a Russian one too', () => {
    expect(codes('Shu raqamga yozing 9161234567')).toEqual([]);
    expect(codes('Telefonga qo‘ng‘iroq qiling 9161234567')).toEqual([]);
    expect(codes('Telefoningizga yozing 9161234567')).toEqual([]);
    expect(codes('Телефонга звонить 9161234567')).toEqual([]);
  });

  it('is never a raqam or a nomer, which has no parts and is for nothing, nor a phone the number is from', () => {
    expect(codes('Raqamga Rustam 9161234567')).toEqual([]);
    expect(codes('Nomerdan Ali 9161234567')).toEqual([]);
    expect(codes('Telefondan Ali 9161234567')).toEqual([]);
    expect(codes('Номерга звонить 9161234567')).toEqual([]);
  });

  it('names the phone’s owner, a person, and so does any owner beside ten digits', () => {
    expect(codes('Telefonning egasi Ali 9161234567')).toEqual([]);
    expect(codes('Uy egasi 9161234567')).toEqual([]);
  });

  it('after a hyphen is the product the word names; before one it is the document', () => {
    expect(codes('Radio-telefon 8517130000')).toEqual([['Radio-telefon', '8517130000']]);
    expect(codes('Номер-телефон 9161234567')).toEqual([]);
  });
});

describe('an address line beside the phone', () => {
  it('may carry a shop or office number of up to four digits', () => {
    expect(parseClientHint('Rustam\nOfis 112\n90 123 45 67', GS)).toEqual({ phone: '90 123 45 67' });
    expect(parseClientHint('Ali aka\nIppodrom 45\n+998 90 123 45 67', GS)).toEqual({ phone: '+998 90 123 45 67' });
  });

  it('is told apart from a goods line by its word, never by its digits', () => {
    expect(parseClientHint('Rustam\nKurtka 20\n90 123 45 67', GS)).toBeNull();
    expect(parseClientHint('Ali aka\nDo‘kon 12034\n+998 90 123 45 67', GS)).toBeNull();
  });

  it('knows the address word in its possessive', () => {
    expect(parseClientHint('Ali aka\nBozori 12\n+998 90 123 45 67', GS)).toEqual({ phone: '+998 90 123 45 67' });
  });
});

describe('a long contact line naming the cargo', () => {
  it('names the customer by the role a cargo word opens, or a firm’s capitalised name', () => {
    const owner = 'Владелец груза Алишер Каримов, Ташкент, Чиланзар, +998 90 123 45 67';
    const firm = 'ООО Silk Way Cargo, Ташкент, Юнусабад 4, тел +998 71 200 30 40';
    expect(owner.length).toBeGreaterThan(60);
    expect(firm.length).toBeGreaterThan(60);
    expect(parseClientHint(owner, GS)).toEqual({ phone: '+998 90 123 45 67' });
    expect(parseClientHint(firm, GS)).toEqual({ phone: '+998 71 200 30 40' });
  });

  it('still refuses a message that speaks of the cargo — «qabul qilib oling» is no receiver', () => {
    const request = 'Yukni qabul qilib oling Toshkentda, telefon +998 90 123 45 67';
    const capital = 'Bizda Xitoydan kelayotgan Yuk bor, telefon raqamim +998 90 123 45 67';
    expect(request.length).toBeGreaterThan(60);
    expect(capital.length).toBeGreaterThan(60);
    expect(parseClientHint(request, GS)).toBeNull();
    expect(parseClientHint(capital, GS)).toBeNull();
    expect(parseClientHint('Рустам, Доставка из Китая в Ташкент нужна, тел +998 90 123 45 67', GS)).toBeNull();
  });

  it('never takes a price for a contact’s word, beside a role too', () => {
    const price = 'Yuk egasi narx Rustam aka Andijon shahridan, telefon raqami +998 90 123 45 67';
    expect(price.length).toBeGreaterThan(60);
    expect(parseClientHint(price, GS)).toBeNull();
  });
});

describe('a unit word written as a field', () => {
  it('«kv:» after a house number is the flat; anywhere else it is still square metres', () => {
    expect(statesGoods('Рустам, ул. Навои 12, кв: 45, тел +998 90 123 45 67')).toBe(false);
    expect(statesGoods("Rustam, Navoiy ko'chasi 12, kv: 45, +998 90 123 45 67")).toBe(false);
    expect(parseGoodsLine('Kafel kv: 120')).toMatchObject({ measureUnit: 'm2', measureQty: 120 });
    expect(parseGoodsLine('kv: 45')).toMatchObject({ measureUnit: 'm2', measureQty: 45 });
  });

  it('a product’s own figure before «kv:» is no house number', () => {
    expect(parseGoodsLine('Kafel 12, kv: 45')).toMatchObject({ quantity: 12, measureUnit: 'm2', measureQty: 45 });
    expect(parseGoodsLine('Обои 12; кв: 60')).toMatchObject({ quantity: 12, measureUnit: 'm2', measureQty: 60 });
  });

  it('a singular carton noun after the name is the product; a place count or a plural is the field', () => {
    expect(parseGoodsLine('Un qop: 500')).toMatchObject({ name: 'Un qop', quantity: 500, cartons: null });
    expect(parseGoodsLine('Kurtka CTN: 45')).toMatchObject({ name: 'Kurtka', quantity: null, cartons: 45 });
    expect(parseGoodsLine('Kurtka joy: 12')).toMatchObject({ name: 'Kurtka', cartons: 12 });
    expect(parseGoodsLine('Jackets cartons: 45')).toMatchObject({ name: 'Jackets', cartons: 45 });
    expect(parseGoodsLine('Kurtka, Коробки: 45')).toMatchObject({ name: 'Kurtka', cartons: 45 });
  });

  it('a carton noun set off by a dash or after a total word is the count', () => {
    expect(parseGoodsLine('Kurtka - karobka: 45')).toMatchObject({ quantity: null, cartons: 45 });
    expect(parseGoodsLine('Jami karobka: 45')).toMatchObject({ quantity: null, cartons: 45 });
    // The total in the other script and the spoken Russian (round-6 probe:
    // «Жами коробка: 45» was a product of 45 pieces).
    expect(parseGoodsLine('Ҳаммаси коробка: 45')).toMatchObject({ quantity: null, cartons: 45 });
    expect(parseGoodsLine('Общий коробка: 45')).toMatchObject({ quantity: null, cartons: 45 });
  });

  it('states goods either way, so the product noun never becomes the customer', () => {
    expect(statesGoods('Lunch box: 500')).toBe(true);
    expect(parseClientHint('Pitsa korobka: 5000', GS)).toBeNull();
  });
});

describe('a word and two figures', () => {
  it('is a row when a figure is a decimal or the first is a hundred or more', () => {
    expect(figureRow('Kafel 2400 36,5')).toBe(true);
    expect(figureRow('Futbolka 2000 35')).toBe(true);
  });

  it('is not when the pair is a stall’s small numbers or a phone’s four and four', () => {
    expect(figureRow('Ippodrom 12 115')).toBe(false);
    expect(figureRow('李先生 6688 1234')).toBe(false);
  });

  it('is not when the line names the market, however large its row', () => {
    expect(figureRow('Ippodrom 101 4')).toBe(false);
    expect(figureRow('Chorsu bozori 112 15')).toBe(false);
    expect(figureRow('Abu Saxiy 115 4')).toBe(false);
  });
});
