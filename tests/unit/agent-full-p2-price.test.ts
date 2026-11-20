import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { autoVerdict, AUTO_REFUSALS, type AutoGateInput } from '@/modules/wms/agent/auto-gate';
import { cardLineOf, centsOf, markupPrice, ruleString, ruleWords, workedExample, type MarkupRule } from '@/modules/wms/agent/calc-markup';
import { CALC_PRICE_REFUSAL_WORDS, markupRuleOf, statedCalcMarks, storedMarksOf, type CalcPriceMark } from '@/modules/wms/agent/calc-price';
import { calcAnswerSourceKey, calcAnswerWhy } from '@/modules/wms/agent/calc-loop';
import { calcAnswerOverLive } from '@/modules/wms/agent/drafts';
import { checkAgentReply, WAREHOUSE_SENTENCES, type PolicyInput } from '@/modules/wms/agent/policy';
import { CALC_PRICE_RULE, chatBlock, CUSTOMS_YES_RULE, stableHead } from '@/modules/wms/agent/prompt';
import { OWNER_WORD } from '@/modules/wms/agent/persona';
import { calcCardLineOf, memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { CALC_PRICE_TOOL, TOOL_SPECS, toolSpecsFor, type ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * The full AI seller, part 2 — P3, the VED answer's price, where it is pure (SPEC-P2-v2 §2.1-§2.3, §2.5, §00): the
 * markup's integer arithmetic against an independent BigInt reference, the rule as stored and as said, the money
 * clause's second branch, the prompt's two lines off and on, and the words that carry no digit. Every expected figure
 * is computed here by hand or by the reference — never by the code under test.
 */

/** The judge's reference: ⌈base × (10 000 + h) ÷ 1 000 000⌉ in ONE exact division (the nested ceilings collapse). */
const reference = (baseCents: bigint, h: number) => (baseCents * BigInt(10_000 + h) + 999_999n) / 1_000_000n;
const pct = (h: number): MarkupRule => ({ kind: 'percent', hundredths: h });

describe('the client price is integer arithmetic, never a float (§2.2, judge money 7)', () => {
  it('his examples: 1300 @ 10 % → 1430 (a float says 1431); 1350.50 @ 10 % → 1486; 1234.56 → 1359 / +150 → 1385', () => {
    expect(markupPrice({ baseCents: 130_000n, rule: pct(1_000) }).clientDollars).toBe(1_430n);
    expect(Math.ceil(1300 * 1.1)).toBe(1431); // the defect the integer rule exists for
    expect(markupPrice({ baseCents: 135_050n, rule: pct(1_000) }).clientDollars).toBe(1_486n);
    expect(markupPrice({ baseCents: 123_456n, rule: pct(1_000) })).toEqual({ markedCents: 135_802n, clientDollars: 1_359n });
    expect(markupPrice({ baseCents: 123_456n, rule: { kind: 'fixed', dollars: 150 } })).toEqual({ markedCents: 138_456n, clientDollars: 1_385n });
  });

  it('§00 A1 — an empty markup is NO markup: the VED figure rounded UP to whole dollars (1350.50 → 1351, 1300 → 1300)', () => {
    expect(markupPrice({ baseCents: 135_050n, rule: { kind: 'none' } }).clientDollars).toBe(1_351n);
    expect(markupPrice({ baseCents: 130_000n, rule: { kind: 'none' } }).clientDollars).toBe(1_300n);
  });

  it('the judge’s grid: integer floors 100..20 000 and nine markups, every one equal to the reference', () => {
    const markups = [1, 50, 333, 500, 750, 1_000, 1_250, 2_000, 10_000];
    let floatOff = 0;
    for (let floor = 100; floor <= 20_000; floor++) {
      const base = BigInt(floor) * 100n;
      for (const h of markups) {
        const got = markupPrice({ baseCents: base, rule: pct(h) }).clientDollars;
        expect(got).toBe(reference(base, h));
        if (Math.ceil(floor * (1 + h / 10_000)) !== Number(got)) floatOff += 1;
      }
    }
    // The float formula is off by a dollar somewhere on this grid — the measurement the rule was written against.
    expect(floatOff).toBeGreaterThan(0);
  });

  it('cents in the floor: a sample of floors with cents agrees with the reference too', () => {
    for (let cents = 10_001n; cents < 2_000_000n; cents += 9_973n) {
      for (const h of [1, 1_000, 1_234]) expect(markupPrice({ baseCents: cents, rule: pct(h) }).clientDollars).toBe(reference(cents, h));
      expect(markupPrice({ baseCents: cents, rule: { kind: 'fixed', dollars: 37 } }).clientDollars).toBe((cents + 3_700n + 99n) / 100n);
      expect(markupPrice({ baseCents: cents, rule: { kind: 'none' } }).clientDollars).toBe((cents + 99n) / 100n);
    }
  });

  it('a money string is read as cents exactly, a third decimal or a sign refused', () => {
    expect(centsOf('1234.56')).toBe(123_456n);
    expect(centsOf('1300')).toBe(130_000n);
    expect(centsOf('0.5')).toBe(50n);
    expect(centsOf('1.234')).toBeNull();
    expect(centsOf('-5')).toBeNull();
    expect(centsOf('')).toBeNull();
  });
});

describe('the rule as stored, as vouched for and as said (§2.1, §00)', () => {
  it('empty is «none» in either kind; garbage is unreadable (fails closed); the bounds are his Q4 ⭐', () => {
    expect(markupRuleOf('percent', '')).toEqual({ kind: 'none' });
    expect(markupRuleOf('fixed', '')).toEqual({ kind: 'none' });
    expect(markupRuleOf('percent', '10')).toEqual(pct(1_000));
    expect(markupRuleOf('percent', '10.5')).toEqual(pct(1_050));
    expect(markupRuleOf('percent', '0.01')).toEqual(pct(1));
    expect(markupRuleOf('percent', '100')).toEqual(pct(10_000));
    expect(markupRuleOf('fixed', '150')).toEqual({ kind: 'fixed', dollars: 150 });
    // A jsonb number is the same figure (the settings writer stores a typed «10» as the number 10).
    expect(markupRuleOf('percent', 10)).toEqual(pct(1_000));
    expect(markupRuleOf('percent', 10.5)).toEqual(pct(1_050));
    expect(markupRuleOf('percent', 0)).toBeNull();
    expect(markupRuleOf('percent', Number.NaN)).toBeNull();
    for (const [k, v] of [
      ['percent', '0'],
      ['percent', '100.01'],
      ['percent', '10.555'],
      ['percent', 'abc'],
      ['fixed', '0'],
      ['fixed', '5001'],
      ['fixed', '1.5'],
      ['bogus', '10'],
      ['percent', null],
      [null, ''],
    ] as const) {
      expect(markupRuleOf(k, v), `${String(k)}:${String(v)}`).toBeNull();
    }
  });

  it('the canonical string (the stamp compares it) and the holder’s words', () => {
    expect(ruleString({ kind: 'none' })).toBe('none');
    expect(ruleString(pct(1_000))).toBe('percent:10');
    expect(ruleString(pct(1_050))).toBe('percent:10.5');
    expect(ruleString(pct(1_005))).toBe('percent:10.05');
    expect(ruleString(pct(1))).toBe('percent:0.01');
    expect(ruleString({ kind: 'fixed', dollars: 150 })).toBe('fixed:150');
    expect(ruleWords({ kind: 'none' })).toBe('ustamasiz');
    expect(ruleWords(pct(1_050))).toBe('ustama 10,5 %');
    expect(ruleWords({ kind: 'fixed', dollars: 1_500 })).toBe('ustama 1 500 $');
  });

  it('the card line and the page’s worked example say the floor, the rule and the client price — the empty case too', () => {
    expect(cardLineOf(123_456n, pct(1_000), 'rastamojka')).toBe('🧮 rastamojka: VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $');
    expect(cardLineOf(123_456n, { kind: 'none' }, null)).toBe('🧮 VED 1 234,56 $ · ustamasiz → mijozga 1 235 $');
    expect(workedExample(pct(1_000))).toBe('VED 1 234,56 $ → ustama 10 % → 1 358,02 $ → mijozga 1 359 $');
    expect(workedExample({ kind: 'fixed', dollars: 150 })).toBe('VED 1 234,56 $ → ustama 150 $ → 1 384,56 $ → mijozga 1 385 $');
    expect(workedExample({ kind: 'none' })).toBe('VED 1 234,56 $ → ustamasiz → mijozga 1 235 $');
  });
});

describe('law 4 — what leaves calc-price is the client price (§2.2, §2.6)', () => {
  const src = readFileSync('src/modules/wms/agent/calc-price.ts', 'utf8');
  const body = (name: string) => {
    const at = src.indexOf(`export interface ${name} {`);
    expect(at, `re-anchor: ${name}`).toBeGreaterThan(0);
    return src.slice(at, src.indexOf('\n}', at));
  };

  it('the mark’s keys are the six the spec names, and none is a floor', () => {
    const mark: Required<CalcPriceMark> = { requestId: 'r', section: 'rastamojka', anchor: 'answer', anchorId: 'r', rule: 'none', total: 1 };
    expect(Object.keys(mark).sort()).toEqual(['anchor', 'anchorId', 'requestId', 'rule', 'section', 'total']);
    for (const name of ['CalcPriceMark', 'CalcPriceGateFacts', 'CalcMarkupView']) {
      expect(body(name)).not.toMatch(/\b(?:floor|base|cents|amount|totalUsd|answerAmount)\w*\s*[?]?:/iu);
    }
  });

  it('a refusal carries no digit — in the service’s words and in the tool’s', () => {
    for (const words of Object.values(CALC_PRICE_REFUSAL_WORDS)) expect(words).not.toMatch(/\d/u);
    const tools = readFileSync('src/modules/wms/agent/tools.ts', 'utf8');
    const fn = tools.slice(tools.indexOf('async function calcPrice('), tools.indexOf('\n}\n', tools.indexOf('async function calcPrice(')));
    expect(fn.length, 're-anchor: calcPrice').toBeGreaterThan(200);
    const refusal = /if \(!r\.ok\) return \{ ok: false, text: `([^`]*)`/u.exec(fn)?.[1];
    expect(refusal, 're-anchor: the refusal').toBeDefined();
    expect(refusal!.replace(/\$\{[^}]*\}/gu, '')).not.toMatch(/\d/u);
  });

  it('a stored mark is read back only whole — anything else is no mark (the re-price fails closed)', () => {
    const ok = [{ requestId: 'a', section: 'rastamojka', anchor: 'seal', anchorId: 'v', rule: 'percent:10', total: 1430 }];
    expect(storedMarksOf(ok)).toEqual(ok);
    expect(storedMarksOf([])).toBeNull();
    expect(storedMarksOf([{ ...ok[0], total: '1430' }])).toBeNull();
    expect(storedMarksOf([{ ...ok[0], anchor: 'other' }])).toBeNull();
    expect(storedMarksOf('x')).toBeNull();
  });
});

/** The eligible greeting, as agent-auto-gate builds it — the money clause's second branch is turned on below. */
function eligible(): AutoGateInput {
  return {
    config: { armed: true, categories: ['greeting', 'qualification', 'faq', 'status'], maxChars: 400, perDay: null },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warningCodes: [],
      noteCodes: [],
      systemAck: false,
      honestLine: false,
      actionTypes: [],
      category: 'price',
      language: 'uz',
      body: 'VED javobi keldi: rastamojka 1 359 $ bo‘ladi.',
      confidence: 0.9,
      ledger: [{ kind: 'money', origin: 'tool', tool: CALC_PRICE_TOOL, role: 'total' }],
      hasEstimate: false,
      estimatesStored: false,
      rail: false,
      calcPricesStored: true,
      customerLocale: { locale: 'uz', confident: true },
      unreadNumeral: false,
    },
    tools: [{ name: CALC_PRICE_TOOL, ok: true, estimate: false }],
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false, ownerFigure: false },
    burstMedia: false,
    calc: null,
    calcPrice: { unconfirmed: false, moved: false, foreign: false, media: false, ownerPriced: false, personOffer: false },
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: new Date('2026-11-12T07:00:00Z'),
    now: new Date('2026-11-12T07:00:00Z'),
    loop: false,
    complaint: false,
    nightPrices: 'table',
    pressedToday: 0,
    budgetLeft: 10,
    sendingEnabled: true,
    listenerCurrent: true,
  };
}

describe('the money clause’s second branch — a VED answer’s price (§2.3)', () => {
  const ticked = (i: AutoGateInput, ...kinds: string[]) => {
    i.config.categories = [...i.config.categories, ...kinds];
    return i;
  };

  it('a calc line goes only with «VED narxi» ticked — never on «Narx» alone; both ticks pass', () => {
    // DELIBERATE EDIT (stage 1a §6.2): the ticked label is gone — the price box alone keeps an unticked VED price his.
    expect(autoVerdict(eligible()).reasons).toEqual(['money']);
    expect(autoVerdict(ticked(eligible(), 'price')).reasons).toEqual(['money']);
    expect(autoVerdict(ticked(eligible(), 'calc_price'))).toEqual({ eligible: true, reasons: [] });
    expect(autoVerdict(ticked(eligible(), 'calc_price', 'price'))).toEqual({ eligible: true, reasons: [] });
  });

  it('…and only with its prices stored; a tool that answered and a reply that quotes none is `money_unread`', () => {
    const unstored = ticked(eligible(), 'calc_price');
    unstored.draft.calcPricesStored = false;
    expect(autoVerdict(unstored).reasons).toContain('money');
    const unquoted = ticked(eligible(), 'calc_price');
    unquoted.draft.ledger = [];
    unquoted.draft.body = 'VED javobi keldi.';
    expect(autoVerdict(unquoted).reasons).toEqual(['money_unread']);
    // …as the run now stores it (fix pass 1): a price the words never said is kept by no draft — still `money_unread`
    // alone, never «pul bor» about a reply that states none.
    unquoted.draft.calcPricesStored = false;
    expect(autoVerdict(unquoted).reasons).toEqual(['money_unread']);
  });

  it('a calc_price REFUSAL is no money: a reply after it that states nothing is an ordinary reply', () => {
    const i = eligible();
    i.tools = [{ name: CALC_PRICE_TOOL, ok: false, estimate: false }];
    i.draft.ledger = [];
    i.draft.calcPricesStored = false;
    i.draft.category = 'faq';
    i.draft.body = 'VED javobi hali to‘liq emas, Bekzod aniqlab aytadi.';
    i.calcPrice = null;
    i.config.categories = [...i.config.categories, 'faq'];
    expect(autoVerdict(i)).toEqual({ eligible: true, reasons: [] });
  });

  it('a mixed reply (a VED price AND the truck table) needs both ticks', () => {
    const i = ticked(eligible(), 'calc_price');
    i.draft.ledger = [...i.draft.ledger, { kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
    i.draft.hasEstimate = true;
    i.draft.estimatesStored = true;
    i.tools = [...i.tools, { name: 'yolkira_estimate', ok: true, estimate: true }];
    i.draft.body = 'Rastamojka 1 359 $. 5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $. Boj va QQS alohida hisoblanadi.';
    // DELIBERATE EDIT (stage 1a §6.2): no label refusal beside it — the unticked «Narx» is the money clause's own.
    expect(autoVerdict(i).reasons).toEqual(['money']);
    i.config.categories = [...i.config.categories, 'price'];
    expect(autoVerdict(i)).toEqual({ eligible: true, reasons: [] });
  });

  it('the truck-only facts are never asked of a calc line — no «Toshkentgacha», no table, no destination', () => {
    const i = ticked(eligible(), 'calc_price');
    i.money = { unnamed: true, moved: true, tariffUnconfirmed: true, foreignDestination: true, ownerPersonal: false, answerStale: false, ownerFigure: false };
    expect(autoVerdict(i)).toEqual({ eligible: true, reasons: [] });
  });

  it('its own six facts — each refuses alone; facts not read refuse all (fails closed)', () => {
    const one = (patch: Partial<NonNullable<AutoGateInput['calcPrice']>>) => {
      const i = ticked(eligible(), 'calc_price');
      i.calcPrice = { ...i.calcPrice!, ...patch };
      return autoVerdict(i).reasons;
    };
    expect(one({ unconfirmed: true })).toEqual(['markup_unconfirmed']);
    expect(one({ moved: true })).toEqual(['calc_price_moved']);
    expect(one({ foreign: true })).toEqual(['calc_foreign']);
    expect(one({ media: true })).toEqual(['media']);
    // His 💵 for the job came while the machine's price counted down (finding 1) — its own words, never «moved».
    expect(one({ ownerPriced: true })).toEqual(['calc_owner_priced']);
    // A person's offer became the card's newest word (fix pass 3) — its own words, never «VED javobi yoki ustama o‘zgardi».
    expect(one({ personOffer: true })).toEqual(['calc_person_offer']);
    const unread = ticked(eligible(), 'calc_price');
    unread.calcPrice = null;
    expect(autoVerdict(unread).reasons).toEqual(
      AUTO_REFUSALS.filter((r) => ['calc_foreign', 'markup_unconfirmed', 'calc_price_moved', 'calc_owner_priced', 'calc_person_offer', 'media'].includes(r)),
    );
  });

  it('the request burst’s own files are no refusal for a VED price (they went to the VED) — a file after the landing is', () => {
    const i = ticked(eligible(), 'calc_price');
    i.burstMedia = true;
    expect(autoVerdict(i)).toEqual({ eligible: true, reasons: [] });
    i.calcPrice!.media = true;
    expect(autoVerdict(i).reasons).toEqual(['media']);
  });

  it('the model’s label rule stands: a «complaint» quoting the VED price stays his (stage 1a: as `complaint`)', () => {
    const i = ticked(eligible(), 'calc_price');
    i.draft.category = 'complaint';
    // DELIBERATE EDIT (stage 1a §6.2): the complaint is its own refusal now.
    expect(autoVerdict(i).reasons).toEqual(['complaint']);
  });
});

function msg(body: string, i: number, direction: 'in' | 'out' = 'in'): ChatMessage {
  return { ref: `#${i}`, id: `m${i}`, tgMessageId: BigInt(i), direction, body, media: null, fileName: null, sentAt: new Date(Date.UTC(2026, 10, 12, 7, i)), autoSent: false, editedAt: null };
}

function ctxWith(openCalcs: AgentContext['openCalcs']): AgentContext {
  const messages = [msg('Rastamojka qancha bo‘ladi?', 1)];
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: messages[0]!,
    burst: messages,
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs,
    ruleDecision: null,
  };
}

const compose = (replyText: string): ComposeReply => ({
  replyNeeded: true,
  replyText,
  language: 'uz',
  glossUz: '',
  category: 'price',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

const MARK: CalcPriceMark = { requestId: 'r1', section: 'rastamojka', anchor: 'answer', anchorId: 'r1', rule: 'percent:10', total: 1359 };
const calcOutcome = (ours: boolean): ToolOutcome => ({
  ok: true,
  text: 'VED javobi asosida, ustama bilan — rastamojka: 1359 $.',
  sources: [{ value: 1359, kind: 'money', label: 'VED narxi (ustama bilan)', origin: 'tool', currency: 'USD', role: 'total', tool: CALC_PRICE_TOOL }],
  calcPrices: [MARK],
  calcCardLine: '🧮 rastamojka: VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $',
  fromOurWarehouse: ours,
});

describe('the run’s memory of a VED price (§2.3) and G11 on it', () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const loop = (outcomes: ToolOutcome[], text = 'Rastamojka 1359 $ bo‘ladi.') => ({
    compose: compose(text),
    tools: outcomes.map(() => ({ name: CALC_PRICE_TOOL, ok: true, text: '', estimate: false })),
    outcomes,
    usage,
    aviaDays: AVIA_DAYS_DEFAULT,
  });

  it('the prices are kept, the client total is the only money source, and no estimate flag is set', () => {
    const mem = memoryFor(ctxWith([]), loop([calcOutcome(false)]), [], 'gsr-t');
    expect(mem.calcPrices).toEqual([MARK]);
    expect(mem.hasEstimate).toBe(false);
    expect(mem.estimates).toEqual([]);
    const money = mem.sources.filter((s) => s.kind === 'money');
    expect(money).toEqual([expect.objectContaining({ value: 1359, tool: CALC_PRICE_TOOL, role: 'total' })]);
    expect(JSON.stringify(mem)).not.toMatch(/1 ?234[.,]56/u);
    expect(calcCardLineOf(loop([calcOutcome(false)]).outcomes)).toMatch(/VED 1 234,56 \$/u);
  });

  it('a job priced from our warehouses holds the reply to both warehouse sentences (G11 `warehouse_condition`)', () => {
    const mem = memoryFor(ctxWith([]), loop([calcOutcome(true)]), [], 'gsr-t');
    expect(mem.fromOurWarehouse).toBe(true);
    const input: PolicyInput = {
      body: 'Rastamojka bilan narx 1359 $ bo‘ladi.',
      language: 'uz',
      customerScript: 'latin',
      numberSources: mem.sources,
      removeWhole: [],
      ownCodes: [],
      bookCodes: new Set(),
      codePrefix: 'GS',
      allowedPhones: [],
      allowedUrls: [],
      mapUrls: [],
      askedLocation: false,
      staffNames: [],
      canary: 'gsr-t',
      fingerprintPeers: 0,
      urlsToChat7d: 0,
      urlsToday: 0,
      hasEstimate: mem.hasEstimate,
      fromOurWarehouse: mem.fromOurWarehouse === true,
    };
    const codes = (body: string) => checkAgentReply({ ...input, body }).blocks.map((b) => b.code);
    expect(codes(input.body)).toContain('warehouse_condition');
    const w = WAREHOUSE_SENTENCES.uz;
    expect(codes(`${input.body} ${w.condition} ${w.factory}`)).toEqual([]);
    // Never «boj va QQS alohida» — a customs price includes them (§6 R1).
    expect(codes(`${input.body} ${w.condition} ${w.factory}`)).not.toContain('estimate_unhedged');
  });

  it('only the prices the reply STATES are kept (finding 3): a figure the words carry, never one the tool merely offered', () => {
    const other: CalcPriceMark = { ...MARK, requestId: 'r2', anchorId: 'r2', total: 1100 };
    expect(statedCalcMarks('Rastamojka narxi 1359 $ bo‘ladi.', [MARK, other])).toEqual([MARK]);
    expect(statedCalcMarks('Rastamojka narxi 1 359 dollar.', [MARK])).toEqual([MARK]);
    expect(statedCalcMarks('Narxi 1359 bo‘ladi.', [MARK])).toEqual([MARK]);
    expect(statedCalcMarks('VED javobi keldi, narxni tez orada aytamiz.', [MARK, other])).toEqual([]);
    // A figure in another currency, a measure or a count of the same digits is no statement of the price.
    expect(statedCalcMarks('1359 so‘m', [MARK])).toEqual([]);
    expect(statedCalcMarks('1359 kg yukingiz uchun narxni aytamiz', [MARK])).toEqual([]);
    expect(statedCalcMarks('Ikkala yuk: 1359 $ va 1100 $.', [MARK, other])).toEqual([MARK, other]);
  });

  it('a rail chat keeps no VED price either (his price, §18.5)', () => {
    const ctx = ctxWith([]);
    ctx.burst = [msg('Temir yo‘l bilan qancha?', 2)];
    ctx.messages = [...ctx.messages, ...ctx.burst];
    expect(memoryFor(ctx, loop([calcOutcome(false)]), [], 'gsr-t').calcPrices).toEqual([]);
  });
});

describe('the prompt and the tools with the VED price off — byte for byte (§2.3, §4.3)', () => {
  const head = (calcPricing: boolean) => stableHead({ styleGuide: null, facts: [], priceArmed: false, calcPricing, lessons: [], persona: '', aviaDays: AVIA_DAYS_DEFAULT });

  it('rule 11 gains ONE sentence when on; off, today’s rule 11 ends where it always did', () => {
    expect(head(false)).not.toContain(CALC_PRICE_RULE);
    // Stage 1a P3: rule 11 ends on its «ha → podklyuch» sentence (CUSTOMS_YES_RULE) now, and the VED one still follows it.
    expect(head(false)).toContain(`Kelib chiqish sertifikatini HECH QACHON so'rama — uni kompaniyaning o'zi oladi.${CUSTOMS_YES_RULE}\n12.`);
    expect(head(true)).toBe(
      head(false).replace(`uni kompaniyaning o'zi oladi.${CUSTOMS_YES_RULE}\n12.`, `uni kompaniyaning o'zi oladi.${CUSTOMS_YES_RULE}${CALC_PRICE_RULE}\n12.`),
    );
    expect(CALC_PRICE_RULE).not.toMatch(/\d/u);
  });

  it('the chat’s calc line says «calc_price beradi» only when on; off and absent are the same bytes', () => {
    const ctx = ctxWith([{ requestId: 'r1', section: 'rastamojka', createdAt: new Date(), status: 'answered' }]);
    expect(chatBlock(ctx)).toBe(chatBlock(ctx, { calcPricing: false }));
    expect(chatBlock(ctx)).toContain(`rastamojka: javob kelgan (narxni ${OWNER_WORD} aytadi)`);
    const on = chatBlock(ctx, { calcPricing: true });
    expect(on).toContain('rastamojka: javob kelgan — narxni calc_price beradi');
    expect(on.replace('javob kelgan — narxni calc_price beradi', `javob kelgan (narxni ${OWNER_WORD} aytadi)`)).toBe(chatBlock(ctx));
  });

  it('the tools: off is today’s list (the same objects, the same order), on adds calc_price alone', () => {
    // DELIBERATE EDIT (stage 1a P7): the avia tool now tells the run's OWN days (`agent_avia_days`), so `toolSpecsFor`
    // builds that one entry per run — equal to the list's own at the shipped days; every other entry is still the
    // list's own object, in its order.
    const off = toolSpecsFor({ calcPricing: false, aviaDays: AVIA_DAYS_DEFAULT });
    expect(off.map((t) => t.name)).not.toContain(CALC_PRICE_TOOL);
    expect(off).toEqual(TOOL_SPECS.filter((t) => t.name !== CALC_PRICE_TOOL));
    expect(off.every((t, i) => t.name === 'avia_estimate' || t === TOOL_SPECS.filter((x) => x.name !== CALC_PRICE_TOOL)[i])).toBe(true);
    const on = toolSpecsFor({ calcPricing: true, aviaDays: AVIA_DAYS_DEFAULT });
    expect(on).toEqual(TOOL_SPECS);
    expect(on.every((t, i) => t.name === 'avia_estimate' || t === TOOL_SPECS[i])).toBe(true);
    const spec = TOOL_SPECS.find((t) => t.name === CALC_PRICE_TOOL)!;
    expect(Object.keys((spec.input_schema as { properties: object }).properties)).toEqual([]);
  });
});

describe('the VED answer’s run (§2.3)', () => {
  it('one key per standing anchor: a seal by its version, an answer by «answer»', () => {
    expect(calcAnswerSourceKey({ requestId: 'r', anchor: 'seal', anchorId: 'v9' })).toBe('calc:r:v9');
    expect(calcAnswerSourceKey({ requestId: 'r', anchor: 'answer', anchorId: 'r' })).toBe('calc:r:answer');
  });

  it('every outcome that leaves no draft is said — the «too old» in the week the run kept (K2); a draft or a duplicate says nothing', () => {
    expect(calcAnswerWhy({ outcome: 'refused', reason: 'human_active' })).toMatch(/o'zingiz yozayapsiz/u);
    expect(calcAnswerWhy({ outcome: 'skipped', reason: 'no_fresh_inbound' })).toMatch(/7 kun/u);
    expect(calcAnswerWhy({ outcome: 'refused', reason: 'too_old' })).toMatch(/7 kun/u);
    expect(calcAnswerWhy({ outcome: 'capped', reason: 'daily_token_cap' })).toMatch(/byudjet/u);
    expect(calcAnswerWhy({ outcome: 'error', reason: 'x' })).toMatch(/xato/u);
    expect(calcAnswerWhy({ outcome: 'no_reply' })).toMatch(/javob kerak emas/u);
    expect(calcAnswerWhy({ outcome: 'stood_down', reason: 'editing' })).toMatch(/✏️/u);
    expect(calcAnswerWhy({ outcome: 'stood_down', reason: 'duplicate' })).toBeNull();
    expect(calcAnswerWhy({ outcome: 'draft', draftId: 'd', blocked: false })).toBeNull();
  });
});

describe('fix pass 5 — what the VED answer’s run does beside a reply the chat already holds (check send-0)', () => {
  const answeredAt = new Date('2026-11-10T10:00:00Z');
  const before = new Date('2026-11-10T09:50:00Z');
  const after = new Date('2026-11-10T10:00:05Z');
  const over = { members: ['r1', 'r0'], anchorKey: 'calc:r1:answer', answeredAt };
  const machine = (p: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    kind: 'reply',
    policy: { memory: { calcPrices: [], estimates: [] }, ...p },
    finalBody: null,
    actions: [],
    needsOwner: false,
    offerId: null,
    createdAt: before,
    ...extra,
  });
  const mark = (requestId: string, anchor: 'answer' | 'seal', anchorId: string) => ({ requestId, section: 'rastamojka', anchor, anchorId, rule: 'percent:10', total: 1359 });

  it('a reply that already states THIS anchor’s price is «already priced» — whatever else it is', () => {
    expect(calcAnswerOverLive(machine({ memory: { calcPrices: [mark('r1', 'answer', 'r1')] } }, { createdAt: after }), over)).toBe('already_priced');
    expect(calcAnswerOverLive(machine({ memory: { calcPrices: [mark('r1', 'answer', 'r1')] } }, { finalBody: 'o‘zim' }), over)).toBe('already_priced');
    // The same chain at another anchor (an older seal) is not this price.
    expect(calcAnswerOverLive(machine({ memory: { calcPrices: [mark('r0', 'seal', 'v1')] } }), over)).toBe('takes_over');
  });

  it('the chain’s own earlier price card is replaced; another job’s price card never', () => {
    expect(calcAnswerOverLive(machine({ calcAnswer: { requestId: 'r0' } }, { createdAt: after }), over)).toBe('own_card');
    expect(calcAnswerOverLive(machine({ calcAnswer: { requestId: 'rX' } }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({ memory: { calcPrices: [mark('rX', 'answer', 'rX')] } }), over)).toBe('held');
  });

  it('an ordinary machine reply drafted BEFORE the VED answered is taken over; after it, or with the moment unknown, it is held', () => {
    expect(calcAnswerOverLive(machine(), over)).toBe('takes_over');
    expect(calcAnswerOverLive(machine({}, { createdAt: after }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { createdAt: answeredAt }), over)).toBe('held');
    expect(calcAnswerOverLive(machine(), { ...over, answeredAt: null })).toBe('held');
  });

  it('never his words, his 💵, a hand-back, an act, a question to him, an offer, a truck figure or a rewrite of his', () => {
    expect(calcAnswerOverLive(machine({}, { finalBody: 'o‘zim yozdim' }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { kind: 'price' }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { kind: 'hand_back' }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { actions: [{ type: 'calc_submit' }] }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { needsOwner: true }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({}, { offerId: '00000000-0000-0000-0000-000000000001' }), over)).toBe('held');
    expect(calcAnswerOverLive(machine({ memory: { calcPrices: [], estimates: [{ total: 900 }] } }), over)).toBe('held');
    for (const key of ['answering', 'ownerAnswer', 'fromAnswer', 'lessonRedraft', 'fromLesson', 'forcedQuestion']) {
      expect(calcAnswerOverLive(machine({ [key]: { x: 1 } }), over), key).toBe('held');
    }
  });

  it('«already priced» is said to nobody — the waiting card already carries the price, never «💵 bering»', () => {
    expect(calcAnswerWhy({ outcome: 'stood_down', reason: 'already_priced' })).toBeNull();
  });
});
