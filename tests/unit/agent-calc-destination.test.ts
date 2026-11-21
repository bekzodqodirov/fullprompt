import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { autoVerdict, type AutoGateInput } from '@/modules/wms/agent/auto-gate';
import { ASSUMED_DESTINATION, truckDestination } from '@/modules/wms/agent/calc-destination';
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
    expect(truckDestination(['Yiwudan Samarqandga 3 kub'], route)).toEqual({ toCity: 'Samarqand', assumed: false });
  });

  it('a city only the route reader knows is still read, as it always was («Kitob» is a word too, so the place list leaves it out)', () => {
    expect(truckDestination(['Guanchjoudan Kitobga 3 kub'], route)).toEqual({ toCity: 'Kitob', assumed: false });
  });

  it('the newest line wins, whichever reader read it', () => {
    expect(truckDestination(['Andijonga', 'Yiwu → Toshkent'], route)).toEqual({ toCity: 'Toshkent', assumed: false });
    expect(truckDestination(['Yiwu → Toshkent', 'Андижонга'], route)).toEqual({ toCity: 'Андижон', assumed: false });
  });

  // DELIBERATE EDIT (the review of T, F3): this pinned «Toshkent → Toshkent» with «Manzil aytilmagan» — a destination
  // the customer SAID, written to the VED as not said. A road whose far end is China is not the table's: asked.
  it('a China place the route reader reads as the far end («Toshkentdan Xitoyga» → «Xitoy») is no destination — and no Tashkent is taken: the city is asked', () => {
    expect(route('Toshkentdan Xitoyga 3 kub')).toBe('Xitoy');
    expect(truckDestination(['Toshkentdan Xitoyga 3 kub'], route)).toEqual({ toCity: null, assumed: false });
  });

  it('the route reader’s far end that is no place («menga», «skladga») is no destination — Tashkent is taken (review R7)', () => {
    expect(route('Xitoydan menga 3 kub yuk kelyapti')).toBe('men');
    expect(truckDestination(['Xitoydan menga 3 kub yuk kelyapti'], route)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true });
    expect(route('Ivudan skladga 2 kub')).toBe('sklad');
    expect(truckDestination(['Ivudan skladga 2 kub'], route)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true });
  });

  it('lines before the last landed job are never this job’s destination, yet a place in them keeps the default off (review R2)', () => {
    expect(truckDestination(['Ivudan 2 kub kiyim'], route, ['Andijonga 3 kub'])).toEqual({ toCity: null, assumed: false });
    expect(truckDestination(['Ivudan 2 kub kiyim'], route, ['Toshkentga 3 kub'])).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true });
    expect(truckDestination(['Ivudan 2 kub kiyim', 'Samarqandga'], route, ['Andijonga 3 kub'])).toEqual({ toCity: 'Samarqand', assumed: false });
  });

  it('nothing said and no other place named: Tashkent, taken', () => {
    expect(truckDestination(['Ivudan 3 kub 450 kg kiyim', 'ha', '200 dona'], route)).toEqual({ toCity: 'Toshkent', assumed: true });
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

  it('a destination taken, not said, is on the line ✅ also does', () => {
    expect(actionLines([submit(true)])[0]).toContain('manzil aytilmagan — Toshkent deb olindi');
  });

  it('a destination said — or an action stored before the flag — reads as said', () => {
    expect(actionLines([submit(false)])[0]).not.toContain('manzil aytilmagan');
    expect(actionLines([submit()])[0]).not.toContain('manzil aytilmagan');
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

describe('the VED’s two screens mark a taken destination where they print the route (review F4)', () => {
  for (const page of ['src/app/(protected)/hisoblash/page.tsx', 'src/app/(protected)/hisoblash/[id]/page.tsx']) {
    it(page, () => {
      const src = readFileSync(page, 'utf8');
      // The one reader (calc-price `takenDestinationRequests`, integration-tested) and the mark beside the route.
      expect(src).toContain('takenDestinationRequests(');
      const at = src.indexOf('data-testid="calc-destination-taken"');
      expect(at, 're-anchor: the mark').toBeGreaterThan(0);
      expect(src.slice(at, at + 200)).toContain("t('destinationTaken')");
      // …in the same block as the route's arrow — never a line somewhere else on the screen.
      expect(src.slice(Math.max(0, at - 400), at)).toMatch(/→ \$?\{row\.toCity \?\? '—'\}/u);
    });
  }
});
