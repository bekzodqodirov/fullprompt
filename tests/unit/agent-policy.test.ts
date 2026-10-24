import { describe, expect, it } from 'vitest';
import { normalizeDigits, unverifiableNumeral } from '@/modules/wms/agent/digits';
import { customerSources, extractNumbers, numberLedger, parseFigure, type NumberSource } from '@/modules/wms/agent/numbers';
import {
  checkAgentReply,
  checkOwnerReply,
  EXCLUSION_SENTENCE,
  foreignCodes,
  promiseHits,
  textFingerprint,
  type PolicyInput,
} from '@/modules/wms/agent/policy';
import { agentCardText, cardDigest, CardTooLong } from '@/modules/wms/agent/card';

/**
 * The rules a machine reply must pass before ✅ exists (spec §6, review
 * §17.6). Every refusal here is BLOCKING — the card carries no ✅ — so each
 * test names the exact reply that must never reach a customer.
 */

const base: PolicyInput = {
  body: 'Assalomu alaykum! Yukingiz Toshkentga yetib keldi.',
  language: 'uz',
  customerScript: 'latin',
  numberSources: [],
  removeWhole: [],
  ownCodes: ['GS777'],
  bookCodes: new Set(),
  codePrefix: 'GS',
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: ['https://yandex.uz/maps/-/CXQr78ni'],
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

describe('digits are read in every script (leak-7)', () => {
  it('turns Persian, Arabic-Indic and full-width digits into ASCII', () => {
    expect(normalizeDigits('GS۷۷۷')).toBe('GS777');
    expect(normalizeDigits('GS٧٧٧')).toBe('GS777');
    expect(normalizeDigits('+۹۹۸ ۹۰ ۱۲۳ ۴۵ ۶۷')).toBe('+998 90 123 45 67');
    expect(normalizeDigits('１５０')).toBe('150');
  });

  it('refuses a numeral nothing here can read', () => {
    expect(unverifiableNumeral(normalizeDigits('二百美元'))).toBe('han_numeral');
    expect(unverifiableNumeral('сто долларов')).toBe('word_numeral');
    expect(unverifiableNumeral('यह ५०० है')).toBe('other_script_digit');
    expect(unverifiableNumeral('一下就好')).toBeNull();
    expect(unverifiableNumeral('bir kub qancha')).toBeNull();
  });

  it('blocks a Persian-digit price, another client’s Persian-digit code and phone', () => {
    expect(codes({ body: '۱۵۰ دلار', language: 'fa', customerScript: 'arabic' })).toContain('number_unsourced');
    expect(codes({ body: 'GS۵۵۵ yuki keldi', bookCodes: new Set(['GS555']) })).toContain('other_client_code');
    expect(codes({ body: 'Tel: +۹۹۸ ۹۰ ۱۲۳ ۴۵ ۶۷' })).toContain('foreign_phone');
    expect(codes({ body: '二百美元', language: 'zh', customerScript: 'han' })).toContain('number_unverifiable');
  });
});

describe('G1: a figure by its kind and its source (money-1)', () => {
  it('reads figures with the word beside them', () => {
    const found = extractNumbers('1 kub uchun $110, jami 330 dollar. Muddat 15-25 kun, 3 ta karobka, 17.11 gacha.');
    expect(found.map((f) => [f.raw, f.kind])).toEqual([
      ['1', 'measure'],
      ['110', 'money'],
      ['330', 'money'],
      ['15', 'duration'],
      ['25', 'duration'],
      ['3', 'count'],
      ['17.11', 'date'],
    ]);
  });

  it('parses thousands and decimals the way people write them', () => {
    expect(parseFigure('1 200')).toBe(1200);
    expect(parseFigure('1,200')).toBe(1200);
    expect(parseFigure('1,5')).toBe(1.5);
    expect(parseFigure('330.50')).toBe(330.5);
  });

  it('never reads a code or a phone as a figure', () => {
    expect(extractNumbers('GS777 va B-000124').map((f) => f.raw)).toEqual([]);
    expect(extractNumbers('+998 95 018 30 33 ga qo‘ng‘iroq qiling')).toEqual([]);
  });

  it('lets a money figure through only from a MONEY source', () => {
    const money: NumberSource = { value: 330, kind: 'money', label: 'yo‘lkira hisobi' };
    expect(codes({ body: 'Taxminan 330$', numberSources: [money] })).not.toContain('number_unsourced');
    // The same value from the customer's own measure, or from a phone, is no price.
    const measure: NumberSource = { value: 330, kind: 'measure', label: 'mijoz xabari' };
    expect(codes({ body: 'Taxminan 330$', numberSources: [measure] })).toContain('number_unsourced');
  });

  it('never repeats the customer’s own money figure as ours', () => {
    const sources = customerSources([{ text: '90$ qilib bering', label: 'mijoz' }]);
    expect(codes({ body: 'Mayli, 90$ bo‘ladi', numberSources: sources })).toContain('number_unsourced');
    // …while their measure vouches for itself.
    const measured = customerSources([{ text: '5 kub yuk bor', label: 'mijoz' }]);
    expect(codes({ body: '5 kub yukingiz uchun hisoblatib beraman', numberSources: measured })).not.toContain(
      'number_unsourced',
    );
  });

  it('takes the persona phone out whole, so its digits are never figures', () => {
    const ledger = numberLedger('Umriddin: +998 95 018 30 33', [], ['+998 95 018 30 33']);
    expect(ledger).toEqual([]);
  });
});

describe('G2: what may never be promised, in six languages (money-8)', () => {
  it.each([
    ['Sizga chegirma qilamiz', 'discount'],
    ['Скидку сделаем', 'discount'],
    ['给您打折', 'discount'],
    ['100% kafolat beraman', 'guarantee'],
    ['Гарантируем доставку', 'guarantee'],
    ['Qarzga berib turamiz', 'credit_release'],
    ['Можно в долг', 'credit_release'],
    ['نسیه می‌دهیم', 'credit_release'],
    ['Pulingizni qaytaramiz', 'refund'],
    ['Вернём деньги', 'refund'],
    ['Eshikkacha bepul yetkazamiz', 'free_extras'],
    ['Free insurance included', 'free_extras'],
    ['Ertaga jo‘natamiz', 'dispatch_promise'],
    ['Отправим завтра', 'dispatch_promise'],
    ['Bojxona narxga kiradi', 'customs_included'],
    ['包清关', 'customs_included'],
    ['Bojsiz olib kelamiz', 'no_duty'],
    ['без пошлин', 'no_duty'],
    ['بدون گمرک', 'no_duty'],
  ])('%s → %s', (text, category) => {
    expect(promiseHits(text)).toContain(category);
  });

  it('does not read the exclusion sentence as a customs promise', () => {
    for (const s of Object.values(EXCLUSION_SENTENCE)) expect(promiseHits(s)).toEqual([]);
  });
});

describe('G4, G5, G6: shape, script, whose things', () => {
  it('blocks a long reply and a second question', () => {
    expect(codes({ body: 'a'.repeat(701) })).toContain('too_long');
    expect(codes({ body: 'Qancha kub? Qayerdan?' })).toContain('questions');
    expect(codes({ body: 'چند کیلو؟ از کجا؟', language: 'fa', customerScript: 'arabic' })).toContain('questions');
  });

  it('answers in the customer’s script — uz-Cyrl and ru are one script', () => {
    expect(codes({ body: 'Юкингиз келди', language: 'uz_cyrl', customerScript: 'latin' })).toContain('wrong_script');
    expect(codes({ body: 'Юкингиз келди', language: 'uz_cyrl', customerScript: 'cyrillic' })).not.toContain(
      'wrong_script',
    );
    expect(codes({ body: 'Ваш груз прибыл', language: 'ru', customerScript: 'cyrillic' })).not.toContain(
      'wrong_script',
    );
  });

  it('blocks another client’s code, an invented prefixed code, a system code', () => {
    expect(codes({ body: 'GS555 yuki ham keldi', bookCodes: new Set(['GS555']) })).toContain('other_client_code');
    expect(codes({ body: 'GS9999 bo‘yicha' })).toContain('other_client_code');
    expect(codes({ body: 'GS777 yukingiz keldi' })).not.toContain('other_client_code');
    expect(codes({ body: 'Yashik CR-YW26-00012 da' })).toContain('system_code');
    expect(codes({ body: 'Bitim B-000124 bo‘yicha' })).toContain('system_code');
  });

  it('blocks a staff name, a prompt leak, a denial of being an AI, a mention', () => {
    expect(codes({ body: 'Umriddin Karimov javob beradi' })).toContain('staff_name');
    expect(codes({ body: 'zq7-canary-41' })).toContain('canary');
    expect(codes({ body: 'Men bot emasman, odamman' })).toContain('ai_denial');
    expect(codes({ body: 'Я не бот' })).toContain('ai_denial');
    expect(codes({ body: '@bekzod_helper ga yozing' })).toContain('mention');
  });

  it('allows a kb phone, refuses any other; the map link only when asked', () => {
    expect(codes({ body: 'Tel: +998 95 018 30 33', allowedPhones: ['+998950183033'] })).not.toContain(
      'foreign_phone',
    );
    expect(codes({ body: 'Manzil: https://yandex.uz/maps/-/CXQr78ni' })).toContain('map_unasked');
    expect(codes({ body: 'Manzil: https://yandex.uz/maps/-/CXQr78ni', askedLocation: true })).not.toContain(
      'map_unasked',
    );
    expect(codes({ body: 'Saytga qarang: https://example.com/x' })).toContain('url');
  });
});

describe('G10, G11: the same text to many, an estimate said as one', () => {
  it('folds case, digits and the customer’s own name out of the fingerprint', () => {
    expect(textFingerprint('Salom Ali! 5 kub', ['Ali'])).toBe(textFingerprint('salom  Vali! 7 kub', ['Vali']));
  });

  it('blocks a fingerprint sent to more than three other customers', () => {
    expect(codes({ fingerprintPeers: 4 })).toContain('fingerprint');
    expect(codes({ fingerprintPeers: 3 })).not.toContain('fingerprint');
  });

  it('an estimate must say «taxminan» and «boj va QQS alohida»', () => {
    const money: NumberSource = { value: 330, kind: 'money', label: 'yo‘lkira hisobi' };
    const p = { numberSources: [money], hasEstimate: true };
    expect(codes({ ...p, body: 'Yo‘lkira 330$' })).toContain('estimate_unhedged');
    expect(codes({ ...p, body: `Yo‘lkira taxminan 330$. ${EXCLUSION_SENTENCE.uz}` })).not.toContain(
      'estimate_unhedged',
    );
  });

  it('a clean reply passes', () => {
    expect(check({}).ok).toBe(true);
  });
});

describe('his own text is his', () => {
  it('blocks only what Telegram would refuse; another code is a warning', () => {
    const r = checkOwnerReply({ body: 'GS555 ni ham ko‘ring, 200$ chegirma', ownCodes: ['GS777'], bookCodes: new Set(['GS555']), codePrefix: 'GS' });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['other_client_code']);
    expect(checkOwnerReply({ body: '  ', ownCodes: [], bookCodes: new Set(), codePrefix: 'GS' }).ok).toBe(false);
  });

  it('foreignCodes ignores the chat’s own codes', () => {
    expect(foreignCodes('GS777-A va GS777', { ownCodes: ['GS777'], bookCodes: new Set(), codePrefix: 'GS' })).toEqual([]);
  });
});

describe('the card (leak-3)', () => {
  const card = {
    customerLabel: 'GS777 · Ali',
    title: '🤖 Javob qoralamasi',
    statusLine: null,
    blocks: [],
    warnings: [],
    notes: [],
    reply: 'Assalomu alaykum! Yukingiz keldi.',
    gloss: null,
    ledger: [],
    actions: [],
    ownerQuestion: null,
    lastOut: 'Rahmat',
    customerLines: ['Yukim keldimi?'],
  };

  it('keeps the whole reply and clips only the customer’s lines', () => {
    const long = Array.from({ length: 400 }, (_, i) => `xabar ${i} ${'x'.repeat(20)}`);
    const text = agentCardText({ ...card, reply: 'R'.repeat(690), customerLines: long });
    expect(text).toContain('R'.repeat(690));
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain('qisqartirildi');
    // The newest line survives the cut, the oldest does not.
    expect(text).toContain('xabar 399');
    expect(text).not.toContain('xabar 0 ');
  });

  it('refuses a card whose fixed part cannot be shown whole', () => {
    expect(() => agentCardText({ ...card, reply: 'R'.repeat(3800) })).toThrow(CardTooLong);
  });

  it('a changed body or action changes the digest', () => {
    expect(cardDigest('a', [])).toMatch(/^[0-9a-f]{8}$/);
    expect(cardDigest('a', [])).not.toBe(cardDigest('b', []));
    expect(cardDigest('a', [])).not.toBe(cardDigest('a', [{ type: 'mute' }]));
  });
});
