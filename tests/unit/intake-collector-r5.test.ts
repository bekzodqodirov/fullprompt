import { describe, expect, it } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';

/**
 * The «Hisoblatish» collector after the round-4 probers (the regression
 * corpus's c2000-c2027, tests/unit/intake-corpus.test.ts): what the rules that
 * fixed them reach PAST the corpus — a contact word stays the phone's label
 * whenever it is WRITTEN as one, an apostrophe inside a word on both sides of
 * a cut and in a contact line, a bracket around the digits only when it
 * closes, a bilingual cell's half met only where a translation stands, and a
 * word with two figures insisted on as the customer.
 */
import { intakeClientLabel, pickGoods } from '@/modules/platform/telegram/calc-intake';
import { readCustomerText } from '@/modules/platform/telegram/staff-handlers';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });
const phone = { phone: '90 123 45 67' };

describe('the lead’s name: a contact word is the phone’s label when written as one', () => {
  it('lower case, short, with its mark, or beside a lower-case word — cut with the phone', () => {
    expect(intakeClientLabel('Rustam telefon 90 123 45 67', phone)).toBe('Rustam');
    expect(intakeClientLabel('Ali Tel 90 123 45 67', phone)).toBe('Ali');
    expect(intakeClientLabel('Rustam Telefon: 90 123 45 67', phone)).toBe('Rustam');
    expect(intakeClientLabel('Ali aka Telefon 90 123 45 67', phone)).toBe('Ali aka');
  });

  it('a shop’s own word stays beside a label that goes', () => {
    expect(intakeClientLabel('Smart Mobile, tel: 90 123 45 67', phone)).toBe('Smart Mobile');
  });

  it('an apostrophe inside a word: never cut at its head, and never a contact line of two words', () => {
    expect(intakeClientLabel("GS777 No'mon", { code: 'GS777' })).toBe("No'mon");
    expect(intakeClientLabel("Rustam\nVa'no GS777", { code: 'GS777' })).toBe("Rustam Va'no GS777");
  });

  it('a bracket is the phone’s only when it closes around the first digits', () => {
    expect(intakeClientLabel('Rustam (90 123 45 67)', phone)).toBe('Rustam');
    expect(intakeClientLabel('Rustam (90) 123 45 67, (91) 234-56-78', phone)).toBe('Rustam');
  });

  it('«Код клиента» is the code’s label on one line too', () => {
    expect(intakeClientLabel('Код клиента: 777', { code: 'GS777' })).toBe('GS777');
  });
});

describe('a bilingual Excel cell is met through a half only where a translation stands', () => {
  const add = (invoice: Goods, extra: Goods) => pickGoods({ invoice, aiGoods: 'add', model: extra, typed: [], typedLabelled: [] });

  it('an outside is not a half: «Ladies jacket (XL)» is a size of it, as «Kurtka (oq)» is a colour', () => {
    const picked = add([line('女士夹克 Ladies jacket', { quantity: 300 })], [line('Ladies jacket (XL)', { quantity: 300 })]);
    expect(picked.goods.map((g) => g.name)).toEqual(['女士夹克 Ladies jacket', 'Ladies jacket (XL)']);
  });

  it('the bracket meets — unless the outside is another name in the other half’s script', () => {
    const cell = [line('女士夹克 Ladies jacket', { quantity: 300 })];
    expect(add(cell, [line('Ladies jacket (女士夹克)', { quantity: 300 })]).goods).toHaveLength(1);
    expect(add(cell, [line('Women jacket (女士夹克)', { quantity: 300 })]).goods).toHaveLength(2);
  });

  it('a bare name meets the cell from either side', () => {
    const picked = add([line('Kurtka', { quantity: 100 })], [line('Kurtka 黑色', { quantity: 100 })]);
    expect(picked.goods.map((g) => g.name)).toEqual(['Kurtka']);
    expect(picked.sameAsInvoice.map((g) => g.name)).toEqual(['Kurtka 黑色']);
  });
});

describe('the customer question: a word and two figures may be insisted on', () => {
  it('two figures could be a customer; three are a packing-list row', async () => {
    expect((await readCustomerText('Kurtka 1200 50', 'GS')).couldBeCustomer).toBe(true);
    expect((await readCustomerText('Kurtka 1200 50 30', 'GS')).couldBeCustomer).toBe(false);
  });
});
