import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reading's own edges (the round-1 review of docs/SAKKIZ-BAND.md, a17 and
 * a19), against a local stand-in for the Messages API — the SDK itself makes
 * the calls, so what is measured is what the bot would wait for and what the
 * model would be shown. The reader's character budget is made small, so a
 * table can be cut with a few dozen lines.
 */
vi.mock('@/modules/wms/deals/goods-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/deals/goods-file')>()),
  SHEET_TEXT_BUDGET: 400,
}));

import {
  analyzeIntake,
  fitSheetTexts,
  INTAKE_RETRY_PAUSE_MS,
  knownGoodsText,
  retryAfterPause,
  sheetsPromptText,
} from '@/modules/wms/calc/intake-ai';

type Scripted = { status: number; delayMs: number };
const script: Scripted[] = [];
const bodies: { messages: { content: { type: string; text?: string }[] }[] }[] = [];
let server: http.Server;
const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const next = script.shift() ?? { status: 400, delayMs: 0 };
      setTimeout(() => {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: next.status === 529 ? 'overloaded_error' : 'invalid_request_error', message: 'stand-in' } }));
      }, next.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  script.length = 0;
  bodies.length = 0;
});

const promptText = () =>
  bodies[0]!.messages[0]!.content.find((b) => b.type === 'text')!.text!;

describe('a spreadsheet is cut on a ROW, and the cut is said (review a17)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1} | Куртка женская модель YW-${i}`);

  it('whole lines only, with the count of what was kept', () => {
    const lines = rows(30);
    const out = fitSheetTexts([lines.join('\n')], 200);
    expect(out.total).toEqual([30]);
    expect(out.kept[0]).toBeGreaterThan(0);
    expect(out.kept[0]).toBeLessThan(30);
    // Every kept line is one of the table's lines, whole.
    expect(out.text.split('\n')).toEqual(lines.slice(0, out.kept[0]));
    expect(out.text.length).toBeLessThanOrEqual(200);
  });

  it('a later file gets nothing once an earlier one has filled the cap — counted, not silent', () => {
    const out = fitSheetTexts([rows(30).join('\n'), rows(3).join('\n')], 200);
    expect(out.kept[1]).toBe(0);
    expect(out.total[1]).toBe(3);
  });

  it('what fits is passed through unchanged', () => {
    const a = rows(2).join('\n');
    const b = rows(1).join('\n');
    expect(fitSheetTexts([a, b], 10_000)).toEqual({ text: `${a}\n\n${b}`, kept: [2, 1], total: [2, 1], parts: [a, b] });
  });

  it('the model is shown whole rows and TOLD the table stops', async () => {
    script.push({ status: 400, delayMs: 0 });
    const sheet = rows(40).join('\n');
    const out = await analyzeIntake({
      section: 'rastamojka',
      text: '',
      fileCount: 1,
      sheets: [{ text: sheet, cut: false, cellsCut: false }],
      timeoutMs: 10_000,
    });
    expect(out).toEqual({ ok: false, failure: 'rejected' });
    const text = promptText();
    expect(text).toMatch(/Таблица обрезана: показаны первые \d+ из 40 строк/);
    const table = text.slice(text.indexOf('(текстом):\n') + '(текстом):\n'.length, text.indexOf('\n[Таблица обрезана'));
    expect(table.split('\n').every((l) => rows(40).includes(l))).toBe(true);
  });

});

describe('the Excel’s line names reach the model when the seller said «another factory» (review c4)', () => {
  it('listed, so its lines are not repeated', async () => {
    script.push({ status: 400, delayMs: 0 });
    await analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 1, knownGoods: ['Kurtka', 'Shim'], timeoutMs: 10_000 });
    expect(promptText()).toContain('НЕ повторяй их в goods');
    expect(promptText()).toContain('- Shim');
  });
});

describe('what the model is told of each spreadsheet (round-2 review, C1/C2)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1} | Куртка женская модель YW-${i}`).join('\n');

  it('a text the READER cut is said to be cut, though what is left fits whole', () => {
    const cut = sheetsPromptText([{ text: rows(5), cut: true, cellsCut: false }], [], 10_000);
    expect(cut).toContain(`${rows(5)}\n[Таблица обрезана: показаны первые 5 строк, файл длиннее.`);
    expect(sheetsPromptText([{ text: rows(5), cut: false, cellsCut: false }], [], 10_000)).not.toContain('обрезана');
  });

  it('a workbook’s other sheets stand under their own heading, for the totals — never in the goods block', () => {
    const text = sheetsPromptText(
      [{ text: '[S]\nA | 1', cut: false, cellsCut: false }],
      [{ text: '[Packing list]\nLadies jacket | 300 | 150', cut: false, cellsCut: false }],
      10_000,
    );
    const goods = text.slice(0, text.indexOf('Другие листы книги'));
    expect(goods).toContain('Таблица Excel (текстом):\n[S]\nA | 1');
    expect(goods).not.toContain('Packing list');
    expect(text).toContain('только для итогов');
    expect(text).toContain('Товары отсюда НЕ перечисляй в goods:\n[Packing list]\nLadies jacket | 300 | 150');
    expect(sheetsPromptText([], [{ text: 'x | 1', cut: false, cellsCut: false }], 10_000)).not.toContain('Таблица Excel');
  });

  it('one budget over both, and a sheet that does not fit at all is SAID', () => {
    const text = sheetsPromptText([{ text: rows(40), cut: false, cellsCut: false }], [{ text: '[Packing list]\nTOTAL | 9', cut: false, cellsCut: false }], 300);
    expect(text).toMatch(/Таблица обрезана: показаны первые \d+ из 40 строк/);
    expect(text).toContain('[Ещё одна таблица не поместилась');
    expect(text).not.toContain('TOTAL | 9');
  });

  it('the Excel’s names within a character budget, and how many more there are', () => {
    const names = Array.from({ length: 150 }, (_, i) => `Tovar ${i + 1}`);
    const text = knownGoodsText(names, 200);
    const shown = text.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(150);
    expect(text).toContain(`…и ещё ${150 - shown} строк этой таблицы — их тоже не повторяй.`);
    expect(knownGoodsText(['Kurtka'], 200)).not.toContain('и ещё');
  });

  it('the wire: analyzeIntake shows the reader’s cut and the totals-only heading', async () => {
    script.push({ status: 400, delayMs: 0 });
    await analyzeIntake({
      section: 'rastamojka',
      text: 'Kurtka',
      fileCount: 2,
      sheets: [{ text: 'A | 1', cut: true, cellsCut: false }],
      contextSheets: [{ text: '[Packing list]\nB | 2', cut: false, cellsCut: false }],
      timeoutMs: 10_000,
    });
    expect(promptText()).toContain('A | 1\n[Таблица обрезана: показаны первые 1 строк, файл длиннее.');
    expect(promptText()).toContain('Товары отсюда НЕ перечисляй в goods:\n[Packing list]\nB | 2');
  });
});

describe('no pause after the last attempt, and none past the leash (review a19)', () => {
  it('the rule, decided before pausing', () => {
    expect(retryAfterPause('overloaded', 0, 0, 20_000)).toBe(true);
    // The last attempt: nothing follows it, so nothing to wait for.
    expect(retryAfterPause('overloaded', 1, 0, 20_000)).toBe(false);
    // Half the leash would not be left once the pause is over.
    expect(retryAfterPause('rate_limited', 0, 20_000 / 2 - INTAKE_RETRY_PAUSE_MS + 1, 20_000)).toBe(false);
    // A failure where the call ran is never retried.
    expect(retryAfterPause('timeout', 0, 0, 20_000)).toBe(false);
    expect(retryAfterPause('truncated', 0, 0, 20_000)).toBe(false);
  });

  it('two instant 529s answer after ONE pause, not two', async () => {
    script.push({ status: 529, delayMs: 0 }, { status: 529, delayMs: 0 });
    const started = Date.now();
    const out = await analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 0, timeoutMs: 20_000 });
    const took = Date.now() - started;
    expect(out).toEqual({ ok: false, failure: 'overloaded' });
    expect(bodies).toHaveLength(2);
    expect(took).toBeLessThan(2 * INTAKE_RETRY_PAUSE_MS - 500);
  });

  it('a failure late in the leash answers at once — never past the leash', async () => {
    script.push({ status: 529, delayMs: 1_600 }, { status: 529, delayMs: 0 });
    const started = Date.now();
    const out = await analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 0, timeoutMs: 3_000 });
    const took = Date.now() - started;
    expect(out).toEqual({ ok: false, failure: 'overloaded' });
    expect(bodies).toHaveLength(1);
    expect(took).toBeLessThan(3_000);
  });
});
