/**
 * The intake regression corpus: every case the review rounds of
 * docs/SAKKIZ-BAND.md wrote down about the «Hisoblatish» intake — the typed
 * reader, the customer question, the spreadsheet door, the collector — merged
 * by (function, input, options) into one list per function.
 *
 * GENERATED from the four corpus files the review workflow produced (round 1,
 * its fix review, rounds 2-3, round 4). `said` is the reviewer's own sentence;
 * `expected` is its exact, checkable reading. Where two rounds answered the
 * same input differently, `pick` says which answer stands and why: the binding
 * decisions of the round-3 review first (R3-*), else the latest round.
 *
 * An expectation names only what the reviewer named — a figure, a name, a
 * count — and every name a goods list states is asserted in order. A case
 * whose sentence states only what must NOT happen carries `negativeOnly`.
 */
import * as CFB from 'cfb';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Cell } from '@/modules/wms/deals/goods-import';

export type Weight = string;

export interface CorpusCase<I, E, O = never> {
  /** `c` + the case's place in the merged corpus. */
  id: string;
  input: I;
  opts?: O;
  expected: E;
  /** The reviewer's own sentence for the expectation. */
  said: string;
  why: string;
  source: string;
  weight: Weight;
  alsoFrom?: string[];
  /** Two rounds disagreed: the answer that stands, and why. */
  pick?: string;
  /** A timing / memory bound the reviewer stated loosely — the bound used is in `expected`. */
  vague?: string;
  /** How the input was built where the reviewer only described it. */
  note?: string;
}

/**
 * A goods list, line by line. `rows[i]` is a PARTIAL line: only the fields the
 * reviewer named are compared, `name` against the line's name (a sheet row's
 * `description`). `count` is the exact number of lines when the reviewer
 * listed them all.
 */
export interface GoodsExpect {
  rows?: Record<string, unknown>[];
  count?: number;
  minCount?: number;
  /** No line is named exactly so. */
  absent?: string[];
  /** No line's name starts so. */
  absentPrefix?: string[];
  /** Every one of these names is among the lines (order-free). */
  includes?: string[];
  maxCount?: number;
  /** Every line matches this partial line. */
  every?: Record<string, unknown>;
  negativeOnly?: boolean;
}

export interface HintExpect {
  /** The answer is null. */
  null?: true;
  /** The answer equals this exactly. */
  equal?: { code?: string; phone?: string };
  /** null = the answer carries no code (or is null). */
  code?: null;
  /** null = the answer carries no phone (or is null). */
  phone?: null;
  hasPhone?: true;
  phoneDigitsEnd?: string;
  phoneDigits?: string;
}

export interface ParseGoodsExpect {
  goods?: GoodsExpect;
  headerRow?: number | null;
}

/** A spreadsheet the test builds, then hands to `readGoodsFile`. */
export type FileSpec =
  | { kind: 'csv' | 'html' | 'xml'; text: string | (() => string); contentType?: string | null }
  | { kind: 'xlsx'; sheets: SheetSpec[] }
  /** One shared string in every cell, written by exceljs' streaming writer (a ~41 KB file). */
  | { kind: 'xlsxShared'; name: string; rows: number; cols: number; cell: string }
  | { kind: 'xls'; bytes: () => Buffer }
  | { kind: 'fixture'; path: string };

export interface SheetSpec {
  name: string;
  rows?: Cell[][] | (() => Cell[][]);
  /** Cells by address, written after `rows` («A5200»). */
  cells?: Record<string, Cell>;
  merges?: string[];
  state?: 'visible' | 'hidden' | 'veryHidden';
}

export interface FileExpect {
  null?: true;
  kind?: 'goods' | 'text' | 'refused';
  reason?: string;
  sheet?: string;
  goods?: GoodsExpect;
  text?: string;
  textIncludes?: string[];
  textExcludes?: string[];
  /** Some line of `text` contains this. */
  textLineContains?: string;
  textMaxLength?: number;
  textMinLength?: number;
  textCut?: boolean;
  cellsCut?: boolean;
  /** Every line of `text` under a «[sheet]» heading is one WHOLE source row. */
  wholeRows?: true;
  /** The result's `sheets` count. */
  sheets?: number;
  /** No cell in `text` is longer than this. */
  cellMaxLength?: number;
  lastLine?: string;
  lastLineStarts?: string;
  lastLineEnds?: string;
  noThrow?: true;
  /** The bot's reply to this file (`readIntakeFile` on a fresh collection) contains each of these. */
  replyIncludes?: string[];
  replyExcludes?: string[];
  /** The read returns within this many milliseconds. */
  maxMs?: number;
  /** The heap grows by less than this many MB over the read. */
  maxHeapMb?: number;
  /** Any one of these holds (the reviewer allowed either answer). */
  either?: FileExpect[];
}

/** The customer question («Mijoz kim?») answered once or twice with the same text. */
export interface ClientStageInput {
  text: string;
  prefix: string;
  /** How many times the same text is sent (1 or 2). */
  sends: number;
  clientAskedWith?: string | null;
  material?: string[];
}
export interface ClientStageExpect {
  first?: 'customer' | 'material';
  second?: 'customer' | 'material';
  /** The customer on the first or the identical second send. */
  eventuallyCustomer?: true;
  firstSayIncludes?: string[];
  firstSayExcludes?: string[];
  secondSayIncludes?: string[];
  secondSayExcludes?: string[];
  couldBeCustomer?: boolean;
  material?: boolean;
  why?: 'goods' | 'shape' | null;
  /** parseClientHint(clientHintRaw) once the customer is taken. */
  hint?: { code?: string; phone?: string } | null;
  /** The lead's name: intakeClientLabel(clientHintRaw, hint). */
  leadName?: string;
  /** clientHintRaw after every send. */
  clientHintRaw?: string;
  /** How many copies of the text `material` holds after every send. */
  materialCopies?: number;
  stage?: string;
}

export interface PickGoodsInput {
  invoice: Record<string, unknown>[];
  aiGoods: 'add' | 'context' | 'same' | 'ask' | null;
  model: Record<string, unknown>[] | null;
  typed: Record<string, unknown>[];
  typedLabelled: Record<string, unknown>[];
}
export interface PickGoodsExpect {
  goods?: GoodsExpect;
  /** The names of the model lines left out as the Excel's own. */
  sameAsInvoice?: string[];
  /** Each partial line is among the left-out lines. */
  sameAsInvoiceHas?: Record<string, unknown>[];
  /** Each partial line is kept in goods or named in sameAsInvoice — never dropped unnamed. */
  somewhere?: Record<string, unknown>[];
}

export interface GoodsLineExpect {
  name?: string;
  tnvedCode?: string | null;
  quantity?: number | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  unitWords?: string[];
  /** Problem kinds the answer carries (at least these). */
  problems?: string[];
  /** The `text` of each problem of that kind. */
  problemTexts?: string[];
  /** The name does not contain this. */
  nameExcludes?: string[];
  /** quantity is not this number. */
  quantityNot?: number;
}

export interface ManualFactsExpect {
  goods?: GoodsExpect;
  weightKg?: number | null;
  volumeM3?: number | null;
  fromCity?: string | null;
  toCity?: string | null;
  /** landingItems(facts) as a goods list. */
  landing?: GoodsExpect;
  /** The landing note of line i contains this. */
  landingNoteIncludes?: { index: number; text: string }[];
  /** missingFields(section, facts) for the named section. */
  missing?: { section: 'yolkira' | 'rastamojka' | 'podklyuch'; equal?: string[]; includes?: string[]; excludes?: string[] };
  /** lineNeeds(section, line) asks nothing about a line named so (no such line exists). */
  noNeedsFor?: string[];
}

/** A corpus case the test drives through a named scenario of its own. */
export interface ScenarioCase {
  id: string;
  /** What the reviewer called (verbatim). */
  call: string;
  input: unknown;
  said: string;
  why: string;
  source: string;
  weight: Weight;
  alsoFrom?: string[];
  pick?: string;
  vague?: string;
}

// ---------------------------------------------------------------------------
// Builders: the spreadsheet files the readGoodsFile cases name, made here.
// ---------------------------------------------------------------------------

/** `A`, `B`, … `AE` — a 1-based column's letters. */
export function colName(col: number): string {
  let name = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** One BIFF8 record: type, size, data. */
function record(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}
const bof = () => {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(0x0010, 2);
  return record(0x0809, data);
};
const eof = () => record(0x000a, Buffer.alloc(0));
function cellHead(row: number, col: number, size: number): Buffer {
  const data = Buffer.alloc(size);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  return data;
}
/** XLUnicodeString, two bytes a character. */
const unicode = (text: string) => {
  const head = Buffer.alloc(3);
  head.writeUInt16LE(text.length, 0);
  head[2] = 1;
  return Buffer.concat([head, Buffer.from(text, 'utf16le')]);
};
const label = (row: number, col: number, text: string) => record(0x0204, Buffer.concat([cellHead(row, col, 6), unicode(text)]));
const number = (row: number, col: number, value: number) => {
  const data = cellHead(row, col, 14);
  data.writeDoubleLE(value, 6);
  return record(0x0203, data);
};
const labelSst = (row: number, col: number, index: number) => {
  const data = cellHead(row, col, 10);
  data.writeUInt32LE(index, 6);
  return record(0x00fd, data);
};
/** A FORMULA whose cached result is a string — the text comes in a STRING record. */
const formulaString = (row: number, col: number) => {
  const data = cellHead(row, col, 22);
  data[6] = 0;
  data.writeUInt16LE(0xffff, 12);
  return record(0x0006, data);
};
const stringRecord = (text: string) => record(0x0207, unicode(text));
/** MULRK: a row of integers, `cols` wide. */
const mulrk = (row: number, cols: number) => {
  const data = Buffer.alloc(4 + cols * 6 + 2);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(0, 2);
  for (let c = 0; c < cols; c += 1) {
    data.writeUInt16LE(0x0f, 4 + c * 6);
    data.writeUInt32LE((((row * cols + c) % 100_000) << 2) | 2, 4 + c * 6 + 2);
  }
  data.writeUInt16LE(cols - 1, 4 + cols * 6);
  return record(0x00bd, data);
};
/** SST: every string once (no CONTINUE — the lists here are short). */
const sst = (strings: string[]) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(strings.length, 0);
  head.writeUInt32LE(strings.length, 4);
  return record(0x00fc, Buffer.concat([head, ...strings.map(unicode)]));
};

interface Entry {
  at: number;
  name: string;
  hsState?: number;
}
function boundsheet({ at, name, hsState = 0 }: Entry): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(at, 0);
  head[4] = hsState;
  return record(0x0085, Buffer.concat([head, Buffer.from([name.length, 1]), Buffer.from(name, 'utf16le')]));
}
/** The workbook stream: the globals (with `extra` records), then `body`; offsets are relative to `body`. */
function stream97(entries: Entry[], body: Buffer, extra: Buffer[] = []): Buffer {
  const globals = (list: Entry[]) => Buffer.concat([bof(), ...extra, ...list.map(boundsheet), eof()]);
  const base = globals(entries).length;
  return Buffer.concat([globals(entries.map((e) => ({ ...e, at: e.at + base }))), body]);
}
/** Sheets laid end to end, one directory entry each. */
function sheets97(list: { name: string; hsState?: number; cells: Buffer[] }[], extra: Buffer[] = []): Buffer {
  const entries: Entry[] = [];
  const bodies: Buffer[] = [];
  let at = 0;
  for (const sheet of list) {
    const body = Buffer.concat([bof(), ...sheet.cells, eof()]);
    entries.push({ at, name: sheet.name, hsState: sheet.hsState });
    bodies.push(body);
    at += body.length;
  }
  return stream97(entries, Buffer.concat(bodies), extra);
}
function compound(stream: Buffer): Buffer {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, 'Workbook', stream);
  return Buffer.from(CFB.write(container, { type: 'buffer' }) as Uint8Array);
}

/** One 5000×100 MULRK sheet that `entries` BOUNDSHEET records all point at (~3 MB, c0058-c0061, c0426). */
export function xlsSameSheet(entries: number): Buffer {
  const body = Buffer.concat([bof(), ...Array.from({ length: 5000 }, (_, r) => mulrk(r, 100)), eof()]);
  return compound(stream97(Array.from({ length: entries }, () => ({ at: 0, name: 'S' })), body));
}

/** `entries` BOF records in a row, then one 5000×100 sheet: entry k starts at the k-th BOF (c0427). */
export function xlsDistinctOffsets(entries: number): Buffer {
  const body = Buffer.concat([...Array.from({ length: entries }, bof), ...Array.from({ length: 5000 }, (_, r) => mulrk(r, 100)), eof()]);
  return compound(stream97(Array.from({ length: entries }, (_, k) => ({ at: k * 20, name: `S${k}` })), body));
}

/** c0147's records: LABELSST header, then string formulas FORMULA → SHRFMLA → STRING, then FORMULA → STRING. */
export function xlsSharedFormulaChairs(): Buffer {
  const shrfmla = record(0x04bc, Buffer.from([1, 0, 3, 0, 0, 0, 0, 3, 0, 0]));
  const cells = [
    labelSst(0, 0, 0),
    labelSst(0, 1, 1),
    formulaString(1, 0),
    shrfmla,
    stringRecord('Chair'),
    number(1, 1, 10),
    formulaString(2, 0),
    stringRecord('Chair'),
    number(2, 1, 20),
    formulaString(3, 0),
    stringRecord('Chair'),
    number(3, 1, 30),
  ];
  return compound(sheets97([{ name: 'S', cells }], [sst(['Description', 'Qty'])]));
}

/** c0153: a hidden 30-line «Наименование | Цена» list (hsState 1) before a visible two-line order. */
export function xlsHiddenPriceList(): Buffer {
  const price = [label(0, 0, 'Наименование'), label(0, 1, 'Цена')];
  for (let r = 1; r <= 30; r += 1) price.push(label(r, 0, `Товар из прайса ${r}`), number(r, 1, r));
  const order = [label(0, 0, 'Наименование'), label(0, 1, 'Кол-во'), label(1, 0, 'Стол'), number(1, 1, 5), label(2, 0, 'Стул'), number(2, 1, 3)];
  return compound(
    sheets97([
      { name: 'Справочник', hsState: 1, cells: price },
      { name: 'Заказ', cells: order },
    ]),
  );
}

/** c0507-c0509: a string FORMULA, then a SHRFMLA / ARRAY / TABLE record, then its STRING. */
export function xlsFormulaThen(between: number): Buffer {
  const cells = [
    label(0, 0, 'Наименование'),
    label(0, 1, 'Кол-во'),
    formulaString(1, 0),
    record(between, Buffer.alloc(14)),
    stringRecord('Стол'),
    number(1, 1, 5),
  ];
  return compound(sheets97([{ name: 'S', cells }]));
}

/**
 * Real LibreOffice «MS Excel 97» saves (LibreOffice 7, `soffice --convert-to
 * 'xls:MS Excel 97'`) of workbooks exceljs wrote:
 *  - fill:   Description | Qty | (C) — A2:A5 = C&" x" (uncached), C = Chair/Table/Lamp/Desk;
 *  - brand:  Brand | Model | Description = A&" "&B (uncached) | Qty | Weight kg;
 *  - hidden: «Справочник» (30 lines, hidden, hsState 1) + «Заказ» (Стол 5, Стул 10, the active sheet);
 *  - merged: «Inv» Наименование | Кол-во | Вес, кг | Сумма; Стол 5/100/900, (A3) 3/60, Стул 10/50/200; merges A2:A3, D2:D3.
 * A string formula there is FORMULA → SHRFMLA → STRING; a merge is MERGECELLS + BLANK.
 */
const LIBREOFFICE_XLS: Record<'fill' | 'brand' | 'hidden' | 'merged', string> = {
  fill:
    '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAOwADAP7/CQAGAAAAAAAAAAAAAAABAAAACQAAAAAAAAAAEAAAAgAAAAEAAAD+////AAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9//////////7///8EAAAABQAAAAYAAAAHAAAACAAAAP7///8KAAAA/v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAUA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAQAAAAIAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAAVAAAAFgAAABcAAAAYAAAAGQAAABoAAAAbAAAAHAAAAB0AAAAeAAAAHwAAAP7///8hAAAA/v////7///8kAAAAJQAAACYAAAD+////KAAAACkAAAD+//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8JCBAAAAYFALsNzAcAAAAABgAAAOEAAgCwBMEAAgAAAOIAAABcAHAABAAAQ2FsYyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEIAAgCwBGEBAgAAAMABAAA9AQIAAQCcAAIADgCvAQIAAAC8AQIAAAA9ABIAAAAAAABAACA4AAAAAAABAFgCQAACAAAAjQACAAAAIgACAAAADgACAAEAtwECAAAA2gACAAAAMQAeANwAAAAIAJABAAAAAgEABwFDAGEAbABpAGIAcgBpADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsAB4EDACkAAcAAEdlbmVyYWzgABQAAACkAPX/IAAAAAAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAgADAAAA//////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAASQAAAAAAAAABAE8AbABlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgACAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACIAAAAUAAAAAAAAAAUAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAIA/////wUAAAD/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIwAAANwAAAAAAAAABQBEAG8AYwB1AG0AZQBuAHQAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAADgAAgD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnAAAArAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAA',
  brand:
    '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAOwADAP7/CQAGAAAAAAAAAAAAAAABAAAACQAAAAAAAAAAEAAAAgAAAAEAAAD+////AAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9//////////7///8EAAAABQAAAAYAAAAHAAAACAAAAP7///8KAAAA/v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAUA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAQAAAAIAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAAVAAAAFgAAABcAAAAYAAAAGQAAABoAAAAbAAAAHAAAAB0AAAAeAAAAHwAAACAAAAAhAAAAIgAAAP7///8kAAAA/v////7///8nAAAAKAAAACkAAAD+////KwAAACwAAAD+//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8JCBAAAAYFALsNzAcAAAAABgAAAOEAAgCwBMEAAgAAAOIAAABcAHAABAAAQ2FsYyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEIAAgCwBGEBAgAAAMABAAA9AQIAAQCcAAIADgCvAQIAAAC8AQIAAAA9ABIAAAAAAABAACA4AAAAAAABAFgCQAACAAAAjQACAAAAIgACAAAADgACAAEAtwECAAAA2gACAAAAMQAeANwAAAAIAJABAAAAAgEABwFDAGEAbABpAGIAcgBpADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsAB4EDACkAAcAAEdlbmVyYWzgABQAAACkAPX/IAAAAAAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAgADAAAA//////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjAAAASQAAAAAAAAABAE8AbABlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgACAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACUAAAAUAAAAAAAAAAUAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAIA/////wUAAAD/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJgAAANwAAAAAAAAABQBEAG8AYwB1AG0AZQBuAHQAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAADgAAgD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqAAAArAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAA',
  hidden:
    '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAOwADAP7/CQAGAAAAAAAAAAAAAAABAAAADgAAAAAAAAAAEAAACwAAAAEAAAD+////AAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9/////////wMAAAAEAAAABQAAAAYAAAAHAAAACAAAAAkAAAAKAAAA/v////7///8NAAAA/v///w8AAAD+/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAUA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAACQgQAAAGBQC7DcwHAAAAAAYAAADhAAIAsATBAAIAAADiAAAAXABwAAQAAENhbGMgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBCAAIAsARhAQIAAADAAQAAPQEEAAEAAgCcAAIADgCvAQIAAAC8AQIAAAA9ABIAAAAAAABAACA4AAEAAQABAFgCQAACAAAAjQACAAAAIgACAAAADgACAAEAtwECAAAA2gACAAAAMQAeANwAAAAIAJAB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AAAAAAAAAOg/KQAIAAAAAAAAAOg/oQAiAAEAZAAAAAEAAQACACwBLAEYDAaDwWDgPxgMBoPBYOA/AQBVAAIACAB9AAwAAAAAAa4IDwAAAAAAAAIOAAAAAAAfAAAAAAACAAAACAIQAAAAAAACACwBAAAAAAABDwAIAhAAAQAAAAIALAEAAAAAAAEPAAgCEAACAAAAAgAsAQAAAAAAAQ8ACAIQAAMAAAACACwBAAAAAAABDwAIAhAABAAAAAIALAEAAAAAAAEPAAgCEAAFAAAAAgAsAQAAAAAAAQ8ACAIQAAYAAAACACwBAAAAAAABDwAIAhAABwAAAAIALAEAAAAAAAEPAAgCEAAIAAAAAgAsAQAAAAAAAQ8ACAIQAAkAAAACACwBAAAAAAABDwAIAhAACgAAAAIALAEAAAAAAAEPAAgCEAALAAAAAgAsAQAAAAAAAQ8ACAIQAAwAAAACACwBAAAAAAABDwAIAhAADQAAAAIALAEAAAAAAAEPAAgCEAAOAAAAAgAsAQAAAAAAAQ8ACAIQAA8AAAACACwBAAAAAAABDwAIAhAAEAAAAAIALAEAAAAAAAEPAAgCEAARAAAAAgAsAQAAAAAAAQ8ACAIQABIAAAACACwBAAAAAAABDwAIAhAAEwAAAAIALAEAAAAAAAEPAAgCEAAUAAAAAgAsAQAAAAAAAQ8ACAIQABUAAAACACwBAAAAAAABDwAIAhAAFgAAAAIALAEAAAAAAAEPAAgCEAAXAAAAAgAsAQAAAAAAAQ8ACAIQABgAAAACACwBAAAAAAABDwAIAhAAGQAAAAIALAEAAAAAAAEPAAgCEAAaAAAAAgAsAQAAAAAAAQ8ACAIQABsAAAACACwBAAAAAAABDwAIAhAAHAAAAAIALAEAAAAAAAEPAAgCEAAdAAAAAgAsAQAAAAAAAQ8ACAIQAB4AAAACACwBAAAAAAABDwD9AAoAAAAAAA8AAAAAAP0ACgAAAAEADwABAAAA/QAKAAEAAAAPAAIAAAB+AgoAAQABAA8ABgAAAP0ACgACAAAADwADAAAAfgIKAAIAAQAPAAoAAAD9AAoAAwAAAA8ABAAAAH4CCgADAAEADwAOAAAA/QAKAAQAAAAPAAUAAAB+AgoABAABAA8AEgAAAP0ACgAFAAAADwAGAAAAfgIKAAUAAQAPABYAAAD9AAoABgAAAA8ABwAAAH4CCgAGAAEADwAaAAAA/QAKAAcAAAAPAAgAAAB+AgoABwABAA8AHgAAAP0ACgAIAAAADwAJAAAAfgIKAAgAAQAPACIAAAD9AAoACQAAAA8ACgAAAH4CCgAJAAEADwAmAAAA/QAKAAoAAAAPAAsAAAB+AgoACgABAA8AKgAAAP0ACgALAAAADwAMAAAAfgIKAAsAAQAPAC4AAAD9AAoADAAAAA8ADQAAAH4CCgAMAAEADwAyAAAA/QAKAA0AAAAPAA4AAAB+AgoADQABAA8ANgAAAP0ACgAOAAAADwAPAAAAfgIKAA4AAQAPADoAAAD9AAoADwAAAA8AEAAAAH4CCgAPAAEADwA+AAAA/QAKABAAAAAPABEAAAB+AgoAEAABAA8AQgAAAP0ACgARAAAADwASAAAAfgIKABEAAQAPAEYAAAD9AAoAEgAAAA8AEwAAAH4CCgASAAEADwBKAAAA/QAKABMAAAAPABQAAAB+AgoAEwABAA8ATgAAAP0ACgAUAAAADwAVAAAAfgIKABQAAQAPAFIAAAD9AAoAFQAAAA8AFgAAAH4CCgAVAAEADwBWAAAA/QAKABYAAAAPABcAAAB+AgoAFgABAA8AWgAAAP0ACgAXAAAADwAYAAAAfgIKABcAAQAPAF4AAAD9AAoAGAAAAA8AGQAAAH4CCgAYAAEADwBiAAAA/QAKABkAAAAPABoAAAB+AgoAGQABAA8AZgAAAP0ACgAaAAAADwAbAAAAfgIKABoAAQAPAGoAAAD9AAoAGwAAAA8AHAAAAH4CCgAbAAEADwBuAAAA/QAKABwAAAAPAB0AAAB+AgoAHAABAA8AcgAAAP0ACgAdAAAADwAeAAAAfgIKAB0AAQAPAHYAAAD9AAoAHgAAAA8AHwAAAH4CCgAeAAEADwB6AAAA7ABQAA8AAvBIAAAAEAAI8AgAAAABAAAAAAQAAA8AA/AwAAAADwAE8CgAAAABAAnwEAAAAAAAAAAAAAAAAAAAAAAAAAACAArwCAAAAAAEAAAFAAAAPgISALYAAAAAAEAAAAA8AGQAAAAAAB0ADwADAAAAAAAAAQAAAAAAAABnCBcAZwgAAAAAAAAAAAAAAgAB/////wAAAAAKAAAACQgQAAAGEAC7DcwHAAAAAAYAAAAMAAIAZAAPAAIAAQARAAIAAAAQAAgALUMc6+I2Gj9fAAIAAQCAAAgAAAAAAAAAAAAlAgQAAAAsAYEAAgDBBCoAAgAAACsAAgAAAIIAAgABABQAAAAVAAAAgwACAAAAhAACAAAAJgAIAGdmZmZmZuY/JwAIAGdmZmZmZuY/KAAIAAAAAAAAAOg/KQAIAAAAAAAAAOg/oQAiAAEAZAAAAAEAAQACACwBLAEYDAaDwWDgPxgMBoPBYOA/AQBVAAIACAB9AAwAAAAAAa4IDwAAAAAAAAIOAAAAAAADAAAAAAACAAAACAIQAAAAAAACACwBAAAAAAABDwAIAhAAAQAAAAIALAEAAAAAAAEPAAgCEAACAAAAAgAsAQAAAAAAAQ8A/QAKAAAAAAAPAAAAAAD9AAoAAAABAA8AAQAAAP0ACgABAAAADwAgAAAAfgIKAAEAAQAPABYAAAD9AAoAAgAAAA8AIQAAAH4CCgACAAEADwAqAAAA7ABQAA8AAvBIAAAAIAAI8AgAAAABAAAAAAgAAA8AA/AwAAAADwAE8CgAAAABAAnwEAAAAAAAAAAAAAAAAAAAAAAAAAACAArwCAAAAAAIAAAFAAAAPgISALYGAAAAAEAAAAA8AGQAAAAAAB0ADwADAAAAAAAAAQAAAAAAAABnCBcAZwgAAAAAAAAAAAAAAgAB/////wAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAP7////+////BAAAAAUAAAAGAAAA/v///wgAAAAJAAAA/v////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8BAP7/AwoAAP////8QCAIAAAAAAMAAAAAAAABGGwAAAE1pY3Jvc29mdCBFeGNlbCA5Ny1UYWJlbGxlAAYAAABCaWZmOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+/wAAAQACAAAAAAAAAAAAAAAAAAAAAAABAAAA4IWf8vlPaBCrkQgAKyez2TAAAACsAAAACAAAAAEAAABIAAAABAAAAFAAAAAIAAAAYAAAAAkAAABwAAAACgAAAHwAAAALAAAAiAAAAAwAAACUAAAADQAAAKAAAAACAAAA6f0AAB4AAAAIAAAAVW5rbm93bgAeAAAACAAAAFVua25vd24AHgAAAAIAAAAwAAAAQAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAQAAAAIC48zHUYd0BQAAAAIC48zHUYd0BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v8AAAEAAgAAAAAAAAAAAAAAAAAAAAAAAgAAAALVzdWcLhsQk5cIACss+a5EAAAABdXN1ZwuGxCTlwgAKyz5rlwAAAAYAAAAAQAAAAEAAAAQAAAAAgAAAOn9AABQAAAAAwAAAAAAAAAgAAAAAQAAADgAAAACAAAAQAAAAAEAAAACAAAACwAAAEFwcFZlcnNpb24AAAIAAADp/QAAHgAAAAgAAAAxNi4wMzAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUgBvAG8AdAAgAEUAbgB0AHIAeQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYABQD//////////wEAAAAQCAIAAAAAAMAAAAAAAABGAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAgAIAAAAAAABXAG8AcgBrAGIAbwBvAGsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgACAAIAAAAEAAAA/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABEQAAAAAAAAEAQwBvAG0AcABPAGIAagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAIAAwAAAP//////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEkAAAAAAAAAAQBPAGwAZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAgD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAFAAAAAAAAAAFAFMAdQBtAG0AYQByAHkASQBuAGYAbwByAG0AYQB0AGkAbwBuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAACAP////8FAAAA/////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAADcAAAAAAAAAAUARABvAGMAdQBtAGUAbgB0AFMAdQBtAG0AYQByAHkASQBuAGYAbwByAG0AYQB0AGkAbwBuAAAAAAAAAAAAAAA4AAIA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAA==',
  merged:
    '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAOwADAP7/CQAGAAAAAAAAAAAAAAABAAAACQAAAAAAAAAAEAAAAgAAAAEAAAD+////AAAAAAAAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9//////////7///8EAAAABQAAAAYAAAAHAAAACAAAAP7///8KAAAA/v///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAUA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAQAAAAIAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAAVAAAAFgAAABcAAAAYAAAAGQAAABoAAAAbAAAAHAAAAB0AAAAeAAAA/v///yAAAAD+/////v///yMAAAAkAAAAJQAAAP7///8nAAAAKAAAAP7///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8JCBAAAAYFALsNzAcAAAAABgAAAOEAAgCwBMEAAgAAAOIAAABcAHAABAAAQ2FsYyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEIAAgCwBGEBAgAAAMABAAA9AQIAAQCcAAIADgCvAQIAAAC8AQIAAAA9ABIAAAAAAABAACA4AAAAAAABAFgCQAACAAAAjQACAAAAIgACAAAADgACAAEAtwECAAAA2gACAAAAMQAeANwAAAAIAJABAAAAAgEABwFDAGEAbABpAGIAcgBpADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsAB4EDACkAAcAAEdlbmVyYWzgABQAAACkAPX/IAAAAAAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAQAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAgAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAAwCDgABQAAAAAAPX/IAAA9AAAAAAAAAAA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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAgADAAAA//////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfAAAASQAAAAAAAAABAE8AbABlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgACAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEAAAAUAAAAAAAAAAUAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAIA/////wUAAAD/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIgAAANwAAAAAAAAABQBEAG8AYwB1AG0AZQBuAHQAUwB1AG0AbQBhAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AAAAAAAAAAAAAADgAAgD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmAAAArAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAA',
};
export function base64Xls(name: keyof typeof LIBREOFFICE_XLS): Buffer {
  return Buffer.from(LIBREOFFICE_XLS[name], 'base64');
}

const CONTENT_TYPE = { csv: 'text/csv', html: 'text/html', xml: 'text/xml' } as const;

/** The bytes (and the content type the bot would pass) of a spec. */
export async function buildFile(spec: FileSpec): Promise<{ body: Buffer; contentType: string | null; fileName: string }> {
  if (spec.kind === 'csv' || spec.kind === 'html' || spec.kind === 'xml') {
    const text = typeof spec.text === 'function' ? spec.text() : spec.text;
    const contentType = 'contentType' in spec ? (spec.contentType ?? null) : CONTENT_TYPE[spec.kind];
    return { body: Buffer.from(text, 'utf8'), contentType, fileName: `file.${spec.kind}` };
  }
  if (spec.kind === 'fixture') {
    return { body: readFileSync(path.join(process.cwd(), spec.path)), contentType: null, fileName: path.basename(spec.path) };
  }
  if (spec.kind === 'xls') return { body: spec.bytes(), contentType: null, fileName: 'file.xls' };
  if (spec.kind === 'xlsxShared') {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => out.on('end', () => resolve()));
    const book = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useSharedStrings: true });
    const sheet = book.addWorksheet(spec.name);
    const row = Array.from({ length: spec.cols }, () => spec.cell);
    for (let r = 0; r < spec.rows; r += 1) sheet.addRow(row).commit();
    sheet.commit();
    await book.commit();
    await ended;
    return { body: Buffer.concat(chunks), contentType: null, fileName: 'file.xlsx' };
  }
  if (spec.kind !== 'xlsx') throw new Error(`unknown spec ${JSON.stringify(spec)}`);
  const book = new ExcelJS.Workbook();
  for (const s of spec.sheets) {
    const ws = book.addWorksheet(s.name, { state: s.state ?? 'visible' });
    const rows = typeof s.rows === 'function' ? s.rows() : (s.rows ?? []);
    rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (value !== null && value !== undefined) ws.getCell(r + 1, c + 1).value = value;
      }),
    );
    for (const [address, value] of Object.entries(s.cells ?? {})) if (value !== null) ws.getCell(address).value = value;
    for (const range of s.merges ?? []) ws.mergeCells(range);
  }
  return { body: Buffer.from(await book.xlsx.writeBuffer()), contentType: null, fileName: 'file.xlsx' };
}

/** The source rows a spec holds — what a WHOLE row of the reader's text is made of. */
export function sourceRows(spec: FileSpec, csv: (text: string) => Cell[][]): Cell[][] | null {
  if (spec.kind === 'csv') return csv(typeof spec.text === 'function' ? spec.text() : spec.text);
  if (spec.kind === 'xlsx') return spec.sheets.flatMap((s) => (typeof s.rows === 'function' ? s.rows() : (s.rows ?? [])));
  return null;
}


/**
 * The corpus's DATA lives in intake-corpus.json, read at run time: as one
 * 900 KB TypeScript literal the cases cost the typechecker more than the 2 GB
 * a default Node heap gives it (`pnpm typecheck` died in a container whose
 * limit is 2 GB). Only the cases that need code to build their input — a file
 * built by a function — stay here, each in its place: the JSON holds
 * `{ id, $ts: true }` where such a case stands, so the order of every list is
 * the corpus's own.
 */
const CORPUS_DATA = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests', 'unit', 'fixtures', 'intake-corpus.json'), 'utf8'),
) as Record<string, ({ id: string; $ts?: true } & Record<string, unknown>)[]>;

function corpusCases<C extends { id: string }>(name: string, own: C[] = []): C[] {
  const byId = new Map(own.map((c) => [c.id, c]));
  const list = CORPUS_DATA[name];
  if (!list) throw new Error(`intake-corpus.json has no ${name}`);
  const out = list.map((c) => {
    if (!c.$ts) return c as unknown as C;
    const mine = byId.get(c.id);
    if (!mine) throw new Error(`${name}: ${c.id} is marked as built here and is not`);
    byId.delete(c.id);
    return mine;
  });
  if (byId.size > 0) throw new Error(`${name}: ${[...byId.keys()].join(', ')} are built here and listed nowhere`);
  return out;
}

export const parseClientHintCases = corpusCases<CorpusCase<string, HintExpect, { prefix?: string | null }>>('parseClientHintCases');

export const looksLikeMaterialCases = corpusCases<CorpusCase<string, boolean, { prefix?: string | null }>>('looksLikeMaterialCases');

export const readGoodsLinesCases = corpusCases<CorpusCase<string, GoodsExpect, { labelledOnly?: boolean; prefix?: string | null }>>('readGoodsLinesCases');

export const parseGoodsCases = corpusCases<CorpusCase<Cell[][] | { csv: string }, ParseGoodsExpect>>('parseGoodsCases');

export const parseGoodsLineCases = corpusCases<CorpusCase<string, GoodsLineExpect>>('parseGoodsLineCases');

export const parseManualFactsCases = corpusCases<CorpusCase<string, ManualFactsExpect>>('parseManualFactsCases');

export const intakeClientLabelCases = corpusCases<CorpusCase<{ raw: string; hint: { code?: string; phone?: string } | null }, string | null>>('intakeClientLabelCases');

export const resolveLineDoneCases = corpusCases<CorpusCase<{ goods: { name: string; weightKg?: number }[]; done: { index: number; name: string }[] }, { index: number; name: string }[]>>('resolveLineDoneCases');

export const clientStageCases = corpusCases<CorpusCase<ClientStageInput, ClientStageExpect>>('clientStageCases');

export const pickGoodsCases = corpusCases<CorpusCase<PickGoodsInput, PickGoodsExpect>>('pickGoodsCases');

export const readGoodsFileCases = corpusCases<CorpusCase<FileSpec, FileExpect>>('readGoodsFileCases', [
  {
    id: "c0058",
    input: { kind: 'xls', bytes: () => xlsSameSheet(1) },
    expected: {"kind": "text", "sheets": 1, "textMaxLength": 15000, "maxMs": 2000},
    said: "the duplicate BOUNDSHEET offsets are read once (dedup by offset, sheet count capped, a byte budget across sheets): time about that of 1 entry (~110-160 ms), bounded text and memory — never 22 s of synchronous CPU, RangeError or OOM",
    why: "readXls pushed one entry per BOUNDSHEET with no dedupe and re-parsed every entry; 13 bytes per extra entry (votes 0/1). 1 entries.",
    source: "r1 c08 sheets — control",
    weight: "pinned",
    vague: "«about that of 1 entry (~110-160 ms) … never 22 s»: one sheet, under 2,000 ms",
  },
  {
    id: "c0059",
    input: { kind: 'xls', bytes: () => xlsSameSheet(20) },
    expected: {"kind": "text", "sheets": 1, "textMaxLength": 15000, "maxMs": 2000},
    said: "the duplicate BOUNDSHEET offsets are read once (dedup by offset, sheet count capped, a byte budget across sheets): time about that of 1 entry (~110-160 ms), bounded text and memory — never 22 s of synchronous CPU, RangeError or OOM",
    why: "readXls pushed one entry per BOUNDSHEET with no dedupe and re-parsed every entry; 13 bytes per extra entry (votes 0/1). 20 entries.",
    source: "r1 c08 sheets",
    weight: "defect",
    vague: "«about that of 1 entry (~110-160 ms) … never 22 s»: one sheet, under 2,000 ms",
  },
  {
    id: "c0060",
    input: { kind: 'xls', bytes: () => xlsSameSheet(300) },
    expected: {"kind": "text", "sheets": 1, "textMaxLength": 15000, "maxMs": 2000},
    said: "the duplicate BOUNDSHEET offsets are read once (dedup by offset, sheet count capped, a byte budget across sheets): time about that of 1 entry (~110-160 ms), bounded text and memory — never 22 s of synchronous CPU, RangeError or OOM",
    why: "readXls pushed one entry per BOUNDSHEET with no dedupe and re-parsed every entry; 13 bytes per extra entry (votes 0/1). 300 entries.",
    source: "r1 c08 sheets",
    weight: "defect",
    vague: "«about that of 1 entry (~110-160 ms) … never 22 s»: one sheet, under 2,000 ms",
  },
  {
    id: "c0061",
    input: { kind: 'xls', bytes: () => xlsSameSheet(1000) },
    expected: {"kind": "text", "sheets": 1, "textMaxLength": 15000, "maxMs": 2000},
    said: "the duplicate BOUNDSHEET offsets are read once (dedup by offset, sheet count capped, a byte budget across sheets): time about that of 1 entry (~110-160 ms), bounded text and memory — never 22 s of synchronous CPU, RangeError or OOM",
    why: "readXls pushed one entry per BOUNDSHEET with no dedupe and re-parsed every entry; 13 bytes per extra entry (votes 0/1). 1000 entries.",
    source: "r1 c08 sheets",
    weight: "defect",
    vague: "«about that of 1 entry (~110-160 ms) … never 22 s»: one sheet, under 2,000 ms",
  },
  {
    id: "c0062",
    input: { kind: "html", text: () => "<html><body><table>" + "<tr><td>Стол</td><td>5</td>\n".repeat(31000) + "</table></body></html>" },
    expected: {"kind": "text", "textIncludes": ["Стол | 5"], "textExcludes": ["[CSV]", "<td", "<tr", "<html"], "maxMs": 1000},
    said: "returns in well under a second (linear; prototypes 33-109 ms) and reads the rows as rows — never 10-13 s of blocked event loop, never raw markup handed to the model as «[CSV] <html>…»",
    why: "Leaving out </tr> is valid HTML; the lazy match made it O(n²) (49/187/787 ms per doubling) and the bot runs inside the app process (all three votes).",
    source: "r1 c09 sheets — scenario (930-992 KB, no </tr>)",
    weight: "defect",
    vague: "«well under a second»: 1,000 ms",
  },
  {
    id: "c0063",
    input: { kind: "html", text: () => "<html><body><table><tr><th>Наименование</th><th>Кол-во</th>" + "<tr><td>Стол</td><td>5</td>".repeat(33000) + "</table></body></html>" },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5}], "minCount": 1}, "maxMs": 1000},
    said: "linear time (~33 ms prototype); kind 'goods' with the rows read (Стол ×5 …), not kind 'text' of raw markup",
    why: "Leaving out </tr> is valid HTML; the lazy match made it O(n²) (49/187/787 ms per doubling) and the bot runs inside the app process (all three votes). Vote 1: a 1,023,098-byte file took 13,398 ms and returned the markup as text.",
    source: "r1 c09 sheets — vote 1",
    weight: "defect",
    vague: "«linear time (~33 ms prototype)»: under 1,000 ms",
  },
  {
    id: "c0147",
    input: { kind: 'xls', bytes: () => xlsSharedFormulaChairs() },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Chair", "quantity": 10}, {"name": "Chair", "quantity": 20}, {"name": "Chair", "quantity": 30}], "count": 3}},
    said: "kind 'goods', three lines: [Chair,10], [Chair,20], [Chair,30] (readXls row 1 = [\"Chair\",10], never [null,10])",
    why: "MS-XLS grammar FORMULA [Array/Table/ShrFmla] [String]; LibreOffice reads the same file as Chair 10/20/30; the first line of a filled-down block vanished (all three votes).",
    source: "r1 c13 sheets — scenario probe",
    weight: "defect",
  },
  {
    id: "c0148",
    input: { kind: 'xls', bytes: () => base64Xls('fill') },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Chair x", "quantity": 10}, {"name": "Table x", "quantity": 20}, {"name": "Lamp x", "quantity": 30}, {"name": "Desk x", "quantity": 40}], "count": 4}},
    said: "kind 'goods', four lines named «Chair x», «Table x», «Lamp x», «Desk x» (qty 10/20/30/40)",
    why: "Vote 1: the real LibreOffice file dumps «6 4bc 207 6 207 …»; HEAD dropped «Chair x»; the fixed copy reads all four.",
    source: "r1 c13 sheets — vote 1 probe 2",
    weight: "defect",
    note: "the reviewer's sheet built with exceljs (formulas =C2&\" x\" … left uncached) and saved by LibreOffice 7 «MS Excel 97»: FORMULA → SHRFMLA → STRING",
  },
  {
    id: "c0149",
    input: { kind: 'xls', bytes: () => base64Xls('brand') },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Ikea Chair", "quantity": 10, "weightKg": 50}], "count": 4}},
    said: "kind 'goods', four lines; the first is «Ikea Chair» with quantity 10, weightKg 50 (not dropped)",
    why: "Vote 2: readGoodsFile returned only Table, Lamp and Fan; Chair (qty 10, 50 kg) was silently dropped; the patched copy returns «Ikea Chair».",
    source: "r1 c13 sheets — vote 2",
    weight: "defect",
    note: "built with exceljs (Description = A&\" \"&B, uncached) and saved by LibreOffice «MS Excel 97»",
  },
  {
    id: "c0151",
    input: { kind: 'xlsx', sheets: [{ name: 'Заказ', rows: () => [['№', 'Наименование', 'Кол-во', 'Вес, кг'], ...Array.from({ length: 20 }, (_, k): Cell[] => { const i = k + 1; return [i, `Куртка женская ${i}`, 10 * i, 5 * i]; })] }, { name: 'Справочник', state: 'hidden', rows: () => [['Наименование', 'Цена'], ...Array.from({ length: 300 }, (_, k): Cell[] => { const i = k + 1; return [`Товар из прайса ${i}`, 1.5 * i]; })] }] },
    expected: {"kind": "goods", "sheet": "Заказ", "goods": {"rows": [{"name": "Куртка женская 1"}], "count": 20}, "textExcludes": ["Товар из прайса"]},
    said: "kind 'goods', sheet «Заказ», 20 goods, first «Куртка женская 1» — the hidden price list neither wins nor reaches the model's text",
    why: "Hidden content is not what the sender meant to send; base (worksheets[0]) read the 20 order lines (all three votes).",
    source: "r1 c14 sheets — scenario probe",
    weight: "regression",
    note: "rowsGen: one row per i, a «{expr}» cell evaluated as a number",
  },
  {
    id: "c0152",
    input: { kind: 'xlsx', sheets: [{ name: 'Order', rows: () => [['№', 'Наименование', 'Кол-во', 'Вес, кг'], ...Array.from({ length: 20 }, (_, k): Cell[] => { const i = k + 1; return [i, `Куртка ${i}`, 10, 5]; })] }, { name: 'Lists', state: 'veryHidden', rows: () => [['Наименование', 'Цена'], ...Array.from({ length: 40 }, (_, k): Cell[] => { const i = k + 1; return [`Позиция ${i}`, i]; })] }] },
    expected: {"kind": "goods", "sheet": "Order", "goods": {"count": 20}, "textExcludes": ["Позиция"]},
    said: "kind 'goods', sheet «Order», 20 goods",
    why: "Vote 1: a veryHidden «Lists» sheet with 40 rows also beat the visible 20-line order.",
    source: "r1 c14 sheets — vote 1 veryHidden variant",
    weight: "regression",
    note: "rowsGen: one row per i, a «{expr}» cell evaluated as a number",
  },
  {
    id: "c0153",
    input: { kind: 'xls', bytes: () => xlsHiddenPriceList() },
    expected: {"kind": "goods", "sheet": "Заказ", "goods": {"rows": [{"name": "Стол"}, {"name": "Стул"}], "count": 2}, "textExcludes": ["Товар из прайса"]},
    said: "kind 'goods' from the visible sheet; the hidden BOUNDSHEET is skipped",
    why: "All votes: readXls checked only dt (byte 5) and ignored hsState, so the same defect exists for .xls.",
    source: "r1 c14 sheets — fix (readXls hsState)",
    weight: "close-variant",
  },
  {
    id: "c0212",
    input: { kind: 'csv', text: () => ['GUANGZHOU XINYI TRADING CO., LTD', 'PACKING LIST', 'No.;Описание товара 货物描述;Кол-во;Ед;Нетто;Брутто;Объем', ...Array.from({ length: 300 }, (_, k) => { const i = k + 1; return `${i};Куртка женская модель YW-${2300 + i} (女士夹克);${100 + i};PCS;${(1.5 * i).toFixed(1)};${(1.7 * i).toFixed(1)};${(0.01 * i).toFixed(2)}`; })].join('\n') },
    expected: {"either": [{"kind": "goods", "goods": {"count": 300}}, {"kind": "text", "textCut": true, "wholeRows": true, "replyIncludes": ["⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi "]}]},
    said: "no line lost in silence: either kind 'goods' with every row, or kind 'text' with textCut true, its text ending on a whole row (never mid-row), and readIntakeFile's reply naming the cut («⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi N qator)»)",
    why: "Scenario: 19 663 chars, slice(0,15000) stopped mid-row at line 230 and lines 231-300 never reached the card; every file is answered and nothing is dropped silently (all three votes).",
    source: "r1 c17 ai — scenario",
    weight: "defect",
  },
  {
    id: "c0213",
    input: { kind: 'xlsx', sheets: [{ name: 'Packing list', rows: () => [['ZHEJIANG YIWU TRADING CO., LTD'], ['PACKING LIST'], ['箱号 CTN NO', '款号 STYLE NO', '款式 STYLE', '颜色 COLOR', '每箱数量 PCS/CTN', '箱数 CTNS', '总数量 TOTAL PCS', '毛重 G.W KG', '净重 N.W KG', '体积 CBM'], ...Array.from({ length: 150 }, (_, k): Cell[] => { const i = k + 1; return [i, `YW-${2300 + i}`, `Женская куртка зимняя 女士冬季夹克 модель ${i}`, 'black/黑色', 20, 5, 100, 55.5, 50.2, 0.48]; })] }] },
    expected: {"either": [{"kind": "goods", "goods": {"count": 150}}, {"kind": "text", "textCut": true, "wholeRows": true, "replyIncludes": ["⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi "]}]},
    said: "no line lost in silence: either kind 'goods' with every row, or kind 'text' with textCut true, its text ending on a whole row (never mid-row), and readIntakeFile's reply naming the cut («⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi N qator)»)",
    why: "Vote 2: read as kind 'text' (15 412 chars), the cut kept rows up to 146 so rows 147-150 never reached the model.",
    source: "r1 c17 ai — vote 2 probe",
    weight: "defect",
    note: "rowsGen: one row per i, a «{expr}» cell evaluated as a number",
  },
  {
    id: "c0214",
    input: { kind: 'xlsx', sheets: [{ name: 'Packing list', rows: () => [['ZHEJIANG YIWU TRADING CO., LTD'], ['PACKING LIST'], ['No', 'Model', 'Color', 'Qty', 'Unit', 'N.W', 'G.W', 'CBM'], ...Array.from({ length: 250 }, (_, k): Cell[] => { const i = k + 1; return [i, `Куртка женская модель YW-${i} (女士夹克)`, 'black', 100, 'PCS', 50.2, 55.5, 0.48]; })] }] },
    expected: {"either": [{"kind": "goods", "goods": {"count": 250}}, {"kind": "text", "textCut": true, "wholeRows": true, "replyIncludes": ["⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi "]}]},
    said: "no line lost in silence: either kind 'goods' with every row, or kind 'text' with textCut true, its text ending on a whole row (never mid-row), and readIntakeFile's reply naming the cut («⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi N qator)»)",
    why: "Vote 2: 20 642 chars, the cut kept ~183 goods rows and ended mid-row on «1»; ~67 lines lost, the half row a broken goods line.",
    source: "r1 c17 ai — vote 2 probe",
    weight: "defect",
    note: "rowsGen: one row per i, a «{expr}» cell evaluated as a number",
  },
  {
    id: "c0215",
    input: { kind: 'xlsx', sheets: [{ name: 'Packing list', rows: () => [['YIWU JINHUA TRADING CO., LTD'], ['No. 88 Futian Road, Yiwu, Zhejiang, China'], ['TEL: +86 579 8555 1234'], [], ['PACKING LIST'], [], ['To:', 'GSR LOGISTICS / Tashkent, Uzbekistan'], ['Invoice No:', 'YW2026-1021', 'Date:', '2026-10-21'], ['From:', 'Yiwu', 'To:', 'Tashkent'], ['Shipping marks:', 'GS777'], [], [], ['No.', 'Model', 'Description', 'Material', 'Color', 'Qty (pcs)', 'Unit price USD', 'Amount USD', 'CTN', 'CTN size (cm)', 'N.W.(kg)', 'G.W.(kg)', 'CBM'], ...Array.from({ length: 130 }, (_, k): Cell[] => { const i = k + 1; return [i, `YW-${2300 + i}`, `Куртка женская утеплённая, модель ${i} (女士羽绒夹克)`, 'polyester 100%', 'black/white', 100 + i, 12.5, (100 + i) * 12.5, 5, '60*40*45', 20 + i / 10, 22 + i / 10, 0.35]; }), ['TOTAL', '', '', '', 999, 999, 9999, 9999, 99]] }] },
    expected: {"either": [{"kind": "goods", "goods": {"count": 130}}, {"kind": "text", "textCut": true, "wholeRows": true, "replyIncludes": ["⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi "]}]},
    said: "no line lost in silence: either kind 'goods' with every row, or kind 'text' with textCut true, its text ending on a whole row (never mid-row), and readIntakeFile's reply naming the cut («⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi N qator)»); the TOTAL row is never silently dropped either",
    why: "Vote 1: header on row 13 past the reader's first ten → kind 'text' 19 801 chars; goods 1-98 whole, line 99 cut mid-row, 100-130 + TOTAL lost.",
    source: "r1 c17 ai — vote 1 probe 2",
    weight: "defect",
    vague: "«the TOTAL row is never silently dropped either»: covered by the text branch (textCut + the reply); on the goods branch only the 130 product lines are counted",
    note: "rowsGen: one row per i, a «{expr}» cell evaluated as a number",
  },
  {
    id: "c0426",
    input: { kind: 'xls', bytes: () => xlsSameSheet(300) },
    expected: {"sheets": 1, "textMaxLength": 15000, "maxMs": 2000},
    said: "no throw; ONE sheet read (a repeated sheet position is skipped); text <= 15,000 chars; ~117 ms (base: readXls 23.6 s, 2.3 GB heap, then readGoodsFile threw RangeError)",
    why: "The .xls sheet list skips a sheet position it has already seen (#8).",
    source: "r1-fix sheets #8 (fixer summary; reviewer 0 scenario b)",
    weight: "pinned",
    vague: "«~117 ms (base: 23.6 s)»: under 2,000 ms",
  },
  {
    id: "c0427",
    input: { kind: 'xls', bytes: () => xlsDistinctOffsets(32) },
    expected: {"sheets": 1, "maxMs": 2000},
    said: "one sheet, ~81 ms (base: 2.9 s and 32 sheets) — the reader stops once the whole stream has been read through once",
    why: "Distinct offsets defeat position dedupe; the read-through limit is what bounds it (#8).",
    source: "r1-fix sheets #8 reviewer 0 (dedupe bypass)",
    weight: "pinned",
    vague: "«~81 ms (base: 2.9 s and 32 sheets)»: one sheet, under 2,000 ms",
  },
  {
    id: "c0431",
    input: { kind: "html", text: () => ('<table><tr><td>Наименование</td><td>Кол-во</td></tr>' + '<tr><td>Стол<td>5'.repeat(30000)) },
    expected: {"kind": "goods", "goods": {"count": 500, "every": {"name": "Стол", "quantity": 5}}, "maxMs": 2000},
    said: "{\"kind\":\"goods\"} with 500 goods, each «Стол» quantity 5, in < 2 s (fixed: 52 ms)",
    why: "Base took 10.8 s and read nothing (the old reader also took 8.9 s on the fixer's 30,000-row unclosed test, bound 2 s); the fix splits on opening tags and cuts each piece at its own closer — linear.",
    source: "r1-fix sheets #9 (fixer summary; reviewer 0 perFinding #9)",
    weight: "pinned",
  },
  {
    id: "c0432",
    input: { kind: "xml", text: () => ('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="S"><Table>' + '<Row><Cell><Data ss:Type="String">Стол</Data></Cell>'.repeat(30000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) in < 2 s",
    why: "The old SpreadsheetML reader took 9.2 s on 30,000 unclosed <Row>s (#9 red proof).",
    source: "r1-fix sheets #9 (fixer summary)",
    weight: "pinned",
  },
  {
    id: "c0433",
    input: { kind: "html", text: () => ('<table><tr><td>Наименование</td><td>Кол-во</td></tr><tr><td>' + '<'.repeat(100000) + '</td><td>5</td></tr></table>') },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) in < 2 s — tag stripping inside a cell is linear",
    why: "The old tag strip took 8.5 s on a cell of 100,000 «<» (#9 red proof).",
    source: "r1-fix sheets #9 (fixer summary)",
    weight: "pinned",
  },
  {
    id: "c0434",
    input: { kind: "html", text: () => ('<tr><td>x'.repeat(Math.floor(3_999_000/9))) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0435",
    input: { kind: "html", text: () => ('<td>'.repeat(Math.floor(3_999_000/4))) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0436",
    input: { kind: "html", text: () => ('<table>'.repeat(Math.floor(3_999_000/7))) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0437",
    input: { kind: "html", text: () => ('<table><tr><td>' + '<'.repeat(3_990_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0438",
    input: { kind: "html", text: () => ('<table><tr><td>' + '<br '.repeat(997_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0439",
    input: { kind: "html", text: () => ('<table><tr><td>' + '&#x'.repeat(1_330_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0440",
    input: { kind: "html", text: () => ('<table><tr><td>&' + 'a'.repeat(3_990_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0441",
    input: { kind: "html", text: () => ('<table>' + '<tr</tr'.repeat(570_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0442",
    input: { kind: "xml", text: () => ('<Workbook><Worksheet ss:Name="S"><Table>' + '<Row>'.repeat(798_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0443",
    input: { kind: "xml", text: () => ('<Workbook><Worksheet ss:Name="S"><Table><Row>' + '<Cell>'.repeat(665_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0444",
    input: { kind: "xml", text: () => ('<Workbook>' + '<Worksheet>'.repeat(363_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0445",
    input: { kind: "xml", text: () => ('<Workbook><Worksheet ss:Name="' + 'a'.repeat(3_990_000)) },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns (no throw) well inside 2 s (reviewer measured 13–730 ms for every shape)",
    why: "Reviewer 0 probed this shape just under the cap to show the HTML/SpreadsheetML readers are linear (#9).",
    source: "r1-fix sheets #9 reviewer 0 (adversarial shapes)",
    weight: "pinned",
  },
  {
    id: "c0446",
    input: { kind: "html", text: () => ('<table><tr><td>' + 'x'.repeat(4_100_000) + '</td></tr></table>') },
    expected: {"kind": "refused", "reason": "broken", "maxMs": 1000},
    said: "{\"kind\":\"refused\",\"reason\":\"broken\"} in ~30 ms (before any reader runs)",
    why: "Oversized markup is refused as «broken» — no new refusal reason, the bot already says «qayta saqlab yuboring» (#9).",
    source: "r1-fix sheets #9 (fixer summary; reviewer 0)",
    weight: "pinned",
    vague: "«in ~30 ms (before any reader runs)»: under 1,000 ms",
  },
  {
    id: "c0506",
    input: { kind: 'xls', bytes: () => base64Xls('brand') },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Ikea Chair"}, {"name": "Ikea Table"}, {"name": "Ikea Lamp"}, {"name": "Xiaomi Fan"}], "count": 4}},
    said: "{\"kind\":\"goods\"} with 4 goods: «Ikea Chair», «Ikea Table», «Ikea Lamp», «Xiaomi Fan» (base: first cell null, 3 goods)",
    why: "#13: a formula's pending string must survive a SHRFMLA record between FORMULA and STRING.",
    source: "r1-fix sheets #13 reviewer 0 (real LibreOffice file)",
    weight: "pinned",
    note: "the same LibreOffice «MS Excel 97» save as c0149: Description is a shared string formula (FORMULA → SHRFMLA → STRING)",
  },
  {
    id: "c0507",
    input: { kind: 'xls', bytes: () => xlsFormulaThen(0x04bc) },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5}], "count": 1}},
    said: "the formula cell reads the STRING value (never null)",
    why: "#13: SHRFMLA, ARRAY and TABLE no longer clear a formula's pending string; each has its own test (the fixer's red proof left out SHRFMLA alone).",
    source: "r1-fix sheets #13 (fixer summary; reviewer 1)",
    weight: "pinned",
    note: "a header row (Наименование | Кол-во) over the formula row, so the read shows the formula cell as the line's name",
  },
  {
    id: "c0508",
    input: { kind: 'xls', bytes: () => xlsFormulaThen(0x0221) },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5}], "count": 1}},
    said: "the formula cell reads the STRING value (never null)",
    why: "#13: SHRFMLA, ARRAY and TABLE no longer clear a formula's pending string; each has its own test (the fixer's red proof left out ARRAY alone).",
    source: "r1-fix sheets #13 (fixer summary; reviewer 1)",
    weight: "pinned",
    note: "a header row (Наименование | Кол-во) over the formula row, so the read shows the formula cell as the line's name",
  },
  {
    id: "c0509",
    input: { kind: 'xls', bytes: () => xlsFormulaThen(0x0236) },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5}], "count": 1}},
    said: "the formula cell reads the STRING value (never null)",
    why: "#13: SHRFMLA, ARRAY and TABLE no longer clear a formula's pending string; each has its own test (the fixer's red proof left out TABLE alone).",
    source: "r1-fix sheets #13 (fixer summary; reviewer 1)",
    weight: "pinned",
    note: "a header row (Наименование | Кол-во) over the formula row, so the read shows the formula cell as the line's name",
  },
  {
    id: "c0512",
    input: { kind: 'xls', bytes: () => base64Xls('hidden') },
    expected: {"kind": "goods", "sheet": "Заказ", "goods": {"rows": [{"name": "Стол"}, {"name": "Стул"}], "count": 2}, "textExcludes": ["Позиция"]},
    said: "{\"kind\":\"goods\",\"sheet\":\"Заказ\"} with goods [«Стол», «Стул»]; no catalogue text sent",
    why: "#14: .xls `hsState & 0x03` marks the sheet hidden (reviewer 0 checked hidden.xls).",
    source: "r1-fix sheets #14 reviewer 0 (hidden.xls)",
    weight: "pinned",
    note: "exceljs book (Справочник hidden, Заказ active) saved by LibreOffice «MS Excel 97»: BOUNDSHEET hsState = 1",
  },
  {
    id: "c0520",
    input: { kind: "csv", text: () => (Array.from({length:300},(_, i)=>`PL-${i+1},LED panel light 600x600 48W 4000K,${i+1},${((i+1)*0.196).toFixed(3)}`).join('\n')) },
    expected: {"kind": "text", "textCut": true, "wholeRows": true, "textMaxLength": 15000},
    said: "{\"kind\":\"text\",\"textCut\":true} and every line of `text` is a WHOLE row — the last line is never a half row like «PL-243 | LED panel light 60»; text.length <= 15000",
    why: "Review2 S4: sheetsAsText cut with piece.slice(0, room) in the middle of a row, so the row-wise fitter downstream saw kept == total and nobody told the seller or the model.",
    source: "review2 S4 (reviewer 1)",
    weight: "defect",
  },
  {
    id: "c0521",
    input: { kind: "csv", text: () => (Array.from({length:300},(_, i)=>`${i+1},Куртка женская модель YW-${i+1} (女士夹克),${i+100},PCS`).join('\n')) },
    expected: {"kind": "text", "textCut": true, "wholeRows": true},
    said: "{\"kind\":\"text\",\"textCut\":true}; the last line of `text` is whole (never «204 | Куртка женская модель YW-204 (女士夹克) | 303 | P»)",
    why: "Review2 C1: the single oversized file stayed silent and ended on a half row once merged with the sheets package.",
    source: "review2 C1 (collector reviewer 0, probe p4.mts)",
    weight: "defect",
  },
  {
    id: "c0522",
    input: { kind: "csv", text: () => (Array.from({length:300},(_, i)=>{const n=i+1; return `${n},Куртка женская зимняя с капюшоном, модель YW-${n},${(n*1.1).toFixed(1)},${(n*1.3).toFixed(1)},${(n/1000).toFixed(3)}`}).join('\n')) },
    expected: {"kind": "text", "textCut": true, "wholeRows": true},
    said: "{\"kind\":\"text\",\"textCut\":true}; no line ends in a truncated figure — never «196 | … | 215.6 | 254.8 | 0.1» where the real cell is 0.196",
    why: "Review2 C4/C5: the mid-row slice handed the model a truncated figure (0.196 became 0.1).",
    source: "review2 C4 (collector reviewer 1); review2 C5",
    weight: "defect",
  },
  {
    id: "c0523",
    input: { kind: "csv", text: () => (Array.from({length:100},(_, i)=>`c${i+1}_`+'x'.repeat(300)).join(',')) },
    expected: {"kind": "text", "textCut": false, "cellsCut": true, "textMinLength": 1},
    said: "{\"kind\":\"text\",\"textCut\":false,\"cellsCut\":true} with a NON-empty text — a single too-long row is shortened, never leaves the text empty, and is not «rows left out»",
    why: "Review2 S4: cap a single line first so one 100-cell row cannot leave the text empty; R3-S6 (lead contract): a row present but shortened is cellsCut, not textCut.",
    source: "review2 S4 (reviewer 1, proposed fix; R3-S6 contract)",
    weight: "defect",
  },
  {
    id: "c1271",
    input: { kind: 'csv', text: () => `${'1'.repeat(30_000)}\nСтол\nСтул\nШкаф\n` },
    expected: {"noThrow": true, "maxMs": 1000},
    said: "returns quickly — the figure scan reads only a cell's first 300 characters (fixer's timing test: unbounded, the cell took 2 s)",
    why: "S7 bound, pinned by a timing test.",
    source: "r2-fixer sheets summary S7 (30,000-digit bound) + r3 sheets rv0 S7",
    weight: "pinned",
    vague: "«returns quickly» (unbounded, the cell took 2 s): under 1,000 ms",
    note: "described only: a one-column list whose header cell is 30,000 digits",
  },
  {
    id: "c1275",
    input: { kind: 'xlsx', sheets: [{ name: 'Заказ', rows: () => [['№', 'Наименование', 'Кол-во', 'Вес, кг'], ...Array.from({ length: 20 }, (_, k): Cell[] => [k + 1, `Товар ${k + 1}`, k + 1, (k + 1) * 2])] }, { name: 'Справочник', state: 'hidden', rows: () => [['Наименование', 'Цена'], ...Array.from({ length: 300 }, (_, k): Cell[] => [`Товар из прайса ${k + 1}`, k + 1])] }] },
    expected: {"kind": "goods", "sheet": "Заказ", "goods": {"rows": [{"name": "Товар 1"}], "count": 20}},
    said: "kind 'goods', sheet 'Заказ', 20 goods (first «Товар 1»)",
    why: "S2: round-1 #14 holds — the visible order beside a hidden 300-line price list.",
    source: "r3 sheets rv1 S2",
    weight: "pinned",
  },
  {
    id: "c1291",
    input: { kind: 'xls', bytes: () => base64Xls('merged') },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5, "weightKg": 100, "amount": 900}, {"name": "Стол", "quantity": 3, "weightKg": 60, "amount": null}, {"name": "Стул", "quantity": 10, "weightKg": 50, "amount": 200}], "count": 3}},
    said: "kind 'goods': Стол 5/100/900 ; Стол 3/60/null ; Стул 10/50/200 — the same as the .xlsx (never dropping the 3 pcs / 60 kg line)",
    why: "S11 note (same in base): readXls has no MERGECELLS handling, so «one rule for every format» leaves out .xls.",
    source: "r3 sheets rv1 S11 note",
    weight: "close-variant",
    note: "the exceljs book (Inv; merges A2:A3, D2:D3) saved by LibreOffice «MS Excel 97»: MERGECELLS + BLANK in the covered cells",
  },
  {
    id: "c1306",
    input: { kind: 'xlsx', sheets: [{ name: 'S', rows: () => [['x', ...Array.from({ length: 30 }, () => '1 '.repeat(15_000) + 'abcdefghij')], ...Array.from({ length: 4999 }, (_, i): Cell[] => [`y${i + 1}`])], merges: Array.from({ length: 30 }, (_, c) => `${colName(c + 1)}1:${colName(c + 1)}5000`) }] },
    expected: {"noThrow": true, "maxMs": 4000},
    said: "returns in about base's time (~0.5 s) — never ~19 s (no per-covered-cell regex over the master's whole text)",
    why: "R3-S7: no per-covered-cell regex — round 2 took 19 s vs base 0.5 s in the app process; keep a timing test.",
    source: "r3 sheets rv1 newDefect 5 + lead R3-S7",
    weight: "defect",
    vague: "«about base's time (~0.5 s) — never ~19 s»: under 4,000 ms (the bound c1879 states for the same sheet)",
    note: "built from the reviewer's description of the sheet",
  },
  {
    id: "c1307",
    input: { kind: 'xlsx', sheets: [{ name: 'S', rows: () => [['x', ...Array.from({ length: 10 }, () => '1 '.repeat(15_000) + 'abcdefghij')], ...Array.from({ length: 4999 }, (_, i): Cell[] => [`y${i + 1}`])], merges: Array.from({ length: 10 }, (_, c) => `${colName(c + 1)}1:${colName(c + 1)}5000`) }] },
    expected: {"noThrow": true, "maxMs": 3000},
    said: "returns in about base's time (~0.3 s) — never ~6.5 s",
    why: "R3-S7: the 10-column variant.",
    source: "r3 sheets rv1 newDefect 5 + lead R3-S7",
    weight: "defect",
    vague: "«about base's time (~0.3 s) — never ~6.5 s»: under 3,000 ms",
    note: "built from the reviewer's description of the sheet",
  },
  {
    id: "c1308",
    input: { kind: "csv", text: () => (Array.from({length:300},(_,i)=>`PL-${i};LED panel light 600x600 40W, ${i} PCS;12.5 kg;0.125 cbm;carton ${i}`).join('\n')), contentType: "text/csv" },
    expected: {"kind": "text", "textCut": true, "cellsCut": false, "wholeRows": true, "lastLineStarts": "PL-188 |", "lastLineEnds": "carton 188"},
    said: "kind 'text', textCut true, cellsCut false; the text ends on a WHOLE row («PL-188 … carton 188», ≈14,984 chars) — never a half row like «PL-189 | LED pa»",
    why: "S4 reader half (fixed): the text is cut only on whole rows, and the cut is said.",
    source: "r3 sheets rv0 S4 + lead R3-S6",
    weight: "pinned",
  },
  {
    id: "c1309",
    input: { kind: "csv", text: () => (Array.from({length:300},(_,i)=>`PL-${i+1},LED panel light 600x600 ${i+1},${10+i},PCS,${(i*1.7).toFixed(2)}KGS`).join('\n')), contentType: "text/csv" },
    expected: {"kind": "text", "textCut": true, "cellsCut": false, "wholeRows": true, "lastLine": "PL-251 | LED panel light 600x600 251 | 260 | PCS | 425.00KGS"},
    said: "kind 'text', textCut true, cellsCut false; last line whole («PL-251 | LED panel light 600x600 251 | 260 | PCS | 425.00KGS»)",
    why: "S4: whole rows (reviewer 1's CSV).",
    source: "r3 sheets rv1 S4 + lead R3-S6",
    weight: "pinned",
  },
  {
    id: "c1311",
    input: { kind: "csv", text: () => ((() => { let csv=''; for (let i=1;i<=20;i++) csv += `${i};Куртка женская модель YW-${i} (女士夹克)${i===3?' 面料 '.repeat(150):''};${i+99};${(i*1.1).toFixed(1)};${(i*1.3).toFixed(1)};0.${String(i).padStart(3,'0')}\n`; return csv; })()), contentType: "text/csv" },
    expected: {"kind": "text", "textCut": false, "cellsCut": true},
    said: "kind 'text', textCut false (all 20 rows reach the model), cellsCut true",
    why: "R3-S6: a 450-char 面料 run in one description is ordinary — never «rows missing».",
    source: "r3 collector rv0 newDefect 1 + lead R3-S6",
    weight: "defect",
  },
  {
    id: "c1312",
    input: { kind: "csv", text: () => (Array.from({length:20},(_,i)=>`${i+1};${i===3?'Женская куртка, материал 100% полиэстер, утеплитель синтепон, '+'x'.repeat(320):`Куртка модель YW-${i}`};${300+i};PCS;${i}.5;${i}.9;0.${i}`).join('\n')+'\n;TOTAL;;;;1234;5.6'), contentType: "text/csv" },
    expected: {"kind": "text", "textCut": false, "cellsCut": true, "textIncludes": ["TOTAL | 1234 | 5.6"]},
    said: "kind 'text', textCut false (every row and the TOTAL row visible), cellsCut true",
    why: "R3-S6: a complete 20-row CSV + TOTAL with one 383-char description.",
    source: "r3 collector rv1 newDefect 1 + lead R3-S6",
    weight: "defect",
  },
  {
    id: "c1762",
    input: { kind: 'xls', bytes: () => base64Xls('merged') },
    expected: {"kind": "goods", "goods": {"rows": [{"name": "Стол", "quantity": 5, "weightKg": 100, "amount": 900}, {"name": "Стол", "quantity": 3, "weightKg": 60}, {"name": "Стул", "quantity": 10, "weightKg": 50, "amount": 200}], "count": 3}},
    said: "{\"kind\":\"goods\",\"goods\":[{\"description\":\"Стол\",\"quantity\":5,\"weightKg\":100,\"amount\":900},{\"description\":\"Стол\",\"quantity\":3,\"weightKg\":60},{\"description\":\"Стул\",\"quantity\":10,\"weightKg\":50,\"amount\":200}]}",
    why: "Excel 97 must read MERGEDCELLS like the XLSX copy (the covered Стол line is not lost)",
    source: "S-r1 ND7",
    weight: "close-variant",
    note: "the exceljs book (Inv; merges A2:A3, D2:D3) saved by LibreOffice «MS Excel 97»: MERGECELLS + BLANK in the covered cells",
  },
  {
    id: "c1763",
    input: { kind: 'csv', text: () => Array.from({ length: 6000 }, (_, i) => (i === 5500 ? 'LAST' : 'a')).join('\n') },
    expected: {"kind": "text", "textCut": true},
    said: "{\"kind\":\"text\",\"textCut\":true}",
    why: "rows/cols past the caps must be reported",
    source: "S-r1 ND8 / integ defect 4",
    weight: "defect",
  },
  {
    id: "c1861",
    input: { kind: 'csv', text: () => Array.from({ length: 20 }, (_, k) => { const i = k + 1; return i === 5 ? 'Ткань полиэфирная, '.repeat(24).slice(0, 450) + ';55;12' : `Kurtka ${i};${10 + i};${i * 2}`; }).join('\n') },
    expected: {"kind": "text", "textCut": false, "cellsCut": true},
    said: "{\"kind\":\"text\",\"textCut\":false,\"cellsCut\":true}",
    why: "accepted (R3-S6 fix)",
    source: "integ ip1",
    weight: "pinned",
  },
  {
    id: "c1875",
    input: { kind: 'csv', text: () => Array.from({ length: 20 }, (_, k) => { const i = k + 1; return `${i};Куртка женская модель YW-${i} (女士夹克)${i === 3 ? ' 面料 '.repeat(150) : ''};${i + 99};${(i * 1.1).toFixed(1)};${(i * 1.3).toFixed(1)};0.${String(i).padStart(3, '0')}`; }).join('\n') },
    expected: {"kind": "text", "textCut": false, "cellsCut": true},
    said: "{\"kind\":\"text\",\"textCut\":false,\"cellsCut\":true}",
    why: "accepted (R3-S6 fix)",
    source: "C-r1 c2sheet",
    weight: "pinned",
    note: "«like rows300»: the c1311 row shape for i = 1..20",
  },
  {
    id: "c1876",
    input: { kind: 'csv', text: () => Array.from({ length: 20 }, (_, i) => `${i + 1};${i === 3 ? 'Женская куртка, материал 100% полиэстер, утеплитель синтепон, ' + 'x'.repeat(320) : `Куртка модель YW-${i}`};${300 + i};PCS;${i}.5;${i}.9;0.${i}`).join('\n') + '\n;TOTAL;;;;1234;5.6' },
    expected: {"kind": "text", "textCut": false, "cellsCut": true},
    said: "{\"kind\":\"text\",\"textCut\":false,\"cellsCut\":true}",
    why: "accepted (R3-S6 fix)",
    source: "C-r1 c2sheet",
    weight: "pinned",
  },
  {
    id: "c1879",
    input: { kind: 'xlsx', sheets: [{ name: 'S', rows: () => [['x', ...Array.from({ length: 30 }, () => '1 '.repeat(15_000) + 'abcdefghij')], ...Array.from({ length: 4999 }, (_, i): Cell[] => [`y${i + 1}`])], merges: Array.from({ length: 30 }, (_, c) => `${colName(c + 1)}1:${colName(c + 1)}5000`) }] },
    expected: {"noThrow": true, "maxMs": 4000, "maxHeapMb": 200},
    said: "returns in well under 4 s (reviewer: NEW 480 ms, BASE 19,620 ms) with heap growth < 200 MB",
    why: "R3-S7: a merged master is read once, never re-scanned per covered cell",
    source: "S-r1 perItem R3-S7",
    weight: "pinned",
    note: "built from the reviewer's description of the sheet",
  },
  {
    id: "c1880",
    input: { kind: 'xlsx', sheets: [{ name: 'S', rows: () => [['Наименование', 'Кол-во'], ['Стол офисный '.repeat(2500), 1], ...Array.from({ length: 4998 }, (_, k): Cell[] => [null, k + 3])], merges: ['A2:A5000'] }] },
    expected: {"noThrow": true, "maxMs": 2000},
    said: "returns quickly (reviewer: NEW 391 ms, BASE 1,847 ms); the long name is read once",
    why: "R3-S7 timing with a 32k-char merged name",
    source: "S-r1 perItem R3-S7",
    weight: "pinned",
    vague: "«returns quickly (reviewer: NEW 391 ms, BASE 1,847 ms)»: under 2,000 ms",
    note: "built from the reviewer's description of the sheet",
  },
  {
    id: "c1881",
    input: { kind: 'xlsx', sheets: [{ name: 'S', rows: () => [['x', '1 '.repeat(15_000) + 'abcdefghij'], ...Array.from({ length: 4999 }, (_, k): Cell[] => [`y${k + 2}`, null])], merges: ['B1:B5000'] }] },
    expected: {"noThrow": true, "maxMs": 4000, "maxHeapMb": 200},
    said: "heap growth well under 200 MB (fixer: +603 MB → +16 MB on a rich master); returns in < 4 s",
    why: "R3-S7 memory bound",
    source: "S-fixer R3-S7",
    weight: "pinned",
    note: "built from the reviewer's description of the sheet",
  },
]);

export const isArticleNumberCases = corpusCases<CorpusCase<string, boolean>>('isArticleNumberCases');

export const statesGoodsCases = corpusCases<CorpusCase<string, boolean>>('statesGoodsCases');

export const threadAiAdviceCases = corpusCases<CorpusCase<string | null, 'retry' | 'admin' | 'smaller' | null>>('threadAiAdviceCases');

export const intakeClientSummaryCases = corpusCases<CorpusCase<string, string | null>>('intakeClientSummaryCases');

export const attemptStandingCases = corpusCases<CorpusCase<[string, number], string>>('attemptStandingCases');

export const scenarioCases = corpusCases<ScenarioCase>('scenarioCases');
