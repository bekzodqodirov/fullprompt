import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { AGENT_LOCALES, type AgentLocale } from '@/modules/wms/agent/locale';
import type { NumberSource } from '@/modules/wms/agent/numbers';
import { placesOf, quoteOrigin, zoneForOrigin } from '@/modules/wms/agent/origin';
import { checkAgentReply, EXCLUSION_SENTENCE, WAREHOUSE_SENTENCES, type PolicyInput } from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, validateActions, type ComposeReply } from '@/modules/wms/agent/run';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import { runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * His third set of answers (2026-10-24, docs/AI-SOTUVCHI.md §17.14), item
 * «3»: «agar skladimizga jo'natib bersangiz skladlarimizdan narxi shuncha deb
 * aytsin. Va zavotidan olib skladga olib kelish alohida hisoblanadi». A
 * customer who names only China, or a Chinese place we have no warehouse in,
 * is quoted from OUR China warehouses, and the reply says both halves of it.
 * The places our warehouses stand in are read from the warehouses table in a
 * run; here they are the demo seed's (YW, GZ, KA), written out.
 */

const OURS: ReadonlySet<string> = new Set(['Yiwu', 'Guangzhou', 'Qashqar']);

describe('where a truck price starts', () => {
  it.each([
    ['Xitoydan Toshkentga 5 kub yuk bor', 'our_warehouse'],
    ['Хитойдан юк бор', 'our_warehouse'],
    ['Груз из Китая, 5 кубов', 'our_warehouse'],
    ['Cargo from China, 5 cbm', 'our_warehouse'],
    ['بار از چین دارم', 'our_warehouse'],
    ['我在中国有货', 'our_warehouse'],
    ['Shenzhendan 5 kub', 'our_warehouse'],
    ['Pekindan yuk bor', 'our_warehouse'],
    ['Yiwudan 5 kub', 'warehouse'],
    ['Guangzhou va Yiwudan', 'warehouse'],
    ['Yiwu va Shenzhendan', 'our_warehouse'],
    ['Qashqardan', 'western'],
    ['Xitoydan, Xorgos orqali', 'western'],
    ['Toshkentga 5 kub', 'unknown'],
    ['Mashinada 5 kub bor', 'unknown'],
  ] as const)('«%s» → %s', (text, origin) => {
    expect(quoteOrigin(text, OURS)).toBe(origin);
  });

  it('a city is ours only when a warehouse row stands in it — the table decides, not a list here', () => {
    expect(quoteOrigin('Yiwudan 5 kub', new Set())).toBe('our_warehouse');
    expect(placesOf([{ name: 'Yiwu', code: 'YW' }, { name: 'Guangzhou' }, { name: 'Tashkent 1', code: 'TAS1' }])).toEqual(
      new Set(['Yiwu', 'Guangzhou']),
    );
    // A warehouse card written in Cyrillic, or whose city is only in its address, is still that city.
    expect(placesOf([{ name: 'Иу склад' }, { name: 'Ombor 2', address: 'Foshan, Nanhai district' }])).toEqual(new Set(['Yiwu', 'Foshan']));
  });

  it('Beijing is a Chinese place now, on the China column', () => {
    expect(zoneForOrigin('Pekin')).toBe('cn');
  });
});

describe('the reply carries both sentences in the customer’s language (G11)', () => {
  const base: PolicyInput = {
    body: '',
    language: 'uz',
    customerScript: null,
    numberSources: [{ value: 480, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool' } satisfies NumberSource],
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
    hasEstimate: true,
    fromOurWarehouse: true,
  };
  const codes = (body: string, patch: Partial<PolicyInput> = {}) => checkAgentReply({ ...base, body, ...patch }).blocks.map((b) => b.code);
  const APPROX: Record<AgentLocale, string> = {
    uz: 'Taxminan',
    uz_cyrl: 'Тахминан',
    ru: 'Примерно',
    en: 'Approximately',
    fa: 'تقریباً',
    zh: '大约',
  };
  const full = (l: AgentLocale) =>
    `${APPROX[l]} 480 $. ${EXCLUSION_SENTENCE[l]} ${WAREHOUSE_SENTENCES[l].condition} ${WAREHOUSE_SENTENCES[l].factory}`;

  it.each(AGENT_LOCALES.map((l) => [l]))('%s: the sentences the model is given pass the whole policy', (l) => {
    expect(checkAgentReply({ ...base, body: full(l), language: l }).blocks).toEqual([]);
  });

  it('a hedged, excluded price without them is blocked — and so is either one alone', () => {
    const w = WAREHOUSE_SENTENCES.uz;
    expect(codes(`Taxminan 480 $. ${EXCLUSION_SENTENCE.uz}`)).toContain('warehouse_condition');
    expect(codes(`Taxminan 480 $. ${EXCLUSION_SENTENCE.uz} ${w.condition}`)).toContain('warehouse_condition');
    expect(codes(`Taxminan 480 $. ${EXCLUSION_SENTENCE.uz} ${w.factory}`)).toContain('warehouse_condition');
  });

  it('«alohida» of the duty sentence does not stand in for the factory leg, and a denied one says the opposite', () => {
    const w = WAREHOUSE_SENTENCES.uz;
    expect(codes(`Taxminan 480 $. Zavoddan olib kelish ham kiradi. ${EXCLUSION_SENTENCE.uz} ${w.condition}`)).toContain(
      'warehouse_condition',
    );
    expect(
      codes(`Taxminan 480 $. ${EXCLUSION_SENTENCE.uz} ${w.condition} Zavoddan omborimizgacha olib kelish alohida hisoblanmaydi.`),
    ).toContain('warehouse_condition');
  });

  it('a reply with no quoted price, or a price from a named warehouse city, needs neither', () => {
    expect(codes('Qancha kub yukingiz bor?')).not.toContain('warehouse_condition');
    expect(codes(`Taxminan 480 $. ${EXCLUSION_SENTENCE.uz}`, { fromOurWarehouse: false })).toEqual([]);
  });
});

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
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext): ToolEnv => ({
  ctx,
  day: '2026-10-24',
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => OURS,
});

const compose = (over: Partial<ComposeReply> = {}): ComposeReply => ({
  replyNeeded: true,
  replyText: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.',
  language: 'uz',
  glossUz: '',
  category: 'qualification',
  confidence: 0.8,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'calc',
  actions: [{ type: 'calc_submit', section: 'podklyuch', citedMessageRefs: ['#1'], date: '', note: '' }],
  usedFactIds: [],
  citedMessageRefs: [],
  ...over,
});
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('the run carries it from the tool to the reply’s check and to the landing', () => {
  const goods = [{ name: 'kurtka', quantity: 100, weight_kg: null }];

  it('a podklyuch job from China is priced from our warehouses; one from Yiwu, or customs alone, is not', async () => {
    const china = ctxWith('Xitoydan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona');
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(china));
    expect(out.checklist).toMatchObject({ complete: true, fromOurWarehouse: true, facts: { fromCity: 'Xitoy' } });
    const { actions } = validateActions(compose(), china, [out], new Date());
    expect(actions).toEqual([expect.objectContaining({ type: 'calc_submit', fromOurWarehouse: true })]);

    const yiwu = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(ctxWith('Yiwudan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona')));
    expect(yiwu.checklist).toMatchObject({ complete: true, fromOurWarehouse: false });
    const customs = await runTool('calc_checklist', { section: 'rastamojka', goods }, env(ctxWith('Xitoydan rastamojka kerak: 3 kub 500 kg, kurtka 100 dona')));
    expect(customs.checklist).toMatchObject({ fromOurWarehouse: false });
  });

  it('the memory takes the flag from a truck estimate priced from our warehouses — and drops it in a rail burst', () => {
    const tool: ToolOutcome = { ok: true, text: 'x', estimate: true, fromOurWarehouse: true, sources: [] };
    const loop = { compose: compose(), tools: [], outcomes: [tool], usage };
    expect(memoryFor(ctxWith('Xitoydan 5 kub 1000 kg'), loop, [], 'gsr-t').fromOurWarehouse).toBe(true);
    expect(memoryFor(ctxWith("Xitoydan temir yo'l bilan 5 kub"), loop, [], 'gsr-t').fromOurWarehouse).toBe(false);
    const named: ToolOutcome = { ok: true, text: 'x', estimate: true, sources: [] };
    expect(memoryFor(ctxWith('Yiwudan 5 kub'), { ...loop, outcomes: [named] }, [], 'gsr-t').fromOurWarehouse).toBe(false);
  });
});

describe('written down for the model and in the knowledge', () => {
  it('the prompt says it, with the sentences the policy checks', () => {
    const head = stableHead({ styleGuide: null, facts: [] });
    expect(head).toContain(WAREHOUSE_SENTENCES.uz.condition);
    expect(head).toContain(WAREHOUSE_SENTENCES.uz.factory);
  });

  it('a seed fact carries his rule, with no money in it — the truck\'s, which is what he answered (review D6)', () => {
    const f = SEED_FACTS.find((x) => x.key === 'china_warehouse_price@1');
    expect(f?.answer).toBe('Avto (mashina) narxi Xitoydagi omborlarimizdan hisoblanadi; zavoddan omborgacha olib kelish alohida hisoblanadi.');
  });
});
