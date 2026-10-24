import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage, MeasureCandidate } from '@/modules/wms/agent/context';
import { customerSources, extractNumbers, factSources, numberLedger, type NumberSource } from '@/modules/wms/agent/numbers';
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
import { stripOfDraftPolicy } from '@/modules/wms/agent/policy-input';
import { glossReadable, memoryFor, railChat, railNote, withRailRule, type ComposeReply } from '@/modules/wms/agent/run';
import { runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * The final review's second look at the policy package's own fixes — each
 * reply the reviewers measured passing (or refused) at ca7e502, now pinned
 * the right way, and beside it the ordinary reply that must still go through.
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

const yolkira: NumberSource[] = [
  { value: 330, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool', currency: 'USD', role: 'total' },
  { value: 110, kind: 'money', label: "yo'lkira tarifi (sayt)", origin: 'tool', currency: 'USD', role: 'rate' },
  { value: 15, kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
  { value: 25, kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
  { value: 3, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
  { value: 300, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
];
const quote = { numberSources: yolkira, hasEstimate: true };

describe('a bare figure never takes a money source — only the upgrade, which asks role and currency', () => {
  it.each([
    ['3 kub yukingiz uchun 110 chiqadi.', 'uz'],
    ['За 3 куба выйдет 110.', 'ru'],
    ['3 cubes will come to 110.', 'en'],
    ['运3方大约110。', 'zh'],
  ] as const)('«%s» — the RATE quoted as the load’s price — is unsourced', (body, language) => {
    expect(codes(body, { ...quote, language, fromOurWarehouse: true })).toContain('number_unsourced');
    expect(numberLedger(body, yolkira).find((e) => e.raw.startsWith('110'))?.source).toBeNull();
  });

  it('the total said bare is still the quoted price, money in dollars', () => {
    expect(numberLedger('3 kub yukingiz uchun 330 chiqadi.', yolkira).find((e) => e.raw.startsWith('330'))).toMatchObject({
      kind: 'money',
      source: "yo'lkira (sayt kalkulyatori)",
    });
  });
});

describe('a customer’s percent, day count or date vouches for nothing, whatever form the reply takes', () => {
  it.each([
    ["Boj 20% bo'ladimi? 5 kub yuk bor", "Ha, boj 20 bo'ladi.", 'uz'],
    ['QQS 12% mi?', "QQS 12 bo'ladi.", 'uz'],
    ['Пошлина 20% будет?', 'Да, пошлина 20.', 'ru'],
    ['Is the duty 20%?', 'Yes, the duty is 20.', 'en'],
    ['5 kunda kelsinmi?', "Ha, 5 bo'ladi.", 'uz'],
  ] as const)('«%s» → «%s» is unsourced', (said, reply, language) => {
    expect(codes(reply, { numberSources: customerSources([{ text: said, label: 'mijoz #1' }]), language })).toContain('number_unsourced');
  });

  it('an approved fact’s percent still vouches for the bare figure', () => {
    expect(codes("QQS 12 bo'ladi.", { numberSources: factSources('QQS 12% hisoblanadi.', 'bilim') })).toEqual([]);
  });
});

describe('G11: every clause naming the customs must itself say it is apart', () => {
  it.each([
    ["Taxminan 330 $ bo'ladi, bu narxga boj ham kirgan, QQS alohida.", 'uz'],
    ["Taxminan 330 $ bo'ladi, bu narxda boj ham hisoblangan, QQS alohida.", 'uz'],
    ['Примерно 330 $ с учётом растаможки, НДС отдельно.', 'ru'],
    ['Примерно 330 $ вместе с пошлиной, НДС отдельно.', 'ru'],
    ['About $330 with customs; VAT is separate.', 'en'],
    ['About $330, customs duty already counted in; VAT is separate.', 'en'],
    ['حدود ۳۳۰ دلار همراه با گمرک، مالیات جداگانه.', 'fa'],
    ['大约330美元（关税已算进去），增值税另算。', 'zh'],
  ] as const)('«%s» is refused, by G11 and by G2', (body, language) => {
    const hit = codes(body, { ...quote, language });
    expect(hit).toContain('estimate_unhedged');
    expect(hit).toContain('promise');
  });

  it('a clause naming the customs that says no «apart» refuses, whatever it says instead', () => {
    // The duty and the VAT are each said apart — and a third clause says something about the clearance that no
    // «in the price» list holds: the requirement, not the count of the duty and the VAT, is what refuses it.
    expect(codes('Taxminan 330 $. Boj va QQS alohida hisoblanadi, rastamojka ham shu narxda.', quote)).toEqual(['estimate_unhedged']);
    expect(codes('About $330. Customs duty and VAT are calculated separately, clearance is on us.', { ...quote, language: 'en' })).toEqual([
      'estimate_unhedged',
    ]);
  });

  it('the hedge of the DAYS is not the price’s when the clauses are joined by «va»', () => {
    expect(codes('Yetib kelishi taxminan 15-25 kun va 3 kub uchun narx 330 $. Boj va QQS alohida hisoblanadi.', quote)).toContain(
      'estimate_unhedged',
    );
    // A measure between the word and the price takes no hedge: one approximate price.
    expect(codes('Taxminan 3 kub va 300 kg uchun 330 $. Boj va QQS alohida hisoblanadi.', quote)).toEqual([]);
  });

  it('a clause that only LISTS the customs belongs to the next; every told sentence passes', () => {
    expect(codes("Taxminan 330 $. Boj, QQS va yig'im alohida hisoblanadi.", quote)).toEqual([]);
    expect(codes('Примерно 330 $. Пошлина, НДС и сбор считаются отдельно.', { ...quote, language: 'ru' })).toEqual([]);
    expect(codes('大约330美元。关税、增值税另行计算。', { ...quote, language: 'zh' })).toEqual([]);
    expect(codes('Taxminan 330 $. Boj, QQS.', quote)).toContain('estimate_unhedged');
    for (const l of ['uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh'] as const) {
      const approx = { uz: 'Taxminan', uz_cyrl: 'Тахминан', ru: 'Примерно', en: 'Approximately', fa: 'تقریباً', zh: '大约' }[l];
      expect(codes(`${approx} 330 $. ${EXCLUSION_SENTENCE[l]}`, { ...quote, language: l }), l).toEqual([]);
    }
  });
});

describe('G2 customs_included: the new spellings, never the negation, the place or podklyuch', () => {
  it.each([
    'Bu narxga boj ham kirgan.',
    'Bu narxda boj ham hisoblangan.',
    'Примерно 330 $ с учётом растаможки.',
    'Примерно 330 $ вместе с пошлиной.',
    'About $330 with customs.',
    'Customs duty already counted in.',
    'حدود ۳۳۰ دلار همراه با گمرک.',
    '关税已算进去。',
    'Бож ҳам шу нархга киради.',
  ])('«%s» says customs is in', (t) => {
    expect(promiseHits(t)).toContain('customs_included');
  });

  it.each([
    'این قیمت شامل عوارض گمرکی و مالیات نمی‌شود.',
    'قیمت شامل گمرک نمی‌شود.',
    'Boj va QQS bu narxga kiritilgan emas.',
    "Boj va QQS narxga qo'shilgan emas.",
    "Yukingiz bojxonadan o'tib omborga kiradi.",
    'Yukingiz bojxonaga kiradi.',
    'Yukingiz bojxona omboriga kiritilgan, rastamojka kutilmoqda.',
    'После растаможки груз будет учтён на складе.',
    'Подключ включает доставку и растаможку — какой вариант вам нужен?',
    "Podklyuch — bu to'liq xizmat: narxga yo'l va bojxona rasmiylashtiruvi kiradi.",
    'Turnkey includes freight and customs clearance.',
    'Boj alohida hisoblangan.',
    '关税不算在内。',
    'Customs are not counted in.',
  ])('«%s» does not', (t) => {
    expect(promiseHits(t)).not.toContain('customs_included');
  });
});

describe('K19 in the other three scripts', () => {
  it.each([
    ['Юкни тўловсиз олиб кетишингиз мумкин.', 'credit_release'],
    ['Тўловни кейинроқ қилсангиз ҳам бўлади.', 'credit_release'],
    ['Сақлаш учун сиздан пул олинмайди.', 'free_extras'],
    ['قیمت ویژه برای شما', 'discount'],
    ['برای شما قیمت خوب می‌دهیم', 'discount'],
    ['بار را بدون پرداخت تحویل می‌دهیم', 'credit_release'],
    ['给您特价', 'discount'],
    ['给你一个好价格', 'discount'],
    ['不用付款就可以提货', 'credit_release'],
  ] as const)('«%s» → %s', (t, category) => {
    expect(promiseHits(t)).toContain(category);
  });
});

describe('K19’s refusals are the agent’s own rules, never a promise', () => {
  it.each([
    "To'lovsiz yuk berilmaydi, avval to'lovni qiling.",
    'Pulsiz yuk bermaymiz.',
    "To'lovsiz olib ketib bo'lmaydi.",
    'Мы не выдаём груз без оплаты.',
    'Без оплаты груз не выдаём.',
    'Груз со склада без оплаты не выдаётся.',
    'We cannot release cargo without payment.',
    "You can't collect your cargo without paying first.",
    'Afsuski, maxsus narx qila olmaymiz.',
    'Специальную цену дать не можем.',
    'К сожалению, специальных цен у нас нет.',
    'Sorry, a special price is not possible.',
    'We are unable to give a better price.',
    'Qadoqlash alohida narxda qilinadi.',
    'Sizga alohida narx hisoblab beramiz.',
    'Юкни тўловсиз бермаймиз.',
    'قیمت ویژه نداریم.',
    '没有特价。',
  ])('«%s» promises nothing', (t) => {
    expect(promiseHits(t)).toEqual([]);
  });
});

describe('K15: the days the first fix did not know, and a day said after its verb', () => {
  it.each([
    'Yukingiz kelgusi hafta Toshkentga keladi.',
    'Юкингиз келгуси ҳафта Тошкентга келади.',
    "Kelgusi haftada jo'natamiz.",
    '货下个礼拜到。',
    '你的货周末到。',
    '货这周末到。',
    'Груз придёт к выходным.',
    'Отправим на днях.',
    'بار شما هفته دیگر می‌رسد.',
    'Yukingiz oy boshida keladi.',
    "Jo'natamiz, ertaga.",
    'Yukingiz yetib keladi, inshaalloh ertaga.',
    "Ertaga jo'natamiz va taxminan 15 kunda yetib keladi.",
  ])('«%s» is a dispatch promise', (t) => {
    expect(dayPromise(t)).toBe(true);
    expect(promiseHits(t)).toContain('dispatch_promise');
  });
});

describe('K15: a status told «as of today», a hedged arrival and a timetable are no promise', () => {
  it.each([
    "Bugungi holat bo'yicha yukingiz Qashg'arda, Toshkentga taxminan 5-7 kunda yetib keladi.",
    'Bugun tekshirdim, yukingiz taxminan 10 kunda keladi.',
    "Yukingiz bugun Qashg'arga yetib keldi va taxminan 5 kunda Toshkentga keladi.",
    'На сегодня ваш груз в Кашгаре, в Ташкент прибудет примерно через 5-7 дней.',
    'As of today your cargo is in Kashgar; it should arrive in Tashkent in about 5-7 days.',
    '截至今天，您的货在喀什，预计5-7天到达塔什干。',
    'امروز بررسی کردم، بار شما حدود ۵ تا ۷ روز دیگر می‌رسد.',
    "Mashinalar shanba kunlari jo'naydi.",
    "Har hafta shanba kuni mashina jo'naydi.",
    'Yukingiz yetib keladi, bugun tekshirdim.',
    'На сегодня груз в пути и прибудет в Ташкент.',
    "Bugungi holatda yukingiz yo'lda va Toshkentga yetib keladi.",
    "Bugungi ma'lumotga ko'ra yukingiz taxminan 5 kunda Toshkentga yetib keladi.",
  ])('«%s»', (t) => {
    expect(promiseHits(t)).not.toContain('dispatch_promise');
  });
});

describe('K14: a date that passed, beside the hedged window that comes', () => {
  it.each([
    'Your cargo was shipped on 03.11 and should arrive in Tashkent around 05.11-09.11.',
    'Ваш груз отправлен 03.11 и прибудет в Ташкент примерно 05.11–09.11.',
    "Yukingiz 03.11 da Ivudan jo'natilgan va taxminan 05.11 – 09.11 oralig'ida Toshkentga yetib keladi.",
    'Yukingiz 28.10 da omborimizga qabul qilindi va taxminan 15-25 kunda Toshkentga yetib keladi.',
    'بار شما 03.11 از ییوو ارسال شد، تقریباً بین 05.11 تا 09.11 به تاشکند می‌رسد.',
    '您的货物已于03.11发出。',
    '您的货物03.11已经到达喀什。',
    'Yukingiz 09.11 da yetib kelishi kutilmoqda.',
    'Your cargo is expected to arrive in Tashkent on 09.11.',
  ])('«%s» is no promise', (t) => {
    expect(timePromise(t)).toBe(false);
    expect(promiseHits(t)).not.toContain('dispatch_promise');
  });

  it('the date the cargo COMES on, said flat, still is one', () => {
    expect(timePromise("Yukingiz 03.11 da jo'natilgan va 09.11 da yetib keladi.")).toBe(true);
    expect(timePromise('您的货物将于09.11到达。')).toBe(true);
  });
});

describe('K12: the hedges the first fix refused', () => {
  it.each([
    ["Taxminan 330 $ bo'ladi, kubiga 110 $ dan. Boj va QQS alohida hisoblanadi.", 'uz'],
    ['Примерно 330 $, то есть 110 $ за куб. Пошлина и НДС считаются отдельно.', 'ru'],
    ['Freight for your cargo is about $330 ($110/cbm). Customs duty and VAT are calculated separately.', 'en'],
    ['حدود ۳۳۰ دلار (۱۱۰ دلار برای هر متر مکعب). عوارض گمرکی و مالیات بر ارزش افزوده جداگانه محاسبه می‌شود.', 'fa'],
    ['هزینه حمل حدوداً ۳۳۰ دلار می‌شود. عوارض گمرکی و مالیات بر ارزش افزوده جداگانه محاسبه می‌شود.', 'fa'],
    ['It will cost $330 approx. Customs duty and VAT are calculated separately.', 'en'],
    ['Taxminiy narx (Ivu → Toshkent):\n330 $\nBoj va QQS alohida hisoblanadi.', 'uz'],
  ] as const)('%j passes', (body, language) => {
    expect(codes(body, { ...quote, language })).toEqual([]);
  });

  it('a header line with no hedge hedges nothing', () => {
    expect(codes('Narx (Ivu → Toshkent):\n330 $\nBoj va QQS alohida hisoblanadi.', quote)).toContain('estimate_unhedged');
  });
});

describe('K21: the per-unit shapes the first fix misread', () => {
  it.each([
    ["3 kub × 110 $ = taxminan 330 $. Boj va QQS alohida hisoblanadi.", 'uz'],
    ['3 cbm × $110 = about $330. Customs duty and VAT are calculated separately.', 'en'],
    ['Sayt tarifi: taxminan 330 $. Boj va QQS alohida hisoblanadi.', 'uz'],
    ['По нашему тарифу — примерно 330 $ за 3 куба. Пошлина и НДС считаются отдельно.', 'ru'],
  ] as const)('«%s» passes', (body, language) => {
    expect(codes(body, { ...quote, language })).toEqual([]);
  });

  it('reads «×» beside a unit as per unit, and «tarif» alone as nothing of the kind', () => {
    expect(extractNumbers('3 kub × 110 $').find((f) => f.kind === 'money')?.perUnit).toBe(true);
    expect(extractNumbers('110 $ x 3 kub').find((f) => f.kind === 'money')?.perUnit).toBe(true);
    expect(extractNumbers('Sayt tarifi: 330 $').find((f) => f.kind === 'money')?.perUnit).toBeUndefined();
  });
});

describe('K16: the neighbours’ currencies are no dollars', () => {
  it.each([
    ["Taxminan 330 somoni bo'ladi. Boj va QQS alohida hisoblanadi.", 'uz', '330 somoni'],
    ["Taxminan 330 manat bo'ladi. Boj va QQS alohida hisoblanadi.", 'uz', '330 manat'],
    ["Taxminan 330 dirham bo'ladi. Boj va QQS alohida hisoblanadi.", 'uz', '330 dirham'],
    ['Approximately 330 dirhams. Customs duty and VAT are calculated separately.', 'en', '330 dirham'],
  ] as const)('«%s» is unsourced, and the card names its currency', (body, language, raw) => {
    expect(codes(body, { ...quote, language })).toContain('number_unsourced');
    expect(numberLedger(body, yolkira).find((e) => e.kind === 'money')).toMatchObject({ raw, source: null });
  });

  it('the Uzbek so‘m is still so‘m, and «сомони» is no so‘m', () => {
    expect(extractNumbers("330 so'm")[0]?.currency).toBe('UZS');
    expect(extractNumbers('330 сом')[0]?.currency).toBe('UZS');
    expect(extractNumbers('330 сомони')[0]?.currency).toBe('TJS');
  });
});

describe('K17: his own counts, his hour and his order number are his to have repeated', () => {
  it.each([
    ['200 juft krossovka yubordim, keldimi?', '200 juft krossovkangizni tekshirib, javob beraman.'],
    ['50 qop yuk yubordim', '50 qop yukingizni tekshiraman.'],
    ['Отправил 20 мешков', 'Проверю ваши 20 мешков.'],
    ['I sent 20 bags', 'I will check your 20 bags.'],
    ['10 rulon mato yubordim', '10 rulon matongizni tekshiraman.'],
    ['3 xil tovar bor', '3 xil tovaringizni yozib oldim.'],
    ['我发了5包货', '您的5包货我们查一下。'],
    ['Ertaga soat 10 da olib ketaman', 'Yaxshi, ertaga soat 10 da kutamiz.'],
    ['Приеду в 15:00', 'Хорошо, ждём вас в 15:00.'],
    ['Buyurtma raqamim 4521', '4521 raqamli buyurtmangizni tekshiraman.'],
  ])('«%s» → «%s» passes G1', (said, reply) => {
    const sources = customerSources([{ text: said, label: 'mijoz #1' }]);
    expect(codes(reply, { numberSources: sources })).not.toContain('number_unsourced');
  });

  it('…but a bare figure of his is still nothing, and his hour is no bare figure', () => {
    const sources = customerSources([{ text: 'Ertaga soat 10 da olib ketaman', label: 'mijoz #1' }]);
    expect(codes("Ha, 10 bo'ladi.", { numberSources: sources })).toContain('number_unsourced');
  });
});

describe('K1: a name in the other script, a short name with its ending', () => {
  it('a Cyrillic book name greeted in Latin folds out of its row', () => {
    const a = textFingerprint(
      'Assalomu alaykum, Bobur aka! Toshkent omborimiz manzili: Chilonzor 5.',
      stripOfDraftPolicy({ memory: { ownCodes: ['GS777'] }, card: { customerLabel: 'GS777 · Бобур Алиев' } }),
    );
    const b = textFingerprint(
      'Assalomu alaykum, Aziz aka! Toshkent omborimiz manzili: Chilonzor 5.',
      stripOfDraftPolicy({ memory: { ownCodes: ['GS778'] }, card: { customerLabel: 'GS778 · Азиз Каримов' } }),
    );
    expect(a).toBe(b);
  });

  it('«Alijon» is «Ali», «Boburjonga» is «Bobur» — and «Ali» is still cut out of no other word', () => {
    expect(textFingerprint('Alijon aka, salom', ['Ali'])).toBe(textFingerprint('Vali aka, salom', ['Vali']));
    expect(textFingerprint('Boburjonga salom', ['Bobur'])).toBe(textFingerprint('Azizga salom', ['Aziz']));
    expect(textFingerprint('Ali aka, yuk hali yo‘lda.', ['Ali'])).toBe(textFingerprint('Vali aka, yuk hali yo‘lda.', ['Vali']));
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

describe('K32: a flight whose start nobody said is priced from our warehouse', () => {
  it('the tool flags it and hands the model both sentences; the policy asks them', async () => {
    const ctx = ctxOf([msg('#1', 'Avia 30 kg qancha?')], [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, envOf(ctx));
    expect(out).toMatchObject({ ok: true, estimate: true, fromOurWarehouse: true });
    expect(out.text).toContain(WAREHOUSE_SENTENCES.uz.condition);
    const memory = memoryFor(ctx, loopOf(out, compose('x')), [], 'c');
    expect(memory.fromOurWarehouse).toBe(true);
    const body = "Avia bilan taxminan 510 $ bo'ladi. Boj va QQS alohida hisoblanadi.";
    const check = (b: string) => codes(b, { numberSources: memory.sources, hasEstimate: true, fromOurWarehouse: true });
    expect(check(body)).toEqual(['warehouse_condition']);
    expect(check(`${body} ${WAREHOUSE_SENTENCES.uz.condition} ${WAREHOUSE_SENTENCES.uz.factory}`)).toEqual([]);
  });
});

describe('K29: a translation he can read', () => {
  it('a copied Persian reply or a lone «.» is no translation', () => {
    const fa = 'سلام، بار شما در انبار است.';
    expect(glossReadable(fa)).toBe(false);
    expect(glossReadable('.')).toBe(false);
    expect(glossReadable('Ok')).toBe(false);
    expect(glossReadable('Salom, yukingiz omborda.')).toBe(true);
    expect(glossReadable('Салом, юкингиз омборда.')).toBe(true);
    const ctx = ctxOf([msg('#1', 'سلام')], []);
    const out: ToolOutcome = { ok: true, text: '', sources: [] };
    const memory = memoryFor(ctx, loopOf(out, compose(fa, { language: 'fa', glossUz: fa })), [], 'c');
    expect(memory.hasGloss).toBe(false);
    expect(checkAgentReply({ ...base, body: fa, language: 'fa', hasGloss: memory.hasGloss }).ok).toBe(false);
  });
});

describe('K18: the newest road the customer named, and a rail word with no figure', () => {
  const truck: ToolOutcome = { ok: true, text: '', sources: yolkira, estimate: true };

  it('a customer who chose the truck after his answer is a truck chat again', () => {
    const ctx = ctxOf(
      [
        msg('#1', "Temir yo'l bilan qancha bo'ladi?"),
        msg('#2', "Temir yo'l hozir ishlamayapti, fura bilan yuboramiz.", 'out'),
        msg('#3', 'Unda fura bilan 5 kub 800 kg qancha?'),
      ],
      [],
    );
    const c = compose("Taxminan 600 $ bo'ladi. Boj va QQS alohida hisoblanadi.");
    expect(railChat(ctx, c)).toBe(false);
    expect(memoryFor(ctx, loopOf(truck, c), [], 'c').sources.some((s) => s.kind === 'money')).toBe(true);
    expect(railNote(ctx, c)).toBeNull();
  });

  it('a rail question followed only by the figures is still his question', () => {
    const ctx = ctxOf(
      [msg('#1', "Ivudan temir yo'l bilan yuborsa qancha bo'ladi?"), msg('#2', "Temir yo'l narxini aniqlab aytaman", 'out'), msg('#3', '5 kub, 800 kg')],
      [],
    );
    const c = compose("Taxminan 960 $ bo'ladi. Boj va QQS alohida hisoblanadi.");
    expect(railChat(ctx, c)).toBe(true);
    expect(memoryFor(ctx, loopOf(truck, c), [], 'c').sources.some((s) => s.kind === 'money')).toBe(false);
  });

  it('a reply quoting the rail fact with no figure is not his rail question', () => {
    const ctx = ctxOf([msg('#1', 'Power bank olib kelsa bo‘ladimi?')], []);
    const c = compose("Power bank faqat avto yoki temir yo'l bilan ketadi.", { category: 'faq' });
    expect(withRailRule(c, ctx).needsOwner).toBe(false);
    expect(railChat(ctx, c)).toBe(false);
    expect(railNote(ctx, c)).toBeNull();
    // …while a rail word WITH a figure is.
    expect(withRailRule(compose("Temir yo'l bilan taxminan 960 $ bo'ladi."), ctx).needsOwner).toBe(true);
  });
});

describe('K21: a second load is no correction of the first', () => {
  const two = ctxOf(
    [msg('#1', 'Ivudan 3 kub 300 kg'), msg('#2', 'yana Guanchjoudan 5 kub 800 kg bor, ikkalasiga narx?')],
    [
      { ref: 'w1', kind: 'weight', value: 300, messageRef: '#1' },
      { ref: 'v1', kind: 'volume', value: 3, messageRef: '#1' },
      { ref: 'w2', kind: 'weight', value: 800, messageRef: '#2' },
      { ref: 'v2', kind: 'volume', value: 5, messageRef: '#2' },
    ],
  );

  it('each load is priced on its own pair; a pair mixing the two loads is refused', async () => {
    expect(await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, envOf(two))).toMatchObject({ ok: true });
    expect(await runTool('yolkira_estimate', { weight_ref: 'w2', volume_ref: 'v2' }, envOf(two))).toMatchObject({ ok: true });
    const mixed = await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v2' }, envOf(two));
    expect(mixed).toMatchObject({ ok: false });
    expect(mixed.text).toContain('w2');
  });

  it('«yana» in a correction is «again»: the corrected load is still refused', async () => {
    const corrected = ctxOf(
      [msg('#1', 'Ivudan 3 kub 400 kg'), msg('#2', "Yana o'lchadim, kechirasiz, 2 kub 300 kg ekan")],
      [
        { ref: 'w1', kind: 'weight', value: 400, messageRef: '#1' },
        { ref: 'v1', kind: 'volume', value: 3, messageRef: '#1' },
        { ref: 'w2', kind: 'weight', value: 300, messageRef: '#2' },
        { ref: 'v2', kind: 'volume', value: 2, messageRef: '#2' },
      ],
    );
    expect(await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, envOf(corrected))).toMatchObject({ ok: false });
  });
});
