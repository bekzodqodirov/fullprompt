import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { normalizeDigits } from '@/modules/wms/agent/digits';
import type { KbHit } from '@/modules/wms/agent/kb';
import { PHONE_RE } from '@/modules/wms/agent/numbers';
import { checkAgentReply, statesChinaAddress, withoutQuotedHan, type PolicyInput } from '@/modules/wms/agent/policy';
import { aviaOwnerQuestion, memoryFor, withAviaRule, type ComposeReply } from '@/modules/wms/agent/run';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';
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

function ctxOf(body: string, customerScript: 'latin' | 'cyrillic' | 'han'): AgentContext {
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
    customerScript,
    measures: [],
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

/** The policy over a reply, on the memory a real run stores — as `policyFor` maps it. */
function judge(customer: string, script: 'latin' | 'cyrillic' | 'han', language: 'uz' | 'ru' | 'zh', reply: string, outcomes: ToolOutcome[] = []) {
  const mem = memoryFor(ctxOf(customer, script), { compose: compose(language), tools: [], outcomes, usage }, FACTS, 'gsr-t');
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

  it('what reads as a China address, and what does not', () => {
    expect(statesChinaAddress('Telefon: 13429089596')).toBe(true);
    expect(statesChinaAddress('Telefon: +86 134 2908 9596')).toBe(true);
    expect(statesChinaAddress('浙江省 义乌市 稠江街道')).toBe(true);
    expect(statesChinaAddress('Umriddin, +998 95 018 30 33')).toBe(false);
    expect(statesChinaAddress('Ivu (义乌) va Guanchjou (广州)')).toBe(false);
    expect(statesChinaAddress("Avia bilan taxminan 510 $ bo'ladi.")).toBe(false);
  });

  it('the draft asks HIM with the cargo, whatever the model composed', () => {
    const silent = withAviaRule(compose('uz'), [air], aviaChat);
    expect(silent).toMatchObject({ needsOwner: true, ownerQuestion: aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' }) });
    expect(silent.ownerQuestion).toContain('30 kg');
    expect(silent.ownerQuestion).toContain('Shenzhen');
    // The model's own avia question — with the goods it read — stands.
    const own = 'Avia: kurtka, 30 kg, Shenzhen — manzilni bering';
    expect(withAviaRule(compose('uz', { ownerQuestion: own }), [air], aviaChat).ownerQuestion).toBe(own);
    // A question about something else keeps its place; the avia line follows it.
    expect(withAviaRule(compose('uz', { ownerQuestion: 'kod ochib bering' }), [air], aviaChat).ownerQuestion).toBe(
      `kod ochib bering · ${aviaOwnerQuestion({ kg: 30, origin: 'Shenzhen' })}`,
    );
    // No flight quoted: nothing is asked.
    expect(withAviaRule(compose('uz'), [truck], aviaChat)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
    expect(aviaOwnerQuestion({ kg: 12, origin: null })).toContain('aytilmagan');
  });

  it('…but never in a rail chat: no machine figure goes out there, so no flight was quoted — the question is the rail one', () => {
    const rail = ctxOf("Temir yo'l bilan 40 kg qancha?", 'latin');
    expect(withAviaRule(compose('uz'), [air], rail)).toMatchObject({ needsOwner: false, ownerQuestion: '' });
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

  it('the stored memory reaches the policy at the write AND at ✅ — policyFor passes both new fields', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/modules/wms/agent/policy-input.ts', 'utf8');
    expect(src).toMatch(/aviaOnly: input\.memory\.aviaOnly === true,/u);
    expect(src).toMatch(/quotableHan: input\.memory\.quotableHan \?\? '',/u);
  });
});
