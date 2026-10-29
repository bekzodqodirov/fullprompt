import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { normalizeDigits, unverifiableNumeral } from '@/modules/wms/agent/digits';
import { servedText, WAREHOUSE_ADDRESS_SEED, type KbHit } from '@/modules/wms/agent/kb';
import type { AgentLocale, ScriptName } from '@/modules/wms/agent/locale';
import { extractNumbers, PHONE_RE, sourceFor, urlsIn, type FoundNumber, type NumberSource } from '@/modules/wms/agent/numbers';
import { addressAnchorsOf, checkAgentReply, promiseHits, vagueTravelTime, type PolicyInput, type PolicyResult } from '@/modules/wms/agent/policy';
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
      { value: 1, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb', mode: 'road', unit: 'm3', said: 'minimum' },
      { value: 100, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb', mode: 'road', unit: 'kg', said: 'minimum' },
      { value: 1, kind: 'measure', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air', unit: 'kg', said: 'minimum' },
      { value: 2, kind: 'duration', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air', unit: 'day' },
      { value: 5, kind: 'duration', label: 'kompaniya qoidasi', origin: 'kb', mode: 'air', unit: 'day' },
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
    ['Рассчитаем стоимость бесплатно.'],
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

/**
 * The first round reviewed (two reviewers, every case re-run against the
 * tree before and after): each softening above had opened a door beside the
 * one it meant to open. Every sentence here was BLOCKED at a4e1b1c and
 * PASSED once the round shipped — or passed on both trees and is a door of
 * the same kind — and must block again; each pass beside it is the shape the
 * round exists for, and must stay open.
 */
const uzc = (reply: string) => verdict(UZC, 'cyrillic', 'uz_cyrl', reply);
const en = (reply: string) => verdict(['Hello', 'I have cargo', 'how much', 'from China'], 'latin', 'en', reply);

describe('review — P10: «before the cargo is taken» exempts only the company rule’s own tail', () => {
  it.each([
    ['Оплата по прибытии, до выдачи платить не нужно.', 'a refusal after it'],
    ['Оплата по прибытии, не обязательно перед получением.', 'a refusal before it'],
    ['Оплата производится по прибытии груза, но не обязательно перед получением — можно и позже.', '«не обязательно … позже»'],
    ['Оплата по прибытии, платить перед получением не нужно.', '«не нужно» after it'],
    ['Груз выдадим до получения оплаты, оплата по прибытии.', '«до получения» the MONEY'],
    ['Оплата при получении, а груз отдадим до получения оплаты.', 'handed over before the money'],
    ['Оплатите по факту, груз можно забрать до оплаты, до получения денег мы его не держим.', '«можно забрать до оплаты»'],
    ['Груз выдадим сразу, оплата по факту, перед получением просто позвоните.', 'the phrase is about a call'],
    ['You pay on arrival, there is no need to pay before you collect.', '«no need»'],
    ['Payment upon delivery, not before pickup.', '«not before»'],
    ["Payment upon arrival, you don't have to pay before pickup, any time later is fine.", '«don’t have to … later»'],
    ["Yuk kelganda to'laysiz, olishdan oldin to'lashingiz shart emas.", '«shart emas»'],
    ['Pulni yuk kelgandan keyin berasiz, olib ketishdan oldin kerak emas.', '«kerak emas»'],
    ['Юк келганда тўлайсиз, олишдан олдин тўлаш шарт эмас.', '«шарт эмас»'],
    ["Pulni yukni olgandan keyin berasiz, olishdan oldin faqat imzo qo'yasiz.", 'paid after he TAKES it'],
    ["To'lovni yukni olib ketgandan keyin qilasiz, topshirishdan oldin qo'ng'iroq qilamiz.", 'three words to its time (passed on both trees)'],
    ['Оплата по прибытии, перед получением. Но это не обязательно.', 'the next statement takes it back'],
    ["Yuk kelganda to'laysiz, yukni olishdan oldin. Shart emas.", 'the next statement takes it back'],
    ['Оплата по прибытии, перед получением или после.', '«or after»'],
    ['Payment upon arrival, before you collect it or after.', '«or after»'],
    ["Yuk kelganda to'laysiz, yukni olishdan oldin yoki keyin.", '«yoki keyin»'],
    ['Груз выдадим сразу, оплата по прибытии, перед получением.', 'the cargo handed over first'],
    ['We release it right away, payment upon arrival, before you collect it.', 'the cargo handed over first'],
    ['Оплата по прибытии, до получения денег.', '«до получения» the money, as the tail'],
    ['Pulni yukni olgandan keyin berasiz, yukni olishdan oldin.', '«olgandan keyin» is after he takes it'],
  ])('«%s» is still credit — %s', (text) => {
    expect(promiseHits(text)).toContain('credit_release');
  });

  it.each([
    ['Оплата по прибытии груза в Ташкент, перед получением.'],
    ['Оплачиваете при получении в Ташкенте, перед тем как забрать груз.'],
    ["To'lov yuk Toshkentga yetib kelganda, yukni olishdan oldin qilinadi."],
    ["To'lovni yuk kelganda qilasiz, yukni olishdan oldin."],
    ['Тўловни юк келганда қиласиз, юкни олишдан олдин.'],
    ['Payment on arrival in Tashkent, before you collect the cargo.'],
    ['Оплата по прибытии, перед получением, наличными или картой.'],
    ["To'lovni yuk kelganda qilasiz, yukni olishdan oldin, naqd yoki karta orqali."],
    ["Yuk tashish uchun to'lov yuk Toshkentga yetib kelganda, yukni olishdan oldin so'mda qilinadi; narx dollarda kelishiladi."],
  ])('«%s» is the company’s rule, and no credit', (text) => {
    expect(promiseHits(text)).not.toContain('credit_release');
  });
});

describe('review — P9: only the calculation as a NOUN may be what is free', () => {
  it.each([
    ['Omborda saqlash bepul hisoblanadi.'],
    ['Saqlash tekin hisoblanadi.'],
    ['Yetkazish bepul hisoblanadi.'],
    ['Uyingizga yetkazish bepul hisoblanadi.'],
    ['Birinchi hafta saqlash bepul hisoblanadi, keyin pullik.'],
    ['Omborda saqlash xizmati bepul hisoblanadi.'],
    ['Toshkent ichida yetkazib berish bepul hisoblanadi.'],
    ['Birinchi oy saqlash tekin hisoblanadi.'],
    ['Saqlashni bepul hisoblaymiz.'],
    ['Narxini hisoblab bepul yetkazib beramiz.'],
    ['Hisoblab bepul saqlab beramiz.'],
    ['Yetkazib berishni ham bepul hisoblab beramiz.'],
    ['Hisoblash bepul, xuddi yetkazish kabi.'],
    ['Hisoblash bepul, qolgani ham.'],
    ['Омборда сақлаш бепул ҳисобланади.'],
    ['Хранение посчитаем бесплатно.'],
    ['Хранение на складе рассчитаем бесплатно.'],
    ['Рассчитаем бесплатную доставку.'],
    ['Рассчитаем бесплатную доставку по Ташкенту.'],
    ['Бесплатно рассчитаем и доставим по Ташкенту.'],
    // «Посчитать» is also «count as»: with no price for its object it says nothing of what is free.
    ['Посчитаем бесплатно.'],
    ['The estimated delivery is free.'],
    ['Estimated shipping is free.'],
    ['We estimate delivery is free.'],
    ['We quote free delivery within Tashkent.'],
    ['We calculate free storage for the first month.'],
    ['Our pricing is free shipping included.'],
    ['Narxni hisoblash bepul. Saqlash ham.'],
    // «Hisoblanadi» is «is counted as», «посчитаем» «we will count as»: no calculation is the free thing.
    ['Bu bepul hisoblanadi.'],
    ['Hammasi tekin hisoblanadi.'],
    ['Это посчитаем бесплатно.'],
    ['Расчёт бесплатный. Хранение тоже.'],
    ['The quote is free. Storage too.'],
  ])('«%s» still promises a free service', (text) => {
    expect(promiseHits(text)).toContain('free_extras');
  });

  it.each([
    ['Hisoblash xizmati bepul, tovar nomi va hajmini yozing.'],
    ['Yetkazish narxini hisoblash bepul.'],
    ['Rastamojkani hisoblash bepul.'],
    ['Бесплатный расчёт стоимости — напишите товар и объём.'],
    ['Расчёт доставки бесплатный.'],
    ['Расчёт таможенных платежей бесплатный.'],
    ['A free quote: send the goods and the volume.'],
    ['The calculation of the delivery cost is free.'],
    ['Narxni hisoblash bepul. Tovar nomini ham yozing.'],
    ['Narxni hisoblash bepul: tovar nomini va hajmini ham yozing.'],
  ])('«%s» says the calculation is free, and passes', (text) => {
    expect(promiseHits(text)).not.toContain('free_extras');
  });
});

describe('review — P3: a price spelled out per unit, or with its currency past a comma', () => {
  it.each([
    ['Har kub uchun ikki yuz.'],
    ["Yo'lkira kub uchun taxminan uch yuz."],
    ['Bir kg uchun taxminan uch.'],
    ["Avia bir kg uchun taxminan o'n yetti."],
    ["Avia kg ga o'n yetti bo'ladi."],
    ['Narx kub uchun yuz ellik atrofida, dollar bilan.'],
    ['Narxi esa, besh yuz.'],
    ["Hammasi bo'lib taxminan ikki ming, dollar hisobida."],
    ["Sizning yukingiz ikki m³ bo'lsa ham olamiz."],
    ['За куб примерно триста.'],
    ['Доставка за один куб обойдётся в триста.'],
    ['Итого примерно две тысячи, в долларах.'],
    ['It comes to about two thousand, in US dollars.'],
    // Passed on both trees: no word of Uzbek Cyrillic, no Russian teen, was a numeral at all.
    ['Нархи беш юз доллар бўлади.'],
    ['Ҳар куб учун икки юз доллар.'],
    ['Авиа — семнадцать долларов за килограмм.'],
    ['Narxi to´rt yuz.'],
    ['Hajmi kub hisobida uch.'],
    ['Цена за кило — семнадцать.'],
    ["Kilosiga o'n yetti bo'ladi."],
  ])('«%s» is a figure spelled out — refused', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBe('word_numeral');
  });

  it.each([
    ['Ming rahmat, narxni aytishim uchun necha kub?'],
    ["Ikki xil yo'l bor: avia va avto. Avia uchun kg kerak."],
    ["Uch narsa kerak: tovar nomi, hajmi (kub) va og'irligi (kg)."],
    ["Ikki yo'l bor: avia va avto, narxi dollarda."],
    ['Два варианта: авиа и авто, цена в долларах.'],
    ['Bir daqiqa, hozir aniqlab beraman.'],
    ['Bir daqiqa kuting, narxni hisoblab aytaman.'],
    ['Бир дақиқа, ҳозир аниқлаб бераман.'],
    ["Ikki yo'l bor: avia va avto, narxi dollarda bo'ladi."],
    ['Ming rahmat, narxni dollarda aytaman — yukingiz necha kub?'],
    ['Есть два варианта: авиа и авто. Цена в долларах.'],
    ['We have two options: air and truck. Prices are in US dollars.'],
    // The words AFTER a run stop at its comma.
    ['Omborimiz ikki, narxlari har xil.'],
  ])('«%s» states no figure', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBeNull();
  });

  it('a minute as a time we give is still one', () => {
    expect(unverifiableNumeral(normalizeDigits('Narxni bir daqiqada hisoblab beraman.'))).toBe('word_numeral');
  });
});

describe('review — P7: a rule’s figure vouches only in its own unit and on its own road', () => {
  const none: KbHit[] = [];
  it.each([
    ['Yukingiz taxminan 5 kunda yetib keladi.', '5'],
    ['Yukingiz taxminan 2 kunda yetib keladi.', '2'],
    ['Yukingiz taxminan 2-5 kunda yetib keladi.', '2'],
    ['Mashina uchun eng kamida 1 kg kerak.', '1'],
    ['100 kub yukni olamiz.', '100'],
    ['Narxni 2 soatda hisoblab beraman.', '2'],
    ['Sizning 100 ta karobkangiz omborga keldi.', '100'],
  ])('«%s», with NO knowledge, has no source for %s', (reply, figure) => {
    expect(blockCodes(verdict(UZ, 'latin', 'uz', reply, none))).toContain(`number_unsourced:${figure}`);
  });

  it.each([
    ['Narxni 5 daqiqada hisoblab beraman.', '5'],
    ['Narxni 15 daqiqada hisoblab beraman.', '15'],
    ['Sizning 100 kub yukingiz omborga keldi.', '100'],
    ['Mashina uchun eng kamida 100 kub kerak.', '100'],
  ])('«%s», on the seeded knowledge, borrows no fact’s figure in another unit (%s)', (reply, figure) => {
    expect(blockCodes(uz(reply))).toContain(`number_unsourced:${figure}`);
  });

  it('…nor in Russian', () => {
    expect(blockCodes(verdict(RU, 'cyrillic', 'ru', 'Ваш груз придёт примерно за 2-5 дней.', none))).toContain('number_unsourced:2');
  });

  it.each([
    ['Mashina uchun eng kamida 1 kub yoki 100 kg kerak.'],
    ['Avia bilan eng kamida 1 kg, taxminan 2-5 kunda yetib boradi.'],
  ])('«%s» says the rule as the prompt tells it', (reply) => {
    expect(verdict(UZ, 'latin', 'uz', reply, none).ok).toBe(true);
  });

  it('…and so in Russian', () => {
    expect(verdict(RU, 'cyrillic', 'ru', 'Минимум для машины — 1 куб или 100 кг.', none).ok).toBe(true);
    expect(verdict(RU, 'cyrillic', 'ru', 'Авиа: от 1 кг, примерно 2-5 дней.', none).ok).toBe(true);
  });

  it('a day count naming no road is the truck’s: the transit fact still vouches for it', () => {
    expect(uz('Assalomu alaykum! Yuk odatda 15–25 kunda keladi. Yukingiz necha kub?').ok).toBe(true);
  });
});

describe('review — P1: the markers the model writes, and the price a marker must never swallow', () => {
  it.each([
    ["Narxni hisoblashim uchun yozing:\n1. **Tovar nomi**\n2. **Hajmi (kub)**"],
    ["Narxni hisoblashim uchun yozing:\n1.Tovar nomi\n2.Hajmi\n3.Og'irligi"],
    ["Narxni aytishim uchun 1) tovar nomi, 2) hajmi, 3) og'irligi kerak."],
    ['Для расчёта стоимости напишите 1) товар 2) объём 3) вес.'],
    ["Narxni hisoblashim uchun yozing:\n1 - tovar nomi\n2 - hajmi\n3 - og'irligi"],
    ['Narxni hisoblashim uchun yozing:\n**1.** Tovar nomi\n**2.** Hajmi'],
    ['Narxni hisoblashim uchun yozing:\n📦 1. Tovar nomi\n📏 2. Hajmi'],
  ])('«%s» holds no figure', (text) => {
    expect(extractNumbers(text)).toEqual([]);
  });

  it.each([
    ["Ikki yo'l bor:\n1. Avia — narxi kg uchun 2. Avto — narxini hisoblab beraman.", 2],
    ['Variantlar:\n1. Avia, kg narxi\n2. Avto, kub narxi 3. dollar atrofida', 3],
    ['Narx: 1️⃣ avia kg 2️⃣ dollar', 2],
    ['Варианты:\n1) авиа — цена за кг 2) доллара\n3) авто', 2],
    ['Narx:\n1) avia\n2) dollar atrofida', 2],
    ['Variantlar: 1) avia, narxi kg uchun 2) avto, narxi kub uchun', 2],
  ])('«%s» keeps its price %d — and is refused', (text, price) => {
    expect(extractNumbers(text).some((f) => f.value === price && f.kind === 'money')).toBe(true);
    expect(uz(text).ok).toBe(false);
  });

  it('a dash between figures is a range, never a marker', () => {
    expect(extractNumbers('Yuk:\n1 - 3 kunda').map((f) => f.value)).toEqual([1, 3]);
  });
});

describe('review — P5: an asking count with OUR delivering verb, or a certainty, is a promise', () => {
  it.each([
    ["Necha kunda kerak bo'lsa, shuncha kunda albatta yetkazib beramiz, kelishdikmi?"],
    ["Necha kunda kerak bo'lsa, albatta o'sha muddatda yetkazamiz?"],
    ["Sizga necha kunda kerak bo'lsa, o'sha necha kunda yetkazib beramiz?"],
    ['Неча кунда керак бўлса, шунча кунда албатта етказамиз?'],
    ["Necha kunda kerak bo'lsa, albatta o'sha kunda yetib keladi?"],
  ])('«%s»', (text) => {
    expect(promiseHits(text)).toContain('dispatch_promise');
  });

  it('…while the customer’s own need, asked, still passes', () => {
    expect(promiseHits('Yuk qachon kerak, necha kunda yetib kelishi kerak?')).toEqual([]);
  });
});

describe('review — P6: every apostrophe people type is the one the rules spell', () => {
  it('folds «`», «´», «′», «ʹ» as it folds «ʼ» — before NFKC makes a space of «´»', () => {
    expect(normalizeDigits('bo`lmaydi to´laysiz bo′lmaydi boʹlmaydi vaʼda')).toBe("bo'lmaydi to'laysiz bo'lmaydi bo'lmaydi va'da");
  });

  it.each([
    ['Hech qanday muammo bo`lmaydi.', 'guarantee'],
    ['Hech qanday muammo bo´lmaydi.', 'guarantee'],
    ['Hech qanday muammo bo′lmaydi.', 'guarantee'],
    ['Yukni to`lovsiz olib ketishingiz mumkin.', 'credit_release'],
    ['Pulni keyin to´laysiz.', 'credit_release'],
    ['Sug`urta ham qilib beramiz.', 'free_extras'],
    ['Sug´urta ham qilib beramiz.', 'free_extras'],
  ])('«%s» is a %s, as it was with «\'» (passed on both trees)', (text, category) => {
    expect(promiseHits(text)).toContain(category);
  });
});

describe('review — G2 reads the vague count in its genitive', () => {
  it('«в течение нескольких дней» is a dispatch promise; G1 still states no figure in it', () => {
    expect(promiseHits('Отправим груз в течение нескольких дней.')).toContain('dispatch_promise');
    expect(unverifiableNumeral(normalizeDigits('Расчёт займёт несколько дней.'))).toBeNull();
  });
});

describe('review — the prompt says what the check now does', () => {
  it('rule 3’s single question is a preference the card warns about, and the header says warnings do not stop a draft', () => {
    const head = stableHead({ styleGuide: null, facts: [] });
    expect(head).not.toMatch(/ko'pi bilan BITTA/u);
    expect(head).toMatch(/Imkon qadar savol belgisi bitta bo'lsin — bir nechtasi ogohlantirish/u);
    expect(head).toMatch(/"ogohlantirish" deyilgani to'xtatmaydi/u);
  });
});

describe('review — the incident’s replies still pass whole', () => {
  it.each([
    ["Assalomu alaykum! Narxni hisoblashim uchun yozing:\n1. **Tovar nomi**\n2. **Hajmi (kub)**\n3. **Og'irligi (kg)**"],
    ["Assalomu alaykum! Narxni aytishim uchun 1) tovar nomi, 2) hajmi, 3) og'irligi kerak."],
    ['Bir daqiqa, hozir aniqlab beraman. Yukingiz necha kub va necha kg?'],
    ["Assalomu alaykum! Ikki yo'l bor: avia va avto. Yukingiz necha kg?"],
  ])('uz Latin: «%s»', (reply) => {
    const r = uz(reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('ru and uz Cyrillic', () => {
    expect(ru('Здравствуйте! Для расчёта стоимости напишите 1) товар 2) объём 3) вес.').ok).toBe(true);
    expect(uzc('Ассалому алайкум! Бир дақиқа, ҳозир аниқлаб бераман. Юкингиз неча куб?').ok).toBe(true);
    expect(en('Hello! The quote is free: what are the goods, the volume and the weight?').ok).toBe(true);
  });
});

/**
 * The round reviewed a second time (two skeptics per finding, every case re-run against a4e1b1c and HEAD): six
 * more doors the softenings had opened beside themselves, and one false warning. Each BLOCK here passed on HEAD
 * and is pinned shut; each pass beside it is a reply the incident's shape must keep.
 */
const UZ3 = ['Assalomu alaykum', '3 kub yuk bor', 'narxi qancha', 'Xitoydan'];
const RU3 = ['Здравствуйте', 'есть груз 3 куба', 'сколько стоит', 'из Китая'];
const EN3 = ['Hello', 'I have 3 m3 of cargo', 'how much', 'from China'];

describe('second review — a price spelled out in a reply that prices it: the old door, beside the neighbour test', () => {
  it.each([
    [UZ3, 'latin', 'uz', "3 kub yukingiz uchun besh yuz atrofida bo'ladi."],
    [UZ3, 'latin', 'uz', "3 kub bo'lsa, hammasi bo'lib ikki ming atrofida chiqadi."],
    [UZ3, 'latin', 'uz', 'Sizning 3 kub yukingiz taxminan ming ikki yuzga tushadi.'],
    [UZ3, 'latin', 'uz', "Yukingiz 3 kub. Hammasi bo'lib to'rt yuz ellik chiqadi."],
    [UZ3, 'latin', 'uz', "3 kub yukingizga yo'l haqi uch yuz ellik atrofida."],
    [UZ3, 'latin', 'uz', 'Narx dollarda hisoblanadi. Sizning yukingizga besh yuz chiqadi.'],
    [UZ3, 'latin', 'uz', 'Narx:\nming ikki yuz atrofida.'],
    [UZ3, 'latin', 'uz', 'Narxi:\n1. ming\n2. ming besh yuz'],
    [UZ3, 'latin', 'uz', '3 kub uchun narxlar:\n• Avto — ming ikki yuz\n• Avia — besh yuz'],
    [RU3, 'cyrillic', 'ru', 'За ваши 3 куба выйдет примерно тысяча двести.'],
    [RU3, 'cyrillic', 'ru', 'Для 3 кубов итого получится около двух тысяч.'],
    [RU3, 'cyrillic', 'ru', 'Цены за ваши 3 куба:\n• Авто — тысяча двести\n• Авиа — пятьсот'],
    // Passed on both trees: the sentence split took «пятьсот» from its currency.
    [RU3, 'cyrillic', 'ru', 'Цена считается в долларах. Ваш груз обойдётся в пятьсот.'],
    [EN3, 'latin', 'en', 'For your 3 m3 it will be around twelve hundred.'],
    [EN3, 'latin', 'en', 'Your 3 m3 will come to roughly fifteen hundred, all in.'],
  ] as const)('«%s» … «%s» is a price nothing vouches for', (lines, script, language, reply) => {
    expect(unverifiableNumeral(normalizeDigits(reply))).toBe('word_numeral');
    const r = verdict(lines, script, language, reply);
    expect(blockCodes(r)).toContain('number_unverifiable:word_numeral');
    expect(r.ok).toBe(false);
  });

  it.each([
    // A count of warehouses, of things he is asked for: no measure before it, no total, no priced heading.
    ['Uch omborimiz bor: Ivu, Guanchjou va Xorgos. Yukingiz necha kub?'],
    ["Narxni aytishim uchun ikki ma'lumot kerak: kub va kg."],
    ['Для расчёта нужны две вещи: объём (куб) и вес (кг).'],
    ["Yukingiz 2 kub bo'lsa, ikki xil yo'l bor: avia va avto."],
    ['Ikki savol: necha kub va necha kg?'],
    ['Two quick questions: volume (m3) and weight (kg)?'],
  ])('«%s» states no figure', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBeNull();
  });

  it('…and a greeting that counts the warehouses keeps its ✅', () => {
    const r = uz('Assalomu alaykum! Uch omborimiz bor: Ivu, Guanchjou va Xorgos. Yukingiz necha kub va necha kg?');
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('second review — the company’s payment rule is taken back by any other statement of the reply', () => {
  it.each([
    ['Оплата по прибытии груза в Ташкент, перед получением. Но можно и позже, когда вам удобно.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. Но забрать груз можно и раньше.'],
    ['Оплата при получении, перед выдачей груза. Если нужно, выдадим и раньше.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. Если денег сразу нет — договоримся.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. А если не успеете — ничего страшного, отдадим.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. Для постоянных клиентов — по договорённости.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. Это правило, но не для вас.'],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Xohlasangiz keyinroq ham bo'ladi."],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Lekin yukni avval olib ketsangiz ham bo'ladi."],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Pul bo'lmasa, kelishib olamiz."],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Ammo bu qat'iy emas."],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Doimiy mijozlarga esa keyin ham mumkin."],
    ['Тўловни юк келганда қиласиз, юкни олишдан олдин. Хоҳласангиз кейинроқ ҳам бўлади.'],
    ['Payment on arrival, before you collect. Though you can collect first if that suits you.'],
    ['Payment on arrival, before collection. We can wait a bit for the money if needed.'],
    ['Payment upon arrival, before collection. That said, it’s flexible.'],
    // A statement further on takes it back as well as the next one.
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Yukingiz necha kub? Xohlasangiz keyinroq ham bo'ladi."],
  ])('«%s» is still credit', (text) => {
    expect(promiseHits(text)).toContain('credit_release');
  });

  it.each([
    ['Оплата по прибытии груза в Ташкент, перед получением. Расчёт пришлю чуть позже.'],
    ['Оплата по прибытии груза в Ташкент, перед получением. Груз выдаём на складе в Чукурсае.'],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Narxni keyinroq aytaman."],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Narxni darhol hisoblab beraman — yukingiz necha kub?"],
    ["To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin. Javobingizni kutamiz."],
    ["Payment on arrival, before collection. I'll send the quote later."],
    // The seed's whole answer, verbatim: «kelishiladi» is the price agreed, never a payment put off.
    [SEED_FACTS.find((f) => f.key === 'payment@1')!.answer],
  ])('«%s» is the company’s rule, and no credit', (text) => {
    expect(promiseHits(text)).not.toContain('credit_release');
  });
});

describe('second review — the free calculation lends its «free» to nothing after it', () => {
  it.each([
    ['Hisoblash bepul, boshqa xizmatlarimiz ham shunday.'],
    ['Hisoblash bepul. Omborda saqlash ham xuddi shunday.'],
    ["Hisoblash bepul, birinchi yukingiz ham shunday bo'ladi."],
    ['Hisoblash bepul. Bojxona rasmiylashtiruvi ham bizdan.'],
    ["Hisoblash bepul. Saqlash uchun ham hech narsa so'ramaymiz."],
    ['Ҳисоблаш бепул, бошқа хизматларимиз ҳам шундай.'],
    ['Расчёт бесплатный, как и все наши услуги.'],
    ['Расчёт бесплатный. Остальное — тоже.'],
    // Only `ALSO_ALONE` reads this one: it crossed no dash.
    ['Расчёт бесплатный. Это — тоже.'],
    ['Расчёт бесплатный. Хранение — аналогично.'],
    ['Расчёт бесплатный. Как и упаковка.'],
    ['Расчёт бесплатный. Растаможку тоже берём на себя.'],
    ['Расчёт бесплатный. За хранение тоже ничего не берём.'],
    ['The quote is free, and so is everything else.'],
    ['The quote is free, just like all our services.'],
    ['The quote is free. Same goes for storage.'],
    ['The quote is free. Storage is on us as well.'],
  ])('«%s» promises a free service', (text) => {
    expect(promiseHits(text)).toContain('free_extras');
  });

  it.each([
    ['Narxni hisoblash bepul. Yetkazish narxini ham hisoblab beraman.'],
    ['Расчёт бесплатный. Стоимость хранения тоже посчитаю.'],
    ['Narxni hisoblash bepul. Shunday qilib, yukingiz necha kub?'],
    ['Расчёт бесплатный. Так же напишите вес груза.'],
    ['Расчёт бесплатный. Доставка занимает 15–25 дней.'],
    ['The quote is free. You can rely on us.'],
    ['Расчёт бесплатный. Напишите, как и когда отправляете?'],
  ])('«%s» says the calculation is free, and nothing else', (text) => {
    expect(promiseHits(text)).not.toContain('free_extras');
  });
});

describe('second review — a deadline pointed back at is a dispatch promise, after the question too', () => {
  it.each([
    ['Necha kunda kerak? Shuncha kunda yetkazib beramiz.'],
    ['Yuk necha kunda yetib kelishi kerak? Biz shu muddatda olib kelamiz.'],
    ['Yuk necha kunda kerak? Aytgan kuningizga yetib keladi.'],
    ["Necha kunda yetib kelishini xohlaysiz? Muammo yo'q, o'sha kunga keladi."],
    ['Necha kunda kerak? Aytgan muddatingizda yetkazamiz.'],
    ['Юк неча кунда керак? Шунча кунда етказиб берамиз.'],
    ['Через сколько дней вам нужно? Доставим в этот срок.'],
    ['How many days do you need it in? We will deliver by then.'],
    // After his question, a hedge does not make his deadline ours to estimate.
    ['Necha kunda kerak? Taxminan shuncha kunda yetkazib beramiz.'],
  ])('«%s»', (text) => {
    expect(promiseHits(text)).toContain('dispatch_promise');
  });

  it('…and the card loses its ✅', () => {
    expect(blockCodes(uz('Necha kunda kerak? Shuncha kunda yetkazib beramiz.'))).toContain('promise:dispatch_promise');
  });

  it.each([
    ['Yuk qachon kerak, necha kunda yetib kelishi kerak?'],
    ['Shu muddatda yetib kelishi kerakmi?'],
    // Our own estimate pointed back at, hedged, with no deadline of his asked.
    ['Avto kargo odatda 15–25 kunda keladi. Sizning yukingiz ham taxminan shu muddatda keladi.'],
  ])('«%s» promises nothing', (text) => {
    expect(promiseHits(text)).not.toContain('dispatch_promise');
  });
});

describe('second review — a vague count of days the cargo comes in is G1’s figure, as it was at a4e1b1c', () => {
  it.each([
    [UZ, 'latin', 'uz', 'Yukingiz taxminan bir necha kunda Toshkentga yetib keladi.'],
    [UZ, 'latin', 'uz', "Taxminan bir necha haftada Toshkentda bo'ladi."],
    [UZ, 'latin', 'uz', 'Odatda bir necha kunda yetkazamiz.'],
    [RU, 'cyrillic', 'ru', 'Груз придёт примерно через несколько дней.'],
    [RU, 'cyrillic', 'ru', 'Ваш груз доставим примерно за несколько дней.'],
    [RU, 'cyrillic', 'ru', 'Обычно груз приходит за пару дней.'],
    [['Hello', 'I have cargo'], 'latin', 'en', 'We usually deliver within a couple of days, approximately.'],
    [UZC, 'cyrillic', 'uz_cyrl', 'Юкингиз тахминан бир неча кунда етиб келади.'],
  ] as const)('«%s» … «%s» is a delivery time nothing vouches for', (lines, script, language, reply) => {
    expect(vagueTravelTime(reply)).toBe(true);
    expect(blockCodes(verdict(lines, script, language, reply))).toContain('number_unverifiable:word_numeral');
  });

  it.each([
    ["Yuk necha kunda kelishi yo'nalishga bog'liq."],
    ['Narxni bir necha daqiqada hisoblab beraman.'],
    ['Расчёт займёт несколько дней.'],
    ['Javob bir necha soatda keladi.'],
    ['Mashina har bir necha kunda chiqadi.'],
  ])('«%s» is no time the cargo comes in', (text) => {
    expect(vagueTravelTime(text)).toBe(false);
  });
});

describe('second review — the company’s minimum vouches for a minimum, on its own road, and for nothing else', () => {
  const none: KbHit[] = [];
  const avia = { aviaOnly: true, askedMode: 'air' as const };
  it.each([
    ['Avia orqali eng kamida 100 kg dan qabul qilamiz.', '100', avia],
    ['Avia orqali eng kamida 1 kub dan qabul qilamiz.', '1', avia],
    ['Sizning 100 kg yukingiz Toshkentga yetib keldi, olib ketishingiz mumkin.', '100', {}],
    ['Sizning 1 kub yukingiz keldi.', '1', {}],
  ])('«%s» has no source for %s — with no knowledge, and on the seeded one', (reply, figure, patch) => {
    expect(blockCodes(verdict(UZ, 'latin', 'uz', reply, none, patch))).toContain(`number_unsourced:${figure}`);
    expect(blockCodes(verdict(UZ, 'latin', 'uz', reply, FACTS, patch))).toContain(`number_unsourced:${figure}`);
  });

  it('the seed’s own sentences, and the customer’s own weight said back, still pass', () => {
    const none2: KbHit[] = [];
    expect(verdict(UZ, 'latin', 'uz', 'Avia orqali 1 kg dan qabul qilamiz, yetib borishi taxminan 2–5 kun.', none2).ok).toBe(true);
    expect(verdict(UZ, 'latin', 'uz', 'Avto orqali eng kamida 1 kub yoki 100 kg dan yuk qabul qilamiz.', none2).ok).toBe(true);
    expect(verdict(UZ, 'latin', 'uz', 'Avto orqali eng kamida 1 kub yoki 100 kg dan yuk qabul qilamiz.').ok).toBe(true);
    const his = ['Assalomu alaykum', '100 kg yuk bor', 'Xitoydan'];
    expect(verdict(his, 'latin', 'uz', 'Sizning 100 kg yukingiz Toshkentga yetib keldi, olib ketishingiz mumkin.').ok).toBe(true);
  });
});

describe('second review — the company’s own name is no colleague', () => {
  const logist = { staffNames: ['Logist Demo', 'Murod Aliyev'] };
  it.each([
    [UZ, 'latin', 'uz', 'Va alaykum assalom! GSR Logistics. Qanday yuk?'],
    [UZ, 'latin', 'uz', 'Assalomu alaykum! GSR LOGISTICS kompaniyasi. Yukingiz necha kub?'],
    [UZC, 'cyrillic', 'uz_cyrl', 'Ва алайкум ассалом! ГСР Логистикс. Қандай юк?'],
  ] as const)('«%s» … «%s» warns of no colleague', (lines, script, language, reply) => {
    const r = verdict(lines, script, language, reply, FACTS, logist);
    expect(r.warnings.filter((w) => w.code === 'staff_name')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('…while the colleague himself, named beside it, still blocks — and one word of him still warns', () => {
    expect(blockCodes(verdict(UZ, 'latin', 'uz', 'GSR Logistics. Logist Demo sizga yozadi.', FACTS, logist))).toContain('staff_name:Logist Demo');
    const word = verdict(UZ, 'latin', 'uz', 'GSR Logistics. Logistimiz sizga yozadi.', FACTS, logist);
    expect(word.warnings).toContainEqual({ rule: 'G6', code: 'staff_name', detail: 'Logist' });
  });
});

/**
 * The round reviewed a third time (an adversarial verifier ran every finding's own input, and its own attacks, on
 * HEAD, on the merged base and on a4e1b1c): the second round's doors were keyed on the words AROUND a figure, a
 * takeback, a free word or a deadline, and each was measured too narrow on one side and too wide on the other.
 * Every BLOCK here passed on HEAD (most were blocked at a4e1b1c); every pass beside it is a greeting or a
 * qualification reply HEAD refused, or a rule said again.
 */
const EN = ['Hello', 'I have cargo', 'how much', 'from China'];

describe('third review — a hundred, a thousand, a ten is a figure in any reply; a small count only beside its unit', () => {
  it.each([
    [UZ3, 'latin', 'uz', 'Yukingiz 3 kub. Besh yuz atrofida chiqadi.'],
    [UZ3, 'latin', 'uz', 'Taxminan ming ikki yuz chiqadi, 3 kub yukingiz uchun.'],
    [UZ3, 'latin', 'uz', "Besh yuz atrofida bo'ladi. Bu 3 kub uchun."],
    [RU3, 'cyrillic', 'ru', 'Выйдет примерно тысяча двести за ваши 3 куба.'],
    [RU3, 'cyrillic', 'ru', 'Ваши 3 куба посчитал. Получится около тысячи двухсот.'],
    [EN3, 'latin', 'en', 'Around twelve hundred for your 3 m3.'],
    [EN3, 'latin', 'en', 'Your cargo is 3 m3. It will come to about fifteen hundred.'],
    [UZ3, 'latin', 'uz', '3 kub yukingiz bo\'yicha hisob tayyor. Ming ikki yuz atrofida.'],
    [UZ3, 'latin', 'uz', '3 kub uchun narx —\nming ikki yuz'],
    [UZ3, 'latin', 'uz', 'Narx\nming ikki yuz atrofida'],
    [RU3, 'cyrillic', 'ru', 'Стоимость для 3 кубов —\nтысяча двести.'],
    [UZ3, 'latin', 'uz', 'Yukingiz 3 kub. Umumiy hisob: ming ikki yuz.'],
    // «yo'l» after the run counts kinds of road; after a hundred it is the road FEE.
    [UZ3, 'latin', 'uz', "3 kub yukingiz uchun besh yuz yo'l haqi chiqadi."],
    [UZ3, 'latin', 'uz', 'Narx:\n\nming ikki yuz atrofida.'],
    [RU3, 'cyrillic', 'ru', 'Итог по вашим 3 кубам\n\nтысяча двести'],
    [UZ3, 'latin', 'uz', '3 kub.\nBesh yuz.'],
    // Passed on every tree: no money word, no measure word anywhere in the reply.
    [UZ3, 'latin', 'uz', 'Avto bilan ming ikki yuz atrofida, avia bilan esa besh yuz atrofida chiqadi.'],
    [RU3, 'cyrillic', 'ru', 'Авто выйдет около тысячи двухсот, авиа — около пятисот.'],
    [EN3, 'latin', 'en', 'By truck it comes to around twelve hundred, by air about five hundred.'],
    [UZ3, 'latin', 'uz', 'Avto: ming ikki yuz atrofida. Avia: besh yuz atrofida.'],
    [EN3, 'latin', 'en', 'Truck: twelve hundred\nAir: five hundred'],
    [UZ3, 'latin', 'uz', 'Yukingiz taxminan ming ikki yuzga tushadi.'],
    [RU3, 'cyrillic', 'ru', 'Ваш груз обойдётся примерно в тысячу двести.'],
    [UZ3, 'latin', 'uz', 'Sizning yukingizga taxminan besh yuz chiqadi.'],
    [EN3, 'latin', 'en', 'Your shipment will cost about twelve hundred.'],
  ] as const)('«%s» … «%s» is a price nothing vouches for', (lines, script, language, reply) => {
    expect(unverifiableNumeral(normalizeDigits(reply))).toBe('word_numeral');
    const r = verdict(lines, script, language, reply);
    expect(blockCodes(r)).toContain('number_unverifiable:word_numeral');
    expect(r.ok).toBe(false);
  });

  it.each([
    // The teens and the tens English and Persian lacked were no numeral at all.
    ['Air freight is seventeen dollars per kilo.'],
    ['The truck is about sixty per cube.'],
    ['هفده دلار برای هر کیلو'],
    // A bare thousand in a reply that prices is the package's figure still.
    ['Narxi:\n1. ming\n2. ming besh yuz'],
    ['Narx dollarda hisoblanadi. Taxminan ming chiqadi.'],
  ])('«%s» is a figure spelled out', (text) => {
    expect(unverifiableNumeral(normalizeDigits(text))).toBe('word_numeral');
  });

  it('…and a bare thousand in a reply that prices nothing is a word', () => {
    expect(unverifiableNumeral(normalizeDigits("Bizda ming xil tovar bor, qaysi biri sizniki?"))).toBeNull();
  });

  it.each([
    [UZ, 'latin', 'uz', 'Narxni dollarda aytaman. Uch omborimizdan qaysi biriga yetkazasiz?'],
    [RU, 'cyrillic', 'ru', 'Здравствуйте! Чтобы посчитать, мне нужно всего две вещи: объём и вес.'],
    [RU, 'cyrillic', 'ru', 'Мне нужно всего две вещи: кубы и килограммы.'],
    [RU, 'cyrillic', 'ru', 'Нужно всего два значения: объём в кубах и вес в кг.'],
    [EN, 'latin', 'en', 'In total I need two numbers: m3 and kg.'],
    [EN, 'latin', 'en', 'Hi! Prices are in US dollars. Which of our three warehouses will your supplier deliver to?'],
    [UZ, 'latin', 'uz', "To'lov so'mda yoki dollarda bo'ladi. Uch omborimizdan qaysi biri yaqin?"],
    [UZ, 'latin', 'uz', 'Yukingiz necha kub, necha kg va uch omborimizdan qaysi biriga keladi?'],
    [EN, 'latin', 'en', 'How many m3 and kg, and which of our three warehouses?'],
    [UZ, 'latin', 'uz', 'Narxni aytishim uchun kerak:\n1) yuk nomi\n2) necha kub\n3) uch omborimizdan qaysi biriga topshirasiz'],
    [UZ, 'latin', 'uz', "Narxni aytishim uchun yozing:\n1. Tovar nomi\n2. Hajmi (kub)\n3. Og'irligi (kg)\nUch omborimizdan qaysi biriga keladi?"],
    [RU, 'cyrillic', 'ru', 'Здравствуйте! Укажите объём (м3) и вес (кг), а также две-три фотографии товара.'],
    [UZ, 'latin', 'uz', 'Kub va kg ni, shuningdek ikki-uch rasm yuboring.'],
    [RU, 'cyrillic', 'ru', 'Принимаем от 1 куба, у нас три склада в Китае.'],
    [RU, 'cyrillic', 'ru', 'Подскажите, пожалуйста, два момента: объём в кубах и вес в кг.'],
    [RU, 'cyrillic', 'ru', 'Нужны всего два параметра: объём и вес.'],
    [UZ, 'latin', 'uz', 'Ming marta rahmat! Narxni hisoblab beraman, yukingiz necha kub?'],
    // «Yuz» alone is a face as well — «yuz kremi» is goods — and only its neighbours make it a hundred.
    [UZ, 'latin', 'uz', 'Yuz kremi uchun narxni kub hisobida aytaman — yukingiz necha kub?'],
  ] as const)('«%s» … «%s» keeps its ✅', (lines, script, language, reply) => {
    expect(unverifiableNumeral(normalizeDigits(reply))).toBeNull();
    const r = verdict(lines, script, language, reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('third review — the minimum: its road is the one named BEFORE it, a «from» covers its pair, and nothing that came', () => {
  const none: KbHit[] = [];
  it.each([
    ['Eng kamida 1 kub yoki 100 kg qabul qilamiz. Avia orqali ham yuborish mumkin.', UZ, 'latin', 'uz'],
    ['Минимум 1 куб или 100 кг. Есть также авиа.', RU, 'cyrillic', 'ru'],
    ['Минимальная партия — 1 куб или 100 кг. Авиа — от 1 кг.', RU, 'cyrillic', 'ru'],
    ['The minimum is 1 m3 or 100 kg. Air freight is also available.', EN, 'latin', 'en'],
    ['Biz 1 kub yoki 100 kg dan qabul qilamiz.', UZ, 'latin', 'uz'],
    ['Принимаем от 1 куба или 100 кг.', RU, 'cyrillic', 'ru'],
    ['We accept from 1 m3 or 100 kg.', EN, 'latin', 'en'],
    ["Agar yukingiz 1 kub yoki 100 kg dan kam bo'lsa, qabul qilolmaymiz.", UZ, 'latin', 'uz'],
    ['Если меньше 1 куба или 100 кг, то не принимаем.', RU, 'cyrillic', 'ru'],
    ["Yukingiz kamida 1 kub yoki 100 kg bo'lishi kerak.", UZ, 'latin', 'uz'],
    ['Avia orqali yuboramiz. Eng kamida 1 kg qabul qilamiz.', UZ, 'latin', 'uz'],
  ] as const)('«%s» says the company’s minimum — with no knowledge and on the seeded one', (reply, lines, script, language) => {
    expect(blockCodes(verdict(lines, script, language, reply, none))).toEqual([]);
    expect(blockCodes(verdict(lines, script, language, reply))).toEqual([]);
  });

  it('…and a day count naming no road is the truck’s, whatever is named after it (blocked on every tree)', () => {
    expect(uz("Yuk odatda 15–25 kunda keladi. Avia orqali ham bo'ladi.").ok).toBe(true);
  });

  it.each([
    ['Yukingizdan kamida 100 kg Toshkentga yetib keldi.', UZ, 'latin', 'uz', '100'],
    ['100 kg dan ortiq yukingiz Toshkentga yetib keldi.', UZ, 'latin', 'uz', '100'],
    ['Груз от 100 кг уже прибыл в Ташкент.', RU, 'cyrillic', 'ru', '100'],
    ['Omborda kamida 100 kg yukingiz bor.', UZ, 'latin', 'uz', '100'],
    ['Your cargo of at least 100 kg has arrived.', EN, 'latin', 'en', '100'],
    ['Avia orqali yuboramiz. Eng kamida 100 kg.', UZ, 'latin', 'uz', '100'],
  ] as const)('«%s» is no minimum the company states — no source for %s', (reply, lines, script, language, figure) => {
    expect(blockCodes(verdict(lines, script, language, reply, none))).toContain(`number_unsourced:${figure}`);
    expect(blockCodes(verdict(lines, script, language, reply))).toContain(`number_unsourced:${figure}`);
  });
});

describe('third review — the payment rule is taken back by a softening in any words, and never by the rule said again', () => {
  const R = 'Оплата по прибытии груза в Ташкент, перед получением.';
  const U = "To'lovni yuk Toshkentga kelganda qilasiz, yukni olishdan oldin.";
  const E = 'Payment on arrival, before collection.';
  it.each([
    [`${R} Но если что, подождём.`],
    [`${R} Хотя можно обсудить.`],
    [`${R} Но мы всегда идём навстречу.`],
    [`${R} Но бывают исключения.`],
    [`${R} Но для вас сделаем исключение.`],
    [`${U} Lekin sizga yon beramiz.`],
    [`${U} Ammo shoshilmasangiz ham bo'ladi.`],
    [`${U} Lekin istisnolar bo'lishi mumkin.`],
    [`${U} Biroq sizga ishonamiz, yukni beraveramiz.`],
    [`${E} But no rush.`],
    [`${E} We can be lenient.`],
    [`${E} Exceptions are possible.`],
    // A contrast turned to the handover or the money, in words no list holds.
    [`${U} Lekin yukni olib ketishingiz mumkin.`],
    [`${E} But you can collect it whenever.`],
    [`${E} We can wait for you to pay.`],
    [`${R} Оплату можно обсудить.`],
    [`${U} Doimiy mijozlarimizga boshqacha.`],
    [`${R} Оплатить можно и позже.`],
    [`${R} Но забрать можно и сразу.`],
  ])('«%s» is still credit', (text) => {
    expect(promiseHits(text)).toContain('credit_release');
  });

  it.each([
    [`${R} После оплаты груз можно забрать сразу.`],
    [`${U} To'lovdan keyin olib ketasiz.`],
    [`${U} To'lovni qilgach, keyin olib ketishingiz mumkin.`],
    [`${U} Avval to'lov, keyin olib ketish.`],
    [`${U} Narxni kelishib olamiz.`],
    [`${R} О цене договоримся.`],
    [`${E} After payment we hand it over first thing.`],
    [`${R} Ждём ваш ответ.`],
    [`${R} Но сначала напишите объём и вес.`],
    [`${U} Lekin yukingiz necha kub?`],
    [`${U} Biz sizni omborda kutamiz.`],
    [`${R} Цену можно обсудить.`],
    [`${R} Сначала оплатите, а потом забирайте груз.`],
    [`${E} But when will you collect it?`],
    // Paying EARLY is no credit — refused on HEAD as the bare «можно и раньше».
    [`${R} Оплатить можно и раньше.`],
    [`${R} Можете оплатить и раньше, если удобно.`],
  ])('«%s» is the company’s rule, and no credit', (text) => {
    expect(promiseHits(text)).not.toContain('credit_release');
  });
});

describe('third review — nothing lends the free calculation to another service, and a request or a question borrows nothing', () => {
  it.each([
    ["Hisoblash bepul. Qadoqlashni esa sovg'a qilamiz."],
    ['Расчёт бесплатный. Упаковку дарим.'],
    ["The quote is free. Storage won't cost you anything either."],
    ['Расчёт бесплатный. Хранение не оплачивается.'],
    ['Hisoblash bepul. Yetkazishni ham hisobimizga olamiz.'],
    ['Расчёт бесплатный. Доставку берём на свой счёт.'],
    ['The quote is free. We cover the packing.'],
    ["Hisoblash bepul. Saqlash esa — bizdan sovg'a."],
    // A statement about calculating no longer hides the expense it names.
    ['Расчёт бесплатный. Доставку тоже рассчитываем за наш счёт.'],
    ['The quote is free. Delivery we also calculate at our own expense.'],
    ["Hisoblash bepul. Hech narsa so'ramaymiz."],
    ['The quote is free. So is storage.'],
  ])('«%s» promises a free service', (text) => {
    expect(promiseHits(text)).toContain('free_extras');
  });

  it.each([
    ["Hisoblash bepul. Qolgan ma'lumotlarni ham yozib yuboring."],
    ['Расчёт бесплатный. Остальные данные тоже пришлите.'],
    ['The quote is free. Please send the rest of the details as well.'],
    ['Hisoblash bepul. Qolgan savollaringizni ham yozing.'],
    ["Hisoblash bepul. Boshqa xizmatlarimiz haqida ham so'rashingiz mumkin."],
    ['Расчёт бесплатный. Также можем рассказать о других услугах.'],
    ['The quote is free. We also offer other services, ask me anytime.'],
    ['Hisoblash bepul. Yetkazish narxini ham aytaman.'],
    ['Расчёт бесплатный. Стоимость доставки тоже скажу.'],
    ['The quote is free. So are you shipping by truck or by air?'],
    ['The quote is free. So do you have the volume in m3?'],
    ['Расчёт бесплатный. Как и обычно, нужен объём и вес.'],
    ["Hisoblash bepul. Hisoblash uchun hech narsa so'ramaymiz."],
    ['The quote is free. We cover all of Uzbekistan.'],
    // Passed on no tree: the doing of the calculation is the calculation.
    ['Расчёт сделаем бесплатно.'],
  ])('«%s» says the calculation is free, and nothing else', (text) => {
    expect(promiseHits(text)).not.toContain('free_extras');
  });
});

describe('third review — his deadline met is a promise whatever its verb; an «on time» that says why or if is not', () => {
  it.each([
    ['Necha kunda kerak? Shunga moslab yetkazib beramiz.'],
    ['Когда вам нужно? Успеем к нужному сроку.'],
    ['Скажите дату — привезём к ней.'],
    ["When do you need it? We'll get it to you in time."],
    ['Necha kunda kerak? Ulguramiz.'],
    ["How many days do you have? We'll make the deadline."],
    ['К какому числу нужно? Доставим к нему.'],
    ['Через сколько дней нужно? Уложимся в ваш срок.'],
    ['Yuk qachon kerak? Avia bilan ulguramiz.'],
    // The condition is his; the promise in the clause it serves is ours.
    ["Agar 10 kunda kerak bo'lsa, shuncha kunda yetkazamiz."],
  ])('«%s»', (text) => {
    expect(promiseHits(text)).toContain('dispatch_promise');
  });

  it.each([
    ["Yukni o'z vaqtida yetkazish uchun necha kub ekanini bilishim kerak."],
    ['Чтобы доставить вовремя, нам нужно знать объём и вес.'],
    ['To ship on time, we need the volume and weight.'],
    ["Yuk qachon kerak? Agar tez kerak bo'lsa, shu muddatda yetib kelishi uchun avia tavsiya qilaman."],
    ['Ulgurmaymiz, afsuski.'],
    ['Не успеем к этому сроку, лучше авиа.'],
    ["We won't make the deadline by truck."],
    ['Necha kunda kerak? Ulgurasizmi?'],
  ])('«%s» promises nothing', (text) => {
    expect(promiseHits(text)).not.toContain('dispatch_promise');
  });
});

describe('third review — a vague time the cargo or the trip takes is G1’s figure with no verb at all; the supplier’s, a time ago, the quote’s are not', () => {
  it.each([
    [UZ, 'latin', 'uz', 'Bir necha kun ichida yukingiz Toshkentda.'],
    [RU, 'cyrillic', 'ru', 'Пара дней — и груз у вас.'],
    [EN, 'latin', 'en', "A few days and it's at your door."],
    [EN, 'latin', 'en', 'Delivery takes a couple of days.'],
    [UZ, 'latin', 'uz', "Yo'lda bir necha kun bo'ladi, xolos."],
    [EN, 'latin', 'en', 'Shipping takes just a few days.'],
    [EN, 'latin', 'en', 'Your goods will be with you in a few days.'],
    [RU, 'cyrillic', 'ru', 'Через пару дней груз будет у вас.'],
  ] as const)('«%s» … «%s» is a delivery time nothing vouches for', (lines, script, language, reply) => {
    expect(vagueTravelTime(reply)).toBe(true);
    expect(blockCodes(verdict(lines, script, language, reply))).toContain('number_unverifiable:word_numeral');
  });

  it.each([
    ['Поставщик обычно отправляет товар на наш склад за пару дней.'],
    ['Yetkazib beruvchi odatda bir necha kunda omborimizga olib keladi.'],
    ['Yukingiz bir necha kun oldin keldi.'],
    ['Yukingiz bir necha kundan beri omborda.'],
    ['Bir necha kun ichida javob beraman.'],
    ['Yetkazib berish narxini bir necha daqiqada aytaman.'],
  ])('«%s» is no time the cargo comes in', (text) => {
    expect(vagueTravelTime(text)).toBe(false);
  });

  it.each([
    [UZ, 'latin', 'uz', 'Narxni bir necha daqiqada hisoblab yuboraman.'],
    [RU, 'cyrillic', 'ru', 'Расчёт отправлю через пару часов.'],
    [UZ, 'latin', 'uz', 'Hisobni bir necha soatda yuboraman.'],
    [RU, 'cyrillic', 'ru', 'Пришлю расчёт через пару часов.'],
    [EN, 'latin', 'en', "I'll send you the quote in a few hours."],
  ] as const)('«%s» … «%s» sends the quote, not the cargo, and keeps its ✅', (lines, script, language, reply) => {
    expect(promiseHits(reply)).not.toContain('dispatch_promise');
    const r = verdict(lines, script, language, reply);
    expect(blockCodes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a definite count of minutes for the quote is a figure still, as its digits are (P7)', () => {
    expect(unverifiableNumeral(normalizeDigits('Ikki daqiqada hisoblab beraman.'))).toBe('word_numeral');
  });
});

describe('third review — the company’s name with its case ending is no colleague either', () => {
  const logist = { staffNames: ['Logist Demo', 'Murod Aliyev'] };
  it.each([
    [['Assalomu alaykum'], 'latin', 'uz', 'Salom! GSR Logistikaga xush kelibsiz. Yukingiz qayerdan?'],
    [['Assalomu alaykum'], 'latin', 'uz', 'Assalomu alaykum! GSR Logisticsga murojaat qilganingiz uchun rahmat.'],
    [['Ассалому алайкум'], 'cyrillic', 'uz_cyrl', 'Ассалому алайкум! ГСР Логистикага хуш келибсиз.'],
  ] as const)('«%s» … «%s» warns of no colleague', (lines, script, language, reply) => {
    const r = verdict(lines, script, language, reply, FACTS, logist);
    expect(r.warnings.filter((w) => w.code === 'staff_name')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('…while «GSR logistimiz» — the company’s logist — still warns', () => {
    const r = verdict(['Assalomu alaykum'], 'latin', 'uz', 'GSR logistimiz sizga yozadi.', FACTS, logist);
    expect(r.warnings).toContainEqual({ rule: 'G6', code: 'staff_name', detail: 'Logist' });
  });
});
