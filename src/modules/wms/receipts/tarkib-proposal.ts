import {
  fromUnits,
  KG_SCALE,
  lineIsLotGood,
  M3_SCALE,
  MAX_LINES,
  nameKey,
  storedUnits,
  toCount,
  toUnits,
  type DraftLine,
  type LotTotals,
} from './composition-math';

/**
 * «🤖 Fayldan to'ldirish» — the PROPOSAL, pure (docs/TARKIB-TAKLIFLAR.md §3;
 * the owner, 2026-11-11: «Tarkibni mijozning packing-list fayli yoki rasmidan
 * AI o'qib to'ldirsin — 10–20 qatorni qo'lda yozmaslik uchun»).
 *
 * The model TRANSCRIBES the client's document; this module turns what it
 * transcribed into the tarkib editor's own cells, and the dialog's arithmetic
 * (what is ticked, what it adds up to, what may be applied). Zero imports
 * from `db`, `next` or `react`, like `composition-math.ts`: the route builds
 * the proposal with it and the browser applies it with it.
 *
 * THE RULE the whole file serves: T1 is never a writer and never an author.
 * A figure the reading did not give is an EMPTY cell — never 0, never a
 * share of the lot, never a figure made to fit. Nothing here scales, balances
 * or adds two rows together; the editor's «Saqlash» runs its own parse and
 * its own sums afterwards, unchanged, and a person presses it.
 *
 * The proposal is LOT-INDEPENDENT on purpose: a packing list covers the
 * shipment and a tarkib is one lot's, so one paid reading serves every lot of
 * the prixod (the browser keeps it by attachment id). What depends on the lot
 * — the name rule, the sums beside the lot's own — is computed here, on the
 * screen, from the lot the editor stands on.
 */

/** How many goods one reading lists — the model is told, and the code cuts. */
export const READ_MAX_ROWS = 40;
/** A line name's ceiling in code points — `parseDraft`'s own (the column's CHECK). */
const NAME_MAX = 200;
/** int4's ceiling — pieces and cartons are `integer` columns. */
const INT4_MAX = 2_147_483_647;
/** The model's own sentences are data: shown as they came, but never at any length. */
const UNSURE_MAX = 300;
const NOTES_MAX = 600;

/** One good as the model transcribed it — the structured output's row, verbatim. */
export interface ReadRow {
  name: string;
  name_ru: string | null;
  pieces: number | null;
  cartons: number | null;
  gross_kg: number | null;
  net_kg: number | null;
  volume_m3: number | null;
  hs_code: string | null;
  unsure: string | null;
}

/** The paper's OWN printed total row — never the model's sum. */
export interface ReadTotals {
  cartons: number | null;
  gross_kg: number | null;
  volume_m3: number | null;
}

export type ReadDocument = 'packing_list' | 'invoice' | 'other';

export interface ReadAnswer {
  rows: ReadRow[];
  totals: ReadTotals | null;
  document: ReadDocument;
  notes: string | null;
}

export type ProposalField = 'pieces' | 'cartons' | 'kg' | 'm3';

/**
 * What the code did to one row's value, as a CODE the screen words (four
 * staff locales) — never a sentence composed here. The model's own remarks
 * (`unsure`, `notes`) are the opposite: data, shown exactly as they came.
 */
export type ProposalNote =
  | { code: 'name_cut' }
  | { code: 'name_short' }
  | { code: 'dropped'; params: { field: ProposalField; value: string } }
  | { code: 'rounded'; params: { field: 'kg' | 'm3'; value: string } }
  | { code: 'gross_unused'; params: { value: string } }
  | { code: 'seller_code'; params: { value: string } };

export type ProposalWarning =
  | { code: 'rows_cut'; params: { shown: number; total: number } }
  | { code: 'text_cut' }
  | { code: 'cells_cut' }
  | { code: 'doc_invoice' }
  | { code: 'doc_other' }
  | { code: 'totals_differ'; params: { field: 'cartons' | 'kg' | 'm3'; sum: string; total: string } };

/**
 * Is this a warning this build knows how to word? Asked of a warning that
 * came back out of the browser's own storage (the editor's draft keeps the
 * reading's warnings until «Saqlash»): a draft written by yesterday's build
 * must not put a shape today's switch cannot read on the screen.
 */
export function isProposalWarning(value: unknown): value is ProposalWarning {
  if (typeof value !== 'object' || value === null) return false;
  const { code, params } = value as { code?: unknown; params?: Record<string, unknown> | null };
  switch (code) {
    case 'text_cut':
    case 'cells_cut':
    case 'doc_invoice':
    case 'doc_other':
      return true;
    case 'rows_cut':
      return typeof params?.shown === 'number' && typeof params.total === 'number';
    case 'totals_differ':
      return (
        (params?.field === 'cartons' || params?.field === 'kg' || params?.field === 'm3') &&
        typeof params.sum === 'string' &&
        typeof params.total === 'string'
      );
    default:
      return false;
  }
}

export interface ProposalRow {
  /** The good as the PAPER names it — one line, at most 200 characters. */
  name: string;
  /** The model's Russian customs wording, when the paper's name is not Russian. */
  nameRu: string | null;
  /** The editor's own cells, in the editor's own spelling; '' = the reading gave no such figure. */
  pieces: string;
  cartons: string;
  kg: string;
  m3: string;
  tnved: string;
  notes: ProposalNote[];
  /** What the model could not read with certainty — its words. */
  unsure: string | null;
}

export interface TarkibProposal {
  rows: ProposalRow[];
  /** Which weight the kg cells carry — ONE kind for every row, or none at all. */
  weightKind: 'gross' | 'net' | null;
  /** The paper's own printed totals, in the cells' spelling. */
  fileTotals: { cartons: string | null; kg: string | null; m3: string | null } | null;
  document: ReadDocument;
  warnings: ProposalWarning[];
  /** The model's remark about the document as a whole — its words. */
  notes: string | null;
  /** How many lots the prixod holds: with more than one, nothing is ticked to begin with. */
  lotsOnReceipt: number;
}

/** A figure as a person writes it: 37.800000000000004 → «37.8». */
export function figureText(x: number): string {
  return Number.isFinite(x) ? String(Number(x.toPrecision(12))) : String(x);
}

/**
 * The reading's figure as an EXACT decimal: `digits × 10^exp`.
 *
 * Twelve significant digits first — a spreadsheet's formula result arrives as
 * a binary float (0.1 + 0.2, 37.800000000000004), and `toPrecision(12)` is the
 * shortest honest reading of one. The string it returns IS a decimal, so from
 * here on the arithmetic is BigInt: `x * 1000` in floating point is how
 * 1.0005 becomes 1000.4999999999999 and rounds the wrong way.
 */
function exactDecimal(x: number): { digits: bigint; exp: number } | null {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(x.toPrecision(12));
  if (!m) return null;
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1]! + frac), exp: Number(m[3] ?? 0) - frac.length };
}

/**
 * A MEASURE the reading gave → the editor cell at the column's scale (kg 3
 * decimals, m³ 4), in the column's own spelling (`fromUnits`), so the
 * editor's `toUnits` reads back exactly what is shown.
 *
 *  · null stays an empty cell and says nothing: the paper gave no figure.
 *  · A figure that is not a positive number, is past the column, or rounds to
 *    0 at the column's scale is an EMPTY cell and `dropped` — never «0.000»,
 *    which the save would refuse about a cell nobody typed.
 *  · More decimals than the column holds: rounded half-up, and `rounded` —
 *    the person is told the cell is not the paper's figure to the digit.
 */
export function measureCell(x: number | null, scale: number): { cell: string; note: 'dropped' | 'rounded' | null } {
  if (x === null) return { cell: '', note: null };
  // numeric(12, scale): what the column can hold at all.
  if (!Number.isFinite(x) || x <= 0 || x >= 10 ** (12 - scale)) return { cell: '', note: 'dropped' };
  const exact = exactDecimal(x);
  if (!exact) return { cell: '', note: 'dropped' };
  const shift = exact.exp + scale;
  let units: bigint;
  let rounded = false;
  if (shift >= 0) {
    units = exact.digits * 10n ** BigInt(shift);
  } else {
    const d = 10n ** BigInt(-shift);
    const rest = exact.digits % d;
    units = exact.digits / d + (2n * rest >= d ? 1n : 0n);
    rounded = rest !== 0n;
  }
  if (units <= 0n) return { cell: '', note: 'dropped' };
  return { cell: fromUnits(Number(units), scale), note: rounded ? 'rounded' : null };
}

/**
 * A COUNT the reading gave → the cell: whole only when the figure is within
 * 1e-9 of an integer (a float's noise, not a fraction) and fits the column.
 * «12.5 cartons» is not thirteen and not twelve — an empty cell and a note.
 */
export function countCell(x: number | null): { cell: string; note: 'dropped' | null } {
  if (x === null) return { cell: '', note: null };
  const whole = Math.round(x);
  if (Number.isFinite(x) && Math.abs(x - whole) <= 1e-9 && whole >= 1 && whole <= INT4_MAX) {
    return { cell: String(whole), note: null };
  }
  return { cell: '', note: 'dropped' };
}

/** One line, trimmed: a name typed over two lines of a cell is still one name. */
const oneLine = (raw: string | null | undefined): string =>
  String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Cut by CODE POINTS — what the column's CHECK counts, and never half an emoji. */
function cutTo(text: string, max: number): { text: string; cut: boolean } {
  const points = [...text];
  return points.length > max ? { text: points.slice(0, max).join('').trim(), cut: true } : { text, cut: false };
}

/**
 * The supplier's code column → the TNVED cell.
 *
 * Kept only when it is exactly ten digits. A six- or eight-digit HS code is
 * the EXPORTER's classification: its first six digits are the international
 * heading and the rest is another country's tariff. Written into the cell it
 * would look like a code somebody chose — it goes into a note instead, where
 * it is what it is: a hint for whoever codes the line.
 */
function codeCell(raw: string | null): { cell: string; note: ProposalNote | null } {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return { cell: digits, note: null };
  if (digits.length >= 4) return { cell: '', note: { code: 'seller_code', params: { value: digits.slice(0, 20) } } };
  return { cell: '', note: null };
}

const sumUnits = (cells: readonly string[], scale: number): number | null => {
  let sum = 0;
  for (const cell of cells) {
    const units = toUnits(cell, scale);
    if (units === null) return null;
    sum += units;
  }
  return sum;
};

/**
 * What the model transcribed → the proposal (everything but the prixod's lot
 * count, which the route adds).
 *
 * WEIGHT, all or none: the kg cells carry the GROSS weight only when EVERY
 * row states its own — the lot's stored kg is what the warehouse weighed, so
 * gross is the closer figure — and otherwise the NET weight for every row.
 * Never a mixture: a column that is gross on three rows and net on two adds
 * up to nothing anybody measured. A gross figure that could not be used (the
 * paper printed one for a group of rows, or for some rows only) stays on its
 * row as a note, so the figure is not lost — only not written.
 */
export function buildProposal(
  answer: ReadAnswer,
  file: { rowsCut: boolean; cellsCut: boolean },
): Omit<TarkibProposal, 'lotsOnReceipt'> {
  const warnings: ProposalWarning[] = [];
  if (file.rowsCut) warnings.push({ code: 'text_cut' });
  if (file.cellsCut) warnings.push({ code: 'cells_cut' });
  if (answer.document === 'invoice') warnings.push({ code: 'doc_invoice' });
  if (answer.document === 'other') warnings.push({ code: 'doc_other' });

  // A row that names nothing and states nothing is a blank line of the paper.
  const stated = answer.rows.filter(
    (row) =>
      oneLine(row.name) !== '' ||
      [row.pieces, row.cartons, row.gross_kg, row.net_kg, row.volume_m3].some((v) => v !== null),
  );
  const listed = stated.slice(0, READ_MAX_ROWS);
  if (stated.length > listed.length) {
    warnings.push({ code: 'rows_cut', params: { shown: listed.length, total: stated.length } });
  }

  const gross = listed.map((row) => measureCell(row.gross_kg, KG_SCALE));
  const net = listed.map((row) => measureCell(row.net_kg, KG_SCALE));
  const allGross = listed.length > 0 && gross.every((g) => g.cell !== '');
  const weightKind: TarkibProposal['weightKind'] = allGross ? 'gross' : net.some((n) => n.cell !== '') ? 'net' : null;

  const rows: ProposalRow[] = listed.map((row, i) => {
    const notes: ProposalNote[] = [];
    const paper = cutTo(oneLine(row.name), NAME_MAX);
    if (paper.cut) notes.push({ code: 'name_cut' });
    if ([...paper.text].length < 2) notes.push({ code: 'name_short' });
    const russian = cutTo(oneLine(row.name_ru), NAME_MAX).text;
    // A translation of fewer than two characters is no name, and one that only
    // repeats the paper's is no second name.
    const nameRu = [...russian].length >= 2 && nameKey(russian) !== nameKey(paper.text) ? russian : null;

    const pieces = countCell(row.pieces);
    if (pieces.note) notes.push({ code: 'dropped', params: { field: 'pieces', value: figureText(row.pieces!) } });
    const cartons = countCell(row.cartons);
    if (cartons.note) notes.push({ code: 'dropped', params: { field: 'cartons', value: figureText(row.cartons!) } });

    const weight = allGross ? gross[i]! : net[i]!;
    const weighed = allGross ? row.gross_kg : row.net_kg;
    if (weight.note) notes.push({ code: weight.note, params: { field: 'kg', value: figureText(weighed!) } });
    if (!allGross && gross[i]!.cell !== '') notes.push({ code: 'gross_unused', params: { value: gross[i]!.cell } });

    const volume = measureCell(row.volume_m3, M3_SCALE);
    if (volume.note) notes.push({ code: volume.note, params: { field: 'm3', value: figureText(row.volume_m3!) } });

    const code = codeCell(row.hs_code);
    if (code.note) notes.push(code.note);

    return {
      name: paper.text,
      nameRu,
      pieces: pieces.cell,
      cartons: cartons.cell,
      kg: weight.cell,
      m3: volume.cell,
      tnved: code.cell,
      notes,
      unsure: cutTo(oneLine(row.unsure), UNSURE_MAX).text || null,
    };
  });

  const totals = answer.totals;
  const fileTotals = totals
    ? {
        cartons: countCell(totals.cartons).cell || null,
        kg: measureCell(totals.gross_kg, KG_SCALE).cell || null,
        m3: measureCell(totals.volume_m3, M3_SCALE).cell || null,
      }
    : null;
  const printed = fileTotals && (fileTotals.cartons || fileTotals.kg || fileTotals.m3) ? fileTotals : null;

  // The one cheap check that every digit was read: where the paper prints its
  // own total AND every listed row states that measure, the rows must add up
  // to it. Only when nothing was cut — a list cut at forty rows is short of
  // its total by construction. Said, never corrected.
  if (printed && !file.rowsCut && stated.length === listed.length && rows.length > 0) {
    if (printed.cartons && rows.every((r) => r.cartons !== '')) {
      const sum = rows.reduce((s, r) => s + (toCount(r.cartons) ?? 0), 0);
      if (String(sum) !== printed.cartons) {
        warnings.push({ code: 'totals_differ', params: { field: 'cartons', sum: String(sum), total: printed.cartons } });
      }
    }
    if (printed.kg && weightKind === 'gross') {
      const sum = sumUnits(rows.map((r) => r.kg), KG_SCALE);
      if (sum !== null && sum !== storedUnits(printed.kg, KG_SCALE)) {
        warnings.push({ code: 'totals_differ', params: { field: 'kg', sum: fromUnits(sum, KG_SCALE), total: printed.kg } });
      }
    }
    if (printed.m3) {
      const sum = sumUnits(rows.map((r) => r.m3), M3_SCALE);
      if (sum !== null && sum !== storedUnits(printed.m3, M3_SCALE)) {
        warnings.push({ code: 'totals_differ', params: { field: 'm3', sum: fromUnits(sum, M3_SCALE), total: printed.m3 } });
      }
    }
  }

  return {
    rows,
    weightKind,
    fileTotals: printed,
    document: answer.document,
    warnings,
    notes: cutTo(oneLine(answer.notes), NOTES_MAX).text || null,
  };
}

/** The lot the editor stands on, as the name rule reads it — its STORED names. */
export interface ProposalLot {
  zh: string;
  ru: string | null;
}

/**
 * The name a proposed row is APPLIED under.
 *
 *  1. The row names the lot's OWN good — the paper's name or the model's
 *     Russian one equals the lot's Chinese or stored Russian name by
 *     `nameKey` — → the lot's own name, exactly as «Bitta tovar» writes it:
 *     the stored Russian name, else the Chinese one.
 *  2. Otherwise the model's Russian wording, when it gave one.
 *  3. Otherwise the paper's own words.
 *
 * Rule 1 is what keeps the save's `tnved_would_vanish` guard meaningful
 * (`lot-composition.ts refuseVanishingCode`): that guard recognises a ONE-line
 * tarkib of the lot's own good by its NAME and refuses to let the code the
 * memory holds for the lot vanish from the invoice. A translation would walk
 * straight past it — the paper says «键盘», the lot is «键盘», the model
 * writes «Клавиатура компьютерная», and the saved line is a stranger to the
 * guard: the invoice prints it with no code and nobody was told. Keeping the
 * lot's own name there is the whole point; `own` lets the dialog say why the
 * row was not translated.
 */
export function appliedName(
  row: { name: string; nameRu: string | null },
  lot: ProposalLot,
): { name: string; own: boolean } {
  const own = lineIsLotGood(row.name, lot) || (row.nameRu !== null && lineIsLotGood(row.nameRu, lot));
  if (own) return { name: (lot.ru ?? '').trim() || lot.zh.trim(), own: true };
  return { name: row.nameRu ?? row.name, own: false };
}

/** The editor line a proposed row becomes — its cells as they are, its name by the rule. */
export function draftLineOf(row: ProposalRow, lot: ProposalLot): DraftLine {
  return {
    name: appliedName(row, lot).name,
    pieces: row.pieces,
    cartons: row.cartons,
    kg: row.kg,
    m3: row.m3,
    tnved: row.tnved,
  };
}

/** May every row be ticked when the dialog opens? Only when that cannot be wrong by construction. */
export function tickedToBegin(proposal: Pick<TarkibProposal, 'rows' | 'lotsOnReceipt'>): boolean {
  return proposal.rows.length <= MAX_LINES && proposal.lotsOnReceipt === 1;
}

export interface TickedSums {
  count: number;
  cartons: number;
  kgUnits: number;
  m3Units: number;
  /** Ticked rows that state no such figure — the sum beside them is short by an unknown amount. */
  missing: { cartons: number; kg: number; m3: number };
}

/** Σ of the TICKED rows, per measure, in the columns' own units — shown beside the lot's, never forced onto it. */
export function tickedSums(rows: readonly ProposalRow[], ticked: ReadonlySet<number>): TickedSums {
  const out: TickedSums = { count: 0, cartons: 0, kgUnits: 0, m3Units: 0, missing: { cartons: 0, kg: 0, m3: 0 } };
  rows.forEach((row, i) => {
    if (!ticked.has(i)) return;
    out.count += 1;
    const cartons = toCount(row.cartons);
    if (cartons === null) out.missing.cartons += 1;
    else out.cartons += cartons;
    const kg = toUnits(row.kg, KG_SCALE);
    if (kg === null) out.missing.kg += 1;
    else out.kgUnits += kg;
    const m3 = toUnits(row.m3, M3_SCALE);
    if (m3 === null) out.missing.m3 += 1;
    else out.m3Units += m3;
  });
  return out;
}

/** The lot's own figures in the same units — what the ticked sums stand beside. */
export function lotUnits(lot: LotTotals): { cartons: number; kgUnits: number; m3Units: number } {
  return { cartons: lot.boxCount, kgUnits: storedUnits(lot.kg, KG_SCALE), m3Units: storedUnits(lot.m3, M3_SCALE) };
}

/** Names that occur more than once by the tarkib's own duplicate key — each named once, as first written. */
export function duplicateNames(names: readonly string[]): string[] {
  const seen = new Map<string, { name: string; n: number }>();
  for (const name of names) {
    const key = nameKey(name);
    if (key === '') continue;
    const entry = seen.get(key);
    if (entry) entry.n += 1;
    else seen.set(key, { name: name.trim(), n: 1 });
  }
  return [...seen.values()].filter((entry) => entry.n > 1).map((entry) => entry.name);
}

const isBlankLine = (l: DraftLine): boolean =>
  [l.name, l.pieces, l.cartons, l.kg, l.m3, l.tnved].every((v) => String(v ?? '').trim() === '');

/** Does the editor hold anything a person typed? Then Apply asks «add» or «replace». */
export function hasTypedLines(lines: readonly DraftLine[]): boolean {
  return lines.some((line) => !isBlankLine(line));
}

export type ApplyRefusal =
  | { code: 'none' }
  | { code: 'too_many'; n: number }
  | { code: 'duplicates'; names: string[] }
  | { code: 'append_overflow'; have: number; add: number }
  | { code: 'append_duplicates'; names: string[] };

/**
 * The ticked rows → the editor's lines, or the reason in a code.
 *
 * Refused, never repaired: more than twenty goods, and two rows of one name.
 * Two «Мышь» rows of a packing list are two cartons' worth of mice OR the
 * same line printed twice — only the person looking at the paper knows, so
 * nothing is ever added together here.
 *
 * `replace` drops what the editor held; `append` keeps its typed rows (blank
 * ones go) and puts the ticked rows after them — refused past twenty lines
 * and when a ticked row repeats a name already typed.
 */
export function applyProposal(input: {
  rows: readonly ProposalRow[];
  ticked: ReadonlySet<number>;
  lot: ProposalLot;
  existing: readonly DraftLine[];
  how: 'replace' | 'append';
}): { ok: true; lines: DraftLine[] } | { ok: false; refusal: ApplyRefusal } {
  const picked = input.rows.filter((_, i) => input.ticked.has(i)).map((row) => draftLineOf(row, input.lot));
  if (picked.length === 0) return { ok: false, refusal: { code: 'none' } };
  if (picked.length > MAX_LINES) return { ok: false, refusal: { code: 'too_many', n: picked.length } };
  const twice = duplicateNames(picked.map((line) => line.name));
  if (twice.length > 0) return { ok: false, refusal: { code: 'duplicates', names: twice } };
  if (input.how === 'replace') return { ok: true, lines: picked };

  const kept = input.existing.filter((line) => !isBlankLine(line));
  if (kept.length + picked.length > MAX_LINES) {
    return { ok: false, refusal: { code: 'append_overflow', have: kept.length, add: picked.length } };
  }
  const typed = new Set(kept.map((line) => nameKey(line.name)));
  const again = picked.filter((line) => typed.has(nameKey(line.name))).map((line) => line.name);
  if (again.length > 0) return { ok: false, refusal: { code: 'append_duplicates', names: again } };
  return { ok: true, lines: [...kept, ...picked] };
}

/** Ticked rows that state cartons beside ticked rows that do not — the editor's «alohida» would refuse them. */
export function cartonsMixed(rows: readonly ProposalRow[], ticked: ReadonlySet<number>): boolean {
  const picked = rows.filter((_, i) => ticked.has(i));
  const stated = picked.filter((row) => row.cartons !== '').length;
  return stated > 0 && stated < picked.length;
}
