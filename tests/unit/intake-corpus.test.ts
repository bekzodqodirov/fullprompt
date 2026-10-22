import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_FAILING } from './fixtures/intake-corpus-known';

/**
 * The intake regression corpus (tests/unit/fixtures/intake-corpus.ts), run
 * case by case against the CURRENT code: the typed reader, the customer
 * question, the spreadsheet door and the collector, as the review rounds of
 * docs/SAKKIZ-BAND.md wrote them down. A case is named by its id and the
 * round that wrote it; its expectation is the reviewer's sentence read
 * exactly (`said` beside it in the fixture). The model is a script here and
 * nothing reaches Telegram: what is under test is what the code does with
 * both.
 *
 * Conflicts (two rounds, one input, two answers) are settled in the fixture —
 * each such case carries `pick`: the round-3 binding decisions first
 * (review3.md, R3-*), else the latest round. Three picks are NOT the latest
 * round: c0996 (R3-T5: a plain number row is never a code), c1237 (R3-S8:
 * «Net total» is the money, the weight is null) and c1677 (R3-C4: a hint of
 * nothing but the contact falls back to the collapsed text).
 *
 * A case the fixture marks `vague` carries a bound the reviewer stated
 * loosely («well under a second») — the bound used is the case's own
 * `expected`, and the case says which.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));
const prefill = vi.hoisted(() => ({ standing: vi.fn(), run: vi.fn() }));
vi.mock('@/modules/wms/calc/prefill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill')>()),
  prefillStanding: prefill.standing,
  aiPrefill: prefill.run,
}));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/modules/platform/notifications/staff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/notifications/staff')>()),
  notifyStaffTelegram: notify,
}));

import {
  AI_READ_FAILURE,
  landingItems,
  lineNeeds,
  missingFields,
  parseClientHint,
  statesGoods,
} from '@/modules/wms/calc/intake';
import { looksLikeMaterial, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import {
  fitSheetRows,
  fitSheetTexts,
  KNOWN_GOODS_CHARS,
  knownGoodsText,
  readIntakeResponse,
  sheetsPromptText,
  type IntakeSheetText,
} from '@/modules/wms/calc/intake-ai';
import { parseGoodsLine } from '@/modules/wms/calc/units';
import { pasteItems } from '@/modules/wms/calc/send-rows';
import { threadAiAdvice } from '@/modules/wms/calc/from-thread';
import { PASS_FAILED, STOOD_DOWN, attemptStanding, registerCalcPrefillWorker } from '@/modules/wms/calc/jobs';
import { SHEET_TEXT_BUDGET, csvRows, readGoodsFile, workbookRows } from '@/modules/wms/deals/goods-file';
import { isArticleNumber, parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import { MAX_ROWS, MAX_SHEETS, htmlTableSheets, readXls, spreadsheetMlSheets } from '@/modules/wms/deals/xls';
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  intakeClientLabel,
  intakeClientSummary,
  pickGoods,
  resolveLineDone,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import {
  clientAnswer,
  handleCalcCallback,
  invoiceChoice,
  otherFilesChoice,
  readCustomerText,
  readIntakeFile,
  receiveGoodsSheet,
  receivePdf,
  receiveSheetText,
  settleAnalysis,
} from '@/modules/platform/telegram/staff-handlers';
import {
  attemptStandingCases,
  buildFile,
  clientStageCases,
  intakeClientLabelCases,
  intakeClientSummaryCases,
  isArticleNumberCases,
  looksLikeMaterialCases,
  parseClientHintCases,
  parseGoodsCases,
  parseGoodsLineCases,
  parseManualFactsCases,
  pickGoodsCases,
  readGoodsFileCases,
  readGoodsLinesCases,
  resolveLineDoneCases,
  scenarioCases,
  sourceRows,
  statesGoodsCases,
  threadAiAdviceCases,
  xlsSameSheet,
  type FileExpect,
  type FileSpec,
  type GoodsExpect,
  type HintExpect,
  type ScenarioCase,
  type SheetSpec,
} from './fixtures/intake-corpus';

type Line = Record<string, unknown>;
type Goods = NonNullable<IntakeState['invoiceGoods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

/** A line's name, whichever reader made it (a sheet row's `description`). */
const nameOf = (row: Line) => (row.name ?? row.description ?? null) as string | null;
/** A missing field is no value: `{quantity: null}` is met by a line without one. */
const fieldOf = (row: Line, key: string) => (key === 'name' ? nameOf(row) : (row[key] ?? null));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Does a partial line match a real one, by the same field rule? */
const matches = (row: Line, want: Line) => Object.entries(want).every(([k, v]) => same(fieldOf(row, k), v));

/** Every way a goods list misses its expectation, in words — empty = it holds. */
function goodsProblems(actual: readonly Line[], want: GoodsExpect): string[] {
  const out: string[] = [];
  const names = actual.map(nameOf);
  const shown = JSON.stringify(names.length > 12 ? [...names.slice(0, 12), `… +${names.length - 12}`] : names);
  if (want.count !== undefined && actual.length !== want.count) out.push(`${actual.length} lines, want ${want.count}: ${shown}`);
  if (want.minCount !== undefined && actual.length < want.minCount) out.push(`${actual.length} lines, want ≥ ${want.minCount}: ${shown}`);
  if (want.maxCount !== undefined && actual.length > want.maxCount) out.push(`${actual.length} lines, want ≤ ${want.maxCount}`);
  (want.rows ?? []).forEach((row, i) => {
    const got = actual[i];
    if (!got) {
      out.push(`line ${i} missing: ${shown}`);
      return;
    }
    for (const [key, value] of Object.entries(row)) {
      if (!same(fieldOf(got, key), value)) out.push(`line ${i}.${key} = ${JSON.stringify(fieldOf(got, key))}, want ${JSON.stringify(value)}`);
    }
  });
  if (want.every) {
    const bad = actual.findIndex((row) => !matches(row, want.every!));
    if (bad >= 0) out.push(`line ${bad} ${JSON.stringify(actual[bad])} is not ${JSON.stringify(want.every)}`);
  }
  for (const name of want.absent ?? []) if (names.includes(name)) out.push(`a line is named «${name}»: ${shown}`);
  for (const prefix of want.absentPrefix ?? []) {
    if (names.some((n) => n?.startsWith(prefix))) out.push(`a line starts «${prefix}»: ${shown}`);
  }
  for (const name of want.includes ?? []) if (!names.includes(name)) out.push(`no line «${name}»: ${shown}`);
  return out;
}

function expectHint(actual: { code?: string; phone?: string } | null, want: HintExpect): void {
  const shown = JSON.stringify(actual);
  if (want.null) expect(actual, shown).toBeNull();
  if (want.equal) expect(actual, shown).toEqual(want.equal);
  if (want.code === null) expect(actual?.code, shown).toBeUndefined();
  if (want.phone === null) expect(actual?.phone, shown).toBeUndefined();
  if (want.hasPhone) expect(actual?.phone, shown).toBeTruthy();
  const digits = (actual?.phone ?? '').replace(/\D/g, '');
  if (want.phoneDigitsEnd) {
    expect(actual?.phone, shown).toBeTruthy();
    expect(digits.endsWith(want.phoneDigitsEnd), `${shown} ends ${want.phoneDigitsEnd}`).toBe(true);
  }
  if (want.phoneDigits) expect(digits, shown).toBe(want.phoneDigits);
}

const title = '$id · $source';

/**
 * `it.each`, with the cases still known to fail run as `it.fails` (see
 * fixtures/intake-corpus-known.ts): a case that starts passing, or one that
 * starts failing, turns this file red.
 */
function each<C extends { id: string }>(cases: readonly C[]) {
  const live = cases.filter((c) => !KNOWN_FAILING.has(c.id));
  const known = cases.filter((c) => KNOWN_FAILING.has(c.id));
  return (name: string, fn: (c: C) => void | Promise<void>, timeout?: number) => {
    if (live.length > 0) it.each(live)(name, fn, timeout);
    if (known.length > 0) it.fails.each(known)(`${name} (known to fail)`, fn, timeout);
  };
}

// ---------------------------------------------------------------------------
// The collection the collector cases run on, and a Telegram that records.
// ---------------------------------------------------------------------------

let seq = 0;
const chats: bigint[] = [];
function collection(
  patch: Partial<IntakeState> = {},
  section: IntakeState['section'] = 'rastamojka',
): { chatId: bigint; state: IntakeState } {
  seq += 1;
  const chatId = BigInt(-9_500_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section);
  return { chatId, state: updateIntake(chatId, patch)! };
}

type Reply = { text: string; extra?: Record<string, unknown> };
function fakeCtx(refuse: (text: string) => boolean = () => false) {
  const replies: Reply[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      if (refuse(text)) throw Object.assign(new Error('Call to sendMessage failed! (429: Too Many Requests: retry after 30)'), { error_code: 429 });
      replies.push({ text, extra });
      return { message_id: replies.length };
    },
    api: {
      async editMessageText(): Promise<never> {
        throw new Error('message to edit not found');
      },
    },
  };
}
const buttonsOf = (reply: { extra?: Record<string, unknown> } | { keyboard?: unknown } | undefined) =>
  JSON.stringify(reply && 'extra' in reply ? (reply.extra?.reply_markup ?? null) : ((reply as { keyboard?: unknown })?.keyboard ?? null));

const reads = (goods: Goods, steps: string[] = []) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps,
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => {
  model.analyze.mockReset();
  prefill.standing.mockReset();
  prefill.run.mockReset();
  notify.mockReset();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

// ---------------------------------------------------------------------------
// The typed reader and the customer hint
// ---------------------------------------------------------------------------

describe('parseClientHint', () => {
  each(parseClientHintCases)(title, (c) => {
    expectHint(parseClientHint(c.input, c.opts ?? {}), c.expected);
  });
});

describe('looksLikeMaterial', () => {
  each(looksLikeMaterialCases)(title, (c) => {
    expect(looksLikeMaterial(c.input, c.opts ?? {})).toBe(c.expected);
  });
});

describe('readGoodsLines', () => {
  each(readGoodsLinesCases)(title, (c) => {
    expect(goodsProblems(readGoodsLines(c.input, c.opts ?? {}) as unknown as Line[], c.expected)).toEqual([]);
  });
});

describe('parseGoods', () => {
  each(parseGoodsCases)(title, (c) => {
    const rows = Array.isArray(c.input) ? c.input : csvRows(c.input.csv);
    const parsed = parseGoods(rows);
    if (c.expected.goods) expect(goodsProblems(parsed.goods as unknown as Line[], c.expected.goods)).toEqual([]);
    if (c.expected.headerRow !== undefined) expect(parsed.headerRow, 'headerRow').toBe(c.expected.headerRow);
  });
});

describe('parseGoodsLine', () => {
  each(parseGoodsLineCases)(title, (c) => {
    const read = parseGoodsLine(c.input);
    const e = c.expected;
    const shown = JSON.stringify(read);
    for (const key of ['name', 'tnvedCode', 'quantity', 'weightKg', 'volumeM3', 'unitWords'] as const) {
      if (e[key] !== undefined) expect(read[key], `${key} of ${shown}`).toEqual(e[key]);
    }
    if (e.problems) {
      const kinds = read.problems.map((p) => p.kind);
      for (const kind of new Set(e.problems)) {
        expect(kinds.filter((k) => k === kind).length, shown).toBeGreaterThanOrEqual(e.problems.filter((k) => k === kind).length);
      }
    }
    if (e.problemTexts) {
      const texts = read.problems.map((p) => ('text' in p ? p.text : null));
      for (const text of e.problemTexts) expect(texts, shown).toContain(text);
    }
    for (const part of e.nameExcludes ?? []) expect(read.name, shown).not.toContain(part);
    if (e.quantityNot !== undefined) expect(read.quantity, shown).not.toBe(e.quantityNot);
  });
});

describe('parseManualFacts → landingItems / missingFields / lineNeeds', () => {
  each(parseManualFactsCases)(title, (c) => {
    const facts = parseManualFacts(c.input);
    const e = c.expected;
    if (e.goods) expect(goodsProblems((facts.goods ?? []) as unknown as Line[], e.goods)).toEqual([]);
    for (const key of ['weightKg', 'volumeM3', 'fromCity', 'toCity'] as const) {
      if (e[key] !== undefined) expect(facts[key], key).toEqual(e[key]);
    }
    const landing = landingItems(facts);
    if (e.landing) expect(goodsProblems(landing as unknown as Line[], e.landing)).toEqual([]);
    for (const note of e.landingNoteIncludes ?? []) expect(landing[note.index]?.note ?? '').toContain(note.text);
    if (e.missing) {
      const missing = missingFields(e.missing.section, facts, new Map());
      if (e.missing.equal) expect(missing).toEqual(e.missing.equal);
      for (const f of e.missing.includes ?? []) expect(missing).toContain(f);
      for (const f of e.missing.excludes ?? []) expect(missing).not.toContain(f);
    }
    if (e.noNeedsFor) {
      const asked = lineNeeds('rastamojka', facts, new Map()).map((n) => n.name);
      for (const name of e.noNeedsFor) expect(asked, 'lineNeeds names').not.toContain(name);
    }
  });
});

describe('intakeClientLabel (the lead’s name)', () => {
  each(intakeClientLabelCases)(title, (c) => {
    expect(intakeClientLabel(c.input.raw, c.input.hint)).toBe(c.expected);
  });
});

describe('intakeClientSummary (the summary’s customer line)', () => {
  each(intakeClientSummaryCases)(title, (c) => {
    expect(intakeClientSummary(c.input)).toBe(c.expected);
  });
});

describe('resolveLineDone', () => {
  each(resolveLineDoneCases)(title, (c) => {
    expect(resolveLineDone(c.input.goods, c.input.done)).toEqual(c.expected);
  });
});

describe('pickGoods', () => {
  each(pickGoodsCases)(title, (c) => {
    const picked = pickGoods(c.input as unknown as Parameters<typeof pickGoods>[0]);
    const e = c.expected;
    if (e.goods) expect(goodsProblems(picked.goods as unknown as Line[], e.goods)).toEqual([]);
    if (e.sameAsInvoice) expect(picked.sameAsInvoice.map((g) => g.name), 'sameAsInvoice').toEqual(e.sameAsInvoice);
    for (const want of e.sameAsInvoiceHas ?? []) {
      expect(
        picked.sameAsInvoice.some((g) => matches(g as unknown as Line, want)),
        `sameAsInvoice has ${JSON.stringify(want)}: ${JSON.stringify(picked.sameAsInvoice)}`,
      ).toBe(true);
    }
    for (const want of e.somewhere ?? []) {
      expect(
        [...picked.goods, ...picked.sameAsInvoice].some((g) => matches(g as unknown as Line, want)),
        `${JSON.stringify(want)} kept or named: ${JSON.stringify(picked)}`,
      ).toBe(true);
    }
  });
});

describe('isArticleNumber', () => {
  each(isArticleNumberCases)(title, (c) => {
    expect(isArticleNumber(c.input)).toBe(c.expected);
  });
});

describe('statesGoods', () => {
  each(statesGoodsCases)(title, (c) => {
    expect(statesGoods(c.input)).toBe(c.expected);
  });
});

describe('threadAiAdvice', () => {
  each(threadAiAdviceCases)(title, (c) => {
    expect(threadAiAdvice(c.input as Parameters<typeof threadAiAdvice>[0])).toBe(c.expected);
  });
});

describe('attemptStanding', () => {
  each(attemptStandingCases)(title, (c) => {
    expect(attemptStanding(c.input[0] as Parameters<typeof attemptStanding>[0], c.input[1])).toBe(c.expected);
  });
});

describe('the customer question (clientAnswer)', () => {
  each(clientStageCases)(title, async (c) => {
    const { text, prefix, sends } = c.input;
    const e = c.expected;
    const { chatId } = collection({
      stage: 'client',
      clientAskedWith: c.input.clientAskedWith ?? null,
      material: c.input.material ?? [],
    });
    const read = await readCustomerText(text, prefix);
    if (e.material !== undefined) expect(read.material, 'readCustomerText.material').toBe(e.material);
    if (e.couldBeCustomer !== undefined) expect(read.couldBeCustomer, 'readCustomerText.couldBeCustomer').toBe(e.couldBeCustomer);
    if (e.why !== undefined) expect(read.why, 'readCustomerText.why').toBe(e.why);

    const answers: ReturnType<typeof clientAnswer>[] = [];
    for (let n = 0; n < sends; n += 1) {
      const state = activeIntake(chatId)!;
      if (state.stage !== 'client') break;
      const answer = clientAnswer(state, text, read);
      answers.push(answer);
      updateIntake(chatId, answer.patch);
    }
    const [first, second] = answers;
    const sayOf = (a: (typeof answers)[number] | undefined) => (a && a.kind === 'material' ? a.say : '');
    if (e.first) expect(first?.kind, 'first send').toBe(e.first);
    if (e.second) expect(second?.kind, 'second send').toBe(e.second);
    if (e.eventuallyCustomer) expect(answers.map((a) => a.kind)).toContain('customer');
    for (const s of e.firstSayIncludes ?? []) expect(sayOf(first)).toContain(s);
    for (const s of e.firstSayExcludes ?? []) expect(sayOf(first)).not.toContain(s);
    for (const s of e.secondSayIncludes ?? []) expect(sayOf(second)).toContain(s);
    for (const s of e.secondSayExcludes ?? []) expect(sayOf(second)).not.toContain(s);

    const after = activeIntake(chatId)!;
    if (e.clientHintRaw !== undefined) expect(after.clientHintRaw, 'clientHintRaw').toBe(e.clientHintRaw);
    if (e.stage !== undefined) expect(after.stage, 'stage').toBe(e.stage);
    if (e.materialCopies !== undefined) {
      expect(after.material.filter((m) => m.trim() === text.trim()).length, `copies in ${JSON.stringify(after.material)}`).toBe(
        e.materialCopies,
      );
    }
    if (e.hint !== undefined || e.leadName !== undefined) {
      const hint = parseClientHint(after.clientHintRaw, { prefix });
      if (e.hint !== undefined) expect(hint, 'parseClientHint(clientHintRaw)').toEqual(e.hint);
      if (e.leadName !== undefined) expect(intakeClientLabel(after.clientHintRaw, hint), 'the lead name').toBe(e.leadName);
    }
  });
});

// ---------------------------------------------------------------------------
// The spreadsheet door
// ---------------------------------------------------------------------------

/** A source row as the reader writes it in its text (`rowLine` in goods-file.ts): whole cells, « | ». */
function renderRow(row: readonly Cell[]): string {
  let out = '';
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    const flat = String(cell)
      .slice(0, 1200)
      .trim()
      .replace(/\s*[\r\n]+\s*/g, ' / ')
      .replace(/\s+/g, ' ');
    if (!flat) continue;
    const piece = out ? ` | ${flat.slice(0, 300)}` : flat.slice(0, 300);
    if (out.length + piece.length > 2000) break;
    out += piece;
  }
  return out;
}
const isHeading = (l: string) => /^\[[^\]\n]*\]$/.test(l.trim());
const bodyLines = (text: string) => text.split('\n').filter((l) => l.trim() && !isHeading(l));

interface FileRun {
  read: Awaited<ReturnType<typeof readGoodsFile>> | undefined;
  threw: unknown;
  ms: number;
  heapMb: number;
}

async function runFile(spec: FileSpec): Promise<FileRun & { built: Awaited<ReturnType<typeof buildFile>> }> {
  const built = await buildFile(spec);
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  let read: FileRun['read'];
  let threw: unknown = null;
  try {
    read = await readGoodsFile(built.body, built.contentType);
  } catch (err) {
    threw = err;
  }
  const ms = performance.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
  return { built, read, threw, ms, heapMb };
}

async function fileProblems(
  spec: FileSpec,
  want: FileExpect,
  run: Awaited<ReturnType<typeof runFile>>,
): Promise<string[]> {
  const out: string[] = [];
  const { read } = run;
  if (run.threw) return [`threw ${String(run.threw)}`];
  if (want.maxMs !== undefined && run.ms > want.maxMs) out.push(`took ${Math.round(run.ms)} ms, want ≤ ${want.maxMs}`);
  if (want.maxHeapMb !== undefined && run.heapMb > want.maxHeapMb) out.push(`heap grew ${Math.round(run.heapMb)} MB, want < ${want.maxHeapMb}`);
  if (want.null) return read === null ? out : [...out, `want null, got ${read?.kind}`];
  if (want.either) {
    const branches = await Promise.all(want.either.map((b) => fileProblems(spec, b, run)));
    if (!branches.some((b) => b.length === 0)) out.push(`no branch holds: ${branches.map((b) => b.join('; ')).join(' ‖ ')}`);
  }
  const kind = read?.kind;
  if (want.kind && kind !== want.kind) {
    out.push(`kind ${kind}${read?.kind === 'refused' ? ` (${read.reason})` : ''}, want ${want.kind}`);
    return out;
  }
  if (!read) return want.noThrow && !want.kind ? out : [...out, 'read null'];
  if (want.reason !== undefined && (read.kind !== 'refused' || read.reason !== want.reason)) out.push(`reason ${read.kind === 'refused' ? read.reason : '-'}, want ${want.reason}`);
  if (read.kind === 'refused') return out;
  if (want.sheet !== undefined && (read.kind !== 'goods' || read.sheet !== want.sheet)) out.push(`sheet ${read.kind === 'goods' ? read.sheet : '-'}, want ${want.sheet}`);
  if (want.sheets !== undefined && read.sheets !== want.sheets) out.push(`sheets ${read.sheets}, want ${want.sheets}`);
  if (want.textCut !== undefined && read.textCut !== want.textCut) out.push(`textCut ${read.textCut}, want ${want.textCut}`);
  if (want.cellsCut !== undefined && read.cellsCut !== want.cellsCut) out.push(`cellsCut ${read.cellsCut}, want ${want.cellsCut}`);
  if (want.goods) {
    if (read.kind !== 'goods') out.push('no goods');
    else out.push(...goodsProblems(read.goods as unknown as Line[], want.goods));
  }
  const text = read.text;
  if (want.text !== undefined && text !== want.text) out.push(`text ${JSON.stringify(text.slice(0, 300))}, want ${JSON.stringify(want.text)}`);
  for (const s of want.textIncludes ?? []) if (!text.includes(s)) out.push(`text lacks ${JSON.stringify(s)}: ${JSON.stringify(text.slice(0, 200))}`);
  for (const s of want.textExcludes ?? []) if (text.includes(s)) out.push(`text has ${JSON.stringify(s)}`);
  if (want.textLineContains !== undefined && !text.split('\n').some((l) => l.includes(want.textLineContains!))) {
    out.push(`no text line contains ${JSON.stringify(want.textLineContains)}: ${JSON.stringify(text.slice(0, 400))}`);
  }
  if (want.textMaxLength !== undefined && text.length > want.textMaxLength) out.push(`text ${text.length} chars, want ≤ ${want.textMaxLength}`);
  if (want.textMinLength !== undefined && text.length < want.textMinLength) out.push(`text ${text.length} chars, want ≥ ${want.textMinLength}`);
  if (want.cellMaxLength !== undefined) {
    const long = bodyLines(text).flatMap((l) => l.split(' | ')).find((cell) => cell.length > want.cellMaxLength!);
    if (long) out.push(`a cell of ${long.length} chars, want ≤ ${want.cellMaxLength}`);
  }
  if (want.wholeRows) {
    const rows = sourceRows(spec, csvRows);
    const whole = new Set((rows ?? []).map(renderRow).filter(Boolean));
    const broken = bodyLines(text).find((l) => !whole.has(l));
    if (broken !== undefined) out.push(`a line is not a whole row: ${JSON.stringify(broken.slice(0, 200))}`);
  }
  const last = bodyLines(text).at(-1) ?? '';
  if (want.lastLine !== undefined && last !== want.lastLine) out.push(`last line ${JSON.stringify(last)}, want ${JSON.stringify(want.lastLine)}`);
  if (want.lastLineStarts !== undefined && !last.startsWith(want.lastLineStarts)) out.push(`last line ${JSON.stringify(last)} does not start ${want.lastLineStarts}`);
  if (want.lastLineEnds !== undefined && !last.endsWith(want.lastLineEnds)) out.push(`last line ${JSON.stringify(last)} does not end ${want.lastLineEnds}`);
  if (want.replyIncludes || want.replyExcludes) {
    const answer = await readIntakeFile(
      { isPhoto: false, body: run.built.body },
      run.built.fileName,
      run.built.contentType,
      collection({ stage: 'material' }).state,
    );
    const say = answer.say ?? '';
    for (const s of want.replyIncludes ?? []) if (!say.includes(s)) out.push(`reply lacks ${JSON.stringify(s)}: ${JSON.stringify(say)}`);
    for (const s of want.replyExcludes ?? []) if (say.includes(s)) out.push(`reply has ${JSON.stringify(s)}`);
  }
  return out;
}

describe('readGoodsFile', () => {
  each(readGoodsFileCases)(
    title,
    async (c) => {
      const run = await runFile(c.input);
      expect(await fileProblems(c.input, c.expected, run)).toEqual([]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Scenarios: the collector and the readers' edges, as the reviewers drove them
// ---------------------------------------------------------------------------

const BUDGET = SHEET_TEXT_BUDGET;
const fitRows = (texts: readonly string[]) => fitSheetRows(texts, BUDGET);
/** What `intakeContent` shows the model of the spreadsheets and the Excel's names — its own two functions. */
function promptOf(input: { sheets?: readonly IntakeSheetText[]; contextSheets?: readonly IntakeSheetText[]; knownGoods?: readonly string[] }): string {
  const known = (input.knownGoods ?? []).map((n) => n.trim()).filter(Boolean);
  return sheetsPromptText(input.sheets ?? [], input.contextSheets ?? [], BUDGET) + (known.length ? knownGoodsText(known, KNOWN_GOODS_CHARS) : '');
}
const lastCall = () => model.analyze.mock.calls.at(-1)?.[0] as Parameters<typeof promptOf>[0];
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const source = (p: string) => code(readFileSync(p, 'utf8'));

/** A file the seller forwards, read by the bot's own door onto a live collection. */
async function forward(chatId: bigint, spec: FileSpec, fileName?: string) {
  const built = await buildFile(spec);
  const answer = await readIntakeFile({ isPhoto: false, body: built.body }, fileName ?? built.fileName, built.contentType, activeIntake(chatId)!);
  updateIntake(chatId, answer.patch);
  return answer;
}
const mapped = (label: string, goods: Goods, text = '', textCut = false, cellsCut = false) => ({ goods, label, text, textCut, cellsCut, where: '' });
const xlsx = (...sheets: SheetSpec[]): FileSpec => ({ kind: 'xlsx', sheets });
const csv = (text: string): FileSpec => ({ kind: 'csv', text });

/** The «y.ts» invoice of c0215 at `n` lines under a given company (c0216's two factories). */
const factoryInvoice = (n: number, company: string): FileSpec =>
  xlsx({
    name: 'Packing list',
    rows: () => [
      [`${company} TRADING CO., LTD`],
      ['No. 88 Futian Road, Yiwu, Zhejiang, China'],
      ['TEL: +86 579 8555 1234'],
      [],
      ['PACKING LIST'],
      [],
      ['To:', 'GSR LOGISTICS / Tashkent, Uzbekistan'],
      ['Invoice No:', 'YW2026-1021', 'Date:', '2026-10-21'],
      ['From:', 'Yiwu', 'To:', 'Tashkent'],
      ['Shipping marks:', 'GS777'],
      [],
      [],
      ['No.', 'Model', 'Description', 'Material', 'Color', 'Qty (pcs)', 'Unit price USD', 'Amount USD', 'CTN', 'CTN size (cm)', 'N.W.(kg)', 'G.W.(kg)', 'CBM'],
      ...Array.from({ length: n }, (_, k): Cell[] => {
        const i = k + 1;
        return [i, `YW-${2300 + i}`, `Куртка женская утеплённая, модель ${i} (女士羽绒夹克)`, 'polyester 100%', 'black/white', 100 + i, 12.5, (100 + i) * 12.5, 5, '60*40*45', 20 + i / 10, 22 + i / 10, 0.35];
      }),
      ['TOTAL', '', '', '', 999, 999, 9999, 9999, 99],
    ],
  });

const csv300 = () =>
  Array.from({ length: 300 }, (_, k) => {
    const i = k + 1;
    return `${i};Куртка женская модель YW-${i} (女士夹克);${i + 99};${(i * 1.1).toFixed(1)};${(i * 1.3).toFixed(1)};0.${String(i).padStart(3, '0')}`;
  }).join('\n');
const csvLongCell = () =>
  Array.from({ length: 20 }, (_, k) => {
    const i = k + 1;
    return `${i};Куртка женская модель YW-${i} (女士夹克)${i === 3 ? ' 面料 '.repeat(150) : ''};${i + 99};${(i * 1.1).toFixed(1)};${(i * 1.3).toFixed(1)};0.${String(i).padStart(3, '0')}`;
  }).join('\n');
const csvWithTotal = () =>
  Array.from({ length: 20 }, (_, i) => `${i + 1};${i === 3 ? 'Женская куртка, материал 100% полиэстер, утеплитель синтепон, ' + 'x'.repeat(320) : `Куртка модель YW-${i}`};${300 + i};PCS;${i}.5;${i}.9;0.${i}`).join('\n') +
  '\n;TOTAL;;;;1234;5.6';
const consigneeWorkbook = () =>
  xlsx(
    {
      name: 'Invoice',
      rows: [['No', 'Description', 'Qty', 'Unit', 'N.W.', 'G.W.', 'CBM'], ...Array.from({ length: 5 }, (_, i): Cell[] => [i + 1, `Kurtka ${i}`, 100, 'pcs', 50, 55, 0.5])],
    },
    { name: 'Packing list', rows: [['Consignee: ' + 'OOO ASIA TRADE, Tashkent, Chilonzor district, '.repeat(8)], ['TOTAL G.W.', '275 KGS', 'TOTAL CBM', '2.5']] },
  );
const bigPackingWorkbook = () =>
  xlsx(
    { name: 'Invoice', rows: [['Наименование', 'Кол-во', 'Вес, кг'], ...Array.from({ length: 10 }, (_, k): Cell[] => [`Kurtka ${k + 1}`, 10 * (k + 1), 5 * (k + 1)])] },
    {
      name: 'Packing list',
      rows: [
        ['Packing list for order 2026-10'],
        ...Array.from({ length: 400 }, (_, k): Cell[] => {
          const i = k + 1;
          return [`Carton ${i}`, `Gross ${(i * 3.3).toFixed(2)} kg`, `Volume ${(i * 0.01).toFixed(3)} m3`, 'Ladies jacket black polyester'];
        }),
      ],
    },
  );
const ladiesWorkbook = (n: number, packing: 'lines' | 'cut') =>
  xlsx(
    {
      name: 'Invoice',
      rows: [['Description', 'Qty', 'G.W.', 'CBM'], ...Array.from({ length: n }, (_, k): Cell[] => [`Ladies jacket model ${k + 1}`, 10 + k, 5 + k, 0.1])],
    },
    {
      name: 'Packing list',
      rows:
        packing === 'lines'
          ? [['Packing list of Factory A'], ...Array.from({ length: n }, (_, k): Cell[] => [k + 1, `Ladies jacket model ${k + 1}`, `${10 + k} pcs`, `${5 + k} kg`])]
          : [
              ['Packing list of Factory A'],
              ...Array.from({ length: n }, (_, k): Cell[] => [k + 1, `Ladies jacket model ${k + 1}`, `${10 + k} pcs`, `${5 + k} kg`]),
              ['TOTAL G.W.', '', '', '9999 kg'],
            ],
    },
  );

const STALE = 'Bu tugma eskirgan.';
const NOT_READ = 'Yangi ma’lumot hali o‘qilmagan — avval «Bo‘ldi» ni bosing.';
const OTHER_ASK = 'Avval javob bering: AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?';
const CLIENT_Q = 'Mijozni yozing: **kodi** (GS777)';
const OTHER_CUT_SELLER = '⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi (tovarlar ro‘yxati to‘liq olindi).';
const CELLS_NOTE = '[Длинные ячейки сокращены, все строки показаны.]';

/** The Messages API stand-in the retry cases are timed against (the shape of intake-ai-wire.test.ts). */
type Scripted = { status: number; delayMs: number };
async function withStandIn<T>(script: Scripted[], body: (calls: () => number) => Promise<T>): Promise<T> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls += 1;
      const next = script.shift() ?? { status: 400, delayMs: 0 };
      setTimeout(() => {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: next.status === 529 ? 'overloaded_error' : 'invalid_request_error', message: 'stand-in' } }));
      }, next.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await body(() => calls);
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.url;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function realAnalyze(script: Scripted[], timeoutMs: number) {
  const real = await vi.importActual<typeof import('@/modules/wms/calc/intake-ai')>('@/modules/wms/calc/intake-ai');
  return withStandIn(script, async (calls) => {
    const started = Date.now();
    const out = await real.analyzeIntake({ section: 'rastamojka', text: 'Kurtka', fileCount: 0, timeoutMs });
    return { out, ms: Date.now() - started, calls: calls() };
  });
}

/** The prefill worker on a stand-in boss (the shape of calc-prefill-standdown.test.ts). */
async function prefillWorker() {
  const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
  await registerCalcPrefillWorker(boss as never);
  const call = boss.work.mock.calls[0] as unknown[];
  return {
    options: call[1],
    handler: call[2] as (jobs: { id: string; name: string; data: unknown; retryCount: number }[]) => Promise<void>,
  };
}
const prefillJob = (retryCount: number) => ({ id: 'j1', name: 'calc.prefill', data: { requestId: 'r1', staffId: 's1', rev: 3 }, retryCount });

/** Linear: the doubled input costs at most ~3× (quadratic is 4×), with room for a few ms of noise. */
function expectLinear(build: (n: number) => string, read: (text: string) => number, n: number): void {
  const time = (size: number) => {
    const text = build(size);
    const t0 = performance.now();
    const rows = read(text);
    return { ms: performance.now() - t0, rows };
  };
  time(n); // warm
  const one = time(n);
  const two = time(2 * n);
  // The readers stop at MAX_ROWS since round 1 and SAY so (S-r1 ND8); a
  // bigger table is read to the cap, still in linear time (c0068/c0069,
  // lead 2026-10-22: «8000 rows read» was the harvest loop's template).
  expect(one.rows, 'rows read').toBe(Math.min(n, MAX_ROWS));
  expect(two.ms, `${Math.round(one.ms)} ms at ${n}, ${Math.round(two.ms)} ms at ${2 * n}`).toBeLessThan(3 * one.ms + 40);
}
const htmlRows = (n: number) => '<html><body><table>' + '<tr><td>Стол</td><td>5</td>\n'.repeat(n) + '</table></body></html>';
const xmlRows = (n: number) =>
  '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="A"><Table>' +
  '<Row><Cell><Data ss:Type="String">Стол</Data></Cell><Cell><Data ss:Type="Number">5</Data></Cell>\n'.repeat(n) +
  '</Table></Worksheet></Workbook>';

/** The ⏭ / «Yana ma’lumot» / «Bo‘ldi» walk of R3-C5 (c1375, c1721). */
async function skipThenReread(): Promise<{ chatId: bigint; asked: string[] }> {
  const { chatId } = collection({
    stage: 'question',
    askingIndex: 0,
    round: 1,
    clientHintRaw: 'GS777',
    material: ['Kurtka'],
    facts: { goods: [line('Kurtka')] },
  });
  const ctx = fakeCtx();
  await handleCalcCallback(ctx, chatId, 'skip');
  await handleCalcCallback(ctx, chatId, 'more');
  updateIntake(chatId, { material: ['Kurtka', 'Shim 2 karobka'] });
  model.analyze.mockResolvedValueOnce(reads([line('Shim'), line('Kurtka')]));
  await handleCalcCallback(ctx, chatId, 'done');
  await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
  return { chatId, asked: ctx.texts().filter((t) => t.startsWith('❓')).map((t) => t.split(' — ')[0]!.split(':')[0]!) };
}

/** The bundle's words, by key. */
const bundle = (locale: string) => (JSON.parse(readFileSync(join('messages', `${locale}.json`), 'utf8')) as { calc: Record<string, string> }).calc;
const LOCALES = ['uz', 'ru', 'en', 'zh-CN'];
const ADVICE_KEY = { retry: 'threadAiRetry', smaller: 'threadAiTooBig', admin: 'threadAiNoRetry' } as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = join(dir, name);
    if (statSync(rel).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const invoiceState = (stage: IntakeState['stage']) =>
  collection({ stage, invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } }).state;

const SCENARIOS: Record<string, () => Promise<void>> = {
  // ---- «a second invoice arrived»: the open question survives the answer (c0)
  c0000: async () => {
    const r = invoiceChoice(invoiceState('client'), 'inv_add')!;
    expect([r.patch.stage, r.reask]).toEqual(['client', 'client']);
  },
  c0001: async () => {
    const r = invoiceChoice(invoiceState('client'), 'inv_replace')!;
    expect([r.patch.stage, r.reask]).toEqual(['client', 'client']);
  },
  c0002: async () => {
    const r = invoiceChoice(invoiceState('section'), 'inv_add')!;
    expect([r.patch.stage, r.reask]).toEqual(['section', 'section']);
  },
  c0003: async () => {
    const r = invoiceChoice(invoiceState('section'), 'inv_replace')!;
    expect([r.patch.stage, r.reask]).toEqual(['section', 'section']);
  },
  c0004: async () => {
    const r = invoiceChoice(invoiceState('material'), 'inv_add')!;
    expect([r.patch.stage, r.reask]).toEqual(['material', null]);
  },
  c0005: async () => {
    const r = invoiceChoice(invoiceState('review'), 'inv_add')!;
    expect([r.patch.stage, r.reask]).toEqual(['material', null]);
  },
  c0006: async () => {
    const r = invoiceChoice(invoiceState('question'), 'inv_add')!;
    expect([r.patch.stage, r.reask]).toEqual(['material', null]);
  },
  // «🧮 → section → client», two mapped files, ➕, then «GS777»: the customer, never material.
  c0007: async () => {
    const { chatId } = collection({ stage: 'client' });
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«A.xlsx»', [line('Kurtka')])).patch);
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«B.xlsx»', [line('Shim')])).patch);
    await handleCalcCallback(fakeCtx(), chatId, 'inv_add');
    expect(activeIntake(chatId)!.stage).toBe('client');
    const read = await readCustomerText('GS777', 'GS');
    const answer = clientAnswer(activeIntake(chatId)!, 'GS777', read);
    expect(answer.kind).toBe('customer');
    updateIntake(chatId, answer.patch);
    const after = activeIntake(chatId)!;
    expect(after.clientHintRaw).toBe('GS777');
    expect(after.material).not.toContain('GS777');
    // What the landing resolves the deal by — the code, so never a nameless lead.
    expect(parseClientHint(after.clientHintRaw, { prefix: 'GS' })).toEqual({ code: 'GS777' });
  },
  c0008: async () => {
    const { chatId } = collection({ stage: 'material' });
    const says: string[] = [];
    for (const [label, goods] of [
      ['«A.xlsx»', [line('Kurtka'), line('Shim')]],
      ['«B.xlsx»', [line('<B line 1>'), line('<B line 2>'), line('<B line 3>')]],
      ['«C.xlsx»', [line('Poyabzal')]],
    ] as const) {
      const a = receiveGoodsSheet(activeIntake(chatId)!, mapped(label, [...goods]));
      says.push(a.say ?? '');
      updateIntake(chatId, a.patch);
    }
    const pending = activeIntake(chatId)!.pendingInvoice!;
    expect(pending.goods?.map((g) => g.name)).toEqual(['<B line 1>', '<B line 2>', '<B line 3>', 'Poyabzal']);
    expect(pending.label).toBe('«B.xlsx», «C.xlsx»');
    expect(says[2]).toContain('«B.xlsx», «C.xlsx»');
    const choice = invoiceChoice(activeIntake(chatId)!, 'inv_add')!;
    expect(choice.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', '<B line 1>', '<B line 2>', '<B line 3>', 'Poyabzal']);
  },
  c0009: async () => {
    const { chatId } = collection({ stage: 'material' });
    for (const [label, goods] of [
      ['«A.xlsx»', [line('Kurtka'), line('Shim')]],
      ['«B.xlsx»', [line('<B line 1>'), line('<B line 2>'), line('<B line 3>')]],
      ['«C.xlsx»', [line('Poyabzal')]],
    ] as const) {
      updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped(label, [...goods])).patch);
    }
    const choice = invoiceChoice(activeIntake(chatId)!, 'inv_replace')!;
    expect(choice.patch.invoiceGoods?.map((g) => g.name)).toEqual(['<B line 1>', '<B line 2>', '<B line 3>', 'Poyabzal']);
  },
  c0010: async () => {
    const { chatId } = collection({ stage: 'material' });
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«A.xlsx»', [line('Kurtka')])).patch);
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«B.xlsx»', [line('Shim')])).patch);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    const before = JSON.stringify(activeIntake(chatId));
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts().at(-1)).toBe(STALE);
    expect(activeIntake(chatId)!.pendingInvoice).toBeNull();
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0011: async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka'], analysing: 'tok' });
    const snapshot: IntakeState = { ...state, material: ['Kurtka'], fileCount: 0, lineAnswers: [], lineDone: [] };
    const live: IntakeState = {
      ...snapshot,
      lineAnswers: [{ index: 0, name: 'Kurtka', patch: { weightKg: 150 } }],
      lineDone: [{ index: 0, name: 'Kurtka' }],
      answers: ['1-qator: 150 kg'],
    };
    const analysed: IntakeState = { ...snapshot, facts: { goods: [line('Kurtka')] } as IntakeState['facts'] };
    const out = settleAnalysis(live, snapshot, analysed, 'tok');
    expect(out.kind).toBe('done');
    expect(out.kind === 'done' && out.state.facts.goods?.[0]?.weightKg).toBe(150);
  },
  c0012: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValue(reads([line('Kurtka', { quantity: 300, weightKg: 150 })]));
    let refused = false;
    const ctx = fakeCtx((t) => {
      if (!refused && t.startsWith('⏳')) {
        refused = true;
        return true;
      }
      return false;
    });
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    await handleCalcCallback(ctx, chatId, 'more');
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    expect(ctx.texts()).not.toContain('⏳ Tahlil davom etmoqda — natijani kuting.');
    expect(model.analyze).toHaveBeenCalledTimes(2);
  },
  // ---- «boshqa zavodning tovarlarimi?» in either order (c4)
  c0016: async () => {
    const base = { stage: 'material' as const, material: ['x'], invoiceGoods: [line('Factory A chair'), line('Factory A table')], aiGoods: null };
    const pdf = receivePdf(collection(base).state, { data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }, '«B.pdf»');
    const sheet = receiveSheetText(collection(base).state, '«B.csv»', { text: '[CSV]\nB blender | 5', cut: false, cellsCut: false }, fitRows);
    for (const answer of [pdf, sheet]) {
      expect(answer.patch.aiGoods).toBe('ask');
      expect(answer.say).toContain('boshqa zavodning tovarlarimi?');
      expect(buttonsOf(answer)).toContain('c:other_add');
      expect(buttonsOf(answer)).toContain('c:other_same');
      const { chatId } = collection({ ...base, ...answer.patch });
      const ctx = fakeCtx();
      await handleCalcCallback(ctx, chatId, 'done');
      expect(ctx.texts().at(-1)).toBe(OTHER_ASK);
    }
  },
  c0017: async () => {
    const { state } = collection({ stage: 'material', invoiceGoods: [], pdfs: [{ data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }], aiGoods: null });
    const answer = receiveGoodsSheet(state, mapped('«A.xlsx»', [line('Kurtka')]));
    expect(answer.patch.aiGoods).toBe('ask');
    expect(buttonsOf(answer)).toContain('c:other_add');
  },
  // ---- ⏭ only under the open question (c5)
  c0018: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka'], analysing: null });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect([STALE, NOT_READ]).toContain(ctx.texts().at(-1));
    expect(['review', 'question']).not.toContain(activeIntake(chatId)!.stage);
    await handleCalcCallback(ctx, chatId, 'save');
    expect(ctx.texts().at(-1)).toBe(NOT_READ);
  },
  c0019: async () => {
    const { chatId } = collection({ stage: 'client', analysing: null });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect([STALE, NOT_READ]).toContain(ctx.texts().at(-1));
    expect(['review', 'question']).not.toContain(activeIntake(chatId)!.stage);
    await handleCalcCallback(ctx, chatId, 'save');
    expect(ctx.texts().at(-1)).toBe(NOT_READ);
  },
  c0020: async () => {
    const { chatId } = collection({ stage: 'question', analysing: 'token', askingIndex: 0, facts: { goods: [line('Kurtka')] } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
  },
  c0021: async () => {
    const { chatId } = collection({
      stage: 'question',
      analysing: null,
      askingIndex: 0,
      round: 1,
      facts: { goods: [line('Kurtka'), line('Shim')] } as IntakeState['facts'],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(activeIntake(chatId)!.lineDone).toContainEqual({ index: 0, name: 'Kurtka' });
    expect(ctx.texts().at(-1)).toMatch(/^❓ 2-qator «Shim»/);
  },
  // ---- 🔁 drops the replaced workbook's other sheets too (c7)
  c0022: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(
      chatId,
      xlsx(
        { name: 'Invoice', rows: [['Description', 'Qty'], ['WRONG jackets', 10]] },
        { name: 'Packing list', rows: [['Packing list for WRONG jackets'], ['TOTAL G.W.', '9999 KGS'], ['TOTAL CBM', 77]] },
      ),
      'WRONG.xlsx',
    );
    await forward(
      chatId,
      xlsx(
        { name: 'Invoice', rows: [['Description', 'Qty'], ['RIGHT shoes', 10], ['RIGHT shoes B', 20]] },
        { name: 'Packing list', rows: [['TOTAL G.W.', '1200 KGS'], ['TOTAL CBM', 8]] },
      ),
      'RIGHT.xlsx',
    );
    await handleCalcCallback(fakeCtx(), chatId, 'inv_replace');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['RIGHT shoes', 'RIGHT shoes B']);
    const texts = s.invoiceTexts.map((t) => t.text).join('\n');
    expect(texts).toContain('1200 KGS');
    expect(texts).not.toContain('9999');
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(s);
    const prompt = promptOf(lastCall());
    expect(prompt).not.toContain('9999 KGS');
    expect(prompt).not.toContain('TOTAL CBM | 77');
  },
  c0023: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    for (const name of ['A', 'B']) {
      await forward(
        chatId,
        xlsx(
          { name: 'Invoice', rows: [['Description', 'Qty'], [`${name} goods`, 10]] },
          { name: 'Packing list', rows: [[`TOTAL G.W. ${name}`, '100 KGS']] },
        ),
        `${name}.xlsx`,
      );
    }
    await handleCalcCallback(fakeCtx(), chatId, 'inv_add');
    const texts = activeIntake(chatId)!.invoiceTexts.map((t) => t.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('TOTAL G.W. A');
    expect(texts[1]).toContain('TOTAL G.W. B');
  },
  // ---- the markup readers are linear (c9)
  c0064: async () => expectLinear(htmlRows, (t) => htmlTableSheets(t)![0]!.rows.length, 2000),
  c0065: async () => expectLinear(xmlRows, (t) => spreadsheetMlSheets(t)![0]!.rows.length, 2000),
  c0066: async () => expectLinear(htmlRows, (t) => htmlTableSheets(t)![0]!.rows.length, 4000),
  c0067: async () => expectLinear(xmlRows, (t) => spreadsheetMlSheets(t)![0]!.rows.length, 4000),
  c0068: async () => {
    expectLinear(htmlRows, (t) => htmlTableSheets(t)![0]!.rows.length, 8000);
    expect(htmlTableSheets(htmlRows(8000))![0]!.rowsLeftOut).toBe(true);
  },
  c0069: async () => {
    expectLinear(xmlRows, (t) => spreadsheetMlSheets(t)![0]!.rows.length, 8000);
    expect(spreadsheetMlSheets(xmlRows(8000))![0]!.rowsLeftOut).toBe(true);
  },
  c0075: async () => {
    const rows = htmlTableSheets(
      '<table>\n<tr><th rowspan=2>Наименование</th><th rowspan=2>Кол-во</th><th colspan=2>Вес, кг</th><th rowspan=2>Сумма</th></tr>\n<tr><th>нетто</th><th>брутто</th></tr>\n<tr><td>Стол</td><td>5</td><td>100</td><td>110</td><td>2500</td></tr>\n<tr><td>Стул</td><td>10</td><td>50</td><td>60</td><td>900</td></tr>\n</table>',
    )![0]!.rows;
    expect([
      ['Наименование', 'Кол-во', 'Вес, кг', 'Вес, кг', 'Сумма'],
      ['Наименование', 'Кол-во', 'Вес, кг', null, 'Сумма'],
    ]).toContainEqual(rows[0]);
    expect([rows[1]![2], rows[1]![3]]).toEqual(['нетто', 'брутто']);
    expect(rows[2]).toEqual(['Стол', '5', '100', '110', '2500']);
  },
  c0081: async () => {
    const items = pasteItems('Description\tQuantity\tN.W.\tCBM\nLED panel light\t12,500PCS\t1,200KGS\t2.5CBM');
    expect(items).toHaveLength(1);
    expect([items[0]!.quantity, items[0]!.weightKg]).toEqual([null, null]);
    expect(items[0]!.note ?? '').toContain('12,500PCS');
    expect(items[0]!.note ?? '').toContain('1,200KGS');
  },
  // ---- one budget, two factories (c17)
  c0216: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, factoryInvoice(70, 'FACTORY A'), 'A.xlsx');
    const b = await forward(chatId, factoryInvoice(70, 'FACTORY B'), 'B.xlsx');
    const s = activeIntake(chatId)!;
    const texts = [...s.sheetTexts, ...s.invoiceTexts].map((t) => t.text.trim());
    const fit = fitSheetTexts(texts, BUDGET);
    fit.parts.forEach((part, i) => {
      const lines = new Set(texts[i]!.split('\n'));
      for (const l of part.split('\n').filter(Boolean)) expect(lines.has(l), `a whole row of file ${i}`).toBe(true);
    });
    const prompt = sheetsPromptText(s.sheetTexts, s.invoiceTexts, BUDGET);
    const bothWhole = !prompt.includes('обрезана') && !prompt.includes('не поместилась');
    const bSaysCut = /AI faqat birinchi \d+ \/ \d+ qatorini o‘qiydi|AI ga sig‘madi|AI faqat boshini o‘qiydi \(birinchi \d+ qator\)/.test(b.say ?? '');
    expect(bothWhole || bSaysCut, `prompt whole: ${bothWhole}; B said: ${b.say}`).toBe(true);
  },
  c0217: async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `${i + 1} | Куртка женская модель YW-${i}`);
    const text = sheetsPromptText([{ text: rows.join('\n'), cut: false, cellsCut: false }], [], 400);
    expect(text).toContain('[Таблица обрезана: показаны первые');
    expect(text).toContain('не считай итоги по видимой части');
    const table = text.slice(text.indexOf('(текстом):\n') + '(текстом):\n'.length, text.indexOf('\n[Таблица обрезана'));
    expect(table.split('\n').every((l) => rows.includes(l))).toBe(true);
  },
  c0218: async () => {
    const answer = receiveGoodsSheet(collection().state, mapped('«A.xlsx»', [line('Kurtka')], '[Packing list]\n1 | 2', true, false));
    expect(answer.say).toContain(OTHER_CUT_SELLER);
  },
  c0219: async () => {
    const answer = receiveGoodsSheet(collection().state, mapped('«A.xlsx»', [line('Kurtka')], '[Packing list]\n1 | 2', false, true));
    expect(answer.say).not.toContain('⚠️ Jadval katta');
  },
  // ---- the prefill worker's stand-down (a18)
  c0220: async () => {
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('touched');
    await handler([prefillJob(1)]);
    const texts = notify.mock.calls.map((call) => (call[0] as { text: string }).text);
    expect(texts).not.toContain(STOOD_DOWN.touched);
    for (const t of texts) expect(t).toBe(PASS_FAILED);
  },
  c0221: async () => {
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('touched');
    await handler([prefillJob(0)]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: STOOD_DOWN.touched }));
  },
  // ---- no pause after the last attempt, none past the leash (a19)
  c0222: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 0 }], 10_000);
    expect(r.out).toEqual({ ok: false, failure: 'overloaded' });
    expect(r.calls).toBe(2);
    expect(r.ms).toBeLessThan(3_500);
  },
  c0223: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 7_900 }], 10_000);
    expect(r.out).toEqual({ ok: false, failure: 'overloaded' });
    expect(r.ms).toBeLessThan(10_250);
  },
  c0224: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 17_900 }], 20_000);
    expect(r.ms).toBeLessThan(20_250);
  },
  c0225: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 0 }, { status: 529, delayMs: 0 }], 20_000);
    expect(r.out).toEqual({ ok: false, failure: 'overloaded' });
    expect(r.ms).toBeLessThan(3_500);
  },
  // ---- the chat door's advice follows the failure, in all four bundles (#20)
  ...Object.fromEntries(
    (
      [
        ['c0226', 'not_configured'],
        ['c0227', 'auth'],
        ['c0228', 'refused'],
        ['c0229', 'rejected'],
      ] as const
    ).map(([id, failure]) => [
      id,
      async () => {
        const advice = threadAiAdvice(failure);
        expect(advice).not.toBe('retry');
        for (const locale of LOCALES) {
          const words = bundle(locale);
          const shown = `${words.threadAiFailed} ${words[ADVICE_KEY[advice!]]}`;
          expect(shown, locale).not.toContain(words.threadAiRetry);
        }
        expect(`${bundle('uz').threadAiFailed} ${bundle('uz')[ADVICE_KEY[advice!]]}`).not.toContain('Keyinroq qayta urinib ko‘ring');
        expect(`${bundle('ru').threadAiFailed} ${bundle('ru')[ADVICE_KEY[advice!]]}`).not.toContain('Попробуйте позже');
      },
    ]),
  ),
  ...Object.fromEntries(
    (
      [
        ['c0230', 'rate_limited'],
        ['c0231', 'overloaded'],
        ['c0232', 'network'],
      ] as const
    ).map(([id, failure]) => [
      id,
      async () => {
        expect(threadAiAdvice(failure)).toBe('retry');
        expect(bundle('uz')[ADVICE_KEY.retry]).toContain('Keyinroq qayta urinib ko‘ring');
      },
    ]),
  ),
  c0233: async () => {
    expect(AI_READ_FAILURE.truncated.retry).toBe(false);
    expect(AI_READ_FAILURE.truncated.text).toContain('Kamroq sahifa yoki Excel yuboring');
  },
  c0234: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'truncated' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('review'));
    expect(buttonsOf(ctx.replies.at(-1))).not.toContain('c:reread');
  },
  c0235: async () => {
    const out = readIntakeResponse({ stop_reason: 'max_tokens', content: [], usage: { input_tokens: 40_000, output_tokens: 16_000 } });
    expect(out).toMatchObject({ ok: false, failure: 'truncated' });
    expect((out as { usage?: { inputTokens?: number; outputTokens?: number } }).usage).toMatchObject({ inputTokens: 40_000, outputTokens: 16_000 });
  },
  // ---- the typed regex never overrules a reading that found no goods (t22)
  c0266: async () => {
    const { state } = collection({ stage: 'material', material: ['Guangzhou → Toshkent\nSalom, 12 kub 3500 kg'] }, 'yolkira');
    model.analyze.mockResolvedValueOnce({ ...reads([]), facts: { fromCity: 'Guangzhou', toCity: 'Toshkent', weightKg: 3500, volumeM3: 12, goods: [] } });
    const out = await analyzeCollected(state);
    expect(missingFields('yolkira', out.facts, new Map())).toContain('goods');
  },
  c0267: async () => {
    const { state } = collection({ stage: 'material', material: ['Кубатура: 12 м3\nOg’irligi 3500 kg'] }, 'yolkira');
    model.analyze.mockResolvedValueOnce(reads([]));
    const out = await analyzeCollected(state);
    expect(missingFields('yolkira', out.facts, new Map())).toContain('goods');
  },
  c0268: async () => {
    // threadCalcAnalyze reads the thread from the database; its goods rule is
    // pinned by its own two lines, and what they give for this chat by the
    // readers they call.
    const service = source('src/modules/wms/calc/from-thread.ts');
    expect(service).toContain('goods: ai?.facts.goods?.length ? ai.facts.goods : typedGoods');
    expect(service).toContain("readGoodsLines(material.bodies.join('\\n'), { labelledOnly: ai !== null })");
    const typedGoods = readGoodsLines('Salom, 12 kub 3500 kg', { labelledOnly: true });
    expect(typedGoods).toEqual([]);
    expect(missingFields('yolkira', { ...parseManualFacts('Salom, 12 kub 3500 kg'), goods: typedGoods }, new Map())).toContain('goods');
  },
  // ---- photographs are STORED, not deflated (#27)
  c0421: async () => {
    expect(source('src/modules/wms/documents/agent-xlsx.ts')).toContain("writeBuffer({ zip: { compression: 'STORE' } })");
  },
  c0422: async () => {
    expect(source('src/modules/wms/documents/packing-photos-xlsx.ts')).toContain("writeBuffer({ zip: { compression: 'STORE' } })");
  },
  c0423: async () => {
    expect(source('src/modules/wms/reports/stock-xlsx.ts')).toContain("writeBuffer({ zip: { compression: 'STORE' } })");
  },
  c0428: async () => {
    // Forty sheets of one cell each, end to end (the BIFF builders of the fixture).
    const many = await buildFile({ kind: 'xls', bytes: () => xlsManySheets(MAX_SHEETS + 8) });
    const read = readXls(many.body);
    expect(read.ok && read.sheets.length).toBe(MAX_SHEETS);
    if (read.ok) read.sheets.forEach((s, i) => expect(s.rows, s.name).toEqual([[`x${i}`]]));
  },
  c0429: async () => {
    expect(csvRows(Array.from({ length: 6000 }, (_, i) => `Item ${i + 1},1`).join('\n'))).toHaveLength(5000);
  },
  c0430: async () => {
    const rows = csvRows(Array.from({ length: 150 }, (_, i) => `c${i + 1}`).join(','));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(100);
  },
  c0524: async () => {
    const { chatId } = collection({ stage: 'material' });
    const answer = await forward(
      chatId,
      { kind: 'csv', text: () => Array.from({ length: 300 }, (_, i) => `PL-${i + 1},LED panel light 600x600 48W 4000K,${i + 1},${((i + 1) * 0.196).toFixed(3)}`).join('\n') },
      'PL.csv',
    );
    expect(answer.say ?? '').toMatch(/⚠️ Jadval katta: AI faqat boshini o‘qiydi|AI faqat birinchi \d+ ?\/ ?\d+ qatori?ni o‘qiydi/);
  },
  c0525: async () => {
    const run = await runFile({ kind: 'csv', text: () => Array.from({ length: 300 }, (_, i) => `PL-${i + 1},LED panel light 600x600 48W 4000K,${i + 1},${((i + 1) * 0.196).toFixed(3)}`).join('\n') });
    const read = run.read!;
    expect(read.kind).toBe('text');
    if (read.kind !== 'text') return;
    const text = sheetsPromptText([{ text: read.text, cut: read.textCut, cellsCut: read.cellsCut }], [], BUDGET);
    expect(text).toContain('[Таблица обрезана');
    expect(text).toContain('файл длиннее');
    expect(text).toContain('не считай итоги');
  },
  c0526: async () => {
    for (const p of ['src/modules/wms/documents/agent-xlsx.ts', 'src/modules/wms/documents/packing-photos-xlsx.ts', 'src/modules/wms/reports/stock-xlsx.ts']) {
      expect(source(p), p).toContain("writeBuffer({ zip: { compression: 'STORE' } })");
    }
  },
  c0527: async () => {
    const sharp = (await import('sharp')).default;
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Photos');
    for (let i = 0; i < 300; i += 1) {
      const noise = Buffer.alloc(400 * 300 * 3);
      for (let b = 0; b < noise.length; b += 1) noise[b] = (b * 7 + i * 13) % 251;
      const jpeg = await sharp(noise, { raw: { width: 400, height: 300, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
      const id = book.addImage({ buffer: jpeg as unknown as ExcelJS.Buffer, extension: 'jpeg' });
      sheet.addImage(id, { tl: { col: 0, row: i }, ext: { width: 40, height: 30 } });
    }
    const body = Buffer.from(await book.xlsx.writeBuffer({ zip: { compression: 'STORE' } } as never));
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(body as unknown as ArrayBuffer);
    expect(back.worksheets[0]!.getImages()).toHaveLength(300);
  },
  c0528: async () => {
    const fence = readFileSync('tests/unit/calc-phone-safety.test.ts', 'utf8');
    const block = fence.slice(fence.indexOf('expect(importers).toEqual('), fence.indexOf('].map((rel)', fence.indexOf('expect(importers).toEqual(')));
    const listed = [...block.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]!).sort();
    expect(listed).toContain('src/modules/wms/deals/goods-import.ts');
    const importers = sourceFiles('src')
      .filter((file) => /from ['"][^'"]*\/number-cell['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => file.split(/[\\/]/).join('/'))
      .sort();
    expect(importers).toEqual(listed);
  },
  c0599: async () => {
    expect(AI_READ_FAILURE.truncated.retry).toBe(false);
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'truncated' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('review'));
    expect(buttonsOf(ctx.replies.at(-1))).not.toContain('🔄 AI qayta o‘qisin');
  },
  c0600: async () => {
    for (const locale of LOCALES) {
      const words = bundle(locale);
      for (const key of ['threadAiRetry', 'threadAiNoRetry', 'threadAiTooBig']) expect(words[key], `${locale}.${key}`).toBeTruthy();
      expect(words.threadAiFailed!.trim().endsWith(words.threadAiRetry!.trim()), `${locale}.threadAiFailed`).toBe(false);
    }
  },
  c0764: async () => {
    const pins = readFileSync('tests/unit/intake-typed.test.ts', 'utf8');
    expect(pins).toContain("const code = (src: string) => src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/.*$/gm, '');");
    expect(pins).toContain('const source = (p: string) => code(read(p));');
    // Every pin on the chat door's two files reads them through the stripper.
    expect(pins).not.toMatch(/read\('src\/modules\/wms\/calc\/from-thread\.ts'\)|read\('src\/components\/thread-calc\.tsx'\)/);
  },
  c0766: async () => {
    const service = source('src/modules/wms/calc/from-thread.ts');
    const typed = service.indexOf('{ labelledOnly: ai !== null }');
    expect(typed).toBeGreaterThan(-1);
    expect(typed).toBeGreaterThan(service.indexOf('await analyzeIntake('));
  },
  c0767: async () => {
    // The day's budget is written from the collection's `usage` at the
    // landing; a paid read that failed must still carry what it cost.
    const usage = { model: 'm', inputTokens: 40_000, outputTokens: 16_000 };
    const { state } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'truncated', usage });
    const out = await analyzeCollected(state);
    expect(out.usage).toEqual(usage);
  },
  // ---- the fixer's collector pins (#0-#7)
  c0768: async () => {
    const { chatId } = collection({ stage: 'client' });
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Shim', 5]] }), 'B.xlsx');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    const s = activeIntake(chatId)!;
    expect(s.stage).toBe('client');
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(ctx.texts().at(-1)).toContain(CLIENT_Q);
    const answer = clientAnswer(s, 'GS777', await readCustomerText('GS777', 'GS'));
    expect(answer.kind).toBe('customer');
    updateIntake(chatId, answer.patch);
    expect(activeIntake(chatId)!.clientHintRaw).toBe('GS777');
    expect(activeIntake(chatId)!.material).not.toContain('GS777');
  },
  c0769: async () => {
    const { chatId } = collection({ stage: 'section', ai: true, route: null }, 'podklyuch');
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Shim', 5]] }), 'B.xlsx');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    const s = activeIntake(chatId)!;
    expect([s.stage, s.route]).toEqual(['section', null]);
    expect(buttonsOf(ctx.replies.at(-1))).toContain('c:zone_cn');
    expect(buttonsOf(ctx.replies.at(-1))).toContain('c:zone_kashgar');
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts().at(-1)).toBe('Avval yuk qayerdan chiqishini tanlang.');
  },
  c0770: async () => {
    const { chatId, state } = collection({ stage: 'client', aiGoods: 'ask', invoiceGoods: [line('Kurtka')] });
    const choice = otherFilesChoice(state, 'other_add')!;
    expect([choice.patch.stage, choice.reask]).toEqual(['client', 'client']);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'other_add');
    expect(activeIntake(chatId)!.stage).toBe('client');
    expect(ctx.texts().at(-1)).toContain(CLIENT_Q);
  },
  c0771: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const files = [
      ['«A.xlsx»', [line('A1'), line('A2')], '[PL A]\nA | 1'],
      ['«B.xlsx»', [line('B1')], '[PL B]\nB | 1'],
      ['«C.xlsx»', [line('C1'), line('C2')], '[PL C]\nC | 1'],
    ] as const;
    const says: string[] = [];
    for (const [label, goods, text] of files) {
      const a = receiveGoodsSheet(activeIntake(chatId)!, mapped(label, [...goods], text));
      says.push(a.say ?? '');
      updateIntake(chatId, a.patch);
    }
    expect(says[2]).toContain('«B.xlsx», «C.xlsx» — jami 3 ta tovar');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['A1', 'A2', 'B1', 'C1', 'C2']);
    expect(s.invoiceTexts.map((t) => t.text)).toEqual(['[PL A]\nA | 1', '[PL B]\nB | 1', '[PL C]\nC | 1']);
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts().at(-1)).toBe(STALE);
  },
  c0772: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    for (const [label, goods] of [
      ['«A.xlsx»', [line('A1')]],
      ['«B.xlsx»', [line('B1')]],
      ['«C.xlsx»', [line('C1')]],
    ] as const) {
      updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped(label, [...goods])).patch);
    }
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(activeIntake(chatId)!.invoiceGoods?.map((g) => g.name)).toEqual(['B1', 'C1']);
    expect(ctx.texts()[0]).toContain('«B.xlsx», «C.xlsx» oldingisining o‘rniga olindi');
  },
  c0773: async () => {
    const { state } = collection({ stage: 'material', material: ['x'], analysing: 'tok' });
    const snapshot: IntakeState = { ...state, facts: { goods: [line('line0'), line('line1')] } as IntakeState['facts'], lineAnswers: [] };
    const answers: IntakeState['lineAnswers'] = [{ index: 1, name: 'line1', patch: { weightKg: 150 } }];
    const live: IntakeState = { ...snapshot, lineAnswers: answers };
    const analysed: IntakeState = { ...snapshot, facts: { goods: [line('line0'), line('line1', { weightKg: null })] } as IntakeState['facts'] };
    const out = settleAnalysis(live, snapshot, analysed, 'tok');
    expect(out.kind).toBe('done');
    expect(out.kind === 'done' && out.state.facts.goods?.[1]?.weightKg).toBe(150);
    // Idempotent: an answer the snapshot already held lands once, the same.
    const again = settleAnalysis(live, { ...snapshot, lineAnswers: answers }, analysed, 'tok');
    expect(again.kind === 'done' && again.state.facts.goods?.[1]?.weightKg).toBe(150);
  },
  c0774: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValueOnce(reads([line('Kurtka', { quantity: 300, weightKg: 150 })]));
    const ctx = fakeCtx((t) => t.startsWith('⏳'));
    await expect(handleCalcCallback(ctx, chatId, 'done')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('review'));
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(activeIntake(chatId)!.analysing).toBeNull();
    expect(buttonsOf(ctx.replies.at(-1))).toContain('c:save');
  },
  c0775: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    const pdf = receivePdf(activeIntake(chatId)!, { data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }, '«B.pdf»');
    updateIntake(chatId, pdf.patch);
    expect(activeIntake(chatId)!.aiGoods).toBe('ask');
    expect(pdf.say).toContain('boshqa zavodning tovarlarimi?');
    expect(buttonsOf(pdf)).toContain('c:other_add');
    expect(buttonsOf(pdf)).toContain('c:other_same');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts().at(-1)).toBe(OTHER_ASK);
    await handleCalcCallback(ctx, chatId, 'reread');
    expect(ctx.texts().at(-1)).toBe(OTHER_ASK);
  },
  c0776: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, csv('X-headerless'), 'X.csv');
    const a = await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10], ['Shim', 5]] }), 'A.xlsx');
    expect(activeIntake(chatId)!.aiGoods).toBe('ask');
    expect(a.say).toContain('boshqa zavodning tovarlarimi?');
    await handleCalcCallback(fakeCtx(), chatId, 'other_add');
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(activeIntake(chatId)!);
    expect(lastCall().knownGoods).toEqual(['Kurtka', 'Shim']);
    // …and only on «add».
    updateIntake(chatId, { aiGoods: 'context' });
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(activeIntake(chatId)!);
    expect(lastCall().knownGoods).toBeUndefined();
  },
  c0782: async () => {
    const { state } = collection({
      stage: 'material',
      material: ['x'],
      aiGoods: 'add',
      invoiceGoods: [line('Ladies jacket')],
      sheetTexts: [{ text: '[CSV]\nB blender | 5', cut: false, cellsCut: false }],
      invoiceTexts: [{ text: '[Packing list]\nLadies jacket | 300 | 150', cut: false, cellsCut: false }],
    });
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(state);
    const prompt = promptOf(lastCall());
    const goodsBlock = prompt.slice(0, prompt.indexOf('Другие листы книги'));
    expect(goodsBlock).toContain('B blender | 5');
    expect(goodsBlock).not.toContain('[Packing list]');
    expect(prompt.slice(prompt.indexOf('Другие листы книги'))).toContain('НЕ перечисляй в goods:\n[Packing list]\nLadies jacket | 300 | 150');
  },
  c0783: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka'], facts: { goods: [line('Kurtka')] } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
    expect(activeIntake(chatId)!.stage).toBe('material');
    await handleCalcCallback(ctx, chatId, 'save');
    expect(ctx.texts().at(-1)).toBe(NOT_READ);
  },
  c0784: async () => {
    const { chatId } = collection({ stage: 'client' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
  },
  c0785: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, csv('X-headerless'), 'X.csv');
    await forward(
      chatId,
      xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Wrong1', 1]] }, { name: 'Packing list', rows: [['TOTAL G.W.', 9999]] }),
      'wrong.xlsx',
    );
    await forward(
      chatId,
      xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Right1', 1]] }, { name: 'Packing list', rows: [['TOTAL G.W.', 1500]] }),
      'right.xlsx',
    );
    await handleCalcCallback(fakeCtx(), chatId, 'inv_replace');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Right1']);
    expect(fitSheetTexts([...s.sheetTexts, ...s.invoiceTexts].map((t) => t.text.trim()), BUDGET).text).toBe(
      '[CSV]\nX-headerless\n\n[Packing list]\nTOTAL G.W. | 1500',
    );
  },
  c0789: async () => {
    expect(STOOD_DOWN.unfinished).toBe(PASS_FAILED);
    expect(source('src/modules/wms/calc/jobs.ts')).toContain('const said = STOOD_DOWN[standing];');
    const { options } = await prefillWorker();
    expect(options).toMatchObject({ includeMetadata: true });
  },
  c0790: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 0 }], 10_000);
    expect(r.calls).toBe(2);
    expect(r.ms).toBeGreaterThanOrEqual(1_900);
    expect(r.ms).toBeLessThan(3_500);
  },
  c0791: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 7_900 }], 10_000);
    expect(r.ms).toBeLessThan(10_250);
  },
  c0792: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 6_000 }, { status: 529, delayMs: 0 }], 10_000);
    expect(r.calls).toBe(1);
    expect(r.ms).toBeLessThan(7_000);
  },
  c0793: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 0 }, { status: 529, delayMs: 17_900 }], 20_000);
    expect(r.calls).toBe(2);
    expect(r.ms).toBeLessThan(20_250);
  },
  c0794: async () => {
    const r = await realAnalyze([{ status: 529, delayMs: 1_600 }, { status: 529, delayMs: 0 }], 3_000);
    expect(r.ms).toBeLessThan(3_000);
  },
  c0797: async () => {
    const { chatId } = collection({ stage: 'question', askingIndex: 0, round: 1, facts: { goods: [line('Kurtka'), line('Shim')] } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toMatch(/^❓ 2-qator «Shim»/);
    expect(activeIntake(chatId)!.lineDone).toEqual([{ index: 0, name: 'Kurtka' }]);
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().filter((t) => t.startsWith('❓ 1-qator «Kurtka»'))).toEqual([]);
  },
  c0802: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(
      chatId,
      xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }, { name: 'Packing list', rows: [['TOTAL G.W.', '150 KGS']] }),
      'A.xlsx',
    );
    const s = activeIntake(chatId)!;
    expect(s.aiGoods).toBeNull();
    expect(a.keyboard).toBeUndefined();
    expect(s.invoiceTexts.map((t) => t.text).join('\n')).toContain('TOTAL G.W. | 150 KGS');
  },
  c0803: async () => {
    const { chatId } = collection(
      { stage: 'question', analysing: null, ai: true, askingIndex: null, askingTotals: true, totalsAsked: true, facts: { goods: [line('Kurtka', { quantity: 300 })] } as IntakeState['facts'] },
      'podklyuch',
    );
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts()).not.toContain(STALE);
    expect(activeIntake(chatId)!.stage).toBe('review');
  },
  c0804: async () => {
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockResolvedValue({ ok: false, reason: 'stand-in' });
    await handler([prefillJob(1)]);
    expect(prefill.run).toHaveBeenCalled();
  },
  c0805: async () => {
    const handlers = source('src/modules/platform/telegram/staff-handlers.ts');
    expect(handlers).toContain("type SheetRefusalReason = Extract<import('../../wms/deals/goods-file').GoodsFileRead, { kind: 'refused' }>['reason'];");
    expect(handlers).toContain('const SHEET_REFUSAL: Record<SheetRefusalReason, (label: string) => string> = {');
    expect(source('src/modules/wms/deals/goods-file.ts')).toContain("| { kind: 'refused'; reason: 'old_format' | 'encrypted' | 'broken' | 'empty' };");
  },
  c1002: async () => {
    const items = pasteItems('Kurtka 1200 50 3000');
    expect(items).toHaveLength(1);
    // The CODE is R3-T5's subject; the name is the kernel's one-cell rule
    // («Stul 2 21»), not asserted (lead 2026-10-22, the skeptic's c1002).
    expect(items[0]!.tnvedCode).toBeNull();
  },
  c1289: async () => {
    const built = await buildFile(
      xlsx({
        name: 'Inv',
        rows: [['Товарная накладная № 15'], ['Наименование', 'Кол-во', 'Вес, кг', 'Сумма'], ['Стол', 5, 100, 900], [null, 3, 60, null], ['Стул', 10, 50, 200]],
        merges: ['A1:D1', 'A3:A4', 'D3:D4'],
      }),
    );
    const sheet = (await workbookRows(built.body))!;
    const goods = parseGoods(sheet.rows, sheet.covered ?? null).goods;
    expect(
      goodsProblems(goods as unknown as Line[], {
        rows: [
          { name: 'Стол', quantity: 5, weightKg: 100, amount: 900 },
          { name: 'Стол', quantity: 3, weightKg: 60, amount: null },
          { name: 'Стул', quantity: 10, weightKg: 50, amount: 200 },
        ],
        count: 3,
      }),
    ).toEqual([]);
  },
  c1336: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, ladiesWorkbook(150, 'lines'), 'A.xlsx');
    updateIntake(chatId, receivePdf(activeIntake(chatId)!, { data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }, '«B.pdf»').patch);
    updateIntake(chatId, otherFilesChoice(activeIntake(chatId)!, 'other_add')!.patch);
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(activeIntake(chatId)!);
    const prompt = promptOf(lastCall());
    const goodsBlock = prompt.includes('Таблица Excel') ? prompt.slice(0, prompt.indexOf('Другие листы книги')) : '';
    expect(goodsBlock).not.toContain('Packing list');
    expect(prompt).toContain('Товары отсюда НЕ перечисляй в goods:\n[Packing list]');
    expect(prompt).toContain('- Ladies jacket model 150\n');
    expect(prompt).not.toContain('…и ещё');
  },
  c1337: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, ladiesWorkbook(400, 'lines'), 'A.xlsx');
    updateIntake(chatId, receivePdf(activeIntake(chatId)!, { data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }, '«B.pdf»').patch);
    updateIntake(chatId, otherFilesChoice(activeIntake(chatId)!, 'other_add')!.patch);
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(activeIntake(chatId)!);
    const known = knownGoodsText(lastCall().knownGoods ?? [], KNOWN_GOODS_CHARS);
    expect(known.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(234);
    expect(known).toContain('…и ещё 166 строк этой таблицы');
  },
  c1338: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csv300 }, 'list.csv');
    expect(a.say).toContain('⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi 213 qator) — qolganini VED fayldan ko‘radi');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    expect(prompt).toContain('[Таблица обрезана: показаны первые 213 строк, файл длиннее');
    const shown = prompt.slice(0, prompt.indexOf('\n[Таблица обрезана')).split('\n').at(-1)!;
    expect(new Set(csvRows(csv300()).map(renderRow)).has(shown), shown).toBe(true);
  },
  c1339: async () => {
    const text = () => Array.from({ length: 300 }, (_, i) => `${i + 1};Куртка женская модель YW-${i} (女士夹克);${300 + i};PCS;${i}.5;${i}.9;0.${i}`).join('\n');
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text }, 'PL.csv');
    expect(a.say).toContain('⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi 199 qator)');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    const shown = prompt.slice(0, prompt.indexOf('\n[Таблица обрезана')).split('\n').at(-1);
    expect(shown).toBe('199 | Куртка женская модель YW-198 (女士夹克) | 498 | PCS | 198.5 | 198.9 | 0.198');
    expect(prompt).toContain('[Таблица обрезана: показаны первые 199 строк, файл длиннее');
  },
  c1340: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csvLongCell }, 'list.csv');
    expect(a.say).not.toContain('Jadval katta');
    expect(a.say).not.toContain('boshini o‘qiydi');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    expect(prompt).toContain(CELLS_NOTE);
    expect(prompt).not.toContain('файл длиннее');
    expect(prompt).not.toContain('не считай итоги');
  },
  c1341: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csvWithTotal }, 'PL.csv');
    expect(a.say).not.toContain('Jadval katta');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    expect(prompt).not.toContain('файл длиннее');
    expect(prompt).not.toContain('не считай итоги');
    expect(prompt).toContain('TOTAL | 1234 | 5.6');
  },
  c1342: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, consigneeWorkbook(), 'A.xlsx');
    expect(a.say).not.toContain('boshqa varaqlarning faqat boshini o‘qiydi');
    expect(activeIntake(chatId)!.invoiceTexts[0]!.cut).toBe(false);
  },
  c1343: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, ladiesWorkbook(400, 'cut'), 'A.xlsx');
    expect(a.say).toContain(OTHER_CUT_SELLER);
    const prompt = sheetsPromptText([], activeIntake(chatId)!.invoiceTexts, BUDGET);
    expect(prompt.slice(prompt.indexOf('Другие листы книги'))).toContain('[Таблица обрезана');
  },
  c1375: async () => {
    const { chatId, asked } = await skipThenReread();
    expect(asked).toEqual(['❓ 1-qator «Shim»']);
    expect(activeIntake(chatId)!.lineDone).toEqual([{ index: 1, name: 'Kurtka' }]);
  },
  c1376: async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 1,
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf'), line('Shapka')] } as IntakeState['facts'],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().map((t) => t.split(' — ')[0])).toEqual(['❓ 2-qator «Shim»', '❓ 3-qator «Sharf»']);
    expect(activeIntake(chatId)).toMatchObject({ askingIndex: 2, lineDone: [{ index: 0, name: 'Kurtka' }, { index: 1, name: 'Shim' }] });
  },
  c1377: async () => {
    const { chatId } = collection({
      stage: 'question',
      askingIndex: 0,
      round: 3,
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf'), line('Shapka')] } as IntakeState['facts'],
    });
    await handleCalcCallback(fakeCtx(), chatId, 'skip');
    expect(activeIntake(chatId)).toMatchObject({ stage: 'review', lineDone: [{ index: 0, name: 'Kurtka' }] });
  },
  c1545: async () => {
    expect(goodsProblems(pasteItems('Kurtka 6201 93 0000 300 dona 12.5$') as unknown as Line[], { rows: [{ tnvedCode: '6201930000', quantity: 300 }], count: 1 })).toEqual([]);
  },
  c1721: async () => {
    const { chatId, asked } = await skipThenReread();
    expect(asked).toEqual(['❓ 1-qator «Shim»']);
    expect(activeIntake(chatId)!.lineDone).toEqual([{ index: 1, name: 'Kurtka' }]);
  },
  c1722: async () => {
    const three = [line('Kurtka'), line('Shim'), line('Sharf')];
    const { chatId } = collection({ stage: 'question', askingIndex: 0, round: 1, material: ['yana fayl bor'], facts: { goods: three } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    await handleCalcCallback(ctx, chatId, 'more');
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'timeout' });
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    model.analyze.mockResolvedValueOnce(reads(three));
    await handleCalcCallback(ctx, chatId, 'reread');
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    expect(ctx.texts().filter((t) => t.startsWith('❓')).at(-1)).toMatch(/^❓ 2-qator «Shim»/);
  },
  c1743: async () => {
    const built = await buildFile(xlsx({ name: 'S', rows: [['Name badge holder'], ['Lanyard 100 pcs 5 kg'], ['Clip 200 pcs 3 kg']] }));
    const sheet = (await workbookRows(built.body))!;
    expect(parseGoods(sheet.rows, sheet.covered ?? null).goods.map((g) => g.description)).toEqual(['Name badge holder', 'Lanyard 100 pcs 5 kg', 'Clip 200 pcs 3 kg']);
  },
  c1744: async () => {
    const built = await buildFile(xlsx({ name: 'S', rows: [['Стеллаж металлический'], ['Полка для товаров'], ['Стол 5 шт 100 кг'], ['Стул 30 шт 150 кг']] }));
    const sheet = (await workbookRows(built.body))!;
    expect(parseGoods(sheet.rows, sheet.covered ?? null).goods.map((g) => g.description)).toEqual([
      'Стеллаж металлический',
      'Полка для товаров',
      'Стол 5 шт 100 кг',
      'Стул 30 шт 150 кг',
    ]);
  },
  c1775: async () => {
    expect(pasteItems('Заявка от 15.10.2026\t\nНаименование\t\nТруба ППР 32\t\nКран шаровый 1/2\t\nМуфта 25\t\n').map((i) => i.name)).toEqual([
      'Труба ППР 32',
      'Кран шаровый 1/2',
      'Муфта 25',
    ]);
  },
  // ---- the seam: what the seller hears and what the model is told (R3-C2)
  c1882: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csvLongCell }, 'list.csv');
    expect(a.say).not.toContain('faqat boshi');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    expect(prompt).toContain(CELLS_NOTE);
    expect(prompt).not.toContain('не считай итоги');
  },
  c1883: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csvWithTotal }, 'PL.csv');
    expect(a.say).not.toContain('faqat boshi');
    const prompt = sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET);
    expect(prompt).toContain(CELLS_NOTE);
    expect(prompt).not.toContain('не считай итоги');
    expect(prompt).toContain('TOTAL | 1234 | 5.6');
  },
  c1884: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(
      chatId,
      xlsx(
        ...['Лист A', 'Лист B'].map(
          (sheet): SheetSpec => ({
            name: sheet,
            rows: Array.from({ length: 6 }, (_, k): Cell[] => {
              const i = k + 1;
              return [`${i}`, `${sheet} строка ${i} ` + '面料'.repeat(i === 2 ? 200 : 1), i * 3];
            }),
          }),
        ),
      ),
      'AB.xlsx',
    );
    expect(a.say).not.toContain('⚠️');
    const s = activeIntake(chatId)!;
    expect(sheetsPromptText(s.sheetTexts, s.invoiceTexts, BUDGET)).toContain(CELLS_NOTE);
  },
  c1885: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, consigneeWorkbook(), 'A.xlsx');
    expect(a.say).not.toContain('boshqa varaqlarning faqat boshini');
    const s = activeIntake(chatId)!;
    expect(sheetsPromptText(s.sheetTexts, s.invoiceTexts, BUDGET)).toContain(CELLS_NOTE);
  },
  c1886: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text: csv300 }, 'list.csv');
    expect(a.say).toContain('birinchi 213 qator');
  },
  c1887: async () => {
    const text = () => Array.from({ length: 300 }, (_, k) => { const i = k + 1; return `Ayollar kurtkasi qora rang model ${i};${100 + i};${(i * 1.5).toFixed(1)};0,${(i % 9) + 1}`; }).join('\n');
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text }, 'list.csv');
    expect(a.say).toContain('birinchi 266 qator');
    expect(sheetsPromptText(activeIntake(chatId)!.sheetTexts, [], BUDGET)).toContain('первые 266 строк, файл длиннее');
  },
  c1888: async () => {
    const text = () =>
      Array.from({ length: 20 }, (_, k) => {
        const i = k + 1;
        return i === 5 ? 'Ткань полиэфирная, '.repeat(24).slice(0, 450) + ';55;12' : `Kurtka ${i};${10 + i};${i * 2}`;
      }).join('\n');
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text }, 'list.csv');
    expect(a.say).not.toContain('⚠️');
    const s = activeIntake(chatId)!;
    expect(sheetsPromptText(s.sheetTexts, s.invoiceTexts, BUDGET)).toContain(CELLS_NOTE);
  },
  c1889: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, bigPackingWorkbook(), 'A.xlsx');
    expect(a.say).toContain('boshqa varaqlarning faqat boshini');
    expect(sheetsPromptText([], activeIntake(chatId)!.invoiceTexts, BUDGET)).toContain('[Таблица обрезана');
  },
  c1890: async () => {
    const text = () => ['Наименование;Кол-во;Вес', ...Array.from({ length: 6000 }, (_, k) => `Tovar ${k + 1};${k + 1};${k + 1}`)].join('\n');
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    const a = await forward(chatId, { kind: 'csv', text }, 'list.csv');
    expect(a.say).toContain('500');
    expect(a.say, 'the cap is said, not only «500 ta tovar o‘qildi»').toContain('⚠️');
  },
  c1891: async () => {
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, bigPackingWorkbook(), 'A.xlsx');
    const text = () => Array.from({ length: 300 }, (_, k) => { const i = k + 1; return `Shim erkaklar ${i};${100 + i};${(i * 1.5).toFixed(1)};0,${(i % 9) + 1}`; }).join('\n');
    const b = await forward(chatId, { kind: 'csv', text }, 'list.csv');
    expect(b.say, 'the earlier workbook is named as cut further').toContain('«A.xlsx»');
  },
  c1892: async () => {
    const { chatId } = collection({
      stage: 'material',
      material: ['Kurtka'],
      aiGoods: 'add',
      invoiceGoods: [line('Kurtka', { quantity: 300, weightKg: 150 })],
      pdfs: [{ data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }],
    });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'not_configured' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.stage).toBe('review'));
    expect(ctx.texts().at(-1)).not.toContain('Faqat yozilganidan o‘qildi.');
  },
  c1893: async () => {
    const { chatId } = collection({
      stage: 'material',
      material: ['x'],
      aiGoods: 'add',
      invoiceGoods: [line('Ladies jacket', { quantity: 300, weightKg: 150 }), line('Kurtka', { quantity: 100, weightKg: 50 })],
      pdfs: [{ data: Buffer.from('%PDF-1.4 B'), name: 'B.pdf' }],
    });
    model.analyze.mockResolvedValueOnce(
      reads(
        [
          line('Куртка женская (Ladies jacket)', { quantity: 300, weightKg: 150 }),
          line('Kurtka', { quantity: 250, weightKg: 120 }),
          line('Shim', { quantity: 200, weightKg: 80 }),
        ],
        ['step one', 'step two', 'step three'],
      ),
    );
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    await vi.waitFor(() => expect(activeIntake(chatId)?.analysing).toBeNull());
    const summary = ctx.texts().find((t) => t.includes('Excel’dagi bilan bir xil')) ?? ctx.texts().at(-1)!;
    expect(summary.split('\n').some((l) => l.startsWith('⚠️') && l.includes('Excel’dagi bilan bir xil'))).toBe(true);
    for (const step of ['step one', 'step two', 'step three']) expect(summary).toContain(step);
  },
};

/** Forty one-cell sheets — the fixture's own BIFF builders (c0428). */
function xlsManySheets(n: number): Buffer {
  // xlsSameSheet builds a 5000-row sheet; a sheet list is what is asked here,
  // so a small workbook is made the same way: the fixture exports only what the
  // file cases need, and this one case needs one more shape.
  void xlsSameSheet;
  const record = (type: number, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const bof = () => {
    const d = Buffer.alloc(16);
    d.writeUInt16LE(0x0600, 0);
    d.writeUInt16LE(0x0010, 2);
    return record(0x0809, d);
  };
  const eof = () => record(0x000a, Buffer.alloc(0));
  const label = (text: string) => {
    const d = Buffer.alloc(6);
    const s = Buffer.alloc(3);
    s.writeUInt16LE(text.length, 0);
    s[2] = 1;
    return record(0x0204, Buffer.concat([d, s, Buffer.from(text, 'utf16le')]));
  };
  const bodies = Array.from({ length: n }, (_, i) => Buffer.concat([bof(), label(`x${i}`), eof()]));
  const sheet = (at: number, name: string) => {
    const h = Buffer.alloc(6);
    h.writeUInt32LE(at, 0);
    return record(0x0085, Buffer.concat([h, Buffer.from([name.length, 1]), Buffer.from(name, 'utf16le')]));
  };
  const globals = (offsets: number[]) => Buffer.concat([bof(), ...offsets.map((at, i) => sheet(at, `S${i}`)), eof()]);
  const rel: number[] = [];
  let at = 0;
  for (const b of bodies) {
    rel.push(at);
    at += b.length;
  }
  const base = globals(rel).length;
  const stream = Buffer.concat([globals(rel.map((r) => r + base)), ...bodies]);
  return cfbOf(stream);
}
function cfbOf(stream: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const CFB = require('cfb') as typeof import('cfb');
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, 'Workbook', stream);
  return Buffer.from(CFB.write(container, { type: 'buffer' }) as Uint8Array);
}

describe('scenarios', () => {
  it('every scenario case has its drive, and every drive its case', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(scenarioCases.map((c) => c.id).sort());
  });

  each(scenarioCases)(
    title,
    async (c: ScenarioCase) => {
      await SCENARIOS[c.id]!();
    },
    60_000,
  );
});
