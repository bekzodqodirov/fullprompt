import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/AI-SORAYDI.md §3.1 T4 at the two places a typed figure reaches money:
 * the reading (`analyzeCollected`), where the TYPED total outranks the
 * model's (`totalWeightFrom`), and the table, where an answer is written onto
 * a row or a total. DIM-4: «…har biri 15 kg» beside «20 karobka» landed 15
 * kg as the shipment's weight over the model's correct 300, and the one-row
 * job copied it onto the row (`loneWeightKg`). The model is a script; nothing
 * reaches Telegram.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
  aiCalcAvailable: async () => true,
}));
vi.mock('@/modules/platform/ai/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => true,
}));
vi.mock('@/modules/platform/telegram/send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/send')>()),
  sendTyping: async () => ({ ok: true }),
  editText: async () => ({ ok: true }),
}));

import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { applyTableAnswer, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { itemFacts, type CalcFacts } from '@/modules/wms/calc/intake';

type Goods = NonNullable<CalcFacts['goods']>;

let seq = 0;
const chats: bigint[] = [];

/** A collection holding one typed message, ready to be read. */
function typed(text: string, section: IntakeState['section'] = 'podklyuch'): IntakeState {
  seq += 1;
  const chatId = BigInt(-9_710_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { ai: true, staffId: 'staff-test' });
  return updateIntake(chatId, { stage: 'material', clientHintRaw: 'GS777', material: [text], fileCount: 0 })!;
}

const reads = (facts: Partial<CalcFacts>, goods: Goods) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, ...facts, goods },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

const DIM4 = 'Kurtka 300 dona, 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg';

beforeEach(() => model.analyze.mockReset());
afterEach(async () => {
  await tableEditsSettled();
  await keptLastSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('T4 at the reading — one carton’s weight no longer outranks the model’s total', () => {
  it('DIM-4: the model read 300 kg; the shipment’s weight is the model’s 300, not the caption’s 15', async () => {
    model.analyze.mockResolvedValueOnce(reads({ weightKg: 300 }, [{ name: 'Куртка', quantity: 300, weightKg: 300 }]));
    const out = await analyzeCollected(typed(DIM4));
    expect(out.facts.weightKg).toBe(300);
    expect(out.facts.goods).toMatchObject([{ name: 'Куртка', weightKg: 300 }]);
  });

  it('the model silent: no 15 kg anywhere — the each beside both counts is asked, the cube 20 × 0.12 = 2.4 m³ computed', async () => {
    // RE-ANCHORED (review typed-spec-1, ruling JN-7): DIM-4's «har biri 15 kg»
    // stands beside a piece count AND a carton count with no noun — nobody's;
    // the row's weight was 20 × 15 = 300 kg by JS-1's unadopted proposal.
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'network' });
    const out = await analyzeCollected(typed(DIM4));
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.facts.goods).toMatchObject([{ name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: 2.4 }]);
    // No row weight and no total: nothing to copy (the lone-weight rule saw 15 kg here before T4).
    const [item] = itemFacts(out.facts);
    expect(item).toMatchObject({ weightKg: null, weightFromTotal: false });
  });

  it('JS-1: one PIECE’s weight — the row is 300 × 0.2 = 60 kg, never 0.2 kg as the job’s', async () => {
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'network' });
    const out = await analyzeCollected(typed('Telefon 300 dona, har biri 0.2 kg', 'rastamojka'));
    expect(out.facts.weightKg ?? null).toBeNull();
    expect(out.facts.goods).toMatchObject([{ name: 'Telefon', quantity: 300, weightKg: 60 }]);
  });
});

/** A collection at its table, one row open — the AI door. */
function atTable(goods: Goods, weightKg: number | null = null): bigint {
  seq += 1;
  const chatId = BigInt(-9_720_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'podklyuch', { staffId: 'staff-test' });
  updateIntake(chatId, {
    stage: 'review',
    ai: true,
    material: ['x'],
    facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg, volumeM3: null, goods },
  });
  return chatId;
}

function fakeCtx() {
  const replies: string[] = [];
  return {
    replies,
    async reply(text: string) {
      replies.push(text);
      return { message_id: 100 + replies.length };
    },
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
}

async function answer(chatId: bigint, text: string) {
  const ctx = fakeCtx();
  await applyTableAnswer(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: 77, forwarded: false, replyTo: null });
  await tableEditsSettled();
  const live = activeIntake(chatId)!;
  return { replies: ctx.replies, kg: live.facts.weightKg ?? null, goods: live.facts.goods ?? [] };
}

describe('T4 at the table — an answer holding one package’s figure writes it nowhere, and says why', () => {
  it('«jami 15 kg/ctn» writes no brutto, and names the figure as one carton’s — with a WHOLE shipment’s example', async () => {
    const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: 150 }]), 'jami 15 kg/ctn');
    expect(out.kg).toBeNull();
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toContain(
      '⚠️ «15 kg/ctn» — bittasiniki, umumiy emas: umumiyini yozing, masalan «jami 3500 kg» yoki «jami 12 kub».',
    );
  });

  it('«jami 507 kg, har biri 15 kg»: the brutto is written, the carton’s figure named beside it', async () => {
    const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: 150 }]), 'jami 507 kg, har biri 15 kg');
    expect(out.kg).toBe(507);
    expect(out.replies.join('\n')).toContain('⚠️ «har biri 15 kg» — bittasiniki, umumiy emas');
  });

  it('review typed-spec-3: «1: 15 kg/ctn» is asked as one carton’s at its row — never «kg/ctn» as a new product', async () => {
    for (const text of ['1: 15 kg/ctn', '1: har biri 15 kg']) {
      const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: null }]), text);
      expect(out.goods[0], text).toMatchObject({ weightKg: null });
      const said = out.replies.join('\n');
      const figure = text.slice(3);
      expect(said, text).toContain(`⚠️ 1-qator: «${figure}» — bittasiniki, qatorning jamisi emas.`);
      expect(said, text).not.toContain('yangi');
    }
    // Un-addressed: the totals' own sentence, never «jadvalda bunday qator yo‘q».
    const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: 150 }]), '15 kg/ctn');
    expect(out.kg).toBeNull();
    expect(out.replies.join('\n')).toContain('⚠️ «15 kg/ctn» — bittasiniki, umumiy emas');
    expect(out.replies.join('\n')).not.toContain('bunday qator');
  });

  it('review typed-spec-7: «G.W. 1136.5 kg CBM 7.19» — the brutto written, the cube asked as the unit he wrote', async () => {
    const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: 150 }]), 'G.W. 1136.5 kg CBM 7.19');
    expect(out.kg).toBe(1136.5);
    expect(out.replies.join('\n')).toContain('«CBM» — kubmi? «jami 7.19 kub» deb yozing.');
    expect(out.replies.join('\n')).not.toContain('birligi yozilmagan');
  });

  it('a row answer «1: 20 x 15 kg» leaves the row’s weight as it was, and asks for the row’s whole figure', async () => {
    const out = await answer(atTable([{ name: 'Kurtka', quantity: 300, weightKg: null }]), '1: 20 x 15 kg');
    expect(out.goods[0]).toMatchObject({ weightKg: null });
    expect(out.replies.join('\n')).toContain(
      '⚠️ 1-qator: «20 x 15 kg» — bittasiniki, qatorning jamisi emas. Qatorning jamisini yozing: masalan «300 dona» yoki «150 kg».',
    );
  });
});
