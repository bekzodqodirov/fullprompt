import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { normalizeDigits, unverifiableNumeral } from '@/modules/wms/agent/digits';
import { servedText, WAREHOUSE_ADDRESS_SEED, type KbHit } from '@/modules/wms/agent/kb';
import type { AgentLocale, ScriptName } from '@/modules/wms/agent/locale';
import { extractNumbers, PHONE_RE, sourceFor, urlsIn, type FoundNumber, type NumberSource } from '@/modules/wms/agent/numbers';
import { addressAnchorsOf, checkAgentReply, promiseHits, type PolicyInput, type PolicyResult } from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { GS_REMINDER, SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import { runTool, type ToolEnv } from '@/modules/wms/agent/tools';

/**
 * The incident of 2026-10-29: «Assalomu alaykum» to his client-only number,
 * and the AI's first reply reached him with no «✅ Yuborish». The owner's
 * «a»: an ordinary greeting, «how can I help», a qualification question gets
 * its ✅; what is dangerous stays blocked exactly as before. Each softening
 * below is pinned on BOTH sides — the shape that lost its ✅, and its
 * dangerous neighbour that must keep losing it. Fixtures are literal replies
 * a model writes; nothing here is computed by the code under test.
 */

const msg = (body: string, n: number): ChatMessage => ({
  ref: `#${n}`,
  id: `00000000-0000-4000-8000-00000000000${n}`,
  tgMessageId: BigInt(n),
  direction: 'in',
  media: null,
  fileName: null,
  sentAt: new Date(),
  autoSent: false,
  editedAt: null,
  body,
});

function ctxOf(lines: readonly string[], customerScript: ScriptName): AgentContext {
  const messages = lines.map((b, i) => msg(b, i + 1));
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    anchor: messages.at(-1)!,
    burst: messages,
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript,
    measures: [],
    openCalcs: [],
    ruleDecision: null,
  };
}

const compose = (language: AgentLocale, replyText: string): ComposeReply => ({
  replyNeeded: true,
  replyText,
  language,
  glossUz: '',
  category: 'faq',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

/** The seeded knowledge as `generalFacts` serves it (kb.ts `hitOf`): question and answer, phones and links of the answer. */
const FACTS: KbHit[] = SEED_FACTS.map((f, i) => ({
  id: `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`,
  ref: `F${i}`,
  answer: servedText(f.question, f.answer),
  phones: [...normalizeDigits(f.answer).matchAll(PHONE_RE)].map((m) => m[0]),
  urls: urlsIn(normalizeDigits(f.answer)),
}));
const ANCHORS = addressAnchorsOf(
  SEED_FACTS.filter((f) => f.key.startsWith(WAREHOUSE_ADDRESS_SEED)).map((f) => f.answer),
  [GS_REMINDER],
);
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The policy over a reply, on the memory a real run stores (`memoryFor`) — as `policyFor` maps it. */
function verdict(
  lines: readonly string[],
  script: ScriptName,
  language: AgentLocale,
  reply: string,
  facts: KbHit[] = FACTS,
  patch: Partial<PolicyInput> = {},
): PolicyResult {
  const mem = memoryFor(ctxOf(lines, script), { compose: compose(language, reply), tools: [], outcomes: [], usage }, facts, 'gsr-t');
  return checkAgentReply({
    body: reply,
    language: mem.language,
    customerScript: mem.customerScript,
    numberSources: mem.sources,
    removeWhole: [],
    ownCodes: mem.ownCodes,
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: mem.allowedPhones,
    allowedUrls: mem.allowedUrls,
    mapUrls: mem.mapUrls,
    askedLocation: mem.askedLocation,
    staffNames: ['Murod Aliyev'],
    customerNames: [],
    canary: mem.canary,
    fingerprintPeers: 0,
    urlsToChat7d: 0,
    urlsToday: 0,
    hasEstimate: mem.hasEstimate,
    fromOurWarehouse: mem.fromOurWarehouse === true,
    factNameWords: mem.factNameWords ?? [],
    askedMode: mem.askedMode ?? null,
    hasGloss: mem.hasGloss === true,
    aviaOnly: mem.aviaOnly === true,
    aviaMentioned: mem.aviaMentioned === true,
    quotableHan: mem.quotableHan ?? '',
    warehouseAddress: ANCHORS,
    ...patch,
  });
}

const UZ = ['Assalomu alaykum', 'yuk bor', 'narxi qancha', 'Xitoydan'];
const RU = ['Здравствуйте', 'есть груз', 'сколько стоит', 'из Китая'];
const UZC = ['Ассалому алайкум', 'юк бор', 'нархи қанча', 'Хитойдан'];
const uz = (reply: string) => verdict(UZ, 'latin', 'uz', reply);
const ru = (reply: string) => verdict(RU, 'cyrillic', 'ru', reply);
const blockCodes = (r: PolicyResult) => r.blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`);
const figures = (text: string) => extractNumbers(text).map((f) => [f.raw, f.kind]);

describe('P1: a list’s own numbers are no figures', () => {
  it.each([
    ["Narxni hisoblashim uchun yozing:\n1. Tovar nomi\n2. Hajmi (kub)\n3. Og'irligi (kg)\n4. Qaysi shahardan jo'natiladi?"],
    ["Narxni aytishim uchun: 1) tovar nomi, 2) necha kub, 3) necha kg, 4) qaysi shahardan — yozib yuboring?"],
    ["Narxni aytishim uchun yozing: 1️⃣ tovar nomi 2️⃣ hajmi (kub) 3️⃣ og'irligi (kg) — qaysi shahardan yuborasiz?"],
    ["Narxni aytishim uchun: (1) tovar nomi, (2) hajmi, (3) og'irligi — yozing."],
    ['Для расчёта цены напишите:\n1. Название товара\n2. Объём (куб)\n3. Вес (кг)\n4. Город отправки?'],
    ["Avval:\n1. Tovar\n2. Kub\nKeyin:\n1. Shahar\n2. Kg"],
  ])('«%s» holds no figure at all — a marker is taken out, never read as «1 $»', (text) => {
    expect(extractNumbers(text)).toEqual([]);
  });

  it('the item’s own figure after a marker is read as ever — and a decimal is no marker', () => {
    expect(figures('Narxlar:\n1. 500 $ — avto\n2. 300 $ — avia')).toEqual([
      ['500', 'money'],
      ['300', 'money'],
    ]);
    expect(figures("Yozing:\n1) 2 kub yukingiz nima\n2) qaysi shahardan?")).toEqual([['2', 'measure']]);
    expect(figures('Yukingiz 1.5 kub, 1.20 kg')).toEqual([
      ['1.5', 'measure'],
      ['1.20', 'measure'],
    ]);
  });

  it.each([
    ['Yozing:\n5. Tovar\n6. Shahar', [5, 6], 'a run that does not start at 1'],
    ['Yozing:\n2) tovar\n3) kub', [2, 3], 'a «2)» no «1)» came before'],
    ['Narxi: 1. Boshqa savol bormi?', [1], 'a list of one'],
    ['Yozing:\n1. Tovar\n3. Kub', [1, 3], 'markers that skip a number'],
    ['Yozing:\n1. Tovar 2) kub', [1, 2], 'two styles are two lists of one'],
    ['Soat 1. Keyin 2. Tovar', [1, 2], 'the first item stands where no item starts'],
  ])('«%s» keeps its figures %j — %s', (text, values) => {
    expect(extractNumbers(text).map((f: FoundNumber) => f.value)).toEqual(values);
  });

  it('the incident’s reply passes; a priced list still asks a source for every price, never for the markers', () => {
    const list = "Assalomu alaykum! Avto kargo odatda 15–25 kunda keladi. Narxni hisoblashim uchun yozing:\n1. Tovar nomi\n2. Hajmi (kub)\n3. Og'irligi (kg)\n4. Qaysi shahardan jo'natiladi?";
    expect(uz(list).ok).toBe(true);
    expect(blockCodes(uz('Narxlar:\n1. 500 $ — avto\n2. 300 $ — avia'))).toEqual(['number_unsourced:500 $', 'number_unsourced:300 $']);
    expect(blockCodes(uz('Narxi: 1. Boshqa savol bormi?'))).toEqual(['number_unsourced:1 $']);
  });

  it('the prompt asks for «•» bullets, and the checklist hands the model the same shape', async () => {
    const head = stableHead({ styleGuide: null, facts: [] });
    expect(head).not.toMatch(/raqamlangan ro'yxat/u);
    expect(head).toMatch(/har bir bandi "•" belgisi bilan/u);
    const ctx = ctxOf(['Rastamojka kerak, kurtka'], 'latin');
    const env: ToolEnv = { ctx, day: '2026-10-29', aviaUsdPerKg: 17, kb: async () => [], chinaPlaces: async () => new Set(['Yiwu']) };
    const out = await runTool('calc_checklist', { section: 'rastamojka', goods: [] }, env);
    const lines = out.text.split('\n').slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^• /u);
    expect(out.text).not.toMatch(/\d\)/u);
  });
});

describe('P3: a word numeral blocks only beside what it counts', () => {
  it.each([
    ['Ming rahmat! Narxni aytishim uchun yukingiz necha kub va necha kg?'],
    ["Ikki xil yo'l bor: avto va avia. Yukingiz necha kg va necha kub?"],
    ["Bizda uch xil xizmat bor: yo'lkira, rastamojka va podklyuch. Yukingiz necha kub?"],
    ['Narxni aytishim uchun uch narsa kerak: tovar, kub va kg.'],
    ['Тысяча благодарностей! Напишите объём (куб) и вес (кг)?'],
  ])('«%s» states no figure', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBeNull();
  });

  it.each([
    ["Yukingiz besh kub bo'lsa yozing."],
    ["Taxminan yuz dollar bo'ladi."],
    ['Yuk ikki haftada yetib keladi.'],
    ['Uch ta karobka keldi.'],
    ['Ikki dona karobka.'],
    ["Taxminan uch-to'rt kunda."],
    ['Ваш груз три куба, верно?'],
    ['It is two kg, right?'],
    ['Yuz foiz yetib keladi.'],
    // A hedge between the price word and its figure hides nothing: the figure is still spelled out.
    ["Narxi taxminan uch yuz bo'ladi."],
    ['сто долларов'],
  ])('«%s» is a figure spelled out — still refused', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBe('word_numeral');
  });
});

describe('P4: a vague or asking count of days is no figure for G1 — and still a promise for G2', () => {
  it.each([
    ["Yuk necha kunda kelishi yo'nalishga bog'liq."],
    ['Narxni bir necha daqiqada hisoblab beraman.'],
    ['Расчёт займёт несколько дней.'],
    ['Посчитаю за пару дней.'],
    ['It takes a few days to calculate.'],
    ['محاسبه چند روز طول می‌کشد'],
    ['计算需要几天'],
  ])('«%s» states no count', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBeNull();
  });

  it.each([['Yuk odatda bir haftada keladi.'], ['Груз обычно приходит через неделю.'], ['Расчёт сделаю в течение часа.'], ['Ikki kunda.'], ['In two days.'], ['大约十几天']])(
    '«%s» is a definite count spelled out — still refused',
    (text) => {
      expect(unverifiableNumeral(normalizeDigits(text))).not.toBeNull();
    },
  );

  it('G2 still reads the vague count as a dispatch promise', () => {
    expect(promiseHits('Yukingiz bir necha kunda yetib keladi.')).toContain('dispatch_promise');
    expect(promiseHits("Yukingiz bir necha kunda Toshkentda bo'ladi.")).toContain('dispatch_promise');
    expect(promiseHits('Доставим за несколько дней.')).toContain('dispatch_promise');
  });

  it('the incident’s shapes pass whole', () => {
    expect(uz("Assalomu alaykum! Yuk necha kunda kelishi yo'nalishga bog'liq: avto kargo odatda 15–25 kun. Narxni aytishim uchun yuk hajmi (kub) va og'irligini (kg) yozing.").ok).toBe(true);
    expect(uz('Ming rahmat murojaatingiz uchun! Yuk odatda 15–25 kunda keladi, narxni bir necha daqiqada hisoblab beraman — yukingiz necha kub va necha kg?').ok).toBe(true);
    expect(ru('Здравствуйте! Расчёт займёт несколько дней. Напишите объём и вес груза?').ok).toBe(true);
  });
});

describe('P5: a question whose count asks is not our promise', () => {
  it('«Yuk qachon kerak, necha kunda yetib kelishi kerak?» asks him; it promises nothing', () => {
    expect(promiseHits('Yuk qachon kerak, necha kunda yetib kelishi kerak?')).toEqual([]);
    expect(uz('Assalomu alaykum! Yuk qachon kerak, necha kunda yetib kelishi kerak?').ok).toBe(true);
  });

  it.each([
    ["Yuk 10 kunda keladi, xo'pmi?", 'a figure with a tag question'],
    ['Yukingiz bir haftada yetib keladi, maqulmi?', 'a definite spelled count with a tag'],
    ["Yukingiz bir necha kunda yetib keladi, xo'pmi?", 'a vague count that still states one'],
    ['Necha kunda kerak? 10 kunda keladi.', 'the question, then the promise'],
    ['Yuk necha kunda yetib keladi.', 'no question mark at all'],
  ])('«%s» stays a promise — %s', (text) => {
    expect(promiseHits(text)).toContain('dispatch_promise');
  });
});

describe('P6: the seed’s own apostrophe (U+02BC) reads as «\'» — both ways', () => {
  it('is folded once, where every figure and word is read', () => {
    expect(normalizeDigits('vaʼda boʼlmaydi')).toBe("va'da bo'lmaydi");
    // «ʻ» (U+02BB) is in every class already and is left as written.
    expect(normalizeDigits('toʻlov')).toBe('toʻlov');
  });

  it('the kb’s disclaimer is a disclaimer…', () => {
    expect(promiseHits('Yuk 15–25 kunda yetib keladi — bu taxmin, vaʼda emas.')).toEqual([]);
    expect(uz('Assalomu alaykum! Yuk 15–25 kunda yetib keladi — bu taxmin, vaʼda emas. Yukingiz necha kub va necha kg?').ok).toBe(true);
  });

  it('…and a guarantee spelled with it is a guarantee (it passed before: fail-open)', () => {
    expect(promiseHits('Albatta, hech qanday muammo boʼlmaydi.')).toContain('guarantee');
    expect(promiseHits('Vaʼda beraman.')).toContain('dispatch_promise');
  });
});

describe('P7: the figures the prompt dictates are a source whatever the knowledge holds', () => {
  it('memoryFor carries the truck and avia minimums and the flight’s days as the company’s rule — never money', () => {
    const mem = memoryFor(ctxOf(UZ, 'latin'), { compose: compose('uz', 'x'), tools: [], outcomes: [], usage }, [], 'gsr-t');
    const rule = mem.sources.filter((s) => s.label === 'kompaniya qoidasi');
    expect(rule).toEqual([
      { value: 1, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb' },
      { value: 100, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb' },
      { value: 1, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air' },
      { value: 2, kind: 'duration', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air' },
      { value: 5, kind: 'duration', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air' },
    ]);
  });

  it('with NO knowledge at all, the minimum and the flight’s window pass; the truck may not borrow the flight’s days', () => {
    const none: KbHit[] = [];
    expect(verdict(UZ, 'latin', 'uz', 'Assalomu alaykum! Mashina bilan eng kamida 1 kub yoki 100 kg yuk olamiz. Yukingiz necha kub?', none).ok).toBe(true);
    expect(verdict(UZ, 'latin', 'uz', 'Avia orqali eng kamida 1 kg qabul qilamiz, yetib borishi taxminan 2–5 kun. Yukingiz necha kg?', none).ok).toBe(true);
    expect(blockCodes(verdict(UZ, 'latin', 'uz', 'Mashina bilan taxminan 5 kunda yetib keladi.', none))).toContain('number_unsourced:5');
    expect(blockCodes(verdict(UZ, 'latin', 'uz', 'Narxi 100 $.', none))).toContain('number_unsourced:100 $');
  });
});

describe('P8: an address’s bare number vouches for the address, never for a time or a count', () => {
  const house: NumberSource = { value: 29, kind: 'plain', label: 'kompaniya bilimi', origin: 'kb' };
  const at = (kind: FoundNumber['kind']): FoundNumber => ({ raw: '29', value: 29, kind, index: 0 });

  it('in sourceFor', () => {
    expect(sourceFor(at('plain'), [house])).toBe(house);
    for (const kind of ['duration', 'measure', 'count', 'date'] as const) expect(sourceFor(at(kind), [house])).toBeNull();
  });

  it.each([
    ['Assalomu alaykum! Yukingiz taxminan 29 kunda yetib keladi. Necha kub?', '29'],
    ['Assalomu alaykum! Yukingiz taxminan 168 soatda yetib keladi. Necha kub?', '168'],
    ['Assalomu alaykum! Narxni taxminan 3 kunda aytaman.', '3'],
    ['Sizning 29 ta karobkangiz keldi.', '29'],
  ])('«%s» — the seed’s house number is no source for %s', (reply, figure) => {
    expect(blockCodes(uz(reply))).toContain(`number_unsourced:${figure}`);
  });

  it('…while the address said back passes', () => {
    expect(verdict(['Ivu manzili qanday?'], 'latin', 'uz', 'Ivu (YW) qabul ombori: 浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596.').ok).toBe(true);
    const gz = SEED_FACTS.find((f) => f.key === 'china_address_guangzhou@1')!.answer;
    expect(verdict(['Guanchjou manzil kerak'], 'latin', 'uz', `Assalomu alaykum! ${gz}`).ok).toBe(true);
  });
});

describe('P9: the CALCULATION being free is no free extra', () => {
  it.each([
    ['Narxni hisoblash bepul.'],
    ['Hisob-kitob bepul.'],
    ['Hisoblash xizmati bepul.'],
    ['Narxni bepul hisoblab beraman.'],
    ['Нархни ҳисоблаш бепул.'],
    ['Расчёт бесплатный.'],
    ['Посчитаем бесплатно.'],
    ['Расчёт стоимости доставки бесплатный.'],
    ['The quote is free.'],
    ['We calculate for free.'],
  ])('«%s» is true, and no promise', (text) => {
    expect(promiseHits(text)).not.toContain('free_extras');
  });

  it.each([
    ['Yetkazish bepul.'],
    ['Yukingizni bepul saqlaymiz.'],
    ['Eshikkacha bepul yetkazamiz'],
    ['Hisoblash va yetkazish bepul.'],
    ['Yetkazish va narxni hisoblash bepul.'],
    ['Bepul hisob-kitob va yetkazib berish.'],
    ['Hisoblash bepul, yetkazish ham.'],
    ['Доставка и расчёт бесплатно.'],
    ['Бесплатный расчёт и доставка.'],
    ['Бесплатное хранение на складе.'],
    ['Free delivery and quote.'],
    ['Delivery and the quote are free.'],
    ['Етказиб бериш бепул.'],
  ])('«%s» still promises a free service', (text) => {
    expect(promiseHits(text)).toContain('free_extras');
  });

  it('the prompt names the everyday phrasings that are blocked, and the true one to use', () => {
    const head = stableHead({ styleGuide: null, facts: [] });
    for (const phrase of ['"qulay narx"', '"yaxshi narx"', '"hech qanday muammo bo\'lmaydi"', '"без проблем"', '"выгодные цены"', '"hisoblash uchun pul olinmaydi"']) {
      expect(head).toContain(phrase);
    }
  });
});

describe('P10: paid on arrival, before the cargo is taken, is the company’s rule — not credit', () => {
  it.each([
    ['Оплата по прибытии груза в Ташкент, перед получением.'],
    ['Оплата при получении, до выдачи груза.'],
    ['Оплатите по прибытии в Ташкент, до получения груза.'],
    ["To'lovni yuk kelganda qilasiz, yukni olishdan oldin."],
    ["Yuk kelgandan keyin to'laysiz, yukni olishingizdan oldin."],
    ["To'lovni yuk kelgandan keyin, yukni olishdan oldin qilasiz."],
    ['Тўловни юк келганда қиласиз, юкни олишдан олдин.'],
    ['Payment upon arrival in Tashkent, before you collect the cargo.'],
    ['You pay when the cargo arrives in Tashkent, before you collect it.'],
    // The seed's own sentence, verbatim.
    ['Yuk tashish uchun toʻlov yuk Toshkentga yetib kelganda, yukni olishdan oldin soʻmda qilinadi.'],
  ])('«%s» is no release on credit', (text) => {
    expect(promiseHits(text)).not.toContain('credit_release');
  });

  it.each([
    ['Оплатите после получения груза.'],
    ['Оплата по прибытии груза в Ташкент.'],
    ['Оплата при получении.'],
    ['Оплатите после получения, до выдачи документов.'],
    ['Оплатите потом, до получения.'],
    ["To'lovni yuk kelgandan keyin qilasiz."],
    ['Pulini keyin berasiz, olishdan oldin.'],
    ["Yuk kelgandan keyin to'laysiz."],
    ['Тўловни юк келганда қиласиз.'],
    ['Payment upon arrival in Tashkent.'],
    ['Pay later, before you collect it.'],
    ['You can pay after you collect it, before release.'],
  ])('«%s» is still credit', (text) => {
    expect(promiseHits(text)).toContain('credit_release');
  });
});

describe('the first reply to «Assalomu alaykum» gets its ✅ — on the memory a real run stores, with the seeded knowledge', () => {
  it.each([
    "Va alaykum assalom! Xitoydan yuk olib kelishda yordam beraman. Qanday yuk olib kelmoqchisiz?",
    "Assalomu alaykum! Qanday yuk olib kelmoqchisiz? Necha kub yoki necha kg bo‘ladi?",
    "Assalomu alaykum! Narxni aytishim uchun yozing:\n1. Tovar nomi\n2. Hajmi (kub)\n3. Og'irligi (kg)\n4. Qaysi shahardan jo'natiladi?",
    "Assalomu alaykum! Narxni aytishim uchun yozing:\n• tovar nomi\n• hajmi (kub) va og'irligi (kg)\n• qaysi shahardan jo'natiladi?",
    'Ming rahmat! Narxni aytishim uchun yukingiz necha kub va necha kg?',
    "Assalomu alaykum! Avto kargo odatda 15–25 kunda keladi — bu taxmin, vaʼda emas. Narxni hisoblash bepul: yukingiz necha kub va necha kg?",
    'Assalomu alaykum! Mashina bilan eng kamida 1 kub yoki 100 kg yuk olamiz. Yukingiz qancha va qaysi shahardan?',
    "Assalomu alaykum! Yuk qachon kerak, necha kunda yetib kelishi kerak?",
  ])('uz Latin: «%s»', (reply) => {
    const r = uz(reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    'Здравствуйте! Помогу привезти груз из Китая. Что за товар? Какой объём и вес?',
    'Здравствуйте! Чтобы назвать цену, напишите:\n1. Название товара\n2. Объём (куб)\n3. Вес (кг)\n4. Город отправки?',
    'Здравствуйте! Расчёт бесплатный. Оплата по прибытии груза в Ташкент, перед получением. Напишите объём и вес груза?',
    'Здравствуйте! Расчёт займёт несколько дней. Напишите объём (куб) и вес (кг)?',
  ])('ru: «%s»', (reply) => {
    const r = ru(reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    'Ассалому алайкум! Хитойдан юк олиб келишда ёрдам бераман. Нархни айтишим учун ёзинг:\n• товар номи\n• ҳажми (куб) ва оғирлиги (кг)\n• қайси шаҳардан жўнатилади?',
    'Ассалому алайкум! Нархни айтишим учун ёзинг:\n1. Товар номи\n2. Ҳажми (куб)\n3. Қайси шаҳардан?',
    'Ассалому алайкум! Нархни ҳисоблаш бепул. Юкингиз неча куб ва неча кг?',
  ])('uz Cyrillic: «%s»', (reply) => {
    const r = verdict(UZC, 'cyrillic', 'uz_cyrl', reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['Assalomu alaykum! Narxi 300 $ bo‘ladi.', 'number_unsourced:300 $'],
    ["Ertaga jo'natamiz.", 'promise:dispatch_promise'],
    ['Yukingiz taxminan 29 kunda yetib keladi.', 'number_unsourced:29'],
    ['Bizda qulay narxlar.', 'promise:discount'],
    ['Hech qanday muammo boʼlmaydi.', 'promise:guarantee'],
    ['Saqlash bepul.', 'promise:free_extras'],
    ['Оплата по прибытии груза в Ташкент.', 'promise:credit_release'],
    ['GS555 yuki ham keldi.', 'other_client_code:GS555'],
    ['Tel: +998 90 123 45 67', 'foreign_phone:+998 90 123 45 67'],
    ['Bitim B-000124 bo‘yicha.', 'system_code:B-000124'],
    ['Здравствуйте! Напишите объём.', 'wrong_script:latin→cyrillic'],
    ['gsr-t', 'canary'],
  ])('…while «%s» stays blocked (%s)', (reply, code) => {
    const r = uz(reply);
    expect(r.ok).toBe(false);
    expect(blockCodes(r)).toContain(code);
  });
});
