import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import type { KbHit } from '@/modules/wms/agent/kb';
import { customerSources, extractNumbers, factSources, type NumberSource } from '@/modules/wms/agent/numbers';
import { checkAgentReply, EXCLUSION_SENTENCE, nameWordsOf, promiseHits, type PolicyInput } from '@/modules/wms/agent/policy';
import { customerNumberSources } from '@/modules/wms/agent/policy-input';
import { memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * The policy review's four findings on the brain (wf2, B1-B4) and the web
 * package's one (B9), each against the exact text that was refused or let
 * through. Fixtures are literal; no figure here is computed by the code under
 * test.
 */

const base: PolicyInput = {
  body: 'Assalomu alaykum!',
  language: 'uz',
  customerScript: 'latin',
  numberSources: [],
  removeWhole: [],
  ownCodes: ['GS777'],
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
  { value: 2, kind: 'duration', label: 'avia muddati', origin: 'tool' },
  { value: 5, kind: 'duration', label: 'avia muddati', origin: 'tool' },
  { value: 40, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
];

function msg(over: Partial<ChatMessage> & { body: string }): ChatMessage {
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
    ...over,
  };
}

function ctxWith(body: string): AgentContext {
  const m = msg({ body });
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
const fact = (answer: string, id = '00000000-0000-4000-8000-0000000000f1'): KbHit => ({ id, ref: 'Ff1', answer, phones: [], urls: [] });

describe('B1: a hedge spoken earlier in the sentence covers its later clauses', () => {
  const B1 = 'Avia bilan taxminan 680 $ bo‘ladi, yetib borishi 2-5 kun. Boj va QQS alohida hisoblanadi.';

  it('the avia reply he allowed is no promise, and passes the whole policy on the tool’s sources', () => {
    expect(promiseHits(B1)).toEqual([]);
    expect(check({ body: B1, numberSources: avia40, hasEstimate: true }).ok).toBe(true);
  });

  it.each([
    ['2 kunda yetib keladi', 'no hedge at all'],
    ['Avia bilan 680 $ bo‘ladi, yetib borishi 2-5 kun.', 'the earlier clause states a price with no hedge'],
    ['Avia bilan taxminan 680 $ bo‘ladi, albatta 2-5 kunda yetib boradi.', 'a certainty word overrides the estimate'],
    ['Avia bilan taxminan 680 $ bo‘ladi, ertaga albatta yetib keladi.', 'the day rule, estimate or not'],
    ['Avia bilan taxminan 680 $ bo‘ladi. Yetib borishi 2-5 kun.', 'the hedge is in another sentence'],
    ['Xavotir olmang, odatda tez ishlaymiz, yukingiz 2 kunda yetib keladi', 'a hedge on no figure softens nothing'],
  ])('«%s» still promises (%s)', (body) => {
    expect(promiseHits(body)).toContain('dispatch_promise');
  });
});

describe('B2: each kb fact is read alone', () => {
  const payment = 'Toʻlov yuk Toshkentga yetib kelganda soʻmda qilinadi.';
  const address = 'Ombor manzili: Chilonzor 7, Toshkent.';

  it('a fact naming money leaves the other facts’ bare figures what they are', () => {
    const memory = memoryFor(ctxWith('Ombor qayerda?'), { compose, tools: [], outcomes: [], usage }, [fact(payment), fact(address)], 'gsr-t');
    expect(memory.sources).toContainEqual({ value: 7, kind: 'plain', label: 'kompaniya bilimi', origin: 'kb' });
    expect(codes({ body: 'Ombor manzili: Chilonzor 7.', numberSources: memory.sources })).not.toContain('number_unsourced');
  });

  it('…while a figure in the money fact itself is still nobody’s price', () => {
    expect(factSources('Toʻlov 480 dan', 'bilim').map((s) => s.kind)).toEqual(['customer_money']);
  });
});

describe('B3: a price, a day count or a day is the company’s word — never the customer’s', () => {
  it('«5 kunda kelsinmi?» backs no «Odatda 5 kunda yetib keladi»', () => {
    const sources = customerNumberSources([{ direction: 'in', body: '5 kunda kelsinmi?', ref: '#1' }]);
    expect(sources).toEqual([{ value: 5, kind: 'duration', label: 'mijoz #1', origin: 'customer' }]);
    expect(codes({ body: 'Odatda 5 kunda yetib keladi.', numberSources: sources })).toContain('number_unsourced');
  });

  it('a kb fact’s days back the same estimate', () => {
    const sources = factSources('Avto kargo odatda 15–25 kunda keladi — bu taxmin, vaʼda emas.', 'kompaniya bilimi');
    expect(sources.every((s) => s.origin === 'kb')).toBe(true);
    expect(check({ body: 'Odatda 15-25 kunda yetib keladi.', numberSources: sources }).ok).toBe(true);
  });

  it('the customer’s own date is no day we may name', () => {
    const sources = customerSources([{ text: '15.11 ga yetib keladimi?', label: 'mijoz' }]);
    expect(sources.map((s) => [s.kind, s.origin])).toEqual([['date', 'customer']]);
    expect(codes({ body: 'Ha, 15.11 da yetib keladi.', numberSources: sources })).toContain('number_unsourced');
  });

  it('his kilos, cubes and cartons are still his to have repeated back', () => {
    const sources = customerSources([{ text: '5 kub, 800 kg, 40 ta karobka', label: 'mijoz' }]);
    expect(check({ body: '5 kub, 800 kg va 40 ta karobka — to‘g‘rimi?', numberSources: sources }).ok).toBe(true);
  });

  it('a source with no origin reads as the customer’s (a memory stored before B3 fails closed)', () => {
    const old: NumberSource[] = [{ value: 680, kind: 'money', label: 'avia (tarif × kg)' }];
    expect(codes({ body: 'Taxminan 680 $. Boj va QQS alohida hisoblanadi.', numberSources: old })).toContain('number_unsourced');
  });

  it('every source the tools make says it is the tool’s, and a kb hit’s says it is the kb’s', async () => {
    const env: ToolEnv = {
      ctx: { ...ctxWith('4 quti 50×40×30 sm, avia 40 kg'), measures: [{ ref: 'w1', kind: 'weight', value: 40, messageRef: '#1' }] },
      day: '2026-10-24',
      aviaUsdPerKg: 17,
      kb: async () => [fact('Ombor manzili: Chilonzor 7, Toshkent.')],
      chinaPlaces: async () => new Set(['Yiwu']),
    };
    const outs: ToolOutcome[] = [
      await runTool('avia_estimate', { weight_ref: 'w1' }, env),
      await runTool('cargo_volume', { count: 4, length_cm: 50, width_cm: 40, height_cm: 30 }, env),
    ];
    for (const o of outs) expect(o.sources.length).toBeGreaterThan(0);
    expect(outs.flatMap((o) => o.sources).every((s) => s.origin === 'tool')).toBe(true);
    const kb = await runTool('kb_search', { query: 'ombor' }, env);
    expect(kb.sources.length).toBeGreaterThan(0);
    expect(kb.sources.every((s) => s.origin === 'kb')).toBe(true);
    // …and hands the memory the fact's words, so a colleague it names is the fact's (B9).
    expect(kb.factTexts).toEqual(['Ombor manzili: Chilonzor 7, Toshkent.']);
  });
});

describe('B4: «2 marta» is twice, not March — each month stem ends where its month does', () => {
  it.each([
    ['Mashina haftada 2 marta chiqadi', 'plain'],
    ['Haftada 3 martaba chiqadi', 'plain'],
    ['5 mayli', 'plain'],
    ['3 maydon', 'plain'],
    ['5 майка', 'plain'],
    ['2 separate boxes', 'plain'],
    ['3 market', 'plain'],
    ['5-martda', 'date'],
    ['5-mart', 'date'],
    ['5-mayda', 'date'],
    ['1 May', 'date'],
    ['2 марта', 'date'],
    ['5 мая', 'date'],
    ['12 dec', 'date'],
    ['3 June', 'date'],
  ])('«%s» → %s', (text, kind) => {
    expect(extractNumbers(text).map((f) => f.kind)).toEqual([kind]);
  });

  it('a timetable of «2 marta» passes on a count of two — it asks for no date source', () => {
    const count: NumberSource[] = [{ value: 2, kind: 'count', label: 'kompaniya bilimi', origin: 'kb' }];
    expect(codes({ body: 'Mashina haftada 2 marta chiqadi.', numberSources: count })).not.toContain('number_unsourced');
  });
});

describe('B9: a colleague an approved fact names is the fact’s', () => {
  const tashkent = 'Toshkentdagi sklad — Chuqursoy sklad. Yukni olish boʻyicha aloqa: Umriddin, +998 95 018 30 33.';
  const reply = 'Yukni olish bo‘yicha Umriddin bilan bog‘laning: +998 95 018 30 33.';
  const phones = ['+998 95 018 30 33'];

  it('the seeded contact passes when a staff user is called exactly that', () => {
    const r = check({ body: reply, allowedPhones: phones, staffNames: ['Umriddin'], factNameWords: nameWordsOf([tashkent]) });
    expect(r.blocks.map((b) => b.code)).not.toContain('staff_name');
    expect(r.warnings.map((b) => b.code)).not.toContain('staff_name');
  });

  it('…and blocks without the facts, as it did', () => {
    expect(codes({ body: reply, allowedPhones: phones, staffNames: ['Umriddin'] })).toContain('staff_name');
  });

  it('a colleague the facts do not name still blocks — and more of his name than the fact says does too', () => {
    const factNameWords = nameWordsOf([tashkent]);
    expect(codes({ body: 'Siroj Aliyev aytadi.', staffNames: ['Siroj Aliyev'], factNameWords })).toContain('staff_name');
    expect(codes({ body: 'Umriddin Karimov aytadi.', staffNames: ['Umriddin Karimov'], factNameWords })).toContain('staff_name');
  });

  it('the run carries the words of the facts it read — the prompt’s and what kb_search returned', () => {
    const kbHit: ToolOutcome = { ok: true, text: 'x', sources: [], factTexts: ['Guanchjou: aloqa Dilshod'] };
    const memory = memoryFor(ctxWith('Yuk qayerda?'), { compose, tools: [], outcomes: [kbHit], usage }, [fact(tashkent)], 'gsr-t');
    expect(memory.factNameWords).toEqual(expect.arrayContaining(['umriddin', 'dilshod']));
    // Only capitalised words — a name is written so — which keeps the stored memory short.
    expect(memory.factNameWords).not.toContain('aloqa');
  });
});

it('the exclusion sentence is untouched by the new readings (G11 still asks for it)', () => {
  expect(codes({ body: 'Taxminan 680 $.', numberSources: avia40, hasEstimate: true })).toContain('estimate_unhedged');
  expect(check({ body: `Taxminan 680 $. ${EXCLUSION_SENTENCE.uz}`, numberSources: avia40, hasEstimate: true }).ok).toBe(true);
});
