import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_FAILING } from './fixtures/intake-corpus-known';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

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
// The reading job bills each answered reading itself (docs/SAKKIZ-R3.md
// §7.2.10); the ledger is not what these cases are about.
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
// «Bo‘ldi» only ENQUEUES since the reading is a pg-boss job (§7.1): the
// collector cases run the captured job through the one drive helper.
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
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
// Round 2 (docs/SAKKIZ-R2.md §6.8): every machine message for a request goes
// through `sayOnce` — one per request — so the worker cases read it here.
const say = vi.hoisted(() => vi.fn());
vi.mock('@/modules/wms/calc/say-once', () => ({ sayOnce: say }));
// Round 3 (docs/SAKKIZ-R3.md §10.2.2): the worker settles its pass on every
// way out — the real module otherwise, with the settle stood in, so the
// worker cases' job id ('j1') never reaches a database from a unit test.
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  settlePass: vi.fn(),
}));

import {
  AI_READ_FAILURE,
  factsVolumeM3,
  invoiceFacts,
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
import { PASS_FAILED, STOOD_DOWN, attemptStanding, registerCalcPrefillWorker, standDownWords } from '@/modules/wms/calc/jobs';
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
  placeByName,
  sameGoodsLine,
  startIntake,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { migrateIntakeState } from '@/modules/platform/telegram/calc-store';
import {
  clientAnswer,
  handleCalcCallback,
  readCustomerText,
  RETIRED_FILE_STEP,
  readIntakeFile,
  receiveGoodsSheet,
  receivePdf,
  receiveSheetText,
  settleAnalysis,
} from '@/modules/platform/telegram/staff-handlers';
import { applyTableAnswer, deliverNextStep, intakeNextStep, tableEditsSettled, ZONE_OPENING } from '@/modules/platform/telegram/calc-dialog';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { parseTableAnswer, type TableRef } from '@/modules/wms/calc/line-address';
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
  sameGoodsLineCases,
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
  startIntake(chatId, section, { staffId: 'staff-test' });
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
// A file answer carries no keyboard since his 1a (docs/IKKI-ESHIK.md §1.1): asked of one, «null».
const buttonsOf = (reply: object | undefined) =>
  JSON.stringify(
    reply && 'extra' in reply
      ? ((reply as { extra?: Record<string, unknown> }).extra?.reply_markup ?? null)
      : ((reply as { keyboard?: unknown } | undefined)?.keyboard ?? null),
  );

const reads = (goods: Goods, steps: string[] = []) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods },
  steps,
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => {
  resetReadingDrive();
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
    // …and as the calc door takes them: what the sheet states per package, multiplied by the kernel.
    if (c.expected.facts) expect(goodsProblems(invoiceFacts(parsed.goods) as unknown as Line[], c.expected.facts), 'facts').toEqual([]);
    if (c.expected.headerRow !== undefined) expect(parsed.headerRow, 'headerRow').toBe(c.expected.headerRow);
    for (const key of ['grossKg', 'volumeM3', 'shape'] as const) {
      if (c.expected[key] !== undefined) expect(parsed[key], key).toBe(c.expected[key]);
    }
    if (c.expected.dropped !== undefined) expect(parsed.dropped, 'dropped').toEqual(c.expected.dropped);
    const notes = parsed.notes.map((n) => `${n.warn ? '⚠️ ' : ''}${n.text}`);
    for (const said of c.expected.notesInclude ?? []) expect(notes.some((n) => n.includes(said)), `notes ${JSON.stringify(notes)}`).toBe(true);
  });
});

describe('parseGoodsLine', () => {
  each(parseGoodsLineCases)(title, (c) => {
    const read = parseGoodsLine(c.input);
    const e = c.expected;
    const shown = JSON.stringify(read);
    for (const key of ['name', 'tnvedCode', 'quantity', 'weightKg', 'volumeM3', 'measureUnit', 'measureQty', 'cartons', 'unitWords'] as const) {
      if (e[key] !== undefined) expect(read[key], `${key} of ${shown}`).toEqual(e[key]);
    }
    if (e.problemCount !== undefined) expect(read.problems, shown).toHaveLength(e.problemCount);
    for (const two of e.twoReadings ?? []) {
      expect(read.problems, shown).toContainEqual(
        expect.objectContaining({ kind: 'ambiguous', text: two.text, decimal: two.short, thousands: two.long }),
      );
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
    if (e.ambiguous !== undefined) expect(facts.ambiguous, 'ambiguous').toEqual(e.ambiguous);
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

// The same four inputs and expected placements, run through `placeByName`
// (entries without patches): ⏭'s `lineDone` is retired with the per-line
// question (docs/SAKKIZ-R3.md §11, his 1.10 c) — the subject moved, the cases
// did not. An entry placed nowhere (-1) is not a placement.
describe('resolveLineDone (now placeByName)', () => {
  each(resolveLineDoneCases)(title, (c) => {
    const placed = placeByName(c.input.goods, c.input.done.map((d) => ({ ...d, patch: {} }))).entries;
    expect(
      placed.filter((e) => e.index >= 0).map((e) => ({ index: e.index, name: c.input.goods[e.index]!.name })),
    ).toEqual(c.expected);
  });
});

// c1524-c1526's typed numbered lists, ROUTED (docs/SAKKIZ-R3.md §11, P3):
// beside their goods-reader cases, which are unchanged. In the table stage
// over rows that do NOT carry those names, a numbered line is ASKED
// (`name_mismatch`), a carton word is never a name (`no_address`), and no row
// is patched; in the material stage after a reading «N.» is not an address,
// so the list is material — where «➕ Yana ma’lumot» left the seller.
describe('c1524-c1526 routed by the table', () => {
  const ROUTED = ['c1524', 'c1525', 'c1526'];
  const cases = readGoodsLinesCases.filter((c) => ROUTED.includes(c.id));
  const row = (no: number, name: string, needs: TableRef['rows'][number]['needs']) => ({ no, index: no - 1, seq: null, name, needs });
  const rows = [row(1, 'Krossovka', ['juft']), row(2, 'Sumka', ['dona', 'kg']), row(3, 'Monitor', ['dona'])];
  const ref = (stage: TableRef['stage'], r = rows): TableRef => {
    const open = r.map((x) => ({ line: x.no }));
    return { rows: r, open, preferred: open, stage };
  };
  it('all three are here', () => expect(cases.map((c) => c.id)).toEqual(ROUTED));
  for (const c of cases) {
    it(`${c.id} in the table stage: asked, nothing patched`, () => {
      const out = parseTableAnswer(c.input as string, ref('review'));
      expect(out.material).toBe(false);
      for (const seg of out.segments) {
        // A refused segment writes nothing (`planWrites` asks it, never patches).
        expect(seg.refused?.reason, seg.raw).toMatch(/^(name_mismatch|no_address)$/);
      }
    });
    it(`${c.id} in the material stage after a reading: material`, () => {
      const meeting = [row(1, 'Kurtka', ['dona']), row(2, 'Shim', ['dona'])];
      expect(parseTableAnswer(c.input as string, ref('material', meeting))).toEqual({ segments: [], material: true });
    });
  }
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

describe('sameGoodsLine (the add door’s top-up — a stored row, or a new line)', () => {
  each(sameGoodsLineCases)(title, (c) => {
    expect(sameGoodsLine(c.input.kept as never, c.input.read as never)).toBe(c.expected);
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
    // `writes: true` — these cases are customs passes, the only kind before round 2.
    expect(attemptStanding(c.input[0] as Parameters<typeof attemptStanding>[0], c.input[1], true)).toBe(c.expected);
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

/** A cell as the reader's text writes it (`rowLine` in goods-file.ts) — '' for an empty one. */
function renderCell(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return '';
  return String(cell)
    .slice(0, 1200)
    .trim()
    .replace(/\s*[\r\n]+\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
/** The columns a sheet's text keeps (`keptColumns` in goods-file.ts): every column some row writes in. */
function keptOf(rows: readonly (readonly Cell[])[]): number[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, c) => c).filter((c) => rows.some((row) => renderCell(row[c]) !== ''));
}
/**
 * A source row as the reader writes it in its text (`rowLine` in
 * goods-file.ts): a cell per kept column of its sheet, « | », an empty cell
 * an empty slot, no white space at either end (docs/AI-SORAYDI.md §3.2 X0,
 * review JN-14). Re-anchored from «the non-empty cells, joined»: that WAS the
 * defect — an empty cell gave up its place and every later figure slid left.
 */
function renderRow(row: readonly Cell[], columns: readonly number[]): string {
  let out = '';
  let stated = false;
  for (const [k, c] of columns.entries()) {
    const flat = renderCell(row[c]);
    const piece = k > 0 ? ` | ${flat}` : flat;
    if (out.length + piece.length > 2000) break;
    out += piece;
    if (flat) stated = true;
  }
  return stated ? out.trim() : '';
}
/** Every whole row of a spec's sheets, each written to its own sheet's columns. */
function wholeRowsOf(sheets: readonly (readonly (readonly Cell[])[])[]): Set<string> {
  return new Set(sheets.flatMap((rows) => rows.map((row) => renderRow(row, keptOf(rows)))).filter(Boolean));
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
  for (const key of ['grossKg', 'volumeM3'] as const) {
    if (want[key] === undefined) continue;
    const got = read.kind === 'goods' ? read[key] : '-';
    if (got !== want[key]) out.push(`${key} ${JSON.stringify(got)}, want ${JSON.stringify(want[key])}`);
  }
  if (want.dropped !== undefined) {
    const got = read.kind === 'goods' ? read.dropped : '-';
    if (!same(got, want.dropped)) out.push(`dropped ${JSON.stringify(got)}, want ${JSON.stringify(want.dropped)}`);
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
    const sheets =
      spec.kind === 'xlsx' ? spec.sheets.map((sheet) => (typeof sheet.rows === 'function' ? sheet.rows() : (sheet.rows ?? []))) : [sourceRows(spec, csvRows) ?? []];
    const whole = wholeRowsOf(sheets);
    const broken = bodyLines(text).find((l) => !whole.has(l));
    if (broken !== undefined) out.push(`a line is not a whole row: ${JSON.stringify(broken.slice(0, 200))}`);
  }
  const last = bodyLines(text).at(-1) ?? '';
  if (want.lastLine !== undefined && last !== want.lastLine) out.push(`last line ${JSON.stringify(last)}, want ${JSON.stringify(want.lastLine)}`);
  if (want.lastLineStarts !== undefined && !last.startsWith(want.lastLineStarts)) out.push(`last line ${JSON.stringify(last)} does not start ${want.lastLineStarts}`);
  if (want.lastLineEnds !== undefined && !last.endsWith(want.lastLineEnds)) out.push(`last line ${JSON.stringify(last)} does not end ${want.lastLineEnds}`);
  if (want.replyIncludes || want.replyExcludes) {
    const answer = await readIntakeFile(
      { isPhoto: false, body: run.built.body, attachmentId: 'a-file' },
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
  const answer = await readIntakeFile({ isPhoto: false, body: built.body, attachmentId: 'a-file' }, fileName ?? built.fileName, built.contentType, activeIntake(chatId)!);
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
    const out = await real.analyzeIntake({ section: 'rastamojka', salvage: true, text: 'Kurtka', fileCount: 0, timeoutMs });
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

/** A table answer, as a typed message in the table stage. */
const answer = (ctx: ReturnType<typeof fakeCtx>, chatId: bigint, text: string) =>
  applyTableAnswer(ctx, chatId, activeIntake(chatId)!, text, { date: 0, messageId: 900, forwarded: false, replyTo: null });

/**
 * The answer / «Yana ma’lumot» / «Bo‘ldi» walk of R3-C5 (c1375, c1721) — ⏭ is
 * retired (his 1.10 c), so the skip became an ANSWER: the defect these
 * pinned, a record carried by index onto another line after a re-read, is
 * held on answers (docs/SAKKIZ-R3.md §11).
 */
async function answerThenReread(): Promise<{ chatId: bigint; table: string }> {
  const { chatId } = collection({
    stage: 'review',
    clientHintRaw: 'GS777',
    material: ['Kurtka'],
    facts: { goods: [line('Kurtka')] },
  });
  const ctx = fakeCtx();
  await answer(ctx, chatId, '1: 150 kg');
  await handleCalcCallback(ctx, chatId, 'more');
  updateIntake(chatId, { material: ['Kurtka', 'Shim 2 karobka'] });
  model.analyze.mockResolvedValueOnce(reads([line('Shim'), line('Kurtka')]));
  // The re-read half runs as the job (P2, §11): «Bo‘ldi» only enqueues.
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  return { chatId, table: ctx.texts().at(-1)! };
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

/**
 * The «🤖 AI rastamojka» door over a real workbook (docs/AI-SORAYDI.md §3.2): files forwarded, read with the
 * model answering NOTHING (every figure is the file's or the kernel's), then each typed table answer
 * written. What the INSERT would take — the cube, the brutto — and the table, after every step.
 */
async function aiDoorWalk(section: IntakeState['section'], files: [FileSpec, string][], answers: string[] = []) {
  const { chatId } = collection({ ai: true, stage: 'material', material: [] }, section);
  for (const [spec, name] of files) {
    await forward(chatId, spec, name);
    updateIntake(chatId, { fileCount: activeIntake(chatId)!.fileCount + 1 });
  }
  model.analyze.mockResolvedValueOnce(reads([]));
  const read = await analyzeCollected(activeIntake(chatId)!);
  updateIntake(chatId, { ...read, answered: undefined } as never);
  const ctx = fakeCtx();
  const said = activeIntake(chatId)!.fileNotes ?? [];
  const intake = await import('@/modules/wms/calc/intake');
  const { nameWordFor } = await import('@/modules/wms/calc/line-address');
  const now = () => {
    const s = activeIntake(chatId)!;
    return {
      state: s,
      cube: factsVolumeM3(s.facts as never),
      weightKg: s.facts.weightKg ?? null,
      table: intakeNextStep(s, new Map(), intake, { nameWord: nameWordFor, aiAvailable: true }).text,
    };
  };
  const steps = [now()];
  for (const text of answers) {
    await answer(ctx, chatId, text);
    await tableEditsSettled();
    steps.push(now());
  }
  return { chatId, said, steps };
}
const SCENARIOS: Record<string, () => Promise<void>> = {
  // ---- «a second invoice arrived»: the open question survives the answer (c0)
  c0000: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'client', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['client', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0001: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'client', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['client', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0002: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'section', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['section', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0003: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'section', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['section', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0004: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'material', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['material', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0005: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'review', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['review', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0006: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A collection hydrated holding the old question is resolved before it reaches memory, its
    // stage untouched, and the old button only says why it does nothing.
    const { chatId, state } = collection({ stage: 'review', invoiceGoods: [line('Kurtka')], pendingInvoice: { goods: [line('Shim')], label: '«B.xlsx»', texts: [] } });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.pendingInvoice]).toEqual(['review', null]);
    expect(migrated.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(migrated.fileNotes).toContain('📄 «B.xlsx» — 1 ta yangi tovar qo‘shildi.');
    updateIntake(chatId, migrated);
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0007: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    const { chatId } = collection({ stage: 'client' });
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«A.xlsx»', [line('Kurtka')])).patch);
    const b = receiveGoodsSheet(activeIntake(chatId)!, mapped('«B.xlsx»', [line('Shim')]));
    expect(buttonsOf(b)).toBe('null');
    updateIntake(chatId, b.patch);
    expect(activeIntake(chatId)!.stage).toBe('client');
    expect(activeIntake(chatId)!.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
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
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // Three factories' lists: each further file's new rows are ADDED and the file says how many.
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
    const s = activeIntake(chatId)!;
    expect(s.pendingInvoice).toBeNull();
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', '<B line 1>', '<B line 2>', '<B line 3>', 'Poyabzal']);
    expect(says[1]).toContain('📄 «B.xlsx» — 3 ta yangi tovar qo‘shildi.');
    expect(says[2]).toContain('📄 «C.xlsx» — 1 ta yangi tovar qo‘shildi.');
    for (const say of says) expect(say).not.toContain('Nima qilamiz?');
    expect(s.fileNotes).toEqual(expect.arrayContaining(['📄 «B.xlsx» — 3 ta yangi tovar qo‘shildi.', '📄 «C.xlsx» — 1 ta yangi tovar qo‘shildi.']));
  },
  c0009: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // There is no «o‘rniga» any more: nothing a later file states replaces another file's rows.
    const { chatId } = collection({ stage: 'material' });
    for (const [label, goods] of [
      ['«A.xlsx»', [line('Kurtka'), line('Shim')]],
      ['«B.xlsx»', [line('<B line 1>'), line('<B line 2>'), line('<B line 3>')]],
      ['«C.xlsx»', [line('Poyabzal')]],
    ] as const) {
      updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped(label, [...goods])).patch);
    }
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(activeIntake(chatId)!.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', '<B line 1>', '<B line 2>', '<B line 3>', 'Poyabzal']);
  },
  c0010: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // Every press of an old keyboard is the same stale answer, and changes nothing.
    const { chatId } = collection({ stage: 'material' });
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«A.xlsx»', [line('Kurtka')])).patch);
    updateIntake(chatId, receiveGoodsSheet(activeIntake(chatId)!, mapped('«B.xlsx»', [line('Shim')])).patch);
    const ctx = fakeCtx();
    const before = JSON.stringify(activeIntake(chatId));
    await handleCalcCallback(ctx, chatId, 'inv_add');
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP, RETIRED_FILE_STEP]);
    expect(activeIntake(chatId)!.pendingInvoice).toBeNull();
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  c0011: async () => {
    const { state } = collection({ stage: 'material', material: ['Kurtka'], analysing: 'tok' });
    const snapshot: IntakeState = { ...state, material: ['Kurtka'], fileCount: 0, lineAnswers: [] };
    const live: IntakeState = {
      ...snapshot,
      lineAnswers: [{ index: 0, name: 'Kurtka', patch: { weightKg: 150 } }],
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
    // Re-anchored (P2, §11): the press enqueues and the job settles the
    // token — the claim («never «Tahlil davom etmoqda» for ever») holds.
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.analysing).toBeNull();
    await handleCalcCallback(ctx, chatId, 'more');
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.analysing).toBeNull();
    expect(ctx.texts()).not.toContain('⏳ Tahlil davom etmoqda — natijani kuting.');
    expect(model.analyze).toHaveBeenCalledTimes(2);
  },
  // ---- «boshqa zavodning tovarlarimi?» in either order (c4)
  c0016: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // A model-read file beside an Excel takes the add path (M3): no question, no keyboard, and
    // «Bo‘ldi» starts the reading instead of waiting for an answer.
    const base = { stage: 'material' as const, material: ['x'], invoiceGoods: [line('Factory A chair'), line('Factory A table')], aiGoods: null };
    const pdf = receivePdf(collection(base).state, { attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }, '«B.pdf»');
    const sheet = receiveSheetText(collection(base).state, '«B.csv»', { text: '[CSV]\nB blender | 5', cut: false, cellsCut: false }, fitRows);
    for (const answer of [pdf, sheet]) {
      expect(answer.patch.aiGoods).toBe('add');
      expect(answer.say).not.toContain('boshqa zavodning tovarlarimi?');
      expect(buttonsOf(answer)).toBe('null');
      const { chatId } = collection({ ...base, ...answer.patch });
      const ctx = fakeCtx();
      await handleCalcCallback(ctx, chatId, 'done');
      expect(ctx.texts()).not.toContain(OTHER_ASK);
      expect(ctx.texts().at(-1)).toBe('⏳ AI o‘qiyapti… (3 daqiqagacha)');
    }
  },
  c0017: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // …and in the reverse order: an Excel after a PDF is the goods list, the PDF the add path.
    const { state } = collection({ stage: 'material', invoiceGoods: [], pdfs: [{ attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }], aiGoods: null });
    const answer = receiveGoodsSheet(state, mapped('«A.xlsx»', [line('Kurtka')]));
    expect(answer.patch.aiGoods).toBe('add');
    expect(buttonsOf(answer)).toBe('null');
    expect(answer.say).not.toContain('boshqa zavodning tovarlarimi?');
  },
  c0018: async () => {
    const { chatId } = collection({ stage: 'material', material: ['Kurtka'], analysing: null });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect([STALE, NOT_READ]).toContain(ctx.texts().at(-1));
    expect(activeIntake(chatId)!.stage).not.toBe('review');
    await handleCalcCallback(ctx, chatId, 'save');
    expect(ctx.texts().at(-1)).toBe(NOT_READ);
  },
  c0019: async () => {
    const { chatId } = collection({ stage: 'client', analysing: null });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect([STALE, NOT_READ]).toContain(ctx.texts().at(-1));
    expect(activeIntake(chatId)!.stage).not.toBe('review');
    await handleCalcCallback(ctx, chatId, 'save');
    expect(ctx.texts().at(-1)).toBe(NOT_READ);
  },
  c0020: async () => {
    // 'question' is a dead value (R3): the table stage during a re-read.
    const { chatId } = collection({ stage: 'review', analysing: 'token', facts: { goods: [line('Kurtka')] } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
  },
  c0021: async () => {
    // RETIRED by his 1.10 c (docs/SAKKIZ-R3.md §11): the table has no
    // per-line skip, so ⏭ is «Bu tugma eskirgan» everywhere — a line left ⚠️
    // at «Tasdiqlash» is the VED's. Nothing moves.
    const { chatId } = collection({
      stage: 'review',
      analysing: null,
      facts: { goods: [line('Kurtka'), line('Shim')] } as IntakeState['facts'],
    });
    const before = JSON.stringify(activeIntake(chatId));
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
    expect(JSON.stringify(activeIntake(chatId))).toBe(before);
  },
  // ---- 🔁 drops the replaced workbook's other sheets too (c7)
  c0022: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // Two workbooks of different goods: both lists are kept — nothing a later file states drops an
    // earlier one in silence — and both workbooks' other sheets reach the model's totals heading.
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(
      chatId,
      xlsx(
        { name: 'Invoice', rows: [['Description', 'Qty'], ['WRONG jackets', 10]] },
        { name: 'Packing list', rows: [['Packing list for WRONG jackets'], ['TOTAL G.W.', '9999 KGS'], ['TOTAL CBM', 77]] },
      ),
      'WRONG.xlsx',
    );
    const right = await forward(
      chatId,
      xlsx(
        { name: 'Invoice', rows: [['Description', 'Qty'], ['RIGHT shoes', 10], ['RIGHT shoes B', 20]] },
        { name: 'Packing list', rows: [['TOTAL G.W.', '1200 KGS'], ['TOTAL CBM', 8]] },
      ),
      'RIGHT.xlsx',
    );
    expect(right.say).toContain('📄 «RIGHT.xlsx» — 2 ta yangi tovar qo‘shildi.');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['WRONG jackets', 'RIGHT shoes', 'RIGHT shoes B']);
    const texts = s.invoiceTexts.map((t) => t.text).join('\n');
    expect(texts).toContain('1200 KGS');
    expect(texts).toContain('9999 KGS');
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(s);
    const prompt = promptOf(lastCall());
    expect(prompt).toContain('9999 KGS');
    expect(prompt).toContain('1200 KGS');
  },
  c0023: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
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
    // Both workbooks' totals sheets are kept without a press.
    const texts = activeIntake(chatId)!.invoiceTexts.map((t) => t.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('TOTAL G.W. A');
    expect(texts[1]).toContain('TOTAL G.W. B');
  },
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
    say.mockReset();
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('touched');
    await handler([prefillJob(1)]);
    const texts = say.mock.calls.map((call) => (call[2] as { text: string }).text);
    // Exactly one message, and that one (R2 late pass, review P1-R8): the two
    // old assertions held over an EMPTY list too, so a stand-down that fell
    // silent on a retry stayed green.
    expect(texts).toEqual([PASS_FAILED]);
  },
  c0221: async () => {
    say.mockReset();
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('touched');
    await handler([prefillJob(0)]);
    expect(say).toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.touched }));
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
    // The reading is a job (P2, §11); the keyboard read is the one it sent.
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.stage).toBe('review');
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
    // The reading is a job (P2, §11).
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.stage).toBe('review');
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
    // The day's budget is written from the collection's bills at the
    // landing; a paid read that failed must still carry what it cost.
    // Re-anchored (docs/SAKKIZ-R2.md §8.2.7, his 2.9 c): the reading names
    // every ANSWERED attempt in `answered`. Re-anchored again (SAKKIZ-R3
    // §7.2.10, P2): the reading JOB bills `answered` the moment the model
    // answered, so the collection no longer appends to `usages` — the claim
    // (a failed paid read still carries what it cost) is on `answered`, and
    // that it is COUNTED against the day's budget is proven where the job
    // writes the row: intake-billing.integration.test.ts, «a reading that
    // answered (cut, with usage)…» (review spec-7).
    const usage = { model: 'm', inputTokens: 40_000, outputTokens: 16_000 };
    const { state } = collection({ stage: 'material', material: ['Kurtka 300 dona 150 kg'] });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'truncated', usage, answered: [usage] });
    const out = await analyzeCollected(state);
    expect(out.answered).toEqual([usage]);
  },
  // ---- the fixer's collector pins (#0-#7)
  c0768: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    const { chatId } = collection({ stage: 'client' });
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    const b = await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Shim', 5]] }), 'B.xlsx');
    expect(b.say).not.toContain('Nima qilamiz?');
    const s = activeIntake(chatId)!;
    expect(s.stage).toBe('client');
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    const answer = clientAnswer(s, 'GS777', await readCustomerText('GS777', 'GS'));
    expect(answer.kind).toBe('customer');
    updateIntake(chatId, answer.patch);
    expect(activeIntake(chatId)!.clientHintRaw).toBe('GS777');
    expect(activeIntake(chatId)!.material).not.toContain('GS777');
  },
  c0769: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // The podklyuch door's «qayerdan?» stays open across two files: nothing about them is asked.
    const { chatId } = collection({ stage: 'section', ai: true, route: null }, 'podklyuch');
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Shim', 5]] }), 'B.xlsx');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    const s = activeIntake(chatId)!;
    expect([s.stage, s.route]).toEqual(['section', null]);
    await handleCalcCallback(ctx, chatId, 'done');
    // Re-anchored by §1.6 (2026-11-08): the zone question is ONE message, counting what arrived,
    // redrawn as the last one — never a second «Avval … tanlang.».
    await keptLastSettled();
    // (The helper reads the files without counting them, so the question is still its opening.)
    expect(ctx.texts().at(-1)).toBe(ZONE_OPENING);
  },
  c0770: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // An open «boshqa zavodmi?» hydrated at deploy is the add path; its button changes nothing.
    const { chatId, state } = collection({ stage: 'client', aiGoods: 'ask', invoiceGoods: [line('Kurtka')] });
    const migrated = migrateIntakeState(state);
    expect([migrated.stage, migrated.aiGoods]).toEqual(['client', 'add']);
    updateIntake(chatId, migrated);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'other_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(activeIntake(chatId)!.stage).toBe('client');
  },
  c0771: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
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
    expect(says[2]).toContain('📄 «C.xlsx» — 2 ta yangi tovar qo‘shildi.');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['A1', 'A2', 'B1', 'C1', 'C2']);
    expect(s.invoiceTexts.map((t) => t.text)).toEqual(['[PL A]\nA | 1', '[PL B]\nB | 1', '[PL C]\nC | 1']);
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_add');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
  },
  c0772: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
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
    expect(activeIntake(chatId)!.invoiceGoods?.map((g) => g.name)).toEqual(['A1', 'B1', 'C1']);
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    expect(activeIntake(chatId)!.fileNotes.join('\n')).not.toContain('o‘rniga olindi');
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
    // The job settles it (P2, §11): the same three facts.
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.stage).toBe('review');
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(activeIntake(chatId)!.analysing).toBeNull();
    expect(buttonsOf(ctx.replies.at(-1))).toContain('c:save');
  },
  c0775: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10]] }), 'A.xlsx');
    const pdf = receivePdf(activeIntake(chatId)!, { attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }, '«B.pdf»');
    updateIntake(chatId, pdf.patch);
    expect(activeIntake(chatId)!.aiGoods).toBe('add');
    expect(pdf.say).toBe('📄 «B.pdf» — AI o‘qiydi.');
    expect(buttonsOf(pdf)).toBe('null');
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(ctx.texts()).not.toContain(OTHER_ASK);
    expect(ctx.texts().at(-1)).toBe('⏳ AI o‘qiyapti… (3 daqiqagacha)');
  },
  c0776: async () => {
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // The model is shown the Excel's list without a press, and only on the add path.
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, csv('X-headerless'), 'X.csv');
    const a = await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty'], ['Kurtka', 10], ['Shim', 5]] }), 'A.xlsx');
    expect(activeIntake(chatId)!.aiGoods).toBe('add');
    expect(a.say).not.toContain('boshqa zavodning tovarlarimi?');
    model.analyze.mockResolvedValueOnce(reads([]));
    await analyzeCollected(activeIntake(chatId)!);
    expect(lastCall().knownGoods).toEqual(['Kurtka', 'Shim']);
    // …and only on «add»: a hydrated «context» was the seller's own answer.
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
    // Re-anchored by his 1a (docs/IKKI-ESHIK.md §1.1, 2026-11-08): the bot no longer asks about a
    // second file — the reviewer's sentence pinned the question; this pins its ABSENCE and the rule
    // that replaced it.
    // Two workbooks of different goods are both kept, and so are both totals sheets — in order.
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
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'inv_replace');
    expect(ctx.texts()).toEqual([RETIRED_FILE_STEP]);
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Wrong1', 'Right1']);
    expect(fitSheetTexts([...s.sheetTexts, ...s.invoiceTexts].map((t) => t.text.trim()), BUDGET).text).toBe(
      '[CSV]\nX-headerless\n\n[Packing list]\nTOTAL G.W. | 9999\n\n[Packing list]\nTOTAL G.W. | 1500',
    );
  },
  c0789: async () => {
    expect(STOOD_DOWN.unfinished).toBe(PASS_FAILED);
    // Round 2: the words are chosen by the job's queue (§2.8) — the customs
    // map stays `STOOD_DOWN`, and the stand-down still SPEAKS. Re-anchored
    // (R2 late pass, concurrency-9): the choice moved into `standDownWords`,
    // which the worker asks, so the customs answer is asked of THAT.
    expect(source('src/modules/wms/calc/jobs.ts')).toContain('const said = standDownWords(standing, writes);');
    expect(standDownWords('unfinished', true)).toBe(PASS_FAILED);
    expect(standDownWords('touched', true)).toBe(STOOD_DOWN.touched);
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
    // Re-anchored onto ANSWERS (⏭ retired, his 1.10 c): line 1 answered is
    // written back to the stored collection, and what is still missing names
    // line 2 — never line 1 again.
    const { chatId } = collection({ stage: 'review', facts: { goods: [line('Kurtka'), line('Shim')] } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await answer(ctx, chatId, '1: 150 kg');
    expect(activeIntake(chatId)!.lineAnswers).toMatchObject([{ index: 0, name: 'Kurtka', patch: { weightKg: 150 } }]);
    const echo = ctx.texts().find((t) => t.startsWith('✅ 1-qator «Kurtka»'))!;
    expect(echo).toContain('⚠️ Yana 3 ta: 2-qator, umumiy brutto, umumiy hajm.');
    expect(echo).not.toContain('1-qator,');
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
    // A file answer has no keyboard at all since his 1a (docs/IKKI-ESHIK.md §1.1).
    expect(Object.keys(a).sort()).toEqual(['patch', 'say']);
    expect(s.invoiceTexts.map((t) => t.text).join('\n')).toContain('TOTAL G.W. | 150 KGS');
  },
  c0803: async () => {
    // RETIRED by his 1.10 c: the totals are a table row, not a question, so
    // there is no ⏭ to accept under them — the press is «eskirgan» and the
    // ⚠️ brutto row stays for a typed «jami … kg» (or the VED).
    const { chatId } = collection(
      { stage: 'review', analysing: null, ai: true, facts: { goods: [line('Kurtka', { quantity: 300 })] } as IntakeState['facts'] },
      'podklyuch',
    );
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
    expect(activeIntake(chatId)!.stage).toBe('review');
    await deliverNextStep(ctx, chatId, activeIntake(chatId)!);
    expect(ctx.texts().at(-1)).toContain('⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
  },
  c0804: async () => {
    say.mockReset();
    const { handler } = await prefillWorker();
    prefill.standing.mockResolvedValue('ok');
    prefill.run.mockResolvedValue({ ok: false, reason: 'stand-in' });
    await handler([prefillJob(1)]);
    expect(prefill.run).toHaveBeenCalled();
  },
  c0805: async () => {
    // The file reader moved to calc-files.ts (docs/SAKKIZ-R3.md K5).
    const handlers = source('src/modules/platform/telegram/calc-files.ts');
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
    // The add path without a press (his 1a, docs/IKKI-ESHIK.md §1.2.2, M3).
    updateIntake(chatId, receivePdf(activeIntake(chatId)!, { attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }, '«B.pdf»').patch);
    expect(activeIntake(chatId)!.aiGoods).toBe('add');
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
    // The add path without a press (his 1a, docs/IKKI-ESHIK.md §1.2.2, M3).
    updateIntake(chatId, receivePdf(activeIntake(chatId)!, { attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }, '«B.pdf»').patch);
    expect(activeIntake(chatId)!.aiGoods).toBe('add');
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
    expect(wholeRowsOf([csvRows(csv300())]).has(shown), shown).toBe(true);
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
    // «;TOTAL;;;;1234;5.6»: seven cells, the first and the three in the middle empty (X0, review JN-14).
    expect(prompt).toContain('| TOTAL |  |  |  | 1234 | 5.6');
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
    // Re-anchored onto ANSWERS: the answered Kurtka lands on its own line
    // after the re-read reorders, and only Shim is open — on the plain door's
    // summary a gap is ℹ️, the VED's to ask (docs/IKKI-ESHIK.md §2.1, re-anchored 2026-11-08).
    const { chatId, table } = await answerThenReread();
    expect(table).toContain('ℹ️ 1. Shim');
    expect(table).toContain('✅ 2. Kurtka — 150 kg');
    expect(activeIntake(chatId)!.lineAnswers).toMatchObject([{ index: 1, name: 'Kurtka' }]);
  },
  c1376: async () => {
    // Re-anchored onto ANSWERS: two lines answered, the stored collection
    // remembers both, and what is missing never names them again.
    const { chatId } = collection({
      stage: 'review',
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf'), line('Shapka')] } as IntakeState['facts'],
    });
    const ctx = fakeCtx();
    await answer(ctx, chatId, '1: 150 kg');
    await answer(ctx, chatId, '2: 20 kg');
    expect(activeIntake(chatId)!.lineAnswers).toMatchObject([
      { index: 0, name: 'Kurtka' },
      { index: 1, name: 'Shim' },
    ]);
    expect(ctx.texts().filter((t) => t.startsWith('✅ 2-qator «Shim»')).at(-1)).toContain('⚠️ Yana 4 ta: 3-qator, 4-qator, umumiy brutto, umumiy hajm.');
  },
  c1377: async () => {
    // RETIRED with MAX_QUESTION_ROUNDS (his 1.10 c): the table has no rounds,
    // so nothing replaces it — ⏭ is «eskirgan» and the table stays.
    const { chatId } = collection({
      stage: 'review',
      facts: { goods: [line('Kurtka'), line('Shim'), line('Sharf'), line('Shapka')] } as IntakeState['facts'],
    });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'skip');
    expect(ctx.texts().at(-1)).toBe(STALE);
    expect(activeIntake(chatId)).toMatchObject({ stage: 'review', lineAnswers: [] });
  },
  c1545: async () => {
    expect(goodsProblems(pasteItems('Kurtka 6201 93 0000 300 dona 12.5$') as unknown as Line[], { rows: [{ tnvedCode: '6201930000', quantity: 300 }], count: 1 })).toEqual([]);
  },
  c1721: async () => {
    const { chatId, table } = await answerThenReread();
    expect(table).not.toContain('⚠️ 2. Kurtka');
    expect(activeIntake(chatId)!.facts.goods?.[1]).toEqual(line('Kurtka', { weightKg: 150 }));
    expect(activeIntake(chatId)!.lineAnswers).toMatchObject([{ index: 1, name: 'Kurtka' }]);
  },
  c1722: async () => {
    // Re-anchored onto ANSWERS: a reading WITHOUT the line keeps the answer
    // (unplaced, -1), and the retry that brings the line back brings its
    // figure with it — Shim is the first ⚠️.
    const three = [line('Kurtka'), line('Shim'), line('Sharf')];
    const { chatId } = collection({ stage: 'review', material: ['yana fayl bor'], facts: { goods: three } as IntakeState['facts'] });
    const ctx = fakeCtx();
    await answer(ctx, chatId, '1: 150 kg');
    await handleCalcCallback(ctx, chatId, 'more');
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'timeout' });
    // Both readings run as the job (P2, §11).
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    model.analyze.mockResolvedValueOnce(reads(three));
    await handleCalcCallback(ctx, chatId, 'reread');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.analysing).toBeNull();
    expect(activeIntake(chatId)!.facts.goods?.[0]).toEqual(line('Kurtka', { weightKg: 150 }));
    const table = ctx.texts().at(-1)!;
    expect(table).toContain('✅ 1. Kurtka — 150 kg');
    // The plain door's summary marks a gap ℹ️ (docs/IKKI-ESHIK.md §2.1, re-anchored 2026-11-08).
    expect(table).toContain('ℹ️ 2. Shim');
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
    // «;TOTAL;;;;1234;5.6»: seven cells, the first and the three in the middle empty (X0, review JN-14).
    expect(prompt).toContain('| TOTAL |  |  |  | 1234 | 5.6');
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
      pdfs: [{ attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }],
    });
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'not_configured' });
    const ctx = fakeCtx();
    // Reached through the job (P2, §11): the tail read is the one it sent.
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.stage).toBe('review');
    expect(ctx.texts().at(-1)).not.toContain('Faqat yozilganidan o‘qildi.');
  },
  c1893: async () => {
    const { chatId } = collection({
      stage: 'material',
      material: ['x'],
      aiGoods: 'add',
      invoiceGoods: [line('Ladies jacket', { quantity: 300, weightKg: 150 }), line('Kurtka', { quantity: 100, weightKg: 50 })],
      pdfs: [{ attachmentId: 'a-pdf-b', name: 'B.pdf', bytes: 10 }],
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
    // Reached through the job (P2, §11).
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
    expect(activeIntake(chatId)?.analysing).toBeNull();
    const summary = ctx.texts().find((t) => t.includes('Excel’dagi bilan bir xil')) ?? ctx.texts().at(-1)!;
    // Re-anchored by docs/IKKI-ESHIK.md §1.2.4: taking the same goods once is the designed outcome,
    // so its line loses the ⚠️; the model's additions are counted on their own line.
    expect(summary.split('\n').some((l) => l.startsWith('📄') && l.includes('Excel’dagi bilan bir xil — bir marta olindi'))).toBe(true);
    expect(summary).toContain('🤖 AI o‘qigan fayllardan 1 ta yangi tovar qo‘shildi (2 tasi Excel’da bor edi).');
    for (const step of ['step one', 'step two', 'step three']) expect(summary).toContain(step);
  },
  // ---- two files, no question (his 1a, docs/IKKI-ESHIK.md §1.2.2, §5)
  c2449: async () => {
    // INT-4: two factories' invoices — a same-named row whose figures disagree is ADDED and named;
    // a row read again is taken once; nothing is asked.
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(chatId, xlsx({ name: 'Invoice', rows: [['Description', 'Qty', 'Weight, kg'], ['Kurtka', 300, 150], ['Shim', 100, null]] }), 'A.xlsx');
    const b = await forward(
      chatId,
      xlsx({ name: 'Invoice', rows: [['Description', 'Qty', 'Weight, kg'], ['Kurtka', 200, 90], ['Shim', 100, null], ['Sumka', 50, null]] }),
      'B.xlsx',
    );
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => [g.name, g.quantity])).toEqual([
      ['Kurtka', 300],
      ['Shim', 100],
      ['Kurtka', 200],
      ['Sumka', 50],
    ]);
    expect(b.say).toContain('📄 «B.xlsx» — 1 tasi ro‘yxatda bor edi, 2 ta yangi tovar qo‘shildi.');
    // The held figure in the read's own unit is bare, as §1.2.2's sentence has it (review PF-SPEC-8).
    expect(b.say).toContain(
      '📄 «B.xlsx» — «Kurtka» 200 dona: birinchi faylda ham «Kurtka» 300 — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).',
    );
    expect(b.say).not.toContain('Nima qilamiz?');
    expect(s.pendingInvoice).toBeNull();
    expect(s.fileNotes).toEqual(expect.arrayContaining([expect.stringContaining('ikkalasi olindi')]));
  },
  c2450: async () => {
    // M1 a: a packing list FIRST, then the invoice — the invoice takes the goods role, the packing
    // list's rows become its totals (the brutto from the gross column only, M2) and the invoice
    // rows' missing netto. File order never decides which counts land.
    const { chatId } = collection({ stage: 'material', material: ['x'] });
    await forward(
      chatId,
      xlsx({
        name: 'Packing',
        rows: [
          ['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'G.W.(kg)', 'CBM'],
          ['Kurtka', 300, 10, 150, 165, 1.2],
          ['Shim', 100, 4, 40, 46, 0.4],
        ],
      }),
      'P.xlsx',
    );
    expect(activeIntake(chatId)!.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    const inv = await forward(
      chatId,
      // «Unit price», as the case says — the commonest PI header, whose price once took the UNIT
      // column and sent every count to the note (review PF-SPEC-1).
      xlsx({ name: 'Invoice', rows: [['Description', 'Qty', 'Unit price', 'Amount'], ['Kurtka', 300, 12.5, 3750], ['Shim', 100, 5, 500]] }),
      'I.xlsx',
    );
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => [g.name, g.quantity, g.weightKg, g.amount])).toEqual([
      ['Kurtka', 300, 150, 3750],
      ['Shim', 100, 40, 500],
    ]);
    expect(s.fileTotals).toMatchObject({ weightKg: 211, volumeM3: 1.6, weightNetto: false });
    expect(inv.say).toContain(
      '📄 «P.xlsx» — o‘sha tovarlar: qatorlar «I.xlsx» dan, bundan faqat umumiy brutto va kub olindi. 2 ta qatorga netto og‘irlik shu fayldan yozildi (yozilgan og‘irlikka tegilmadi).',
    );
    // The packing list's own rows join the model's totals-only sheets.
    expect(s.invoiceTexts.map((t) => t.text).join('\n')).toContain('G.W.(kg)');
    // …and the reading takes its totals: never asked again.
    model.analyze.mockResolvedValueOnce(reads([]));
    const read = await analyzeCollected(s);
    expect([read.facts.weightKg, read.facts.volumeM3]).toEqual([211, 1.6]);
  },
  c2904: async () => {
    // sheets-08's collector pin (docs/FAYL-OQISH.md §4.6): a lone Excel whose model answer is
    // count-only translations of every row names nothing — typed text beside it, or a header-less
    // cover sheet in the workbook, is model-read material that can carry other goods, and still
    // every translated line meets one row by its count.
    const invoice: Cell[][] = [['Description', 'Qty'], ['Ladies jacket', 300], ['Mens jacket', 240], ['Kids pants', 400]];
    const cover: Cell[][] = [['YIWU XINGHUA IMPORT & EXPORT CO., LTD'], ['PROFORMA INVOICE'], ['To: GSR LOGISTICS']];
    const translated = [line('Куртка женская', { quantity: 300 }), line('Куртка мужская', { quantity: 240 }), line('Брюки детские', { quantity: 400 })];
    for (const [material, book] of [
      [['GS777'], xlsx({ name: 'Invoice', rows: invoice })],
      [[], xlsx({ name: 'Cover', rows: cover }, { name: 'Invoice', rows: invoice })],
    ] as const) {
      const { chatId } = collection({ stage: 'material', material: [...material] });
      await forward(chatId, book, 'inv.xlsx');
      const s = activeIntake(chatId)!;
      expect(s.invoiceGoods?.map((g) => g.name)).toEqual(['Ladies jacket', 'Mens jacket', 'Kids pants']);
      model.analyze.mockResolvedValueOnce(reads(translated));
      const calls = model.analyze.mock.calls.length;
      const read = await analyzeCollected(s);
      // The model read (the case is about its answer, not about not asking it).
      expect(model.analyze.mock.calls.length).toBe(calls + 1);
      expect(read.notes).toEqual([]);
      expect(read.facts.goods?.map((g) => g.name)).toEqual(['Ladies jacket', 'Mens jacket', 'Kids pants']);
    }
  },
  c4520: async () => {
    // review seams-3: a lone invoice whose every line states its cube gives NO stated cube — the
    // current lines' Σ «qatorlardan», which a row the seller corrects at the table moves.
    const head = ['No.', 'Description', 'QTY(PCS)', 'Unit price (USD)', 'Amount (USD)', 'CBM'];
    const rows: Cell[][] = [head, [1, 'Ladies jacket', 200, 6.5, 1300, 1.2], [2, 'Kids toy plastic', 480, 1.5, 720, 1.1], [3, 'LED lamp 50W', 300, 3, 900, 1.5]];
    const { steps } = await aiDoorWalk('podklyuch', [[xlsx({ name: 'Sheet1', rows }), 'ci.xlsx']], ['2: 2.1 m3']);
    const [before, after] = steps as [(typeof steps)[number], (typeof steps)[number]];
    // 1.2 + 1.1 + 1.5 = 3.8; after «2: 2.1 m3», 1.2 + 2.1 + 1.5 = 4.8 — by hand.
    expect(before.state.facts.volumeM3 ?? null).toBeNull();
    expect(before.cube).toBe(3.8);
    expect(before.table).toContain('✅ Hajm: 3.8 m³ (qatorlardan)');
    expect(after.cube).toBe(4.8);
    expect(after.table).toContain('✅ Hajm: 4.8 m³ (qatorlardan)');
  },
  c4521: async () => {
    // review seams-2: the asked columns' Σ (36 kg / 0.18 m³) is no shipment total; after the seller
    // answers every row the cube is the rows' 0.5 + 1.2 + 2.1 = 3.8 and the brutto is still his to give.
    const rows: Cell[][] = [
      ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'G.W.(KGS)', 'CBM'],
      [1, 'Ladies jacket', 200, 10, 12, 0.05],
      [2, 'Kids toy plastic', 480, 20, 13, 0.06],
      [3, 'LED lamp 50W', 300, 30, 11, 0.07],
      ['TOTAL', null, 980, 60, 36, 0.18],
    ];
    const { steps } = await aiDoorWalk('podklyuch', [[xlsx({ name: 'Sheet1', rows }), 'pl.xlsx']], ['1: 120 kg 0.5 m3', '2: 260 kg 1.2 m3', '3: 330 kg 2.1 m3']);
    const before = steps[0]!;
    const after = steps.at(-1)!;
    expect(before.weightKg).toBeNull();
    expect(before.state.facts.volumeM3 ?? null).toBeNull();
    expect(before.table).not.toContain('36 kg');
    expect(after.cube).toBe(3.8);
    expect(after.weightKg).toBeNull();
    expect(after.table).not.toContain('0.18');
  },
  c4522: async () => {
    // review seams-4: the same packing list beside its invoice (ci then pl): its asked columns' Σ is
    // no «✅ brutto / kub» either, and the receipt names both columns.
    const ci: Cell[][] = [
      ['No.', 'Description', 'QTY', 'Unit price', 'Amount', 'N.W.(KGS)'],
      [1, 'Ladies jacket', 200, 6.5, 1300, 100],
      [2, 'Kids toy plastic', 480, 1.5, 720, 240],
      [3, 'LED lamp 50W', 300, 3, 900, 300],
    ];
    const pl: Cell[][] = [
      ['No.', 'Description', 'QTY', 'CTNS', 'G.W.(KGS)', 'CBM'],
      [1, 'Ladies jacket', 200, 10, 12, 0.05],
      [2, 'Kids toy plastic', 480, 20, 13, 0.06],
      [3, 'LED lamp 50W', 300, 30, 11, 0.07],
      ['TOTAL', null, 980, 60, 36, 0.18],
    ];
    const { said, steps } = await aiDoorWalk('podklyuch', [
      [xlsx({ name: 'Sheet1', rows: ci }), 'ci.xlsx'],
      [xlsx({ name: 'Sheet1', rows: pl }), 'pl.xlsx'],
    ]);
    const now = steps[0]!;
    expect(now.weightKg).toBeNull();
    expect(now.cube).toBeNull();
    expect(now.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(now.table).toContain('umumiy hajmi (kub) — yozilmagan');
    expect(said.join('\n')).toContain(
      '«G.W.(KGS)» va «CBM» ustunlaridagi sonlar bitta karobkanikimi yoki qatornikimi — aniq emas, shuning uchun umumiy brutto va kub fayldan olinmadi',
    );
  },
  c4523: async () => {
    // review seams-5: two rows of one name are two rows — answering rows 1 and 3 leaves row 2's
    // file figure asked, and the table never says «to‘liq» over it.
    const rows: Cell[][] = [
      ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'G.W.(KGS)', 'CBM'],
      [1, 'Office chair', 200, 10, 12, 0.05],
      [2, 'Office chair', 480, 20, 13, 0.06],
      [3, 'Desk', 300, 30, 11, 0.07],
      ['TOTAL', null, 980, 60, 36, 0.18],
    ];
    const { steps } = await aiDoorWalk('rastamojka', [[xlsx({ name: 'Sheet1', rows }), 'pl.xlsx']], ['1: 120 kg 0.5 m3', '3: 330 kg 2.1 m3', '2: 260 kg 1.2 m3']);
    const [, afterThree, afterTwo] = [steps[0]!, steps[2]!, steps[3]!];
    expect(afterThree.table).toContain('«G.W.(KGS)» ustuni — bitta karobkanikimi yoki qatornikimi?');
    expect(afterThree.table).toContain('«CBM» ustuni — bitta karobkanikimi yoki qatornikimi?');
    expect(afterThree.table).not.toContain('Ma’lumot to‘liq');
    expect(afterTwo.table).not.toContain('ustuni — bitta karobkanikimi yoki qatornikimi?');
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
