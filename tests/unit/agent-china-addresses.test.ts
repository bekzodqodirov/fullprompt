import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { normalizeDigits } from '@/modules/wms/agent/digits';
import type { KbHit } from '@/modules/wms/agent/kb';
import { airMentionIn, namesMode, PHONE_RE, pricedRoadOf, roadChoiceIn } from '@/modules/wms/agent/numbers';
import {
  addressAnchorsOf,
  checkAgentReply,
  isReceivingAddressFact,
  statesChinaAddress,
  withoutQuotedHan,
  type AddressAnchors,
  type PolicyInput,
} from '@/modules/wms/agent/policy';
import {
  askedModeOf,
  asksWhereToSend,
  aviaOwnerQuestion,
  chatRoadOf,
  memoryFor,
  railChat,
  shipmentWeightIn,
  withAviaGuard,
  withAviaRule,
  type ComposeReply,
} from '@/modules/wms/agent/run';
import { chatForm } from '@/modules/wms/agent/context';
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
const AIR_QUOTE: AgentContext['lastQuote'] = { road: 'air', air: { kg: 30, origin: 'Shenzhen' }, at: new Date(0), text: null, tgMessageId: null, edited: false };
const ROAD_QUOTE: AgentContext['lastQuote'] = { road: 'road', air: null, at: new Date(0), text: null, tgMessageId: null, edited: false };

/** The policy over a reply, on the memory a real run stores — as `policyFor` maps it. */
function judge(
  customer: string | AgentContext,
  script: 'latin' | 'cyrillic' | 'han',
  language: 'uz' | 'ru' | 'zh',
  reply: string,
  outcomes: ToolOutcome[] = [],
  tools: { name: string; ok: boolean; text: string }[] = [],
) {
  return verdict(customer, script, language, reply, outcomes, tools).blocks.map((b) => b.code);
}

function verdict(
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
    aviaMentioned: mem.aviaMentioned === true,
    quotableHan: mem.quotableHan ?? '',
    warehouseAddress: ANCHORS,
  };
  return checkAgentReply(input);
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
    expect(statesChinaAddress('浙江省 义乌市 稠江街道 荷花南街', ANCHORS)).toBe(true);
    expect(statesChinaAddress('地址：义乌市稠江街道荷花南街', ANCHORS)).toBe(true);
    // The subdistrict alone is every supplier's in it (review #1484) — «稠江街道贝村路88号» is not ours.
    expect(statesChinaAddress('浙江省 义乌市 稠江街道', ANCHORS)).toBe(false);
    expect(statesChinaAddress('义乌市稠江街道贝村路88号', ANCHORS)).toBe(false);
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
    const later: AgentContext['lastQuote'] = { road: 'road', air: null, at: new Date(Date.now() + 60_000), text: null, tgMessageId: null, edited: false };
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
      // The truck draft he approved, whose text went out as «Taxminan 640 $.» — its echo is that quote's road.
      { ...ROAD_QUOTE!, text: 'Taxminan 640 $.' },
    );
    expect(blocked(ctx)).toBe(false);
    expect(rule(compose('uz'), [], ctx)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
  });

  it('R1: «air» is a road only as «air freight» / «by air»; «kargo» is the truck only as «oddiy / yig\'ma kargo»', () => {
    for (const t of ['by air', 'via air', 'air freight', 'air-cargo', 'aircargo', 'avia bilan', 'авиа', '空运']) expect(namesMode(t, 'air'), t).toBe(true);
    for (const t of ['air fryer', 'Air Max krossovka', 'air conditioner']) expect(namesMode(t, 'air'), t).toBe(false);
    // …and as the way a thing goes — «kargoda», «kargo bilan», «kargo orqali» (#1485): «Kargo bilan necha kunda?» asks the truck's days.
    for (const t of ['oddiy kargo bilan', 'обычным карго', "yig'ma kargo", 'kargoda', 'Kargo bilan necha kunda?', 'kargo orqali']) expect(namesMode(t, 'road'), t).toBe(true);
    // A bare «kargo» is the COMPANY (review #1484): «kargongiz», «kargo manzili», «Kargo narxini ayting».
    for (const t of ['avia kargo bilan', 'авиа-карго', 'avia kargoda', 'Kargongizga qayerga yuboraman?', 'Kargo narxini ayting']) expect(namesMode(t, 'road'), t).toBe(false);
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

describe('the road is what we quoted, whatever the words name — the third review (#1484)', () => {
  const yiwu = () => `Assalomu alaykum! ${answer('china_address_yiwu@1')}`;
  const blocked = (ctx: AgentContext) => judge(ctx, 'latin', 'uz', yiwu()).includes('avia_address');
  const asked = (ctx: AgentContext) => rule(compose('uz'), [], ctx).needsOwner;
  const kg30 = [{ ref: 'w1', kind: 'weight' as const, value: 30, messageRef: '#1' }];
  const echoOf = (text: string): AgentContext['lastQuote'] => ({ ...AIR_QUOTE!, text });

  it('the approved quote\'s own echo is its stored road, though its words name the goods', () => {
    const sent = "Tikuv mashinasi 30 kg avia orqali taxminan 510 $ bo'ladi.";
    const a = ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Tikuv mashinasi 30 kg, avia bilan qancha?', 1), said(sent, 2, 'out')], kg30, echoOf(sent));
    expect(blocked(a)).toBe(true);
    expect(asked(a)).toBe(true);
    // A hand-typed line is read at its PRICE, never by the goods: «Автозапчасти 30 кг авиа примерно 510 $» quoted the flight.
    const c = ctxOf('Куда отправлять?', 'cyrillic', [said('Автозапчасти 30 кг авиа сколько?', 1), said('Автозапчасти 30 кг авиа примерно 510 $.', 2, 'out')], kg30);
    expect(judge(c, 'cyrillic', 'ru', `Здравствуйте! ${answer('china_address_yiwu@1')}`)).toContain('avia_address');
  });

  it('an echo whose words price one road while the draft quoted two is the draft\'s — the stored road, not the words', () => {
    const sent = 'Avia: 30 kg — taxminan 510 $, 2–5 kun. Mashina bilan arzonroq, 1 kubdan.';
    const ctx = ctxOf('Yaxshi, manzilni yuboring', 'latin', [said('30 kg kiyim, avia va mashinada qancha?', 1), said(sent, 2, 'out')], kg30, { road: 'both', air: null, at: new Date(0), text: sent, tgMessageId: null, edited: false });
    expect(pricedRoadOf(sent)).toBe('air');
    expect(blocked(ctx)).toBe(false);
    expect(asked(ctx)).toBe(false);
  });

  it('the goods and the company are no road chosen — «Tikuv mashinalarini …», «Kargongizga …», «kargo manzili»', () => {
    for (const body of ['Tikuv mashinalarini qayerga yuboray?', 'Kargongizga qayerga yuboraman?', 'Yaxshi, kargo manzilini tashlang', 'Хорошо, скиньте адрес карго']) {
      const ctx = ctxOf(body, 'latin', [said('Avia bilan Guanchjoudan 30 kg qancha?', 1), said('Avia: 30 kg × 17 $ ≈ 510 $ (taxminan), 2–5 kun.', 2, 'out')], kg30, AIR_QUOTE);
      expect(blocked(ctx), body).toBe(true);
      expect(asked(ctx), body).toBe(true);
    }
  });

  it('a customer accepting the flight is no refusal — «qimmat emas», «muammo yo\'q», «boshqasi kerakmas», «не знаю куда»', () => {
    for (const body of [
      'Avia narxi qimmat emas ekan, shu bilan yuboraman. Manzilni tashlang',
      'Avia qimmat emas, yuboraman. Manzil?',
      "avia bilan yuboraman muammo yo'q manzil qayerga",
      'Avia bilan kerak boshqasi kerakmas manzil?',
      'Хорошо авиа отправлю не знаю куда отправлять',
      'Mashinada uzoq ekan avia bilan yuboraman manzil qayerga',
      'Fura 20 kun ekan avia bilan yuboramiz manzilni tashlang',
    ]) {
      const ctx = ctxOf(body, 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said("Avia bilan taxminan 510 $ bo'ladi.", 2, 'out')], kg30, AIR_QUOTE);
      expect(blocked(ctx), body).toBe(true);
      expect(asked(ctx), body).toBe(true);
    }
  });

  it('a truck chosen in words is the truck\'s, whatever the goods are called — and a refusal it does not name is still one', () => {
    for (const body of [
      "Mashinada yuboraman. Tovar: bolalar samolyot o'yinchoqlari, 2 kub. Manzil qayerga?",
      'Отправлю машиной. Товар: игрушки самолёты, 2 куба. Куда отправлять?',
      "Fura bilan yuboraman, tovar aviator ko'zoynaklar 3 kub. Ivu manzilini bering",
      "Mashinada yuboramiz, avia to'g'ri kelmaydi. Manzilni bering",
      'By truck please, no air freight. Send the Yiwu warehouse address',
      'Mashinada, aviasiz. Ivu manzilini tashlang',
    ]) {
      const ctx = ctxOf(body, 'latin');
      expect(blocked(ctx), body).toBe(false);
      expect(asked(ctx), body).toBe(false);
    }
  });

  it('our priced line is read at its price, and an echo of a truck or two-road quote is no flight', () => {
    expect(pricedRoadOf("Avia bilan 30 kg taxminan 510 $ boʻladi, 2–5 kun. Eslatma: power bank va litiy batareya avia bilan ketmaydi, ular faqat avto yoki temir yoʻl bilan ketadi.")).toBe('air');
    expect(pricedRoadOf('Avto (mashina) narxi: 3 kub — taxminan 640 $, 15–25 kun. Avia: 300 kg — taxminan 5100 $, 2–5 kun.')).toBe('both');
    expect(pricedRoadOf('3 kub uchun taxminan 640 $.')).toBe('road');
    expect(pricedRoadOf('Taxminan 640 $, 15–25 kunda keladi.')).toBeNull();
    const battery = "Avia bilan 30 kg taxminan 510 $ boʻladi, 2–5 kun. Eslatma: power bank faqat avto bilan ketadi.";
    expect(blocked(ctxOf('Tushunarli, batareya yoʻq. Manzil qayerga?', 'latin', [said('Guanchjoudan avia bilan yuk yubormoqchiman', 1), said(battery, 2, 'out')], kg30))).toBe(true);
    const both = 'Avto (mashina) narxi: 3 kub — taxminan 640 $, 15–25 kun. Avia: 300 kg — taxminan 5100 $, 2–5 kun.';
    expect(blocked(ctxOf('Yaxshi, manzilni yuboring', 'latin', [said('3 kub, 300 kg — avia va mashinada qancha?', 1), said(both, 2, 'out')], [], { road: 'both', air: null, at: new Date(0), text: both, tgMessageId: null, edited: false }))).toBe(false);
    const truck = "Avto (mashina) bilan 3 kub — taxminan 640 $, 15–25 kun. Tezroq kerak bo'lsa avia ham bor.";
    expect(blocked(ctxOf('Yaxshi, manzilni yuboring', 'latin', [said('3 kub kiyim, qancha?', 1), said(truck, 2, 'out')], [], { road: 'road', air: null, at: new Date(0), text: truck, tgMessageId: null, edited: false }))).toBe(false);
  });

  it('an avia chat with nothing quoted yet is still the flight\'s — the customer chose it', () => {
    const ctx = ctxOf('30 kg. Manzil qayerga?', 'latin', [said('Assalomu alaykum, Guanchjoudan avia bilan yuk yubormoqchiman', 1), said('Vaalaykum assalom! Yuk necha kg?', 2, 'out')], [
      { ref: 'w1', kind: 'weight', value: 30, messageRef: '#3' },
    ]);
    expect(chatRoadOf(ctx, { tools: [], outcomes: [] })).toBe('air');
    expect(blocked(ctx)).toBe(true);
    expect(rule(compose('uz'), [], ctx).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Guangzhou' }));
  });

  it('«kargo» no longer ends the rail rule', () => {
    const ctx = ctxOf('5 kub, 800 kg. Kargo narxini ayting', 'latin', [said("Temir yo'l bilan Urumchidan Toshkentga qancha bo'ladi?", 1), said('Aniqlab aytaman.', 2, 'out')]);
    expect(railChat(ctx, compose('uz', { replyText: '5 kub, 800 kg yuk uchun taxminan 480 $ boʻladi.' }))).toBe(true);
  });

  it('the card names the customer\'s NEW shipment, and never the warehouse he sends to as the origin', () => {
    const a = ctxOf('Yana yuk bor: 80 kg, endi Guanchjoudan avia bilan. Qayerga yuboray?', 'latin', [said('Shenzhendan avia 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')], [
      { ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' },
      { ref: 'w2', kind: 'weight', value: 80, messageRef: '#3' },
    ], AIR_QUOTE);
    expect(rule(compose('uz'), [], a).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 80, origin: 'Guangzhou' }));
    const b = ctxOf("Ivu omboringizga yuborsam bo'ladimi?", 'latin', [said('Avia bilan 15 kg kiyim qancha bo\'ladi?', 1)], [{ ref: 'w1', kind: 'weight', value: 15, messageRef: '#1' }]);
    const held = { ok: false, blocks: [{ rule: 'G6' as const, code: 'avia_address' as const }], warnings: [], ledger: [] };
    expect(withAviaGuard(compose('uz', { replyText: yiwu() }), held, { outcomes: [], tools: [] }, b).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 15, origin: null }));
  });

  it('where the cargo ARRIVES, or an address he gives, is no «where do I send it»', () => {
    for (const body of ['Yuk qayerga keladi?', 'Куда придёт груз?', 'Куда доставите груз?', 'Yetkazib berish manzili: Samarqand shahri', "Manzil: Andijon, Navoiy ko'chasi 12"]) {
      expect(asksWhereToSend([{ body }]), body).toBe(false);
    }
    for (const body of ['Qayerga yuborsam tez keladi?', 'Manzil?', 'Manzil: ?', 'Куда отправлять, чтобы быстрее пришло?']) expect(asksWhereToSend([{ body }]), body).toBe(true);
  });

  it('a warehouse typed twice is still ours — the two facts do not cancel each other\'s street', () => {
    const seed = SEED_FACTS.filter((f) => f.key.startsWith(WAREHOUSE_ADDRESS_SEED)).map((f) => f.answer);
    const twice = addressAnchorsOf(
      [
        ...seed,
        'Foshan (Guanchjou) ombori, yangi: 广东省佛山市南海区里水镇胜利社区胜利工业区29号3栋 拓派国际物流有限公司. Telefon: 王红 13266376775.',
        'Ivu ombori (yangi qabul qiluvchi): 浙江省 义乌市 稠江街道 荷花南街 2255号，李先生 13800001111',
      ],
      [GS_REMINDER],
    );
    expect(statesChinaAddress('Guanchjou ombori: 广东省佛山市南海区里水镇胜利社区胜利工业区29号3栋 拓派国际物流有限公司.', twice)).toBe(true);
    expect(statesChinaAddress('Yukni shu manzilga yuboring: 义乌市稠江街道荷花南街，周先生。', twice)).toBe(true);
  });

  it('a truck warehouse that says «avia emas» is still a receiving address; an airport\'s is the flight\'s', () => {
    expect(isReceivingAddressFact('Ivu ombori (faqat avto kargo uchun, avia yuklar bu yerga emas): 浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596.')).toBe(true);
    for (const t of ['Shenzhen aeroport ombori: 广东省深圳市宝安区机场路 5号, Li 13700002222.', 'Аэропорт склад: 广东省深圳市宝安区机场路 5号.', '机场仓库：广东省深圳市宝安区机场路5号']) {
      expect(isReceivingAddressFact(t), t).toBe(false);
    }
    expect(roadChoiceIn('Ivu ombori (faqat avto kargo uchun, avia yuklar bu yerga emas)')).toBe('both');
  });

  it('what every Chinese address is made of names nobody — crossings, «…米», districts, a date «28号»', () => {
    for (const text of [
      'Yukni 义乌市福田路与城北路交叉口 dagi zavoddan olib kelasizmi?',
      '供应商地址：金华市人民路与解放路交叉口正东方向200米',
      '广州市白云区胜利社区',
      "Yetkazish manzili: Navoiy ko'chasi 168, Toshkent",
      'Авиа дороговато: 168 кг — 2 856 $',
      'Air: 168 kg — 2856 $. By road it is cheaper, 15–25 days.',
      '空运168公斤，10月28号发货',
      'Авиа доставка 2255 кг обойдётся примерно в 38 335 $. Это дорого, зато быстро.',
      // A house number counts only BESIDE its street word, not anywhere in the reply.
      "Avia 2255 kg uchun taxminan 38 335 $ bo'ladi, Toshkentda yetkazib beramiz: Navoiy ko'chasi.",
    ]) {
      expect(statesChinaAddress(text, ANCHORS), text).toBe(false);
    }
    // The transliterated street still counts, its number beside its street word.
    expect(statesChinaAddress('Ivu ombori: Yiwu, Choujiang jiedao, Hehua Nanjie 2255-hao, Zhou xiansheng.', ANCHORS)).toBe(true);
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
    // «168米» is a distance, not a house number (review #1484).
    expect(ANCHORS.houseNumbers).toEqual(['2255']);
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
    expect(src).toMatch(/aviaMentioned: input\.memory\.aviaMentioned === true,/u);
    // …and the warehouses are read for the warning as well as the block.
    expect(src).toMatch(/input\.memory\.aviaOnly === true \|\| input\.memory\.aviaMentioned === true \|\| airMentionIn\(input\.body\)\s*\? warehouseAddressTexts\(\)/u);
    expect(src).toMatch(/quotableHan: input\.memory\.quotableHan \?\? '',/u);
  });
});

describe('the fourth review (#1485): the words that pick a road, our quote by its identity, our warehouses by their streets', () => {
  const yiwu = () => `Assalomu alaykum! ${answer('china_address_yiwu@1')}`;
  const blocked = (ctx: AgentContext) => judge(ctx, 'latin', 'uz', yiwu()).includes('avia_address');
  const warned = (ctx: AgentContext) => verdict(ctx, 'latin', 'uz', yiwu()).warnings.some((w) => w.code === 'avia_maybe');
  const card = (ctx: AgentContext) => rule(compose('uz'), [], ctx).ownerQuestion;
  const flight = [said('Shenzhendan avia 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')];
  const kg30 = [{ ref: 'w1', kind: 'weight' as const, value: 30, messageRef: '#1' }];
  const quote = (patch: Partial<NonNullable<AgentContext['lastQuote']>>): AgentContext['lastQuote'] => ({ ...AIR_QUOTE!, ...patch });

  it('goods, the factory\'s leg and a toy are no road chosen — the flight he was quoted stays the chat\'s', () => {
    for (const t of ['Avto chexol 2 kub, qancha?', 'Avto chexollarni qayerga yuboray?', 'Zavoddan mashinada olib kelasizmi?', 'Fabrikadan omborga mashina bilan', 'toy trucks 2 cbm', 'Toshkentdan mashinada olib ketaman']) {
      expect(roadChoiceIn(t), t).toBeNull();
    }
    for (const body of ['Avto chexol 30 kg. Manzil qayerga?', 'Zavoddan mashinada olib kelasizmi? Manzil qayerga?', 'Toy trucks 30 kg. Where do I send them?']) {
      expect(blocked(ctxOf(body, 'latin', flight, kg30, AIR_QUOTE)), body).toBe(true);
    }
  });

  it('a road turned down with words between — «Avia juda qimmat ekan», «Авиа нам не подходит» — is the other road', () => {
    expect(roadChoiceIn('Avia juda qimmat ekan')).toBe('not_air');
    expect(roadChoiceIn('Авиа нам не подходит')).toBe('not_air');
    expect(roadChoiceIn('Avia biz uchun qimmat')).toBe('not_air');
    expect(roadChoiceIn('Avia qimmat emas')).toBe('air');
    const ctx = ctxOf('Mashinada qancha? Avia juda qimmat ekan. Ivu manzilini tashlang', 'latin', flight, kg30, AIR_QUOTE);
    expect(chatRoadOf(ctx, { tools: [], outcomes: [] })).toBe('road');
    expect(blocked(ctx)).toBe(false);
    const ru = ctxOf('Сколько машиной? Авиа нам не подходит. Адрес склада в Иу?', 'cyrillic', [said('Из Шэньчжэня авиа 30 кг сколько?', 1), said('Авиа 510 $.', 2, 'out')], kg30, AIR_QUOTE);
    expect(chatRoadOf(ru, { tools: [], outcomes: [] })).toBe('road');
  });

  it('a truck chosen in one bare word is a choice, and our line pricing «Mashina 1 kub» is the truck', () => {
    expect(roadChoiceIn("Mashina bo'lsin")).toBe('road');
    expect(blocked(ctxOf("Mashina bo'lsin. Ivu manzili?", 'latin', [said('30 kg, avia yoki mashina?', 1), said('Avia: 30 kg — 510 $.', 2, 'out')]))).toBe(false);
    expect(pricedRoadOf('Mashina 1 kub 250$')).toBe('road');
    const chat = [said('Avia bilan 30 kg qancha?', 1), said('Avia: 30 kg — 510 $.', 2, 'out'), said("1 kub bo'lsa?", 3), said('Mashina 1 kub 250$', 4, 'out')];
    expect(blocked(ctxOf('Ivu manzilini bering', 'latin', chat))).toBe(false);
  });

  it('«Mashinada 1 kubdan kam olinmaydi, faqat avia: 30 kg — 510 $» priced the flight alone', () => {
    const line = 'Mashinada 1 kubdan kam olinmaydi, faqat avia: 30 kg — 510 $.';
    expect(pricedRoadOf(line)).toBe('air');
    expect(blocked(ctxOf('Manzil qayerga?', 'latin', [said('Kiyim 30 kg, qancha?', 1), said(line, 2, 'out')], kg30))).toBe(true);
  });

  it('the quote\'s echo is known by its Telegram id, and by its words in the form the chat holds them', () => {
    // The chat's copy reads as a truck at its price; it IS the flight's quote by its id.
    const echo = said('Mashina: 30 kg — taxminan 510 $.', 2, 'out');
    expect(pricedRoadOf(echo.body)).toBe('road');
    expect(blocked(ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Tikuv mashinasi 30 kg avia bilan qancha?', 1), echo], kg30, quote({ text: 'boshqa matn', tgMessageId: 2n })))).toBe(true);
    // A long quote in Persian digits: the chat holds it digit-read and clipped.
    const long = `Mashina: 30 kg — taxminan ۵۱۰ $.${' Eslatma: batareyalar alohida.'.repeat(40)}`;
    expect([...long].length).toBeGreaterThan(1000);
    const held = said(chatForm(long), 2, 'out');
    expect(blocked(ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Tikuv mashinasi 30 kg avia bilan qancha?', 1), held], kg30, quote({ text: long })))).toBe(true);
  });

  it('a quote he rewrote with ✏️ is read at its price — his words, not the stored road', () => {
    const his = 'Mashina bilan 3 kub — taxminan 640 $.';
    const chat = [said('30 kg yoki 3 kub, qanday?', 1), said(his, 2, 'out')];
    expect(blocked(ctxOf('Ivu manzilini bering', 'latin', chat, kg30, quote({ text: his, edited: true })))).toBe(false);
    // Not rewritten: the stored road is the quote's, whatever its words.
    expect(blocked(ctxOf('Ivu manzilini bering', 'latin', chat, kg30, quote({ text: his, edited: false })))).toBe(true);
    // Rewritten into words that name no road: the stored road stands.
    const plain = 'Taxminan 640 $ bo‘ladi.';
    expect(blocked(ctxOf('Ivu manzilini bering', 'latin', [said('30 kg, qancha?', 1), said(plain, 2, 'out')], kg30, quote({ text: plain, edited: true })))).toBe(true);
  });

  it('the card\'s kilos are the shipment\'s: never one piece\'s, never a what-if asked after the quote', () => {
    for (const s of ['Har biri 2 kg', 'по 2 кг каждая коробка', 'Each box 5 kg']) expect(shipmentWeightIn(s, { whatIfCounts: true }), s).toBe(false);
    expect(shipmentWeightIn("50 kg bo'lsa qancha?", { whatIfCounts: false })).toBe(false);
    expect(shipmentWeightIn('Avia bilan 30 kg qancha?', { whatIfCounts: true })).toBe(true);
    const piece = ctxOf('Har biri 2 kg. Manzil qayerga?', 'latin', flight, [...kg30, { ref: 'w2', kind: 'weight', value: 2, messageRef: '#3' }], AIR_QUOTE);
    expect(card(piece)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
    const whatIf = ctxOf("50 kg bo'lsa qancha bo'ladi? Manzil qayerga?", 'latin', flight, [...kg30, { ref: 'w2', kind: 'weight', value: 50, messageRef: '#3' }], AIR_QUOTE);
    expect(card(whatIf)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
  });

  it('the card\'s origin: a place turned down is not it, a corrected weight keeps it, a load added does not', () => {
    const negated = ctxOf('Manzil qayerga?', 'latin', [said('Guanchjoudan avia bilan 30 kg, Shenzhendan emas.', 1)], kg30);
    expect(card(negated)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Guangzhou' }));
    // The chat as it happened: the question, our quote, and then the new line.
    const before = flight.map((m, i) => ({ ...m, sentAt: new Date(1_000 + i) }));
    const q = quote({ at: new Date(5_000) });
    const corrected = ctxOf('Kechirasiz, 35 kg ekan. Manzil qayerga?', 'latin', before, [...kg30, { ref: 'w2', kind: 'weight', value: 35, messageRef: '#3' }], q);
    expect(card(corrected)).toBe(aviaOwnerQuestion({ kg: 35, origin: 'Shenzhen' }));
    const added = ctxOf('Yana yuk bor: 80 kg avia bilan. Qayerga yuboray?', 'latin', before, [...kg30, { ref: 'w2', kind: 'weight', value: 80, messageRef: '#3' }], q);
    expect(card(added)).toBe(aviaOwnerQuestion({ kg: 80, origin: null }));
  });

  it('where the cargo is brought TO US in China is the China end; where it arrives is not', () => {
    for (const t of ['Куда доставить груз в Китае?', 'Zavod yukni qayerga yetkazsin?', 'Xitoyda qayerga olib boray?', 'Where should the factory deliver it?']) {
      expect(asksWhereToSend([{ body: t }]), t).toBe(true);
    }
    for (const t of ['Yuk qayerga keladi?', 'Куда доставите?', 'Qayerga yetkazasiz?', 'Xitoydan qayerga keladi?', 'Where will you deliver?']) {
      expect(asksWhereToSend([{ body: t }]), t).toBe(false);
    }
  });

  it('the road a customer asks the days of is the one he chose — «Avia qimmat ekan, kargo bilan necha kunda?»', () => {
    expect(askedModeOf(ctxOf('Avia qimmat ekan, kargo bilan necha kunda?', 'latin'))).toBe('road');
    expect(askedModeOf(ctxOf('Kargo bilan necha kunda?', 'latin', [said('Avia bilan 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')]))).toBe('road');
    expect(askedModeOf(ctxOf("Temir yo'l bilan qancha, avia qimmat", 'latin'))).toBe('rail');
    // One statement that turns the truck down and names rail is rail's — not the flight's by elimination.
    expect(askedModeOf(ctxOf("Fura emas temir yo'l kerak", 'latin'))).toBe('rail');
    expect(askedModeOf(ctxOf('Necha kunda keladi?', 'latin', [said('Avia bilan 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')]))).toBe('air');
    // Both asked in one breath, or turned down with nothing chosen: what each statement says.
    expect(askedModeOf(ctxOf('Avia va mashinada qancha, necha kunda?', 'latin'))).toBeNull();
    expect(askedModeOf(ctxOf('Avia juda qimmat ekan. Necha kunda keladi?', 'latin'))).toBe('road');
  });

  it('our warehouses by their streets: a Han run ends at a digit or a stop, an industrial zone is a street', () => {
    expect(statesChinaAddress('佛山南海胜利工业区29号3栋', ANCHORS)).toBe(true);
    expect(statesChinaAddress('地址：胜利工业区 29号', ANCHORS)).toBe(true);
    // The GS reminder after Horgos's «…168米左右.» glues no piece to the address.
    expect(ANCHORS.pieces.filter((p) => /发|货|请/u.test(p))).toEqual([]);
    // …and a piece never spans a digit: «工业区29号3栋» mints nothing of «区号栋».
    expect(ANCHORS.pieces.some((p) => p.includes('区号') || p.includes('号栋'))).toBe(false);
    // A space inside one street line does not cut it.
    expect(addressAnchorsOf(['Shenzhen qabul ombori: 广东省深圳市宝安区福永街道 塘尾路 18号']).pieces.length).toBeGreaterThan(0);
  });

  it('a truck warehouse that stands on Airport Road or turns the flight down stays ours — the flight\'s guard counts it', () => {
    const fact = 'Shenzhen qabul ombori: 广东省深圳市宝安区机场路 5号，13700002222.';
    expect(isReceivingAddressFact(fact)).toBe(true);
    expect(isReceivingAddressFact('Ivu ombori (avia yuk qabul qilinmaydi): 浙江省义乌市稠江街道荷花南街2255号')).toBe(true);
    expect(isReceivingAddressFact('Ombor aeroport yonida: 广东省深圳市宝安区福永街道 塘尾路 18号')).toBe(true);
    // It names the flight's own words — and turns them down.
    expect(isReceivingAddressFact('Avia yuklar uchun emas, faqat mashina: Ivu ombori 浙江省义乌市稠江街道荷花南街2255号')).toBe(true);
    // Counted, its phone is an anchor: an avia reply giving it is held.
    expect(statesChinaAddress('Manzil: 13700002222', addressAnchorsOf([fact]))).toBe(true);
    // A fact that says it is the flight's is his to have quoted.
    expect(isReceivingAddressFact('Avia ombori: 广东省深圳市宝安国际机场 货运站')).toBe(false);
    expect(isReceivingAddressFact('Склад для авиа: 广东省深圳市宝安区机场路 5号.')).toBe(false);
  });

  it('avia spoken of, the road not the flight\'s: a China address WARNS — the ✅ stays, he looks', () => {
    const both = 'Avto (mashina) narxi: 3 kub — taxminan 640 $, 15–25 kun. Avia: 300 kg — taxminan 5100 $, 2–5 kun.';
    const two = ctxOf('Yaxshi, manzilni yuboring', 'latin', [said('3 kub, 300 kg — avia va mashinada qancha?', 1), said(both, 2, 'out')], [], quote({ road: 'both', air: null, text: both }));
    expect(blocked(two)).toBe(false);
    expect(warned(two)).toBe(true);
    // The customer turned the flight down after our avia quote: the truck's, and still a look.
    const turned = ctxOf('Mashinada qancha? Avia juda qimmat ekan. Ivu manzilini tashlang', 'latin', flight, kg30, AIR_QUOTE);
    expect(warned(turned)).toBe(true);
    // The flight lives only in the quote he approved; our later line priced the truck.
    const quotedOnly = ctxOf('Ivu manzilini bering', 'latin', [said('30 kg yoki 1 kub, qancha?', 1), said('Mashina 1 kub 250$.', 2, 'out')], kg30, AIR_QUOTE);
    expect(blocked(quotedOnly)).toBe(false);
    expect(warned(quotedOnly)).toBe(true);
    // A truck the customer CHOSE after the quote settles the chat: nothing to look at (#1486).
    expect(warned(ctxOf('Mashinada yuboraman. Ivu manzilini bering', 'latin', [said('30 kg kiyim, qancha?', 1), said('Taxminan 510 $.', 2, 'out')], kg30, AIR_QUOTE))).toBe(false);
    // Avia asked about, alongside: «Avia bilan ham bormi?».
    expect(airMentionIn('Avia bilan ham bormi?')).toBe(true);
    // A truck chat that never spoke of the flight: no warning.
    expect(warned(ctxOf('Mashinada yuboraman. Ivu manzilini bering', 'latin'))).toBe(false);
    // The flight's own chat: the block, not the warning.
    const air = ctxOf('Manzil qayerga?', 'latin', flight, kg30, AIR_QUOTE);
    expect(blocked(air)).toBe(true);
    expect(warned(air)).toBe(false);
    // No address in the reply: nothing to look at.
    expect(verdict(two, 'latin', 'uz', 'Assalomu alaykum! Manzilni hozir yuboramiz.').warnings.some((w) => w.code === 'avia_maybe')).toBe(false);
  });
});

describe('the fifth review (#1486): a question asks for the road, a concession chooses it, rail turned down is the flight\'s', () => {
  const yiwu = () => `Assalomu alaykum! ${answer('china_address_yiwu@1')}`;
  const gz = () => `Assalomu alaykum! ${answer('china_address_guangzhou@1')}`;
  const ruYiwu = 'Здравствуйте! Адрес склада в Иу: 浙江省义乌市稠江街道荷花南街2255号，周先生，小周 13429089596.';
  const blocked = (ctx: AgentContext, reply = yiwu()) => judge(ctx, 'latin', 'uz', reply).includes('avia_address');
  const blockedRu = (ctx: AgentContext) => judge(ctx, 'cyrillic', 'ru', ruYiwu).includes('avia_address');
  const warned = (ctx: AgentContext, reply = yiwu()) => verdict(ctx, 'latin', 'uz', reply).warnings.some((w) => w.code === 'avia_maybe');
  const flight = [said('Shenzhendan avia 30 kg qancha?', 1), said('Avia 510 $.', 2, 'out')];
  const kg30 = [{ ref: 'w1', kind: 'weight' as const, value: 30, messageRef: '#1' }];
  /** The memory a run stores when the reply itself is `reply` — the rail check reads the reply. */
  const verdictOfReply = (ctx: AgentContext, reply: string) => {
    const mem = memoryFor(ctx, { compose: compose('uz', { replyText: reply }), tools: [], outcomes: [], usage }, FACTS, 'gsr-t');
    return checkAgentReply({
      body: reply, language: mem.language, customerScript: mem.customerScript, numberSources: mem.sources, removeWhole: [],
      ownCodes: [], bookCodes: new Set(), codePrefix: 'GS', allowedPhones: mem.allowedPhones, allowedUrls: mem.allowedUrls,
      mapUrls: mem.mapUrls, askedLocation: mem.askedLocation, staffNames: [], customerNames: [], canary: mem.canary,
      fingerprintPeers: 0, urlsToChat7d: 0, urlsToday: 0, hasEstimate: mem.hasEstimate, fromOurWarehouse: mem.fromOurWarehouse === true,
      factNameWords: mem.factNameWords ?? [], askedMode: mem.askedMode ?? null, hasGloss: mem.hasGloss === true,
      aviaOnly: mem.aviaOnly === true, aviaMentioned: mem.aviaMentioned === true, quotableHan: mem.quotableHan ?? '', warehouseAddress: ANCHORS,
    });
  };

  it('a question about a road asks for it — «-mi», «?» — it never turns it down', () => {
    for (const t of ["Aviada bo'lmaydimi?", 'Avia bilan qimmatmi?', 'Avia bilan ketmaydimi?', 'Avia narxi balandmi?', 'Avia qimmat ekanmi?', 'Авиа дорого выйдет?', 'Is air freight expensive for 20 kg?']) {
      expect(roadChoiceIn(t), t).toBe('air');
    }
    for (const t of ['Fura bilan ketmaydimi?', 'Mashinada ketmaydimi?']) expect(roadChoiceIn(t), t).toBe('road');
    // …with no question mark too, the way a phone sends it.
    for (const t of ["Aviada bo'lmaydimi", 'Avia bilan qimmatmi', 'Avia narxi balandmi']) expect(roadChoiceIn(t), t).toBe('air');
    // A refusal said as one still is.
    expect(roadChoiceIn('Avia qimmat ekan')).toBe('not_air');
    expect(blocked(ctxOf("Aviada bo'lmaydimi? Qaysi manzilga yuboray?", 'latin', [said('Salom, Guanchjouda 40 kg sumka bor', 1)]), gz())).toBe(true);
    expect(blocked(ctxOf("Shenzhenda 30 kg kosmetika bor. Avia bilan ketmaydimi? Manzilni bering", 'latin'))).toBe(true);
    expect(blocked(ctxOf('Ivuda 2 kub yuk bor, fura bilan ketmaydimi? Manzilni bering', 'latin'))).toBe(false);
    // The question mark is the statement's: a Russian question is read as one.
    expect(blockedRu(ctxOf('Авиа дорого выйдет? 20 кг. Адрес склада в Иу?', 'cyrillic'))).toBe(true);
  });

  it('a road chosen in spite of its price or by a double negation is chosen', () => {
    for (const t of ["Avia qimmat bo'lsa ham mayli, tez kerak", 'Пусть авиа дорого, нам срочно', 'Без авиа никак', "Aviasiz bo'lmaydi", "Avia qimmat bo'lsa ham avia"]) {
      expect(roadChoiceIn(t), t).toBe('air');
    }
    // A choice word outside the refusal's own words is chosen.
    expect(roadChoiceIn('Avia qimmat ekan lekin avia bilan yuboraman')).toBe('air');
    expect(blocked(ctxOf("Avia qimmat bo'lsa ham mayli, tez kerak. Guanchjou manzilini tashlang", 'latin', [said('Salom, 18 kg kosmetika bor, Guanchjoudan', 1)]), gz())).toBe(true);
    expect(blockedRu(ctxOf('Пусть авиа дорого, нам срочно. 18 кг. Адрес склада в Иу?', 'cyrillic'))).toBe(true);
  });

  it('rail turned down for the flight is the flight\'s: the guard holds and the card asks the AVIA question', () => {
    const c4 = ctxOf("Poyezd kerak emas, avia bilan. Manzil?", 'latin', [said('20 kg, Ivudan', 1)], [{ ref: 'w1', kind: 'weight', value: 20, messageRef: '#1' }]);
    expect(railChat(c4, compose('uz'))).toBe(false);
    expect(blocked(c4)).toBe(true);
    expect(rule(compose('uz'), [], c4).ownerQuestion).toBe(aviaOwnerQuestion({ kg: 20, origin: 'Yiwu' }));
    const c3 = ctxOf("Temir yo'l uzoq ekan, avia bilan yuboraman. Manzilni tashlang", 'latin', [said('Ivudan 30 kg kiyim, poyezdda qancha?', 1), said("Temir yo'l narxini aniqlab aytaman.", 2, 'out')], kg30);
    expect(blocked(c3)).toBe(true);
    expect(blockedRu(ctxOf('Не поездом, а самолётом. 25 кг. Адрес склада в Иу?', 'cyrillic'))).toBe(true);
    // Hardware is not the railway: «железки» alone is no rail word; «по железке» is.
    expect(blockedRu(ctxOf('У меня железки, 30 кг, самолётом можно? Адрес склада в Иу?', 'cyrillic'))).toBe(true);
    expect(railChat(ctxOf('Отправим по железке, сколько?', 'cyrillic'), compose('ru'))).toBe(true);
    expect(railChat(ctxOf('У меня железки, 30 кг', 'cyrillic'), compose('ru'))).toBe(false);
    // Rail turned down in the newest statement is no rail question.
    expect(railChat(ctxOf('Avia bilan yuboraman, poyezd kerak emas. Manzil?', 'latin'), compose('uz'))).toBe(false);
    // The flight chosen in a later line, no rail word in it: the rail question is behind him.
    const later = ctxOf('Mayli, avia bilan yuboraman. Manzil?', 'latin', [said('Ivudan 30 kg, poyezdda qancha?', 1), said('Aniqlab aytaman.', 2, 'out')], kg30);
    expect(railChat(later, compose('uz'))).toBe(false);
    expect(blocked(later)).toBe(true);
    // Rail AND the flight asked in one breath: rail is his question, and the flight's address his too.
    const both = ctxOf("Avia yoki poyezdda yuborsam bo'ladimi? Manzilni ayting", 'latin');
    expect(railChat(both, compose('uz'))).toBe(true);
    expect(blocked(both)).toBe(true);
    expect(rule(compose('uz'), [], both).ownerQuestion).toBe(aviaOwnerQuestion({ kg: null, origin: null }));
  });

  it('a reply that names rail beside our address keeps the flight\'s guard — a house number is no rail price', () => {
    const ctx = ctxOf('Kiyim ichida power bank ham bor. Manzil qayerga yuboraman?', 'latin', flight, kg30, AIR_QUOTE);
    const reply = `Assalomu alaykum! Power bank avia bilan ketmaydi — faqat avto yoki temir yoʻl bilan ketadi. ${answer('china_address_yiwu@1')}`;
    expect(railChat(ctx, compose('uz', { replyText: reply }))).toBe(false);
    expect(verdictOfReply(ctx, reply).blocks.map((b) => b.code)).toContain('avia_address');
  });

  it('the everyday ways to say «by air» are the flight\'s', () => {
    for (const t of ['По воздуху 20 кг можно?', 'Воздушным путём можно?', "Havo yo'li bilan qancha?", 'Havo orqali yuboraman', 'Samalyotda yuborsa bo\'ladimi?', 'Самалётда юборса бўладими?', 'By airplane please', 'Air transport for 20 kg', 'Air shipment from Yiwu', '空派20公斤多少钱']) {
      expect(airMentionIn(t), t).toBe(true);
      expect(roadChoiceIn(t), t).toBe('air');
    }
    expect(pricedRoadOf('По воздуху 20 кг — примерно 340 $, 3-5 дней.')).toBe('air');
    const b7 = ctxOf('Хорошо, отправляем. Куда отправить, адрес склада?', 'cyrillic', [said('Можно по воздуху 20 кг из Иу? Срочно', 1), said('По воздуху 20 кг — примерно 340 $, 3-5 дней.', 2, 'out')]);
    expect(blockedRu(b7)).toBe(true);
  });

  it('«kargo orqali / bilan» is the company the flight goes through — no road chosen', () => {
    expect(roadChoiceIn('Kargo orqali avia yubormoqchiman')).toBe('air');
    expect(roadChoiceIn('Kargo orqali yuboraman')).toBeNull();
    expect(roadChoiceIn('Kargoda manzil qayer')).toBeNull();
    expect(blocked(ctxOf('Kargo orqali yuboraman, manzil qayerga?', 'latin', [said('Shenzhendan avia bilan 20 kg kiyim, qancha?', 1)]))).toBe(true);
    expect(blocked(ctxOf("Avia bilan 30 kg yuborsam bo'ladimi, sizning kargo orqali? Manzil?", 'latin'), gz())).toBe(true);
    // …and still the truck's in a question of days, where it is all that names a road.
    expect(askedModeOf(ctxOf('Kargo bilan necha kunda keladi?', 'latin'))).toBe('road');
  });

  it('the truck chosen in the commonest words — «Avto», «Avto bo\'lsin», «Toshkentga mashinada» — is chosen', () => {
    for (const t of ['Avto', "Avto bo'lsin", 'Toshkentga mashinada yuboraman', 'Отправлю машиной до Ташкента', 'Toshkentgacha fura bilan necha kun?']) expect(roadChoiceIn(t), t).toBe('road');
    // The pickup in Tashkent is another leg.
    for (const t of ['Toshkentda mashinaga ortib berasizlarmi?', 'Toshkentdan mashinada olib ketaman', 'Avto chexol 2 kub']) expect(roadChoiceIn(t), t).toBeNull();
    const quoted = [said('Shenzhendan 30 kg kiyim, avia bilan qancha?', 1), said("Avia bilan 30 kg — taxminan 510 $, 2–5 kun. Boj va QQS alohida.", 2, 'out')];
    expect(blocked(ctxOf("Avto bo'lsin. Ivu manzilini bering", 'latin', quoted, kg30, AIR_QUOTE))).toBe(false);
    expect(blocked(ctxOf('Qimmat ekan. Toshkentga mashinada yuboraman, Ivu omboringiz manzilini bering', 'latin', quoted, kg30, AIR_QUOTE))).toBe(false);
  });

  it('our priced line is read by the road it chooses or opens with — never the goods\' name', () => {
    expect(pricedRoadOf("Mashinada: o'yinchoq samolyotlar 3 kub — taxminan 640 $.")).toBe('road');
    expect(pricedRoadOf('Машиной: игрушечные самолёты 3 куба — примерно 640 $.')).toBe('road');
    expect(pricedRoadOf('Avia: avtozapchast 30 kg — taxminan 510 $.')).toBe('air');
    expect(pricedRoadOf('Авиа: автозапчасти 30 кг — примерно 510 $.')).toBe('air');
    expect(pricedRoadOf('Avia: tikuv mashinasi 30 kg — taxminan 510 $.')).toBe('air');
    // A road turned down in our own line is the other road; two prices are two roads.
    expect(pricedRoadOf("Mashinada bo'lmaydi, 30 kg — taxminan 510 $.")).toBe('air');
    expect(pricedRoadOf('Avia 30 kg 510$, 3 kub 640$')).toBe('both');
    expect(pricedRoadOf('Mashina 1 kub 250$')).toBe('road');
    // A price with no road of its own looks to its neighbours, never past another price.
    expect(pricedRoadOf('Mashinada 2 kub — 430 $, 30 kg — 510 $, avia bilan 2–5 kun.')).toBe('both');
    expect(blocked(ctxOf('Yaxshi, Ivu manzilini yuboring', 'latin', [said("Ivuda 3 kub o'yinchoq bor, qancha?", 1), said("Mashinada: o'yinchoq samolyotlar 3 kub — taxminan 640 $.", 2, 'out')]))).toBe(false);
  });

  it('the days asked are the road chosen, not a goods word after it', () => {
    expect(askedModeOf(ctxOf('Avia bilan necha kunda keladi? Tovar: tikuv mashinalari, 25 kg', 'latin'))).toBe('air');
    expect(askedModeOf(ctxOf('Avia bilan qancha kunda yetib keladi? Avtozapchastlar 40 kg', 'latin'))).toBe('air');
    expect(askedModeOf(ctxOf('Сколько дней идёт авиа? Груз — автозапчасти, 40 кг', 'cyrillic'))).toBe('air');
    expect(askedModeOf(ctxOf("Mashinada necha kunda keladi? O'yinchoq samolyotlar, 3 kub", 'latin'))).toBe('road');
  });

  it('the card\'s kilos: a corrected weight in a question is the shipment\'s; one piece\'s never — decimals included', () => {
    const quoted = [said('Shenzhendan 30 kg kiyim, avia bilan qancha?', 1), said('Avia bilan 30 kg — taxminan 510 $, 2–5 kun.', 2, 'out')].map((m, i) => ({ ...m, sentAt: new Date(1_000 + i) }));
    const q = { ...AIR_QUOTE!, at: new Date(5_000) };
    const card = (body: string, kg: number) => rule(compose('uz'), [], ctxOf(body, 'latin', quoted, [...kg30, { ref: 'w2', kind: 'weight', value: kg, messageRef: '#3' }], q)).ownerQuestion;
    expect(card('Kechirasiz, 35 kg ekan, qayerga yuboray?', 35)).toBe(aviaOwnerQuestion({ kg: 35, origin: 'Shenzhen' }));
    expect(card("Yuk 50 kg bo'ldi, manzilni qayerga yuboray?", 50)).toBe(aviaOwnerQuestion({ kg: 50, origin: 'Shenzhen' }));
    expect(card("50 kg bo'lsa qancha bo'ladi? Manzil qayerga?", 50)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
    expect(card("Agar 50 kg bo'lsa, narxi o'zgaradimi? Manzil qayerga?", 50)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
    expect(card('Har biri 2.5 kg. Manzil qayerga?', 2.5)).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }));
    expect(shipmentWeightIn('Each box 2.5 kg', { whatIfCounts: true })).toBe(false);
    expect(shipmentWeightIn('Beach toys 30 kg', { whatIfCounts: true })).toBe(true);
  });

  it('the card\'s origin: only a place itself turned down is skipped', () => {
    const card = (body: string) => rule(compose('uz'), [], ctxOf(body, 'latin', [], kg30)).ownerQuestion;
    expect(card('Guanchjoudan yuk hali tayyor emas, avia bilan 30 kg. Manzil qayerga?')).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Guangzhou' }));
    expect(card('Shenzhendan emas Guanchjoudan avia bilan 30 kg. Manzil qayerga?')).toBe(aviaOwnerQuestion({ kg: 30, origin: 'Guangzhou' }));
  });

  it('a truck warehouse that only SPEAKS of the flight, stands near an airport or takes both stays ours', () => {
    for (const fact of [
      "Shenzhen qabul ombori: 广东省深圳市宝安区福永街道塘尾路88号，李先生 13800138000. Avia uchun manzilni men alohida beraman.",
      'Shenzhen qabul ombori: 广东省深圳市宝安区福永街道塘尾路88号，13800138000. Ombor aeroportga yaqin.',
      'Склад в Шэньчжэне, рядом с аэропортом: 广东省深圳市宝安区福永街道塘尾路88号, 13800138000',
      'Guanchjou 2-ombor: 广州市白云区人和镇机场北路 88号, 13700003333',
      'Guanchjou ombori avto va avia yuklar uchun: 广东省广州市白云区太和镇龙归路18号，李先生 13800001111.',
      'Avto va avia yuk qabul ombori: 广东省广州市白云区太和镇龙归路18号，李先生 13800001111.',
    ]) {
      expect(isReceivingAddressFact(fact), fact).toBe(true);
    }
    // A fact that says it IS the flight's point is his to have quoted.
    for (const fact of ['Avia ombori: 广东省深圳市宝安国际机场 货运站, 13700002222', 'Avia yuk qabul ombori: 广东省深圳市宝安区机场路 5号，13700002222.', 'Склад для авиа: 广东省深圳市宝安区机场路 5号.']) {
      expect(isReceivingAddressFact(fact), fact).toBe(false);
    }
  });

  it('the reply itself steering to the flight beside our address warns', () => {
    const ctx = ctxOf('Manzil qayerga yuboraman?', 'latin', [said('Guanchjoudan 30 kg kiyim bor', 1), said('Qanday yubormoqchisiz?', 2, 'out')], kg30);
    expect(warned(ctx, `Assalomu alaykum! 30 kg mashinaga kam, avia bilan yuborishingiz mumkin. ${answer('china_address_guangzhou@1')}`)).toBe(true);
    expect(warned(ctx, gz())).toBe(false);
  });

  it('the warning is not noise: toy planes and our own seeded batteries sentence put no flight on the table', () => {
    for (const t of ["Ivuda o'yinchoq samolyotlar va mashinalar, 2 kub. Manzil?", 'Ivu manzil kerak, 玩具飞机 2 kub', 'RC plane toys, 2 cbm. Yiwu address please', 'Aviamodellar 2 kub', 'Air fryer 300 dona']) {
      expect(airMentionIn(t), t).toBe(false);
    }
    const ours = ctxOf('Ivu manzilini bering', 'latin', [said('2 kub kiyim, ichida power bank bor', 1), said(answer('prohibited@1'), 2, 'out')]);
    expect(warned(ours)).toBe(false);
  });
});
