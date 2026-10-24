import { describe, expect, it } from 'vitest';
import { POLICY_WORDS } from '@/modules/wms/agent/card';
import { normalizeDigits } from '@/modules/wms/agent/digits';
import type { AgentContext, ChatMessage, MeasureCandidate } from '@/modules/wms/agent/context';
import { AGENT_LOCALES, type AgentLocale } from '@/modules/wms/agent/locale';
import { customerSources, extractNumbers, factSources, numberLedger, type NumberSource } from '@/modules/wms/agent/numbers';
import { aviaOrigin } from '@/modules/wms/agent/origin';
import {
  checkAgentReply,
  dayPromise,
  EXCLUSION_SENTENCE,
  promiseHits,
  textFingerprint,
  timePromise,
  WAREHOUSE_SENTENCES,
  type PolicyInput,
} from '@/modules/wms/agent/policy';
import { sameTextWarning, stripOfDraftPolicy } from '@/modules/wms/agent/policy-input';
import { priceReplyText } from '@/modules/wms/agent/price-reply';
import { memoryFor, railChat, railNote, withRailRule, type ComposeReply } from '@/modules/wms/agent/run';
import { runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * The final review's money and ban items (K1, K3, K12-K21, K29, K31, K32),
 * each the exact reply the review measured passing, now pinned refused — and
 * beside it the ordinary reply that must still pass, so a rule made too wide
 * shows here as plainly as one made too narrow.
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
const codes = (body: string, patch: Partial<PolicyInput> = {}) => checkAgentReply({ ...base, body, ...patch }).blocks.map((b) => b.code);

/** The yo'lkira tool's sources, as `yolkira` writes them. */
const yolkira: NumberSource[] = [
  { value: 330, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool', currency: 'USD', role: 'total' },
  { value: 110, kind: 'money', label: "yo'lkira tarifi (sayt)", origin: 'tool', currency: 'USD', role: 'rate' },
  { value: 15, kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
  { value: 25, kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
  { value: 3, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
  { value: 300, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
];
const quote = { numberSources: yolkira, hasEstimate: true };

describe('K12 — G11 reads the exclusion with its polarity, and the hedge in the price’s own clause', () => {
  it.each([
    ["Taxminan 330 $ bo'ladi. Boj ham shu narxga kiradi, QQS alohida.", 'uz'],
    ['Примерно 330 $, растаможка тоже входит в цену, НДС отдельно.', 'ru'],
    ['About $330. Customs duty is in the price; only VAT is separate.', 'en'],
    ['大约330美元，关税包含在运费内，增值税另行计算。', 'zh'],
  ] as const)('«%s» says customs IS in the price — G11 and G2 both refuse it', (body, language) => {
    const hit = codes(body, { ...quote, language });
    expect(hit).toContain('estimate_unhedged');
    expect(hit).toContain('promise');
  });

  it('a hedge on the DAYS does not hedge a flat price', () => {
    expect(codes('3 kub uchun narx 330 $. Yetib kelishi taxminan 15-25 kun. Boj va QQS alohida hisoblanadi.', quote)).toContain(
      'estimate_unhedged',
    );
    expect(codes("3 kub uchun taxminan 330 $ bo'ladi. Yetib kelishi taxminan 15-25 kun. Boj va QQS alohida hisoblanadi.", quote)).toEqual([]);
    // A hedge that is its own clause belongs to the next one; one right after the figure is the figure's.
    expect(codes('Taxminan, 330 $ bo‘ladi. Boj va QQS alohida hisoblanadi.', quote)).toEqual([]);
    expect(codes('330 $ atrofida bo‘ladi. Boj va QQS alohida hisoblanadi.', quote)).toEqual([]);
    expect(codes('About $330. Customs duty and VAT are calculated separately.', { ...quote, language: 'en' })).toEqual([]);
  });

  it('«约定» — agreed — is no approximation; «大约» is', () => {
    expect(codes('运费约定330美元。关税和增值税另行计算。', { ...quote, language: 'zh' })).toContain('estimate_unhedged');
    expect(codes('运费大约330美元。关税和增值税另行计算。', { ...quote, language: 'zh' })).toEqual([]);
  });

  it.each(AGENT_LOCALES.map((l) => [l]))('%s: the exclusion sentence the model is told passes', (l: AgentLocale) => {
    const approx: Record<AgentLocale, string> = { uz: 'Taxminan', uz_cyrl: 'Тахминан', ru: 'Примерно', en: 'Approximately', fa: 'تقریباً', zh: '大约' };
    expect(codes(`${approx[l]} 330 $. ${EXCLUSION_SENTENCE[l]}`, { ...quote, language: l })).toEqual([]);
  });

  it('the duty and the VAT each said apart, in two sentences, pass; a denied «alohida» does not', () => {
    expect(codes('Taxminan 330 $. Boj alohida. QQS ham alohida hisoblanadi.', quote)).toEqual([]);
    expect(codes('Taxminan 330 $. Boj va QQS alohida hisoblanmaydi.', quote)).toContain('estimate_unhedged');
    expect(codes('Taxminan 330 $. Boj va QQS bu narxga kirmaydi.', quote)).toEqual([]);
  });

  it.each([
    'Boj ham shu narxga kiradi.',
    'Boj kiritilgan.',
    'Narxda boj bor.',
    'Narxga boj ham kiradi.',
    'Бож ҳам шу нархга киради.',
    'Растаможка тоже входит в цену.',
    'В цену входит растаможка.',
    'Цена включает растаможку.',
    'Customs duty is in the price.',
    'Customs clearance is included in the price.',
    'The price covers customs.',
    'قیمت شامل گمرک است.',
    '关税包含在运费内。',
    '运费包括关税。',
  ])('G2 customs_included: «%s»', (t) => {
    expect(promiseHits(t)).toContain('customs_included');
  });

  it.each([
    'Boj va QQS bu narxga kirmaydi.',
    'Boj narx ichida emas.',
    'Boj va QQS hisobga kiritilmagan.',
    'Пошлина и НДС не входят в цену.',
    'Цена не включает растаможку.',
    'Customs duty is not included.',
    'عوارض گمرکی شامل قیمت نمی‌شود.',
    '运费不包含关税。',
    '运费不含关税。',
  ])('…and its negation is no promise: «%s»', (t) => {
    expect(promiseHits(t)).not.toContain('customs_included');
  });
});

describe('K13 — a bare figure only the money tool vouches for is a quoted price', () => {
  it.each([
    ['3 kub yukingiz uchun 330 chiqadi.', 'uz'],
    ['За 3 куба выйдет 330.', 'ru'],
    ['حدود ۳۳۰ میشه', 'fa'],
    ['大约330', 'zh'],
  ] as const)('«%s» asks the hedge, the exclusion and his warehouse condition', (body, language) => {
    const hit = codes(body, { ...quote, language, fromOurWarehouse: true });
    expect(hit).toContain('warehouse_condition');
    if (!/大约|حدود/u.test(body)) expect(hit).toContain('estimate_unhedged');
  });

  it('the ledger names it money, in dollars, beside the tool', () => {
    expect(numberLedger('3 kub yukingiz uchun 330 chiqadi.', yolkira).find((e) => e.raw.startsWith('330'))).toEqual({
      raw: '330 $',
      kind: 'money',
      source: "yo'lkira (sayt kalkulyatori)",
      currency: 'USD',
    });
  });

  it('a figure whose form says what it is — an hour, a clock — is never read as the price', () => {
    const nine: NumberSource = { value: 9, kind: 'money', label: 'x', origin: 'tool' };
    expect(numberLedger('Ombor soat 9 dan ochiq.', [nine])[0]?.kind).toBe('plain');
  });
});

describe('K14 — a date the cargo comes on is judged like a day count', () => {
  it.each([
    'Yukingiz 09.11 da albatta yetib keladi.',
    'Yukingiz 09.11 da yetib keladi.',
    'Ваш груз прибудет в Ташкент 09.11.',
    'Your cargo will arrive in Tashkent on 09.11.',
    'Yukingiz 09.11 da, albatta, yetib keladi.',
  ])('«%s» is a promise', (t) => {
    expect(timePromise(t)).toBe(true);
  });

  it.each([
    'Yetib borishi taxminan 05.11 – 09.11 (va’da emas).',
    'Yukingiz taxminan 05.11 – 09.11 oralig‘ida yetib keladi.',
    'Yukingiz 03.11 da omborga keldi.',
    'Yukingiz 03.11 da qabul qilindi va yo‘lga chiqdi.',
  ])('«%s» is not', (t) => {
    expect(timePromise(t)).toBe(false);
  });
});

describe('K15 — a day beside a coming verb, the weekdays, the weeks and the months', () => {
  it.each([
    'Ertaga yukingiz Toshkentga keladi.',
    "Yukingiz ertaga tayyor bo'ladi.",
    "Indinga yukingiz Toshkentda bo'ladi.",
    'Ertaga yukingizni olib ketasiz.',
    'Tomorrow your cargo will be in Tashkent.',
    'You will get your cargo tomorrow.',
    'Завтра получите груз.',
    '明天货就到了。',
    'فردا بار شما می‌رسد.',
    "Dushanba kuni jo'natamiz.",
    "Keyingi hafta jo'natamiz.",
    'В понедельник отправим ваш груз.',
    'We will ship it on Monday.',
    'Your cargo will arrive next week.',
    'Yukingiz yanvar oyida keladi.',
    '下周发货。',
    'Oy oxirigacha yukingiz Toshkentga yetib keladi.',
    'На следующей неделе груз будет в Ташкенте.',
    'Эртага юкингиз Тошкентга келади.',
    'Ertaga, inshaalloh, yukingiz yetib keladi.',
  ])('«%s» is a dispatch promise', (t) => {
    expect(dayPromise(t)).toBe(true);
    expect(promiseHits(t)).toContain('dispatch_promise');
  });

  it.each([
    "Mashina har dushanba jo'naydi.",
    'We ship every Monday.',
    'Yukingiz bugun Toshkentga yetib keldi.',
    "Ertaga hisob tayyor bo'ladi.",
    'Завтра не отправим.',
    'Juma aka, yukingiz Toshkentga keladi.',
    '今天已经发货了。',
    'Ertaga sizga qo‘ng‘iroq qilaman.',
    'Assalomu alaykum! Yukingiz Toshkentga yetib keldi.',
  ])('«%s» is not', (t) => {
    expect(promiseHits(t)).not.toContain('dispatch_promise');
  });
});

describe('K16 — a figure and its source are one claim only in one currency', () => {
  it.each([
    ['运费大约330元，关税和增值税另行计算。', 'zh'],
    ["Taxminan 330 so'm bo'ladi. Boj va QQS alohida hisoblanadi.", 'uz'],
    ['Примерно 330 рублей. Пошлина и НДС считаются отдельно.', 'ru'],
    ['حدود ۳۳۰ تومان. عوارض گمرکی و مالیات بر ارزش افزوده جداگانه محاسبه می‌شود.', 'fa'],
    ['About 330 euros. Customs duty and VAT are calculated separately.', 'en'],
    ['Taxminan 330 yuan. Boj va QQS alohida hisoblanadi.', 'uz'],
  ] as const)('«%s» on the tool’s 330 dollars is unsourced', (body, language) => {
    expect(codes(body, { ...quote, language })).toContain('number_unsourced');
  });

  it('the card’s line says the currency the figure was read in', () => {
    expect(numberLedger('运费大约330元', yolkira)).toEqual([{ raw: '330 yuan', kind: 'money', source: null, currency: 'CNY' }]);
    expect(numberLedger('Taxminan 330 $', yolkira)).toEqual([
      { raw: '330 $', kind: 'money', source: "yo'lkira (sayt kalkulyatori)", currency: 'USD' },
    ]);
    // A bare figure in a text naming one currency is that currency; naming two, it is no currency at all.
    expect(extractNumbers('Narx (yuanda): 480')[0]?.currency).toBe('CNY');
    expect(extractNumbers('Narx: 480, yuan yoki dollar')[0]?.currency).toBeNull();
    expect(extractNumbers('Narx: 480')[0]?.currency).toBe('USD');
  });

  it('the balance tool’s so‘m stays so‘m and its dollar equivalent dollars', async () => {
    const own: NumberSource = { value: 5_000_000, kind: 'money', label: 'mijozning balansi', origin: 'tool', currency: 'UZS', role: 'balance' };
    expect(codes("Oxirgi to'lovingiz 5 000 000 so'm.", { numberSources: [own] })).not.toContain('number_unsourced');
    expect(codes("Oxirgi to'lovingiz 5 000 000 $.", { numberSources: [own] })).toContain('number_unsourced');
  });
});

describe('K17 — a customer’s bare figure vouches for nothing; his count still does', () => {
  it.each([
    ["Ivudan 3 kub yuk, 250 bo'ladimi?", "Ha, 250 bo'ladi."],
    ['3 куба из Иу, за 250 возьмёте?', 'Да, возьмём за 250.'],
    ['3 cubic meters from Yiwu, can you do 250?', 'Yes, we can do 250.'],
  ])('«%s» → «%s» is unsourced', (said, reply) => {
    const sources = customerSources([{ text: said, label: 'mijoz #1' }]);
    expect(codes(reply, { numberSources: sources })).toContain('number_unsourced');
  });

  it('«30 mayda quti» is his count, read as one, and repeated back', () => {
    expect(extractNumbers('Bizda 30 mayda quti bor')[0]?.kind).toBe('count');
    const sources = customerSources([{ text: 'Bizda 30 mayda quti bor, hammasi 2 kub', label: 'mijoz' }]);
    expect(codes('Yaxshi, 30 mayda quti va 2 kub — hisoblatishga yubordim.', { numberSources: sources })).toEqual([]);
  });
});

describe('K20 — a percent is the company’s word', () => {
  it('his own «20%» does not confirm a duty rate; an approved fact’s does', () => {
    const his = customerSources([{ text: "Boj 20% bo'ladimi? 5 kub yuk bor", label: 'mijoz #1' }]);
    expect(codes("Ha, boj 20% bo'ladi.", { numberSources: his })).toContain('number_unsourced');
    expect(codes("QQS 12% bo'ladi.", { numberSources: customerSources([{ text: 'QQS 12% mi?', label: 'mijoz' }]) })).toContain('number_unsourced');
    expect(codes("QQS 12% bo'ladi.", { numberSources: factSources('QQS 12% hisoblanadi.', 'bilim') })).toEqual([]);
  });
});

describe('K21 — a rate vouches for a per-unit figure only, a total for the rest', () => {
  it('the rate of 110 $/kub is not the price of three cubes', () => {
    expect(codes("3 kub uchun taxminan 110 $ bo'ladi. Boj va QQS alohida hisoblanadi.", quote)).toContain('number_unsourced');
    expect(codes("3 kub uchun taxminan 330 $ bo'ladi (kubiga 110 $). Boj va QQS alohida hisoblanadi.", quote)).toEqual([]);
    expect(codes("Taxminan 330 $ (har kub uchun $110). Boj va QQS alohida hisoblanadi.", quote)).toEqual([]);
    // A rate beside its hedged total in one sentence is that estimate's arithmetic (fix round, reversing the
    // first fix's «a rate in its own clause needs its own hedge» — the tool writes «330 $ — 110 $/kub»).
    expect(codes("Taxminan 330 $, har kub uchun $110. Boj va QQS alohida hisoblanadi.", quote)).toEqual([]);
    // …but a rate in a sentence whose total is NOT hedged hedges nothing.
    expect(codes("330 $ bo'ladi, har kub uchun $110. Boj va QQS alohida hisoblanadi.", quote)).toEqual(['estimate_unhedged']);
    // …and the total is no per-unit price.
    expect(codes("Taxminan kubiga 330 $. Boj va QQS alohida hisoblanadi.", quote)).toContain('number_unsourced');
  });

  it('reads the per-unit spellings', () => {
    for (const t of ['110 $/kub', '17 $ kilosiga', '17 долларов за кг', '$17 per kg', 'kubiga 110 $', 'за 1 кг 17 $', '17美元/公斤', '每公斤17美元', '1 kub 110 $', '1 kubi 110 dollar', '1 куб — 110 $', '1 cbm = $110']) {
      const money = extractNumbers(t).filter((f) => f.kind === 'money');
      expect(money.length, t).toBe(1);
      expect(money[0]!.perUnit, t).toBe(true);
    }
    for (const t of ['3 kub uchun 330 $', 'Jami 330 $', '31 kub uchun 330 $']) {
      expect(extractNumbers(t).find((f) => f.kind === 'money')?.perUnit, t).toBeUndefined();
    }
  });
});

function msg(ref: string, body: string, direction: 'in' | 'out' = 'in'): ChatMessage {
  return {
    ref,
    id: `00000000-0000-4000-8000-${ref.slice(1).padStart(12, '0')}`,
    tgMessageId: BigInt(ref.slice(1)),
    direction,
    body,
    media: null,
    fileName: null,
    sentAt: new Date(),
    autoSent: false,
    editedAt: null,
  };
}

function ctxOf(messages: ChatMessage[], measures: MeasureCandidate[]): AgentContext {
  const lastOut = messages.map((m) => m.direction).lastIndexOf('out');
  return {
    managerUserId: '00000000-0000-4000-8000-000000000099',
    peerId: 1n,
    messages,
    anchor: messages.at(-1) ?? null,
    burst: messages.slice(lastOut + 1).filter((m) => m.direction === 'in'),
    lastOut: lastOut >= 0 ? messages[lastOut]! : null,
    identity: {
      clientId: null,
      leadId: '00000000-0000-4000-8000-000000000098',
      codes: [],
      customerName: null,
      managerName: null,
      strength: 'none',
      cargoAllowed: false,
    } as unknown as AgentContext['identity'],
    storedLocale: null,
    customerScript: null,
    measures,
    openCalcs: [],
    ruleDecision: null,
  };
}

const OURS = new Set(['Yiwu', 'Guangzhou', 'Qashqar']);
const envOf = (ctx: AgentContext, rate: number | null = 17): ToolEnv => ({
  ctx,
  day: '2026-10-24',
  aviaUsdPerKg: rate,
  kb: async () => [],
  chinaPlaces: async () => OURS,
});

describe('K21 — the tools price the customer’s NEWEST figures', () => {
  it('a corrected weight: the first reference is refused and names the newest', async () => {
    const ctx = ctxOf(
      [msg('#1', 'Shenzhendan avia 30 kg'), msg('#2', 'kechirasiz, 45 kg ekan')],
      [
        { ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' },
        { ref: 'w2', kind: 'weight', value: 45, messageRef: '#2' },
      ],
    );
    const old = await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(ctx));
    expect(old).toMatchObject({ ok: false });
    expect(old.text).toContain('w2');
    expect(old.sources).toEqual([]);
    const fresh = await runTool('avia_estimate', { weight_ref: 'w2' }, envOf(ctx));
    expect(fresh).toMatchObject({ ok: true, estimate: true });
  });

  it('the truck tool too — and the same figure stated twice is no correction', async () => {
    const ctx = ctxOf(
      [msg('#1', 'Yiwudan 3 kub 400 kg'), msg('#2', 'kechirasiz, 0.5 kub 60 kg ekan')],
      [
        { ref: 'w1', kind: 'weight', value: 400, messageRef: '#1' },
        { ref: 'v1', kind: 'volume', value: 3, messageRef: '#1' },
        { ref: 'w2', kind: 'weight', value: 60, messageRef: '#2' },
        { ref: 'v2', kind: 'volume', value: 0.5, messageRef: '#2' },
      ],
    );
    expect(await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, envOf(ctx))).toMatchObject({ ok: false });
    // The newest is below the truck's minimum — the checklist's answer, now the tool's too.
    expect((await runTool('yolkira_estimate', { weight_ref: 'w2', volume_ref: 'v2' }, envOf(ctx))).text.startsWith('below_minimum')).toBe(true);
    const twice = ctxOf(
      [msg('#1', 'Avia 40 kg'), msg('#2', 'yana 40 kg avia bilan?')],
      [
        { ref: 'w1', kind: 'weight', value: 40, messageRef: '#1' },
        { ref: 'w2', kind: 'weight', value: 40, messageRef: '#2' },
      ],
    );
    expect(await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(twice))).toMatchObject({ ok: true });
  });
});

describe('K32 — avia from «Xitoy» or a city we do not stand in carries his third-set «3»', () => {
  it('the origin of a flight: no western refusal, ours when we stand there', () => {
    expect(aviaOrigin('Shenzhendan avia', OURS)).toBe('our_warehouse');
    expect(aviaOrigin('Xitoydan avia 30 kg', OURS)).toBe('our_warehouse');
    expect(aviaOrigin('Urumchidan avia', OURS)).toBe('our_warehouse');
    expect(aviaOrigin('Qashqardan avia', OURS)).toBe('warehouse');
    expect(aviaOrigin('Yiwudan avia', OURS)).toBe('warehouse');
    expect(aviaOrigin('avia 30 kg qancha?', OURS)).toBe('unknown');
  });

  it('the tool flags it and hands the model both sentences in every language; a Yiwu flight does not', async () => {
    const w = [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' } as const];
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(ctxOf([msg('#1', 'Shenzhen zavodidan avia 30 kg qancha?')], [...w])));
    expect(out).toMatchObject({ ok: true, estimate: true, fromOurWarehouse: true });
    for (const l of AGENT_LOCALES) {
      expect(out.text, l).toContain(WAREHOUSE_SENTENCES[l].condition);
      expect(out.text, l).toContain(WAREHOUSE_SENTENCES[l].factory);
    }
    const yiwu = await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(ctxOf([msg('#1', 'Yiwudan avia 30 kg qancha?')], [...w])));
    expect(yiwu.fromOurWarehouse).toBeUndefined();
  });

  it('the run carries the flag to the policy, which asks the condition of the flight’s price', async () => {
    const ctx = ctxOf([msg('#1', 'Shenzhen zavodidan avia 30 kg qancha?')], [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(ctx));
    const memory = memoryFor(ctx, loopOf(out, compose("Avia bilan taxminan 510 $ bo'ladi. Boj va QQS alohida hisoblanadi.")), [], 'c');
    expect(memory.fromOurWarehouse).toBe(true);
    const policy = checkAgentReply({
      ...base,
      body: "Avia bilan taxminan 510 $ bo'ladi. Boj va QQS alohida hisoblanadi.",
      numberSources: memory.sources,
      hasEstimate: memory.hasEstimate,
      fromOurWarehouse: memory.fromOurWarehouse === true,
    });
    expect(policy.blocks.map((b) => b.code)).toEqual(['warehouse_condition']);
  });
});

function compose(replyText: string, patch: Partial<ComposeReply> = {}): ComposeReply {
  return {
    replyNeeded: true,
    replyText,
    language: 'uz',
    glossUz: '',
    category: 'price',
    confidence: 0.8,
    needsOwner: false,
    ownerQuestion: '',
    nextStep: 'quote',
    actions: [],
    usedFactIds: [],
    citedMessageRefs: [],
    ...patch,
  };
}

function loopOf(out: ToolOutcome, c: ComposeReply) {
  return { compose: c, tools: [], outcomes: [out], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
}

describe('K18 — rail in the reply or anywhere in the chat’s window', () => {
  const truck: ToolOutcome = { ok: true, text: '', sources: yolkira, estimate: true };
  const chat = [
    msg('#1', "Ivudan temir yo'l bilan yuborsa qancha bo'ladi?"),
    msg('#2', "Temir yo'l narxini aniqlab aytaman", 'out'),
    msg('#3', '5 kub, 800 kg'),
  ];

  it('the window’s rail question drops the machine’s money sources, and the card says why', () => {
    const ctx = ctxOf(chat, []);
    const c = compose("Taxminan 960 $ bo'ladi. Boj va QQS alohida hisoblanadi.");
    expect(railChat(ctx, c)).toBe(true);
    const memory = memoryFor(ctx, loopOf(truck, c), [], 'c');
    expect(memory.sources.some((s) => s.kind === 'money')).toBe(false);
    expect(memory.hasEstimate).toBe(false);
    expect(railNote(ctx, c)).toContain("temir yo'l");
  });

  it('a reply that SAYS rail is his question, and its figure is blocked in words even on the truck’s sources', () => {
    const ctx = ctxOf([msg('#1', '5 kub, 800 kg')], []);
    const c = compose("Temir yo'l bilan taxminan 330 $ bo'ladi. Boj va QQS alohida hisoblanadi.");
    expect(withRailRule(c, ctx)).toMatchObject({ needsOwner: true });
    const policy = checkAgentReply({ ...base, body: c.replyText, ...quote });
    expect(policy.blocks).toContainEqual(expect.objectContaining({ code: 'number_unsourced', detail: '330 $ — temir yo‘l narxini Bekzod aytadi' }));
  });

  it('a truck chat with no rail anywhere keeps its sources', () => {
    const ctx = ctxOf([msg('#1', 'Ivudan mashinada 3 kub 300 kg qancha?')], []);
    const c = compose("Taxminan 330 $ bo'ladi. Boj va QQS alohida hisoblanadi.");
    expect(memoryFor(ctx, loopOf(truck, c), [], 'c').sources.some((s) => s.kind === 'money')).toBe(true);
    expect(railNote(ctx, c)).toBeNull();
  });
});

describe('K19 — the figure-less concessions', () => {
  it.each([
    ['Sizga yaxshi narx qilib beramiz.', 'discount'],
    ['Arzonlatib beramiz.', 'discount'],
    ['Siz uchun maxsus narx.', 'discount'],
    ['Сделаем вам хорошую цену.', 'discount'],
    ['Для вас сделаем цену ниже.', 'discount'],
    ['We can give you a better price.', 'discount'],
    ['Special price for you.', 'discount'],
    ["Yukni to'lovsiz olib ketishingiz mumkin.", 'credit_release'],
    ["To'lovni keyinroq qilsangiz ham bo'ladi.", 'credit_release'],
    ['Qarzni keyin yopasiz.', 'credit_release'],
    ['Груз выдадим без оплаты.', 'credit_release'],
    ['Pay when you can.', 'credit_release'],
    ['Хранение без оплаты.', 'free_extras'],
    ['Saqlash uchun sizdan pul olinmaydi.', 'free_extras'],
  ] as const)('«%s» → %s', (t, category) => {
    expect(promiseHits(t)).toContain(category);
  });

  it.each([
    WAREHOUSE_SENTENCES.uz.factory,
    'Hisoblash uchun pul olinmaydi.',
    'Цены указаны ниже.',
    'Narxni arzonlatib bo‘lmaydi.',
    'Не можем сделать цену ниже.',
    'We cannot give a better price.',
    "To'lovdan keyin yukni olib ketasiz.",
  ])('«%s» promises nothing', (t) => {
    expect(promiseHits(t)).toEqual([]);
  });
});

describe('K29 — a Persian or Chinese draft he cannot read carries its translation or no ✅', () => {
  it('blocked in words without one, passes with one; an Uzbek or Russian draft needs none', () => {
    const fa = { body: 'سلام، بار شما در انبار است.', language: 'fa' as const, customerScript: 'arabic' as const };
    // Its own code, so the card names it in words — under 'empty' the card read «bo'sh» beside a full reply.
    expect(checkAgentReply({ ...base, ...fa, hasGloss: false }).blocks).toContainEqual(
      expect.objectContaining({ rule: 'G5', code: 'gloss_missing' }),
    );
    expect(POLICY_WORDS.gloss_missing).toContain('tarjima');
    expect(checkAgentReply({ ...base, ...fa, hasGloss: true }).ok).toBe(true);
    expect(checkAgentReply({ ...base, body: '您好，货在仓库。', language: 'zh', hasGloss: false }).ok).toBe(false);
    expect(checkAgentReply({ ...base, body: 'Yukingiz omborda.', hasGloss: false }).ok).toBe(true);
    expect(checkAgentReply({ ...base, body: 'Груз на складе.', language: 'ru', hasGloss: false }).ok).toBe(true);
  });

  it('the run records whether the model wrote one', () => {
    const ctx = ctxOf([msg('#1', 'سلام')], []);
    const out: ToolOutcome = { ok: true, text: '', sources: [] };
    expect(memoryFor(ctx, loopOf(out, compose('سلام', { language: 'fa', glossUz: '' })), [], 'c').hasGloss).toBe(false);
    expect(memoryFor(ctx, loopOf(out, compose('سلام', { language: 'fa', glossUz: 'Salom' })), [], 'c').hasGloss).toBe(true);
  });
});

describe('K31 — every price sentence, in every language, promises nothing', () => {
  it('none of the twenty-four sentences hits G2, and podklyuch is never «door-to-door»', () => {
    for (const l of AGENT_LOCALES) {
      for (const s of ['yolkira', 'rastamojka', 'podklyuch', null]) {
        const text = priceReplyText(l, s, 1250);
        expect(promiseHits(text), `${l}/${s}: ${text}`).toEqual([]);
      }
    }
    expect(priceReplyText('en', 'podklyuch', 1250)).not.toMatch(/door/iu);
  });
});

describe('K1 — each stored reply is folded with ITS OWN customer’s names and codes', () => {
  it('the strip a stored draft carries: its codes and its label’s words', () => {
    expect(stripOfDraftPolicy({ memory: { ownCodes: ['GS777', 'GS778'] }, card: { customerLabel: 'GS777, GS778 · Bobur Aliyev' } }).sort()).toEqual(
      ['Aliyev', 'Bobur', 'GS777', 'GS778'],
    );
    expect(stripOfDraftPolicy({ card: { customerLabel: 'Lid: Bobur' } })).toEqual(['Bobur']);
    expect(stripOfDraftPolicy(null)).toEqual([]);
  });

  it('two customers greeted by name and by code fold to one text; a name is cut as a word, never inside one', () => {
    const a = textFingerprint('Assalomu alaykum, Bobur aka! GS777 bo‘yicha manzil: Chuqursoy, 5-uy.', ['GS777', 'Bobur']);
    const b = textFingerprint('Assalomu alaykum, Aziz aka! GS555 bo‘yicha manzil: Chuqursoy, 5-uy.', ['GS555', 'Aziz']);
    expect(a).toBe(b);
    // «Ali» cut out of «hali» would fold one text and not the other.
    expect(textFingerprint('Ali aka, yuk hali yo‘lda.', ['Ali'])).toBe(textFingerprint('Vali aka, yuk hali yo‘lda.', ['Vali']));
    expect(textFingerprint('Boburga salom', ['Bobur'])).toBe(textFingerprint('Azizga salom', ['Aziz']));
  });
});

describe('K3 — the 💵 template’s same-text count is a warning, never a block', () => {
  it('more than the fuse’s peers warns with the machine’s own code', () => {
    expect(sameTextWarning(4)).toEqual({ rule: 'G10', code: 'fingerprint', detail: '4' });
    expect(sameTextWarning(3)).toBeNull();
  });
});

describe('digits stay one spelling for every new reader', () => {
  it('Persian digits are dates and money like ASCII ones', () => {
    expect(timePromise(normalizeDigits('Yukingiz ۰۹.۱۱ da yetib keladi.'))).toBe(true);
  });
});
