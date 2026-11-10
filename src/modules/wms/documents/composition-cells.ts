import { lineIsLotGood, nameKey, type PaperLine, type PaperReason, type PaperView } from '../receipts/composition-math';
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

/**
 * The product cell of a packing list's line row: the line's name and the
 * lot's Chinese name beside it (his Q6 a, 2026-10-27) — the warehouse finds
 * the cartons by the name on their sticker, which a tarkib never changes.
 * The pieces left this cell for their own column (`packingPiecesCell`); one
 * count printed twice is a count read twice.
 */
export function packingProductCell(line: PaperLine, lot: { zh: string; ru: string | null }): string {
  // The lot's Chinese name (his Q6 a) only beside the line that IS the lot's
  // good: in a two-good lot it named one good on both lines, «Мышь (键盘)»,
  // and on a lot that is wholly another good it named the wrong one (judge
  // product-8). The vouch's own key decides (`lineIsLotGood`).
  const zh = lot.zh.trim();
  return zh && nameKey(zh) !== nameKey(line.name) && lineIsLotGood(line.name, lot) ? `${line.name} (${zh})` : line.name;
}

/**
 * The «Кол-во, шт» cell: the line's pieces on this truck, or BLANK — a
 * stated count that rounds to none here is blank too, never «0», which a
 * reader takes for «no goods» (the invoice refuses 0 for the same reason).
 */
export function packingPiecesCell(line: PaperLine): number | '' {
  return line.pieces !== null && line.pieces >= 1 ? line.pieces : '';
}

/**
 * The agent file's product cell of a tarkib LINE row (the owner's item 2,
 * 2026-11-10 — «yuklamada har bir tarkib alohida qatorlarga bo'linib
 * chiqsin»; docs/TARKIB-TUZATISH.md §4): the packing lists' own product cell
 * (one rule for «the line's name, with the lot's Chinese name beside the line
 * that IS the lot's good»), then the line's TNVED code in brackets when one
 * is stated — the code is language-neutral for a sheet read Chinese-first,
 * and is what the export declaration keys on.
 *
 * `onCarton`: the lot's Chinese name on a SECOND text line, for the first
 * row of a lot none of whose printed lines is the lot's own good. The agent
 * reads Chinese and finds the cartons by the name on their sticker; before
 * the rows were split that name always opened the cell, and a lot typed in
 * Chinese with Russian tarkib lines would otherwise show no Chinese at all.
 */
export function agentProductCell(line: PaperLine, lot: { zh: string; ru: string | null }, onCarton: string | null): string {
  const cell = `${packingProductCell(line, lot)}${line.tnvedCode ? ` [${line.tnvedCode}]` : ''}`;
  return onCarton ? `${cell}\n${DOC.onCarton}: ${onCarton}` : cell;
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

const REASON_TEXT: Record<Exclude<PaperReason, 'share'>, string> = {
  stale: 'лот изменён после ввода состава / lot changed after the contents were stated',
  invalid: 'состав без числа коробок у части строк / contents with carton counts on some lines only',
  pallet: 'места на поддоне распределены по коробкам / pallet places split by cartons',
  clamped: 'коробка учтена на двух машинах / a carton counted on two trucks',
};

/**
 * The cell note of an estimated row: one clause per reason, RU/EN. `where`
 * names what the share is a share OF: a truck's papers print the lot's share
 * on that truck; the agent file prints a plan in BLOCKS (here, on the road,
 * not come), and a fully planned lot split between two blocks is a share of
 * the block — «on this truck» would be untrue of it.
 */
export function estimateNote(
  view: Pick<PaperView, 'reasons'>,
  n: number,
  boxCount: number,
  where: 'truck' | 'block' = 'truck',
): string {
  const share =
    where === 'block'
      ? `доля лота в этом блоке (${n} из ${boxCount} кор.) / lot share in this block`
      : `доля лота на этой машине (${n} из ${boxCount} кор.) / lot share on this truck`;
  const clauses = view.reasons.map((r) => (r === 'share' ? share : REASON_TEXT[r]));
  return `Расчётно / Estimate: ${clauses.join('; ')}`;
}

/** The light fill an estimated row's product cell wears (the stock sheet's precedent). */
export const ESTIMATE_FILL = {
  type: 'pattern' as const,
  pattern: 'solid' as const,
  fgColor: { argb: 'FFFFF2CC' },
};
