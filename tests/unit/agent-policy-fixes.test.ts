import { describe, expect, it } from 'vitest';
import { unverifiableNumeral } from '@/modules/wms/agent/digits';
import { customerSources, extractNumbers, type NumberSource } from '@/modules/wms/agent/numbers';
import { checkAgentReply, promiseHits, type PolicyInput } from '@/modules/wms/agent/policy';

/**
 * The fix round over the policy package (P1-P3), from two reviewers who ran
 * `checkAgentReply` on the base commit and on the package side by side. Each
 * must-block text below PASSED the package's whole policy — most of them a
 * promise the shipped policy had blocked — and each must-pass text was a
 * reply the package newly refused. Fixtures are literal and come from the
 * findings; no figure here is computed by the code under test.
 */

const base: PolicyInput = {
  body: 'Assalomu alaykum!',
  language: 'uz',
  customerScript: null,
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
const days = (...values: number[]): NumberSource[] => values.map((value) => ({ value, kind: 'duration', label: 'tool' }));

describe('the day rule blocks every dispatch the shipped policy blocked', () => {
  it.each([
    ["Ertaga jo'natib beraman", 'uz'],
    ["Ertaga jo'natib qo'yamiz", 'uz'],
    ["Bugun jo'natyapmiz", 'uz'],
    ["Ertaga jo'natishadi.", 'uz'],
    ['Ertaga yuborishadi.', 'uz'],
    ["Bugun jo'natilishi kerak.", 'uz'],
    ['Эртага жўнатиб берамиз.', 'uz_cyrl'],
    ['Завтра отправляем ваш груз', 'ru'],
    ['Сегодня отправляем', 'ru'],
    ['Отправка завтра', 'ru'],
    ['Отправляем завтра.', 'ru'],
    ['Завтра отправка.', 'ru'],
    ['Груз будет отправлен завтра.', 'ru'],
    ['It will be shipped tomorrow', 'en'],
    ['It will be dispatched tomorrow', 'en'],
    ['We are shipping it tomorrow.', 'en'],
    ['Shipping tomorrow.', 'en'],
  ] as const)('«%s» is a dispatch promise', (body, language) => {
    expect(promiseHits(body)).toContain('dispatch_promise');
    expect(check({ body, language }).blocks).toContainEqual({ rule: 'G2', code: 'promise', detail: 'dispatch_promise' });
  });

  it.each([
    'Bugun jo‘natdik, yo‘lda.',
    'Bugun jo‘natib yubordik.',
    'Yukingiz kecha jo‘natildi, bugun chegarada.',
    'Сегодня отправили ваш груз.',
    'Груз отправлен сегодня утром.',
    'It was dispatched today.',
    // The customer's errand, and a refusal — neither is our promise.
    'Ertaga invoysni yuboring, narxini aytaman.',
    'Hujjatlarni ertaga yuborasizmi?',
    'Отправьте фото груза сегодня, пожалуйста.',
    'Please send the invoice tomorrow.',
    'Ertaga jo‘natmaymiz, mashina yo‘q.',
    'Завтра не отправим, машины нет.',
  ])('«%s» is no promise', (text) => {
    expect(promiseHits(text)).toEqual([]);
  });
});

describe('paying after the cargo comes is credit, in every phrasing', () => {
  it.each([
    'Оплатите после',
    'Оплатите после того, как получите груз',
    'Можете оплатить после',
    'Оплата по факту получения',
    'Оплата при получении',
    'Pulini yuk kelgandan so‘ng berasiz',
    'To‘lovni yuk kelganda qilasiz',
    'Yuk kelgach to‘laysiz',
    'You can pay when it arrives',
    'Cash on delivery is fine',
    '货到付款就行',
  ])('«%s» → credit_release', (text) => {
    expect(promiseHits(text)).toContain('credit_release');
  });

  it.each([
    'Отправим после оплаты',
    'Хорошо, отправим после оплаты.',
    'Оплату после расчёта сообщим.',
    'Pul o‘tkazgandan keyin jo‘natamiz.',
    'Yuk kelgach sizga xabar beramiz.',
  ])('«%s» is no credit', (text) => {
    expect(promiseHits(text)).not.toContain('credit_release');
  });
});

describe('a day count with no digit, a promise to receive, a hedge that is not on the figure', () => {
  it.each([
    ['Yukingiz bir haftada yetib keladi', 'uz'],
    ['Yukingiz ikki kunda yetib keladi', 'uz'],
    ['Груз придёт через неделю', 'ru'],
    ['It will arrive in two days', 'en'],
  ] as const)('«%s»: a spelled duration is a promise AND a figure nothing checked', (body, language) => {
    const r = check({ body, language });
    expect(r.blocks).toContainEqual({ rule: 'G2', code: 'promise', detail: 'dispatch_promise' });
    expect(r.blocks).toContainEqual({ rule: 'G1', code: 'number_unverifiable', detail: 'word_numeral' });
  });

  it.each([
    ['Yukingizni 2 kunda olasiz', 'uz'],
    ['Через 2 дня получите', 'ru'],
    ['Груз будет в Ташкенте через 2 дня', 'ru'],
    ["Yukingiz 2 kunda Toshkentda bo'ladi", 'uz'],
    ['You will have it in 2 days', 'en'],
    ['我们约定3天到货', 'zh'],
    ['Груз придёт через 2 дня к складу около Ташкента', 'ru'],
    ["Don't worry about it, it will arrive in 2 days", 'en'],
    ['Xavotir olmang, odatda tez ishlaymiz, yukingiz 2 kunda yetib keladi', 'uz'],
    ['Mashina har 3 kunda chiqadi, yukingiz 5 kunda yetib keladi', 'uz'],
    ['Yukingiz 2 kunda yetib keladi ~', 'uz'],
  ] as const)('«%s» promises the day even with the days sourced', (body, language) => {
    const r = check({ body, language, numberSources: days(2, 3, 5) });
    expect(r.blocks).toContainEqual({ rule: 'G2', code: 'promise', detail: 'dispatch_promise' });
  });

  it.each([
    'Rastamojkaga 3 kun vaqt ketadi.',
    'Hisob-kitob 1 soatda chiqadi.',
    'Ответ придёт в течение 2 часов.',
    'Taxminan, 2 kunda yetib keladi.',
    "Avia odatda 2-5 kunda yetib boradi, reys bo'lsa 2 kunda.",
    "Taxminiy yo'lkira 480 $. Yuk 15-20 kunda yetib keladi (va'da emas). Boj va QQS alohida.",
  ])('«%s» is no promise about the cargo’s day', (text) => {
    expect(promiseHits(text)).not.toContain('dispatch_promise');
  });

  it('a non-cargo time with his own escalation line passes the whole policy', () => {
    const body = 'Narxni Bekzod aka 1 soat ichida aytadi, javob keladi.';
    expect(check({ body, numberSources: days(1), staffNames: [] }).ok).toBe(true);
  });
});

describe('money in the spellings people send', () => {
  const measure = (value: number): NumberSource[] => [
    { value, kind: 'measure', label: 'mijoz xabari' },
    { value, kind: 'plain', label: 'mijoz xabari' },
  ];

  it.each([
    ['Avia kilosiga 17', 'uz', 17],
    ["Kubiga 160 bo'ladi", 'uz', 160],
    ['За кило 17', 'ru', 17],
    ['17 per kg', 'en', 17],
    ["Umumiy summa 480 bo'ladi", 'uz', 480],
    ['Summasi 480', 'uz', 480],
    ['Jami 480 dollor', 'uz', 480],
    ['480 долар', 'ru', 480],
    ['480 USDT', 'uz', 480],
    ['Kilosi 17 USDT', 'uz', 17],
    ['Доставка стоит 480', 'ru', 480],
    ['Сколько стоит доставка? 480', 'ru', 480],
  ] as const)('«%s» does not pass on the customer’s same-value measure', (body, language, value) => {
    expect(codes({ body, language, numberSources: measure(value) })).toContain('number_unsourced');
  });

  it.each([
    ['Ваши 500 рубашек получены на складе.', 'ru', 500],
    ['Груз на 10 европаллетах на складе.', 'ru', 10],
    ['10 europallets arrived at the warehouse.', 'en', 10],
    ['10 evropaddon keldi', 'uz', 10],
    ['Ваш груз стоит на складе 2, приезжайте.', 'ru', 2],
    ['Машина стоит на границе, в очереди 15.', 'ru', 15],
    ['Pulat aka, yukingiz 2-omborda turibdi.', 'uz', 2],
    ['Ваши 300 пуловеров уже на складе.', 'ru', 300],
    ['20 chargers and 5 costumes arrived.', 'en', 20],
  ] as const)('«%s» names no money: its figure stays what it is', (body, language, value) => {
    expect(extractNumbers(body).map((f) => f.kind)).not.toContain('money');
    const count: NumberSource[] = [{ value, kind: 'count', label: 'mijoz xabari' }, { value: 5, kind: 'count', label: 'mijoz xabari' }];
    expect(codes({ body, language, numberSources: count })).not.toContain('number_unsourced');
  });

  it('«500千克» is five hundred kilograms, «2千元» two thousand yuan', () => {
    expect(extractNumbers('500千克').map((f) => [f.value, f.kind])).toEqual([[500, 'measure']]);
    expect(extractNumbers('2千元').map((f) => [f.value, f.kind])).toEqual([[2000, 'money']]);
    // …so a Chinese customer's weight vouches for itself again.
    expect(customerSources([{ text: '衬衫，货物500千克，2立方', label: 'mijoz' }]).map((s) => [s.value, s.kind])).toEqual([
      [500, 'measure'],
      [2, 'measure'],
    ]);
  });

  it('a figure’s form says it is no price: an ordinal glued to its noun, an hour after «soat»', () => {
    expect(extractNumbers("To'lov naqd, ombor 3-ko'chada").map((f) => f.kind)).toEqual(['plain']);
    const kb: NumberSource[] = [9, 18].map((value) => ({ value, kind: 'plain', label: 'kompaniya bilimi' }));
    expect(codes({ body: "Ofis soat 9 dan 18 gacha ishlaydi, to'lovni ofisda qilasiz.", numberSources: kb })).not.toContain(
      'number_unsourced',
    );
    // A case ending on a cardinal is no ordinal: «480-ga» is still the price, «500-dollarlik» still dollars.
    expect(extractNumbers('Narxi 480-ga tushadi').map((f) => f.kind)).toEqual(['money']);
    expect(extractNumbers('500-dollarlik tovar').map((f) => f.kind)).toEqual(['money']);
  });
});

describe('bargaining spans messages', () => {
  it('«Narxi qancha?» then «90 bo‘lsa olaman»: the 90 is the customer’s money, not a figure we may agree to', () => {
    const sources = customerSources([
      { text: 'Narxi qancha?', label: 'mijoz 1' },
      { text: "90 bo'lsa olaman", label: 'mijoz 2' },
    ]);
    expect(sources.map((s) => s.kind)).toEqual(['customer_money']);
    expect(codes({ body: "Mayli, 90 bo'ladi", numberSources: sources })).toContain('number_unsourced');
    // A measure keeps vouching for itself in the same conversation.
    const measured = customerSources([
      { text: 'Narxi qancha?', label: 'mijoz 1' },
      { text: '5 kub yuk bor', label: 'mijoz 2' },
    ]);
    expect(measured.map((s) => s.kind)).toEqual(['measure']);
  });
});

describe('a spelled-out number counts beside money, not merely in a text about it', () => {
  it.each([
    ['قیمت را آقای بکزاد اعلام می‌کند، نه من.', 'fa'],
    ['The price depends on two things: the volume and the goods.', 'en'],
    ['Narxni aytish uchun ikki narsa kerak: tovar nomi va hajmi.', 'uz'],
    ['Для расчёта цены нужно три вещи: название, объём и вес.', 'ru'],
  ] as const)('«%s» passes', (body, language) => {
    expect(check({ body, language }).ok).toBe(true);
  });

  it('…and a number spelled beside a price word, a currency or a unit of time still blocks', () => {
    expect(unverifiableNumeral('narxi besh yuz')).toBe('word_numeral');
    expect(unverifiableNumeral('Цена — сто долларов')).toBe('word_numeral');
    expect(unverifiableNumeral('نه روز')).toBe('word_numeral');
    expect(unverifiableNumeral('三百美金')).toBe('han_numeral');
    expect(unverifiableNumeral('两天到货')).toBe('han_numeral');
    // «一般» («generally») and «一下» («a moment») beside a price word are words, not numerals.
    expect(unverifiableNumeral('请问一下价格')).toBeNull();
    expect(unverifiableNumeral('一般3-5天到达')).toBeNull();
  });
});

describe('a discount is OUR price lowered, now or offered', () => {
  it.each([
    'Скиньте фото и цену товара, пожалуйста.',
    'Скиньте инвойс с ценой товара.',
    'Hajm oshgani sari kub narxi kamayadi.',
    'Narxlar hozir pasaygan.',
    'Tovar narxini kamaytirib yozmang, bojxona tekshiradi.',
    "Invoysda narxni tushirib ko'rsatish mumkin emas.",
    'Мы не можем снизить цену в инвойсе.',
    'Narxni tushirishimiz mumkin emas.',
  ])('«%s» is no discount', (text) => {
    expect(promiseHits(text)).not.toContain('discount');
  });

  it.each(['Narxni tushirishimiz mumkin.', 'Narxni tushirsak bo‘ladi.', 'Скину цену для вас.', 'Можем скинуть 10%.'])(
    '«%s» is one',
    (text) => {
      expect(promiseHits(text)).toContain('discount');
    },
  );
});

describe('a colleague named in the order documents write it', () => {
  it('«Karimov Umriddin» blocks as «Umriddin Karimov» does', () => {
    expect(check({ body: 'Karimov Umriddin sizga yozadi' }).blocks).toContainEqual({
      rule: 'G6',
      code: 'staff_name',
      detail: 'Umriddin Karimov',
    });
    // A three-word stored name in any order, its «o'g'li» left out.
    expect(codes({ body: 'Rustam Karimov Umriddin javob beradi', staffNames: ["Karimov Umriddin Rustam o'g'li"] })).toContain(
      'staff_name',
    );
    // One word still only warns.
    expect(codes({ body: 'Karimov sizga yozadi' })).not.toContain('staff_name');
  });
});
