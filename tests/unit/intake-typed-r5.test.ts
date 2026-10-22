import { describe, expect, it } from 'vitest';
import { parseClientHint } from '@/modules/wms/calc/intake';
import { figureRow, looksLikeMaterial, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * Round 5 of the typed readers — the round-4 probers' regressions — where the
 * rule reaches past the cases the regression corpus (fixtures/intake-corpus.ts)
 * pins: the corpus says what each prober's input must read; these say what
 * the narrowed rule must still refuse, and what it must not reach.
 */
const GS = { prefix: 'GS' };
const names = (text: string) => readGoodsLines(text).map((g) => g.name);

describe('a phone typed with its country code glued to the operator’s', () => {
  it('is whole only in the full international form — a short code that opens 998 is still a code and a count', () => {
    expect(parseClientHint('Ali aka +99890 123 45 67', GS)).toEqual({ phone: '+99890 123 45 67' });
    expect(parseClientHint('Kurtka 998123 456', GS)).toBeNull();
  });
});

describe('the company prefix before a phone', () => {
  it('heads a code whatever separates it — only a country code there is the phone’s own head', () => {
    expect(parseClientHint('GS-8 90 123 45 67', GS)).toEqual({ code: 'GS8', phone: '90 123 45 67' });
    expect(parseClientHint('GS 998 90 123 45 67', GS)).toEqual({ phone: '998 90 123 45 67' });
  });
});

describe('a long contact line', () => {
  it('names a child as a relative only after a genitive; after a bare name it is the patronymic', () => {
    const relative = 'Ali aka Toshkent Chilonzor bozori, Boburning o‘g‘li +998 90 123 45 67';
    expect(relative.length).toBeGreaterThan(60);
    expect(parseClientHint(relative, GS)).toBeNull();
    expect(parseClientHint('Rustam Valiyevich o‘g‘li, Toshkent Chilonzor bozori +998 90 123 45 67', GS)).toEqual({
      phone: '+998 90 123 45 67',
    });
  });

  it('that speaks of the cargo or its price is a request, not a contact', () => {
    const cargo = 'Ivan Petrov, Almaty, cargo from Urumqi, my number +7 701 234 56 78';
    const ours = 'Olimjon aka Andijon viloyati Asaka tumani, yuklari bor, +998 90 123 45 67';
    expect(cargo.length).toBeGreaterThan(60);
    expect(ours.length).toBeGreaterThan(60);
    expect(parseClientHint(cargo, GS)).toBeNull();
    expect(parseClientHint(ours, GS)).toBeNull();
  });
});

describe('a name line over a phone', () => {
  it('keeps a person with a small number, refuses ONE word and its count', () => {
    expect(parseClientHint('Ali aka 12\n+998 90 123 45 67', GS)).toEqual({ phone: '+998 90 123 45 67' });
    expect(parseClientHint('Shim 40\nAli aka\n90 123 45 67', GS)).toBeNull();
  });
});

describe('a chat line about the shipment', () => {
  it('reads the request verb in every form, and «how much»', () => {
    expect(names('Hisoblatish 12 kub')).toEqual([]);
    expect(names('Сколько 12 куб')).toEqual([]);
  });

  it('takes the words that only say whose, which or how the cargo is', () => {
    expect(names('Yuk tayyor 12 kub')).toEqual([]);
    expect(names('Груз клиентов 12 куб')).toEqual([]);
    // …and never without a word of the shipment: «my jackets» are jackets.
    expect(names('Mening kurtkam 12 kub')).toEqual(['Mening kurtkam']);
  });

  it('names no variety on its own, while «har xil kiyimlar» is what it is a variety of', () => {
    expect(names('Turli 12 kub')).toEqual([]);
    expect(names('Tovar: har xil kiyimlar')).toEqual(['har xil kiyimlar']);
  });
});

describe('a labelled goods line', () => {
  it('drops the measure fields that labelled its figures from the name', () => {
    expect(readGoodsLines('Товар: куртки 300 шт, вес 500 кг')).toEqual([
      expect.objectContaining({ name: 'куртки', quantity: 300, weightKg: 500 }),
    ]);
  });

  it('refuses a time, a file or a photo standing alone, under either label', () => {
    expect(names('Tovar nomi: ertaga')).toEqual([]);
    expect(names('Tovar: rasmlar')).toEqual([]);
    expect(names('Tovar: Kun kremi')).toEqual(['Kun kremi']);
  });

  it('after a naming label, takes a name that opens with a number and goes on', () => {
    expect(names('Наименование: 2 в 1 шампунь')).toEqual(['2 в 1 шампунь']);
    expect(names('Tovar nomi: 5 litrli suv')).toEqual(['5 litrli suv']);
  });
});

describe('ten bare digits after a contact word', () => {
  it('are a number in the field’s cases and English phrase, a code after a product', () => {
    expect(names('Telefonimga 9161234567')).toEqual([]);
    expect(names('Phone number 9161234567')).toEqual([]);
    expect(readGoodsLines('Mobile phone 8517130000')).toEqual([
      expect.objectContaining({ name: 'Mobile phone', tnvedCode: '8517130000' }),
    ]);
  });
});

describe('the first message', () => {
  it('a comma list naming a place of business is a contact, not a goods list', () => {
    expect(looksLikeMaterial('Ali, Chilonzor, do‘kon', GS)).toBe(false);
    expect(looksLikeMaterial('Kurtka, shim, sharf', GS)).toBe(true);
  });

  it('a word and TWO figures is material, but only three figures refuse a repeat as the customer', () => {
    expect(looksLikeMaterial('Kurtka 1200 50', GS)).toBe(true);
    expect(figureRow('Kurtka 1200 50')).toBe(false);
    expect(figureRow('Kurtka 1200 50 3000')).toBe(true);
  });
});

describe('a unit word written as a field before its number', () => {
  it('routes the number by that word', () => {
    expect(parseGoodsLine('Kg: 150')).toMatchObject({ weightKg: 150, quantity: null });
    expect(parseGoodsLine('Kurtka; Мест: 45; 300 dona')).toMatchObject({ cartons: 45, quantity: 300 });
  });

  it('never a lone letter: «L:» on a clothing line is a size', () => {
    expect(parseGoodsLine('Futbolka L: 50')).toMatchObject({ quantity: 50, measureUnit: null });
  });
});
