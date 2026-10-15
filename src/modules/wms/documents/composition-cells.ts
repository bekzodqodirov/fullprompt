import type { PaperLine, PaperReason, PaperView } from '../receipts/composition-math';
import { DOC } from './labels';

/**
 * The words the customs papers print about a lot's composition (lot
 * tarkibi, docs/LOT-TARKIBI.md §4) — ONE home for the invoice, both packing
 * lists and the agent file (#513). Pure; every figure comes from
 * `paperLines`, every label from `DOC` (bilingual RU/EN — these files are read
 * at the border and by the Chinese agent, never in the reader's language).
 */

/**
 * One invoice row. Quantity is the line's pieces with «шт» when it states
 * pieces AND they come out ≥ 1 on this truck; otherwise its kg with «кг»
 * (today's rule) — a pieces figure that rounds to 0 never reaches `E`, so
 * `J = I×E` is never zeroed by an invented count.
 */
export function invoiceRowCells(line: PaperLine): {
  product: string;
  code: string;
  unit: 'шт' | 'кг';
  quantity: number;
  places: number | string;
  kg: number;
} {
  const byPieces = line.pieces !== null && line.pieces >= 1;
  return {
    product: line.name,
    code: line.tnvedCode ?? '',
    unit: byPieces ? 'шт' : 'кг',
    quantity: byPieces ? line.pieces! : line.kg,
    places: line.places === 'part' ? DOC.partOfPlace : (line.places ?? ''),
    kg: line.kg,
  };
}

/** The product cell of a packing list's line row: «Мышь — 1000 шт». */
export function packingProductCell(line: PaperLine): string {
  return line.pieces !== null && line.pieces >= 1 ? `${line.name} — ${line.pieces} шт` : line.name;
}

/**
 * The BOXES cell of a line row. «alohida»: the line's own cartons on this
 * truck. «aralash»: every carton holds a mix, so the lot's cartons go on the
 * FIRST line and the others say «(в тех же коробках) / (same cartons)».
 */
export function packingBoxesCell(
  line: PaperLine,
  mode: 'separate' | 'mixed',
  first: boolean,
  lotCartons: number,
): number | string {
  if (mode === 'separate' && line.cartons !== null) return line.cartons;
  return first ? lotCartons : DOC.sameCartons;
}

const fmt1 = (n: number) => n.toFixed(1);
const fmt3 = (n: number) => n.toFixed(3);

/**
 * The agent file's suffix under the lot's Chinese name: every line of the
 * lot's WHOLE planned contents, its TNVED code in brackets when one is set —
 * the sheet is read Chinese-first and the line names are Russian, while a
 * code is language-neutral and is what the export declaration keys on. «≈»
 * before each figure when the view is an estimate.
 */
export function agentContentsText(lines: readonly PaperLine[], estimate: boolean): string {
  const approx = estimate ? '≈' : '';
  const entries = lines.map((l) => {
    const head = `${l.name}${l.tnvedCode ? ` [${l.tnvedCode}]` : ''}`;
    const figures = [
      l.cartons !== null ? `${approx}${l.cartons} кор.` : null,
      `${approx}${fmt1(l.kg)} кг`,
      l.m3 !== null ? `${approx}${fmt3(l.m3)} м³` : null,
      l.pieces !== null && l.pieces >= 1 ? `${approx}${l.pieces} шт` : null,
    ].filter((f): f is string => f !== null);
    return `${head} — ${figures.join(' · ')}`;
  });
  return `${DOC.contents}: ${entries.join('; ')}`;
}

const REASON_TEXT: Record<Exclude<PaperReason, 'share'>, string> = {
  stale: 'лот изменён после ввода состава / lot changed after the contents were stated',
  invalid: 'состав без числа коробок у части строк / contents with carton counts on some lines only',
  pallet: 'места на поддоне распределены по коробкам / pallet places split by cartons',
  clamped: 'коробка учтена на двух машинах / a carton counted on two trucks',
};

/** The cell note of an estimated row: one clause per reason, RU/EN. */
export function estimateNote(view: Pick<PaperView, 'reasons'>, n: number, boxCount: number): string {
  const clauses = view.reasons.map((r) =>
    r === 'share'
      ? `доля лота на этой машине (${n} из ${boxCount} кор.) / lot share on this truck`
      : REASON_TEXT[r],
  );
  return `Расчётно / Estimate: ${clauses.join('; ')}`;
}

/** The light fill an estimated row's product cell wears (the stock sheet's precedent). */
export const ESTIMATE_FILL = {
  type: 'pattern' as const,
  pattern: 'solid' as const,
  fgColor: { argb: 'FFFFF2CC' },
};
