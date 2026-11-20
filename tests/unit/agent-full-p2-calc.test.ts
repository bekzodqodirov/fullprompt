import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { isCalcSubmitOnly } from '@/modules/wms/agent/auto-gate';
import { landedUnsentLine, LANDED_UNSENT, LANDING_CLAIM } from '@/modules/wms/agent/card-io';
import { CALC_FILES_MAX, calcFileCopyId, filesMaterialLine, missingFilesNote } from '@/modules/wms/agent/calc-files';
import { CALC_RECENT_MS, handBackLoopOf } from '@/modules/wms/agent/calc-submit';
import type { AgentContext, CalcChain, ChatMessage } from '@/modules/wms/agent/context';
import { CHECKLIST_UNITS, checklistLine, lineNeedWords, runTool, TOOL_SPECS, type ToolEnv } from '@/modules/wms/agent/tools';
import { FIELD_LABEL, missingFields, type CalcFacts } from '@/modules/wms/calc/intake';
import { needLawOf } from '@/modules/wms/calc/needs';

/**
 * «Hisoblatishni o'zi yuboradi» — SPEC-P2-v2 §1, package P2, its pure rules: which draft is a calculation, the
 * checklist's units routed by the door's own rule, the law's figure named in the customer's words, the hand-back
 * loop's card, the files' words, the card line of a job that landed while its reply did not go.
 */

describe('a draft judged as `calc` — by its one act (§1.1)', () => {
  it.each([
    [['calc_submit'], true],
    [['calc_submit', 'set_followup'], true],
    [['set_followup', 'calc_submit'], true],
    [['calc_submit', 'mute'], false],
    [['calc_submit', 'calc_submit'], false],
    [['set_followup'], false],
    [[], false],
    [['mute'], false],
  ] as const)('%j → %s', (actions, expected) => {
    expect(isCalcSubmitOnly(actions)).toBe(expected);
  });
});

describe('the checklist’s goods carry their unit (§1.6) — routed by the door’s own rule', () => {
  it('«kafel 120 m2» is 120 m², never 120 pieces', () => {
    expect(checklistLine('Kafel', 120, null, 'm2')).toMatchObject({ name: 'Kafel', quantity: null, measureUnit: 'm2', measureQty: 120 });
  });

  it('litres, pairs and engine cubic centimetres go to the measure pair; kilograms to the line’s weight', () => {
    expect(checklistLine('Pivo', 1000, null, 'litr')).toMatchObject({ quantity: null, measureUnit: 'litr', measureQty: 1000 });
    expect(checklistLine('Tufli', 300, null, 'juft')).toMatchObject({ quantity: null, measureUnit: 'juft', measureQty: 300 });
    expect(checklistLine('Motor', 1500, null, 'sm3')).toMatchObject({ quantity: null, measureUnit: 'sm3', measureQty: 1500 });
    expect(checklistLine('Shakar', 1100, null, 'kg')).toMatchObject({ quantity: null, weightKg: 1100 });
  });

  it('a carton count is never the goods’ count — out of the count, said in the note', () => {
    const line = checklistLine('Kurtka', 5, null, 'karobka');
    expect(line.quantity).toBeNull();
    expect(line.measureUnit ?? null).toBeNull();
    expect(line.note).toMatch(/5 karobka/u);
  });

  it('no unit, or pieces, is today’s line exactly — byte for byte in the checklist’s JSON', () => {
    for (const unit of [null, undefined, 'dona', 'nonsense', 7]) {
      expect(JSON.stringify(checklistLine('Kurtka', 100, 40, unit))).toBe(JSON.stringify({ name: 'Kurtka', quantity: 100, weightKg: 40 }));
    }
    // A unit with no figure moves nothing either.
    expect(JSON.stringify(checklistLine('Kafel', null, null, 'm2'))).toBe(JSON.stringify({ name: 'Kafel', quantity: null, weightKg: null }));
  });

  it('the tool’s goods offer exactly the spec’s units, and a null', () => {
    expect([...CHECKLIST_UNITS]).toEqual(['dona', 'kg', 'm2', 'juft', 'litr', 'sm3', 'karobka']);
    const spec = TOOL_SPECS.find((t) => t.name === 'calc_checklist')!;
    const items = (spec.input_schema as { properties: { goods: { items: { properties: Record<string, { enum?: unknown[] }>; required: string[] } } } }).properties.goods.items;
    expect(items.properties.unit!.enum).toEqual([...CHECKLIST_UNITS, null]);
    expect(items.required).toContain('unit');
    // The leak-11 fence's own rule: no tool property names a code.
    expect(Object.keys(items.properties).some((k) => /code/iu.test(k))).toBe(false);
  });
});

describe('the figure a law pins, asked in the customer’s words (§1.6)', () => {
  const litr = new Map([['2203001000', needLawOf({ dutyMode: 'max', dutyUnit: 'litr', dutySpecific: 1, dutyFree: false })]]);
  const facts = (goods: CalcFacts['goods']): CalcFacts => ({ fromCity: null, toCity: null, weightKg: 1200, volumeM3: 2, goods });

  it('«Pivo, 1100 kg» under a litre law: the line owes its litres — named by the unit’s words, never by the staff label', () => {
    const f = facts([{ name: 'Pivo', quantity: null, weightKg: 1100, tnvedCode: '2203001000' }]);
    expect(missingFields('rastamojka', f, litr)).toEqual(['lineNeed']);
    expect(lineNeedWords('rastamojka', f, litr)).toEqual(['«Pivo»: hajmi (litr)']);
    expect(lineNeedWords('rastamojka', f, litr).join(' ')).not.toContain(FIELD_LABEL.lineNeed);
    // No dollar figure of the law reaches the model's words.
    expect(lineNeedWords('rastamojka', f, litr).join(' ')).not.toMatch(/\$|\d/u);
  });

  it('…and «1000 litr» closes it', () => {
    const f = facts([{ ...checklistLine('Pivo', 1000, 1100, 'litr'), tnvedCode: '2203001000' }]);
    expect(missingFields('rastamojka', f, litr)).toEqual([]);
    expect(lineNeedWords('rastamojka', f, litr)).toEqual([]);
  });

  it('with no law (the act off) the same line is complete — today’s checklist', () => {
    const f = facts([{ name: 'Pivo', quantity: null, weightKg: 1100 }]);
    expect(missingFields('rastamojka', f, new Map())).toEqual([]);
  });

  it('the checklist’s off path is today’s call, byte for byte (source)', () => {
    const src = readFileSync('src/modules/wms/agent/tools.ts', 'utf8');
    expect(src).toContain(': missingFields(section, facts, new Map()).map((f) => FIELD_LABEL[f]);');
    expect(src).toMatch(/const laws = env\.calcArmed \? await armedLaws\(goods\) : null;/u);
  });
});

describe('the hand-back loop’s card (§1.5)', () => {
  const chain = (over: Partial<CalcChain>): CalcChain => ({
    root: 'r1',
    linkedAt: new Date('2026-11-10T08:00:00Z'),
    newestId: 'q1',
    newestRequestedAt: new Date('2026-11-10T08:00:00Z'),
    section: 'rastamojka',
    status: 'returned',
    entityType: 'deal',
    entityId: 'd1',
    dealClientId: 'c1',
    cardLabel: 'B-00001',
    memberIds: ['r1', 'q1'],
    endedAt: new Date('2026-11-10T09:00:00Z'),
    cardOpen: true,
    returnTaskOpen: true,
    ...over,
  });
  /** A day after the hand-back. */
  const NOW = new Date('2026-11-11T09:00:00Z');

  it('a returned chain of the section on the client’s own deal is the loop', () => {
    expect(handBackLoopOf([chain({})], 'rastamojka', { clientId: 'c1', leadId: null }, NOW)).toEqual({
      requestId: 'q1',
      rootRequestId: 'r1',
      card: { kind: 'deal', id: 'd1', label: 'B-00001' },
    });
  });

  it('…and on the chat’s own lead when the chat has no client', () => {
    const lead = chain({ entityType: 'lead', entityId: 'l1', dealClientId: null, cardLabel: 'Ali' });
    expect(handBackLoopOf([lead], 'rastamojka', { clientId: null, leadId: 'l1' }, NOW)?.card).toEqual({ kind: 'lead', id: 'l1', label: 'Ali' });
    // A lead beside a client (won since) is no loop: the landing would land on the client's new deal.
    expect(handBackLoopOf([lead], 'rastamojka', { clientId: 'c1', leadId: 'l1' }, NOW)).toBeNull();
  });

  it('never another section, an answered or open chain, another client’s deal or another lead', () => {
    expect(handBackLoopOf([chain({})], 'podklyuch', { clientId: 'c1', leadId: null }, NOW)).toBeNull();
    expect(handBackLoopOf([chain({ status: 'answered' })], 'rastamojka', { clientId: 'c1', leadId: null }, NOW)).toBeNull();
    expect(handBackLoopOf([chain({ status: 'open' })], 'rastamojka', { clientId: 'c1', leadId: null }, NOW)).toBeNull();
    expect(handBackLoopOf([chain({ dealClientId: 'c2' })], 'rastamojka', { clientId: 'c1', leadId: null }, NOW)).toBeNull();
    expect(
      handBackLoopOf([chain({ entityType: 'lead', entityId: 'l2', dealClientId: null })], 'rastamojka', { clientId: null, leadId: 'l1' }, NOW),
    ).toBeNull();
  });

  it('the newest returned chain answers when there are two', () => {
    const older = chain({ newestId: 'q1', newestRequestedAt: new Date('2026-11-01T08:00:00Z') });
    const newer = chain({ root: 'r2', newestId: 'q2', newestRequestedAt: new Date('2026-11-09T08:00:00Z'), entityId: 'd2' });
    expect(handBackLoopOf([older, newer], 'rastamojka', { clientId: 'c1', leadId: null }, NOW)?.requestId).toBe('q2');
  });

  it('bounded (findings 7, 10): only a return within the 14 days, on a card still taking jobs, its ↩️ task still open', () => {
    const id = { clientId: 'c1', leadId: null };
    // The 14 days are the 14-day rule's own (`CALC_RECENT_MS`): exactly at the edge still the loop, a minute past it none.
    const ended = new Date('2026-11-10T09:00:00Z');
    expect(handBackLoopOf([chain({ endedAt: ended })], 'rastamojka', id, new Date(ended.getTime() + CALC_RECENT_MS))?.requestId).toBe('q1');
    expect(handBackLoopOf([chain({ endedAt: ended })], 'rastamojka', id, new Date(ended.getTime() + CALC_RECENT_MS + 60_000))).toBeNull();
    // A return with no time on it is no loop (fails closed).
    expect(handBackLoopOf([chain({ endedAt: null })], 'rastamojka', id, NOW)).toBeNull();
    // A deal won or lost since, a lead closed since — no loop.
    expect(handBackLoopOf([chain({ cardOpen: false })], 'rastamojka', id, NOW)).toBeNull();
    expect(handBackLoopOf([chain({ entityType: 'lead', entityId: 'l1', dealClientId: null, cardOpen: false })], 'rastamojka', { clientId: null, leadId: 'l1' }, NOW)).toBeNull();
    // He closed the «↩️ Ma'lumot to'ldiring» himself — the request is handled, no loop.
    expect(handBackLoopOf([chain({ returnTaskOpen: false })], 'rastamojka', id, NOW)).toBeNull();
    // A stale returned chain does not hide a fresh one behind it.
    const stale = chain({ newestId: 'q9', newestRequestedAt: new Date('2026-11-10T10:00:00Z'), cardOpen: false });
    expect(handBackLoopOf([stale, chain({})], 'rastamojka', id, NOW)?.requestId).toBe('q1');
  });
});

describe('the files that go to the VED (§1.4) — and the ones that cannot', () => {
  it('a copy’s id is the (note, file) pair’s: the same press twice is the same row, another note another', () => {
    const note = '11111111-1111-4111-8111-111111111111';
    const file = '22222222-2222-4222-8222-222222222222';
    expect(calcFileCopyId(note, file)).toBe(calcFileCopyId(note, file));
    expect(calcFileCopyId(note, file)).not.toBe(calcFileCopyId('33333333-3333-4333-8333-333333333333', file));
    expect(CALC_FILES_MAX).toBe(10);
  });

  it('the note names the files it carries, and says the ones it does not', () => {
    expect(filesMaterialLine([{ fileName: 'invoice.pdf' }, { fileName: 'photo.jpg' }], 0)).toEqual([
      'Chatdan 2 ta fayl VEDga biriktirildi: invoice.pdf, photo.jpg.',
    ]);
    expect(filesMaterialLine([], 1)).toEqual(['(Chatda yana 1 ta fayl/rasm saqlanmagan — Telegram suhbatida.)']);
    expect(filesMaterialLine([], 0)).toEqual([]);
  });

  it('the card names the day of a file nobody kept, and what ✅ does then', () => {
    const at = new Date('2026-11-12T07:00:00Z');
    expect(missingFilesNote([at])).toBe('📎 12.11 dagi fayl saqlanmagan — ✅ bossangiz faylsiz yuboriladi; faylni VEDga o‘zingiz bering.');
    expect(missingFilesNote([at, at])).toMatch(/^📎 12\.11 dagi 2 ta fayl saqlanmagan/u);
    expect(missingFilesNote([])).toBeNull();
  });
});

describe('a job that landed while its reply did not go (§1.2)', () => {
  it('its own marker, apart from the landing’s claim', () => {
    expect(LANDED_UNSENT).toBe('landed_unsent');
    expect(LANDED_UNSENT).not.toBe(LANDING_CLAIM);
  });

  it('the card says where the job is and what ✅ and ❌ do', () => {
    expect(landedUnsentLine('B-00042')).toBe('🧮 VEDga tushdi (B-00042) — mijozga javob ketmadi: ✅ bilan yuboring yoki ❌ (VED ishi qoladi).');
    expect(landedUnsentLine(null)).toBe('🧮 VEDga tushdi — mijozga javob ketmadi: ✅ bilan yuboring yoki ❌ (VED ishi qoladi).');
    expect(landedUnsentLine('lid «Ali»', true)).toBe('🧮 Hisoblatish VEDda qoldi (lid «Ali») — mijozga javob ketmadi.');
  });

  it('the note written before the approval says neither who approved nor that the AI sent it by itself (source)', () => {
    const src = readFileSync('src/modules/wms/agent/decide.ts', 'utf8');
    expect(src).toContain(`"AI sotuvchi mijozning Telegram suhbatidan yig'di."`);
    expect(src).not.toContain(`yig'di, egasi tasdiqladi.`);
    expect(src).not.toContain(`AI o'zi yubordi (egasi ko'rmagan)`);
  });
});

describe('the checklist with the act off is today’s, byte for byte (§1.6, §4.3)', () => {
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
  const ctxOf = (body: string): AgentContext => {
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
      measures: [],
      openCalcs: [],
      lastQuote: null,
      ruleDecision: null,
    };
  };
  const env = (ctx: AgentContext): ToolEnv => ({
    ctx,
    day: '2026-11-14',
    aviaUsdPerKg: null,
    kb: async () => [],
    chinaPlaces: async () => new Set(['Yiwu']),
    priceArmed: false,
    calcArmed: false,
  calcPricing: false,
    aviaDays: AVIA_DAYS_DEFAULT,
  });

  it('a complete line with no unit: the very text and facts the checklist wrote before the unit existed', async () => {
    const ctx = ctxOf('Rastamojka kerak: 2 kub 1200 kg, kurtka 100 dona');
    const out = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 100, unit: null, weight_kg: null }] }, env(ctx));
    expect(out.text).toBe(
      `To'liq. rastamojka: {"fromCity":null,"toCity":null,"weightKg":1200,"volumeM3":2,"goods":[{"name":"kurtka","quantity":100,"weightKg":null}]}. ` +
        'Endi actions ichida calc_submit taklif qil va mijozga «hisoblatishga yubordim, javob kelishi bilan aytaman» de.',
    );
    // …and a model that sends no `unit` at all (a call before the field existed) is the same call.
    const bare = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] }, env(ctx));
    expect(bare.text).toBe(out.text);
  });

  it('an incomplete one asks in today’s words — the labels, «•», nothing per line', async () => {
    const ctx = ctxOf('Rastamojka kerak, kurtka 100 dona');
    const out = await runTool('calc_checklist', { section: 'rastamojka', goods: [{ name: 'kurtka', quantity: 100, unit: null, weight_kg: null }] }, env(ctx));
    expect(out.text).toBe(
      'Yetishmaydi (hammasini BITTA xabarda, "•" bilan ro\'yxat qilib so\'ra — raqamlama; savol belgisi faqat oxirida):\n' +
        `• ${FIELD_LABEL.weightKg}\n• ${FIELD_LABEL.volumeM3}`,
    );
  });
});
