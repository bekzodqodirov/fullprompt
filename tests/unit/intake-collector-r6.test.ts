import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalcFacts } from '@/modules/wms/calc/intake';
import { intakeClientLabel, pickGoods } from '@/modules/platform/telegram/calc-intake';
import { readCustomerText } from '@/modules/platform/telegram/staff-handlers';

/**
 * The «Hisoblatish» collector after the round-5 probers (the regression
 * corpus's c2077-c2092, tests/unit/intake-corpus.test.ts): what the rules that
 * fixed them reach PAST the corpus — every messenger's name is the phone's
 * label in whatever case it is typed and on whichever side of the number, a
 * capital counts only where the writer chose it but a word hyphened to the
 * name stays the name's, the numbers in a name count however they are
 * written, and which rows the customer question refuses on a repeat is the
 * goods reader's call alone.
 */

// The customer question asks `figureRow` through a dynamic import; the last
// test makes it call one text a row, to show nothing else in the question
// counts figures.
const row = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('@/modules/wms/calc/intake-manual', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/intake-manual')>();
  return { ...real, figureRow: (raw: string) => raw === row.text || real.figureRow(raw) };
});

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });
const phone = { phone: '+998 90 123 45 67' };

describe('the lead’s name: a messenger is the phone’s label, however it is typed', () => {
  it('in Cyrillic, and WeChat beside a Chinese number', () => {
    expect(intakeClientLabel('Алишер Вотсап +998 90 123 45 67', phone)).toBe('Алишер');
    expect(intakeClientLabel('Rustam Телеграм +998 90 123 45 67', phone)).toBe('Rustam');
    expect(intakeClientLabel('Dilshod WeChat +86 138 1234 5678', { phone: '+86 138 1234 5678' })).toBe('Dilshod');
  });

  it('with the keyboard’s capital, and after the number', () => {
    // «Whatsapp» passes the capital-before-lower-case test: only the
    // messenger list sends it with the phone.
    expect(intakeClientLabel('Sardor Whatsapp +998 90 123 45 67', phone)).toBe('Sardor');
    expect(intakeClientLabel('+998 90 123 45 67 WhatsApp Sardor', phone)).toBe('Sardor');
  });
});

describe('the lead’s name: a capital counts only where the writer chose it', () => {
  it('a label in capitals beside a name written in lower case is still the label', () => {
    expect(intakeClientLabel('Sardor TELEFON 90 123 45 67', phone)).toBe('Sardor');
  });

  it('a word hyphened to the name stays the name’s, in capitals too — no label is hyphened', () => {
    expect(intakeClientLabel('UZ-MOBILE +998 90 123 45 67', phone)).toBe('UZ-MOBILE');
    expect(intakeClientLabel('Uz-Mobile +998 90 123 45 67', phone)).toBe('Uz-Mobile');
  });
});

describe('a bilingual Excel cell: two names each have a word — or a number — the other lacks', () => {
  const add = (invoice: Goods, extra: Goods) => pickGoods({ invoice, aiGoods: 'add', model: extra, typed: [], typedLabelled: [] });

  it('a size in other glyphs is the cell read again; another size is another line', () => {
    // The cell writes «*» and «~», the model «×», «х» and «–»: compared as
    // words they were two names (round-6 probe, collector); left out, a 800×800
    // tile met the 600*600 one (the lead's undo, probed). Read as numbers both
    // hold.
    const tile = [line('瓷砖 Ceramic tile 600*600mm', { quantity: 500 })];
    expect(add(tile, [line('Плитка керамическая 600×600 мм (瓷砖)', { quantity: 500 })]).goods).toHaveLength(1);
    expect(add(tile, [line('Плитка керамическая 800×800 мм (瓷砖)', { quantity: 500 })]).goods).toHaveLength(2);
    const shoes = [line('女鞋 Women shoes 36~40', { quantity: 120 })];
    expect(add(shoes, [line('Обувь женская 36–40 (女鞋)', { quantity: 120 })]).goods).toHaveLength(1);
    expect(add(shoes, [line('Обувь женская 41–45 (女鞋)', { quantity: 120 })]).goods).toHaveLength(2);
  });

  it('a model number in a shared script, and «№» against «No.»', () => {
    const cases = [line('手机壳 Phone case iPhone 14', { quantity: 1000 })];
    expect(add(cases, [line('Phone case iPhone 15 (手机壳)', { quantity: 1000 })]).goods).toHaveLength(2);
    const sneakers = [line('运动鞋 Sneakers No.8823', { quantity: 600 })];
    expect(add(sneakers, [line('Кроссовки №8823 (运动鞋)', { quantity: 600 })]).goods).toHaveLength(1);
  });

  it('a model’s tier word after its number is another model, in either script; before it, a description', () => {
    // Two stalls' phone cases: «Чехол iPhone 15» inside «Phone case iPhone 15
    // Pro» was dropped as the same line (round-6 final probe, collector).
    const pro = [line('手机壳 Phone case iPhone 15 Pro', { quantity: 500 })];
    expect(add(pro, [line('Чехол iPhone 15 (手机壳)', { quantity: 500 })]).goods).toHaveLength(2);
    expect(add(pro, [line('Чехол iPhone 15 Про (手机壳)', { quantity: 500 })]).goods).toHaveLength(1);
    const dryer = [line('吹风机 Pro hair dryer 2000W', { quantity: 200 })];
    expect(add(dryer, [line('Фен 2000 Вт (吹风机)', { quantity: 200 })]).goods).toHaveLength(1);
  });

  it('naming MORE of the same in the cell’s script is the cell; another word in its place is not', () => {
    const cell = [line('Kurtka 黑色', { quantity: 100 })];
    expect(add(cell, [line('Kurtka qora (黑色)', { quantity: 100 })]).goods).toHaveLength(1);
    expect(add(cell, [line('Shim qora (黑色)', { quantity: 100 })]).goods).toHaveLength(2);
  });
});

describe('the customer question: which rows refuse the repeat is the goods reader’s alone', () => {
  afterEach(() => {
    row.text = null;
  });

  it('a pair the reader calls a row is refused, with no count of figures of its own', async () => {
    expect((await readCustomerText('Ippodrom 7 230', 'GS')).couldBeCustomer).toBe(true);
    row.text = 'Ippodrom 7 230';
    expect(await readCustomerText('Ippodrom 7 230', 'GS')).toMatchObject({ couldBeCustomer: false, why: 'goods' });
  });
});
