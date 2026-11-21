import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { autoVerdict, type AutoGateInput } from '@/modules/wms/agent/auto-gate';
import { ASSUMED_DESTINATION, ASSUMED_DESTINATION_NOTE, destinationNote, evidenceOf, saidDestinationNote, truckDestination } from '@/modules/wms/agent/calc-destination';
import { actionLines } from '@/modules/wms/agent/card-io';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { ASSUMED_DESTINATION_TOOL_WORDS, CALC_PRICE_TOOL, runTool, type ToolEnv } from '@/modules/wms/agent/tools';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';

/**
 * The truck job's destination beside the route reader the checklist always read (his «T a», 2026-11-21): the
 * destination reader first, the route reader's `toCity` for a line it reads nothing in, the newest line winning — and a
 * China place the route reader hands over is never where the cargo goes. The reader's own words are the corpus's
 * (`calc_destination`, `calc_destination_default` in tests/unit/fixtures/agent-reader-corpus.ts).
 */

const route = (line: string) => parseManualFacts(line).toCity ?? null;

describe('truckDestination beside the route reader', () => {
  it('the route reader still answers a Latin «Adan Bga» the destination reader also reads — one city', () => {
    expect(truckDestination(['Yiwudan Samarqandga 3 kub'], route)).toEqual({ toCity: 'Samarqand', assumed: false, evidence: 'Yiwudan Samarqandga 3 kub' });
  });

  it('a city only the route reader knows is still read, as it always was («Kitob» is a word too, so the place list leaves it out)', () => {
    expect(truckDestination(['Guanchjoudan Kitobga 3 kub'], route)).toEqual({ toCity: 'Kitob', assumed: false, evidence: 'Guanchjoudan Kitobga 3 kub' });
  });

  it('the newest line wins, whichever reader read it', () => {
    expect(truckDestination(['Andijonga', 'Yiwu → Toshkent'], route)).toMatchObject({ toCity: 'Toshkent', assumed: false, evidence: 'Yiwu → Toshkent' });
    expect(truckDestination(['Yiwu → Toshkent', 'Андижонга'], route)).toMatchObject({ toCity: 'Андижон', assumed: false, evidence: 'Андижонга' });
  });

  // DELIBERATE EDIT (the review of T, F3): this pinned «Toshkent → Toshkent» with «Manzil aytilmagan» — a destination
  // the customer SAID, written to the VED as not said. A road whose far end is China is not the table's: asked.
  it('a China place the route reader reads as the far end («Toshkentdan Xitoyga» → «Xitoy») is no destination — and no Tashkent is taken: the city is asked', () => {
    expect(route('Toshkentdan Xitoyga 3 kub')).toBe('Xitoy');
    expect(truckDestination(['Toshkentdan Xitoyga 3 kub'], route)).toEqual({ toCity: null, assumed: false, evidence: null });
  });

  it('the route reader’s far end that is no place («menga», «skladga») is no destination — Tashkent is taken (review R7)', () => {
    expect(route('Xitoydan menga 3 kub yuk kelyapti')).toBe('men');
    expect(truckDestination(['Xitoydan menga 3 kub yuk kelyapti'], route)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true, evidence: null });
    expect(route('Ivudan skladga 2 kub')).toBe('sklad');
    expect(truckDestination(['Ivudan skladga 2 kub'], route)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true, evidence: null });
  });

  it('lines before the last landed job are never this job’s destination, yet a place in them keeps the default off (review R2)', () => {
    expect(truckDestination(['Ivudan 2 kub kiyim'], route, ['Andijonga 3 kub'])).toMatchObject({ toCity: null, assumed: false });
    expect(truckDestination(['Ivudan 2 kub kiyim'], route, ['Toshkentga 3 kub'])).toMatchObject({ toCity: ASSUMED_DESTINATION, assumed: true });
    expect(truckDestination(['Ivudan 2 kub kiyim', 'Samarqandga'], route, ['Andijonga 3 kub'])).toMatchObject({ toCity: 'Samarqand', assumed: false });
  });

  it('nothing said and no other place named: Tashkent, taken', () => {
    expect(truckDestination(['Ivudan 3 kub 450 kg kiyim', 'ha', '200 dona'], route)).toEqual({ toCity: 'Toshkent', assumed: true, evidence: null });
  });
});

// The lead's ruling on the T check (2026-11-21): a job that never lands is the defect he reported, a wrong destination
// is a route line the VED reads beside the customer's own words — so a reading lands with its evidence.
describe('the T check: a reading lands, with the words it was read from', () => {
  it('regression 1 — a story in ANOTHER clause never drops the destination said beside it', () => {
    for (const [line, city] of [
      ['Ivudan Andijonga 3 kub kiyim, qachon keladi?', 'Andijon'],
      ['Yiwudan Samarqandga 5 kub, qancha turadi va qachon yetib keladi?', 'Samarqand'],
      ['Сколько стоит доставка в Самарканд и когда придёт?', 'Самарканд'],
      ['Yuk zavodga keldi, Andijonga kerak', 'Andijon'],
      ['Я отправил инвойс, доставка в Андижан', 'Андижан'],
      ['Нужно в Андижан, чем раньше тем лучше', 'Андижан'],
      ['Yiwu to Almaty 3 cbm, when will it arrive?', 'Almaty'],
    ] as const) {
      expect(truckDestination([line], route), line).toMatchObject({ toCity: city, assumed: false });
    }
    // …and in the story's own clause it is still no destination of THIS cargo (review R2).
    expect(truckDestination(['Andijonga qachon keladi?'], route).toCity).toBeNull();
  });

  it('regression 1 — a request or a promise is no story: «Пришлите», «пришлю» keep the place said', () => {
    expect(truckDestination(['Пришлите цену до Ташкента, из Иу 3 куба'], route)).toMatchObject({ toCity: 'Toshkent', assumed: false });
    expect(truckDestination(['Пришлите цену доставки в Самарканд'], route)).toMatchObject({ toCity: 'Самарканд', assumed: false });
    expect(truckDestination(['Я пришлю инвойс, из Иу 3 куба'], route)).toMatchObject({ toCity: 'Toshkent', assumed: true });
  });

  it('regression 1 — the route reader’s explicit «Adan Bga» is never skipped for a story beside it', () => {
    expect(truckDestination(["O'tgan safar ham Ivudan Samarqandga yuborganmiz"], route)).toMatchObject({ toCity: 'Samarqand', assumed: false });
  });

  it('regression 2 — no Uzbek dative switches the default off: «Qanchaga», «Kubiga», «Ertaga», «Nimaga?» land on Tashkent', () => {
    for (const second of ['Qanchaga?', 'qanchaga', 'Kubiga?', 'Ertaga', 'ertaga', 'Nimaga?', 'Kilosiga qancha?', 'Chilonzorga']) {
      expect(truckDestination(['Ivudan 3 kub kiyim', second], route), second).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true, evidence: null });
    }
    for (const line of ['Assalomu alaykum. Kompaniyamizga Ivudan 3 kub yuk kerak', 'Ivudan 3 kub, narxni Akmalga yuboring', 'Ivudan 3 kub kiyim, Kuniga nechta mashina?']) {
      expect(truckDestination([line], route), line).toMatchObject({ toCity: ASSUMED_DESTINATION, assumed: true });
    }
  });

  it('regression 2 — the Russian and English prepositions still hold an unlisted town, never a stoplisted word', () => {
    for (const line of ['Из Иу 3 куба, на Узум продаю', 'Из Иу 3 куба, отправьте на Почту', 'Из Иу 3 куба, в Мешках', 'Из Иу 3 куба. До Свидания', 'Из Иу 3 куба, в Чиланзар', '3 cbm from Yiwu. To Be honest']) {
      expect(truckDestination([line], route), line).toMatchObject({ toCity: ASSUMED_DESTINATION, assumed: true });
    }
    expect(truckDestination(['В Кызылорду, из Иу 3 куба'], route)).toEqual({ toCity: null, assumed: false, evidence: null });
  });

  it('regression 3 — the route reader’s far end lands unless it is plainly no place', () => {
    expect(truckDestination(['ivudan chinozga 3 kub'], route)).toMatchObject({ toCity: 'chinoz', assumed: false });
    expect(truckDestination(['yiwudan isfaraga'], route)).toMatchObject({ toCity: 'isfara', assumed: false });
    for (const line of ['Ivudan skladga', 'Xitoydan firmamizga', 'Ivudan bizga 5 kub', "Xitoydan O'zbekistonga 3 kub"]) {
      expect(truckDestination([line], route), line).toMatchObject({ toCity: ASSUMED_DESTINATION, assumed: true });
    }
  });

  it('a town by its own shape or by «X shahri» is read, never asked: «Novosibirskka», «В Новосибирск», «Kitob shahriga»', () => {
    expect(truckDestination(['Yuk Novosibirskka ketadi'], route)).toMatchObject({ toCity: 'Novosibirsk', assumed: false });
    expect(truckDestination(['В Новосибирск, из Иу 3 куба'], route)).toMatchObject({ toCity: 'Новосибирск', assumed: false });
    expect(truckDestination(['Ivudan 3 kub', 'Kitob shahriga'], route)).toMatchObject({ toCity: 'Kitob', assumed: false, evidence: 'Kitob shahriga' });
    // «boshqa shaharga» — «to another city» — names none.
    expect(truckDestination(['Toshkentga kerak emas, boshqa shaharga'], route).toCity).toBeNull();
  });

  it('rare 5-8, one narrow rule each: «не» refuses only «не в X» / «X не надо»; «в Косонсой» is a town; a locative is no refusal', () => {
    expect(truckDestination(['В Андижан не позже пятницы, из Иу 3 куба'], route)).toMatchObject({ toCity: 'Андижан' });
    expect(truckDestination(['Доставка в Ташкент не дорого? из Иу 3 куба'], route)).toMatchObject({ toCity: 'Toshkent', assumed: false });
    expect(truckDestination(['В Самарканд нужно, не в Ташкент'], route)).toMatchObject({ toCity: 'Самарканд' });
    expect(truckDestination(['в Косонсой, из Иу 3 куба'], route)).toMatchObject({ toCity: 'Косонсой' });
    expect(truckDestination(['В Ташкенте нет склада? Из Иу 3 куба'], route)).toMatchObject({ toCity: ASSUMED_DESTINATION, assumed: true });
    expect(truckDestination(['В Ташкент не надо'], route).toCity).toBeNull();
  });

  it('the evidence is the customer’s line, cut at words around the place — never a head of greetings alone', () => {
    const long =
      'Assalomu alaykum hurmatli kompaniya, bizda Ivudan 3 kub kiyim bor, 450 kg, iltimos narxini ayting, yuk Andijonga ketadi, rahmat oldindan';
    const ev = truckDestination([long], route).evidence!;
    expect(ev).toContain('Andijonga');
    expect(ev.length).toBeLessThanOrEqual(80);
    expect(ev.startsWith('…')).toBe(true);
    expect(evidenceOf('Ivudan 3 kub,\n  Toshkentga', 20)).toBe('Ivudan 3 kub, Toshkentga');
  });
});

describe('his card says what the VED will read', () => {
  const submit = (toCityAssumed?: boolean) => ({
    type: 'calc_submit' as const,
    section: 'podklyuch' as const,
    facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 450, volumeM3: 3, goods: [] },
    fromOurWarehouse: false,
    ...(toCityAssumed === undefined ? {} : { toCityAssumed }),
    citedMessageIds: [],
  });

  it('a destination taken, not read, is on the line ✅ also does — «taxmin», and the VED’s own words', () => {
    expect(actionLines([submit(true)])[0]).toContain(` · taxmin: ${ASSUMED_DESTINATION_NOTE}`);
  });

  it('a destination READ is on it with the customer’s words; an action stored before the evidence names neither', () => {
    const read = { ...submit(false), facts: { ...submit(false).facts, toCity: 'Andijon' }, toCitySaid: 'Ivudan Andijonga 3 kub' };
    expect(actionLines([read])[0]).toContain(' · Manzil mijoz xabaridan: «Ivudan Andijonga 3 kub»');
    expect(actionLines([read])[0]).not.toContain('taxmin');
    expect(actionLines([submit(false)])[0]).not.toMatch(/Manzil|taxmin/u);
    expect(actionLines([submit()])[0]).not.toMatch(/Manzil|taxmin/u);
  });

  it('his card and the VED’s screens say ONE sentence (uz): the bundle’s words are `destinationNote`’s', () => {
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { calc: { destinationTaken: string; destinationSaid: string } };
    expect(uz.calc.destinationTaken).toBe(destinationNote({ taken: true }));
    expect(uz.calc.destinationSaid.replace('{evidence}', 'X')).toBe(saidDestinationNote('X'));
    expect(destinationNote({ taken: false, evidence: 'X' })).toBe(saidDestinationNote('X'));
  });
});

/** The customer's lines, `minutesAgo` each, as a run's recent window holds them. */
function chat(lines: readonly [string, number][], openCalcs: AgentContext['openCalcs'] = []): AgentContext {
  const now = Date.now();
  const messages: ChatMessage[] = lines.map(([body, minutesAgo], i) => ({
    ref: `#${i + 1}`,
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tgMessageId: BigInt(i + 1),
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: new Date(now - minutesAgo * 60_000),
    autoSent: false,
    editedAt: null,
    body,
  }));
  const last = messages.at(-1)!;
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: last,
    burst: [last],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs,
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext): ToolEnv => ({
  ctx,
  day: '2026-11-21',
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou']),
  priceArmed: false,
  calcArmed: false,
  calcPricing: false,
  aviaDays: AVIA_DAYS_DEFAULT,
});

const goods = [{ name: 'kiyim', quantity: 200, unit: 'dona', weight_kg: null }];

describe('the checklist reads THIS job’s destination since the chat’s last landed job (review R2)', () => {
  const landed = (minutesAgo: number, status: string) => ({
    requestId: 'r',
    section: 'podklyuch',
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    status,
  });

  it('«Andijonga» for the job that landed an hour ago is no destination of today’s — and is not swapped for Tashkent either: asked', async () => {
    const lines: [string, number][] = [
      ['Andijonga 3 kub kiyim', 120],
      ['Ivudan 3 kub 450 kg kiyim, 200 dona', 5],
    ];
    const fresh = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(chat(lines)));
    // Control — no job landed: the line is this job's, as it always was.
    expect(fresh.checklist).toMatchObject({ toCityAssumed: false, facts: { toCity: 'Andijon' } });
    const after = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(chat(lines, [landed(60, 'answered')])));
    expect(after.checklist).toMatchObject({ complete: false, toCityAssumed: false, facts: { toCity: null } });
    expect(after.text).toContain('qaysi shaharga');
  });

  it('a chain the VED handed back is no cut: the hand-back loop’s resubmission is the same job, its destination said before it landed', async () => {
    const lines: [string, number][] = [
      ['Andijonga 3 kub kiyim', 120],
      ['Ivudan 3 kub 450 kg kiyim, 200 dona', 5],
    ];
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(chat(lines, [landed(60, 'returned')])));
    expect(out.checklist).toMatchObject({ toCityAssumed: false, facts: { toCity: 'Andijon' } });
  });
});

describe('the model is told one thing about a taken destination (review F5)', () => {
  it('«don’t ask, don’t say it as his» — and «Toshkentgacha» in a price, as the truck estimate demands', async () => {
    expect(ASSUMED_DESTINATION_TOOL_WORDS).toContain('«Toshkentgacha»');
    expect(ASSUMED_DESTINATION_TOOL_WORDS).not.toMatch(/shahar nomini o'zingdan aytma/u);
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(chat([['Ivudan 3 kub 450 kg kiyim, 200 dona', 5]])));
    expect(out.checklist).toMatchObject({ complete: true, toCityAssumed: true });
    expect(out.text).toContain(ASSUMED_DESTINATION_TOOL_WORDS);
  });
});

/** A VED price reply the machine may press — every fact clean, «VED narxi» ticked (agent-full-p2-price's own shape). */
function calcQuote(body: string, destinationTaken: boolean): AutoGateInput {
  return {
    config: { armed: true, categories: ['greeting', 'qualification', 'faq', 'status', 'calc_price'], maxChars: 400, perDay: null },
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
      body,
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
    calcPrice: { unconfirmed: false, moved: false, foreign: false, media: false, ownerPriced: false, personOffer: false, destinationTaken },
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

describe('a VED price on a job whose destination was TAKEN says «Toshkentgacha» or waits for him (review F2)', () => {
  it('no Tashkent word → `destination_unsaid`; «Toshkentgacha» → goes; a destination said → as before', () => {
    expect(autoVerdict(calcQuote('VED javobi keldi: podklyuch 1 000 $ bo‘ladi.', true)).reasons).toEqual(['destination_unsaid']);
    expect(autoVerdict(calcQuote('VED javobi keldi: Toshkentgacha podklyuch 1 000 $ bo‘ladi.', true))).toEqual({ eligible: true, reasons: [] });
    expect(autoVerdict(calcQuote('VED javobi keldi: podklyuch 1 000 $ bo‘ladi.', false))).toEqual({ eligible: true, reasons: [] });
  });
});

describe('the VED’s two screens mark the destination’s reading where they print the route (review F4, the T check)', () => {
  for (const page of ['src/app/(protected)/hisoblash/page.tsx', 'src/app/(protected)/hisoblash/[id]/page.tsx']) {
    it(page, () => {
      const src = readFileSync(page, 'utf8');
      // The one reader (calc-price `destinationReadings`, integration-tested) and the two marks beside the route.
      expect(src).toContain('destinationReadings(');
      const at = src.indexOf('data-testid="calc-destination-taken"');
      expect(at, 're-anchor: the taken mark').toBeGreaterThan(0);
      expect(src.slice(at, at + 200)).toContain("t('destinationTaken')");
      // …in the same block as the route's arrow — never a line somewhere else on the screen.
      expect(src.slice(Math.max(0, at - 400), at)).toMatch(/→ \$?\{row\.toCity \?\? '—'\}/u);
      const said = src.indexOf('data-testid="calc-destination-said"');
      expect(said, 're-anchor: the read mark').toBeGreaterThan(at);
      expect(src.slice(said, said + 200)).toContain("t('destinationSaid', { evidence:");
      expect(said - at, 'the read mark sits beside the taken one').toBeLessThan(600);
    });
  }
});
