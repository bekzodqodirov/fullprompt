import { normalizeTnved, unitOf } from '../calc/units';

/**
 * The client's "50 goods" spreadsheet (DEALS.md answer 6): parse whatever
 * file the client sent, then let the TNVED assistant propose the grouping.
 *
 * The files are not ours — every client's supplier formats their own — so the
 * header is FOUND, not assumed: the first row that names a goods column wins,
 * and a file with no recognizable header at all degrades to "every row's
 * first text cell is a product". Pure functions over plain cell values, so
 * the whole detective work is unit-testable without an xlsx in sight.
 *
 * Three consumers — the deal's «Позиции» import, the staff bot's invoice
 * reader and the VED workspace's Excel paste — so a column read here is read
 * the same way at every door (#513).
 */

export type Cell = string | number | null;

export interface GoodsRow {
  description: string;
  /** The quantity column's number, in `unit` — PIECES unless the unit (the
   * unit column's word, else the quantity header's own word) names another
   * column. The calc door routes it (`normalizeRowUnit`); a deal line keeps
   * it as the sheet wrote it. */
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  amount: number | null;
  /**
   * The SUPPLIER's own code when the file carries a TNVED column (2026-10-09,
   * the audit's «a TNVED column in an Excel invoice is ignored»), else filled
   * from the TNVED memory before the AI is ever asked.
   */
  tnvedCode: string | null;
  /** What the reader could not use and will not drop: a code cell that is
   * not a code, said in words for the VED. */
  note: string | null;
}

interface ColumnMap {
  name: number;
  tnved: number | null;
  quantity: number | null;
  /** The quantity header's own unit word («Кол-во, м2» → м2), used when a
   * row has no unit cell of its own. */
  quantityUnit: string | null;
  unit: number | null;
  weight: number | null;
  volume: number | null;
  amount: number | null;
}

/** Substring keywords per column, lowercased — ru/uz/zh/en, the four the clients actually write. */
const NAME_KEYS = ['наимен', 'товар', 'описан', 'назван', 'nomi', 'mahsulot', 'tovar', 'name', 'descri', 'goods', 'item', '品名', '名称', '货物', '商品', '产品'];
/**
 * The TNVED / HS column (judge MR-19). Never a bare «hs» or «kod»: header
 * keys match as SUBSTRINGS, so «hs» is inside «Widths» and «kod» inside
 * «Tovar kodi» / «Mijoz kodi» — an article number then priced under a real
 * heading. And it is claimed only when most of its data cells READ as codes.
 */
const TNVED_KEYS = ['hs code', 'hs-code', 'тн вэд', 'тнвэд', 'tn ved', 'tnved', '海关编码', '商品编码'];
const QTY_KEYS = ['кол-во', 'кол.', 'количество', 'колич', 'soni', 'miqdor', 'dona', 'qty', 'quantity', 'pcs', '数量', '件数'];
const UNIT_KEYS = ['ед.', 'ед изм', 'единиц', 'birlik', 'unit', '单位'];
const WEIGHT_KEYS = ['вес', 'кг', "og'irlik", 'ogirlik', 'vazn', 'weight', 'kg', '重量', '毛重', '净重'];
const VOLUME_KEYS = ['объем', 'объём', 'куб', 'м3', 'м³', 'hajm', 'kub', 'volume', 'cbm', 'm3', 'm³', '体积', '立方'];
// Totals first: a file carrying both «цена» (per unit) and «сумма» (the line
// total) must land on the total — profit and customs both read line money.
const AMOUNT_TOTAL_KEYS = ['сумма', 'стоимость', 'итог', 'summa', 'umumiy', 'amount', 'total', '金额', '总价'];
const AMOUNT_PRICE_KEYS = ['цена', 'narx', 'price', '单价', '价格'];

/** Rows that are arithmetic, not goods. */
const TOTAL_ROW_KEYS = ['итого', 'всего', 'jami', 'total', '合计', '总计'];

/** How many data rows a column's content is judged by. */
const SAMPLE_ROWS = 50;

const cellText = (cell: Cell): string => (cell === null ? '' : String(cell).trim());

const matchKey = (text: string, keys: string[]): boolean => {
  const t = text.toLowerCase();
  return t.length > 0 && keys.some((k) => t.includes(k));
};

/** `1 234,56` and `1,234.56` both reach us; the last separator is the decimal one. */
export function parseNumber(cell: Cell): number | null {
  if (cell === null) return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
  const text = cell.trim().replace(/\s+/g, '');
  if (!text) return null;
  const normalized =
    text.includes(',') && text.includes('.')
      ? text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '')
      : text.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A cell that reads as a TNVED code — the kernel's own shape rule. */
const isCodeCell = (cell: Cell) => cellText(cell) !== '' && normalizeTnved(cell) !== null;

/** The non-empty data cells of one column, under a header row. */
function columnCells(rows: Cell[][], headerRow: number, col: number): Cell[] {
  return rows
    .slice(headerRow + 1, headerRow + 1 + SAMPLE_ROWS)
    .map((row) => row[col] ?? null)
    .filter((cell) => cellText(cell) !== '');
}

function findColumn(
  header: Cell[],
  keys: string[],
  taken: Set<number>,
  accept: (index: number) => boolean = () => true,
): number | null {
  for (let i = 0; i < header.length; i++) {
    if (!taken.has(i) && matchKey(cellText(header[i]!), keys) && accept(i)) return i;
  }
  return null;
}

/** The unit a header names with its last word — «Кол-во, кг» is a weight. */
function headerUnitWord(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}\d²³]+/u).filter(Boolean);
  const last = words.at(-1) ?? null;
  return last && unitOf(last) !== null ? last : null;
}

/**
 * Find the header row (within the first ten — files open with logos and
 * legal names) and map its columns. Null when the file has no header we can
 * read: that is not a failure, it is single-column mode.
 */
export function detectColumns(rows: Cell[][]): { headerRow: number; columns: ColumnMap } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const header = rows[r]!;
    const taken = new Set<number>();
    const mostlyCodes = (i: number) => {
      const cells = columnCells(rows, r, i);
      return cells.length === 0 || cells.filter(isCodeCell).length * 2 > cells.length;
    };
    const allCodes = (i: number) => {
      const cells = columnCells(rows, r, i);
      return cells.length > 0 && cells.every(isCodeCell);
    };
    // The TNVED column is claimed BEFORE the name keys run: «Код ТН ВЭД
    // товара» contains «товар», and taken as the NAME it named every
    // product by its code and lost the code (the audit, reproduced).
    const tnved = findColumn(header, TNVED_KEYS, taken, mostlyCodes);
    if (tnved !== null) taken.add(tnved);
    // …and a name column is never one whose data are all codes («Goods
    // code», «Tovar kodi» to the left of the real name).
    const name = findColumn(header, NAME_KEYS, taken, (i) => !allCodes(i));
    if (name === null) continue;
    taken.add(name);
    const claim = (keys: string[]): number | null => {
      const idx = findColumn(header, keys, taken);
      if (idx !== null) taken.add(idx);
      return idx;
    };

    // The quantity header's OWN unit word decides what its numbers are: a
    // «Кол-во, кг» column is a WEIGHT, «Кол-во, м3» a volume, and a carton
    // column («Кол-во мест») is never preferred over a piece column.
    let quantity: number | null = null;
    let quantityUnit: string | null = null;
    let weightFromQty: number | null = null;
    let volumeFromQty: number | null = null;
    let cartonCol: { index: number; word: string } | null = null;
    for (let i = 0; i < header.length; i++) {
      if (taken.has(i) || !matchKey(cellText(header[i]!), QTY_KEYS)) continue;
      const word = headerUnitWord(cellText(header[i]!));
      const unit = unitOf(word);
      if (unit === 'kg') weightFromQty ??= i;
      else if (unit === 'm3') volumeFromQty ??= i;
      else if (unit === 'karobka') cartonCol ??= { index: i, word: word! };
      else if (quantity === null) {
        quantity = i;
        quantityUnit = unit === 'dona' || unit === null ? null : word;
      } else continue;
      taken.add(i);
    }
    if (quantity === null && cartonCol) {
      // Only cartons: their number goes where a carton count goes — through
      // the door's rule into the note, never into the piece column.
      quantity = cartonCol.index;
      quantityUnit = cartonCol.word;
    } else if (cartonCol) {
      taken.delete(cartonCol.index);
    }
    const unit = claim(UNIT_KEYS);
    // Volume before weight: «вес, кг» must not be eaten by a stray m3 match,
    // and the volume keys are the more specific set.
    const volume = volumeFromQty ?? claim(VOLUME_KEYS);
    const weight = weightFromQty ?? claim(WEIGHT_KEYS);
    const amount = claim(AMOUNT_TOTAL_KEYS) ?? claim(AMOUNT_PRICE_KEYS);
    return {
      headerRow: r,
      columns: { name, tnved, quantity, quantityUnit, unit, volume, weight, amount },
    };
  }
  return null;
}

export const MAX_GOODS_ROWS = 500;

/**
 * The whole file → goods rows. With a header, each mapped column; without
 * one, the first non-empty text cell of each row is the product and nothing
 * else is guessed at.
 */
export function parseGoods(rows: Cell[][]): { goods: GoodsRow[]; headerRow: number | null } {
  const detected = detectColumns(rows);
  const goods: GoodsRow[] = [];

  const push = (row: GoodsRow) => {
    const description = row.description.trim();
    if (!description) return;
    if (matchKey(description, TOTAL_ROW_KEYS)) return;
    if (goods.length >= MAX_GOODS_ROWS) return;
    goods.push({ ...row, description: description.slice(0, 300) });
  };

  if (detected) {
    const { headerRow, columns } = detected;
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const at = (idx: number | null): Cell => (idx === null ? null : (row[idx] ?? null));
      // The code cell as the file holds it: a NUMERIC nine-digit cell lost
      // its leading zero to Excel and is padded; typed text of nine digits is
      // a question, and any other non-code is said rather than dropped.
      const codeCell = at(columns.tnved);
      const code = normalizeTnved(codeCell);
      const codeNote =
        cellText(codeCell) === ''
          ? null
          : code && 'problem' in code
            ? `TNVED «${code.text}» — 9 xonali: boshida 0 tushib qolganmi?`
            : code === null
              ? `TNVED «${cellText(codeCell).slice(0, 40)}» — kod emas`
              : null;
      push({
        description: cellText(at(columns.name)),
        quantity: parseNumber(at(columns.quantity)),
        unit: (cellText(at(columns.unit)) || columns.quantityUnit || '').slice(0, 20) || null,
        weightKg: parseNumber(at(columns.weight)),
        volumeM3: parseNumber(at(columns.volume)),
        amount: parseNumber(at(columns.amount)),
        tnvedCode: code && 'code' in code ? code.code : null,
        note: codeNote,
      });
    }
    return { goods, headerRow };
  }

  for (const row of rows) {
    const first = row.find((cell) => typeof cell === 'string' && cell.trim().length > 0);
    push({
      description: cellText(first ?? null),
      quantity: null,
      unit: null,
      weightKg: null,
      volumeM3: null,
      amount: null,
      tnvedCode: null,
      note: null,
    });
  }
  return { goods, headerRow: null };
}
