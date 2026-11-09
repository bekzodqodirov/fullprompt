import 'dotenv/config';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

/**
 * THE PIN of docs/IKKI-ESHIK.md §2.2 (DR-1, M11, INT-3): on the plain door
 * «🧮 Hisoblatish» a typed text after the summary is never material merely
 * because it was typed — R3 §0.1(3)'s defect stays closed: a row's «150 kg»
 * must not become the shipment's weight.
 *
 * End to end over the real collector: an invoice and a packing list read by
 * the real file reader (the packing list's gross Σ is the brutto, 3500 kg,
 * §1.2.2), «Bo‘ldi» read by the real reading job (the book's laws and the
 * row coding on the pool), and then «3: 150 kg» and «Sumka 80 kg» typed to
 * the summary — the brutto stays 3500, rows 3 and Sumka are written, and the
 * chat hears nothing but a 👍 under each.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { activeIntake, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { routeCollectorText, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';

async function workbook(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const chats: bigint[] = [];
let seq = 0;

function fakeCtx() {
  let next = 7_000;
  const replies: { id: number; text: string }[] = [];
  const reactions: number[] = [];
  return {
    replies,
    reactions,
    async reply(text: string) {
      next += 1;
      replies.push({ id: next, text });
      return { message_id: next };
    },
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async setMessageReaction(_chat: string, id: number) {
        reactions.push(id);
        return true;
      },
    },
  };
}

beforeEach(() => {
  model.analyze.mockReset();
  resetReadingDrive();
});
afterEach(async () => {
  await tableEditsSettled();
  await keptLastSettled();
  for (const id of chats.splice(0)) endIntake(id);
});

describe('the plain door writes a typed figure quietly — never as material (§2.2 pin)', () => {
  it('a packing list’s brutto 3500, then «3: 150 kg» and «Sumka 80 kg»: 3500 stays, both rows written, no reply', async () => {
    seq += 1;
    const chatId = BigInt(-9_650_000_000) - BigInt(seq);
    chats.push(chatId);
    startIntake(chatId, 'rastamojka', { staffId: 'staff-test', ai: false });
    updateIntake(chatId, { stage: 'material', clientHintRaw: 'GS777' });

    const invoice = await workbook([
      ['Description', 'Qty', 'Unit price', 'Amount'],
      ['Kurtka', 300, 5, 1500],
      ['Sumka', 100, 3, 300],
      ['Shim', 200, 4, 800],
    ]);
    const packing = await workbook([
      ['Description', 'Qty', 'Cartons', 'G.W. (kg)'],
      ['Kurtka', 300, 10, 1500],
      ['Sumka', 100, 5, 1000],
      ['Shim', 200, 8, 1000],
    ]);
    for (const [body, name] of [[invoice, 'A.xlsx'], [packing, 'packing.xlsx']] as const) {
      const live = activeIntake(chatId)!;
      const read = await readIntakeFile({ isPhoto: false, body, attachmentId: `att-${name}` }, name, XLSX, live);
      updateIntake(chatId, { ...read.patch, fileCount: live.fileCount + 1 });
    }
    expect(activeIntake(chatId)!.fileTotals).toMatchObject({ weightKg: 3500 });

    // «Bo‘ldi» — the reading job; the model reads nothing new.
    model.analyze.mockResolvedValue({
      ok: true,
      facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [] },
      steps: [],
      usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
      answered: [{ model: 'm', inputTokens: 1, outputTokens: 1 }],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    const read = activeIntake(chatId)!;
    expect(read.stage).toBe('review');
    expect(read.facts.weightKg).toBe(3500);
    expect(read.facts.goods?.map((g) => g.name)).toEqual(['Kurtka', 'Sumka', 'Shim']);
    expect(ctx.replies.at(-1)!.text.split('\n')[0]).toBe('🧮 Hisoblatish · 🛃 Rastamojka');

    const before = ctx.replies.length;
    let id = 50_000;
    for (const text of ['3: 150 kg', 'Sumka 80 kg']) {
      id += 1;
      updateIntake(chatId, { takenUpTo: id }, { quiet: true });
      await routeCollectorText(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: id, forwarded: false, replyTo: null });
      await tableEditsSettled();
      await keptLastSettled();
    }
    const after = activeIntake(chatId)!;
    // The shipment's brutto is the packing list's, untouched by a row's kilos.
    expect(after.facts.weightKg).toBe(3500);
    expect(after.facts.goods?.[2]).toMatchObject({ name: 'Shim', weightKg: 150 });
    expect(after.facts.goods?.[1]).toMatchObject({ name: 'Sumka', weightKg: 80 });
    expect(after.lineAnswers.map((e) => [e.name, e.patch])).toEqual([
      ['Shim', { weightKg: 150 }],
      ['Sumka', { weightKg: 80 }],
    ]);
    expect(after.stage).toBe('review');
    // Nothing became material, and the chat was told nothing — a 👍 under each.
    expect(after.material).toEqual([]);
    expect(ctx.replies.length).toBe(before);
    expect(ctx.reactions).toEqual([50_001, 50_002]);
  });
});
