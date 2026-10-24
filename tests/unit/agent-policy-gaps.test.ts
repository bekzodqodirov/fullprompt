import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeDigits, unverifiableNumeral } from '@/modules/wms/agent/digits';
import { customerSources, extractNumbers, type NumberSource } from '@/modules/wms/agent/numbers';
import { checkAgentReply, foreignCodes, promiseHits, type PolicyInput } from '@/modules/wms/agent/policy';

/**
 * The review of the shipped policy (P1-P3): every reply below was MEASURED
 * passing `checkAgentReply` before its rule existed — a price with no source,
 * a promise, another customer's code — so each test names the exact text that
 * must never reach a customer from his account. Fixtures are literal: no
 * figure here is computed by the code under test.
 */

const base: PolicyInput = {
  body: 'Assalomu alaykum!',
  language: 'uz',
  customerScript: 'latin',
  numberSources: [],
  removeWhole: [],
  ownCodes: ['GS777'],
  bookCodes: new Set(),
  codePrefix: 'GS',
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: [],
  askedLocation: false,
  staffNames: ['Umriddin Karimov', 'Siroj Aliyev'],
  canary: 'zq7-canary-41',
  fingerprintPeers: 0,
  urlsToChat7d: 0,
  urlsToday: 0,
  hasEstimate: false,
};

const check = (patch: Partial<PolicyInput>) => checkAgentReply({ ...base, ...patch });
const codes = (patch: Partial<PolicyInput>) => check(patch).blocks.map((b) => b.code);
const kinds = (text: string) => extractNumbers(text).map((f) => [f.raw, f.kind]);

describe('P1: a figure is money whenever money is written near it', () => {
  it('reads superscript and circled digits instead of skipping them', () => {
    expect(normalizeDigits('⁴⁸⁰ $')).toBe('480 $');
    expect(normalizeDigits('④⑧⓪ $')).toBe('480 $');
    expect(normalizeDigits('ＵＳＤ４８０')).toBe('USD480');
    // A numeral that does not fold to plain digits is not guessed at.
    expect(unverifiableNumeral(normalizeDigits('1½ kub'))).toBe('other_script_digit');
  });

  it.each([
    ['Narxi USD480', 'uz'],
    ['Jami-480$', 'uz'],
    ['⁴⁸⁰ $', 'uz'],
    ['④⑧⓪ $', 'uz'],
    ['Narxi 480usd', 'uz'],
    ['Narxi480$', 'uz'],
    ['Narxi US480', 'uz'],
    ['ＵＳＤ４８０', 'uz'],
  ] as const)('«%s» with an empty ledger is unsourced money', (body, language) => {
    expect(extractNumbers(body).map((f) => f.kind)).toEqual(['money']);
    expect(codes({ body, language, numberSources: [] })).toContain('number_unsourced');
  });

  it.each([
    'Jami-480 AQSH dollari',
    'Jami-300 US dollars',
    'Итого-480 евро',
    'Jami-480 RMB',
    'Jami-480 у.е.',
    'Итого-480 тенге',
    'Jami-480 sum',
  ])('«%s»: a currency after the figure means it is no code', (body) => {
    expect(extractNumbers(body).map((f) => f.kind)).toEqual(['money']);
  });

  it('reads the currencies that are money only right after a figure, and a sign before a decimal', () => {
    expect(kinds('480元')).toEqual([['480', 'money']]);
    // «€12.10» is twelve euros ten, not the twelfth of October.
    const money: NumberSource = { value: 12.1, kind: 'money', label: 'tarif' };
    expect(codes({ body: 'Narxi €12.10', numberSources: [money] })).not.toContain('number_unsourced');
  });

  it('keeps «№» a sign, so the figure it numbers is still read', () => {
    expect(normalizeDigits('№5')).toBe('№5');
    expect(extractNumbers('Ombor №5').map((f) => f.raw)).toEqual(['5']);
    // A decomposed letter comes back composed.
    expect(normalizeDigits('и\u0306')).toBe('й');
  });

  it('reads «m²» as a measure, even in a text that names money', () => {
    expect(kinds('15 m² kafel narxi')).toEqual([['15', 'measure']]);
  });

  it('a number spelled out beside a price word is unreadable, currency or not', () => {
    expect(unverifiableNumeral('narxi besh yuz')).toBe('word_numeral');
    expect(unverifiableNumeral('сто евро')).toBe('word_numeral');
    expect(unverifiableNumeral('ikki hafta ichida')).toBeNull();
  });

  it('a multi-word currency makes the customer’s figure a request, never our price', () => {
    const sources = customerSources([{ text: '90 AQSH dollari qilib bering', label: 'mijoz' }]);
    expect(sources.map((s) => s.kind)).toEqual(['customer_money']);
    expect(codes({ body: "Mayli, 90 AQSH dollari bo'ladi", numberSources: sources })).toContain('number_unsourced');
    // …and the same request with the currency a line away, agreed to with a bare figure.
    const asked = customerSources([{ text: "Narxi qancha?\n90 bo'lsin", label: 'mijoz' }]);
    expect(asked.map((s) => s.kind)).toEqual(['customer_money']);
    expect(codes({ body: "Mayli, 90 bo'ladi", numberSources: asked })).toContain('number_unsourced');
  });

  it.each([
    ['300 US dollars', 'en', 'latin', 300],
    ['300 АҚШ доллари', 'uz_cyrl', 'cyrillic', 300],
    ['300 долларов США', 'ru', 'cyrillic', 300],
    ["1,5 mln so'm", 'uz', 'latin', 1.5],
    ['480 евро', 'ru', 'cyrillic', 480],
    ['480 юаней', 'ru', 'cyrillic', 480],
    ['480 RMB', 'uz', 'latin', 480],
    ['480 sum', 'uz', 'latin', 480],
    ['480 у.е.', 'ru', 'cyrillic', 480],
    ['480 тенге', 'ru', 'cyrillic', 480],
    ['480 دلار آمریکا', 'fa', 'arabic', 480],
    ['480 人民币', 'zh', 'han', 480],
    ['Narx (dollarda): 480', 'uz', 'latin', 480],
    ['Цена в долларах: 480', 'ru', 'cyrillic', 480],
  ] as const)('«%s» does not pass on the customer’s same-value measure', (body, language, script, value) => {
    const measure: NumberSource = { value, kind: 'measure', label: 'mijoz xabari' };
    const plain: NumberSource = { value, kind: 'plain', label: 'mijoz xabari' };
    expect(codes({ body, language, customerScript: script, numberSources: [measure, plain] })).toContain(
      'number_unsourced',
    );
  });

  it('a scale word is part of the figure: «1,5 mln so‘m» is 1 500 000', () => {
    expect(extractNumbers("1,5 mln so'm").map((f) => [f.value, f.kind])).toEqual([[1_500_000, 'money']]);
    expect(extractNumbers('480 ming').map((f) => [f.value, f.kind])).toEqual([[480_000, 'money']]);
    expect(extractNumbers('10k$').map((f) => [f.value, f.kind])).toEqual([[10_000, 'money']]);
    expect(extractNumbers('5 тыс. руб').map((f) => [f.value, f.kind])).toEqual([[5_000, 'money']]);
    expect(extractNumbers('2千元').map((f) => [f.value, f.kind])).toEqual([[2_000, 'money']]);
    // The card's ledger shows the figure as written, scale and all.
    expect(extractNumbers("1,5 mln so'm").map((f) => f.raw)).toEqual(['1,5 mln']);
    // «5 ming dona» is five thousand pieces: a count, scaled.
    expect(extractNumbers('5 ming dona').map((f) => [f.value, f.kind])).toEqual([[5_000, 'count']]);
    const tool: NumberSource = { value: 1_500_000, kind: 'money', label: 'mijozning balansi' };
    expect(codes({ body: "Balansingiz 1,5 mln so'm", numberSources: [tool] })).not.toContain('number_unsourced');
    // The unscaled value is a different number.
    const rate: NumberSource = { value: 1.5, kind: 'money', label: 'tarif' };
    expect(codes({ body: "Balansingiz 1,5 mln so'm", numberSources: [rate] })).toContain('number_unsourced');
  });

  it('a money source still lets the same money through', () => {
    const money: NumberSource = { value: 480, kind: 'money', label: "yo'lkira hisobi" };
    expect(codes({ body: 'Narx (dollarda): 480', numberSources: [money] })).not.toContain('number_unsourced');
    expect(codes({ body: 'Narxi USD480', numberSources: [money] })).not.toContain('number_unsourced');
  });

  it('a measure, a duration and a clock keep their kind in a money reply', () => {
    expect(kinds("5 kub yukingiz narxini soat 15:00 gacha, 2 kunda aytaman")).toEqual([
      ['5', 'measure'],
      ['15:00', 'plain'],
      ['2', 'duration'],
    ]);
    const measured = customerSources([{ text: '5 kub yuk bor, narxi qancha?', label: 'mijoz' }]);
    expect(measured.map((s) => s.kind)).toEqual(['measure']);
    expect(codes({ body: '5 kub yukingiz narxini hisoblab aytaman', numberSources: measured })).not.toContain(
      'number_unsourced',
    );
  });
});

describe('P2: the promises the table missed', () => {
  it.each([
    ['Narxni tushirib beraman', 'discount'],
    ['Narxini biroz pasaytiramiz', 'discount'],
    ['Arzon qilamiz', 'discount'],
    ['Sizga arzon beramiz', 'discount'],
    ['10% kamroq qilamiz', 'discount'],
    ['Нархни тушириб бераман', 'discount'],
    ['Скинем 10%', 'discount'],
    ['Сбавлю цену', 'discount'],
    ['Снизим цену для вас', 'discount'],
    ['10% off for you', 'discount'],
    ['قیمت را کم می‌کنیم', 'discount'],
    ['给您便宜一点', 'discount'],
    ["Ertaga albatta jo'natamiz", 'dispatch_promise'],
    ['Bugun kechqurun yuboramiz', 'dispatch_promise'],
    ['2 kunda yetib keladi', 'dispatch_promise'],
    ['Через 2 дня придёт', 'dispatch_promise'],
    ['It will arrive in 2 days', 'dispatch_promise'],
    ['Taxminan 2-5 kunda albatta yetib boradi', 'dispatch_promise'],
    ['Taxminan shunday. 2 kunda yetib keladi.', 'dispatch_promise'],
    ['Ertaga jo‘natiladi', 'dispatch_promise'],
    ['Yuk ertaga Toshkentga yetib boradi', 'dispatch_promise'],
    ['Pulini keyin berasiz', 'credit_release'],
    ["To'lovni keyinroq qilasiz", 'credit_release'],
    ['Оплатите после получения', 'credit_release'],
    ['You can pay after delivery', 'credit_release'],
    ['以后付就行', 'credit_release'],
  ] as const)('«%s» → %s', (text, category) => {
    expect(promiseHits(text)).toContain(category);
  });

  it.each([
    'Taxminan 2-5 kunda yetib boradi',
    'Reys bo‘lsa, odatda 2 kunda yetib keladi',
    'Примерно через 2-5 дней придёт',
    'It usually takes about 2-5 days to arrive',
    '大约2-5天到达',
    'Yukingiz 2 kun oldin yetib keldi',
    'Yukni ertaga tushiramiz',
    'Albatta, yordam beraman',
    'Bu yo‘l kamroq vaqt oladi',
    'Скиньте фото, пожалуйста',
    'Отправим после оплаты',
    'Hujjatni keyin berasiz',
    'Yukingiz bugun Toshkentga yetib keldi',
    'Bugun jo‘natildi',
    'Сегодня отправили',
    'We shipped it today',
    'Mashina har 3 kunda chiqadi',
    "To'lovni oldindan qilasiz keyin jo'natamiz",
  ])('«%s» is no promise', (text) => {
    expect(promiseHits(text)).toEqual([]);
  });

  it('the avia estimate he allowed passes the whole policy, hedged and sourced', () => {
    const days: NumberSource[] = [
      { value: 2, kind: 'duration', label: 'avia muddati' },
      { value: 5, kind: 'duration', label: 'avia muddati' },
    ];
    expect(check({ body: 'Taxminan 2-5 kunda yetib boradi.', numberSources: days }).ok).toBe(true);
    expect(codes({ body: '2 kunda yetib keladi.', numberSources: days })).toContain('promise');
  });

  it('a discount by the customer’s own percent is a promise, not a sourced figure', () => {
    const sources = customerSources([{ text: '10% kamroq qilib bering', label: 'mijoz' }]);
    const r = check({ body: '10% kamroq qilamiz', numberSources: sources });
    expect(r.blocks).toContainEqual({ rule: 'G2', code: 'promise', detail: 'discount' });
  });
});

describe('P3: another customer’s code in another script, a colleague’s name', () => {
  const ctx = { ownCodes: ['GS777'], bookCodes: new Set<string>(), codePrefix: 'GS' };

  it('folds Cyrillic and Greek spellings of a code to Latin', () => {
    expect(foreignCodes('ГС778 yuki ham keldi', ctx)).toEqual(['GS778']);
    // Latin G and a Cyrillic С.
    expect(foreignCodes('GС778 yuki ham keldi', ctx)).toContain('GS778');
    expect(foreignCodes('гс778', ctx)).toEqual(['GS778']);
    expect(foreignCodes('ΑΒ123 yuki', { ...ctx, bookCodes: new Set(['AB123']) })).toEqual(['AB123']);
    // The chat's own code in Cyrillic is still its own.
    expect(foreignCodes('ГС777 yukingiz keldi', ctx)).toEqual([]);
  });

  it('blocks a system shape spelled with look-alike letters', () => {
    expect(codes({ body: 'Bitim В-000124 bo‘yicha' })).toContain('system_code');
    expect(codes({ body: 'Yashik СR-YW26-00012 da' })).toContain('system_code');
  });

  it('a colleague’s full name in the other script still blocks', () => {
    expect(codes({ body: 'Умриддин Каримов жавоб беради', language: 'uz_cyrl', customerScript: 'cyrillic' })).toContain(
      'staff_name',
    );
  });

  it('one token of a colleague’s name WARNS, unless it is the customer’s own name', () => {
    const r = check({ body: 'Umriddin sizga javob beradi' });
    expect(r.blocks.map((b) => b.code)).not.toContain('staff_name');
    expect(r.warnings).toContainEqual({ rule: 'G6', code: 'staff_name', detail: 'Umriddin' });
    // Uzbek puts the case on the name: «Karimovga» is still Karimov.
    expect(check({ body: 'Karimovga yozing' }).warnings).toContainEqual({
      rule: 'G6',
      code: 'staff_name',
      detail: 'Karimov',
    });
    // …and a full name with its case ending still blocks.
    expect(codes({ body: 'Umriddin Karimovga yozing' })).toContain('staff_name');
    // A three-letter token is matched only as a whole word: «Ali» is not «Alisher».
    expect(check({ body: 'Alisher aka', staffNames: ['Ali Valiyev'] }).warnings).toEqual([]);
    expect(check({ body: 'Umriddin aka, yukingiz keldi', customerNames: ['Umriddin'] }).warnings).toEqual([]);
    // Said twice, warned once.
    expect(check({ body: 'Umriddin, Umriddin javob beradi' }).warnings).toEqual([
      { rule: 'G6', code: 'staff_name', detail: 'Umriddin' },
    ]);
  });

  it('a name is one name in either script and with any apostrophe', () => {
    expect(codes({ body: 'Umriddin Karimov javob beradi', staffNames: ['Умриддин Каримов'] })).toContain('staff_name');
    expect(codes({ body: 'G‘ulom Rahimov javob beradi', staffNames: ["G'ulom Rahimov"] })).toContain('staff_name');
    // «o'g'li» («son of») in a stored full name names nobody.
    expect(check({ body: 'Uning o‘g‘li keldi', staffNames: ["Karimov Umriddin Rustam o'g'li"] }).warnings).toEqual([]);
  });

  it('the IO layer asks the book about every spelling and passes the customer’s name', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/modules/wms/agent/policy-input.ts'), 'utf8');
    expect(src).toMatch(/async function bookCodesIn[\s\S]*?const candidates = codeCandidatesIn\(body\);/u);
    expect(src).toMatch(/customerNames: input\.strip\.filter\(/u);
  });
});
