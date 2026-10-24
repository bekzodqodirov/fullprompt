import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { normalizeDigits } from '@/modules/wms/agent/digits';
import type { KbHit } from '@/modules/wms/agent/kb';
import { namesMode, PHONE_RE } from '@/modules/wms/agent/numbers';
import {
  addressAnchorsOf,
  checkAgentReply,
  isReceivingAddressFact,
  statesChinaAddress,
  withoutQuotedHan,
  type AddressAnchors,
  type PolicyInput,
} from '@/modules/wms/agent/policy';
import { aviaOwnerQuestion, memoryFor, withAviaGuard, withAviaRule, type ComposeReply } from '@/modules/wms/agent/run';
import { WAREHOUSE_ADDRESS_SEED } from '@/modules/wms/agent/kb';
import { GS_REMINDER, SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import type { ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * His fourth set (2026-10-24, docs/AI-SOTUVCHI.md §17.14): the three China
 * receiving warehouses, verbatim, and «2 yukini infosini menga bersang men
 * adres beraman telegramda sorasin» — the flight's address is HIS. Fixtures
 * are the seeded facts as a run's prompt carries them (kb.ts `hitOf`), and
 * replies a model would write; no figure is computed by the code under test.
 */

const msg = (body: string): ChatMessage => ({
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
});

function ctxOf(
  body: string,
  customerScript: 'latin' | 'cyrillic' | 'han',
  earlier: ChatMessage[] = [],
  measures: AgentContext['measures'] = [],
  lastQuote: AgentContext['lastQuote'] = null,
): AgentContext {
  const m = { ...msg(body), ref: `#${earlier.length + 1}`, tgMessageId: BigInt(earlier.length + 1) };
  const messages = [...earlier, m];
  // The burst as `loadContext` cuts it: every inbound line since our last one.
  const lastOutIndex = messages.map((x) => x.direction).lastIndexOf('out');
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    anchor: m,
    burst: messages.slice(lastOutIndex + 1).filter((x) => x.direction === 'in'),
    lastOut: lastOutIndex >= 0 ? messages[lastOutIndex]! : null,
    lastQuote,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript,
    measures,
    openCalcs: [],
    ruleDecision: null,
  };
}

const compose = (language: 'uz' | 'ru' | 'zh', patch: Partial<ComposeReply> = {}): ComposeReply => ({
  replyNeeded: true,
  replyText: 'x',
  language,
  glossUz: language === 'zh' ? 'Salom, Ivu omborining manzili quyidagicha.' : '',
  category: 'faq',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
  ...patch,
});

/** The seeded knowledge as `generalFacts` serves it — phones read the way `hitOf` reads them. */
const FACTS: KbHit[] = SEED_FACTS.map((f, i) => ({
  id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`,
  ref: `F${i}`,
  answer: f.answer,
  phones: [...normalizeDigits(f.answer).matchAll(PHONE_RE)].map((m) => m[0]),
  urls: [],
}));
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (key: string) => SEED_FACTS.find((f) => f.key === key)!.answer;
/** The receiving warehouses as `policyFor` reads them: every live fact under the address seed key. */
const ANCHORS: AddressAnchors = addressAnchorsOf(
  SEED_FACTS.filter((f) => f.key.startsWith(WAREHOUSE_ADDRESS_SEED)).map((f) => f.answer),
  [GS_REMINDER],
);
const said = (body: string, n: number, direction: 'in' | 'out' = 'in'): ChatMessage => ({
  ...msg(body),
  ref: `#${n}`,
  tgMessageId: BigInt(n),
  direction,
});
type ToolCall = { name: string; ok: boolean; text: string };
/** The avia rule over a run's tools and outcomes, as `runOnce` calls it. */
const rule = (c: ComposeReply, outcomes: ToolOutcome[], ctx: AgentContext, tools: ToolCall[] = []) => withAviaRule(c, { outcomes, tools }, ctx);
/** The flight he approved a draft for, as `loadContext` reads it back. */
const AIR_QUOTE: AgentContext['lastQuote'] = { road: 'air', air: { kg: 30, origin: 'Shenzhen' }, at: new Date(0) };
const ROAD_QUOTE: AgentContext['lastQuote'] = { road: 'road', air: null, at: new Date(0) };

/** The policy over a reply, on the memory a real run stores — as `policyFor` maps it. */
function judge(
  customer: string | AgentContext,
  script: 'latin' | 'cyrillic' | 'han',
  language: 'uz' | 'ru' | 'zh',
  reply: string,
  outcomes: ToolOutcome[] = [],
  tools: { name: string; ok: boolean; text: string }[] = [],
) {
  const ctx = typeof customer === 'string' ? ctxOf(customer, script) : customer;
  const mem = memoryFor(ctx, { compose: compose(language), tools, outcomes, usage }, FACTS, 'gsr-t');
  const input: PolicyInput = {
    body: reply,
    language: mem.language,
    customerScript: mem.customerScript,
    numberSources: mem.sources,
    removeWhole: [],
    ownCodes: [],
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: mem.allowedPhones,
    allowedUrls: mem.allowedUrls,
    mapUrls: mem.mapUrls,
    askedLocation: mem.askedLocation,
    staffNames: [],
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
    quotableHan: mem.quotableHan ?? '',
    warehouseAddress: ANCHORS,
  };
  return checkAgentReply(input).blocks.map((b) => b.code);
}

describe('a warehouse address quoted from the knowledge goes out in the customer\'s own language', () => {
  it.each([
    ['Ivu omboringiz manzilini tashlang', 'china_address_yiwu@1'],
    ['Guanchjou manzil kerak', 'china_address_guangzhou@1'],
    ['Xorgosga yubormoqchiman, manzil?', 'china_address_horgos@1'],
  ])('«%s» → the fact verbatim in an Uzbek reply: nothing blocks', (customer, key) => {
    // Measured whole, the Chinese address outweighed the Uzbek sentence and every one read `wrong_script`.
    expect(judge(customer, 'latin', 'uz', `Assalomu alaykum! ${answer(key)}`)).toEqual([]);
  });

  it('…a Russian reply carrying it copied without its spaces, and the reminder\'s Chinese line', () => {
    const reply =
      'Здравствуйте! Адрес склада в Иу: 浙江省义乌市稠江街道荷花南街2255号，周先生，小周 13429089596. ' +
      'Перед отправкой не забудьте написать GS код (маркировку). 发货前请不要忘记标注GS编码（唛头）。';
    expect(judge('Адрес склада в Иу?', 'cyrillic', 'ru', reply)).toEqual([]);
  });

  it('a Chinese reply that is mostly the quoted address is still a Chinese reply (review D1)', () => {
    // Measured without the quoted stretches, the fact's Uzbek words and the reminder outweighed «您好».
    expect(judge('义乌仓库地址？', 'han', 'zh', `您好！${answer('china_address_yiwu@1')}`)).not.toContain('wrong_script');
  });

  it('the «亿» in a warehouse\'s NAME is no spelled-out figure (review D2)', () => {
    expect(judge('Xorgosga 10 kub yubormoqchiman, manzil?', 'latin', 'uz', `Assalomu alaykum! 10 kub uchun: ${answer('china_address_horgos@1')}`)).toEqual([]);
    // …while a figure the model spells out in Chinese still is.
    expect(judge('Xorgosga 10 kub, narxi?', 'latin', 'uz', 'Assalomu alaykum! 10 kub uchun 五百美元 bo\'ladi.')).toContain('number_unverifiable');
    // …and so is a lone «亿» the facts happen to hold: a stretch too short to be a quotation is the reply's own.
    expect(judge('Xorgosga 10 kub, narxi?', 'latin', 'uz', 'Assalomu alaykum! 10 kub uchun 1亿 dollar.')).toContain('number_unverifiable');
  });

  it('…and a Chinese reply to a Chinese customer is measured in Chinese, as before', () => {
    expect(judge('义乌仓库地址？', 'han', 'zh', '您好！义乌仓库地址：浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596。')).toEqual([]);
  });

  it('the model\'s OWN Chinese to an Uzbek customer is still the wrong script — only what a fact holds is the fact\'s', () => {
    expect(judge('Ivu manzili?', 'latin', 'uz', 'Assalomu alaykum! 您好，您的货物已经到达我们的仓库，请尽快来取货，谢谢您的耐心等待。')).toContain('wrong_script');
    // The piece a fact holds is taken out; the rest of the stretch stays.
    expect(withoutQuotedHan('A 浙江省义乌市 B 您好朋友 C', '浙江省义乌市')).toBe('A  B 您好朋友 C');
  });

  it('a street number or contact the facts do not hold is still refused', () => {
    expect(judge('Ivu manzili?', 'latin', 'uz', `Assalomu alaykum! ${answer('china_address_yiwu@1').replace('13429089596', '13900001111')}`)).toContain(
      'foreign_phone',
    );
  });
});

describe('an avia quote: the address is his (his fourth set «2»)', () => {
  const air: ToolOutcome = {
    ok: true,
    text: '',
    estimate: true,
    air: { kg: 30, origin: 'Shenzhen' },
    sources: [
      { value: 510, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', currency: 'USD', role: 'total' },
      { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool', currency: 'USD', role: 'rate' },
      { value: 30, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
    ],
  };
  const truck: ToolOutcome = {
    ok: true,
    text: '',
    estimate: true,
    sources: [{ value: 640, kind: 'money', label: "yo'lkira (sayt)", origin: 'tool', currency: 'USD', role: 'total' }],
  };
  const quoted = "Avia bilan taxminan 510 $ bo'ladi. Boj va QQS alohida hisoblanadi.";
  const aviaChat = ctxOf('Shenzhendan avia 30 kg', 'latin');

  it('a China address in an avia-only reply is refused — the warehouse fact and a Chinese mobile alike', () => {
    expect(judge('Shenzhendan avia 30 kg', 'latin', 'uz', `${quoted} ${answer('china_address_yiwu@1')}`, [air])).toContain('avia_address');
    expect(judge('Shenzhendan avia 30 kg', 'latin', 'uz', quoted, [air])).toEqual([]);
  });

  it('a reply quoting the truck AND the flight may give the truck\'s warehouse — the rule is the flight\'s alone', () => {
    expect(judge('Shenzhendan avia 30 kg', 'latin', 'uz', `${quoted} ${answer('china_address_yiwu@1')}`, [air, truck])).not.toContain('avia_address');
  });

  it('what reads as a receiving warehouse\'s address, and what does not', () => {
    // A warehouse's own contact, however it is spaced or prefixed.
    expect(statesChinaAddress('Telefon: 13429089596', ANCHORS)).toBe(true);
    expect(statesChinaAddress('Telefon: +86 134 2908 9596', ANCHORS)).toBe(true);
    expect(statesChinaAddress('ASQAR 18309082036', ANCHORS)).toBe(true);
    // A piece of a warehouse's street address, copied without its spaces.
    expect(statesChinaAddress('浙江省 义乌市 稠江街道', ANCHORS)).toBe(true);
    expect(statesChinaAddress('地址：义乌市稠江街道荷花南街', ANCHORS)).toBe(true);
    expect(statesChinaAddress('Umriddin, +998 95 018 30 33', ANCHORS)).toBe(false);
    expect(statesChinaAddress('Ivu (义乌) va Guanchjou (广州)', ANCHORS)).toBe(false);
    expect(statesChinaAddress("Avia bilan taxminan 510 $ bo'ladi.", ANCHORS)).toBe(false);
    // Review D3: ordinary Chinese words that carry 市/区/路/号 are no warehouse's address.
    expect(statesChinaAddress('您好，请问您从哪个城市发货？', ANCHORS)).toBe(false);
    expect(statesChinaAddress('空运路线：从义乌市出发，请提供电话号码。', ANCHORS)).toBe(false);
    expect(statesChinaAddress('我们是国际物流公司，地区不限。', ANCHORS)).toBe(false);
    // «国际物流中心» is in Horgos's name — and in every forwarder's; a piece with no street character names nobody.
    expect(statesChinaAddress('我们有自己的国际物流中心。', ANCHORS)).toBe(false);
    // …and a Chinese mobile that is no warehouse's is G6's `foreign_phone`, not this rule's.
    expect(statesChinaAddress('Telefon: 13900001111', ANCHORS)).toBe(false);
    // No warehouse facts read — nothing is anybody's address.
    expect(statesChinaAddress(answer('china_address_yiwu@1'), { pieces: [], phones: [], houseNumbers: [] })).toBe(false);
  });

  it('a Chinese avia reply that asks where the cargo starts is no address (review D3)', () => {
    expect(judge('从深圳空运30公斤多少钱？', 'han', 'zh', '您好！空运大约510美元。请问您从哪个城市发货？', [air])).not.toContain('avia_address');
  });

  it('a follow-up «manzil?» in an avia chat: no warehouse address, and the card asks him (review D4)', () => {
    const chat = ctxOf(
      'Manzil qayerga yuboraman?',
      'latin',
      [said('Shenzhendan avia 30 kg qancha?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')],
      [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }],
      AIR_QUOTE,
    );
    // No tool ran this time — the flight was quoted one burst back, on the draft he approved.
    expect(judge(chat, 'latin', 'uz', `Assalomu alaykum! ${answer('china_address_yiwu@1')}`)).toContain('avia_address');
    const asked = rule(compose('uz'), [], chat);
    expect(asked.needsOwner).toBe(true);
    expect(asked.ownerQuestion).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
    // He typed the avia price himself (no draft): our own last quote still says which road it was.
    const typed = ctxOf('Manzil qayerga yuboraman?', 'latin', [
      said('Shenzhendan 30 kg qancha?', 1),
      said("Avia bilan 510 $ bo'ladi, 2-5 kunda.", 2, 'out'),
    ]);
    expect(judge(typed, 'latin', 'uz', `Assalomu alaykum! ${answer('china_address_yiwu@1')}`)).toContain('avia_address');
    // A truck chat asking the same question is answered from the knowledge, as before.
    const road = ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Ivudan fura bilan 5 kub qancha?', 1)]);
    expect(judge(road, 'latin', 'uz', `Assalomu alaykum! ${answer('china_address_yiwu@1')}`)).not.toContain('avia_address');
    expect(rule(compose('uz'), [], road)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
    // An avia chat that asks something else is not his address question — «where IS my cargo» included.
    for (const body of ['Necha kunda keladi?', 'Yuk qayerda?', 'Где мой груз?']) {
      const other = ctxOf(body, 'latin', [said('Shenzhendan avia 30 kg qancha?', 1)], [], AIR_QUOTE);
      expect(rule(compose('uz'), [], other), body).toMatchObject({ needsOwner: false, ownerQuestion: '' });
    }
    // «Where to» in the customer's own words is.
    for (const body of ['Qayerga yuboray?', 'Куда отправить?', '寄到哪里？']) {
      const ask = ctxOf(body, 'latin', [said('Shenzhendan avia 30 kg qancha?', 1)], [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }]);
      expect(rule(compose('uz'), [], ask).needsOwner, body).toBe(true);
    }
    // The kilos are not known — the card says so instead of inventing them.
    expect(aviaOwnerQuestion({ kg: null, origin: null })).toContain("og'irligi aytilmagan");
  });

  it('a truck quote asked in the same run — even one the tool refused — may give the truck\'s warehouse (review D5)', () => {
    const refused = [{ name: 'yolkira_estimate', ok: false, text: 'hajm kerak' }];
    expect(judge('Shenzhendan avia 30 kg, fura bilan ham', 'latin', 'uz', `${quoted} ${answer('china_address_yiwu@1')}`, [air], refused)).not.toContain(
      'avia_address',
    );
  });

  it('the model\'s own question stands only when it asks the flight\'s ADDRESS (review D8)', () => {
    const line = aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' });
    for (const asked of ['Kairat aka chair buyurtma qilyapti', 'Avia narxini tasdiqlang', 'Mijoz air max krossovka so\'rayapti']) {
      expect(rule(compose('uz', { ownerQuestion: asked }), [air], aviaChat).ownerQuestion).toBe(`${asked} · ${line}`);
    }
    for (const asked of ['Avia: kurtka, 30 kg, Shenzhen — manzilni bering', 'Авиа: куртка 30 кг, адрес?']) {
      expect(rule(compose('uz', { ownerQuestion: asked }), [air], aviaChat).ownerQuestion).toBe(asked);
    }
  });

  it('the draft asks HIM with the cargo, whatever the model composed', () => {
    const silent = rule(compose('uz'), [air], aviaChat);
    expect(silent).toMatchObject({ needsOwner: true, ownerQuestion: aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }) });
    expect(silent.ownerQuestion).toContain('30 kg');
    expect(silent.ownerQuestion).toContain('Shenzhen');
    // The model's own avia question — with the goods it read — stands.
    const own = 'Avia: kurtka, 30 kg, Shenzhen — manzilni bering';
    expect(rule(compose('uz', { ownerQuestion: own }), [air], aviaChat).ownerQuestion).toBe(own);
    // A question about something else keeps its place; the avia line follows it.
    expect(rule(compose('uz', { ownerQuestion: 'kod ochib bering' }), [air], aviaChat).ownerQuestion).toBe(
      `kod ochib bering · ${aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' })}`,
    );
    // No flight quoted: nothing is asked.
    expect(rule(compose('uz'), [truck], aviaChat)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
    expect(aviaOwnerQuestion({ kg: 12, origin: null })).toContain('aytilmagan');
  });

  it('…but never in a rail chat: no machine figure goes out there, so no flight was quoted — the question is the rail one', () => {
    const rail = ctxOf("Temir yo'l bilan 40 kg qancha?", 'latin');
    expect(rule(compose('uz'), [air], rail)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
  });
});

describe('which chat is a flight\'s — the review of the follow-up (review R1-R4)', () => {
  const yiwu = () => `Assalomu alaykum! ${answer('china_address_yiwu@1')}`;
  const blocked = (ctx: AgentContext) => judge(ctx, 'latin', 'uz', yiwu()).includes('avia_address');
  const kg30 = [{ ref: 'w1', kind: 'weight' as const, value: 30, messageRef: '#1' }];

  it('R1: the flight he was quoted stays the chat\'s road, however the customer words the follow-up', () => {
    // (a) the goods are called «…mashinasi»; (e) «автозапчасти» — a road word inside the goods' name.
    expect(blocked(ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Tikuv mashinasi 30 kg, avia bilan qancha?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE))).toBe(true);
    expect(blocked(ctxOf('Куда отправлять?', 'cyrillic', [said('Автозапчасти 30 кг авиа сколько?', 1), said('Авиа примерно 510 $.', 2, 'out')], kg30, AIR_QUOTE))).toBe(true);
    // (d) the customer never said «avia» — the quote did.
    expect(blocked(ctxOf('Ok, manzilni yuboring', 'latin', [said('30 kg kiyim Shenzhendan, eng tez qanday?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE))).toBe(true);
    // (f) the sent line named no road at all — the approved draft it came from did.
    expect(blocked(ctxOf('Manzilni yuboring', 'latin', [said('30 kg kiyim, eng tez qanday?', 1), said("30 kg uchun taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE))).toBe(true);
  });

  it('R1: a quote he approved AFTER our older priced line is the road — the newer of the two speaks', () => {
    const later: AgentContext['lastQuote'] = { road: 'road', air: null, at: new Date(Date.now() + 60_000) };
    const ctx = ctxOf('Manzilni bering', 'latin', [said('Avia 20 kg qancha?', 1), said('Avia 340 $.', 2, 'out')], [], later);
    expect(blocked(ctx)).toBe(false);
    expect(rule(compose('uz'), [], ctx)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
  });

  it('R1: the customer\'s own choice in this burst decides — a road turned down is no choice', () => {
    // (b) both roads compared, then «Unda avia bilan».
    expect(blocked(ctxOf('Unda avia bilan. Manzil qayerga yuboraman?', 'latin', [said("Avia va mashinada qancha bo'ladi? 30 kg", 1), said('Mashinada 1 kubdan, avia 510 $.', 2, 'out')], kg30))).toBe(true);
    // (c) «Mashinada emas, avia bilan» — the truck turned down, the flight chosen.
    expect(blocked(ctxOf('Mashinada emas, avia bilan yuboraman. Manzil?', 'latin', [], kg30))).toBe(true);
    // …and the flight turned down is the truck's address, in three languages.
    for (const body of [
      'Avia qimmat ekan, kerak emas. Ivu omboringiz manzilini tashlang',
      'Aviada emas, oddiy kargo bilan yuboraman. Manzilni bering',
      'Не авиа, обычным карго. Скиньте адрес склада в Иу',
    ]) {
      const ctx = ctxOf(body, 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE);
      expect(blocked(ctx), body).toBe(false);
      expect(rule(compose('uz'), [], ctx), body).toMatchObject({ needsOwner: false, ownerQuestion: '' });
    }
  });

  it('R1: an old avia question the truck quote came after is the truck\'s chat now', () => {
    const ctx = ctxOf(
      'Manzilni bering, Ivuga yuboraman',
      'latin',
      [said('Avia bilan 20 kg qancha?', 1), said('Avia 340 $.', 2, 'out'), said('Qimmat ekan', 3), said('3 kub kiyim bor, Ivudan Toshkentga qancha?', 4), said('Taxminan 640 $.', 5, 'out')],
      [],
      ROAD_QUOTE,
    );
    expect(blocked(ctx)).toBe(false);
    expect(rule(compose('uz'), [], ctx)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
  });

  it('R1: «air» is a road only as «air freight» / «by air»; «kargo» is the truck unless it is «avia kargo»', () => {
    for (const t of ['by air', 'via air', 'air freight', 'air-cargo', 'aircargo', 'avia bilan', 'авиа', '空运']) expect(namesMode(t, 'air'), t).toBe(true);
    for (const t of ['air fryer', 'Air Max krossovka', 'air conditioner']) expect(namesMode(t, 'air'), t).toBe(false);
    for (const t of ['oddiy kargo bilan', 'обычным карго', 'kargoda']) expect(namesMode(t, 'road'), t).toBe(true);
    for (const t of ['avia kargo bilan', 'авиа-карго']) expect(namesMode(t, 'road'), t).toBe(false);
  });

  it('R1: goods named after the air are no flight — «air fryer», «air conditioner»', () => {
    for (const body of ['300 ta air fryer, 4 kub, Ivudan yuboraman. Manzilni bering', 'Air conditioner 5 kub, Ivu sklad adresi?']) {
      const ctx = ctxOf(body, 'latin');
      expect(blocked(ctx), body).toBe(false);
      expect(rule(compose('uz'), [], ctx).needsOwner, body).toBe(false);
    }
  });

  it('R1: a truck section asked this run (podklyuch) is the truck\'s chat, as a truck estimate is', () => {
    const ctx = ctxOf('Unda podklyuch qilib Ivuga 3 kub yuboraman. Ivu manzili qanday?', 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')], kg30, AIR_QUOTE);
    const checklist: ToolOutcome = {
      ok: true,
      text: '',
      sources: [],
      checklist: { section: 'podklyuch', facts: {} as never, complete: false, fromOurWarehouse: false },
    };
    expect(judge(ctx, 'latin', 'uz', yiwu(), [checklist], [{ name: 'calc_checklist', ok: true, text: '' }])).not.toContain('avia_address');
  });

  it('R2: only «where do I send it» asks him — thanks, his own address, a pickup or an arrival never do', () => {
    const avia = (body: string, replyNeeded = true) =>
      rule(compose('uz', { replyNeeded, replyText: replyNeeded ? 'x' : '' }), [], ctxOf(body, 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE)).needsOwner;
    for (const body of [
      'Rahmat, manzilni oldim',
      'Shu manzilga yubordim, trek raqami 7788',
      'Toshkentda manzilingiz qayerda? Qayerga kelib olaman?',
      'Откуда вылетает самолёт?',
      'Откуда считается цена?',
      'Avia bilan qayergacha yetkazasiz?',
      'Mening manzilim: Toshkent, Chilonzor 5-kvartal',
      'Yukim qayerga yetib keldi?',
      'Куда пришёл мой груз?',
    ]) {
      expect(avia(body), body).toBe(false);
    }
    // A line that needs no reply never becomes a question card.
    expect(avia('Manzil qayerga yuboraman?', false)).toBe(false);
    for (const body of [
      'Adresni tashlang',
      'Манзилни юборинг',
      'Qaysi omborga yuboray?',
      'Omboringiz qayerda?',
      'Qayoqqa yuboray?',
      'Манзил қаерда?',
      'Lokatsiya tashlang',
      'Where is your warehouse?',
      'Please send the warehouse location',
      'نشانی انبار را بفرستید',
      'کجا ارسال کنم؟',
      '寄哪里？',
      '仓库在哪里？',
    ]) {
      expect(avia(body), body).toBe(true);
    }
  });

  it('R2: whenever the guard holds the draft, the card asks him — the guard and the question are one rule', () => {
    const ctx = ctxOf('Ivu omboringiz qayerda joylashgan?', 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')], kg30, AIR_QUOTE);
    const held = { ok: false, blocks: [{ rule: 'G6' as const, code: 'avia_address' as const }], warnings: [], ledger: [] };
    const c = withAviaGuard(compose('uz', { replyText: yiwu() }), held, { outcomes: [], tools: [] }, ctx);
    expect(c).toMatchObject({ needsOwner: true, ownerQuestion: aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }) });
    // Nothing held, nothing asked.
    const clear = { ok: true, blocks: [], warnings: [], ledger: [] };
    expect(withAviaGuard(compose('uz'), clear, { outcomes: [], tools: [] }, ctx)).toMatchObject({ needsOwner: false });
  });

  it('R3: the card names where the cargo STARTS — never the warehouse asked about', () => {
    // No quote stored (the chat moved to avia in this burst): the kilos and the origin come from the chat.
    const a = ctxOf('Avia bilan. Ivu omboringiz manzilini bering', 'latin', [said('Avia bilan 30 kg qancha?', 1)], kg30);
    expect(rule(compose('uz'), [], a).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 30, origin: null }));
    const b = ctxOf('Avia bilan. Ivu omboringiz manzilini bering', 'latin', [said('Shenzhendan avia 30 kg qancha?', 1)], kg30);
    expect(rule(compose('uz'), [], b).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
  });
});

describe('what reads as our warehouse — the review of the anchors (review R5-R8)', () => {
  it('R5: a piece of the street that the house number splits, and the house number beside a street word', () => {
    expect(statesChinaAddress('Ivu omboriga yuboring: Yiwu, 荷花南街 2255号. GS kodni yozing.', ANCHORS)).toBe(true);
    expect(statesChinaAddress("Manzil: Zhejiang, Yiwu, Choujiang ko'chasi, Hehua South Street 2255, Zhou xiansheng.", ANCHORS)).toBe(true);
    expect(statesChinaAddress('Адрес: Иу, Чоуцзян, улица Хэхуа Наньцзе 2255, господин Чжоу.', ANCHORS)).toBe(true);
    // The number alone is no address.
    expect(statesChinaAddress('Trek raqami 2255.', ANCHORS)).toBe(false);
  });

  it('R6: the warehouse\'s own name and the receiving company are ours', () => {
    expect(statesChinaAddress('霍尔果斯金亿国际物流中心, qabul qiluvchi ASQAR', ANCHORS)).toBe(true);
    expect(statesChinaAddress('Guanchjou ombori: Foshan, 拓派国际物流有限公司, qabul qiluvchi 王红.', ANCHORS)).toBe(true);
  });

  it('R7: the province, city or district a customer\'s cargo starts from is nobody\'s address', () => {
    for (const text of ['您好！从浙江省义乌市空运30公斤大约510美元。', '从广东省佛山市空运吗？', '佛山市南海区发货，空运多少？', '从霍尔果斯市空运吗？', '新疆维吾尔自治区也可以空运。']) {
      expect(statesChinaAddress(text, ANCHORS), text).toBe(false);
    }
  });

  it('R9: a warehouse he adds on the page is a receiving address by what it says — a flight\'s address he writes is not', () => {
    expect(isReceivingAddressFact('Qashqar qabul ombori: 新疆喀什市迎宾大道88号，王先生 13900001111.')).toBe(true);
    expect(isReceivingAddressFact('Shenzhen ombori qayerda? — 广东省深圳市宝安区福永街道 塘尾路 18号')).toBe(true);
    // His own flight's receiving point — a warehouse word and a street — is the flight's, and his to have quoted.
    expect(isReceivingAddressFact('Avia yuk qabul ombori: 广东省深圳市宝安区机场路 5号，13700002222.')).toBe(false);
    expect(isReceivingAddressFact('Авиа склад: 广东省深圳市宝安区机场路 5号.')).toBe(false);
    expect(isReceivingAddressFact(answer('china_points@4'))).toBe(false);
    expect(isReceivingAddressFact('Toʻlov: naqd yoki karta orqali.')).toBe(false);
    // Every seeded address is one by what it says, too.
    for (const f of SEED_FACTS.filter((x) => x.key.startsWith(WAREHOUSE_ADDRESS_SEED))) expect(isReceivingAddressFact(f.answer), f.key).toBe(true);
  });

  it('R8: the verbatim Horgos address inside a Chinese sentence is the fact\'s spelling, not a figure', () => {
    const reply =
      '您好！5立方的货请发到霍尔果斯金亿国际物流中心 新疆维吾尔自治区伊犁哈萨克自治州霍尔果斯市南京路与宁波路交叉口正东方向168米左右。收货人：ASQAR 18309082036。发货前请不要忘记标注GS编码（唛头）。';
    expect(judge('我有5立方的货，霍尔果斯仓库地址在哪里？', 'han', 'zh', reply)).not.toContain('number_unverifiable');
  });
});

describe('written down for the model', () => {
  it('the prompt gives the warehouse address as the fact has it, and never a flight\'s', async () => {
    const { stableHead } = await import('@/modules/wms/agent/prompt');
    const head = stableHead({ styleGuide: null, facts: [] });
    expect(head).toMatch(/bilimdagidek, xitoycha qismini o'zgartirmay va tarjima qilmay, GS kod eslatmasi bilan/u);
    expect(head).toMatch(/avia manzilini HECH QACHON aytma/u);
    expect(head).toContain('owner_question="Avia: <tovar>, <kg> kg, <qayerdan> — manzilni bering"');
    // K32's sentence for the flight is gone (his fourth set «2»).
    expect(head).not.toMatch(/avia narxi ham Xitoydagi omborimizdan/u);
    // A contact the knowledge carries is the knowledge's (rule 5).
    expect(head).toMatch(/bilimdagi faktda yozilgan aloqa/u);
  });

  it('nothing claims avia cargo is not received in China — he said only that he gives its address (review D7)', async () => {
    const { stableHead } = await import('@/modules/wms/agent/prompt');
    const { readFileSync } = await import('node:fs');
    const head = stableHead({ styleGuide: null, facts: [] });
    const tool = readFileSync('src/modules/wms/agent/tools.ts', 'utf8');
    for (const text of [head, tool, answer('china_points@4')]) {
      expect(text).not.toMatch(/YUBORILMAYDI|yuborilmaydi —|manzillar EMAS/u);
    }
    expect(answer('china_points@4')).toMatch(/Avia uchun manzilni AI aytmaydi/u);
    expect(head).toMatch(/Avia uchun manzilni AI aytmaydi/u);
  });

  it('the price-from-our-warehouses fact is the TRUCK\'s (review D6) — a flight is weight × rate', () => {
    const f = SEED_FACTS.find((x) => x.key.startsWith('china_warehouse_price@'))!;
    expect(f.answer).toMatch(/^Avto \(mashina\) narxi Xitoydagi omborlarimizdan hisoblanadi/u);
    expect(f.question).toMatch(/mashina/iu);
  });

  it('every receiving warehouse fact sits under the one seed key the policy reads them by', () => {
    const keys = SEED_FACTS.map((f) => f.key).filter((k) => k.startsWith(WAREHOUSE_ADDRESS_SEED));
    expect(keys).toEqual(['china_address_yiwu@1', 'china_address_guangzhou@1', 'china_address_horgos@1']);
    // Each one's phone is an anchor: the warehouse is named by its contact as well as its street.
    expect(ANCHORS.phones).toEqual(['429089596', '266376775', '309082036']);
    expect(ANCHORS.pieces.length).toBeGreaterThanOrEqual(3);
    // The GS reminder every warehouse carries is nobody's address: no piece of it is an anchor.
    expect(ANCHORS.pieces.some((p) => '发货前请不要忘记标注编码唛头'.includes(p))).toBe(false);
    // …left out twice over: as the text every address shares (no `ordinary` given), and as the ordinary text a lone address carries.
    const reminderPiece = (a: AddressAnchors) => a.pieces.some((p) => '发货前请不要忘记标注编码唛头'.includes(p));
    expect(reminderPiece(addressAnchorsOf(SEED_FACTS.filter((f) => f.key.startsWith(WAREHOUSE_ADDRESS_SEED)).map((f) => f.answer)))).toBe(false);
    expect(reminderPiece(addressAnchorsOf([answer('china_address_yiwu@1')], [GS_REMINDER]))).toBe(false);
    // The house numbers a street address names — never a phone's digits.
    expect(ANCHORS.houseNumbers).toEqual(['2255', '168']);
  });

  it('both run paths — a customer\'s message and his hand-back — draft through the avia rule, judge THAT draft, then let the guard ask him', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
    const path = /const drafted = withAviaRule\(withRailRule\(loop\.compose, ctx\), loop, ctx\);[\s\S]*?body: drafted\.replyText,[\s\S]*?const c = withAviaGuard\(drafted, policy, loop, ctx\);\s*const \{ actions, notes \} = validateActions\(c,/gu;
    expect(src.match(path)?.length).toBe(2);
  });

  it('the stored memory reaches the policy at the write AND at ✅ — policyFor passes both new fields', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/modules/wms/agent/policy-input.ts', 'utf8');
    expect(src).toMatch(/aviaOnly: input\.memory\.aviaOnly === true,/u);
    expect(src).toMatch(/quotableHan: input\.memory\.quotableHan \?\? '',/u);
  });
});
