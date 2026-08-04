/**
 * The client's "50 goods" spreadsheet (DEALS.md answer 6): parse whatever
 * file the client sent, then let the TNVED assistant propose the grouping.
 *
 * The files are not ours — every client's supplier formats their own — so the
 * header is FOUND, not assumed: the first row that names a goods column wins,
 * and a file with no recognizable header at all degrades to "every row's
 * first text cell is a product". Pure functions over plain cell values, so
 * the whole detective work is unit-testable without an xlsx in sight.
 */

export type Cell = string | number | null;

export interface GoodsRow {
  description: string;
  quantity: number | null;
  unit: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  amount: number | null;
  /** Filled from the TNVED memory before the AI is ever asked. */
  tnvedCode: string | null;
}

interface ColumnMap {
  name: number;
  quantity: number | null;
  unit: number | null;
  weight: number | null;
  volume: number | null;
  amount: number | null;
}

/** Substring keywords per column, lowercased — ru/uz/zh/en, the four the clients actually write. */
const NAME_KEYS = ['наимен', 'товар', 'описан', 'назван', 'nomi', 'mahsulot', 'tovar', 'name', 'descri', 'goods', 'item', '品名', '名称', '货物', '商品', '产品'];
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

function findColumn(header: Cell[], keys: string[], taken: Set<number>): number | null {
  for (let i = 0; i < header.length; i++) {
    if (!taken.has(i) && matchKey(cellText(header[i]!), keys)) return i;
  }
  return null;
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
    const name = findColumn(header, NAME_KEYS, taken);
    if (name === null) continue;
    taken.add(name);
    const claim = (keys: string[]): number | null => {
      const idx = findColumn(header, keys, taken);
      if (idx !== null) taken.add(idx);
      return idx;
    };
    const quantity = claim(QTY_KEYS);
    const unit = claim(UNIT_KEYS);
    // Volume before weight: «вес, кг» must not be eaten by a stray m3 match,
    // and the volume keys are the more specific set.
    const volume = claim(VOLUME_KEYS);
    const weight = claim(WEIGHT_KEYS);
    const amount = claim(AMOUNT_TOTAL_KEYS) ?? claim(AMOUNT_PRICE_KEYS);
    return { headerRow: r, columns: { name, quantity, unit, volume, weight, amount } };
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

  const push = (row: Omit<GoodsRow, 'tnvedCode'>) => {
    const description = row.description.trim();
    if (!description) return;
    if (matchKey(description, TOTAL_ROW_KEYS)) return;
    if (goods.length >= MAX_GOODS_ROWS) return;
    goods.push({ ...row, description: description.slice(0, 300), tnvedCode: null });
  };

  if (detected) {
    const { headerRow, columns } = detected;
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const at = (idx: number | null): Cell => (idx === null ? null : (row[idx] ?? null));
      push({
        description: cellText(at(columns.name)),
        quantity: parseNumber(at(columns.quantity)),
        unit: cellText(at(columns.unit)).slice(0, 20) || null,
        weightKg: parseNumber(at(columns.weight)),
        volumeM3: parseNumber(at(columns.volume)),
        amount: parseNumber(at(columns.amount)),
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
    });
  }
  return { goods, headerRow: null };
}
