import { describe, expect, it } from 'vitest';
import { ambiguousPrice, noQuestionWhy, typedPriceUsd } from '@/modules/wms/agent/calc-loop';
import { renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { namedOrigin, zoneForOrigin } from '@/modules/wms/agent/origin';
import { checkAgentReply } from '@/modules/wms/agent/policy';
import { memoryFor, validateActions, type ComposeReply } from '@/modules/wms/agent/run';
import { originZone, runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';
import { mentionsRail } from '@/modules/wms/agent/worthy';

/**
 * The review of the answers' package (2026-10-24), where its findings are
 * pure: the truck minimum at every door, avia's volumetric weight, rail with
 * a machine figure, an ambiguous typed price, Qashqadaryo, «Иу», a retired
 * draft's words and the hand-back's «why no question».
 */

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

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const OURS: ReadonlySet<string> = new Set(['Yiwu', 'Guangzhou', 'Qashqar']);

describe('the truck’s minimum holds at the hisoblatish door too (his «1 kubdan kam yuk qabul qilmasin»)', () => {
  const small = 'Yiwudan Toshkentga podklyuch, 0.4 kub 60 kg, kurtka 50 dona';

  it('the checklist says below_minimum and is never complete for a truck job below BOTH halves', async () => {
    for (const section of ['podklyuch', 'yolkira']) {
      const out = await runTool('calc_checklist', { section, goods: [{ name: 'kurtka', quantity: 50, weight_kg: null }] }, env(ctxWith(small, [])));
      expect(out.text.startsWith('below_minimum'), section).toBe(true);
      expect(out.checklist).toMatchObject({ section, complete: false });
      expect(out.sources.some((s) => s.kind === 'money')).toBe(false);
    }
  });

  it('a rastamojka-only job is not bound by it (it can be avia cargo); one half at the minimum is carried', async () => {
    const rast = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 50, weight_kg: null }] }, env(ctxWith(small, [])));
    expect(rast.checklist).toMatchObject({ complete: true });
    const heavy = await runTool(
      'calc_checklist',
      { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 50, weight_kg: null }] },
      env(ctxWith('Yiwudan Toshkentga podklyuch, 0.4 kub 100 kg, kurtka 50 dona', [])),
    );
    expect(heavy.checklist).toMatchObject({ complete: true });
  });

  it('the server drops a calc_submit below the minimum even when a checklist called it complete, and says why', () => {
    const ctx = ctxWith(small, []);
    const stale: ToolOutcome = {
      ok: true,
      text: "To'liq.",
      sources: [],
      checklist: {
        section: 'podklyuch',
        facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 60, volumeM3: 0.4, goods: [{ name: 'kurtka', quantity: 50, weightKg: null }] },
        complete: true,
        fromOurWarehouse: false,
      },
    };
    const c = compose({ actions: [{ type: 'calc_submit', section: 'podklyuch', citedMessageRefs: ['#1'], date: '', note: '' }] });
    const { actions, notes } = validateActions(c, ctx, [stale], new Date());
    expect(actions).toEqual([]);
    expect(notes.join(' ')).toContain(`${AGENT_LIMITS.minShipment.m3} kub / ${AGENT_LIMITS.minShipment.kg} kg`);
  });
});

describe('avia is the ACTUAL kilos × his rate — volume never changes the figure, and there is no ceiling (his «1b / 2b»)', () => {
  const aviaFor = async (kg: number, m3: number | null) => {
    const measures: AgentContext['measures'] = [{ ref: 'w1', kind: 'weight', value: kg, messageRef: '#1' }];
    if (m3 !== null) measures.push({ ref: 'v1', kind: 'volume', value: m3, messageRef: '#1' });
    return runTool('avia_estimate', { weight_ref: 'w1' }, env(ctxWith(`${m3 ?? ''} kub, ${kg} kg, avia qancha?`, measures), 17));
  };
  const total = (out: ToolOutcome) => out.sources.find((s) => s.label === 'avia (tarif × kg)')?.value;

  it('50 kg is 850 $ whether the chat stated 2 m³, 0.1 m³ or no volume at all', async () => {
    for (const m3 of [2, 0.1, null]) {
      const out = await aviaFor(50, m3);
      expect(out, String(m3)).toMatchObject({ ok: true, estimate: true });
      expect(total(out), String(m3)).toBe(850);
      expect(out.sources, String(m3)).toContainEqual({
        value: 850,
        kind: 'money',
        label: 'avia (tarif × kg)',
        origin: 'tool',
        currency: 'USD',
        role: 'total',
      });
    }
  });

  it('a heavy load is quoted too — no upper weight bound', async () => {
    const out = await aviaFor(25_000, 3);
    expect(out).toMatchObject({ ok: true, estimate: true });
    expect(total(out)).toBe(425_000);
  });
});

describe('rail: the spellings customers type, and no machine figure on a rail answer', () => {
  it('reads «temir yul», «poyzd», «ж.д.», «вагоном», «по железке», «班列» — and not a star', () => {
    for (const t of ['temir yulda qancha', 'temiryul bilan', 'poyzd bilan', 'сколько стоит ж.д.?', 'вагоном', 'по железке', '中亚班列', 'vagon bilan']) {
      expect(mentionsRail([t]), t).toBe(true);
    }
    for (const t of ['temir yulduz', 'Жду ответа', 'trailer bilan']) expect(mentionsRail([t]), t).toBe(false);
  });

  it('in a rail burst the tools’ money leaves the memory, so G1 blocks the figure and G11 does not apply', async () => {
    const ctx = ctxWith("Temir yo'l bilan 40 kg qancha?", [{ ref: 'w1', kind: 'weight', value: 40, messageRef: '#1' }]);
    const avia = await runTool('avia_estimate', { weight_ref: 'w1' }, env(ctx, 17));
    expect(avia.sources.some((s) => s.kind === 'money')).toBe(true);
    const memory = memoryFor(ctx, { compose: compose(), tools: [], outcomes: [avia], usage }, [], 'gsr-test');
    expect(memory.sources.some((s) => s.kind === 'money')).toBe(false);
    expect(memory.hasEstimate).toBe(false);
    const result = checkAgentReply({
      body: 'Taxminan 680 $ bo‘ladi. Boj va QQS alohida.',
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
    expect(result.blocks.map((b) => b.code)).toContain('number_unsourced');
  });
});

describe('a typed price a separator makes a thousand times ambiguous is asked about (his B4 a)', () => {
  it('«1.250» and «1,250» are neither 1.25 nor 1250 until he says which', () => {
    for (const t of ['1.250', '1,250', '12.500', '$1.250', '1.250 $']) {
      expect(typedPriceUsd(t), t).toBeNull();
      expect(ambiguousPrice(t), t).not.toBeNull();
    }
    expect(ambiguousPrice('1.250')).toEqual({ thousands: 1250, decimal: 1.25 });
  });

  it('the ways he is asked to retype it read without a question', () => {
    expect(typedPriceUsd('1250')).toBe(1250);
    expect(typedPriceUsd('1 250')).toBe(1250);
    expect(typedPriceUsd('1,25')).toBe(1.25);
    expect(typedPriceUsd('1 250,50')).toBe(1250.5);
    expect(ambiguousPrice('0.250')).toBeNull();
  });
});

describe('Qashqadaryo is a destination, not Kashgar; «Иу» is Yiwu', () => {
  it('names no origin for the Uzbek region, in Latin and Cyrillic', () => {
    for (const t of ['Qashqadaryoga podklyuch kerak', 'Қашқадарёга юк', 'Qarshi, Qashqadaryo viloyati']) {
      expect(namedOrigin(t), t).toBeNull();
      expect(zoneForOrigin(t), t).toBeNull();
      expect(originZone(ctxWith(t, []), OURS), t).toBe('unknown');
    }
    expect(namedOrigin('Qashqardan yuk')).toEqual({ place: 'Qashqar', zone: 'kashgar' });
    expect(namedOrigin('Қашқардан юк')).toEqual({ place: 'Qashqar', zone: 'kashgar' });
    expect(originZone(ctxWith('Yiwudan Qashqadaryoga 3 kub', []), OURS)).toBe('warehouse');
  });

  it('reads the Russian Yiwu alone and with an Uzbek case ending, not inside a word', () => {
    expect(namedOrigin('Груз из Иу в Ташкент')).toEqual({ place: 'Yiwu', zone: 'cn' });
    expect(namedOrigin('Иудан юк бор')).toEqual({ place: 'Yiwu', zone: 'cn' });
    expect(namedOrigin('Иуда юк турибди')).toEqual({ place: 'Yiwu', zone: 'cn' });
    expect(namedOrigin('Иудаизм')).toBeNull();
  });
});

describe('a retired draft says WHY on its card', () => {
  const row = (policy: Record<string, unknown>) =>
    ({
      id: 'd',
      status: 'superseded',
      kind: 'price',
      finalBody: null,
      proposedBody: 'Hisob tayyor: narxi — 1 250 $.',
      glossUz: null,
      needsOwner: false,
      ownerQuestion: null,
      actions: [],
      policy,
      actionStatus: null,
      actionError: null,
    }) as unknown as DraftRow;

  it('a recalculation, a new avia rate, and the customer writing again are three different sentences', () => {
    expect(renderDraftCard(row({ stale: 'recalc' }), null)).toContain('VED qayta hisoblayapti');
    expect(renderDraftCard(row({ stale: 'avia_rate' }), null)).toContain('Avia tarifi o‘zgardi');
    expect(renderDraftCard(row({}), null)).toContain('Mijoz yana yozdi');
  });
});

describe('a hand-back that drafts nothing tells him why', () => {
  it('words for a refusal, the cap, an error, no reply and a stale chat — and silence for a draft or a duplicate', () => {
    expect(noQuestionWhy({ outcome: 'refused', reason: 'human_active' })).toContain("o'zingiz yozayapsiz");
    expect(noQuestionWhy({ outcome: 'refused', reason: 'listener_behind' })).toContain('tg-listen');
    expect(noQuestionWhy({ outcome: 'capped', reason: 'daily_token_cap' })).not.toBeNull();
    expect(noQuestionWhy({ outcome: 'error', reason: 'x' })).not.toBeNull();
    expect(noQuestionWhy({ outcome: 'no_reply' })).not.toBeNull();
    expect(noQuestionWhy({ outcome: 'skipped', reason: 'no_fresh_inbound' })).toContain('24 soat');
    expect(noQuestionWhy({ outcome: 'skipped', reason: 'agent_off' })).toBeNull();
    expect(noQuestionWhy({ outcome: 'draft', draftId: 'd', blocked: false })).toBeNull();
    expect(noQuestionWhy({ outcome: 'stood_down', reason: 'duplicate' })).toBeNull();
  });
});
