import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cardDigest, cardExtra, digestBody } from '@/modules/wms/agent/card';
import { renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { AGENT_LOCALES } from '@/modules/wms/agent/locale';
import { extractNumbers } from '@/modules/wms/agent/numbers';
import { namedOrigin, zoneForOrigin } from '@/modules/wms/agent/origin';
import { checkAgentReply } from '@/modules/wms/agent/policy';
import { priceReplyText } from '@/modules/wms/agent/price-reply';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, validateActions, withRailRule, type ComposeReply } from '@/modules/wms/agent/run';
import { runTool, TOOL_SPECS, YOLKIRA_GUARDS, type ToolEnv } from '@/modules/wms/agent/tools';
import { CANCELLED_BY_HOLDER } from '@/modules/wms/agent/web-thread';
import { mentionsRail, RAIL_OWNER_QUESTION } from '@/modules/wms/agent/worthy';

/**
 * His answers of 2026-10-24 (docs/AI-SOTUVCHI.md §17.14) where they are pure:
 * the price sentence, the truck and avia minimums, the avia figure and its
 * hedge, rail, the certificate, the origin's zone, and two card defects the
 * answers' package found on the way (the digest's body and its key order).
 */

const SECTIONS = ['yolkira', 'rastamojka', 'podklyuch', null] as const;

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

function ctxWith(body: string, measures: AgentContext['measures']): AgentContext {
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
    measures,
    openCalcs: [],
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext, aviaUsdPerKg: number | null = 17): ToolEnv => ({
  ctx,
  day: '2026-10-24',
  aviaUsdPerKg,
  kb: async () => [],
  // The demo seed's China receiving points (YW, GZ, KA) — read from the warehouses table in a run.
  chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou', 'Qashqar']),
});

function compose(over: Partial<ComposeReply> = {}): ComposeReply {
  return {
    replyNeeded: true,
    replyText: 'Aniqlab aytaman.',
    language: 'uz',
    glossUz: '',
    category: 'other',
    confidence: 0.5,
    needsOwner: false,
    ownerQuestion: '',
    nextStep: 'wait',
    actions: [],
    usedFactIds: [],
    citedMessageRefs: [],
    ...over,
  };
}

describe('«💵 Narx yozaman»: his figure, and no other number, in six languages (his 6 b)', () => {
  it('carries exactly ONE figure — money, his value — in every locale and section', () => {
    for (const locale of AGENT_LOCALES) {
      for (const section of SECTIONS) {
        for (const amount of [1250, 1300.5, 75]) {
          const text = priceReplyText(locale, section, amount);
          const found = extractNumbers(text);
          expect(found, `${locale}/${section}: ${text}`).toHaveLength(1);
          expect(found[0]).toMatchObject({ kind: 'money', value: amount });
        }
      }
    }
  });

  it('names the section in the customer’s language and groups thousands as that language does', () => {
    expect(priceReplyText('uz', 'yolkira', 1250)).toBe('Hisob tayyor: yo‘lkira narxi — 1 250 $.');
    expect(priceReplyText('ru', 'rastamojka', 1250)).toBe('Расчёт готов: растаможка — 1 250 $.');
    expect(priceReplyText('en', 'podklyuch', 1250.5)).toBe('Your quote is ready: turnkey (freight and customs clearance) — $1,250.50.');
    expect(priceReplyText('zh', 'yolkira', 1250)).toContain('运费');
    expect(priceReplyText('fa', 'rastamojka', 1250)).toContain('ترخیص گمرکی');
    expect(priceReplyText('uz_cyrl', 'podklyuch', 1250)).toContain('подключ');
    // No section on the request → «narx», never a guessed one.
    expect(priceReplyText(null, null, 900)).toBe('Hisob tayyor: narxi — 900 $.');
  });
});

describe('the truck’s minimum and avia (his 7, 2026-10-24)', () => {
  const below = ctxWith('Yiwudan 0.5 kub 50 kg yuk bor', [
    { ref: 'w1', kind: 'weight', value: 50, messageRef: '#1' },
    { ref: 'v1', kind: 'volume', value: 0.5, messageRef: '#1' },
  ]);

  it('below BOTH halves: no figure — below_minimum, with the minimum as the only sources', async () => {
    const out = await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, env(below));
    expect(out.text.startsWith('below_minimum')).toBe(true);
    expect(out.estimate).toBeUndefined();
    expect(out.sources.some((s) => s.kind === 'money')).toBe(false);
    expect(out.sources.map((s) => s.value).sort((a, b) => a - b)).toEqual([AGENT_LIMITS.minShipment.m3, AGENT_LIMITS.minShipment.kg]);
  });

  it('one half at the minimum is cargo the truck takes — the tool goes on to its other questions', async () => {
    const heavy = ctxWith('0.5 kub 150 kg yuk bor', [
      { ref: 'w1', kind: 'weight', value: 150, messageRef: '#1' },
      { ref: 'v1', kind: 'volume', value: 0.5, messageRef: '#1' },
    ]);
    const out = await runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, env(heavy));
    expect(out.text.startsWith('below_minimum')).toBe(false);
    // Origin not said: asked, not quoted.
    expect(out.text).toContain("qayerdan jo'natilishi aytilmagan");
  });

  it('the old 0.1 m³ guard is gone; the big-end guards stay', () => {
    expect(YOLKIRA_GUARDS).toEqual({ maxM3: 100, maxKg: 20_000, minTotalUsd: 50, minDensity: 1 });
  });

  const aviaCtx = ctxWith('Avia bilan 37.5 kg', [{ ref: 'w1', kind: 'weight', value: 37.5, messageRef: '#1' }]);

  it('avia = kg × his rate, with the rate, the total and the days as sources, and an estimate', async () => {
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, 17));
    expect(out).toMatchObject({ ok: true, estimate: true });
    expect(out.sources).toEqual(
      expect.arrayContaining([
        // In dollars, and which is the load's price and which the kilo's (K16, K21).
        { value: 637.5, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', currency: 'USD', role: 'total' },
        { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool', currency: 'USD', role: 'rate' },
        // The days are a FLIGHT's — never a truck's figure (fix round).
        { value: AGENT_LIMITS.avia.daysMin, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
        { value: AGENT_LIMITS.avia.daysMax, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
      ]),
    );
  });

  it('no rate = avia is not quoted; under a kilo = the avia minimum', async () => {
    const none = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, null));
    expect(none).toMatchObject({ ok: false });
    expect(none.sources).toEqual([]);
    const tiny = ctxWith('Avia 0.4 kg', [{ ref: 'w1', kind: 'weight', value: 0.4, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(tiny, 17));
    expect(out.text.startsWith('below_minimum')).toBe(true);
    expect(out.sources).toEqual([{ value: AGENT_LIMITS.avia.minKg, kind: 'measure', label: 'avia minimal yuk (1 kg)', origin: 'tool' }]);
  });

  it('an avia figure makes G11 apply — unhedged is blocked, hedged passes', async () => {
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(aviaCtx, 17));
    const loop = { compose: compose(), tools: [], outcomes: [out], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const memory = memoryFor(aviaCtx, loop, [], 'gsr-test');
    expect(memory.hasEstimate).toBe(true);
    const check = (body: string) =>
      checkAgentReply({
        body,
        language: 'uz',
        customerScript: 'latin',
        numberSources: memory.sources,
        removeWhole: [],
        ownCodes: [],
        bookCodes: new Set(),
        codePrefix: 'GS',
        allowedPhones: [],
        allowedUrls: [],
        mapUrls: [],
        askedLocation: false,
        staffNames: [],
        canary: 'gsr-test',
        fingerprintPeers: 0,
        urlsToChat7d: 0,
        urlsToday: 0,
        hasEstimate: memory.hasEstimate,
        fromOurWarehouse: memory.fromOurWarehouse === true,
      });
    expect(check('Avia 637.5 $.').blocks.map((b) => b.code)).toContain('estimate_unhedged');
    // His fourth set «2» withdrew K32 for the flight: its address is his, so no warehouse condition is asked.
    expect(memory.fromOurWarehouse).toBe(false);
    expect(check('Avia bilan taxminan 637.5 $, 2-5 kun. Boj va QQS alohida hisoblanadi.').ok).toBe(true);
  });

  it('the toolset offers avia_estimate taking a REFERENCE, never a figure', () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'avia_estimate')!;
    expect(Object.keys((spec.input_schema as { properties: object }).properties)).toEqual(['weight_ref']);
  });
});

describe('rail is his question', () => {
  it('reads rail in the six languages, and not inside other words', () => {
    for (const t of [
      "temir yo'l bilan qancha?",
      'temiryo‘l orqali',
      'poyezdda yuborsa',
      'темир йўл орқали',
      'Сколько по ЖД?',
      'ж/д доставка',
      'железной дорогой',
      'поездом',
      'by rail please',
      'railway freight',
      'by train',
      'با قطار',
      'راه آهن',
      '铁路运输多少钱',
      '火车',
    ]) {
      expect(mentionsRail([t]), t).toBe(true);
    }
    for (const t of ['Жду ответа', 'trailer bilan', 'temir buyumlar 5 kub', 'training', 'Salom']) {
      expect(mentionsRail([t]), t).toBe(false);
    }
  });

  it('forces needs_owner with his question — and keeps the model’s own question when it asked one', () => {
    const burst = [msg({ body: "Temir yo'l bilan qancha bo'ladi?" })];
    expect(withRailRule(compose(), { burst })).toMatchObject({ needsOwner: true, ownerQuestion: RAIL_OWNER_QUESTION });
    expect(withRailRule(compose({ ownerQuestion: 'Ertaga aytaymi?' }), { burst }).ownerQuestion).toBe('Ertaga aytaymi?');
    expect(withRailRule(compose(), { burst: [msg({ body: 'Yuk qayerda?' })] }).needsOwner).toBe(false);
  });

  it('the prompt says it too — the AI never quotes rail', () => {
    expect(stableHead({ styleGuide: null, facts: [] })).toContain(RAIL_OWNER_QUESTION);
  });
});

describe('the certificate is the company’s (his 9)', () => {
  it('the checklist asks for no certificate — a complete rastamojka needs only the goods', async () => {
    const ctx = ctxWith('Rastamojka kerak: kurtka 100 dona, 3 kub 500 kg', []);
    const out = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] }, env(ctx));
    expect(out.checklist).toMatchObject({ section: 'rastamojka', complete: true });
    expect(out.checklist).not.toHaveProperty('certificate');
    expect(out.text).not.toMatch(/sertifikat/iu);
    const spec = TOOL_SPECS.find((t) => t.name === 'calc_checklist')!;
    expect(Object.keys((spec.input_schema as { properties: object }).properties)).not.toContain('certificate');
  });

  it('the calc_submit action carries no certificate field at all, and the prompt forbids asking', async () => {
    const ctx = ctxWith('Rastamojka kerak: kurtka 100 dona, 3 kub 500 kg', []);
    const out = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] }, env(ctx));
    const c = compose({ actions: [{ type: 'calc_submit', section: 'rastamojka', citedMessageRefs: ['#1'], date: '', note: '' }] });
    const { actions } = validateActions(c, ctx, [out], new Date());
    expect(actions).toHaveLength(1);
    // Nothing reads it since his «9» — and a stored «certificate: null» would only say the AI asked.
    expect(actions[0]).not.toHaveProperty('certificate');
    expect(stableHead({ styleGuide: null, facts: [] })).toMatch(/sertifikatini HECH QACHON so'rama/u);
  });
});

describe('the origin’s zone — the bot’s buttons, never a guess (review A11)', () => {
  it('maps a named place to its tariff zone, and anything else to none', () => {
    expect(zoneForOrigin('Qashqar')).toBe('kashgar');
    expect(zoneForOrigin('Kashgar')).toBe('kashgar');
    expect(zoneForOrigin('Xorgos')).toBe('horgos');
    expect(zoneForOrigin('Yiwu')).toBe('cn');
    expect(zoneForOrigin('Guangzhou')).toBe('cn');
    expect(zoneForOrigin('Xitoy')).toBeNull();
    expect(zoneForOrigin('Urumchi')).toBeNull();
    expect(zoneForOrigin('Yiwu va Qashqar')).toBeNull();
    expect(zoneForOrigin(null)).toBeNull();
  });

  it('finds the one place a customer named, not a word that only ends like one', () => {
    expect(namedOrigin('Qashqardan Toshkentga 3 kub')).toEqual({ place: 'Qashqar', zone: 'kashgar' });
    expect(namedOrigin('Я живу в Ташкенте')).toBeNull();
    expect(namedOrigin('Ивудан юк бор')).toEqual({ place: 'Yiwu', zone: 'cn' });
  });
});

describe('the card’s digest is over what ✅ sends (A12)', () => {
  it('a body stored with whitespace at its ends draws the digest the decision recomputes', () => {
    const extra = cardExtra({ id: 'd', body: 'Salom!\n', actions: [], blocked: false, live: true, kind: 'reply' });
    expect(extra.digest).toBe(cardDigest(digestBody({ finalBody: null, proposedBody: 'Salom!\n' }), []));
    expect(digestBody({ finalBody: '  Mening matnim ', proposedBody: 'x' })).toBe('Mening matnim');
  });

  it('the actions digest the same written and read back from jsonb (key order is not meaning)', () => {
    const written = [{ type: 'calc_submit', section: 'rastamojka', facts: { weightKg: 1, fromCity: 'Yiwu' }, fromOurWarehouse: false, citedMessageIds: [] }];
    // jsonb hands objects back with its own key order (shorter keys first).
    const stored = [{ type: 'calc_submit', facts: { fromCity: 'Yiwu', weightKg: 1 }, section: 'rastamojka', citedMessageIds: [], fromOurWarehouse: false }];
    expect(cardDigest('x', stored)).toBe(cardDigest('x', written));
    expect(cardDigest('x', [{ type: 'mute', reason: 'a' }])).not.toBe(cardDigest('x', [{ type: 'mute', reason: 'b' }]));
  });

  it('a reply he took back on the page has a word on the card, never the raw value', () => {
    const d = {
      id: 'd',
      status: 'approved',
      kind: 'reply',
      finalBody: null,
      proposedBody: 'Salom',
      glossUz: null,
      needsOwner: false,
      ownerQuestion: null,
      actions: [],
      policy: {},
      actionStatus: null,
      actionError: null,
    } as unknown as DraftRow;
    const o = { status: 'cancelled', lastError: CANCELLED_BY_HOLDER, nextStepAt: new Date(), sentAt: null } as never;
    expect(renderDraftCard(d, o)).toContain('✖ Yuborilmadi — o‘zingiz qaytarib oldingiz.');
  });
});

describe('one home for the day’s counts and the media words (#513, A13)', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the page and the ✅ read the caps from today.ts, never their own SQL', () => {
    const page = strip(readFileSync('src/modules/wms/agent/web-page.ts', 'utf8'));
    expect(page).not.toMatch(/FROM\s+agent_runs\s+WHERE\s+created_at/u);
    expect(page).not.toMatch(/FROM\s+agent_outbox\s+WHERE\s+manager_user_id/u);
    expect(page).toMatch(/dayRunCounts\(/u);
    expect(page).toMatch(/sendsToday\(/u);
    const decide = strip(readFileSync('src/modules/wms/agent/decide.ts', 'utf8'));
    expect(decide.slice(decide.indexOf('async function budgetLeft'))).toMatch(/^[\s\S]{0,400}sendsToday\(/u);
    const run = strip(readFileSync('src/modules/wms/agent/run.ts', 'utf8'));
    expect(run).not.toMatch(/FROM\s+agent_runs\s+WHERE\s+created_at/u);
  });

  it('the census asks the context’s own mediaOf', () => {
    const census = strip(readFileSync('src/modules/wms/agent/census.ts', 'utf8'));
    expect(census).toMatch(/mediaOf\(/u);
    expect(census).not.toMatch(/startsWith\('image\/'\)/u);
  });
});

describe('the VED’s hand-back waits on nothing of the agent’s (review regression-3)', () => {
  it('returnCalcRequest tells the agent AFTER the seller’s task, and the agent only queues', () => {
    const src = readFileSync('src/modules/wms/calc/service.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function returnCalcRequest'), src.indexOf('const ANSWER_CURRENCIES'));
    expect(body.indexOf("announceAgentCalcSafe(id, 'returned'")).toBeGreaterThan(body.indexOf('await createTask('));
    const loop = readFileSync('src/modules/wms/agent/calc-loop.ts', 'utf8');
    const announce = loop.slice(loop.indexOf('export async function announceAgentCalc('), loop.indexOf('export function handBackInstruction'));
    expect(announce).not.toMatch(/runOwnerTriggered\(/u);
    expect(announce).toMatch(/JOB_AGENT_HAND_BACK/u);
  });
});
