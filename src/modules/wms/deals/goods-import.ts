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
  /**
   * A gross-weight column, located and never claimed (docs/IKKI-ESHIK.md
   * §1.2.1): the line weights come from the net column when there is one, and
   * the gross Σ is still the shipment's brutto.
   */
  gross: number | null;
  /** A carton column stands in the header — a packing list's sign, whether or not it took the quantity. */
  cartons: boolean;
  /** Where the line weights came from (`SheetShape.weightKind`). */
  weightKind: WeightKind;
}

/** Which column a sheet's line weights were read from — null = none. */
export type WeightKind = 'net' | 'gross' | 'plain' | null;

/**
 * What a MAPPED sheet is, by its columns and never its line names
 * (docs/IKKI-ESHIK.md §1.2.1, his 1a): `packing` = a carton or gross column
 * and NO money column — a packing list, whose rows restate an invoice's goods
 * and whose sums are the shipment's totals; anything else is an `invoice`.
 *  - `weightKind` — the column the line weights came from;
 *  - `grossKg` — Σ of the gross column over every row, null when any row
 *    lacks it (reported even when the line weights came from a net column);
 *  - `volumeM3` — Σ of the m³ column over every row, all or none
 *    (`linesVolumeM3`'s rule).
 * A position a merge DOWN covers is its master's, stated once: it lacks
 * nothing. A headerless sheet is no mapped sheet: `invoice`, nothing summed.
 */
export interface SheetShape {
  shape: 'invoice' | 'packing';
  weightKind: WeightKind;
  grossKg: number | null;
  /** A gross column stands in the header — so a null `grossKg` is a row lacking it, not «no column». */
  grossColumn: boolean;
  volumeM3: number | null;
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
/**
 * …but a header that MENTIONS a model or a brand beside the name is still the
 * name (R3-S1, then the fourth review): «Description / Model», «品名/型号»,
 * «Наименование и марка», «Product Name & Model», «Goods name/brand». The
 * head is split into its parts on «/», «&», «+» and a joining word, and the
 * header names the goods when one part carries a name key and no attribute
 * word. Chinese writes the parts with nothing between them («品名规格型号»),
 * so a head OPENING with 品名 or 名称 names the goods too. A party word
 * anywhere in the head still names a party («Наименование получателя»): the
 * round-3 tiers waived the whole check for such a header, and a brand or
 * customer column to the left of the real name named every product again.
 */
const NAME_PARTS = /[/／&＆+]|\s(?:и|and|va)\s|及|和/i;
const namesTheGoods = (header: string): boolean => {
  const head = header.split(/[(,;]/)[0] ?? '';
  if (NAME_PARTY.test(head)) return false;
  if (/^\s*(?:品名|名称)/.test(head)) return true;
  return head.split(NAME_PARTS).some((part) => matchKey(part, NAME_KEYS) && !NAME_ATTRIBUTE.test(part));
};
/**
 * A DESCRIPTION column is a name column of the second rank: beside a header
 * that names the product — «Product Name», «Наименование», «品名» — it holds
 * the material, the colour, the spec (round 1's «Description | Product Name»:
 * «white plastic» became the chair; the fourth review's «品名/型号 | 产品描述»:
 * «网布 黑色» became the office chair). Alone it is the name, as on every
 * Western invoice.
 *
 * So the first rung is a header that names the PRODUCT and nothing else: a
 * part of its head made only of naming words — a word for «name» or the
 * goods themselves, by stem, so every case form counts («Наименование
 * продукции», «Tovar nomlari», «Name of goods», «商品名称»). A goods word
 * QUALIFIED by anything else names something else about the goods (the fifth
 * review): «Страна происхождения товара», «Goods weight», «产品颜色», «Category
 * Name», «Наименование группы», «Factory name», «工厂名称», «Zavod nomi» each
 * named every product by its country, colour, group or factory, and outranked
 * the description beside it.
 *
 * The sixth review found that rung too strict three ways, each a name the
 * VED needs that fell below the description and left the spec beside it the
 * product: the cargo is the goods too («Наименование груза», «Cargo name» —
 * the forwarder's word); a word that says WHICH name the column holds — its
 * language, its length, the customs it is declared to — qualifies nothing
 * about the goods («Name in Russian», «Наименование товара на русском
 * языке», «中文品名», «报关品名», «Полное наименование»); and after the word
 * for NAME a preposition and all it governs say where that name is written
 * («Наименование по накладной», «Name as per invoice»). After a goods word
 * the same words say where the goods are («Товар в наличии») and qualify it.
 */
const NAMING_WORD =
  /^(?:наимен|назван|номенклатур|товар|продук|маҳсулот|махсулот|номи$|номлари$|tovar|mahsulot|nomi$|nomlari$|name|goods$|product|item|commodit|of$|груз(?:а|ы|ов)?$|cargo(?:e?s)?$|yuk(?:lar)?(?:ning)?$|юк(?:лар)?(?:нинг)?$)/;
const NAMING_HAN = ['品名', '名称', '商品', '货物', '产品', '货品'];
/** Which name — its language, its length, its customs — said beside a naming word and never naming one. */
const WHICH_NAME =
  /^(?:the|a|an|на|по|in|рус(?:ск\p{L}*)?|англ(?:ийск\p{L}*)?|китайск\p{L}*|узбекск\p{L}*|russian|english|chinese|uzbek|ru|en|zh|cn|uz|eng|rus|chn|язык\p{L}*|ruscha|inglizcha|xitoycha|o'zbekcha|tilida|tilidagi|русча|инглизча|хитойча|ўзбекча|тилида|тилидаги|полн\p{L}*|кратк\p{L}*|таможенн\p{L}*|официальн\p{L}*|full|short|customs|declared|official)$/u;
/** …and in Chinese, written before the name with nothing between: «中文品名», «报关品名». */
const WHICH_NAME_HAN = /^(?:中英文|中文|英文|俄文|俄语|英语|汉语|乌兹别克[文语]|报关|申报|海关)+/;
/** A preposition after the word for NAME: what follows says where that name is written. */
const NAME_IN = /^(?:на|по|в|во|для|in|on|for|per|by|as)$/;
/** The word for NAME itself — the only one such a preposition may follow. */
const NAME_WORD = /^(?:наимен|назван|name|nomi$|nomlari$|номи$|номлари$)/;
const namesTheProduct = (header: string): boolean => {
  const head = header.split(/[(（,;]/)[0] ?? '';
  if (/^\s*(?:品名|名称)/.test(head.trim().replace(WHICH_NAME_HAN, ''))) return true;
  return head.split(NAME_PARTS).some((part) => {
    const all = part.toLowerCase().replace(/[ʻ‘’`]/g, "'").match(/[\p{L}']+/gu) ?? [];
    const cut = all.findIndex((word, at) => NAME_IN.test(word) && all.slice(0, at).some((w) => NAME_WORD.test(w)));
    const words = cut < 0 ? all : all.slice(0, cut);
    const naming = (word: string) => NAMING_WORD.test(word) || hanRunOf(word.replace(WHICH_NAME_HAN, ''), NAMING_HAN);
    return words.some(naming) && words.every((word) => naming(word) || WHICH_NAME.test(word));
  });
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
  /[/／]\s*(?:ctns?|cartons?|box(?:es)?|pcs?|pieces?|units?|шт|кор|мест|箱|件|个|只|包)|[(（]\s*(?:箱|件|个|只|包)\s*[)）]|\bper\b|\beach\b|на\s*1\b|(?<![\p{L}\d])(?:1|одного)\s*(?:мест|короб|ящик|упаков)|每|单箱|单件|单重/iu;
/**
 * A COUNT header that is one package's (as-built review FILES-1): «每箱数量»,
 * «每箱件数», «Кол-во в коробке», «PCS/CTN», «Qty per carton» stand before the
 * line's «总数量» / «Кол-во, шт» / «TOTAL QTY» on a packing list, and taken as
 * the line's count they made 300 jackets 30 — so the packing list was no
 * longer «the same goods» and its rows were added as a second order. Never
 * the weight's `PER_PACKAGE` whole: «Qty/pcs» is the line's count in pieces.
 */
const PER_PACKAGE_COUNT =
  /[/／]\s*(?:ctns?|cartons?|box(?:es)?|pkgs?|packs?|bags?|кор\p{L}*|мест\p{L}*|ящ\p{L}*|箱|包)|\b(?:per|each|in(?:\s+a)?|every)\s+(?:ctns?|cartons?|box(?:es)?|pkgs?|packages?|packs?|bags?)\b|(?<![\p{L}])(?:в|на)\s*(?:1\s*|одн\p{L}*\s*)?(?:коробк|кор\.|упаковк|мест|ящик)|每|单箱/iu;
/**
 * A money header. A CURRENCY is one too (the third review's S6 note): «Gross
 * (USD) | Net (USD)» is an invoice's money before and after a discount, and
 * read as the gross and net weights its dollars became the line's kilos.
 */
const MONEY_HEADER = /цен[аы]|сумм[аы](?!р)|стоимост|narx|summa|price|amount|cost|value|金额|单价|价格|总价|\b(?:usd|rmb|cny|eur|uzs|rub)\b|so['ʻ‘’]?m\b|[$¥€₽]|руб|юан|元/i;
const VOLUME_KEYS = ['объем', 'объём', 'куб', 'м3', 'м³', 'hajm', 'kub', 'volume', 'cbm', 'm3', 'm³', '体积', '立方'];
/**
 * How Chinese packing lists abbreviate a figure's column — «TOTAL MEAS.»,
 * «Total Vol.» (the volume), «TOTAL WT» (the weight). None of them is a key,
 * so «total» made each the line's MONEY (the third review's S10 note); they
 * are read as what they measure when no keyed column does, and never as money.
 * A unit of its own beside the word — «MEAS (CM)», «Vol (L)», «Vol, ml» — is
 * a carton's centimetres or a bottle's litres, which read as m³ made a 60 cm
 * carton 60 m³ (the fifth review); such a column stays no volume and no
 * money. Unless that unit spells cubic metres OUT — «(CU.M)», «(CUBIC
 * METER)», «(cu m)» are no key, and refusing every bracket lost the stock
 * volume column of a Chinese packing list (the sixth review); the
 * abbreviations («MEAS.(CBM)», «Vol, m3») are keys and never reach here.
 */
const VOLUME_WORD = /\b(?:meas(?:urement)?s?|vol)\b/i;
const OWN_UNIT = /[(（,]/;
/** Cubic metres written out — «cu.m», «cu m», «cubic metre(s)», «CU.MTS» — never «cu.ft» or «cu.cm». */
const CUBIC_METRE = /\bcu(?:bic)?\.?\s*m(?:et(?:er|re)s?|trs?|ts?)?\b/i;
const WEIGHT_ABBREV = /\bwt\b/i;
// Totals first: a file carrying both «цена» (per unit) and «сумма» (the line
// total) must land on the total — profit and customs both read line money.
const AMOUNT_TOTAL_KEYS = ['сумма', 'стоимость', 'итог', 'summa', 'umumiy', 'amount', 'total', '金额', '总价'];
const AMOUNT_PRICE_KEYS = ['цена', 'narx', 'price', '单价', '价格'];
/**
 * A money TOTAL that names no weight — «Gross total», «Net total» — is never
 * the line's weight ON AN INVOICE THAT DISCOUNTS (R3-S8, the third review):
 * «gross» is a weight key and «net» a net-weight word, so on «Gross total |
 * Discount | Net total» the invoice's money became the weight and the line
 * lost its sum. Without a discount column such a header is a packing list's
 * (the fourth review): «TOTAL GROSS | TOTAL NET», «Gross total» over a
 * carton's kilos — read as money, the net weight became the line's sum and
 * the line lost its weight. A total that DOES say it weighs stays a weight
 * either way: «TOTAL N.W.», «Total G.W.», «Суммарный вес», «Umumiy vazn».
 *
 * A discount is one sign of an invoice; a TAX column is another, and so is a
 * unit price with no other money column to be the line's sum (the fifth
 * review): «Unit price | Net total | VAT 12% | Gross total», «Narxi | Net
 * total | QQS» — read as a packing list, the net money became the line's
 * kilos and the unit price its sum. A price BESIDE a money column («Unit
 * price | Amount | Total gross | Total net») leaves the totals the packing
 * list's weights.
 */
const WEIGHT_STATED = [...WEIGHT_KEYS.filter((key) => key !== 'gross'), ...NET_WEIGHT_KEYS, 'брутто', 'brutto'];
const namesMoneyTotal = (text: string): boolean =>
  matchKey(text, AMOUNT_TOTAL_KEYS) && !matchKey(text, WEIGHT_STATED) && !WEIGHT_WORD.test(text);
const DISCOUNT_HEADER = /discount|скидк|chegirma|折扣|优惠/i;
const TAX_HEADER = /\b(?:vat|tax(?:es)?)\b|ндс|налог|qqs|soliq|税/i;
/** Does this header row read as an INVOICE — the context in which a bare total is money? */
function invoiceHeader(texts: string[]): boolean {
  if (texts.some((text) => DISCOUNT_HEADER.test(text) || TAX_HEADER.test(text))) return true;
  const price = (text: string) => matchKey(text, AMOUNT_PRICE_KEYS);
  return texts.some(price) && !texts.some((text) => MONEY_HEADER.test(text) && !price(text));
}
/** A count of packages — «TOTAL CTNS», «Кол-во мест», «箱数» — is no money either. */
const PACKAGE_COUNT = /ctns?\b|cartons?|pkgs?\b|packages?|короб|мест|箱数|件数|包数/i;

/** Rows that are arithmetic, not goods. */
const TOTAL_ROW_KEYS = ['итого', 'всего', 'подытог', 'jami', 'total', '合计', '总计'];
/**
 * …and a Chinese SUBTOTAL row (review PF-ADV-3): «小计», «共计» under each
 * group landed as a goods row and doubled the sheet's brutto and cube. Only as
 * the cell's own word — never inside a name: «小计算器» is a pocket calculator.
 */
const SUBTOTAL_HAN = /^(?:小计|小計|共计|共計|合計|總計)(?!\p{Script=Han})/u;
const isTotalRow = (text: string): boolean => matchKey(text, TOTAL_ROW_KEYS) || SUBTOTAL_HAN.test(text.trim());

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
  const glued = GLUED_FIGURE.exec(cell.trim());
  if (!glued || unitOf(glued[2]!.replace(/\.$/, '')) !== accept) return null;
  const read = readNumberCell(glued[1]!);
  return read.state === 'ok' ? read.value : null;
}

const GLUED_FIGURE = /^(-?[\d\s.,]*\d)\s*([\p{L}][\p{L}\d²³.]*)$/u;

/**
 * A cell that states a FIGURE — one number and, around it, only what it is
 * counted in: units the kernel knows or a currency («120 KGS», «1,200», «5
 * CTNS», «$1,200.00», «1 200 000 сўм», «3600元», «120KG/CTN») — as opposed
 * to text that has a number in it («LED 50W», «12V», «42 размер»: a word
 * that counts nothing). A money or a per-carton weight read as text was
 * repeated on every line its merge covers, and a model summing the column
 * counted it three times (the fifth review). Decided by the cell's shape on
 * its first 64 characters, so a covered cell costs the same whatever its
 * master holds (R3-S7): what the model's text repeats under a merge and what
 * it leaves empty (`sheetsAsText`).
 */
export function readsAsFigure(cell: Cell): boolean {
  if (typeof cell === 'number') return true;
  const text = cellText(cell);
  if (text === '' || text.length > 64) return false;
  const shape = FIGURE_SHAPE.exec(text);
  if (!shape) return false;
  const words = `${shape[1] ?? ''} ${shape[2] ?? ''}`.split(/[\s/／]+/).filter(Boolean);
  return words.every((word) => CURRENCY_WORD.test(word) || unitOf(word.replace(/\.$/, '')) !== null);
}

/** A currency sign or word before the number, the number, and the words after it («KG/CTN»: per package). */
const FIGURE_SHAPE = /^([$¥€₽]|\p{L}+\.?)?\s*-?[\d\s.,]*\d\s*([\p{L}][\p{L}\d²³.\s/／]*)?$/u;
/** A currency as a cell writes it beside its sum — never a substring. */
const CURRENCY_WORD = /^(?:[$¥€₽元]|usd|rmb|cny|eur|uzs|rub|руб\.?|сўм|сум|so['ʻ‘’]?m|юан[ьяей]?|yuan)$/i;

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
 * The words a SUB-header row is written in under a two-row header — the
 * split under a parent the row above merges across two cells: «PER CTN |
 * TOTAL», «EACH | TOTAL», «N.W. | G.W.», «单箱 | 合计», «每箱 | 合计», «1 места |
 * всего», «нетто | брутто», and the units beside them. A closed list, so a
 * goods row, a section title («Ayollar kiyimi») or a second language's
 * header is never taken for one.
 */
const SUB_HEADER_WORDS = new Set([
  'per', 'each', 'ctn', 'ctns', 'carton', 'cartons', 'box', 'pkg', 'pkgs', 'total', 'totals', 'sum', 'all',
  'g', 'w', 'n', 'gw', 'nw', 'gross', 'net', 'weight', 'wt', 'kg', 'kgs', 'pcs', 'pc', 'qty', 'quantity',
  'cbm', 'm', 'unit', 'units', 'vol', 'volume', 'meas',
  'шт', 'кг', 'м', 'нетто', 'брутто', 'вес', 'всего', 'итого', 'места', 'место', 'мест', 'в', 'коробке',
  'упаковке', 'на', 'одного', 'ед', 'кол', 'во', 'объем', 'объём', 'jami', 'dona', 'har', 'biri', 'quti',
]);
/** …and the Chinese characters such a row is written in. */
const SUB_HEADER_HAN = /^[单每箱件个包合总计小毛净重数量体积]+$/u;
/**
 * The words that SPLIT a parent — one of them must stand in the row: a row
 * of bare units («pcs | kg») splits nothing, and «1 места» reads as a figure
 * («1 carton») to the figure test, so the vocabulary decides, not the shape.
 */
const SPLIT_WORDS = new Set(['per', 'each', 'total', 'totals', 'all', 'sum', 'gross', 'net', 'n', 'g', 'gw', 'nw', 'нетто', 'брутто', 'всего', 'итого', 'места', 'место', 'jami', 'har']);
const SPLIT_HAN = /[单每合总毛净]/u;

/** Is the row under the chosen header its SUB-header (`SUB_HEADER_WORDS`), never data? */
function subHeaderRow(row: Cell[] | undefined, r: number, covered: Covered | null): boolean {
  if (!row) return false;
  let splits = 0;
  for (let i = 0; i < row.length; i++) {
    // A label merged DOWN over both rows repeats here, as the reader repeats
    // every downward merge: the parent's own text, never the split's.
    if (covered?.has(r, i)) continue;
    const text = cellText(row[i] ?? null);
    if (text === '') continue;
    // A number is data; a word written with one («1 места») is judged by its words.
    if (typeof row[i] === 'number') return false;
    const tokens = text.toLowerCase().match(/\p{Script=Han}+|\p{L}+|\d+/gu) ?? [];
    if (tokens.length === 0) return false;
    for (const t of tokens) {
      const han = /^\p{Script=Han}+$/u.test(t);
      if (han ? !SUB_HEADER_HAN.test(t) : /^\d+$/.test(t) ? t !== '1' && t !== '3' : !SUB_HEADER_WORDS.has(t)) return false;
      if (han ? SPLIT_HAN.test(t) : SPLIT_WORDS.has(t)) splits += 1;
    }
  }
  return splits > 0;
}

/**
 * The header row as its columns read, a TWO-ROW header composed (as-built
 * review CRITIC-1): the commonest Chinese and Russian packing lists write the
 * figure's KIND in the top row merged across two cells and the split in the
 * row below — «G.W. (KG)» over «PER CTN | TOTAL», «毛重(KG)» over «单箱 |
 * 合计», «Вес брутто, кг» over «1 места | всего». The reader leaves a cell
 * covered to the RIGHT of its master empty, so the second column had no
 * header at all and the per-carton column was the only gross one: the
 * shipment's brutto the Σ of single cartons, 7.6× light, and ranked above the
 * model that read the TOTAL row. Each column under the split reads as parent
 * + child — the parent its own, or, under a covered cell, the master's to its
 * left across the split — so «PER CTN» meets `PER_PACKAGE` and «TOTAL» is the
 * line's, as on a one-row header. The sub-header row is no data either way
 * (no name, or the name merged down: `isHeaderText`).
 */
function composedHeader(rows: Cell[][], r: number, covered: Covered | null): Cell[] {
  const header = rows[r]!;
  const sub = rows[r + 1];
  if (!subHeaderRow(sub, r + 1, covered)) return header;
  const child = (i: number) => (covered?.has(r + 1, i) ? '' : cellText(sub![i] ?? null));
  const width = Math.max(header.length, sub!.length);
  const out: Cell[] = [];
  for (let i = 0; i < width; i++) {
    const own = cellText(header[i] ?? null);
    const below = child(i);
    let parent = own;
    if (parent === '' && below !== '') {
      // Across the split: every column back to the master has a child under
      // an empty parent, and the master has a child of its own.
      for (let j = i - 1; j >= 0; j--) {
        const up = cellText(header[j] ?? null);
        if (child(j) === '') break;
        if (up !== '') {
          parent = up;
          break;
        }
      }
    }
    out.push(parent && below ? `${parent} ${below}` : parent || below || (header[i] ?? null));
  }
  return out;
}

/**
 * Find the header row (within the first ten — files open with logos and
 * legal names) and map its columns. Null when the file has no header we can
 * read: that is not a failure, it is single-column mode.
 */
export function detectColumns(rows: Cell[][], covered: Covered | null = null): Detected | null {
  return findHeader(rows, covered).found;
}

/**
 * The header — or, when a one-column list carries its figures and so has no
 * header anywhere, the last of its opening lines that is no product
 * (`refused`, `listOpening`), which `parseGoods`' headerless pass starts
 * after.
 */
function findHeader(rows: Cell[][], covered: Covered | null = null): { found: Detected | null; refused: number | null } {
  const filled = (row: Cell[] | undefined) => (row ?? []).filter((cell) => cellText(cell) !== '').length;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    // A two-row header is read as one (CRITIC-1); a one-row header is itself.
    const header = composedHeader(rows, r, covered);
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
      if (most(carriesFigure)) return { found: null, refused: listOpening(rows) };
      // A numbered TITLE («Заявка от 15.10.2026», «Заказ № 15») over a list
      // of names is passed over, not a refusal: the real one-cell header may
      // stand on the next row (S-r2 ND1 — stopping here made «Наименование»
      // over Труба ППР 32 / Кран 1/2 / Муфта 25 a text sheet, and the VED
      // paste landed the title and the header as items).
      if (header.some(hasDigit) && most(hasDigit)) continue;
    }
    // The TNVED column is claimed BEFORE the name keys run: «Код ТН ВЭД
    // товара» contains «товар», and taken as the NAME it named every
    // product by its code and lost the code (the audit, reproduced).
    const tnved = findColumn(header, TNVED_KEYS, taken, mostlyCodes);
    if (tnved !== null) taken.add(tnved);
    // …and a name column is never one whose data are all codes («Goods
    // code», «Tovar kodi» to the left of the real name), and prefers a
    // column whose data READ as words over an article number («YW-2301»).
    // A column with no data at all is no evidence of a name: a Chinese PI's
    // «产品图片» holds pictures, which are not cell values, and taken as the
    // name it left every line nameless (the fourth review) — so it is
    // chosen only when no name column has data (the last resort).
    const sampled = (i: number) => columnCells(rows, r, i);
    const wordy = (i: number) => {
      const cells = sampled(i);
      return cells.length > 0 && cells.filter(isWordCell).length * 2 > cells.length;
    };
    const stated = (i: number) => sampled(i).length > 0 && !allCodes(i);
    // One ladder, the header's rank before the data's: a header that names
    // the PRODUCT alone (`namesTheProduct`, which outranks a description)
    // over words, then one that names the GOODS (never a code, a brand or a
    // party — S5 — unless it only mentions one beside the name,
    // `namesTheGoods`) over words, then over any data, then any name key at
    // all. The fourth review found the round-3
    // tiers' «any header over words» rung naming RTX-4090 / GTX-1660 by the
    // «Brand name» column beside them: a model number is not a word, but it
    // is the product.
    const goods = (i: number) => namesTheGoods(cellText(header[i]!));
    const name =
      findColumn(header, NAME_KEYS_FIRST, taken, (i) => namesTheProduct(cellText(header[i]!)) && wordy(i)) ??
      findColumn(header, NAME_KEYS_FIRST, taken, (i) => goods(i) && wordy(i)) ??
      findColumn(header, NAME_KEYS, taken, (i) => goods(i) && wordy(i)) ??
      findColumn(header, NAME_KEYS_FIRST, taken, (i) => goods(i) && stated(i)) ??
      findColumn(header, NAME_KEYS, taken, (i) => goods(i) && stated(i)) ??
      findColumn(header, NAME_KEYS, taken, (i) => !allCodes(i));
    if (name === null) continue;
    taken.add(name);
    const claim = (keys: string[], accept?: (index: number) => boolean): number | null => {
      const idx = findColumn(header, keys, taken, accept);
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
      // One package's count is nobody's count (FILES-1): passed over, so the
      // line's own total count column is the line's.
      if (PER_PACKAGE_COUNT.test(cellText(header[i]!))) continue;
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
    // A unit PRICE is no unit (docs/IKKI-ESHIK.md review PF-SPEC-1): «Unit
    // price», «Цена за ед.», «单价» carry a unit key, and claimed as the unit
    // the price became every line's unit word («50») while the count beside
    // it went to the note at the door as a count of nobody knows what.
    const unit = claim(UNIT_KEYS, (i) => !MONEY_HEADER.test(cellText(header[i]!)));
    // Volume before weight: «вес, кг» must not be eaten by a stray m3 match,
    // and the volume keys are the more specific set.
    const claimWhere = (test: (text: string) => boolean): number | null => {
      const idx = findWhere(header, taken, test);
      if (idx !== null) taken.add(idx);
      return idx;
    };
    // ONE carton's volume is not the line's (his 2.7 b, probe P1: a
    // «CBM/CTN» standing before «TOTAL CBM» on a Chinese packing list was
    // read as the line and landed 14× short — the weight's PER_PACKAGE rule,
    // which the volume never learned). The same test on the abbreviation
    // rung: «MEAS./CTN» is one carton's too.
    const volume =
      volumeFromQty ??
      claimWhere((text) => matchKey(text, VOLUME_KEYS) && !PER_PACKAGE.test(text)) ??
      claimWhere(
        (text) =>
          VOLUME_WORD.test(text) && !PER_PACKAGE.test(text) && (!OWN_UNIT.test(text) || CUBIC_METRE.test(text)),
      );
    const invoiced = invoiceHeader(header.map(cellText));
    const moneyTotal = (text: string) => invoiced && namesMoneyTotal(text);
    // What a weight column's figures add up to, over the data rows (a merged
    // position is its master's, counted once).
    const columnKg = (i: number): number => {
      let sum = 0;
      for (let d = r + 1; d < rows.length; d++) {
        if (covered?.has(d, i)) continue;
        const value = parseMeasure(rows[d]![i] ?? null, 'kg');
        if (value !== null && value > 0) sum += value;
      }
      return sum;
    };
    // Two columns of one kind are one carton's figure and the line's (review
    // PF-ADV-1): a Chinese packing list writes «N.W.(KG) | G.W.(KG)» under a
    // «PER CTN» super-header beside the «TOTAL» pair, or an unmarked
    // «G.W.(KG)» before «TOTAL G.W.», and the leftmost was one carton's — the
    // line 10× light and the shipment's brutto the Σ of single cartons. One
    // carton's figure is never more than its line's, so the line's column is
    // the heaviest; one column, or a tie, keeps the leftmost.
    const heaviest = (candidates: number[]): number | null => {
      if (candidates.length <= 1) return candidates[0] ?? null;
      let best = candidates[0]!;
      let bestKg = columnKg(best);
      for (const i of candidates.slice(1)) {
        const kg = columnKg(i);
        if (kg > bestKg) {
          best = i;
          bestKg = kg;
        }
      }
      return best;
    };
    // The line's weight, never one package's and never a price — and never a
    // GROSS column while another weight column stands (a line's weight is
    // netto): the heaviest is chosen among one kind only.
    const lineWeight = (isWeight: (text: string) => boolean): number | null => {
      const candidates = header.flatMap((cell, i) => {
        const text = cellText(cell);
        return !taken.has(i) && isWeight(text) && !PER_PACKAGE.test(text) && !MONEY_HEADER.test(text) && !moneyTotal(text)
          ? [i]
          : [];
      });
      const plain = candidates.filter((i) => !GROSS_HEADER.test(cellText(header[i]!)));
      const idx = heaviest(plain.length > 0 ? plain : candidates);
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
    const netWeight = weightFromQty === null ? lineWeight(isNetWeight) : null;
    const weight =
      weightFromQty ?? netWeight ?? lineWeight((text) => matchKey(text, WEIGHT_KEYS) || WEIGHT_ABBREV.test(text));
    const isGrossWeight = (text: string) =>
      GROSS_HEADER.test(text) && !PER_PACKAGE.test(text) && !MONEY_HEADER.test(text) && !moneyTotal(text);
    const weightKind: WeightKind =
      weight === null
        ? null
        : netWeight !== null
          ? 'net'
          : weightFromQty === null && isGrossWeight(cellText(header[weight]!))
            ? 'gross'
            : 'plain';
    // The gross column is LOCATED, never claimed: beside a net column it is
    // still the brutto the shipment's Σ is read from — the line weight's own
    // column when that is a gross one, else the heaviest gross column (one
    // carton's G.W. stands beside the line's, PF-ADV-1).
    const grossCandidates = header.flatMap((cell, i) => ((i === weight || !taken.has(i)) && isGrossWeight(cellText(cell)) ? [i] : []));
    const gross = weight !== null && grossCandidates.includes(weight) ? weight : heaviest(grossCandidates);
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
          WEIGHT_ABBREV.test(text) ||
          isNetWeight(text) ||
          matchKey(text, VOLUME_KEYS) ||
          VOLUME_WORD.test(text) ||
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
        columns: {
          name,
          tnved,
          quantity,
          quantityUnit,
          unit,
          volume,
          weight,
          amount,
          amountIsPrice,
          gross,
          // A carton column is any header that counts packages — «Кол-во
          // мест», and a bare «Cartons», «CTNS», «Мест», «Packages» the
          // quantity keys never claimed (review PF-ADV-4: an invoice's own
          // packing list with such a header and a plain weight read as a
          // second invoice, and every row landed twice).
          cartons:
            cartonCol !== null ||
            header.some((cell, i) => {
              const text = cellText(cell);
              return i !== name && PACKAGE_COUNT.test(text) && !MONEY_HEADER.test(text);
            }),
          weightKind,
        },
      },
      refused: null,
    };
  }
  return { found: null, refused: null };
}

/**
 * The last of a refused one-column list's opening lines that is no product
 * (R3-S4: the refused header became the first good of the deal import,
 * «Наименование» over «Масло моторное 4 л», and a title its first line).
 * The list's HEAD is read from the top, among the lines above the first that
 * carries its figures: a run of TITLES (`TITLE_LINE`) and HEADINGS
 * (`listHeadingLine`), each with at most one other line before it — the
 * sender's, which the head takes with it («Yiwu Trading» over «Наименование»;
 * «ООО «Ромашка»», «Заявка на расчёт», «Товары:» — the fifth review: the
 * round-4 rule looked at two lines only, and a heading under a title became
 * the first product). A heading further down, under products, is a product
 * itself («Куртка женская», «Брюки мужские», «Товары»).
 * Never a line because a name key is somewhere INSIDE it (the fourth review):
 * «Name badge holder», «Enamel mug white», «Полка для товаров», «Sports
 * goods», «电子产品配件» are products — a heading opens with what it lists.
 * Null: the list opens with a product.
 */
function listOpening(rows: Cell[][]): number | null {
  let head: number | null = null;
  let since = 0;
  for (let k = 0; k < Math.min(rows.length, 10); k += 1) {
    const cells = (rows[k] ?? []).filter((c) => cellText(c) !== '');
    if (cells.length === 0) continue;
    if (cells.length !== 1 || carriesFigure(cells[0]!)) break;
    const text = cellText(cells[0]!);
    if (since <= 1 && (listHeadingLine(text) || TITLE_LINE.test(text))) {
      head = k;
      since = 0;
    } else {
      since += 1;
    }
  }
  return head;
}

/**
 * A document's own name or its date — what a title line carries and a
 * product's name does not. Never a bare «№ 12» / «No. 12» or three numbers
 * between slashes: that is how a product writes its size («Кисть малярная
 * №12», «Тройник 20/16/20» — the fifth review), so a date needs a month that
 * is one, or a whole year. «Накладн…» is also the adjective of a product
 * («Светильник накладной», «Накладные ресницы», «Розетка двойная накладная»
 * — the sixth review), so it is the waybill only in the waybill's own phrase:
 * after the adjective that says which waybill («Товарная», «Расходная»,
 * «Товарно-транспортная»; «Складская» and «Электронная» only opening the
 * line and before the noun itself, since «Замок электронный накладной» and
 * «Электронный накладной замок» are products), or opening the line
 * with nothing after it but its number however written, a code, its date or
 * what it is for («Накладная № 15», «Накладная N 15», «Накладная GS 777»,
 * «Накладная от 01.10», «Накладная на отпуск», «Накладная для клиента») — and
 * the spoken «Накладной № 15» / «Накладной GS777» before a number or a code
 * only, since «Накладной замок» is a product (the round-6 probes: the first
 * narrowing read the commonest of these as a product).
 */
const TITLE_LINE =
  /(?<!\p{L})(?:товарн|транспортн|расходн|приходн|сопроводительн|отгрузочн|возвратн)\p{L}*[\s-]+накладн|^(?:складск|электронн|внутренн)\p{L}*[\s-]+накладн(?:ая|ые)(?!\p{L})|^накладная(?=\s*(?:$|№|\(|\d|[-–—:]|(?:n[or]?\.?|nº|номер|#)\s*\d|\p{L}{1,4}[\s-]?\d|(?:от|на|для|за)(?!\p{L})))|^накладные(?=\s*(?:$|№|\d|[-–—:]|(?:n[or]?\.?|nº|номер|#)\s*\d|\p{L}{1,4}[\s-]?\d|от(?!\p{L})))|^накладной(?=\s*(?:№|\(|\d|[-–—:]|(?:n[or]?\.?|nº|номер|#)\s*\d|\p{L}{1,4}[\s-]?\d))|(?<!\p{L})(?:invoice|proforma|packing\s*list|заявк|заказ|сч[её]т(?!\p{L})|спецификац|ariza|buyurtma|faktura|发票|订单|装箱单)|(?<!\d)(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:\d{4}|\d{2})(?!\d)|(?<!\d)\d{1,2}[/-]\d{1,2}[/-]\d{4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/iu;

/**
 * The words a goods list is headed with, as whole words — never a substring.
 * The Uzbek ones in both scripts: «Товарлар рўйхати», «Товар номи» were
 * products for want of their Cyrillic spelling (the fifth review).
 */
const LIST_WORDS = new Set([
  'наименование', 'наименования', 'название', 'товар', 'товара', 'товары', 'товаров', 'список', 'перечень',
  'продукция', 'описание', 'номенклатура',
  'tovar', 'tovarlar', 'tovarlarning', 'nomi', 'nomlari', 'mahsulot', 'mahsulotlar', "ro'yxati", "ro'yxat",
  'товарлар', 'товарларнинг', 'номи', 'номлари', 'маҳсулот', 'маҳсулотлар', 'махсулот', 'махсулотлар', 'рўйхати', 'рўйхат',
  'name', 'names', 'goods', 'list', 'item', 'items', 'product', 'products', 'description', 'of',
]);
/** …and in Chinese, which writes them with nothing between: «商品名称», «货物清单». */
const LIST_WORDS_HAN = ['品名', '名称', '货物', '商品', '产品', '清单', '列表', '货品', '明细'];

/** A line's words, lower-cased, the Uzbek apostrophe in one spelling. */
const lineWords = (text: string): string[] => text.toLowerCase().replace(/[ʻ‘’`]/g, "'").match(/[\p{L}']+/gu) ?? [];

/** A cell made of nothing but list words — «Наименование товара», «Tovar nomi», «Goods list», «商品名称». */
function listHeading(text: string): boolean {
  const words = lineWords(text);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((word) => LIST_WORDS.has(word) || hanListWords(word));
}

/**
 * A line a goods list is headed with: nothing but list words
 * (`listHeading`), or OPENING with two of them and going on to say what the
 * list is for or gives («Список товаров для расчёта», «Tovar nomi, soni,
 * og'irligi», «Product names and quantities», «货物明细表», «商品名称及规格»), or
 * announcing the lines under it with a colon («Goods to be shipped:»,
 * «产品清单如下：»). One list word opens a product's name as often as a heading
 * («Goods trolley», «Name badge holder»).
 */
function listHeadingLine(text: string): boolean {
  if (listHeading(text) || /[:：]\s*$/.test(text)) return true;
  const words = lineWords(text);
  const first = words[0];
  if (first === undefined) return false;
  if (/^\p{Script=Han}/u.test(first)) return hanListPrefix(first) >= 2;
  return words.length >= 2 && LIST_WORDS.has(first) && LIST_WORDS.has(words[1]!);
}

/** How many list words a run of Chinese characters opens with, read left to right. */
function hanListPrefix(word: string): number {
  let count = 0;
  for (let at = 0; at < word.length; count += 1) {
    const next = LIST_WORDS_HAN.find((w) => word.startsWith(w, at));
    if (!next) break;
    at += next.length;
  }
  return count;
}

/** A run of Chinese characters that is list words end to end, read left to right. */
const hanListWords = (word: string): boolean => hanRunOf(word, LIST_WORDS_HAN);

/** A run of Chinese characters made of these words end to end, read left to right. */
function hanRunOf(word: string, vocabulary: readonly string[]): boolean {
  if (!/^\p{Script=Han}+$/u.test(word)) return false;
  for (let at = 0; at < word.length; ) {
    const next = vocabulary.find((w) => word.startsWith(w, at));
    if (!next) return false;
    at += next.length;
  }
  return true;
}

export const MAX_GOODS_ROWS = 500;

/** The first data row under a header row. */
const r0 = (headerRow: number) => headerRow + 1;

/** A GRAND total row's own word — never a subtotal («подытог», «subtotal», «小计»). */
const GRAND_TOTAL = /^(?:grand\s+)?(?:total|totals|итого|всего|jami|合计|总计)(?![\p{L}])/iu;
const SUBTOTAL_WORD = /sub\s*-?\s*total|подытог|小计|小計/iu;

/**
 * The sheet's LAST grand total row under the header — the line a packing
 * list closes with («TOTAL … 190 … 1.6») — or null. Any cell may carry the
 * word: the «No.» column as often as the name's.
 */
function grandTotal(rows: Cell[][], from: number, covered: Covered | null): Cell[] | null {
  for (let d = rows.length - 1; d >= from; d--) {
    const row = rows[d]!;
    const says = row.some((cell, i) => {
      if (covered?.has(d, i) || typeof cell !== 'string') return false;
      const text = cell.trim();
      return text.length <= 24 && GRAND_TOTAL.test(text) && !SUBTOTAL_WORD.test(text);
    });
    if (says) return row;
  }
  return null;
}

/** The total row's figure in a column, against the Σ: apart by more than rounding (under `unit`, or 0.5 %). */
function contradicts(sum: number, cell: Cell | undefined, unit: 'kg' | 'm3', step: number): boolean {
  const stated = parseMeasure(cell ?? null, unit);
  if (stated === null || stated <= 0) return false;
  const gap = Math.abs(sum - stated);
  return !(gap < step || gap <= 0.005 * Math.max(sum, stated));
}

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
): { goods: GoodsRow[]; headerRow: number | null } & SheetShape {
  const header = findHeader(rows, covered);
  const detected = header.found;
  const goods: GoodsRow[] = [];

  const push = (row: GoodsRow): boolean => {
    const description = row.description.trim();
    if (!description) return false;
    if (isTotalRow(description)) return false;
    goods.push({ ...row, description: description.slice(0, 300) });
    return true;
  };

  if (detected) {
    const { headerRow, columns } = detected;
    // The sheet's two sums over the rows it LANDS (a total row is arithmetic,
    // never a line): null as soon as one landed row lacks its figure — a Σ
    // one line short is a smaller number wearing the shipment's name.
    let grossKg: number | null = columns.gross === null ? null : 0;
    let volumeM3: number | null = columns.volume === null ? null : 0;
    const headerName = cellText(rows[headerRow]![columns.name] ?? null).toLowerCase();
    let r = headerRow + 1;
    for (; r < rows.length && goods.length < MAX_GOODS_ROWS; r++) {
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
      const qtyCell = once(columns.quantity);
      const weightCell = once(columns.weight);
      const volumeCell = once(columns.volume);
      const amountCell = columns.amountIsPrice ? at(columns.amount) : once(columns.amount);
      const figures: [what: string, cell: Cell, value: number | null][] = [
        // A piece column takes «300 PCS»; a column whose header names
        // another unit («Кол-во, м2») keeps the plain number, as before.
        ['soni', qtyCell, columns.quantityUnit ? parseNumber(qtyCell) : parseMeasure(qtyCell, 'dona')],
        ['vazn', weightCell, parseMeasure(weightCell, 'kg')],
        ['hajm', volumeCell, parseMeasure(volumeCell, 'm3')],
        ['summa', amountCell, parseNumber(amountCell)],
      ];
      const [quantity, weightKg, rowVolume, amount] = figures.map(([, , value]) => value);
      // A figure cell the reader could not use is SAID, never dropped in
      // silence (round 1): «12,500PCS» and «1,200KGS» read two ways and land
      // empty — the paste door's own promise — and the line's note is where
      // the VED sees what the file stated.
      const unread = figures
        .filter(([, cell, value]) => value === null && /\d/.test(cellText(cell)))
        .map(([what, cell]) => `${what} «${cellText(cell).slice(0, 40)}» — aniq emas`);
      const landed = push({
        description: cellText(at(columns.name)),
        quantity: quantity ?? null,
        unit: (cellText(at(columns.unit)) || columns.quantityUnit || '').slice(0, 20) || null,
        weightKg: weightKg ?? null,
        volumeM3: rowVolume ?? null,
        amount: amount ?? null,
        tnvedCode: code && 'code' in code ? code.code : null,
        note: [codeNote, ...unread].filter(Boolean).join(' · ') || null,
      });
      if (landed) {
        // A covered position is its master's figure, stated once: it lacks nothing.
        const sum = (total: number | null, col: number | null, value: number | null): number | null =>
          total === null || col === null ? null : covered?.has(r, col) ? total : value !== null && value > 0 ? total + value : null;
        grossKg = sum(grossKg, columns.gross, columns.gross === columns.weight ? (weightKg ?? null) : parseMeasure(once(columns.gross), 'kg'));
        volumeM3 = sum(volumeM3, columns.volume, rowVolume ?? null);
      }
    }
    // A list the reader STOPPED at its ceiling sums nothing (review PF-ADV-2):
    // the Σ of its first 500 lines is a smaller number wearing the shipment's
    // name, and it outranks the model that may read the TOTAL row.
    const stoppedShort =
      goods.length >= MAX_GOODS_ROWS &&
      rows.slice(r).some((row) => {
        const name = cellText(row[columns.name] ?? null);
        return name !== '' && !isTotalRow(name);
      });
    if (stoppedShort) {
      grossKg = null;
      volumeM3 = null;
    }
    // …and a Σ the sheet's OWN grand total contradicts is no total (as-built
    // review CRITIC-1, the belt): whatever header shape the reader misread,
    // the file's «TOTAL» row says what the column adds up to, and a Σ of
    // single cartons beside it is a smaller number wearing the shipment's
    // name. Refused, never corrected: the VED reads the file, the model reads
    // the row.
    const stated = grandTotal(rows, r0(headerRow), covered);
    if (stated) {
      if (grossKg !== null && columns.gross !== null && contradicts(grossKg, stated[columns.gross], 'kg', 1)) grossKg = null;
      if (volumeM3 !== null && columns.volume !== null && contradicts(volumeM3, stated[columns.volume], 'm3', 0.01)) volumeM3 = null;
    }
    // …and a brutto lighter than the lines' own netto is no brutto: a column
    // read wrong, never a figure to land.
    if (grossKg !== null && columns.weightKind === 'net' && columns.gross !== columns.weight) {
      const net = goods.every((g) => g.weightKg !== null) ? goods.reduce((n, g) => n + (g.weightKg ?? 0), 0) : null;
      if (net !== null && grossKg + 0.5 < net) grossKg = null;
    }
    // A money column is a money HEADER, claimed or not (PF-SPEC-1, §1.2.1's
    // «NO money column»): «Value (USD)», a unit price the amount did not take.
    const money = columns.amount !== null || rows[headerRow]!.some((cell) => MONEY_HEADER.test(cellText(cell)));
    const round = (n: number | null, places: number) => (n === null || goods.length === 0 ? null : Number(n.toFixed(places)));
    return {
      goods,
      headerRow,
      shape: (columns.cartons || columns.gross !== null) && !money ? 'packing' : 'invoice',
      weightKind: columns.weightKind,
      grossKg: round(grossKg, 3),
      grossColumn: columns.gross !== null,
      volumeM3: round(volumeM3, 3),
    };
  }

  // A one-column list refused a header: its heading and its title are no
  // products either (R3-S4).
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
  return { goods, headerRow: null, shape: 'invoice', weightKind: null, grossKg: null, grossColumn: false, volumeM3: null };
}
