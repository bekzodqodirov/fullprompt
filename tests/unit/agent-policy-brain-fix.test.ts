import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import type { KbHit } from '@/modules/wms/agent/kb';
import { AGENT_LOCALES } from '@/modules/wms/agent/locale';
import { customerSources, extractNumbers, factSources, oneModeIn, type NumberSource } from '@/modules/wms/agent/numbers';
import { placesOf, quoteOrigin, zoneForOrigin } from '@/modules/wms/agent/origin';
import {
  checkAgentReply,
  EXCLUSION_SENTENCE,
  promiseHits,
  WAREHOUSE_SENTENCES,
  type PolicyInput,
} from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import { runTool, type ToolEnv } from '@/modules/wms/agent/tools';
import { calcFromOurWarehouse } from '@/modules/wms/agent/types';

/**
 * The second review of the brain package's fix round (wf2-brain-fix), each
 * finding against the exact text the reviewers ran. Fixtures are literal; no
 * figure here is computed by the code under test.
 */

const base: PolicyInput = {
  body: '',
  language: 'uz',
  customerScript: null,
  numberSources: [],
  removeWhole: [],
  ownCodes: [],
  bookCodes: new Set(),
  codePrefix: 'GS',
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: [],
  askedLocation: false,
  staffNames: [],
  canary: 'zq7-canary-41',
  fingerprintPeers: 0,
  urlsToChat7d: 0,
  urlsToday: 0,
  hasEstimate: false,
  fromOurWarehouse: false,
};
const check = (patch: Partial<PolicyInput>) => checkAgentReply({ ...base, ...patch });
const codes = (patch: Partial<PolicyInput>) => check(patch).blocks.map((b) => b.code);

/** What the avia tool hands the policy for 40 kg at $17 (tools.ts `avia`), written out. */
const avia40: NumberSource[] = [
  { value: 680, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool' },
  { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool' },
  { value: 2, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
  { value: 5, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
  { value: 40, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
];

function msg(body: string): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: new Date(),
    autoSent: false,
    editedAt: null,
    body,
  };
}

function ctxWith(body: string): AgentContext {
  const m = msg(body);
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages: [m],
    anchor: m,
    burst: [m],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs: [],
    ruleDecision: null,
  };
}

const compose: ComposeReply = {
  replyNeeded: true,
  replyText: 'x',
  language: 'uz',
  glossUz: '',
  category: 'faq',
  confidence: 0.5,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
};
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The seeded knowledge as every run's prompt carries it (kb.ts `generalFacts`). */
const SEEDED: KbHit[] = SEED_FACTS.map((f, i) => ({
  id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
  ref: `F${i}`,
  answer: f.answer,
  phones: [],
  urls: [],
}));

/** The policy over a reply, on the memory a real run would store for this chat. */
function onMemory(customer: string, reply: string): string[] {
  const memory = memoryFor(ctxWith(customer), { compose, tools: [], outcomes: [], usage }, SEEDED, 'gsr-t');
  return codes({ body: reply, numberSources: memory.sources, askedMode: memory.askedMode });
}

describe('B1, narrowed: an earlier estimate covers only a later clause with no verb of its own', () => {
  it.each([
    ['Odatda 15-25 kunda keladi, sizning yukingiz esa 2 kunda yetib keladi.'],
    ['Avia taxminan 2-5 kun, lekin yukingiz 2 kunda yetib keladi.'],
    ['Taxminan 680 $ bo‘ladi, 2 kunda jo‘natamiz.'],
    ['Mashina odatda har 3 kunda chiqadi, yukingiz 5 kunda yetib keladi.'],
    ['Обычно 15-25 дней, ваш груз придёт через 2 дня.'],
    ['Usually 15-25 days, your cargo will arrive in 2 days.'],
    ['Авиа примерно 680 $, отправим через 2 дня.'],
    ['About 680 $, we will ship it in 2 days.'],
    ['Avia bilan taxminan 680 $ bo‘ladi, mashina bilan esa 15 kunda yetib keladi.'],
    ['Odatda 15-25 kunda, lekin sizniki 5 kunda yetib keladi.'],
    ['Odatda mashina 5 kunda chiqadi, yukingiz 15 kunda yetib keladi.'],
    ['Taxminan 680 $ bo‘ladi, 2 kunda yetib kelishadi.'],
  ])('«%s» — its own verb, judged alone: a promise', (body) => {
    expect(promiseHits(body)).toContain('dispatch_promise');
  });

  it.each([
    ['Avia bilan taxminan 680 $ bo‘ladi, yetib borishi 2-5 kun, lekin sizniki 2 kun.', 'a verbless clause that turns against the estimate'],
    ['Avia odatda 2-5 kunda yetib boradi, sizniki esa 2 kunda.', '«esa» — yours, as against the estimate'],
    ['Xavotir olmang, odatda tez ishlaymiz, yetib borishi 2 kun.', 'a hedge on no figure covers no verbal noun either'],
  ])('«%s» — %s: a promise', (body) => {
    expect(promiseHits(body)).toContain('dispatch_promise');
  });

  it.each([
    ['Avia bilan taxminan 680 $ bo‘ladi, yetib borishi 2-5 kun. Boj va QQS alohida hisoblanadi.'],
    ['Авиа примерно 680 $, доставка 2-5 дней. Пошлина и НДС считаются отдельно.'],
    ["Avia odatda 2-5 kunda yetib boradi, reys bo'lsa 2 kunda."],
  ])('«%s» — the estimate said again in a verbless clause: no promise', (body) => {
    expect(promiseHits(body)).toEqual([]);
  });

  it('the dispatch case fails the whole policy on the avia tool’s own sources — it did not on e0a9a59', () => {
    const body = 'Avia bilan taxminan 680 $ bo‘ladi, yukingizni 2 kunda jo‘natamiz. Boj va QQS alohida hisoblanadi.';
    expect(codes({ body, numberSources: avia40, hasEstimate: true })).toContain('promise');
    // …and the reply he allowed passes on the same sources.
    const allowed = 'Avia bilan taxminan 680 $ bo‘ladi, yetib borishi 2-5 kun. Boj va QQS alohida hisoblanadi.';
    expect(check({ body: allowed, numberSources: avia40, hasEstimate: true }).ok).toBe(true);
  });

  it('the contrast promises need no tool: the seeded facts alone used to back them', () => {
    expect(onMemory('Qachon keladi?', 'Odatda 15-25 kunda, lekin sizniki 5 kunda yetib keladi.')).toContain('promise');
    expect(onMemory('Qachon keladi?', 'Odatda mashina 5 kunda chiqadi, yukingiz 15 kunda yetib keladi.')).toContain('promise');
  });
});

describe('a working day is a day: the duration words the reader did not know', () => {
  it.each([
    ['5 ish kunida', 'uz'],
    ['5 иш кунида', 'uz_cyrl'],
    ['через 5 рабочих дней', 'ru'],
    ['за 5 календарных дней', 'ru'],
    ['in 5 business days', 'en'],
    ['within 5 working days', 'en'],
    ['5 sutkada', 'uz'],
    ['5个工作日', 'zh'],
  ])('«%s» (%s) is a duration', (text) => {
    expect(extractNumbers(text).map((f) => f.kind)).toEqual(['duration']);
  });

  it.each([
    ['Ha, yukingiz odatda 5 ish kunida yetib keladi.', 'uz'],
    ['Обычно груз приходит примерно за 5 рабочих дней.', 'ru'],
    ['Usually it arrives in about 5 business days.', 'en'],
  ] as const)('«5 kunda kelsinmi?» backs no «%s» (B3 through a working day)', (body, language) => {
    const sources = customerSources([{ text: '5 kunda kelsinmi?', label: 'mijoz' }]);
    expect(codes({ body, language, numberSources: sources })).toContain('number_unsourced');
  });

  it('…and G2 sees the day it promises', () => {
    expect(promiseHits('Yukingiz 5 ish kunida yetib keladi.')).toContain('dispatch_promise');
    expect(promiseHits('Груз придёт через 5 рабочих дней.')).toContain('dispatch_promise');
    expect(promiseHits('It will arrive in 5 business days.')).toContain('dispatch_promise');
  });

  it('a spelled working day is a spelled duration too', () => {
    const r = check({ body: 'Yukingiz ikki ish kunida yetib keladi.' });
    expect(r.blocks).toContainEqual({ rule: 'G1', code: 'number_unverifiable', detail: 'word_numeral' });
    expect(r.blocks).toContainEqual({ rule: 'G2', code: 'promise', detail: 'dispatch_promise' });
  });
});

describe('a month is read where it is one, and only there', () => {
  it.each([
    ['Bizda 30 mayda quti bor', 'plain'],
    ['Bizda 10 mayda karobka bor', 'plain'],
    ['30 mayda qutilar', 'plain'],
    ['10 майда қути бор', 'plain'],
    ['5 mayda-chuyda narsa', 'plain'],
    ['Машина ҳафтада 2 марта чиқади', 'plain'],
    ['Ҳафтада 2 мартаба чиқади', 'plain'],
    ['Box 2 may arrive later', 'plain'],
    ['5-mayda', 'date'],
    ['5 mayda keladi', 'date'],
    ['5-mayigacha', 'date'],
    ['5-mayiga', 'date'],
    ['5-mayidan', 'date'],
    ['5-mayni', 'date'],
    ['5-mayini', 'date'],
    ['5-майигача', 'date'],
    ['5 мая', 'date'],
    ['Машина придёт 2 марта', 'date'],
    ['28 oktyabrda', 'date'],
    ['12 sentyabrda', 'date'],
    ['28-oktabrda', 'date'],
    ['5 mayli', 'plain'],
    ['5 maydon', 'plain'],
    ['5 майка', 'plain'],
  ])('«%s» → %s', (text, kind) => {
    expect(extractNumbers(text).map((f) => f.kind)).toEqual([kind]);
  });

  it('his own «30 mayda quti» is his to have repeated back', () => {
    const sources = customerSources([{ text: 'Bizda 30 mayda quti bor, hammasi 2 kub', label: 'mijoz' }]);
    expect(check({ body: 'Yaxshi, 30 mayda quti va 2 kub — hisoblatishga yubordim.', numberSources: sources }).ok).toBe(true);
  });

  it('a May date in its possessive form is a date nothing vouched for — his «5 kub» is no source of it', () => {
    const sources = customerSources([{ text: '5 kub yuk bor', label: 'mijoz' }]);
    expect(codes({ body: 'Yukingiz 5-mayigacha Toshkentga yetib keladi.', numberSources: sources })).toContain('number_unsourced');
    expect(codes({ body: 'Юкингиз 5-майигача Тошкентга етиб келади.', language: 'uz_cyrl', numberSources: sources })).toContain(
      'number_unsourced',
    );
  });

  it('«oktyabr» / «sentyabr» are dates his «28 kg» or «12 karobka» cannot back', () => {
    const sources = customerSources([{ text: '12 karobka, 28 kg', label: 'mijoz' }]);
    expect(codes({ body: 'Yukingiz taxminan 28 oktyabrda yetib keladi.', numberSources: sources })).toContain('number_unsourced');
    expect(codes({ body: 'Yukingiz 12 sentyabrda yetib keladi.', numberSources: sources })).toContain('number_unsourced');
  });

  it('the customer’s date stays the company’s to name: «Ha, 15.11 ga.» agrees to it with no verb any rule could read', () => {
    // Kept on purpose (the reviewers' nit 9a): letting his date back a reply «when it is no delivery
    // sentence» would let the elliptical yes through, and that yes is the promise.
    const sources = customerSources([{ text: '15.11 ga yetib keladimi?', label: 'mijoz' }]);
    expect(promiseHits('Ha, 15.11 ga.')).toEqual([]);
    expect(codes({ body: 'Ha, 15.11 ga.', numberSources: sources })).toContain('number_unsourced');
  });
});

describe('a day count is the time of ONE road', () => {
  it('the seeded facts say whose days they are', () => {
    const byKey = new Map(SEED_FACTS.map((f) => [f.key, f.answer]));
    const days = (key: string) =>
      factSources(byKey.get(key)!, 'x')
        .filter((s) => s.kind === 'duration')
        .map((s) => [s.value, s.mode]);
    expect(days('transit@1')).toEqual([
      [15, 'road'],
      [25, 'road'],
    ]);
    expect(days('avia@1')).toEqual([
      [2, 'air'],
      [5, 'air'],
      [2, 'air'],
    ]);
  });

  it('«Mashinada 5 kunda kelsinmi?» is never answered on the flight’s five — named or not', () => {
    expect(onMemory('Mashinada 5 kunda kelsinmi?', 'Odatda mashina bilan 5 kunda yetib keladi.')).toContain('number_unsourced');
    expect(onMemory('Mashinada 5 kunda kelsinmi?', 'Odatda 5 kunda yetib keladi.')).toContain('number_unsourced');
    expect(onMemory('Qancha kunda keladi?', 'Avia bilan taxminan 15-25 kunda yetib boradi.')).toContain('number_unsourced');
    // A range's dash is inside the figure, not between clauses: the 25 of «2–25» is the avia clause's.
    expect(onMemory('Qancha kunda keladi?', 'Avia bilan taxminan 2–25 kunda, mashina bilan odatda 15–25 kunda yetib keladi.')).toContain(
      'number_unsourced',
    );
  });

  it('…while each road’s own days pass, in the reply’s words or the customer’s', () => {
    expect(onMemory('Mashinada qancha kunda keladi?', 'Odatda 15-25 kunda yetib keladi.')).toEqual([]);
    expect(onMemory('Avia bilan qancha kunda?', 'Taxminan 2-5 kunda yetib boradi.')).toEqual([]);
    expect(onMemory('Qancha kunda keladi?', 'Avia bilan taxminan 2-5 kunda, mashina bilan odatda 15-25 kunda yetib keladi.')).toEqual([]);
  });

  it('the road the customer asked about is one road or none', () => {
    expect(oneModeIn('Mashinada 5 kunda kelsinmi?')).toBe('road');
    expect(oneModeIn('Avia bilan qancha?')).toBe('air');
    expect(oneModeIn("Temir yo'l bilan bo'ladimi?")).toBe('rail');
    expect(oneModeIn('Avia yoki mashina?')).toBeNull();
    expect(oneModeIn('Avtomat yuvish mashinasi bor')).toBe('road');
    expect(oneModeIn('Avtomatik javob')).toBeNull();
  });
});

describe('a Chinese place we have no warehouse in is priced from ours — the coast, not five cities', () => {
  const OURS: ReadonlySet<string> = new Set(['Yiwu', 'Guangzhou', 'Qashqar']);

  it.each([
    'Dongguandan 5 kub',
    'Hangzhoudan',
    '从杭州发货',
    '东莞',
    'Xiamen',
    'Tianjindan',
    'Jinhua',
    'Wenzhou',
    'Qingdao',
    'Guangdong',
    'Гуандун',
    'Hong Kong',
    'Ханчжоудан юк бор',
  ])('«%s» → our_warehouse', (text) => {
    expect(quoteOrigin(text, OURS)).toBe('our_warehouse');
  });

  it.each([
    ['کاشغر', 'western'],
    ['بار از گوانگژو', 'warehouse'],
    ['Moskvadan Toshkentga', 'unknown'],
    ['Qashqadaryoga 5 kub', 'unknown'],
    ['Andijondan Toshkentga', 'unknown'],
  ] as const)('«%s» → %s', (text, origin) => {
    expect(quoteOrigin(text, OURS)).toBe(origin);
  });

  it('a city on the China column; a warehouse’s province is no place it stands in', () => {
    expect(zoneForOrigin('Dongguan')).toBe('cn');
    expect(placesOf([{ name: 'Yiwu', address: 'Yiwu, Zhejiang' }, { name: 'GZ ombori', address: 'Baiyun, Guangzhou, Guangdong' }])).toEqual(
      new Set(['Yiwu', 'Guangzhou']),
    );
    // …so a customer naming the province is quoted with the condition.
    expect(quoteOrigin('Zhejiangdan 5 kub', placesOf([{ name: 'Yiwu', address: 'Yiwu, Zhejiang' }]))).toBe('our_warehouse');
  });

  it('a podklyuch job from Dongguan is complete, priced from our warehouses, and keeps its city', async () => {
    const env: ToolEnv = {
      ctx: ctxWith('Dongguandan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona'),
      day: '2026-10-24',
      aviaUsdPerKg: 17,
      kb: async () => [],
      chinaPlaces: async () => OURS,
    };
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] }, env);
    expect(out.checklist).toMatchObject({ complete: true, fromOurWarehouse: true, facts: { fromCity: 'Dongguan' } });
  });
});

describe('the two warehouse sentences, said in natural words and in every language', () => {
  const priced: PolicyInput = {
    ...base,
    numberSources: [{ value: 480, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool' }],
    hasEstimate: true,
    fromOurWarehouse: true,
  };
  const blocks = (body: string, language: PolicyInput['language'] = 'uz') =>
    checkAgentReply({ ...priced, body, language }).blocks.map((b) => b.code);

  it.each([
    [
      'zh',
      `大约 480 $。${EXCLUSION_SENTENCE.zh}如果您把货发到我们在中国的仓库，这是从我们仓库起的价格。从工厂到我们仓库的运费需单独计算。`,
    ],
    ['uz', `Taxminan 480 $. ${EXCLUSION_SENTENCE.uz} ${WAREHOUSE_SENTENCES.uz.condition} Zavoddan omborgacha olib kelish narxga kirmaydi, alohida hisoblanadi.`],
    ['uz', `Taxminan 480 $. ${EXCLUSION_SENTENCE.uz} ${WAREHOUSE_SENTENCES.uz.condition} Zavoddan omborgacha olib kelish narxga kirmaydi.`],
    ['uz_cyrl', `Тахминан 480 $. ${EXCLUSION_SENTENCE.uz_cyrl} ${WAREHOUSE_SENTENCES.uz_cyrl.condition} Заводдан омборгача олиб келиш нархга кирмайди.`],
    ['fa', `تقریباً 480 $. ${EXCLUSION_SENTENCE.fa} ${WAREHOUSE_SENTENCES.fa.condition} آوردن بار از کارخانه شامل قیمت نمی‌شود.`],
    // A «not» in ANOTHER clause of the sentence denies nothing about «separately».
    ['zh', `大约 480 $。${EXCLUSION_SENTENCE.zh}${WAREHOUSE_SENTENCES.zh.condition}从工厂到我们仓库的运费需单独计算，不在这个报价内。`],
    ['en', `Approximately 480 $. ${EXCLUSION_SENTENCE.en} ${WAREHOUSE_SENTENCES.en.condition} Bringing it from the factory is priced separately, not in this quote.`],
    ['ru', `Примерно 480 $. ${EXCLUSION_SENTENCE.ru} ${WAREHOUSE_SENTENCES.ru.condition} Доставка от завода до нашего склада не входит в цену.`],
    ['en', `Approximately 480 $. ${EXCLUSION_SENTENCE.en} ${WAREHOUSE_SENTENCES.en.condition} Pickup from the factory is not included.`],
  ] as const)('%s: a natural phrasing of the factory leg passes', (language, body) => {
    expect(blocks(body, language)).toEqual([]);
  });

  it.each([
    [`Taxminan 480 $. ${WAREHOUSE_SENTENCES.uz.condition} Zavoddan omborgacha olib kelish ham shu narxga kiradi, boj va QQS alohida hisoblanadi.`, 'uz'],
    [`Approximately 480 $. ${EXCLUSION_SENTENCE.en} ${WAREHOUSE_SENTENCES.en.condition} The factory pickup is included, duties are separate.`, 'en'],
    [`Примерно 480 $. ${EXCLUSION_SENTENCE.ru} ${WAREHOUSE_SENTENCES.ru.condition} Доставка от завода включена в цену, пошлина отдельно.`, 'ru'],
  ] as const)('«%s» says the factory leg is IN the price: blocked', (body, language) => {
    expect(blocks(body, language)).toContain('warehouse_condition');
  });

  it('the model is told both sentences in all six languages in the prompt (the tool: agent-answers.integration)', () => {
    const head = stableHead({ styleGuide: null, facts: [] });
    for (const l of AGENT_LOCALES) {
      expect(head, l).toContain(WAREHOUSE_SENTENCES[l].condition);
      expect(head, l).toContain(WAREHOUSE_SENTENCES[l].factory);
      expect(head, l).toContain(EXCLUSION_SENTENCE[l]);
    }
  });
});

describe('the flag the 💵 price reads off the landed draft', () => {
  it('is true only for a calc_submit stored with it — an older action, or another kind, is no', () => {
    expect(calcFromOurWarehouse([{ type: 'calc_submit', fromOurWarehouse: true }])).toBe(true);
    expect(calcFromOurWarehouse([{ type: 'set_followup' }, { type: 'calc_submit', fromOurWarehouse: true }])).toBe(true);
    expect(calcFromOurWarehouse([{ type: 'calc_submit' }])).toBe(false);
    expect(calcFromOurWarehouse([{ type: 'calc_submit', fromOurWarehouse: 'true' }])).toBe(false);
    expect(calcFromOurWarehouse([{ type: 'mute', fromOurWarehouse: true }])).toBe(false);
    expect(calcFromOurWarehouse(null)).toBe(false);
  });
});
