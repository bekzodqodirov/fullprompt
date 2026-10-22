import { readNumberCell } from '../calc/number-cell';
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

/**
 * The widest row a sheet reader keeps (`xls.ts` re-exports it as `MAX_COLS`),
 * and so the stride of a position in `CoverMask`.
 */
export const SHEET_MAX_COLS = 100;

/**
 * The positions a merge DOWN covers in its master's own column (R3-S3, the
 * third review). Every reader repeats the master's VALUE into them — as
 * exceljs always did for an .xlsx — and says WHICH they are, so the decision
 * is made by the COLUMN the position stands in and never by what the text
 * looks like: a TNVED code, a unit price or a name merged over two lines
 * names both («LED 50W», «USB 3.0» and «12V» looked like figures to the
 * content rule and the covered line was dropped), while a quantity, a
 * weight, a volume or a line total merged over them is the carton's, stated
 * once and counted once (`parseGoods`).
 */
export interface Covered {
  has(row: number, col: number): boolean;
}

/**
 * A `Covered` as a bitmap, grown as rows arrive: a reader's sheet holds up to
 * 5,000 × 100 positions, so a sheet merged top to bottom is 62 KB here, where
 * a `Set` of half a million numbers — 32 sheets a workbook — would be hundreds
 * of megabytes for one forwarded file.
 */
export class CoverMask implements Covered {
  private bits = new Uint8Array(0);
  private count = 0;

  add(row: number, col: number): void {
    if (row < 0 || col < 0 || col >= SHEET_MAX_COLS) return;
    const at = row * SHEET_MAX_COLS + col;
    const byte = at >> 3;
    if (byte >= this.bits.length) {
      const grown = new Uint8Array(Math.max(byte + 1, this.bits.length * 2));
      grown.set(this.bits);
      this.bits = grown;
    }
    const bit = 1 << (at & 7);
    if ((this.bits[byte]! & bit) === 0) this.count += 1;
    this.bits[byte]! |= bit;
  }

  has(row: number, col: number): boolean {
    if (row < 0 || col < 0 || col >= SHEET_MAX_COLS) return false;
    const at = row * SHEET_MAX_COLS + col;
    return ((this.bits[at >> 3] ?? 0) & (1 << (at & 7))) !== 0;
  }

  get size(): number {
    return this.count;
  }
}

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
  /**
   * The money column is a UNIT price (no line total in the file). A price
   * merged over two lines is the price of both — it repeats; a line total
   * merged over them is stated once (R3-S3).
   */
  amountIsPrice: boolean;
}

/** Substring keywords per column, lowercased — ru/uz/zh/en, the four the clients actually write. */
const NAME_KEYS = ['наимен', 'товар', 'описан', 'назван', 'nomi', 'mahsulot', 'tovar', 'name', 'descri', 'goods', 'item', '品名', '名称', '货物', '商品', '产品'];
/**
 * The keys tried first: every name key but «item» (2026-10-21, the diagnosis'
 * cause 1 — «Item No.» took the name column from «Description» two cells
 * further on, and every product was called YW-2301). «item» was the ONLY key
 * that did it; a first tier that also dropped «товар» and «name» jumped past
 * «Товар» / «Product Name» to the «Описание» / «Description» beside them, and
 * the fabric spec became the product (the review).
 */
const NAME_KEYS_FIRST = NAME_KEYS.filter((key) => key !== 'item');
/**
 * A header that carries a name key and names something ELSE (S5, the second
 * review): «Код товара», «Артикул товара», «Товарный знак», «Tovar kodi»,
 * «Brand name», «品牌名称» are an attribute OF the goods; «Customer name»,
 * «Mijoz nomi», «Наименование покупателя» a party. «товар» and «name» are
 * first-tier keys, so such a column to the LEFT of the real name took it —
 * a УПД's 1C code «ЦБ-00012345» became every product's name, the brand
 * «Xiaomi» the vacuum cleaner's. Judged on the header's HEAD, before the first
 * «(», «,» or «;»: «Наименование товара (марка, модель)» LISTS what the
 * column holds and is the name.
 */
const NAME_ATTRIBUTE = /код|kod|code|артикул|арт(?![а-яё])|art\.|sku|номер|number|raqam|знак|марк|brand|бренд|brend|model|модел|编号|编码|代码|货号|型号|品牌/i;
const NAME_PARTY =
  /customer|client|consignee|shipper|supplier|manufact|vendor|buyer|seller|клиент|покупател|получател|отправител|поставщ|производител|изготовител|продав|mijoz|xaridor|客户|收货|发货|供应|厂家|厂商|买方|卖方/i;
const namesSomethingElse = (header: string): boolean => {
  const head = header.split(/[(,;]/)[0] ?? '';
  return NAME_ATTRIBUTE.test(head) || NAME_PARTY.test(head);
};
/**
 * The TNVED / HS column (judge MR-19). Never a bare «hs» or «kod»: header
 * keys match as SUBSTRINGS, so «hs» is inside «Widths» and «kod» inside
 * «Tovar kodi» / «Mijoz kodi» — an article number then priced under a real
 * heading. And it is claimed only when most of its data cells READ as codes.
 */
const TNVED_KEYS = ['hs code', 'hs-code', 'тн вэд', 'тнвэд', 'tn ved', 'tnved', '海关编码', '商品编码'];
const QTY_KEYS = ['кол-во', 'кол.', 'количество', 'колич', 'soni', 'miqdor', 'dona', 'qty', 'quantity', 'pcs', '数量', '件数'];
const UNIT_KEYS = ['ед.', 'ед изм', 'единиц', 'birlik', 'unit', '单位'];
const WEIGHT_KEYS = ['вес', 'кг', "og'irlik", 'ogirlik', 'vazn', 'weight', 'kg', '重量', '毛重', '净重', 'g.w', 'n.w', 'gross'];
/**
 * A line's weight is NETTO (the row's own unit of account, `CalcField`), so a
 * packing list carrying both «N.W.» and «G.W.» is read by its net column
 * whichever stands first. Never «net» as a SUBSTRING: it is inside «Net
 * price», «Net amount» and «Cabinet No.», and the line's money became its
 * weight (the review).
 */
const NET_WEIGHT_KEYS = ['нетто', 'netto', 'n.w', 'net w', 'net.w', '净重'];
/**
 * …but «net» as a WORD is the net column when the header says it weighs
 * («Net, kg», «NET (KG)») or a gross column stands in the same header
 * («Gross | Net») — S6, the second review: dropping the word altogether made
 * «Gross, kg | Net, kg» read the gross, and per-kg duty took the cartons'
 * weight. A «Net» on an invoice with no weight beside it stays unread: there
 * it is as often the line's money.
 */
const NET_WORD = /(?:^|[^\p{L}])net(?:[^\p{L}]|$)/iu;
const WEIGHT_WORD = /kgs?\b|кг|weight|\bwt\b|вес/i;
const GROSS_HEADER = /gross|g\.\s*w|брутто|brutto|毛重/i;
/**
 * A weight header that is not the LINE's weight. Per package — «N.W./CTN»
 * stands before «TOTAL N.W.» on a Chinese packing list and is one carton's,
 * 20× short; «毛重/箱», «净重/件» the same in Chinese (S3) — or money («Цена
 * нетто», «Net price»). «total» / «итог» are not money words here: «TOTAL
 * N.W.» IS the line's weight; nor is «Суммарный вес». The slash is the
 * full-width «／» as often as «/» — what a Chinese input method types — and
 * «毛重(箱)» / «毛重（箱）» bracket the package instead (R3-S10).
 */
const PER_PACKAGE =
  /[/／]\s*(?:ctns?|cartons?|box(?:es)?|pcs?|pieces?|units?|шт|кор|мест|箱|件|个|只|包)|[(（]\s*(?:箱|件|个|只|包)\s*[)）]|\bper\b|\beach\b|на\s*1\b|每|单箱|单件|单重/i;
const MONEY_HEADER = /цен[аы]|сумм[аы](?!р)|стоимост|narx|summa|price|amount|cost|value|金额|单价|价格|总价/i;
const VOLUME_KEYS = ['объем', 'объём', 'куб', 'м3', 'м³', 'hajm', 'kub', 'volume', 'cbm', 'm3', 'm³', '体积', '立方'];
// Totals first: a file carrying both «цена» (per unit) and «сумма» (the line
// total) must land on the total — profit and customs both read line money.
const AMOUNT_TOTAL_KEYS = ['сумма', 'стоимость', 'итог', 'summa', 'umumiy', 'amount', 'total', '金额', '总价'];
const AMOUNT_PRICE_KEYS = ['цена', 'narx', 'price', '单价', '价格'];
/**
 * A money TOTAL that names no weight — «Gross total», «Net total» — is never
 * the line's weight (R3-S8, the third review): «gross» is a weight key and
 * «net» a net-weight word, so on «Gross total | Discount | Net total» the
 * invoice's money became the weight and the line lost its sum. A total that
 * DOES say it weighs stays a weight: «TOTAL N.W.», «Total G.W.», «Суммарный
 * вес», «Umumiy vazn».
 */
const WEIGHT_STATED = [...WEIGHT_KEYS.filter((key) => key !== 'gross'), ...NET_WEIGHT_KEYS, 'брутто', 'brutto'];
const moneyTotal = (text: string): boolean =>
  matchKey(text, AMOUNT_TOTAL_KEYS) && !matchKey(text, WEIGHT_STATED) && !WEIGHT_WORD.test(text);
/** A count of packages — «TOTAL CTNS», «Кол-во мест», «箱数» — is no money either. */
const PACKAGE_COUNT = /ctns?\b|cartons?|pkgs?\b|packages?|короб|мест|箱数|件数|包数/i;

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

/**
 * A number with the column's OWN unit glued on — «120KGS», «12.5 CBM», «300
 * PCS» — as Chinese packing lists write every cell (the diagnosis' cause 3:
 * those cells read as nothing). Only the unit the column stands for is taken
 * off: «5 CTNS» in a quantity column is cartons, not pieces, and stays
 * unread rather than become a wrong count.
 *
 * The number is read by the KERNEL's reader (`readNumberCell`), not
 * `parseNumber`: «1,200KGS» is 1,200 kg on an English packing list and
 * 1.2 kg on a Russian one, and `parseNumber` chose 1.2 — a line 1000× light
 * that the checklist then stopped asking about (the review). An ambiguous
 * figure stays unread, as these cells were before; the line is asked.
 */
function parseMeasure(cell: Cell, accept: 'dona' | 'kg' | 'm3'): number | null {
  const plain = parseNumber(cell);
  if (plain !== null || typeof cell !== 'string') return plain;
  const glued = /^(-?[\d\s.,]*\d)\s*([\p{L}][\p{L}\d²³.]*)$/u.exec(cell.trim());
  if (!glued || unitOf(glued[2]!.replace(/\.$/, '')) !== accept) return null;
  const read = readNumberCell(glued[1]!);
  return read.state === 'ok' ? read.value : null;
}

/** A cell that reads as a TNVED code — the kernel's own shape rule. */
const isCodeCell = (cell: Cell) => cellText(cell) !== '' && normalizeTnved(cell) !== null;

/**
 * An article number: a few CAPITAL letters then digits («YW-2301», «A-17»,
 * «SKU 0042», «ЦБ-00012345», «УТ-00000077»), or a few letters of any case
 * JOINED to the digits by a mark («gs-1201», «Art. 2301», «Арт. 2301»).
 * «Труба 32», «Кран 1/2», «Муфта 25» are names: a capital and then lower-case
 * letters, and a space where an article has a mark (the review). A 1C code
 * in Cyrillic capitals with its mark («ЦБ-00012345») is one too (S1, the
 * second review: it read as a word and a УПД's code column named every
 * product).
 *
 * But capitals are how 1C and many Uzbek documents print NAMES (R3-S5, the
 * third review): «ДСП 16», «МДФ 18», «ГКЛ 12», «ПВХ 110», «ТРУБА 32», «СТОЛ 2»
 * read as articles, the name column lost to «Описание», and the description
 * became the product. So the letters say how they join the digits:
 *  - Latin capitals GLUED («AB17», «YW2301») or with a mark («YW-2301»,
 *    «A-17») — an article, as round 1 read them;
 *  - Latin capitals and a bare SPACE only before a code-shaped number — a
 *    leading 0 or three digits at least («SKU 0042», «YW 2301»); «LED 50»,
 *    «LCD 32», «USB 3.0» are names. The residue: «PVC 110», «LED 100» read
 *    as articles, which only matters when a «Description» column stands
 *    beside them;
 *  - letters of any script or case only with a MARK («ЦБ-00012345»,
 *    «УТ-00000077», «АБ-1201», «gs-1201», «Art. 2301», «Арт. 2301»). A Cyrillic
 *    name with a space or glued to its size is a name.
 */
const ARTICLE_NUMBER = /^(?:[A-Z]{1,5}(?:[\-_./#№]+\s*|\s+(?=0|\d{3})|(?=\d))|\p{L}{1,5}[\-_./#№]+\s*)?\d[\d\s\-_./]*$/u;

/** Exported for the test: an article number as `ARTICLE_NUMBER` reads one. */
export const isArticleNumber = (text: string): boolean => ARTICLE_NUMBER.test(text.trim());

/** A cell that reads as a product's NAME: two letters at least, and not an article number. */
const isWordCell = (cell: Cell) => {
  const text = cellText(cell);
  if ((text.match(/\p{L}/gu) ?? []).length < 2) return false;
  return !ARTICLE_NUMBER.test(text);
};

/**
 * A typed line with its figures in it — «Стол офисный 5 шт 100 кг»: a number
 * followed by a unit word the kernel knows. «Труба 32» and «Кран 1/2» carry a
 * number and no unit; they are names.
 */
const carriesFigure = (cell: Cell): boolean => {
  if (typeof cell === 'number') return true;
  // The head a description keeps: a cell of thirty thousand digits (one
  // shared string, #8) would make this scan quadratic.
  for (const m of cellText(cell).slice(0, 300).matchAll(/\d(?:[.,]?\d)*\s*(\p{L}+[²³]?)/gu)) {
    if (unitOf(m[1]!) !== null) return true;
  }
  return false;
};

/**
 * A cell whose text is the header cell's own (`own` lower-cased). Lower-casing
 * never shortens a string, so a longer cell is answered before a thirty-
 * thousand-character one is lower-cased for nothing.
 */
const isHeaderText = (cell: Cell, own: string): boolean => {
  const text = cellText(cell);
  return text.length <= own.length && text.toLowerCase() === own;
};

/**
 * The non-empty data cells of one column, under a header row — never a cell
 * that repeats the header's own text (R3-S2, the third review): under a
 * two-row header the merged «Код ТН ВЭД» repeats into the sub-header row,
 * and on a one-line invoice that repeat was half the column, so the code was
 * «not mostly codes» and the supplier's TNVED was dropped. The same rule
 * `parseGoods` skips a repeated header by.
 */
function columnCells(rows: Cell[][], headerRow: number, col: number): Cell[] {
  const own = cellText(rows[headerRow]?.[col] ?? null).toLowerCase();
  return rows
    .slice(headerRow + 1, headerRow + 1 + SAMPLE_ROWS)
    .map((row) => row[col] ?? null)
    .filter((cell) => cellText(cell) !== '' && !isHeaderText(cell, own));
}

function findColumn(
  header: Cell[],
  keys: string[],
  taken: Set<number>,
  accept: (index: number) => boolean = () => true,
): number | null {
  return findWhere(header, taken, (text, i) => matchKey(text, keys) && accept(i));
}

/** The leftmost free header cell the test accepts. */
function findWhere(header: Cell[], taken: Set<number>, test: (text: string, index: number) => boolean): number | null {
  for (let i = 0; i < header.length; i++) {
    if (!taken.has(i) && test(cellText(header[i]!), i)) return i;
  }
  return null;
}

/** The unit a header names with its last word — «Кол-во, кг» is a weight. */
function headerUnitWord(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}\d²³]+/u).filter(Boolean);
  const last = words.at(-1) ?? null;
  return last && unitOf(last) !== null ? last : null;
}

interface Detected {
  headerRow: number;
  columns: ColumnMap;
}

/**
 * Find the header row (within the first ten — files open with logos and
 * legal names) and map its columns. Null when the file has no header we can
 * read: that is not a failure, it is single-column mode.
 */
export function detectColumns(rows: Cell[][]): Detected | null {
  return findHeader(rows).found;
}

/**
 * The header — or, when a one-column list carries its figures and so has no
 * header anywhere, the row the reader would have taken for one (`refused`),
 * which `parseGoods`' headerless pass starts after.
 */
function findHeader(rows: Cell[][]): { found: Detected | null; refused: number | null } {
  const filled = (row: Cell[] | undefined) => (row ?? []).filter((cell) => cellText(cell) !== '').length;
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
    // A title row is one merged cell («COMMERCIAL INVOICE / Товарная
    // накладная»): it names «товар» and is no header. A header has columns —
    // when the table under it HAS columns: a one-column list keeps its
    // one-cell header («Наименование товара» over Стол / Стул), or the header
    // became the first product (the review).
    if (filled(header) < 2) {
      const below = rows.slice(r + 1, r + 1 + SAMPLE_ROWS);
      if (below.some((row) => filled(row) > 1)) continue;
      // …and only a HEADER over a LIST (S7, the second review): «Товарная
      // накладная № 15 от 01.10.2026» over «Стол офисный 5 шт 100 кг» was
      // taken as the header, every line landed with no quantity and no
      // weight, and the sheet never reached the model that reads them.
      // Typed lines carry their figures, a list of names does not; and a
      // header with a number in it is a title, so over lines with numbers
      // it hands them to the model too. A list of NAMES keeps its header
      // whatever it is — «Труба 32», «Кран 1/2» are names, and the names
      // are read exactly.
      //
      // Refused, the list has no header ANYWHERE (R3-S4, the third review):
      // passing on to the next row made a later one-cell line with a name
      // key in it — «Товар забрать со склада», «Contact name: Ali» — the
      // header, and every line above it was lost. This branch runs only when
      // the fifty rows below are all one cell, so no table further down is
      // given up by stopping here.
      const listed = below.flat().filter((cell) => cellText(cell) !== '');
      const most = (test: (cell: Cell) => boolean) => listed.filter(test).length * 2 > listed.length;
      const hasDigit = (cell: Cell) => /\d/.test(cellText(cell));
      if (most(carriesFigure) || (header.some(hasDigit) && most(hasDigit))) {
        return { found: null, refused: wouldBeHeader(rows) };
      }
    }
    // The TNVED column is claimed BEFORE the name keys run: «Код ТН ВЭД
    // товара» contains «товар», and taken as the NAME it named every
    // product by its code and lost the code (the audit, reproduced).
    const tnved = findColumn(header, TNVED_KEYS, taken, mostlyCodes);
    if (tnved !== null) taken.add(tnved);
    // …and a name column is never one whose data are all codes («Goods
    // code», «Tovar kodi» to the left of the real name), and prefers a
    // column whose data READ as words over an article number («YW-2301»).
    const wordy = (i: number) => {
      const cells = columnCells(rows, r, i);
      return cells.length === 0 || cells.filter(isWordCell).length * 2 > cells.length;
    };
    // The first two tiers pass over a header that names a code, a brand or a
    // party (S5); the last resort still takes it when nothing else names the
    // goods at all. Between them, a header that MENTIONS a model or a brand
    // beside the name — «Description / Model», «品名/型号», «Goods name/brand»,
    // «Product Name & Model» — is still the name when its data read as words
    // (R3-S1, the third review): the skip sent those to the last resort,
    // which takes the leftmost name key whatever it holds, and «Item No.»
    // named every product again — the diagnosis' cause 1.
    const theGoods = (i: number) => !namesSomethingElse(cellText(header[i]!)) && !allCodes(i) && wordy(i);
    const words = (i: number) => !allCodes(i) && wordy(i);
    const name =
      findColumn(header, NAME_KEYS_FIRST, taken, theGoods) ??
      findColumn(header, NAME_KEYS, taken, theGoods) ??
      findColumn(header, NAME_KEYS_FIRST, taken, words) ??
      findColumn(header, NAME_KEYS, taken, words) ??
      findColumn(header, NAME_KEYS, taken, (i) => !allCodes(i));
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
    // The line's weight, never one package's and never a price.
    const lineWeight = (isWeight: (text: string) => boolean): number | null => {
      const idx = findWhere(
        header,
        taken,
        (text) => isWeight(text) && !PER_PACKAGE.test(text) && !MONEY_HEADER.test(text) && !moneyTotal(text),
      );
      if (idx !== null) taken.add(idx);
      return idx;
    };
    // A gross WEIGHT — «Gross amount | Discount | Net» is an invoice's money,
    // and so is «Gross total | Discount | Net total» (R3-S8).
    const grossBeside = header.some((cell) => {
      const text = cellText(cell);
      return GROSS_HEADER.test(text) && !MONEY_HEADER.test(text) && !moneyTotal(text);
    });
    const isNetWeight = (text: string) =>
      !moneyTotal(text) &&
      (matchKey(text, NET_WEIGHT_KEYS) || (NET_WORD.test(text) && (WEIGHT_WORD.test(text) || grossBeside)));
    const weight = weightFromQty ?? lineWeight(isNetWeight) ?? lineWeight((text) => matchKey(text, WEIGHT_KEYS));
    // The line's money is never a weight, a volume or a package count (S10,
    // the second review): «total» is a money key, and a packing list's
    // «TOTAL G.W.» — left free once «TOTAL N.W.» took the weight — or its
    // «TOTAL CTNS» became the line's sum. A money word keeps a column money
    // whatever else it says («Gross amount», «Цена за кг»).
    const money = (keys: string[]): number | null => {
      const idx = findColumn(header, keys, taken, (i) => {
        const text = cellText(header[i]!);
        if (MONEY_HEADER.test(text)) return true;
        return !(
          matchKey(text, WEIGHT_KEYS) ||
          isNetWeight(text) ||
          matchKey(text, VOLUME_KEYS) ||
          matchKey(text, QTY_KEYS) ||
          PER_PACKAGE.test(text) ||
          PACKAGE_COUNT.test(text)
        );
      });
      if (idx !== null) taken.add(idx);
      return idx;
    };
    const total = money(AMOUNT_TOTAL_KEYS);
    const amount = total ?? money(AMOUNT_PRICE_KEYS);
    const amountIsPrice = total === null && amount !== null;
    return {
      found: {
        headerRow: r,
        columns: { name, tnved, quantity, quantityUnit, unit, volume, weight, amount, amountIsPrice },
      },
      refused: null,
    };
  }
  return { found: null, refused: null };
}

/**
 * The row a refused one-column list would have been read under: the first
 * one-cell line of the sheet that names the goods («Наименование товара»,
 * «Список товаров», «Goods list») and comes BEFORE any one-cell line carrying
 * its figures — a line with its figures is a product, whatever word is in it,
 * and so is everything after it. Rows above that header were never products
 * under it either, so the headerless pass starts after it (R3-S4: the refused
 * header became the first good of the deal import, «Наименование» over
 * «Масло моторное 4 л»).
 */
function wouldBeHeader(rows: Cell[][]): number | null {
  for (let k = 0; k < Math.min(rows.length, 10); k += 1) {
    const cells = (rows[k] ?? []).filter((c) => cellText(c) !== '');
    if (cells.length !== 1) continue;
    if (carriesFigure(cells[0]!)) return null;
    if (matchKey(cellText(cells[0]!), NAME_KEYS)) return k;
  }
  return null;
}

export const MAX_GOODS_ROWS = 500;

/**
 * The whole file → goods rows. With a header, each mapped column; without
 * one, the first non-empty text cell of each row is the product and nothing
 * else is guessed at.
 *
 * `covered` is the reader's word for which positions a merge DOWN repeats
 * (R3-S3). There a quantity, a weight, a volume and a line TOTAL are the
 * merge's master's — one carton's weight or one sum over the lines packed
 * together — and read as empty, so they are counted once; the name, the
 * TNVED code, the unit and a unit PRICE are every covered line's own.
 */
export function parseGoods(
  rows: Cell[][],
  covered: Covered | null = null,
): { goods: GoodsRow[]; headerRow: number | null } {
  const header = findHeader(rows);
  const detected = header.found;
  const goods: GoodsRow[] = [];

  const push = (row: GoodsRow) => {
    const description = row.description.trim();
    if (!description) return;
    if (matchKey(description, TOTAL_ROW_KEYS)) return;
    goods.push({ ...row, description: description.slice(0, 300) });
  };

  if (detected) {
    const { headerRow, columns } = detected;
    const headerName = cellText(rows[headerRow]![columns.name] ?? null).toLowerCase();
    for (let r = headerRow + 1; r < rows.length && goods.length < MAX_GOODS_ROWS; r++) {
      const row = rows[r]!;
      const at = (idx: number | null): Cell => (idx === null ? null : (row[idx] ?? null));
      const once = (idx: number | null): Cell => (idx !== null && covered?.has(r, idx) ? null : at(idx));
      // A row whose name IS the header's is the header again (S8, the second
      // review): repeated at a page break, or the sub-header row under a
      // two-row header, whose merged name cell now reads as its text.
      if (isHeaderText(at(columns.name), headerName)) continue;
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
        // A piece column takes «300 PCS»; a column whose header names
        // another unit («Кол-во, м2») keeps the plain number, as before.
        quantity: columns.quantityUnit
          ? parseNumber(once(columns.quantity))
          : parseMeasure(once(columns.quantity), 'dona'),
        unit: (cellText(at(columns.unit)) || columns.quantityUnit || '').slice(0, 20) || null,
        weightKg: parseMeasure(once(columns.weight), 'kg'),
        volumeM3: parseMeasure(once(columns.volume), 'm3'),
        amount: parseNumber(columns.amountIsPrice ? at(columns.amount) : once(columns.amount)),
        tnvedCode: code && 'code' in code ? code.code : null,
        note: codeNote,
      });
    }
    return { goods, headerRow };
  }

  // A one-column list refused a header: the line it would have been read
  // under is no product either (R3-S4).
  const start = header.refused === null ? 0 : header.refused + 1;
  for (const row of rows.slice(start)) {
    if (goods.length >= MAX_GOODS_ROWS) break;
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
