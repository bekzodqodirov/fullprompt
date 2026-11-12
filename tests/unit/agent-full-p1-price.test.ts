import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FreightBand } from '@/modules/wms/calc/pricing';
import { OWNER_TARIFF_BANDS } from '@/modules/wms/calc/tariff-seed';
import { parseCallback, buttonsFor } from '@/modules/platform/telegram/staff-bot';
import type { StoredEstimate } from '@/modules/wms/agent/auto-money';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { namesForeignPlace } from '@/modules/wms/agent/destination';
import { aviaEstimate, reprice, repriceAll, siteStillValid, storedEstimatesOf, truckEstimate, YOLKIRA_GUARDS } from '@/modules/wms/agent/estimate';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { checkAgentReply, textFingerprint, type PolicyInput } from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { SITE_TARIFF } from '@/modules/wms/agent/site-estimate';
import { tariffFingerprint, tariffNoticeFrom, tariffNoticeText } from '@/modules/wms/agent/tariff-watch';
import { runTool, type ToolEnv } from '@/modules/wms/agent/tools';

/**
 * The full AI seller, part 1 — the price that goes by itself (spec SPEC-P1-v2 §1.2, §1.3, §1.6, §1.7, §1.8), where
 * it is pure: the one arithmetic the tools quote with and the send re-prices with, the table's expiry, the avia
 * narrowing in the tool's and the head's words, the destination list, and G10 measured over estimate replies.
 * Every figure below is read off his own tariff (`OWNER_TARIFF_BANDS`) or the website's snapshot, never computed by
 * the code under test.
 */

/** His China column as `tariffFor` hands it back. */
const CN: FreightBand[] = OWNER_TARIFF_BANDS.map(([min, max, cn]) => ({ zone: 'cn', minDensity: min, maxDensity: max, priceUsd: cn, perKg: max === null }));
const BEFORE = '2026-11-12';
const AFTER = '2027-01-05';

describe('one arithmetic for the quote and the re-price — the truck (spec §1.3, §1.6)', () => {
  it('while the website’s table is valid the figure is the website’s, cross-checked against his column', () => {
    // 5 kub, 1000 kg: 200 kg/kub — his «151–200» band, 160 $/kub, the website’s too.
    const r = truckEstimate({ kg: 1000, m3: 5, day: BEFORE, bands: CN });
    expect(r).toEqual({ ok: true, figure: { total: 800, rate: 160, unit: 'm3', days: [15, 25], densityKgM3: 200, source: 'site' } });
    // Denser than water: per kg on both sheets.
    const heavy = truckEstimate({ kg: 3000, m3: 2, day: BEFORE, bands: CN });
    expect(heavy).toMatchObject({ ok: true, figure: { total: 1650, rate: 0.55, unit: 'kg', source: 'site' } });
  });

  it('…and a column that stopped agreeing with the website refuses (money-3), never quotes either figure', () => {
    const edited = CN.map((b) => (b.minDensity === 151 ? { ...b, priceUsd: 170 } : b));
    expect(truckEstimate({ kg: 1000, m3: 5, day: BEFORE, bands: edited })).toEqual({ ok: false, reason: 'tariff_mismatch' });
    // A hole cut in the column.
    expect(truckEstimate({ kg: 1000, m3: 5, day: BEFORE, bands: CN.filter((b) => b.minDensity !== 151) })).toEqual({ ok: false, reason: 'tariff_mismatch' });
  });

  it('after `validThrough` the website is SKIPPED — the price is his column’s list price, the days the company’s rule', () => {
    expect(siteStillValid(SITE_TARIFF.validThrough)).toBe(true);
    expect(siteStillValid('2027-01-01')).toBe(false);
    const r = truckEstimate({ kg: 1000, m3: 5, day: AFTER, bands: CN });
    expect(r).toEqual({ ok: true, figure: { total: 800, rate: 160, unit: 'm3', days: [15, 25], densityKgM3: 200, source: 'tariff' } });
    // His column moved after the expiry: its figure is the price (nothing independent checks it — §1.6's ✅ does).
    const edited = CN.map((b) => (b.minDensity === 151 ? { ...b, priceUsd: 170 } : b));
    expect(truckEstimate({ kg: 1000, m3: 5, day: AFTER, bands: edited })).toMatchObject({ ok: true, figure: { total: 850, rate: 170 } });
    // A hole in it is refused in its own words.
    expect(truckEstimate({ kg: 1000, m3: 5, day: AFTER, bands: CN.filter((b) => b.minDensity !== 151) })).toEqual({
      ok: false,
      reason: 'tariff_refused',
      detail: 'band_missing',
    });
  });

  it('the $50 floor is on the list price after the expiry, as it was on the website’s figure before', () => {
    // 1 kub, 90 kg: band «1–100», 110 $ — above the floor on both sides.
    expect(truckEstimate({ kg: 90, m3: 1, day: AFTER, bands: CN })).toMatchObject({ ok: true, figure: { total: 110 } });
    // A column whose band reads 40 $/kub puts a 1-kub load under the floor: refused after the expiry…
    const cheap = CN.map((b) => (b.minDensity === 1 ? { ...b, priceUsd: 40 } : b));
    expect(truckEstimate({ kg: 90, m3: 1, day: AFTER, bands: cheap })).toEqual({ ok: false, reason: 'min_total' });
  });

  it('the size guards hold on both sides of the expiry', () => {
    for (const day of [BEFORE, AFTER]) {
      expect(truckEstimate({ kg: 1000, m3: YOLKIRA_GUARDS.maxM3 + 1, day, bands: CN })).toEqual({ ok: false, reason: 'size' });
      expect(truckEstimate({ kg: YOLKIRA_GUARDS.maxKg + 1, m3: 50, day, bands: CN })).toEqual({ ok: false, reason: 'size' });
      expect(truckEstimate({ kg: Number.NaN, m3: 5, day, bands: CN })).toEqual({ ok: false, reason: 'size' });
    }
  });

  it('the truck’s days after the expiry are the website snapshot’s own 15–25 (⭐ Q5 a)', () => {
    expect(AGENT_LIMITS.truckDays).toEqual(SITE_TARIFF.truck.days);
  });
});

describe('the flight (spec §1.2, §1.3)', () => {
  it('his rate × the actual kilos, to the cent; no rate is no quote; under a kilo is the minimum', () => {
    expect(aviaEstimate({ kg: 37.5, rate: 17 })).toEqual({ ok: true, total: 637.5, rate: 17 });
    expect(aviaEstimate({ kg: 37.5, rate: null })).toEqual({ ok: false, reason: 'rate_unset' });
    expect(aviaEstimate({ kg: 0.4, rate: 17 })).toEqual({ ok: false, reason: 'below_minimum' });
  });
});

describe('the figure still stands — the re-price (spec §1.3)', () => {
  const truck: StoredEstimate = { tool: 'yolkira_estimate', kg: 1000, m3: 5, zone: 'cn', day: BEFORE, total: 800, rate: 160, unit: 'm3' };
  const avia: StoredEstimate = { tool: 'avia_estimate', kg: 37.5, m3: null, zone: null, day: BEFORE, total: 637.5, rate: 17, unit: 'kg' };
  const now = (patch: Partial<{ day: string; bands: FreightBand[]; aviaRate: number | null }> = {}) => ({
    day: BEFORE,
    bands: CN,
    aviaRate: 17,
    ...patch,
  });

  it('the same table, the same rate: it stands', () => {
    expect(reprice(truck, now())).toBe('stands');
    expect(reprice(avia, now())).toBe('stands');
    expect(repriceAll([truck, avia], now())).toBe('stands');
  });

  it('an /admin/tarif edit between the quote and the send: moved (before the expiry by the cross-check, after it by the figure)', () => {
    const edited = CN.map((b) => (b.minDensity === 151 ? { ...b, priceUsd: 170 } : b));
    expect(reprice(truck, now({ bands: edited }))).toBe('estimate_moved');
    expect(reprice({ ...truck, day: AFTER }, now({ day: AFTER, bands: edited }))).toBe('estimate_moved');
    // An edit to a band this load is not in moves nothing.
    expect(reprice(truck, now({ bands: CN.map((b) => (b.minDensity === 1 ? { ...b, priceUsd: 111 } : b)) }))).toBe('stands');
  });

  it('a re-price that REFUSES is a figure that moved — a hole, his avia rate taken away or changed', () => {
    expect(reprice(truck, now({ bands: CN.filter((b) => b.minDensity !== 151) }))).toBe('estimate_moved');
    expect(reprice(avia, now({ aviaRate: null }))).toBe('estimate_moved');
    expect(reprice(avia, now({ aviaRate: 18 }))).toBe('estimate_moved');
    // One figure of two moved: the draft's answer is «moved».
    expect(repriceAll([truck, avia], now({ aviaRate: 18 }))).toBe('estimate_moved');
  });

  it('crossing the website’s expiry with his column equal to it: the same figure, it stands', () => {
    expect(reprice(truck, now({ day: '2027-01-01' }))).toBe('stands');
  });

  it('the send step’s question over a stored memory: nothing kept is null (today’s answer); a row nobody can read is moved', async () => {
    const { estimatesStand } = await import('@/modules/wms/agent/estimate-check');
    expect(await estimatesStand(undefined, new Date())).toBeNull();
    expect(await estimatesStand([], new Date())).toBeNull();
    expect(await estimatesStand([{ tool: 'yolkira_estimate', kg: 'x' }], new Date())).toBe('estimate_moved');
  });

  it('a stored row nobody can read is no figure that stands (the caller holds it as moved)', () => {
    expect(storedEstimatesOf([truck, avia])).toEqual([truck, avia]);
    expect(storedEstimatesOf(null)).toBeNull();
    expect(storedEstimatesOf([{ ...truck, total: '800' }])).toBeNull();
    expect(storedEstimatesOf([{ ...truck, tool: 'own_balance' }])).toBeNull();
    expect(storedEstimatesOf([{ ...truck, m3: null }])).toBeNull();
  });
});

function msg(body: string, n = 1): ChatMessage {
  return {
    ref: `#${n}`,
    id: `00000000-0000-4000-8000-00000000000${n}`,
    tgMessageId: BigInt(n),
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: new Date(),
    autoSent: false,
    editedAt: null,
    body,
  };
}

function ctxWith(body: string, measures: AgentContext['measures']): AgentContext {
  const m = msg(body);
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages: [m],
    history: [m],
    anchor: m,
    burst: [m],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures,
    openCalcs: [],
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext, priceArmed: boolean): ToolEnv => ({
  ctx,
  day: BEFORE,
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou']),
  priceArmed,
});

describe('the avia tool’s words, his price act off and on (spec §1.2)', () => {
  const aviaCtx = ctxWith('Avia bilan 37.5 kg', [{ ref: 'w1', kind: 'weight', value: 37.5, messageRef: '#1' }]);

  it('off: every quoted flight asks him with its cargo, as it always did', async () => {
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, false));
    expect(out.text).toContain('needs_owner=true, owner_question="Avia: <tovar>, 37.5 kg, <qayerdan> — manzilni bering"');
    expect(out.text).toMatch(/^Taxminiy avia yo'lkira: 637\.5 \$/u);
    expect(out.text).not.toMatch(/Faqat narxni ayt/u);
  });

  it('on: the price alone — no address, no sending to a warehouse — and HIM only when the address is asked', async () => {
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, true));
    expect(out.text).toMatch(/Faqat narxni ayt: avia manzilini AYTMA, bilimdagi ombor manzilini ham, omborga yuborishni ham aytma/u);
    expect(out.text).toMatch(/Mijoz manzilni yoki qayerga yuborishni so'rasa — needs_owner=true/u);
    // The figure, its sources and the figure the memory keeps are the same either way.
    const off = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, false));
    expect(out.sources).toEqual(off.sources);
    expect(out.priced).toEqual({ tool: 'avia_estimate', kg: 37.5, m3: null, zone: null, day: BEFORE, total: 637.5, rate: 17, unit: 'kg' });
  });

  it('below the minimum keeps no figure for the memory (no price was said)', async () => {
    const tiny = ctxWith('Avia 0.4 kg', [{ ref: 'w1', kind: 'weight', value: 0.4, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(tiny, true));
    expect(out.text.startsWith('below_minimum')).toBe(true);
    expect(out.priced).toBeUndefined();
  });
});

describe('the head (spec §1.2, §1.8): rule 9 changes only with his price act; rule 8 asks the load and «Toshkentgacha»', () => {
  const off = stableHead({ styleGuide: null, facts: [], priceArmed: false });
  const on = stableHead({ styleGuide: null, facts: [], priceArmed: true });
  const rule = (head: string, n: number) => head.split('\n').find((l) => l.startsWith(`${n}. `))!;

  it('off, rule 9’s address sentence is today’s, word for word', () => {
    expect(rule(off, 9)).toContain(
      "Avia narxini aytsang yoki mijoz avia bilan jo'natmoqchi bo'lsa: tovar nomi, og'irligi (kg) va qayerdan jo'natilishini bil va needs_owner=true, owner_question=\"Avia: <tovar>, <kg> kg, <qayerdan> — manzilni bering\". Avia narxi belgilanmagan bo'lsa — narx aytma, needs_owner.",
    );
  });

  it('on, the price alone; «avia manzilini HECH QACHON aytma» stays; nothing else in the head moves', () => {
    expect(rule(on, 9)).toMatch(/Avia narxini aytsang — faqat narxni ayt: omborga yuborishni ham, manzilni ham aytma\./u);
    expect(rule(on, 9)).toMatch(/avia manzilini HECH QACHON aytma/u);
    expect(rule(on, 9)).toContain('owner_question="Avia: <tovar>, <kg> kg, <qayerdan> — manzilni bering"');
    const others = (head: string) => head.split('\n').filter((l) => !l.startsWith('9. '));
    expect(others(on)).toEqual(others(off));
  });

  it('rule 8: the load the tool priced and «Toshkentgacha» in the price’s own sentence, in the six languages the gate reads', () => {
    for (const words of ['«Toshkentgacha»', '«Тошкентгача»', '«до Ташкента»', '«to Tashkent»', '«到塔什干»', '«تا تاشکند»']) {
      expect(rule(off, 8)).toContain(words);
    }
    expect(rule(off, 8)).toMatch(/vosita narxlagan kubi va kg ini/u);
    // §1.7's remedy: wording that differs per customer, never a policy hole.
    expect(rule(off, 8)).toMatch(/bir xil qolip matnni ko'p mijozga yuborma/u);
  });
});

describe('the destination (spec §1.8): any city or region other than Tashkent, a new list', () => {
  it.each([
    'Andijonga yetkazib berasizlarmi?',
    'Yuk Samarqandga kerak, 3 kub',
    'Нужно в Андижан',
    'Доставка до Ферганы',
    'Ташкентдан Наманганга ҳам борасизми?',
    'Almatyga ham olib borasizmi?',
    'Груз в Бишкек',
    'Душанбега етказасизми',
    'Can you deliver to Kabul?',
    'به کابل می‌فرستید؟',
    '能运到阿拉木图吗？',
    'Qarshiga kerak',
    'Oshga yuk bor',
    'Navoiyga yuboring',
    'Afg‘onistonga ketadi',
  ])('«%s» names one', (line) => {
    expect(namesForeignPlace([line])).toBe(true);
  });

  it.each([
    'Toshkentgacha qancha?',
    'Ташкентга керак, 5 куб',
    'Yiwudan 5 kub 800 kg',
    'Guanchjoudan Toshkentga',
    'Qarshi emasman, yuboravering',
    'Osh pishiryapman, keyin yozaman',
    "Manzil: Toshkent, Navoiy ko'chasi 12",
    'Kabul qilasizmi bu yukni?',
    'Кабул киласизми?',
    'Dushanba kuni yuboraman',
    'یوکنی دوشنبه می‌فرستم',
    '运到塔什干多少钱？',
  ])('«%s» names none', (line) => {
    expect(namesForeignPlace([line])).toBe(false);
  });

  it('the run reads the whole inbound window and the burst — never our own lines', () => {
    const ctx = ctxWith('5 kub 800 kg', []);
    const earlier: ChatMessage = { ...msg('Andijonga kerak', 2) };
    const ours: ChatMessage = { ...msg('Andijonga ham yetkazamiz', 3), direction: 'out' };
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const compose: ComposeReply = {
      replyNeeded: true,
      replyText: 'x',
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
    };
    const loop = { compose, tools: [], outcomes: [], usage };
    expect(memoryFor({ ...ctx, messages: [earlier, ...ctx.messages] }, loop, [], 'gsr-t').foreignDestination).toBe(true);
    expect(memoryFor({ ...ctx, messages: [ours, ...ctx.messages] }, loop, [], 'gsr-t').foreignDestination).toBe(false);
    expect(memoryFor(ctx, loop, [], 'gsr-t').foreignDestination).toBe(false);
  });

  it('the road guards’ own lists are untouched — `ARRIVAL` keeps its byte (a new constant, never an edit)', () => {
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    expect(src).toContain(
      "const ARRIVAL =\n  /yetib\\s+kel|kel(?:di|adi|yapti|ishi)|yetkaz(?:asiz|ib\\s+berasiz|iladi|ilad)|приш[её]л|пришл|прид[её]т|приед|доставит(?:е|ся)|доставят|доставк|arriv|(?:will|do|can)\\s+you\\s+deliver|delivered|到了|到达|送到乌|رسید|samarqand|самарканд|andijon|андижан|namangan|наманган|farg['‘’ʻ`]?ona|фергана|buxoro|бухар|qo['‘’ʻ`]?qon|коканд|urganch|ургенч|qarshi|карши|termiz|термез|nukus|нукус|jizzax|джизак|guliston|гулистан/iu;",
    );
  });
});

describe('the memory keeps every figure the run quoted (spec §1.3)', () => {
  it('a priced estimate is kept; a rail chat keeps none', async () => {
    const ctx = ctxWith('Avia bilan 37.5 kg', [{ ref: 'w1', kind: 'weight', value: 37.5, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(ctx, false));
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
    const kept = memoryFor(ctx, { compose: compose('x'), tools: [], outcomes: [out], usage }, [], 'gsr-t');
    expect(kept.estimates).toEqual([out.priced]);
    const rail = ctxWith("Temir yo'l bilan 37.5 kg qancha?", [{ ref: 'w1', kind: 'weight', value: 37.5, messageRef: '#1' }]);
    expect(memoryFor(rail, { compose: compose('x'), tools: [], outcomes: [out], usage }, [], 'gsr-t').estimates).toEqual([]);
  });
});

describe('G10 for estimate replies — no exemption, measured (spec §1.7)', () => {
  /**
   * The corpus: the replies rule 8 asks for, as a model following it to the letter would write them for twelve
   * customers — the price's own sentence with «taxminan», the load, «Toshkentgacha», then the exclusion sentence.
   * Every digit folds to «#» in the fingerprint, so a template said to twelve chats is ONE text to Telegram.
   */
  const loads: [number, number, number][] = [
    [5, 1000, 800], [3, 300, 330], [2, 400, 360], [10, 1500, 1300], [1, 150, 130], [4, 900, 720],
    [6, 1100, 960], [8, 1200, 1040], [2.5, 500, 450], [7, 700, 770], [12, 2400, 2160], [1.5, 250, 240],
  ];
  const template = loads.map(([m3, kg, usd]) => `${m3} kub, ${kg} kg yukingiz Toshkentgacha taxminan ${usd} $ bo'ladi. Boj va QQS alohida hisoblanadi.`);
  /** The same twelve as the rule's variety asks — each names the goods and says it its own way. */
  const goods = ['kiyim', 'oyoq kiyim', 'o‘yinchoq', 'mebel', 'telefon g‘ilofi', 'idish-tovoq', 'sumka', 'mato', 'chiroq', 'kosmetika', 'avtoehtiyot qism', 'ko‘zoynak'];
  const varied = loads.map(([m3, kg, usd], i) =>
    i % 3 === 0
      ? `${goods[i]} uchun: ${m3} kub, ${kg} kg — Toshkentgacha taxminan ${usd} $. Boj va QQS alohida hisoblanadi.`
      : i % 3 === 1
        ? `Assalomu alaykum! ${m3} kub ${goods[i]} (${kg} kg) Toshkentgacha taxminan ${usd} $ turadi. Boj va QQS alohida hisoblanadi.`
        : `${goods[i]}ingiz ${kg} kg, ${m3} kub ekan — yo'lkira Toshkentgacha taxminan ${usd} $. Boj va QQS alohida hisoblanadi.`,
  );
  /** Groups of more than `fingerprintPeers` replies with one fingerprint: the 4th chat of the day BLOCKS. */
  const collisions = (texts: readonly string[]) => {
    const by = new Map<string, number>();
    for (const t of texts) {
      const fp = textFingerprint(t);
      by.set(fp, (by.get(fp) ?? 0) + 1);
    }
    return [...by.values()].filter((n) => n > AGENT_LIMITS.fingerprintPeers).reduce((a, n) => a + n, 0);
  };

  it('measured: the bare template collides in all twelve chats — the rule’s variety, none', () => {
    expect(collisions(template)).toBe(12);
    expect(collisions(varied)).toBe(0);
  });

  it('and the policy grants no estimate an exemption: from the 4th chat a reply with a figure BLOCKS, at his ✅ too', () => {
    const input: PolicyInput = {
      body: template[0]!,
      language: 'uz',
      customerScript: 'latin',
      numberSources: [
        { value: 800, kind: 'money', label: "yo'lkira", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'total' },
        { value: 5, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
        { value: 1000, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
      ],
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
      hasEstimate: true,
      fromOurWarehouse: false,
    };
    expect(checkAgentReply(input).blocks).toEqual([]);
    const fourth = checkAgentReply({ ...input, fingerprintPeers: AGENT_LIMITS.fingerprintPeers + 1 });
    expect(fourth.blocks.map((b) => b.code)).toContain('fingerprint');
  });
});

describe('the table’s expiry (spec §1.6): the notice, its button, the column’s stamp', () => {
  it('fourteen days before `validThrough`, worded for before and after the date', () => {
    expect(tariffNoticeFrom('2026-12-31')).toBe('2026-12-17');
    expect(tariffNoticeText('2026-12-31', '2026-12-17')).toMatch(/31\.12\.2026 da tugaydi/u);
    expect(tariffNoticeText('2026-12-31', '2027-01-02')).toMatch(/31\.12\.2026 da tugadi/u);
    // No customer anywhere in it — the purge has nothing to blank (agent-fences NO_CHAT).
    expect(tariffNoticeText('2026-12-31', '2026-12-17')).not.toMatch(/GS\d|\+998/u);
  });

  it('the stamp is the China column’s content — another zone or the row order does not move it, a price does', () => {
    const west: FreightBand = { zone: 'kashgar', minDensity: 1, maxDensity: 100, priceUsd: 70, perKg: false };
    expect(tariffFingerprint([...CN, west])).toBe(tariffFingerprint([...CN].reverse()));
    expect(tariffFingerprint(CN.map((b) => (b.minDensity === 151 ? { ...b, priceUsd: 16 } : b)))).not.toBe(tariffFingerprint(CN));
    expect(tariffFingerprint(CN)).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('«✅ Tarif to‘g‘ri» is drawn only with a holder and a stamp, and its callback is one the parser takes', () => {
    const holder = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const rows = buttonsFor('AgentTariffNotice', { holderId: holder, fingerprint: 'a1b2c3d4', text: 'x' })!;
    const data = rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toEqual([`ag:t:${holder}:a1b2c3d4`]);
    expect(parseCallback(data[0]!)).toEqual({ kind: 'agent', op: 't', id: holder, digest: 'a1b2c3d4' });
    expect(buttonsFor('AgentTariffNotice', { holderId: holder, text: 'x' })).toBeNull();
    expect(buttonsFor('AgentTariffNotice', { fingerprint: 'a1b2c3d4', text: 'x' })).toBeNull();
  });
});
