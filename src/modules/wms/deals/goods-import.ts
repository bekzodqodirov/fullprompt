import { clipUnits } from '../../platform/text/clip';
import { readNumberCell } from '../calc/number-cell';
import { FIELD_LABELS as SPEC_LABELS, normalizeTnved, unitOf } from '../calc/units';
import {
  applyPacking,
  emptyPacking,
  packingStated,
  parseSize,
  wholeCartons,
  type CartonSize,
  type Packing,
  type PerCartonUnit,
  type SizeOwner,
} from '../calc/carton-math';

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
  /**
   * What the sheet states PER PACKAGE — its carton count, a carton's size,
   * cube, weight, pieces (docs/AI-SORAYDI.md §2.3, §3.2 X2-X3). The reader
   * COPIES; the calc door multiplies (`invoiceFacts` → `applyPacking`). A deal
   * line's import ignores it. Absent = the sheet stated none.
   *
   * A sheet whose ONLY count column counts cartons still writes that number
   * as `quantity` under its carton word («15 ctn»), as it did before the
   * packing: the deal's import and the VED's paste keep no packing, and read
   * the count there. The calc door reads it HERE and says it once.
   */
  packing?: Packing | null;
  /**
   * Which weight the row's own `weightKg` is, by its column — said only on a
   * row whose packing states a per-carton weight, where the carton arithmetic
   * needs it: a GROSS line weight a little over its cartons' NETTO is a row,
   * not a question (review JN-4). Absent = not said.
   */
  weightKind?: 'gross' | 'net';
}

/**
 * The columns a header states PER PACKAGE (§3.2 X2-X3) — each read into the
 * row's `packing`, none of them a line figure.
 */
interface PackColumns {
  /** The carton COUNT: a package column, whichever way it was found. */
  cartons: number | null;
  /**
   * What one carton holds, and in which unit (review JR-1): «PCS/CTN»,
   * «пар/кор», «m²/ctn». `unit: null` — the header names none («Qty per
   * carton», «装箱数»): the row's own count unit, else pieces.
   */
  pieces: { index: number; unit: PerCartonUnit | null } | null;
  /** One carton's weight — the NET column when the sheet has both. */
  weight: { index: number; kind: 'gross' | 'net' | null } | null;
  /** One carton's cube, and what its figures are divided by to be m³ (X6). */
  volume: { index: number; divisor: number } | null;
  /**
   * A size: one cell («60*40*50») or an L | W | H triplet, the unit its
   * header names and WHOSE size the header says it is (review JN-11) — null:
   * the header said «size» and nothing more, so nothing is multiplied by it.
   */
  size: { cols: [number] | [number, number, number]; unit: CartonSize['unit']; of: SizeOwner | null } | null;
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
  /**
   * What the volume column's figures are divided by to be cubic metres — 1,
   * or 1 000 000 / 1000 under a header that names cm³ / dm³ or litres (X6).
   */
  volumeDivisor: number;
  amount: number | null;
  /**
   * The money column is a UNIT price (no line total in the file). A price
   * merged over two lines is the price of both — it repeats; a line total
   * merged over them is stated once (R3-S3).
   */
  amountIsPrice: boolean;
  /**
   * The count headers the ranking passed over that count in ANOTHER unit —
   * «Кол-во, м2», «Кол-во, пар» beside the chosen «Кол-во, шт» (§5.10): the
   * row's figure there is said on its note for the VED, never dropped. And,
   * said the same way (X6, review JN-13): a volume column in a unit nobody
   * converts («Volume (ft3)»), the figure of a CONVERTED one as the file
   * wrote it («Volume (cm3)»: 120000), and a volumetric weight.
   */
  alsoCounts: { index: number; header: string }[];
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
  /** What the header states per package (X2-X3) — the row's `packing`. */
  pack: PackColumns;
}

/** Which column a sheet's line weights were read from — null = none. */
export type WeightKind = 'net' | 'gross' | 'plain' | null;

/**
 * What a MAPPED sheet is, by its columns and never its line names
 * (docs/IKKI-ESHIK.md §1.2.1, his 1a): `packing` = a carton or gross column
 * and NO money column — a packing list, whose rows restate an invoice's goods
 * and whose sums are the shipment's totals; anything else is an `invoice`.
 *  - `weightKind` — the column the line weights came from;
 *  - `grossKg` — Σ of the gross column over every row it keeps as a good,
 *    null when any of them lacks it (reported even when the line weights
 *    came from a net column) — a total row, a subtotal and a footer under the
 *    list are no rows of it (`dropped`, FAYL-OQISH §5.4-§5.5);
 *  - `volumeM3` — Σ of the m³ column over the same rows, all or none
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
const NAME_KEYS = ['наимен', 'товар', 'описан', 'назван', 'nomi', 'mahsulot', 'tovar', 'name', 'descri', 'goods', 'item', '品名', '货名', '名称', '货物', '商品', '产品'];
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
 * A header that names the PRODUCT with a word no key holds — «Product»,
 * «PRODUCTS», «Commodity», a 1C export's «Номенклатура» (FAYL-OQISH §5.2,
 * xlsxN-06 variant C). Never name keys: a key feeds every rung, and a
 * «Product» category to the left of «Name» took the name from it (c1936).
 * Asked on its own rung, right after the first and only by `namesTheProduct`
 * («Product colour», «Product No.», «Product category» name something else).
 */
const PRODUCT_KEYS = ['product', 'commodit', 'номенклат'];
/**
 * …and the last resort: «Наим.» (the abbreviation) and «Yuk turi» (the
 * cargo's kind, Uzbek) — never a bare «yuk»: «Yuk egasi» is the owner and
 * «Yuk og‘irligi» a weight (xlsx1-03's verifier).
 */
const LAST_NAME_KEYS = ['наим', 'yuk turi'];
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
/**
 * What a column says ABOUT the goods beside their name — the colour, the
 * material, the size, the packing, a remark (`goodsBeside`). Whole words in
 * Latin («Orange», «Range» are no colour); stems elsewhere.
 */
const NAME_DETAIL =
  /\b(?:colou?rs?|rangi?|materials?|materiali|sizes?|packing|packaging|packages?|remarks?|comments?|notes?|izoh)\b|цвет|материал|размер|упаков|примечан|комментар|o['ʻ‘’]?lcham|qadoq|颜色|材质|面料|尺寸|尺码|包装|备注/i;
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
const NAMING_HAN = ['品名', '名称', '商品', '货物', '产品', '货品', '货名'];
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
/** The last rung's header: a `LAST_NAME_KEYS` head that names no party and no attribute. */
const lastNames = (header: string): boolean => {
  const head = header.split(/[(,;]/)[0] ?? '';
  return !NAME_PARTY.test(head) && !NAME_ATTRIBUTE.test(head) && matchKey(head, LAST_NAME_KEYS);
};
/**
 * The TNVED / HS column (judge MR-19). Never a bare «hs» or «kod»: header
 * keys match as SUBSTRINGS, so «hs» is inside «Widths» and «kod» inside
 * «Tovar kodi» / «Mijoz kodi» — an article number then priced under a real
 * heading. And it is claimed only when most of its data cells READ as codes.
 */
const TNVED_KEYS = ['hs code', 'hs-code', 'тн вэд', 'тнвэд', 'tn ved', 'tnved', '海关编码', '商品编码'];
/**
 * Header keys match as SUBSTRINGS of the header folded by `matchKey` — so a
 * stem holds an Uzbek word's every ending (§5.13, unmapped-uz-header-words):
 * «og'irl» is «Og‘irligi», «Ogʻirlik», «Umumiy og'irligi» (which, read as no
 * weight, became the line's MONEY by its «umumiy»), and «nechta» is «Nechta».
 * A bare «necha» only before what it counts (`NECHA_COUNT`): «Necha so‘m» is
 * a price. A «Brutto» / «Брутто» column ALONE is the line's weight, a gross
 * one (§5.14, xlsxN-12), as «G.W.» and «毛重» always were.
 */
const QTY_KEYS = ['кол-во', 'кол.', 'количество', 'колич', 'soni', 'miqdor', 'dona', 'nechta', 'qty', 'quantity', 'pcs', '数量', '件数'];
const NECHA_COUNT = /(?<![\p{L}])necha(?![\p{L}])(?!\s*(?:so'?m|pul)(?![\p{L}]))/u;
const UNIT_KEYS = ['ед.', 'ед изм', 'единиц', 'birlik', 'unit', '单位'];
const WEIGHT_KEYS = ['вес', "og'irl", 'ogirl', 'vazn', 'weight', '重量', '总重', '毛重', '净重', 'g.w', 'n.w', 'gross', 'брутто', 'brutto'];
/**
 * Kilos as a unit WORD (docs/AI-SORAYDI.md §3.2 X1; XLS-3) — «KG», «KGS»,
 * «кг», the customs code «KGM», «公斤» — and never a key: as a SUBSTRING «kg» is
 * inside «PKGS», «PKG» and «BKG NO», so a packing list's package count read
 * as the line's weight (10 / 20 / 30 «kg» for 120 / 260 / 330), outranked the
 * «G.W.» beside it — a plain weight column goes before a gross one — and
 * per-kg customs was computed on 60 kg for a 710 kg shipment. A letter of its
 * own script on either side makes it another word; a digit («25KG») or a
 * Chinese character («总KG») does not.
 */
const KG_WORD = /(?<![\p{Script=Latin}\p{Script=Cyrillic}])(?:kgs?|kgm|кг)(?![\p{Script=Latin}\p{Script=Cyrillic}])|公斤|千克/iu;
/**
 * The weight's ABBREVIATIONS as words, and the «mass» a Russian or an Uzbek
 * sheet says for it (§3.2 X7; XLS-7, XLS-8). «G.W.» and «N.W.» were keys by
 * their dots, and a packing list writes «GW», «NW», «G/W», «N/W» as often:
 * undotted, neither was a weight at all — or, with a unit («NW(KG) |
 * GW(KG)»), both were «plain» weights by their «kg» and the heavier one, the
 * GROSS, became the line's, with no brutto read for the shipment. Whole words
 * only, the two letters together or with their dot or slash between — «S/N
 * W/H» is a serial number and a warehouse. «T.W» (total weight) needs its dot
 * or slash: «TW» is Taiwan in a column of origins.
 */
const WORD_EDGE = String.raw`[\p{Script=Latin}\p{Script=Cyrillic}]`;
const GW_WORD = new RegExp(String.raw`(?<!${WORD_EDGE})g(?:\s*[./／]\s*)?w(?!${WORD_EDGE})`, 'iu');
const NW_WORD = new RegExp(String.raw`(?<!${WORD_EDGE})n(?:\s*[./／]\s*)?w(?!${WORD_EDGE})`, 'iu');
const TW_WORD = new RegExp(String.raw`(?<!${WORD_EDGE})t\s*[./／]\s*w(?!${WORD_EDGE})`, 'iu');
const MASS_WORD = /(?<![\p{L}])(?:масс[аыеу]|massa(?:si)?)(?![\p{L}])/iu;
/**
 * A line's weight is NETTO (the row's own unit of account, `CalcField`), so a
 * packing list carrying both «N.W.» and «G.W.» is read by its net column
 * whichever stands first. Never «net» as a SUBSTRING: it is inside «Net
 * price», «Net amount» and «Cabinet No.», and the line's money became its
 * weight (the review).
 */
const NET_WEIGHT_KEYS = ['нетто', 'netto', 'n.w', 'net w', 'net.w', '净重'];
/** A header that names the NET weight: a net key, or «NW» / «N/W» as a word (X7). */
const namesNet = (text: string): boolean => matchKey(text, NET_WEIGHT_KEYS) || NW_WORD.test(text);
/**
 * …but «net» as a WORD is the net column when the header says it weighs
 * («Net, kg», «NET (KG)») or a gross column stands in the same header
 * («Gross | Net») — S6, the second review: dropping the word altogether made
 * «Gross, kg | Net, kg» read the gross, and per-kg duty took the cartons'
 * weight. A «Net» on an invoice with no weight beside it stays unread: there
 * it is as often the line's money.
 */
const NET_WORD = /(?:^|[^\p{L}])net(?:[^\p{L}]|$)/iu;
const WEIGHT_WORD = new RegExp(`${KG_WORD.source}|weight|\\bwt\\b|вес|${GW_WORD.source}|${NW_WORD.source}|${TW_WORD.source}|${MASS_WORD.source}`, 'iu');
const GROSS_HEADER = new RegExp(String.raw`gross|g\.\s*w|брутто|brutto|毛重|${GW_WORD.source}`, 'iu');
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
  /[/／]\s*(?:ctns?|cartons?|box(?:es)?|pcs?|pieces?|units?|шт|кор|мест|箱|件|个|只|包)|[(（]\s*(?:箱|件|个|只|包)\s*[)）]|\bper\b|\beach\b|\bsingle\b|на\s*1\b|(?<![\p{L}\d])(?:1|одного)\s*(?:мест|кор|ящик|упаков)|每|单箱|单件|单重/iu;
/**
 * A COUNT header that is one package's (as-built review FILES-1): «每箱数量»,
 * «每箱件数», «Кол-во в коробке», «PCS/CTN», «Qty per carton» stand before the
 * line's «总数量» / «Кол-во, шт» / «TOTAL QTY» on a packing list, and taken as
 * the line's count they made 300 jackets 30 — so the packing list was no
 * longer «the same goods» and its rows were added as a second order. Never
 * the weight's `PER_PACKAGE` whole: «Qty/pcs» is the line's count in pieces.
 *
 * The package is ONE (fix review FR-REGR-6): a PLURAL after the slash or
 * «in» — «QTY/CTNS», «QTY IN CTNS», «Total qty in cartons», «Кол-во/мест» —
 * counts the cartons themselves, the carton column it was before, unless a
 * piece word stands before it («PCS/CTNS»). A two-row header's per-package
 * child is one too (FR-REGR-2): «Soni (juft) har biri», «Кол-во, кг 1 места».
 */
const PER_PACKAGE_COUNT = new RegExp(
  [
    String.raw`(?:pcs?|pieces?|шт\.?|件|个)\s*(?:[/／]|\s+in\s+)\s*(?:ctns?|cartons?|box(?:es)?|pkgs?|packs?|bags?|кор\p{L}*|мест\p{L}*|ящ\p{L}*|箱|包)`,
    String.raw`[/／]\s*(?:ctn|carton|box|pkg|pack|bag|кор(?:\.|обк[аеуи])?|мест[оеау]|ящик[аеу]?|箱|包)(?![\p{L}])`,
    String.raw`\b(?:per|each|every)\s+(?:ctns?|cartons?|box(?:es)?|pkgs?|packages?|packs?|bags?)\b`,
    String.raw`\bin(?:\s+(?:a|one|1))?\s+(?:ctn|carton|box|pkg|package|pack|bag)\b`,
    String.raw`(?<![\p{L}])(?:в|на)\s*(?:1\s*|одн\p{L}*\s*)?(?:коробк|кор\.|упаковк|мест|ящик)`,
    String.raw`(?<![\p{L}\d])(?:1|одного)\s*(?:мест|кор|ящик|упаков)`,
    // «har biri» / «har (bir) qutida»: each one package — never «har bir tovar soni», each GOOD's count.
    String.raw`(?<![\p{L}])har\s+(?:biri(?![\p{L}])|(?:bir(?:ta)?\s+)?(?:quti|karobka|joy|qop)\p{L}*)`,
    '每|单箱',
  ].join('|'),
  'iu',
);
/**
 * The PACKAGE half of `PER_PACKAGE` (docs/AI-SORAYDI.md §3.2 X2): a weight or
 * a cube marked as ONE CARTON's — «CBM/CTN», «G.W./CTN», «毛重/箱», «单箱体积»,
 * «Объем 1 места», «G.W. (KG)» over «PER CTN». Such a column was passed over
 * and nothing multiplied it by the «CTNS» standing beside it (XLS-4, DIM-7);
 * now the row keeps the figure in its packing. Never the PIECE half («/pcs»,
 * «/шт», «单件», «单重»), and never a mark that may be either: «/件» (a piece
 * on one list and a package on the next, review JN-8), a bare «per», «each»,
 * «single» or «每». Each alternative is one of `PER_PACKAGE`'s own, narrowed
 * — so a column this reads was nobody's line figure before it.
 */
const PER_CARTON = new RegExp(
  [
    String.raw`[/／]\s*(?:ctns?|cartons?|box(?:es)?|кор|мест|箱|包)`,
    String.raw`[(（]\s*(?:箱|包)\s*[)）]`,
    String.raw`\b(?:per|each|single)\s+(?:(?:1|one|a)\s+)?(?:ctns?|cartons?|box(?:es)?|pkgs?|packages?|packs?)\b`,
    String.raw`на\s*1\s*(?:мест|кор|ящик|упаков)`,
    String.raw`(?<![\p{L}\d])(?:1|одного)\s*(?:мест|кор|ящик|упаков)`,
    '每箱|单箱|每包',
  ].join('|'),
  'iu',
);
/**
 * A UNIT, then the package it is counted in — «PRS/CTN», «пар/кор», «m²/ctn»,
 * «SETS/CTN», «шт в коробке», «pairs per carton», «双/箱»: what ONE CARTON
 * holds a count of, and in which unit (review JR-1). A count with no unit of
 * its own lands as PIECES, so 12 pairs a carton became 12 pieces a carton —
 * the calculator round's root defect, a number in the column nobody's unit
 * named. The word before the mark is the unit; «QTY/CTNS» has none there (it
 * counts the cartons themselves, FR-REGR-6) and «KGS/CTN» a weight's.
 */
const UNIT_PER_CARTON = new RegExp(
  String.raw`(?<![\p{L}\d])([\p{L}][\p{L}\d²³.]*?)\.?\s*(?:[/／]\s*|\s+(?:in|per|в|на)\s+(?:(?:1|a|one|одн\p{L}*)\s+)?)(?:ctns?|cartons?|box(?:es)?|pkgs?|packs?|bags?|кор\p{L}*\.?|мест\p{L}*|ящ\p{L}*|упаков\p{L}*|箱|包)(?![\p{L}])`,
  'iu',
);
/**
 * What one carton holds, as a Chinese packing list heads it where no quantity
 * key stands: «装箱数», «装箱量», «入数», and «每箱…数» with the unit between
 * («每箱双数», pairs a carton).
 */
const PACKED_COUNT_HAN = /装箱数|装箱量|入数|每箱\p{Script=Han}{0,2}数/u;
/**
 * The unit a header says one carton holds a count of — the word before the
 * package mark, else a pair / m² / litre word anywhere in it («Кол-во в
 * коробке, пар», «每箱双数»); null: it names none, and the count is pieces
 * unless the row itself counts in another unit (`parseGoods`). A letter alone
 * («L», «л») is a length as often as a litre and says nothing.
 */
function perCartonUnitOf(text: string): PerCartonUnit | null {
  const lead = UNIT_PER_CARTON.exec(text)?.[1] ?? null;
  // Before «/箱» a 件 is a piece: the package is named beside it.
  const led = lead === null ? null : lead === '件' ? 'dona' : unitOf(lead);
  if (led === 'dona' || led === 'juft' || led === 'm2' || led === 'litr') return led;
  for (const word of foldKey(text).split(/[^\p{L}\d²³]+/u)) {
    if (word.length < 2) continue;
    const unit = unitOf(word);
    if (unit === 'juft' || unit === 'm2' || unit === 'litr') return unit;
  }
  if (/[双对]/u.test(text)) return 'juft';
  if (/平方米|平米|㎡/u.test(text)) return 'm2';
  return null;
}
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
/**
 * The cube headers no key held (§3.2 X7, XLS-7): «CUBE», «Cubage», «CUBM»,
 * the transposed «CMB», and cubic metres spelled out as a header of their own
 * — «CU.M», «Cubic meter» (until now only the UNIT of a «MEAS» / «VOL»
 * header). With «方数» / «总方数» — 方 («fang») is how a Chinese forwarder
 * writes cubic metres; never «平方数», which counts SQUARE metres — these are
 * the cube columns that read as nothing, or, under a «Total», as the line's
 * MONEY. Whole words: «cub» is inside «Cuba» and «incubator». A bare «CUM» is
 * not one of them («Cum. qty» counts), and «Cubic feet» never was.
 */
const CUBE_WORD = /(?<![\p{Script=Latin}])(?:cubes?|cubage|cubm|cmb)(?![\p{Script=Latin}])|(?<!平)方数/iu;
const CUBIC_METRE_HEAD = /\b(?:cubic\s*m(?:et(?:er|re)s?|trs?|ts?)?|cu(?:\.\s*|\s+)m(?:trs?|ts?)?)\b/i;
/** A header that names a VOLUME — one predicate for every reader of «is this a cube column». */
const namesVolume = (text: string): boolean => matchKey(text, VOLUME_KEYS) || CUBE_WORD.test(text) || CUBIC_METRE_HEAD.test(text);
/**
 * A volume header's OWN unit, when it is not cubic metres (docs/AI-SORAYDI.md
 * §3.2 X6, review JN-13; XLS-10). «m3» is inside «cm3» and «м3» inside «дм3»,
 * and header keys match as substrings: «Volume (cm3)» 120000 landed as
 * 120 000 m³ on the line. Cubic centimetres and decimetres are named by their
 * own spelling wherever they stand; a LITRE by its word anywhere («Hajmi
 * (litr)», «Объём в литрах») and by its letter only where a header puts its
 * unit — in brackets, after a comma or a slash — since a bare «L» is as often
 * a length («L*W*H»).
 */
const CUBIC_CM = /(?<![\p{L}])(?:cm|см|sm)\s*[3³]|куб\.?\s*см|(?<![\p{L}])cu(?:bic)?\.?\s*(?:cm|centimet(?:er|re)s?)(?![\p{L}])|立方厘米/iu;
const CUBIC_DM = /(?<![\p{L}])(?:dm|дм)\s*[3³]|куб\.?\s*дм|(?<![\p{L}])cu(?:bic)?\.?\s*(?:dm|decimet(?:er|re)s?)(?![\p{L}])|立方分米/iu;
const LITRE_WORD = /(?<![\p{L}])(?:lit(?:er|re)s?|litr\p{L}*|литр\p{L}*|ltrs?)(?![\p{L}])|升/iu;
const LITRE_LETTER = /^(?:l|л)\.?$/iu;
/** Where a header writes its unit: in brackets, or after its last comma or slash. */
const UNIT_PARTS = /[(（\[]([^()（）\[\]]*)[)）\]]|[,，/／]\s*([^,，/／()（）\[\]]*)$/gu;
function unitParts(text: string): string[] {
  return [...text.matchAll(UNIT_PARTS)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
}
/** Cubic metres as a header's unit part writes them — «m3», «м³», «CBM», «куб.м», «立方米». */
const CUBIC_METRE_UNIT = /(?<![\p{L}])(?:m|м)\s*[3³]|cbm|куб|kub|立方|方/iu;
/**
 * A unit a volume header's unit part names that nobody converts here: a
 * length («CBM (cm)» is a carton's side), cubic feet and inches, millilitres
 * (a bottle's — «Vol, ml»), a weight. Read only INSIDE the unit part, and
 * only where it names no cubic metre («Volume (m3/total)»).
 */
const FOREIGN_VOLUME_UNIT =
  /(?<![\p{L}])(?:ml|мл|mm|мм|cm|см|sm|m|м|inch(?:es)?|ft|feet|foot|cu\.?\s*ft|cuft|cft|gal(?:lon)?s?|oz|yd|kgs?|кг)\.?\s*[23²³]?(?![\p{L}\d])|毫升|厘米|毫米|英尺|英寸|公斤|千克/iu;
/**
 * A header that names a WEIGHT in a volume's words (review JN-13):
 * «Объёмный вес, кг» and «Вес объемный», «Volume weight», «Vol. wt»,
 * «Volumetric», «Chargeable weight», «体积重», «抛重» — the carrier's
 * volumetric kilos — and any volume key beside kilos («Плотность, кг/м3»).
 * Its «объем» / «volume» / «м3» made it the line's cubic metres; it is
 * neither the cube nor the line's weight.
 */
const VOLUMETRIC_WEIGHT =
  /объ[её]мн\p{L}*\s+(?:вес|масс)|(?:вес|масса)\s+объ[её]мн|(?<![\p{L}])vol(?:ume|umetric|\.)?\s*(?:weight|wt)(?![\p{L}])|(?<![\p{L}])(?:volumetric|chargeable|dimensional)(?![\p{L}])|体积重|材积重|计费重|抛重/iu;
const volumetricWeight = (text: string): boolean =>
  VOLUMETRIC_WEIGHT.test(text) || (namesVolume(text) && KG_WORD.test(text));
/**
 * What a volume column's figures are divided by to be cubic metres — or
 * `null`: its header names a unit nobody converts, and the column is no
 * volume (the cube is asked, the figure said on the line's note).
 *  - cm³ ÷ 1 000 000 and dm³ ÷ 1000 on both rungs;
 *  - litres ÷ 1000 on the KEY rung («Объем, л», «Hajmi (litr)», «Volume (L)»).
 *    On the abbreviation rung («Vol (L)», «Vol, ml») a litre is a bottle's
 *    own — the corpus' c1936, c1937 — and stays refused, as every unit of its
 *    own does there unless it spells cubic metres out.
 * A DIVISOR, never a factor: 120000 / 1e6 is 0.12, 120000 × 1e-6 is not.
 */
function volumeDivisor(text: string, keyed: boolean): number | null {
  if (CUBIC_CM.test(text)) return 1_000_000;
  if (CUBIC_DM.test(text)) return 1000;
  if (!keyed) return !OWN_UNIT.test(text) || CUBIC_METRE.test(text) ? 1 : null;
  const parts = unitParts(text);
  if (LITRE_WORD.test(text) || parts.some((part) => LITRE_LETTER.test(part))) return 1000;
  if (parts.some((part) => FOREIGN_VOLUME_UNIT.test(part) && !CUBIC_METRE_UNIT.test(part) && !CUBIC_METRE.test(part))) return null;
  return 1;
}
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
/**
 * …and the package as a LATIN or CYRILLIC word — what makes a count header a
 * carton column (§5.10): «CTN QTY», «Carton Quantity», «PKG QTY». Never 件数:
 * on a Chinese list «件数» alone is the pieces (c1778) and «总件数» their total
 * (c2453).
 */
const LATIN_PACKAGE = /ctns?\b|cartons?|pkgs?\b|packages?|короб|мест/i;
/**
 * …and what RANKS a count header as one of packages (§5.10, review
 * break-qty-rank): the package words above, the Uzbek «karobka» / «quti» /
 * «joy soni» (Latin and Cyrillic) and the Russian «упаков». Only the rank asks these extra words —
 * the carton column and the packing-list shape keep PACKAGE_COUNT, as before.
 */
const RANK_PACKAGE = /karobka|(?:quti|қути)(?:lar|лар)?(?![\p{L}])|(?<![\p{L}])(?:joy|жой)(?:i|lar|и|лар)?\s+(?:soni|сони)|упаков/iu;
const namesPackage = (text: string): boolean => PACKAGE_COUNT.test(text) || RANK_PACKAGE.test(foldKey(text));
/** …and the package a count of BAGS names — rice, sugar and resin ship in them. */
const BAG_WORD = /(?<![\p{L}])(?:bags?|sacks?|qop\p{L}*)(?![\p{L}])|мешк|мешок|袋/iu;
/**
 * A header that names a WEIGHT (X1, X7): a weight's own word (`WEIGHT_KEYS`,
 * its abbreviations, «масса»), or kilos as a unit word — unless the unit is all it says of a weight and it
 * names a PACKAGE: «BAGS (25KG)», «PKGS (KG)», «Мест (кг)» count packages of
 * that size, and a package count is never a weight candidate. «Вес мест, кг»,
 * «Gross weight of packages», «Bag weight» say «weight» and stay one.
 */
const namesWeight = (text: string): boolean =>
  matchKey(text, WEIGHT_KEYS) ||
  [GW_WORD, NW_WORD, TW_WORD, MASS_WORD].some((word) => word.test(text)) ||
  (KG_WORD.test(text) && !namesPackage(text) && !BAG_WORD.test(text));
/** A count header that is the line's TOTAL — «TOTAL QTY», «Всего шт», «Jami soni», a leading 总 / 總 («总数量»). */
const COUNT_TOTAL = /(?<![\p{L}])(?:total|totals|ttl|sum|всего|итого|итог|jami|жами|umumiy|умумий)(?![\p{L}])/iu;
const COUNT_TOTAL_HAN = /^\s*[总總]|合计|总计|合計|總計/u;

/**
 * «件数» — a count that is the PIECES when it stands alone (c1778, c2453) and
 * the packages only beside a piece column («数量 | 件数»): 件 is a piece on one
 * Chinese list and a package on the next, so the other column decides.
 */
const JIANSHU = /件数/u;
/**
 * A COUNT header that counts packages by a word nobody reads as a piece
 * (docs/AI-SORAYDI.md §3.2 X2; XLS-9) — the RANK's own vocabulary
 * (`namesPackage`), so the rank and «which column is the pieces» cannot
 * disagree: «Karobka soni», «Joy soni», «Кол-во мест, шт» ranked as packages
 * and still landed as PIECES when no other count stood beside them — ten
 * cartons as ten jackets. With «Mesta» and «Korobka», which no list held;
 * never by «件数» (`JIANSHU`).
 */
const MORE_PACKAGES = /(?<![\p{L}])(?:mesta|korobka\p{L}*|karopka\p{L}*)(?![\p{L}])/iu;
const countsPackages = (text: string): boolean => namesPackage(text.replace(/件数/gu, '')) || MORE_PACKAGES.test(foldKey(text));
/**
 * A header that is nothing but a package COUNT (X2, XLS-9): «CTNS», «CTN»,
 * «Cartons», «PKGS», «Packages», «NO. OF CTNS», «箱数», «总箱数», «Мест», «Мест
 * (кор)», «Mesta», «Korobka». It carries no quantity key, so it was no count
 * header and only a flag (`ColumnMap.cartons`): its number stood on no row.
 * WHOLE words — the flag's `PACKAGE_COUNT` is a substring test, and
 * «Вместимость» holds «мест» — never «упаков…» (as often HOW the goods are
 * packed), and never the carton's NUMBER: «CTN NO.», «Carton No.», «箱号», «№
 * места» label a carton, they do not count them («NO. OF CTNS» does).
 */
const BARE_PACKAGES =
  /(?<![\p{L}])(?:ctns?|cartons?|pkgs?|packages?|короб\p{L}*|мест(?:[аоу]|ами)?|mesta|korobka\p{L}*|karobka\p{L}*|karopka\p{L}*|quti\p{L}*|қути\p{L}*)(?![\p{L}])|箱数|包数/iu;
const NUMBER_OF = /(?<![\p{L}])(?:nos?|num|number|qty|quantity)\.?\s+of(?![\p{L}])/iu;
const NUMBER_LABEL = /(?<![\p{L}])(?:nos?|num|number|nr|номер\p{L}*|raqam\p{L}*)(?![\p{L}])|[№#]|箱号|件号|编号/iu;
/**
 * The longest header the PACKING's tests read (X2-X4). A header that names a
 * package, a side or a size is a few words — the longest real ones are a
 * bilingual «Количество мест / Number of packages / 箱数» — while a cell of
 * thousands of characters is a merged master repeated across the sheet
 * (c1306, c1879): it names none of them, and asked of every such cell these
 * tests cost the one app process seconds (the long-strings sheet of
 * `fayl-oqish-reader.test.ts` read in 2.9 s before them and 5 s with them).
 */
const PACK_HEADER_MAX = 200;
/** The carton word a package header counts in — its own («мест», «ctns», «karobka», «箱»), else «karobka». */
function cartonWordOf(text: string): string {
  for (const word of foldKey(text).split(/[^\p{L}]+/u)) if (unitOf(word) === 'karobka') return word;
  return text.includes('箱') ? '箱' : 'karobka';
}

/**
 * WHOSE size a header names decides the arithmetic (§3.2 X3, review JN-11):
 * only a PACKAGE's size is multiplied by the packages. The two lists are the
 * kernel's (`FIELD_LABELS.packageSize` / `.size`, units.ts): «Carton size»,
 * «CTN SIZE», «MEAS (CM)», «外箱尺寸», «箱规», «Размер коробки», «Karobka
 * o‘lchami» are the package's; a bare «Size», «Dimensions», «L*W*H», «尺寸»,
 * «Размер», «Габариты», «O‘lchami» says nobody's — on a quotation it is the
 * PRODUCT's as often («Sofa | Size 220×95×85 | CTNS 30» is three cartons a
 * sofa, and 30 × 1.78 m³ a cube nobody shipped), so the size is kept with no
 * owner and the owner is asked.
 */
const PACKAGE_SIZE_LABELS: readonly string[] = SPEC_LABELS.packageSize.map((label) => label.replace(/[ʻ‘’`ʼ]/g, "'"));
const SIZE_LABELS: readonly string[] = SPEC_LABELS.size.map((label) => label.replace(/[ʻ‘’`ʼ]/g, "'"));
/**
 * Does the header carry one of these labels — as written, or as a word that
 * is a one-word label's stem («Dimension» of «dimensions», «O‘lcham» of
 * «o‘lchami», «Габарит» of «габариты»)? «L×W×H» is «l*w*h» in any of its signs.
 */
function namesSizeLabel(text: string, labels: readonly string[]): boolean {
  const folded = foldKey(text).replace(/[×✕]/g, '*').replace(/\s+/g, ' ');
  if (labels.some((label) => folded.includes(label))) return true;
  const words = folded.match(/[\p{L}']+/gu) ?? [];
  return words.some((word) => word.length >= 5 && labels.some((label) => !label.includes(' ') && label.startsWith(word)));
}
/** «MEAS.», «Measurement» — a packing list's word for its cartons' measurement (a cube, or their size). */
const MEAS_WORD = /\bmeas(?:urement)?s?\b/i;
/** A package, said beside a size word: «Box size», «Габариты коробки», «包装尺寸», «Packing size». */
const SIZE_PACKAGE_WORD =
  /(?<![\p{L}])(?:ctns?|cartons?|box(?:es)?|pkgs?|packages?|packing|короб\p{L}*|мест[аоу]?|упаков\p{L}*|ящик\p{L}*|karobka\p{L}*|quti\p{L}*)(?![\p{L}])|箱|包装/iu;
/** …and the goods themselves: «Product size», «Размер товара», «产品尺寸» — a size nobody multiplies by the cartons. */
const SIZE_PRODUCT_WORD =
  /(?<![\p{L}])(?:products?|items?|goods|товар\p{L}*|издели\p{L}*|продукт\p{L}*|продукци\p{L}*|mahsulot\p{L}*|tovar\p{L}*)(?![\p{L}])|产品|商品|单品|货物/iu;
/** A header that may hold sizes — a size label, or «MEAS.» (whose cells are a cube on one list and «60*40*50» on the next). */
const namesSize = (text: string): boolean => namesSizeLabel(text, PACKAGE_SIZE_LABELS) || namesSizeLabel(text, SIZE_LABELS) || MEAS_WORD.test(text);
/** Whose size the header — or the label an L | W | H triplet stands under — says it is; null: nobody's. */
function sizeOwnerOf(text: string): SizeOwner | null {
  if (namesSizeLabel(text, PACKAGE_SIZE_LABELS) || MEAS_WORD.test(text) || SIZE_PACKAGE_WORD.test(text)) return 'package';
  return SIZE_PRODUCT_WORD.test(text) ? 'product' : null;
}
/** A length as a size header names its unit; `'other'` — one nobody converts here (inches, feet): asked, never read as centimetres. */
function lengthUnitOf(part: string): CartonSize['unit'] {
  const unit = part.trim().toLowerCase().replace(/\.$/, '');
  if (/^(?:cm|см|sm|santimetr\p{L}*|сантиметр\p{L}*|厘米|公分)$/u.test(unit)) return 'cm';
  if (/^(?:mm|мм|millimetr\p{L}*|миллиметр\p{L}*|毫米)$/u.test(unit)) return 'mm';
  if (/^(?:m|м|metr\p{L}*|метр\p{L}*|米)$/u.test(unit)) return 'm';
  if (/^(?:inch(?:es)?|in|дюйм\p{L}*|dyuym\p{L}*|ft|feet|foot|фут\p{L}*|dm|дм|英寸|寸|英尺|["″])$/u.test(unit)) return 'other';
  return null;
}
/** The unit a size header names — «(cm)», «, см», «(sm)», «CTN SIZE CM» — or null: it names none, and the cell's own decides. */
function sizeUnitOfHeader(text: string): CartonSize['unit'] {
  for (const part of unitParts(text)) {
    const unit = lengthUnitOf(part);
    if (unit !== null) return unit;
  }
  // …or as the header's last word, where only centimetres and millimetres are unmistakable.
  const last = /(?<![\p{L}])(cm|см|sm|mm|мм)\.?\s*$/iu.exec(text);
  return last ? lengthUnitOf(last[1]!) : null;
}
/**
 * ONE side of a size as a header names it — «L», «W (cm)», «Длина», «Ш», «高»,
 * «外箱长», «MEAS (CM) H» (a two-row header composed) — and what stands before
 * the side's word, which says whose size the three are (`sizeOwnerOf`). The
 * side's word stands ALONE or after a size's own label: «N.W.» and «G.W.» end
 * in a «W» too, and read as a carton's width the net weight became the size's
 * second side — and was no weight any more.
 */
type Side = 'l' | 'w' | 'h';
const SIDE_WORD: Record<Side, RegExp> = {
  l: /^(?:l|len|length|д|дл|длина|uzunlig?i|uzunlik|bo'yi)$/u,
  w: /^(?:w|wid|width|ш|шир|ширина|eni|kenglig?i|kenglik)$/u,
  h: /^(?:h|ht|hgt|height|в|выс|высота|balandlig?i|balandlik)$/u,
};
const SIDE_HAN: [Side, RegExp][] = [
  ['l', /[长長]度?$/u],
  ['w', /[宽寬]度?$/u],
  ['h', /高度?$/u],
];
const sideWord = (word: string): Side | null => (['l', 'w', 'h'] as const).find((side) => SIDE_WORD[side].test(word)) ?? null;
function dimensionOf(text: string): { side: Side; lead: string } | null {
  const bare = foldKey(text).replace(UNIT_PARTS, ' ').replace(/[.:：\s]+$/u, '');
  const words = bare.match(/\p{Script=Han}+|[\p{L}']+/gu) ?? [];
  const last = words.at(-1);
  if (last === undefined) return null;
  const before = words.slice(0, -1).join(' ');
  const led = (side: Side, lead: string) =>
    lead === '' || namesSize(lead) || SIZE_PACKAGE_WORD.test(lead) || SIZE_PRODUCT_WORD.test(lead) ? { side, lead } : null;
  if (/^\p{Script=Han}+$/u.test(last)) {
    const han = SIDE_HAN.find(([, re]) => re.test(last));
    return han ? led(han[0], `${before} ${last.replace(han[1], '')}`.trim()) : null;
  }
  const side = sideWord(last);
  return side ? led(side, before) : null;
}

/**
 * A total word ANYWHERE in a cell — how the HEADER search judges a row's
 * neighbourhood (a serial read past its «TOTAL», a deep candidate whose name
 * is a total, a table line). Never whether a row is a good: that is
 * `totalRowOf`, which a product named «TOTAL cordless drill» passes.
 */
const TOTAL_ROW_KEYS = ['итого', 'всего', 'подытог', 'jami', 'total', '合计', '总计'];
/**
 * …and a Chinese SUBTOTAL row (review PF-ADV-3): «小计», «共计» under each
 * group landed as a goods row and doubled the sheet's brutto and cube. Only as
 * the cell's own word — never inside a name: «小计算器» is a pocket calculator.
 */
const SUBTOTAL_HAN = /^(?:小计|小計|共计|共計|合計|總計)(?!\p{Script=Han})/u;
const mentionsTotal = (text: string): boolean => matchKey(text, TOTAL_ROW_KEYS) || SUBTOTAL_HAN.test(text.trim());

/**
 * The words a TOTAL row's label is made of (§5.4, reader-5.4ab-vocab) —
 * whole words, never a substring: as `includes` the old keys ate «TOTAL
 * cordless drill» (a TOTAL Tools drill, xlsx1-04) and «Итоговая папка», and
 * missed «Umumiy», «Итог», «Жами», «Sum» and «Общий итог» (xlsx1-05), which
 * became a second good and doubled the brutto and the cube.
 *  - `TOTAL_WORDS` say «total» by themselves («umumiy» and «sum» only here,
 *    where a whole cell is judged: «Umumiy maqsadli lak», «Sumka»);
 *  - `CORE_TOTAL` are the ones that make a FIGURE-LESS row a footer even
 *    beside other words («SAY TOTAL: US DOLLARS …») — never «umumiy» or «sum»;
 *  - `TOTAL_PREFIX` qualify a total and never stand for one («Grand», «Общий»);
 *  - `TOTAL_QUALIFIERS` is the closed vocabulary a total label may carry
 *    beside its word: what is totalled, its unit, its currency, «по счету»,
 *    «к оплате», «SAY» — a cell of nothing else is a label, never a product.
 * Han has no spaces: a Han run is judged by stripping what a total label is
 * written in («合计数量», «总计（箱）») and seeing whether anything is left.
 */
const TOTAL_WORDS = new Set(['total', 'totals', 'ttl', 'subtotal', 'итого', 'итог', 'всего', 'подытог', 'jami', 'жами', 'umumiy', 'умумий', 'sum']);
const CORE_TOTAL = new Set(['total', 'totals', 'итого', 'всего', 'jami']);
const TOTAL_PREFIX = new Set(['grand', 'sub', 'общий', 'общая', 'общее']);
const TOTAL_QUALIFIERS = new Set([
  // what is totalled, as an English / Chinglish packing list writes it
  'amount', 'amounts', 'value', 'price', 'qty', 'quantity', 'quantities', 'ctn', 'ctns', 'carton', 'cartons', 'pkg', 'pkgs',
  'package', 'packages', 'pack', 'packs', 'pcs', 'pc', 'piece', 'pieces', 'set', 'sets', 'pair', 'pairs', 'weight', 'gross',
  'net', 'nw', 'gw', 'n', 'g', 'w', 'wt', 'volume', 'vol', 'meas', 'measurement', 'cbm', 'm', 'kg', 'kgs', 'usd', 'us',
  'dollar', 'dollars', 'rmb', 'cny', 'eur', 'uzs', 'rub', 'say', 'of', 'the', 'in', 'all', 'invoice', 'payable', 'due',
  'incl', 'including', 'excl', 'excluding', 'vat', 'tax', 'with', 'without', 'page', 'section', 'group', 'fob', 'cif',
  'exw', 'cfr', 'ddp', 'dap', 'fca', 'cpt', 'cip',
  // …what a Chinese packing list totals beside the goods: the page, the
  // shipment, its container and pallets («TOTAL 1X40'HQ», «TOTAL 2 PALLETS»,
  // «Total for this page», «Total goods»). The English mirror of the Russian
  // «по странице / товаров / позиций / заказу» below — missing, each of these
  // closing rows read as a GOOD at the Σ and doubled the quantity, brutto and
  // cube (the as-built check's check-b-total-container-label-kept).
  'for', 'this', 'these', 'goods', 'item', 'items', 'order', 'shipment', 'container', 'containers', 'cntr', 'pallet',
  'pallets', 'plt', 'plts', 'one', 'two', 'three', 'four', 'five',
  // …as a Russian invoice does
  'по', 'счету', 'счёту', 'накладной', 'документу', 'разделу', 'разделам', 'группе', 'листу', 'странице', 'сумма', 'сумме',
  'к', 'оплате', 'оплаты', 'с', 'без', 'ндс', 'учетом', 'учётом', 'вес', 'веса', 'брутто', 'нетто', 'кол', 'во',
  'количество', 'мест', 'места', 'шт', 'кг', 'м', 'куб', 'руб', 'сум', 'долл', 'всех', 'позиций', 'позициям', 'товаров',
  'товара', 'товарам', 'заказу', 'за', 'на',
  // …and an Uzbek one
  'summa', 'summasi', 'soni', 'miqdori', 'vazni', 'vazn', "og'irligi", 'ogirligi', 'hajmi', 'hajm', 'kub', 'dona', 'ta',
  'karobka', 'joy', 'narxi', 'qiymati', "bo'yicha", 'uchun', "so'm", 'tovarlar',
]);
/**
 * An Incoterm names the PLACE after it — «TOTAL FOB NINGBO», «TOTAL CIF
 * TASHKENT» — and a place is no product word (review break-named-total):
 * only after a total word, and only in a label of nothing but total words
 * and qualifiers up to it — «TOTAL key fob» and «FOB key TOTAL» stay goods.
 */
const INCOTERMS = new Set(['fob', 'cif', 'exw', 'cfr', 'ddp', 'dap', 'fca', 'cpt', 'cip']);
/**
 * A unit glued to its number is a qualifier — «TOTAL 15CTNS», «300KG»,
 * «1.2CBM» — but any other letters glued to digits are a model number, a
 * word: the «10W» of «TOTAL 10W-40» (a TOTAL motor oil) read as the «W» of
 * «G.W.» and made the oil a label-only total (review break-qualifier-letters).
 */
const GLUED_UNITS = new Set(['kg', 'kgs', 'ctn', 'ctns', 'pc', 'pcs', 'cbm', 'm3', 'м3', 'шт', 'кг', 'ta', 'set', 'sets', 'pairs']);
/**
 * A container is a qualifier too — «2X40HQ», «1X40'HQ», «40'HC», «20GP»: the
 * shipment's box, never a model number (an oil's «10W» is not one of these
 * letters).
 */
const CONTAINER_TOKEN = /^(?:\d+[x*×])?\d{2}'?(?:gp|hq|hc|dc|ot|fr|rf)$/;
/**
 * The words a SUBTOTAL may open with and still be one by the Σ (§5.4 (c)):
 * 1C's «Итого по разделу Одежда», «Всего по группе …», «Jami kiyimlar»,
 * «Subtotal …», «合计 女装». Never the Latin «TOTAL» alone: TOTAL is a brand
 * («TOTAL cordless drill», «TOTAL QUARTZ 9000»), and a TOTAL product whose
 * figures happen to add up to the lines above it stays a good (review
 * break-c-window-wider). «Grand total …», «Sub total …» open with a prefix.
 */
const LEAD_TOTAL = new Set(['итого', 'всего', 'jami', 'жами', 'подытог', 'subtotal']);
/**
 * …and the words a subtotal may END with (Excel's «X Итог», «X Total»):
 * never «umumiy» / «умумий» / «sum» — those say total only as a whole label
 * (§5.4 (a), reader-5.4ab-vocab), and «Dim sum», «… umumiy» are names
 * (review break-c-window-wider).
 */
const LAST_TOTAL = new Set(['total', 'totals', 'ttl', 'subtotal', 'итого', 'итог', 'всего', 'подытог', 'jami', 'жами']);
const LEAD_TOTAL_HAN = /^(?:合计|总计|合計|總計|小计|小計|共计|共計)/u;
const TOTAL_HAN = /合计|总计|合計|總計|小计|小計|共计|共計|汇总|匯總/u;
const TOTAL_HINT = /total|ttl|sum|итог|всего|подытог|jami|жами|umumiy|умумий|合计|总计|合計|總計|小计|小計|共计|共計|汇总|匯總/i;
const TOTAL_HAN_LAST = /(?:合计|总计|合計|總計|小计|小計|共计|共計|汇总|匯總)$/u;
const HAN_QUALIFIERS = /合计|总计|合計|總計|小计|小計|共计|共計|汇总|匯總|数量|數量|件数|件數|箱数|箱數|重量|毛重|净重|淨重|体积|體積|金额|金額|总额|總額|总价|總價|美元|人民币|公斤|立方米|立方|[总總共箱件个個包元米]/gu;

/** What a cell says as a total label (null: no total word in it at all). */
interface TotalLabel {
  /** Nothing word-like is left beside the total word(s) and their qualifiers. */
  only: boolean;
  /** A CORE total word stands in it as a whole word. */
  core: boolean;
  /** Its LAST word is a total word — Excel's subtotal «Куртка женская Итог», «Jacket Total», «女士夹克 汇总». */
  last: boolean;
  /** It OPENS as a subtotal does — «Итого по разделу …», «Subtotal …», «Grand total …» (`LEAD_TOTAL`). */
  lead: boolean;
}
function totalLabel(text: string): TotalLabel | null {
  // Most cells say no total at all: they are answered before a word is split
  // (`totalRows` asks this of every string cell of the sheet).
  if (text.length > 300 || !TOTAL_HINT.test(text)) return null;
  // Digits are read WITH the letters glued to them («10w», «15ctns»), and a
  // bare number is no word at all («TOTAL 15 CTNS»).
  const words =
    foldKey(text.trim())
      .replace(/(\p{Script=Han}+)/gu, ' $1 ')
      .match(/[\p{L}\d']+/gu)
      ?.map((w) => w.replace(/^'+|'+$/g, ''))
      .filter((w) => w !== '' && !/^\d+$/.test(w)) ?? [];
  let total = false;
  let core = false;
  let only = true;
  let place = false;
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      // A Han total word is the run's own only when nothing but qualifiers is
      // left beside it, or the run ENDS with it: «合计数量», «女士夹克 汇总» —
      // never «小计算器», a pocket calculator.
      const rest = word.replace(HAN_QUALIFIERS, '');
      if (TOTAL_HAN.test(word) && (rest === '' || TOTAL_HAN_LAST.test(word))) {
        total = true;
        core ||= /合计|总计|合計|總計/u.test(word);
      }
      if (rest !== '') only = false;
    } else if (TOTAL_WORDS.has(word)) {
      total = true;
      core ||= CORE_TOTAL.has(word);
    } else if (/\d/.test(word)) {
      // …or a qualifier word glued to its number («15мест», «15CARTONS»),
      // never a single letter: the «W» of «10W» is a model number's.
      const glued = word.replace(/^\d+/, '');
      if (!CONTAINER_TOKEN.test(word) && !GLUED_UNITS.has(glued) && !(glued.length > 1 && TOTAL_QUALIFIERS.has(glued))) {
        only = false;
      }
    } else if (INCOTERMS.has(word) && total) {
      // The place after an Incoterm only once a total word has been seen:
      // «FOB key TOTAL» is a key fob (the as-built check's
      // check-b-incoterm-first-swallows-name), «TOTAL FOB NINGBO» a total.
      place = true;
    } else if (!place && !TOTAL_PREFIX.has(word) && !TOTAL_QUALIFIERS.has(word)) only = false;
  }
  if (!total) return null;
  const [first = '', second = ''] = words;
  const tail = words.at(-1) ?? '';
  return {
    only,
    core,
    last: LAST_TOTAL.has(tail) || TOTAL_HAN_LAST.test(tail),
    lead: LEAD_TOTAL.has(first) || LEAD_TOTAL_HAN.test(first) || (TOTAL_PREFIX.has(first) && TOTAL_WORDS.has(second)),
  };
}

/**
 * Why a row the sheet holds is no good — said, never dropped in silence
 * (`dropped`, §5.5):
 *  - `total` — a label-only total («TOTAL», «Итого по счету», «TOTAL 15
 *    CTNS», «Umumiy», «Общий итог», «合计数量»), whatever its figures;
 *  - `footer_total` — a figure-less line with a CORE total word in it, the
 *    «SAY TOTAL: US DOLLARS …» footer;
 *  - `subtotal` — a total word in a named row whose figures ARE the Σ of the
 *    goods above it (Excel's «Куртка женская Итог»);
 *  - `footer` — a figure-less line under the last line that states
 *    anything (§5.5): «Made in China», «Remarks:», a stamp.
 */
export type DroppedWhy = 'total' | 'footer_total' | 'subtotal' | 'footer';
export interface DroppedRow {
  /** The row as one line, its cells joined by « | » (what the model is shown of it). */
  text: string;
  /**
   * Its name cell — what a door puts back as a line when a person says the
   * row IS a good (the deal import's «＋», the VED paste); '' for a total
   * standing in no name column.
   */
  name: string;
  why: DroppedWhy;
}

/** What `totalRowOf` is told of a row. */
export interface TotalRowFacts {
  /** The row's name cell (any cell, for `totalRows`). */
  name: string;
  /** Does the row state a figure of its own in a mapped figure column (headerless: in any cell)? */
  figures: boolean;
  /**
   * Its figures equal the Σ of the goods landed since the sheet's start or
   * the last total row, over `rows` goods; `twin` = there is one and it
   * bears this row's own name. Absent: not judged.
   */
  sum?: { rows: number; twin: boolean } | null;
}

/**
 * Is this row arithmetic and not a good — and why? ONE predicate (#513),
 * asked by every reader of «is this a total row»: `parseGoods`' own rows,
 * its stopped-short test, and `totalRows` that the contradiction check reads
 * (reader-5.4ab-vocab: with two rules a «TOTAL QUARTZ 9000» oil kept as a good
 * was still read as the sheet's grand total and nulled the Σ).
 *
 * The Σ may drop a row ONLY when its name is a subtotal's (§5.4 (c),
 * reader-5.4c-silent-arith): label-free, it took the third colour of one
 * jacket (100/200/300), the «Шкаф» of «Стол 5 / Стул 10 / Шкаф 15» and the
 * grey socks of 100/100/200 — all of which equal what stands above them.
 * A subtotal's name ENDS with its total word (Excel's «Куртка женская
 * Итог») or OPENS as one (1C's «Итого по разделу Одежда»); a total word
 * anywhere else is a product's — «Umumiy maqsadli lak», «TOTAL cordless
 * drill» — however its figures add up (review break-c-window-wider). Over
 * one good the row must not bear that good's own name: two «Colgate Total»
 * lines with the same figures are two lines.
 */
export function totalRowOf(row: TotalRowFacts): Exclude<DroppedWhy, 'footer'> | null {
  const label = totalLabel(row.name);
  if (!label) return null;
  if (label.only) return 'total';
  if (!row.figures && label.core) return 'footer_total';
  const sum = row.sum;
  if (sum && (label.last || label.lead) && (sum.rows >= 2 || !sum.twin)) return 'subtotal';
  return null;
}

/**
 * What a whole cell LABELS, when it is nothing but a field's name — the left
 * column of a label|value card («Soni: | 300», «Вес брутто, кг | 150», «HS
 * code | 6202930000») and of a letterhead («Address: | Yiwu», «电话 | …»).
 * An EXACT vocabulary, never `matchKey`: as a substring «вес» is inside
 * «Весы напольные» and «куб» inside «Кубик Рубика», and a real list of scales
 * would read as a card (xlsx1-07's verifier, c2619). The cell is judged
 * without its trailing colon and the unit it names («(kg)», «, м3»), must
 * carry no digit and at most three words (reader-5.6-card).
 */
type FieldKind = 'name' | 'count' | 'unit' | 'net' | 'weight' | 'gross' | 'volume' | 'tnved' | 'price' | 'total' | 'other';
const FIELD_WORDS: Record<FieldKind, string[]> = {
  name: [
    'tovar', 'tovar nomi', 'tovarning nomi', 'mahsulot', 'mahsulot nomi', 'nomi', 'товар номи', 'маҳсулот', 'махсулот',
    'наименование', 'наименование товара', 'наименование продукции', 'товар', 'название', 'название товара', 'описание',
    'описание товара', 'номенклатура', 'product', 'product name', 'name', 'goods', 'description', 'description of goods',
    'item', 'item name', 'commodity', '品名', '名称', '商品', '商品名称', '产品', '产品名称', '货名', '货物', '货物名称',
  ],
  // …a count however a two-column list names it, Uzbek Cyrillic and a bare
  // «Шт» / «件» included: «Наименование | Шт», «Товар номи | Сони», «品名 | 件»
  // over figures are a header, never a card's first line (§5.6 (a), the
  // fix round's reader-a-break-twocol-value-refusal).
  count: [
    'soni', 'miqdori', 'miqdor', 'dona', 'nechta', 'сони', 'миқдори', 'миқдор', 'нечта', 'количество', 'кол-во', 'кол.',
    'колич', 'кол', 'остаток', 'шт', 'шт.', 'штук', 'qty', 'quantity', 'pcs', 'pieces', 'count', 'total qty',
    'total quantity', '数量', '件数', '件', '个',
  ],
  unit: ['birlik', "o'lchov birligi", 'ед. изм.', 'ед.изм.', 'ед изм', 'ед. изм', 'единица', 'единица измерения', 'unit', 'units', '单位'],
  net: [
    'netto', 'нетто', 'вес нетто', 'масса нетто', 'net weight', 'n.w.', 'n.w', 'nw', 'net wt', '净重',
    "sof og'irligi", "sof og'irlik", 'sof vazni', 'sof vazn',
  ],
  weight: ['vazni', 'vazn', "og'irligi", "og'irlik", 'ogirligi', 'ogirlik', 'вазни', 'вазн', 'оғирлиги', 'оғирлик', 'вес', 'масса', 'weight', '重量'],
  gross: [
    'brutto', 'брутто', 'вес брутто', 'масса брутто', 'gross weight', 'gross', 'g.w.', 'g.w', 'gw', 'gross wt', '毛重',
    "yalpi og'irligi", "umumiy og'irligi", 'umumiy vazni',
  ],
  volume: ['hajmi', 'hajm', 'kub', 'kubi', 'объём', 'объем', 'куб', 'кубатура', 'volume', 'cbm', 'meas', 'measurement', '体积', '立方'],
  tnved: ['tnved', 'tn ved', 'tn-ved', 'tnved kodi', 'тн вэд', 'тнвэд', 'код тн вэд', 'hs code', 'hs', 'hs-code', 'hs код', '海关编码', '商品编码', 'hs编码', '税号'],
  price: ['narxi', 'narx', 'birlik narxi', 'цена', 'price', 'unit price', '单价', '价格'],
  total: ['summa', 'jami summa', 'qiymati', 'сумма', 'стоимость', 'amount', 'total amount', '总价', '金额'],
  // A field the card carries and no column of ours holds — its attributes, its
  // packages, a letterhead's lines: a label all the same, never a product.
  other: [
    'model', 'модель', 'material', 'materiali', 'материал', 'brand', 'бренд', 'марка', 'origin', 'country of origin', 'страна',
    'страна происхождения', 'color', 'colour', 'цвет', 'rang', 'rangi', 'size', 'размер', "o'lcham", "o'lchami", 'spec',
    'specification', 'спецификация', 'примечание', 'note', 'notes', 'remark', 'remarks', 'comment', 'izoh', 'артикул',
    'article', 'sku', 'barcode', 'штрих-код', 'karobka', 'karobka soni', 'quti', 'qutilar', 'мест', 'кол-во мест',
    'ctns', 'ctn', 'cartons', 'carton', 'packages', '型号', '材质', '品牌', '颜色', '尺寸', '产地', '规格', '备注', '箱数',
    'address', 'add', 'tel', 'phone', 'fax', 'e-mail', 'email', 'date', 'buyer', 'seller', 'consignee', 'shipper',
    'supplier', 'customer', 'client', 'company', 'company name', 'manzil', 'telefon', 'sana', 'mijoz', 'адрес', 'телефон',
    'факс', 'дата', 'покупатель', 'продавец', 'получатель', 'отправитель', 'клиент', '地址', '电话', '传真', '日期',
    '买方', '卖方', '收货人', '发货人', '公司名称', '客户', '序号', 'no.', 'no', '№',
  ],
};
/** The labels that name a FIGURE column — a goods row's count stands under one (`labels`). */
const FIGURE_FIELDS = new Set<FieldKind>(['count', 'net', 'weight', 'gross', 'volume', 'price', 'total']);
const FIELD_LABELS = new Map<string, FieldKind>(
  (Object.entries(FIELD_WORDS) as [FieldKind, string[]][]).flatMap(([kind, words]) => words.map((word): [string, FieldKind] => [word, kind])),
);
/** The unit a label names after itself: «(kg)», «（公斤）», «, кг», «, м3». */
const LABEL_UNIT = /\s*(?:[(（][^()（）]{1,12}[)）]|,\s*[\p{L}\d²³.$/]{1,8})$/u;
function fieldLabel(cell: Cell): FieldKind | null {
  if (typeof cell !== 'string' || cell.length > 60) return null;
  const text = cell
    .trim()
    .toLowerCase()
    .replace(/[ʻ‘’`ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*[:：]$/, '')
    .replace(LABEL_UNIT, '')
    .replace(/\s*[:：]$/, '')
    .trim();
  if (text === '' || /\d/.test(text) || text.split(' ').length > 3) return null;
  return FIELD_LABELS.get(text) ?? null;
}
/** A cell that announces a value after it — «Address:», «电话：» — or is a field's name. */
const labelCell = (cell: Cell): boolean => /[:：]\s*$/.test(cellText(cell)) || fieldLabel(cell) !== null;
/**
 * …as a name column's DATA: the label of ANOTHER field. A card's name column
 * holds «Soni», «Vazni», «TNVED» under its «Tovar nomi», a letterhead's
 * «Address:», «Tel:» under «Company Name»; a line named «Товар» or «Product»
 * is a placeholder, not a card (goods-import.test.ts writes its rows so).
 */
const otherLabel = (cell: Cell): boolean => {
  const kind = fieldLabel(cell);
  return kind !== null ? kind !== 'name' : /[:：]\s*$/.test(cellText(cell));
};

/** How many data rows a column's content is judged by. */
const SAMPLE_ROWS = 50;

const cellText = (cell: Cell): string => (cell === null ? '' : String(cell).trim());

/** The header's text as the keys are written: lower case, every apostrophe Uzbek types «ʻ ‘ ’ ` ʼ» the ASCII one (§5.13). */
const foldKey = (text: string): string => text.toLowerCase().replace(/[ʻ‘’`ʼ]/g, "'");

const matchKey = (text: string, keys: string[]): boolean => {
  const t = foldKey(text);
  return t.length > 0 && keys.some((k) => t.includes(k));
};

/** A header that counts — a quantity key, or «Necha …» before what it counts (§5.13). */
const namesCount = (text: string): boolean => matchKey(text, QTY_KEYS) || NECHA_COUNT.test(foldKey(text));

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
function parseMeasure(cell: Cell, accept: MeasuredIn): number | null {
  const plain = parseNumber(cell);
  if (plain !== null || typeof cell !== 'string') return plain;
  const glued = GLUED_FIGURE.exec(cell.trim());
  if (!glued || unitOf(glued[2]!.replace(/\.$/, '')) !== accept) return null;
  const read = readNumberCell(glued[1]!);
  return read.state === 'ok' ? read.value : null;
}

const GLUED_FIGURE = /^(-?[\d\s.,]*\d)\s*([\p{L}][\p{L}\d²³.]*)$/u;
/** The units a figure column may be measured in — the unit a cell may carry glued to its number. */
type MeasuredIn = 'dona' | 'kg' | 'm3' | 'karobka' | 'juft' | 'm2' | 'litr';

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
function columnCells(rows: Cell[][], headerRow: number, col: number, skip: ReadonlySet<number> = NO_ROWS): Cell[] {
  const own = cellText(rows[headerRow]?.[col] ?? null).toLowerCase();
  const out: Cell[] = [];
  for (let d = headerRow + 1; d < Math.min(rows.length, headerRow + 1 + SAMPLE_ROWS); d++) {
    // …nor a row that is the header again in its second language (§5.12):
    // «HS Code» sampled as data made a one-good file's TNVED column «not
    // mostly codes», and the supplier's code was dropped.
    if (skip.has(d)) continue;
    const cell = rows[d]![col] ?? null;
    if (cellText(cell) !== '' && !isHeaderText(cell, own)) out.push(cell);
  }
  return out;
}
const NO_ROWS: ReadonlySet<number> = new Set();

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

/**
 * The words a two-row header's split puts AFTER the parent's unit and that
 * name none: «Кол-во, м2» over «всего» reads «Кол-во, м2 всего», «QTY (PAIRS)»
 * over «TOTAL» reads «QTY (PAIRS) TOTAL» (fix review FR-REGR-2) — the unit
 * is still the parent's, or m² and pairs land as pieces.
 */
const UNIT_TAIL = new Set(['total', 'totals', 'ttl', 'sum', 'all', 'всего', 'итого', 'jami', '合计', '总计', '小计', '共计']);

/** The unit a header names with its last word — «Кол-во, кг» is a weight. */
function headerUnitWord(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}\d²³]+/u).filter(Boolean);
  while (words.length > 1 && UNIT_TAIL.has(words.at(-1)!)) words.pop();
  const last = words.at(-1) ?? null;
  return last && unitOf(last) !== null ? last : null;
}

interface Detected {
  headerRow: number;
  /** The first data row: past a second header row directly under the header (§5.12). */
  dataFrom: number;
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
  'per', 'each', 'single', 'ctn', 'ctns', 'carton', 'cartons', 'box', 'pkg', 'pkgs', 'total', 'totals', 'ttl', 'sum', 'all',
  'g', 'w', 'n', 'gw', 'nw', 'gross', 'net', 'weight', 'wt', 'kg', 'kgs', 'pcs', 'pc', 'qty', 'quantity',
  'cbm', 'm', 'unit', 'units', 'vol', 'volume', 'meas',
  'шт', 'кг', 'м', 'нетто', 'брутто', 'вес', 'всего', 'итого', 'места', 'место', 'мест', 'в', 'коробке',
  'упаковке', 'на', 'одного', 'ед', 'кол', 'во', 'объем', 'объём', 'jami', 'dona', 'har', 'biri', 'quti', 'за',
]);
/**
 * …and the Russian package words by their STEM (fix review FR-SELL-2): «в 1
 * месте», «за 1 место», «1 кор.», «1 коробки» — a declension of a word the
 * set held twice was a data row, and the brutto the Σ of single cartons.
 */
const SUB_HEADER_STEM = /^(?:мест|кор|упаков|ящик)/u;
/** …and the Chinese characters such a row is written in. */
const SUB_HEADER_HAN = /^[单每箱件个包合总计小毛净重数量体积]+$/u;
/**
 * The words that SPLIT a parent — one of them must stand in the row: a row
 * of bare units («pcs | kg») splits nothing, and «1 места» reads as a figure
 * («1 carton») to the figure test, so the vocabulary decides, not the shape.
 */
const SPLIT_WORDS = new Set(['per', 'each', 'single', 'total', 'totals', 'ttl', 'all', 'sum', 'gross', 'net', 'n', 'g', 'gw', 'nw', 'нетто', 'брутто', 'всего', 'итого', 'места', 'место', 'jami', 'har']);
const SPLIT_HAN = /[单每合总毛净]/u;

/** Is the row under the chosen header its SUB-header (`SUB_HEADER_WORDS`), never data? */
function subHeaderRow(row: Cell[] | undefined, r: number, covered: Covered | null): boolean {
  if (!row) return false;
  let splits = 0;
  // (X3) …or the three SIDES of a size under a parent merged across them —
  // «MEAS (CM)» / «Carton size» over «L | W | H», «Длина | Ширина | Высота»,
  // «长 | 宽 | 高»: a split of its own kind, and one only when all three stand.
  const sides = new Set<Side>();
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
      const side = han ? (SIDE_HAN.find(([, re]) => re.test(t))?.[0] ?? null) : sideWord(t);
      if (side) sides.add(side);
      else if (han ? !SUB_HEADER_HAN.test(t) : /^\d+$/.test(t) ? t !== '1' && t !== '3' : !SUB_HEADER_WORDS.has(t) && !SUB_HEADER_STEM.test(t) && !SIDE_UNITS.has(t)) return false;
      if (han ? SPLIT_HAN.test(t) : SPLIT_WORDS.has(t)) splits += 1;
    }
  }
  return splits > 0 || sides.size === 3;
}
/** The unit a side's cell may carry in the sub-header row — «L (cm)», «Ш, мм». */
const SIDE_UNITS = new Set(['cm', 'mm', 'sm', 'см', 'мм']);
/** One side of a size as a DATA cell writes it with its unit glued on — «60cm», «0.6 м» (a bare number is read as one). */
const SIDE_CELL = /^\d+(?:[.,]\d+)?\s*(?:cm|см|sm|mm|мм|m|м)\.?$/iu;

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
 * Find the header row and map its columns. Null when the file has no header
 * we can read: that is not a failure, it is single-column mode.
 */
export function detectColumns(rows: Cell[][], covered: Covered | null = null): Detected | null {
  return findHeader(rows, covered).found;
}

/** The rows a header is chosen among — files open with logos and legal names. */
const TOP_ROWS = 10;
/** …and how deep one is looked for when none of them is a header (§5.1). */
const DEEP_ROWS = 50;

/**
 * The header — or, when a one-column list carries its figures and so has no
 * header anywhere, the last of its opening lines that is no product
 * (`refused`, `listOpening`), which `parseGoods`' headerless pass starts
 * after.
 *
 * The ORDER of the tests is the design (docs/FAYL-OQISH.md §5), each one's
 * answer the next one's input:
 *  0. A two-column label|value CARD of one good is read before any of this
 *     (`cardGood`, §5.6's extra): a card has no header row to find.
 *  1. Rows 0-9: every row is a candidate (`headerAt`) and the BEST wins
 *     (§5.8) — the one that maps the most columns besides the name, a tie the
 *     earliest, and a later one only when no row between would land as a
 *     good under the earlier (`landsBetween`). A letterhead's label row
 *     («Company Name | Yiwu Trading Co.», «公司名称», «Product name: | Hair
 *     dryer») maps the name alone and loses to the table under it; it was
 *     taken because it came first. A row the same as one already judged is
 *     not judged again.
 *  2. Only when none of them is a header: rows 10-49, the first that holds
 *     (§5.1), under guards that apply there alone — the search stops at the
 *     second TABLE line above it (`tableLine`: a title block states no
 *     goods), a row carrying a figure is data unless it names the goods by
 *     the field's own word, and a header found that deep names a figure
 *     column and no total.
 * Inside one candidate (`headerAt`):
 *  a. a one-cell row (rows 0-9 only): the table-below skip, the list refusal
 *     and the numbered title as before, then it must READ as a heading or a
 *     title (§5.7 (2));
 *  b. the columns (`mapColumns`): TNVED first, then the name ladder — the
 *     product rung after the first (§5.2), the serial guard on the stated
 *     rungs and on the last NAME_KEYS rung, which never takes a party (§5.3,
 *     §5.8), the last-resort rung (§5.2 (d)); the column chosen holding field
 *     LABELS refuses the row (§5.6 (b), §5.8) — then the figures;
 *  c. a second header row below it (§5.12) is taken out of the sampling and
 *     the columns are mapped again, so the checks after it read the final
 *     map;
 *  d. a candidate with a FIGURE beside its name is a data row (§5.7 (1)),
 *     unless its name cell is the field's own word (a size run's header);
 *  e. one whose only other cell is a VALUE — no key, no unit, no column the
 *     map claimed — over the card's figures is a transposed card (§5.6 (a));
 *  f. the deep guards (b), on the final map.
 * Each answers on the map the step before it settled: (d) reads which column
 * the ladder named, (e) which the figures claimed, (f) the final map.
 */
function findHeader(rows: Cell[][], covered: Covered | null = null): { found: Detected | null; refused: number | null } {
  let best: { detected: Detected; score: number } | null = null;
  // A row word for word one already judged is judged the same: the header
  // again maps nothing the first did not, and a row refused once is refused
  // again (c0425: 2,000 rows of one cell). Best-of-ten and the deep search
  // judged every row anew — 2,000 × 100 cells of «Customer name xxx…» (no
  // header anywhere) took 3.8 s for 0.1, two 30,000-character rows taking
  // turns 1.5 s for 0.6 (the fix round's reader-a-break-candidate-cost).
  const judged: number[] = [];
  const seen = (r: number) => judged.some((j) => sameCells(rows[r], rows[j]));
  let tableLines = 0;
  for (let r = 0; r < Math.min(rows.length, TOP_ROWS); r++) {
    if (tableLine(rows, r, covered)) tableLines += 1;
    if (seen(r)) continue;
    judged.push(r);
    const at = headerAt(rows, r, covered, false);
    // A list refused below a header already found leaves that header standing:
    // the first-found rule returned it before this row was ever read.
    if (at === 'refused') {
      if (best) break;
      return { found: null, refused: listOpening(rows) };
    }
    if (at && (best === null || (at.score > best.score && !landsBetween(rows, best.detected, r, covered)))) best = at;
  }
  if (best) return { found: best.detected, refused: null };
  for (let r = TOP_ROWS; r < Math.min(rows.length, DEEP_ROWS); r++) {
    // (§5.1, the fix round's reader-a-break-deep-summary-wins) The search goes
    // deep for a TITLE BLOCK's table, and a title block states no goods: under
    // a table of lines the top rows could not read, a «Всего наименований |
    // Количество мест | Вес брутто» summary was taken as the whole sheet's
    // header, its one row of totals the only good, and the lines above it —
    // the real goods — were lost with nothing shown to the model.
    if (tableLines >= 2) break;
    if (tableLine(rows, r, covered)) tableLines += 1;
    if (seen(r)) continue;
    judged.push(r);
    const at = headerAt(rows, r, covered, true);
    if (at && at !== 'refused') return { found: at.detected, refused: null };
  }
  return { found: null, refused: null };
}

/**
 * A line of a TABLE, as a title block has none: a word or a serial with a
 * figure beside it («Куртка модель 3 | 302 | 152», «1 | Ladies jacket |
 * 300»), or a typed line carrying its own («Стол офисный 5 шт»). Never a
 * label's line — «TEL: | +86 579 8501», «Date | 2026-11-01», «Invoice No: |
 * HY-118» — and never a merged cell's repeats. Two of them above a deep
 * candidate are a table the top rows did not read (one may be a letterhead's
 * «PI NO | 12345»).
 */
function tableLine(rows: Cell[][], r: number, covered: Covered | null): boolean {
  const cells = (rows[r] ?? []).filter((cell, i) => cellText(cell) !== '' && !covered?.has(r, i));
  if (cells.length === 0 || labelCell(cells[0]!)) return false;
  return cells.length === 1 ? carriesFigure(cells[0]!) : cells.some(readsAsFigure);
}

/**
 * (§5.8, the fix round's reader-a-spec-best-of-ten-drops-rows-above) Would a
 * row between the header found and a later candidate land as a GOOD under the
 * one found? Then the later one is no better: «Наименование | Кол-во» over
 * Стол / Стул, then a fuller table further down, lost Стол and Стул to the
 * second header; «Товар | Примечание» lost every line above «Сумка для
 * товаров | вес уточняется», whose «вес» mapped a weight. The letterhead a
 * later table outranks has no goods between: its lines are labels («Brand: |
 * Xiaomi» under «Product name:»), or its name column is a letterhead's own
 * field («Company Name | Yiwu Trading Co.» over its address lines, c2695).
 */
function landsBetween(rows: Cell[][], found: Detected, r: number, covered: Covered | null): boolean {
  const { headerRow, dataFrom, columns } = found;
  const head = rows[headerRow]?.[columns.name] ?? null;
  if (fieldLabel(head) === 'other' || NAME_PARTY.test(cellText(head).split(/[(,;]/)[0] ?? '')) return false;
  const own = cellText(head).toLowerCase();
  for (let d = dataFrom; d < r; d++) {
    const name = rows[d]?.[columns.name] ?? null;
    const text = cellText(name);
    if (text === '' || labelCell(name) || isHeaderText(name, own) || mentionsTotal(text)) continue;
    if (repeatsHeader(rows[d]!, d, columns, covered)) continue;
    return true;
  }
  return false;
}

const filled = (row: Cell[] | undefined) => (row ?? []).filter((cell) => cellText(cell) !== '').length;

/** Two rows holding the same text cell for cell. */
function sameCells(a: Cell[] | undefined, b: Cell[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (cellText(x[i] ?? null) !== cellText(y[i] ?? null)) return false;
  return true;
}

/** How many columns a header maps besides the name — best-of-ten's measure. */
const mappedBeside = (c: ColumnMap): number =>
  [c.tnved, c.quantity, c.unit, c.volume, c.weight, c.amount].filter((i) => i !== null).length +
  (c.gross !== null && c.gross !== c.weight ? 1 : 0) +
  (c.cartons ? 1 : 0);

/** Every column key, for «is this cell a header word or a value». */
const COLUMN_KEYS = [
  ...NAME_KEYS, ...PRODUCT_KEYS, ...TNVED_KEYS, ...QTY_KEYS, ...UNIT_KEYS, ...WEIGHT_KEYS, ...NET_WEIGHT_KEYS,
  ...VOLUME_KEYS, ...AMOUNT_TOTAL_KEYS, ...AMOUNT_PRICE_KEYS,
];
/**
 * A header cell that names a column — any key, a field's name, an attribute
 * or a party — as against a VALUE («Ayollar kurtkasi»).
 */
const keyish = (text: string): boolean =>
  fieldLabel(text) !== null ||
  matchKey(text, COLUMN_KEYS) ||
  namesWeight(text) ||
  namesVolume(text) ||
  [MONEY_HEADER, PACKAGE_COUNT, GROSS_HEADER, VOLUME_WORD, WEIGHT_ABBREV, KG_WORD, NET_WORD, NAME_ATTRIBUTE, NAME_PARTY].some((re) => re.test(text));

/** Row `r` as a header candidate (`findHeader`'s order, steps a-f). */
function headerAt(
  rows: Cell[][],
  r: number,
  covered: Covered | null,
  deep: boolean,
): { detected: Detected; score: number } | 'refused' | null {
  const raw = rows[r] ?? [];
  const own = (i: number) => !covered?.has(r, i);
  // (§5.1 a) Below the top rows a header carries no figure: «Sports goods
  // bag | 50 | 40» at row 11 of a header-less list is data, and taken as the
  // header it lost every line above it (xlsx1-02's verifier, c2602-c2607). A
  // one-cell line that deep names no figure column either. (§5.7 (1) below
  // says the same of any row the ladder can name; asked here first, a deep
  // data row of a 5,000-line list is never mapped at all — unless the row
  // names the goods by the field's own word, as a size run's header does.)
  const namesField = raw.some((cell, i) => own(i) && fieldLabel(cell) === 'name');
  if (deep && (filled(raw) < 2 || (!namesField && raw.some((cell, i) => own(i) && readsAsFigure(cell))))) return null;
  // A two-row header is read as one (CRITIC-1); a one-row header is itself.
  const header = composedHeader(rows, r, covered);
    // A title row is one merged cell («COMMERCIAL INVOICE / Товарная
    // накладная»): it names «товар» and is no header. A header has columns —
    // when the table under it HAS columns: a one-column list keeps its
    // one-cell header («Наименование товара» over Стол / Стул), or the header
    // became the first product (the review).
    if (filled(header) < 2) {
      const below = rows.slice(r + 1, r + 1 + SAMPLE_ROWS);
      if (below.some((row) => filled(row) > 1)) return null;
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
      if (most(carriesFigure)) return 'refused';
      // A numbered TITLE («Заявка от 15.10.2026», «Заказ № 15») over a list
      // of names is passed over, not a refusal: the real one-cell header may
      // stand on the next row (S-r2 ND1 — stopping here made «Наименование»
      // over Труба ППР 32 / Кран 1/2 / Муфта 25 a text sheet, and the VED
      // paste landed the title and the header as items).
      if (header.some(hasDigit) && most(hasDigit)) return null;
      // …and a one-cell line is a header only when it READS as one (§5.7
      // (2)): a heading made of list words, one announcing the lines under it
      // («Товары:»), or a document's title — never because a name key is
      // somewhere inside it. «Товары для дома» among a list of names was
      // taken as the header, and every name above it was lost with it
      // (unmapped-product-name-as-header, Q4). All 23 one-cell headers the
      // corpus finds pass: 22 headings, and c0169's «Invoice for goods No 12»
      // a title. «Хозтовары» does not, and lands as a line (c2678).
      const line = cellText(header.find((cell) => cellText(cell) !== '') ?? null);
      if (!listHeadingLine(line) && !TITLE_LINE.test(line)) return null;
    }
  const first = mapColumns(rows, r, header, NO_ROWS, covered);
  if (first === null) return null;
  // (§5.12) A row under the header that is the header again in its second
  // language — «No. | Description | HS Code | Qty | G.W. | CBM» under «序号 |
  // 品名 | 海关编码 | 数量 | 毛重 | 体积», directly or repeated at a page break —
  // is no data: its words were sampled as the columns' cells, so the one-good
  // file's code column read «not mostly codes» and the supplier's TNVED was
  // dropped. Mapped again without it.
  const repeats = new Set<number>();
  for (let d = r + 1; d < Math.min(rows.length, r + 1 + SAMPLE_ROWS); d++) {
    if (repeatsHeader(rows[d]!, d, first, covered)) repeats.add(d);
  }
  const columns = repeats.size > 0 ? mapColumns(rows, r, header, repeats, covered) : first;
  if (columns === null) return null;
  // (§5.7 (1)) A header never carries a figure: a data row whose name holds a
  // goods word («Товары для дома | 100 | 50», «塑料产品», «Plastik
  // mahsulotlar») was taken as the header — every row above it, the row
  // itself and every figure column lost, and the sheet never reached the
  // model. ANY non-name cell, or a «шт» unit column lets it through (V4).
  // But a header whose NAME cell is the field's own word is a header, figures
  // and all: a garment or shoe order heads its size run with the sizes
  // («Наименование | Цвет | 38 | 40 | 42 | Всего», «款号 | 品名 | 颜色 | 90 | 100
  // | 110»), and refused it lost every figure on every door (the fix round's
  // reader-a-break-size-grid-header). «Товары для дома», «塑料产品», «Plastik
  // mahsulotlar», «Куртка» are no field's word, so Q1-Q4 and V1-V9 stay data.
  if (
    filled(header) >= 2 &&
    fieldLabel(raw[columns.name] ?? null) !== 'name' &&
    raw.some((cell, i) => i !== columns.name && own(i) && readsAsFigure(cell))
  )
    return null;
  // (§5.6 (a)) A label|value card's first line is no header: in «Tovar nomi:
  // | Ayollar kurtkasi» the other cell is a VALUE, not a key, and the column
  // under it holds the card's figures and codes (300, 150, 6202930000).
  // «Товар | Цвет» over «Куртка | чёрный» and «Наименование | Примечание»
  // over «300 шт» name their columns (c2621, c2622) — and so does a column
  // the map CLAIMED, or one headed by a unit: «Наименование | Шт», «品名 | 个»
  // over counts are a list, never a card (the fix round's
  // reader-a-break-twocol-value-refusal).
  const others = raw.flatMap((cell, i) => (i !== columns.name && own(i) && cellText(cell) !== '' ? [i] : []));
  const claimed = [columns.tnved, columns.quantity, columns.unit, columns.volume, columns.weight, columns.gross, columns.amount];
  const valueCell = (i: number) => {
    const text = cellText(raw[i] ?? null);
    return !claimed.includes(i) && !keyish(text) && headerUnitWord(text) === null;
  };
  if (others.length === 1 && valueCell(others[0]!)) {
    const under = columnCells(rows, r, others[0]!, repeats);
    const figures = under.filter((cell) => readsAsFigure(cell) || isCodeCell(cell) || carriesFigure(cell)).length;
    if (under.length > 0 && figures * 2 > under.length) return null;
  }
  // (§5.1 b) …and a header found that deep must name a figure column, not
  // just the name: «Consignee name: | GSR LOGISTICS» inside a long title
  // block is no table (c2637). Nor is a TOTALS line: «Всего наименований |
  // Количество мест | Вес брутто» names figure columns over the shipment's
  // sums, and is no goods header however deep.
  if (deep && [columns.quantity, columns.weight, columns.volume, columns.amount, columns.gross].every((i) => i === null)) return null;
  if (deep && mentionsTotal(cellText(raw[columns.name] ?? null))) return null;
  return { detected: { headerRow: r, dataFrom: repeats.has(r + 1) ? r + 2 : r + 1, columns }, score: mappedBeside(columns) };
}

/**
 * The columns a header row maps — its TNVED, its name, its figures — with
 * `skip` rows left out of the sampling that judges a column by its data.
 * Null when no column names the goods.
 */
function mapColumns(rows: Cell[][], r: number, header: Cell[], skip: ReadonlySet<number>, covered: Covered | null): ColumnMap | null {
  const taken = new Set<number>();
  // Each column's sample is read once: every rung, guard and claim below
  // judges a column by it, and a 30,000-character cell (c0425) was lower-cased
  // again for every question asked of its column.
  const samples = new Map<number, Cell[]>();
  const sampled = (i: number): Cell[] => {
    let cells = samples.get(i);
    if (cells === undefined) samples.set(i, (cells = columnCells(rows, r, i, skip)));
    return cells;
  };
  const mostlyCodes = (i: number) => {
    const cells = sampled(i);
    return cells.length === 0 || cells.filter(isCodeCell).length * 2 > cells.length;
  };
  const allCodes = (i: number) => {
    const cells = sampled(i);
    return cells.length > 0 && cells.every(isCodeCell);
  };
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
  const wordy = (i: number) => {
    const cells = sampled(i);
    return cells.length > 0 && cells.filter(isWordCell).length * 2 > cells.length;
  };
  const stated = (i: number) => sampled(i).length > 0 && !allCodes(i);
  // (§5.6 (b), §5.8) A column whose own data are field LABELS names no goods
  // on any rung: «Soni:», «Вес нетто», «HS code» under a card's «Tovar
  // nomi»; «Address:», «Tel:», «Buyer:» under a letterhead's «Company Name».
  // The labels landed as the goods and the good's own name, beside the
  // header, was lost — and the model was shown the labels as goods already
  // taken (xlsx1-07, unmapped-vertical-card).
  // But a GOOD named like a label is a good: «Karobka | 500 | 100», «Carton |
  // 500 | 100» under «Tovar nomi | Soni | Vazni» are boxes sold by the piece,
  // their count standing in the header's own count column — where a card's
  // value stands under the card's first VALUE, which names no figure (the
  // fix round's reader-a-break-goods-named-like-labels).
  const figureHeads = header.flatMap((cell, j) => (FIGURE_FIELDS.has(fieldLabel(cell) ?? 'other') ? [j] : []));
  const labels = (i: number) => {
    const own = cellText(rows[r]?.[i] ?? null).toLowerCase();
    let cells = 0;
    let hits = 0;
    for (let d = r + 1; d < Math.min(rows.length, r + 1 + SAMPLE_ROWS); d++) {
      const cell = skip.has(d) ? null : (rows[d]![i] ?? null);
      if (cellText(cell) === '' || isHeaderText(cell, own)) continue;
      cells += 1;
      if (otherLabel(cell) && !figureHeads.some((j) => j !== i && readsAsFigure(rows[d]![j] ?? null))) hits += 1;
    }
    return cells > 0 && hits * 2 > cells;
  };
  // (§5.3) A running serial — 1, 2, 3 … under «ITEM» — or, under a header
  // that names the goods by «item» alone, article numbers («LJ-2023»), is no
  // name while a wordier column stands beside it: every product was called
  // «1» … «12» (xlsxN-06), and the sheet then goes to the model whole
  // (c2652-c2655). The serial is read past a TOTAL row in the same column.
  // The wordier column is one that could hold the goods — never a party's
  // or an attribute's: beside «Customer name» the item numbers are all the
  // file names its lines by (c1782). Alone, either stays the name:
  // «Наименование» over 1, 2, 3 is all the file says (c2617, c2618).
  // Article numbers under any other name header
  // ARE the product — «Product Name» over RTX-4090 / GTX-1660 beside a
  // «Brand name» column (the fourth review, c2615) — so the article half is
  // scoped to «item».
  const serial = (i: number) => {
    const cells = sampled(i).map(cellText).filter((text) => !mentionsTotal(text));
    return cells.length > 1 && cells.every((text, at) => /^\d+\.?$/.test(text) && Number.parseInt(text, 10) === at + 1);
  };
  const itemOnly = (i: number) => !matchKey(cellText(header[i]!), NAME_KEYS_FIRST);
  const articles = (i: number) => {
    const cells = sampled(i);
    return cells.length > 0 && cells.every((cell) => isArticleNumber(cellText(cell)));
  };
  const party = (i: number) => NAME_PARTY.test(cellText(header[i]!).split(/[(,;]/)[0] ?? '');
  // …nor a column that DESCRIBES the goods — their colour, material, size,
  // packing or a remark: beside «Color», «Material», «Packing» the article
  // numbers under «Item No.» are the products, and the commonest Chinese
  // clothing PI («Item No. | Color | Qty | Unit Price | Amount») lost its
  // header to the colour column (the fix round's
  // reader-a-break-item-color-not-goods).
  const describes = (j: number) => {
    const text = cellText(header[j] ?? null);
    const first = text.split(/[(,;]/)[0] ?? '';
    return party(j) || NAME_ATTRIBUTE.test(first) || NAME_DETAIL.test(first) || fieldLabel(text) === 'other';
  };
  const goodsBeside = (i: number) => header.some((_, j) => j !== i && wordy(j) && !describes(j));
  const named = (i: number) => !((serial(i) || (itemOnly(i) && articles(i))) && goodsBeside(i));
  // One ladder, the header's rank before the data's: a header that names
  // the PRODUCT alone (`namesTheProduct`, which outranks a description)
  // over words — first by a name key, then by a product word no key holds
  // («Product», «Commodity», «Номенклатура», §5.2) — then one that names the
  // GOODS (never a code, a brand or a party — S5 — unless it only mentions
  // one beside the name, `namesTheGoods`) over words, then over any data,
  // then any name key at all — never a party's («Customer name:»,
  // «Consignee name:», §5.8) — and last «Наим.» / «Yuk turi». The fourth
  // review found the round-3 tiers' «any header over words» rung naming
  // RTX-4090 / GTX-1660 by the «Brand name» column beside them: a model
  // number is not a word, but it is the product.
  const head = (i: number) => cellText(header[i]!);
  const goods = (i: number) => namesTheGoods(head(i));
  const name =
    findColumn(header, NAME_KEYS_FIRST, taken, (i) => namesTheProduct(head(i)) && wordy(i)) ??
    findColumn(header, PRODUCT_KEYS, taken, (i) => namesTheProduct(head(i)) && wordy(i)) ??
    findColumn(header, NAME_KEYS_FIRST, taken, (i) => goods(i) && wordy(i)) ??
    findColumn(header, NAME_KEYS, taken, (i) => goods(i) && wordy(i)) ??
    findColumn(header, NAME_KEYS_FIRST, taken, (i) => goods(i) && stated(i) && named(i)) ??
    findColumn(header, NAME_KEYS, taken, (i) => goods(i) && stated(i) && named(i)) ??
    findColumn(header, NAME_KEYS, taken, (i) => !allCodes(i) && named(i) && !party(i)) ??
    findColumn(header, LAST_NAME_KEYS, taken, (i) => lastNames(head(i)) && wordy(i));
  if (name === null) return null;
  // (§5.6 (b)) …and the column the ladder chose holding LABELS refuses the
  // whole row as a header, never only the column: passed over, the climb
  // went on and named the goods by the card's VALUE column whenever its
  // first value held a name word — «Tovar nomi | Plastik mahsulotlar», «…
  // | Товары для дома», «… | Kitchen goods set» — numbers became products and
  // the first good's name was lost, with nothing shown to the model (the fix
  // round's reader-a-spec-56b-column-exclusion-not-refusal).
  if (labels(name)) return null;
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
  // (X2) The column the row's PACKING takes its carton count from. `cartonCol`
  // above is what it was — the quantity of a sheet that counts nothing else,
  // and the packing-list flag — and its words decide the sheet's SHAPE, which
  // this round does not move; `packCol` is found by X2's one vocabulary.
  let packCol: { index: number; word: string } | null = null;
  // …and the count headers the ranking passes over as ONE package's (FILES-1):
  // «PCS/CTN», «每箱数量», «Кол-во в коробке» — what one carton holds.
  const packedCounts: number[] = [];
  let alsoCounts: { index: number; header: string }[] = [];
  // The line's count is CHOSEN among the count headers, never the first
  // one standing (§5.10, xlsxN-08): «QTY/CTN | CTN QTY | TOTAL QTY» took «CTN
  // QTY» — 15 «dona» for 300 jackets — and «TOTAL QTY» was passed over.
  const counts: { i: number; text: string; unit: ReturnType<typeof unitOf>; word: string | null }[] = [];
  for (let i = 0; i < header.length; i++) {
    const text = cellText(header[i]!);
    // A header that counts by its own LAST unit word is a count too (§5.11,
    // xlsxN-09's verifier): «Всего шт», «Итого (шт.)», «Total pieces», «Jami,
    // ta» name no quantity key, and the 300 pieces were lost beside «Кол-во
    // коробок». Never money («Цена, шт», «Цена за шт»), never the UNIT column
    // («Ед.» — the kernel reads «ед» as a piece), and never a weight or a
    // volume OF a piece («Вес 1 шт», «Объём 1 шт» — whose «кг» / «м3» the
    // unit word already refuses when it is written).
    const pieces =
      unitOf(headerUnitWord(text)) === 'dona' &&
      !MONEY_HEADER.test(text) &&
      !matchKey(text, UNIT_KEYS) &&
      !namesWeight(text) &&
      !namesVolume(text);
    if (taken.has(i) || !(namesCount(text) || pieces)) continue;
    // One package's count is nobody's count (FILES-1): passed over, so the
    // line's own total count column is the line's.
    if (PER_PACKAGE_COUNT.test(text)) {
      packedCounts.push(i);
      continue;
    }
    const word = headerUnitWord(text);
    const unit = unitOf(word);
    if (unit === 'kg') weightFromQty ??= i;
    else if (unit === 'm3') volumeFromQty ??= i;
    else if (unit === 'karobka') {
      cartonCol ??= { index: i, word: word! };
      packCol ??= cartonCol;
    } else {
      counts.push({ i, text, unit, word });
      continue;
    }
    taken.add(i);
  }
  // The ranking (§5.10, xlsxN-08's betterFix): (a) a TOTAL — «TOTAL QTY»,
  // «总数量»; (b) a PIECE unit word — «Кол-во, шт», «QTY (PCS)»; (c) no
  // package word; (d) the leftmost. So «QTY/CTN | CTN QTY | TOTAL QTY» is
  // TOTAL QTY, «件数 | 数量» is 数量, and a lone «件数» or «总件数» is still the
  // pieces. A header that names a package counts PACKAGES, and its total word
  // or its «шт» is theirs: «Кол-во мест, шт», «Karobka soni, ta», «Всего
  // мест», «TOTAL CTN QTY» ranked by (a) or (b) became the line's count, 15
  // «dona» for 300 jackets, beside a plain «Кол-во» (review break-qty-rank) —
  // so (a) and (b) are asked of a header naming no package only. A header
  // naming money or a measure ranks below every other (kept beside the
  // betterFix, recorded): the count by its unit would otherwise put
  // «Price/pcs» and «Weight/pcs» above «Qty» (both are quantity keys by their
  // «pcs»). A count in ANOTHER unit — «Кол-во, м2», «Кол-во, пар» — is no
  // piece unit: beside «Кол-во, шт» the pieces are the line's count (review
  // spec-510-unit-rank), and the measure it passed over is said on the line's
  // note (`alsoCounts`), never lost.
  const rank = (c: (typeof counts)[number]) => {
    const packages = namesPackage(c.text);
    return [
      MONEY_HEADER.test(c.text) || namesWeight(c.text) || namesVolume(c.text) ? 1 : 0,
      !packages && (COUNT_TOTAL.test(c.text) || COUNT_TOTAL_HAN.test(c.text)) ? 0 : 1,
      !packages && c.unit === 'dona' ? 0 : 1,
      packages ? 1 : 0,
      c.i,
    ];
  };
  const byRank = [...counts].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    const k = x.findIndex((v, j) => v !== y[j]);
    return k < 0 ? 0 : x[k]! - y[k]!;
  });
  const chosen = byRank[0];
  // (X2, XLS-9) A package header is never the PIECE column: the count the
  // ranking chose counts packages when its header says so — by the rank's own
  // vocabulary (`countsPackages`), whatever stands beside it. «Karobka soni»,
  // «Joy soni», «Кол-во мест, шт» alone landed ten cartons as ten pieces; so
  // did «CTN QTY» beside a «Price/pcs», which ranks below every count.
  const packageCount = (c: (typeof counts)[number]) =>
    (c.unit === null || c.unit === 'dona') && c.text.length <= PACK_HEADER_MAX && countsPackages(c.text);
  if (chosen && packageCount(chosen)) {
    // A LONE «CTN QTY» counts cartons: the door's carton rule sends it to the
    // note, never into pieces. Never by «件数» / «总件数»: alone, that is the
    // pieces (c1778, c2453).
    const latin = chosen.unit === null && LATIN_PACKAGE.test(chosen.text);
    if (counts.length === 1 && latin) cartonCol ??= { index: chosen.i, word: 'ctn' };
    packCol ??= { index: chosen.i, word: counts.length === 1 && latin ? 'ctn' : cartonWordOf(chosen.text) };
    taken.add(chosen.i);
  } else if (chosen) {
    quantity = chosen.i;
    quantityUnit = chosen.unit === 'dona' || chosen.unit === null ? null : chosen.word;
    taken.add(chosen.i);
    // …and a count passed over that names a package in a Latin or Cyrillic
    // word is the packing list's carton column, said as one («ctn»).
    const packages = byRank.slice(1).find((c) => c.unit === null && LATIN_PACKAGE.test(c.text));
    if (packages) cartonCol ??= { index: packages.i, word: 'ctn' };
    // (X2) …and by ANY package word it is where the row's packing reads its
    // cartons — or, beside a piece column, by «件数»: on «数量 | 件数» the 件
    // are the packages.
    const pieces = (chosen.unit === null || chosen.unit === 'dona') && !JIANSHU.test(chosen.text);
    const packed = byRank.slice(1).find(packageCount) ?? (pieces ? byRank.slice(1).find((c) => c.unit === null && JIANSHU.test(c.text)) : undefined);
    if (packed) packCol ??= { index: packed.i, word: cartonWordOf(packed.text) };
    // …and one passed over that counts in ANOTHER unit («Кол-во, м2» beside
    // «Кол-во, шт») is the line's measure: said on its note, never lost.
    alsoCounts = byRank
      .slice(1)
      .filter((c) => c.unit !== null && c.unit !== 'dona' && !namesPackage(c.text) && !MONEY_HEADER.test(c.text))
      .filter((c) => !namesWeight(c.text) && !namesVolume(c.text))
      .map((c) => ({ index: c.i, header: clipUnits(c.text, 30) }));
  }
  if (quantity === null && (cartonCol ?? packCol)) {
    // Only cartons: their number goes where a carton count goes — through
    // the door's rule into the note, never into the piece column. (The calc
    // door reads it off the row's packing instead; the doors that keep no
    // packing — the deal's import, the VED's paste — read it here.)
    const only = (cartonCol ?? packCol)!;
    quantity = only.index;
    quantityUnit = only.word;
    packCol = only;
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
  // ONE carton's volume is not the line's (his 2.7 b, probe P1: a
  // «CBM/CTN» standing before «TOTAL CBM» on a Chinese packing list was
  // read as the line and landed 14× short — the weight's PER_PACKAGE rule,
  // which the volume never learned). The same test on the abbreviation
  // rung: «MEAS./CTN» is one carton's too.
  //
  // …and a header's OWN unit decides what its figures are (X6, review JN-13):
  // a column in cubic metres — or naming no unit — is taken before one in
  // cm³, dm³ or litres whichever stands first («Volume (cm3) | CBM»: the CBM
  // is the line's), a foreign-unit column is CONVERTED when it is all the
  // sheet has, and one in a unit nobody converts is no volume at all: its
  // figure goes on the line's note (`alsoCounts`) and the cube is asked.
  //
  // A header naming a WEIGHT in a volume's words — «Объёмный вес, кг»,
  // «Volume weight», a density «кг/м3» — is nobody's column (JN-13): taken out
  // before the volume and the weight are chosen (as the heaviest plain weight
  // column it became the line's kilos), and said on the note.
  const volumetric = header.flatMap((cell, i) => {
    const text = cellText(cell);
    return !taken.has(i) && volumetricWeight(text) ? [{ index: i, header: clipUnits(text, 30) }] : [];
  });
  for (const c of volumetric) taken.add(c.index);
  // (X3; XLS-5, DIM-6) A SIZE — one cell («60*40*50») or an L | W | H triplet
  // — is found before the volume is chosen: «MEAS.» whose cells are sizes is a
  // size column, never a cube (its cells read «hajm «60*40*50» — aniq emas»
  // and the cartons beside them multiplied nothing). By its header AND its
  // cells: «Size» is as often S / M / L or a tile's «600x600», and only three
  // sides are a package. The reader copies it into the row's packing with the
  // unit the header names and WHOSE size the header says it is (review JN-11);
  // the kernel multiplies — a package's size only.
  // …judged over the DATA: under a two-row header the row below is the split
  // («L | W | H», «PER CTN | TOTAL»), and its words are no cell of the column
  // — on a one-line sheet they were half of it, and the size was not found.
  const split = header === rows[r] ? null : r + 1;
  const mostly = (i: number, test: (cell: Cell) => boolean) => {
    const cells = split === null ? sampled(i) : columnCells(rows, r, i, new Set([...skip, split]));
    return cells.length > 0 && cells.filter(test).length * 2 > cells.length;
  };
  /** The header as the packing's tests read it: one past `PACK_HEADER_MAX` names nothing of theirs. */
  const packHead = (i: number): string => {
    const text = head(i);
    return text.length > PACK_HEADER_MAX ? '' : text;
  };
  const sidesAt = new Map<Side, { i: number; lead: string }>();
  header.forEach((_, i) => {
    const side = taken.has(i) ? null : dimensionOf(packHead(i));
    if (side && !sidesAt.has(side.side) && mostly(i, (cell) => parseNumber(cell) !== null || SIDE_CELL.test(cellText(cell)))) {
      sidesAt.set(side.side, { i, lead: side.lead });
    }
  });
  let size: PackColumns['size'] = null;
  const [sideL, sideW, sideH] = [sidesAt.get('l'), sidesAt.get('w'), sidesAt.get('h')];
  if (sideL && sideW && sideH) {
    const three = [sideL, sideW, sideH];
    size = {
      cols: [sideL.i, sideW.i, sideH.i],
      unit: three.map((side) => sizeUnitOfHeader(head(side.i))).find((unit) => unit !== null) ?? null,
      of: three.map((side) => sizeOwnerOf(side.lead)).find((owner) => owner !== null) ?? null,
    };
  } else {
    const at = findWhere(
      header,
      taken,
      (text, i) => text.length <= PACK_HEADER_MAX && namesSize(text) && mostly(i, (cell) => typeof cell === 'string' && parseSize(cell)?.size != null),
    );
    if (at !== null) size = { cols: [at], unit: sizeUnitOfHeader(head(at)), of: sizeOwnerOf(head(at)) };
  }
  if (size) for (const i of size.cols) taken.add(i);
  let volumeDivisorOf = 1;
  const volumeHeads = (keyed: boolean): { i: number; divisor: number | null }[] =>
    header.flatMap((cell, i) => {
      const text = cellText(cell);
      const named = keyed ? namesVolume(text) : VOLUME_WORD.test(text) && !namesVolume(text);
      if (taken.has(i) || !named || PER_PACKAGE.test(text) || volumetricWeight(text)) return [];
      return [{ i, divisor: volumeDivisor(text, keyed) }];
    });
  const volumeCandidates = volumeFromQty === null ? [...volumeHeads(true), ...volumeHeads(false)] : [];
  const volumeHead = volumeCandidates.find((c) => c.divisor === 1) ?? volumeCandidates.find((c) => c.divisor !== null) ?? null;
  if (volumeHead) {
    taken.add(volumeHead.i);
    volumeDivisorOf = volumeHead.divisor!;
  }
  const volume = volumeFromQty ?? volumeHead?.i ?? null;
  // A KEYED header in a unit nobody converts («Volume (ft3)», «CBM (cm)»)
  // used to land as cubic metres: it is said, where the abbreviation rung's
  // own refusals («MEAS (CM)», «Vol (L)») stay unsaid, as they always were.
  const unreadVolumes = volumeHeads(true)
    .filter((c) => c.divisor === null)
    .map((c) => ({ index: c.i, header: clipUnits(cellText(header[c.i]!), 30) }));
  for (const c of unreadVolumes) taken.add(c.index);
  const invoiced = invoiceHeader(header.map(cellText));
  const moneyTotal = (text: string) => invoiced && namesMoneyTotal(text);
  // What a weight column's figures add up to, over the data rows (a merged
  // position is its master's, counted once).
  // Read once per column, and never a cell longer than any figure is
  // (`readsAsFigure`'s 64): best-of-ten maps every candidate, and a row of a
  // hundred «… Вес …» cells over 2,000 rows asked this of 99 columns each a
  // whole sheet long — 7 s of parsing 30,000-character cells as numbers (the
  // fix round's reader-a-break-candidate-cost). It only ranks columns; the
  // figures themselves are read by the rows.
  const kgOf = new Map<number, number>();
  const columnKg = (i: number): number => {
    const known = kgOf.get(i);
    if (known !== undefined) return known;
    let sum = 0;
    for (let d = r + 1; d < rows.length; d++) {
      const cell = rows[d]![i] ?? null;
      if (covered?.has(d, i) || (typeof cell === 'string' && cell.length > 64)) continue;
      const value = parseMeasure(cell, 'kg');
      if (value !== null && value > 0) sum += value;
    }
    kgOf.set(i, sum);
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
    (namesNet(text) || (NET_WORD.test(text) && (WEIGHT_WORD.test(text) || grossBeside)));
  const netWeight = weightFromQty === null ? lineWeight(isNetWeight) : null;
  const weight =
    weightFromQty ?? netWeight ?? lineWeight((text) => namesWeight(text) || WEIGHT_ABBREV.test(text));
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
        namesWeight(text) ||
        WEIGHT_ABBREV.test(text) ||
        isNetWeight(text) ||
        namesVolume(text) ||
        VOLUME_WORD.test(text) ||
        namesCount(text) ||
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
  // (X2; XLS-4, XLS-9, DIM-7) What the header states PER PACKAGE, read LAST:
  // every column a line figure could claim has been claimed, so the packing
  // takes only what was nobody's — the columns passed over as one carton's
  // («CBM/CTN», «G.W./CTN», «PCS/CTN»), and the carton count itself.
  const perCarton = (i: number) => {
    const text = packHead(i);
    return !taken.has(i) && PER_CARTON.test(text) && !MONEY_HEADER.test(text) && !moneyTotal(text) && !volumetricWeight(text);
  };
  const cubic = (text: string) => namesVolume(text) || VOLUME_WORD.test(text);
  // One carton's cube, in the unit its header names (X6): a unit nobody
  // converts leaves the column unread, as it does the line's.
  const cartonCube =
    header.flatMap((_, i) => {
      const text = head(i);
      const divisor = perCarton(i) && cubic(text) ? volumeDivisor(text, namesVolume(text)) : null;
      return divisor === null ? [] : [{ index: i, divisor }];
    })[0] ?? null;
  // One carton's weight. A line's weight is NETTO, so with both on the sheet
  // the net column is the packing's. The gross one beside it is said on the
  // row's note (a packing holds one weight) — where the sheet states the
  // line's gross in no column of its own; beside a «TOTAL G.W.» it is noise.
  const cartonWeights = header.flatMap((_, i) => {
    const text = head(i);
    if (!perCarton(i) || cubic(text) || !(namesWeight(text) || WEIGHT_ABBREV.test(text) || isNetWeight(text) || KG_WORD.test(text))) return [];
    return [{ index: i, kind: isNetWeight(text) ? ('net' as const) : GROSS_HEADER.test(text) ? ('gross' as const) : null }];
  });
  const cartonWeight = cartonWeights.find((c) => c.kind === 'net') ?? cartonWeights.find((c) => c.kind === 'gross') ?? cartonWeights[0] ?? null;
  const cartonGrossBeside =
    cartonWeight?.kind === 'net' && gross === null
      ? cartonWeights.filter((c) => c.kind === 'gross').map((c) => ({ index: c.index, header: clipUnits(head(c.index), 30) }))
      : [];
  for (const c of cartonWeights) taken.add(c.index);
  if (cartonCube) taken.add(cartonCube.index);
  // What one carton HOLDS: a count header passed over as one package's, or a
  // unit before its package («PRS/CTN», «пар/кор», «m²/ctn») and «装箱数»,
  // which no quantity key names. The leftmost; its unit is the header's own.
  const holdsCount = (i: number) => {
    const text = packHead(i);
    if (text === '' || taken.has(i) || MONEY_HEADER.test(text)) return false;
    if (packedCounts.includes(i) || PACKED_COUNT_HAN.test(text)) return true;
    const led = UNIT_PER_CARTON.exec(text)?.[1] ?? null;
    return led !== null && (led === '件' || ['dona', 'juft', 'm2', 'litr'].includes(unitOf(led) ?? ''));
  };
  const cartonPiecesAt = header.findIndex((_, i) => holdsCount(i));
  const cartonPieces = cartonPiecesAt < 0 ? null : { index: cartonPiecesAt, unit: perCartonUnitOf(head(cartonPiecesAt)) };
  if (cartonPieces) taken.add(cartonPieces.index);
  // The carton COUNT: the column the count ranking found (while nothing since
  // has claimed it), else a bare package header whose cells are counts — a
  // «Packages» column of «CARTON» / «PALLET» says how the goods are packed.
  const bare = (text: string) =>
    BARE_PACKAGES.test(text) &&
    (NUMBER_OF.test(text) || !NUMBER_LABEL.test(text)) &&
    !PER_PACKAGE.test(text) &&
    !PER_PACKAGE_COUNT.test(text) &&
    !MONEY_HEADER.test(text) &&
    !namesWeight(text) &&
    !WEIGHT_ABBREV.test(text) &&
    !cubic(text) &&
    !namesSize(text);
  const cartonsAt =
    (packCol && (packCol.index === quantity || !taken.has(packCol.index)) ? packCol.index : null) ??
    findWhere(header, taken, (text, i) => text.length <= PACK_HEADER_MAX && bare(text) && mostly(i, (cell) => parseMeasure(cell, 'karobka') !== null));
  return {
    name,
    tnved,
    quantity,
    quantityUnit,
    unit,
    volume,
    volumeDivisor: volumeDivisorOf,
    weight,
    amount,
    amountIsPrice,
    // A claim made after the count may have taken one (a unit column); then
    // it is that column's, said there.
    alsoCounts: [
      ...alsoCounts.filter((c) => !taken.has(c.index)),
      ...(volumeHead && volumeHead.divisor !== 1 ? [{ index: volumeHead.i, header: clipUnits(cellText(header[volumeHead.i]!), 30) }] : []),
      ...unreadVolumes,
      ...volumetric,
      ...cartonGrossBeside,
    ],
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
    // A sheet with no line-weight column whose rows are weighed by their
    // cartons («CTNS» × «N.W./CTN») has its line weights from THAT column, and
    // of its kind: a netto the next file's rows may be compared with and take,
    // a brutto they may not (`file-goods.ts`).
    weightKind: weight === null && cartonWeight && cartonsAt !== null ? (cartonWeight.kind ?? 'plain') : weightKind,
    pack: { cartons: cartonsAt, pieces: cartonPieces, weight: cartonWeight, volume: cartonCube, size },
  };
}

/**
 * Is this row the header again — in its second language under the header, or
 * repeated at a page break (§5.12, xlsxN-10)? By its CONTENT, at any place
 * under the header, all three:
 *  - no figure in any mapped figure column (a goods row states its figures);
 *  - its name cell is a header phrase: a name key and no figure in it;
 *  - another mapped cell names its OWN column's kind — «Qty» over the
 *    quantity, «G.W.» over the weight, «HS Code» over the TNVED.
 * «Goods trolley | pcs | 5» is a good: its count is a figure, and «pcs» is
 * no unit KEY (c2632). The unit column's own key is «Unit» / «Ед. изм.».
 * SUB_HEADER_WORDS stays what it is: a second language is not a PER CTN /
 * TOTAL split, and composing it would map nothing the first row did not.
 */
function repeatsHeader(row: Cell[], d: number, columns: ColumnMap, covered: Covered | null): boolean {
  const at = (i: number | null): Cell => (i === null ? null : (row[i] ?? null));
  const figure = (i: number | null) => i !== null && (readsAsFigure(at(i)) || parseNumber(at(i)) !== null);
  if ([columns.quantity, columns.weight, columns.gross, columns.volume, columns.amount].some(figure)) return false;
  const name = cellText(at(columns.name));
  if (!matchKey(name, NAME_KEYS) || carriesFigure(name) || /\d/.test(name)) return false;
  const own: [number | null, (text: string) => boolean][] = [
    [columns.quantity, (text) => namesCount(text)],
    [columns.weight, (text) => namesWeight(text) || namesNet(text) || GROSS_HEADER.test(text) || WEIGHT_ABBREV.test(text)],
    [columns.gross, (text) => GROSS_HEADER.test(text) || namesWeight(text)],
    [columns.volume, (text) => namesVolume(text) || VOLUME_WORD.test(text)],
    [columns.amount, (text) => matchKey(text, AMOUNT_TOTAL_KEYS) || matchKey(text, AMOUNT_PRICE_KEYS) || MONEY_HEADER.test(text)],
    [columns.tnved, (text) => matchKey(text, TNVED_KEYS)],
    [columns.unit, (text) => matchKey(text, UNIT_KEYS)],
  ];
  return own.some(([i, names]) => i !== null && i !== columns.name && !covered?.has(d, i) && names(cellText(at(i))));
}

/** A card's field kinds that land on the good — an attribute or a letterhead line is no card's. */
const CARD_FIELDS = new Set<FieldKind>(['name', 'count', 'unit', 'net', 'weight', 'gross', 'volume', 'tnved', 'price', 'total']);

/**
 * A two-column label|value CARD of ONE good, read deterministically
 * (docs/FAYL-OQISH.md §5.6's extra, reader-5.6-card): «Tovar nomi: | Ayollar
 * kurtkasi / Soni: | 300 / Vazni: | 150 / TNVED: | 6202930000». Only when it
 * is clearly that, all at once:
 *  - exactly two columns hold anything (a unit column, a merged title, a
 *    third cell is no such card);
 *  - every filled row is a known field's label (`fieldLabel`) and its value,
 *    at least two of them, each field once;
 *  - exactly ONE of them names the goods, and its value is no label itself.
 * Anything else that looks like a card — two goods stacked, a client line,
 * spec lines (Model, Material) — is refused as a header inside `findHeader`
 * (§5.6 (a), (b)) and goes to the model whole.
 *
 * The line's weight is a NETTO label's, or a plain weight's («Vazni», «Вес»),
 * as a plain weight column is the line's on a table; a BRUTTO label is the
 * shipment's gross and never the line's netto (the house rule, CalcField).
 * The result carries the name label's row as its header row, so
 * `readGoodsFile` keeps the card's good as the sheet's goods — an INVOICE by
 * shape whatever its weight is called: a card states the good itself, where a
 * packing list's rows restate an invoice's (docs/IKKI-ESHIK.md §1.2.1).
 */
function cardGood(rows: Cell[][], covered: Covered | null): ({ goods: GoodsRow[]; headerRow: number } & SheetShape) | null {
  const cols = new Set<number>();
  const lines: { r: number; cells: Cell[] }[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const at = row.flatMap((cell, i) => (cellText(cell) !== '' && !covered?.has(r, i) ? [i] : []));
    if (at.length === 0) continue;
    for (const i of at) cols.add(i);
    if (cols.size > 2) return null;
    lines.push({ r, cells: row });
  }
  if (cols.size !== 2 || lines.length < 2) return null;
  const [labelCol, valueCol] = [...cols].sort((a, b) => a - b) as [number, number];
  const fields = new Map<FieldKind, { r: number; value: Cell }>();
  for (const { r, cells } of lines) {
    const kind = fieldLabel(cells[labelCol] ?? null);
    if (kind === null || !CARD_FIELDS.has(kind) || fields.has(kind)) return null;
    fields.set(kind, { r, value: cells[valueCol] ?? null });
  }
  const named = fields.get('name');
  const description = cellText(named?.value ?? null);
  if (!named || description === '' || labelCell(named.value)) return null;
  const value = (kind: FieldKind) => fields.get(kind)?.value ?? null;
  const code = normalizeTnved(value('tnved'));
  const tnvedText = cellText(value('tnved'));
  const read = (kind: FieldKind, unit: 'dona' | 'kg' | 'm3') => parseMeasure(value(kind), unit);
  const weightKg = read('net', 'kg') ?? read('weight', 'kg');
  const grossKg = read('gross', 'kg');
  const volumeM3 = read('volume', 'm3');
  const unread = (['count', 'net', 'weight', 'gross', 'volume', 'price', 'total'] as const)
    .filter((kind) => /\d/.test(cellText(value(kind))) && (kind === 'price' || kind === 'total' ? parseNumber(value(kind)) : read(kind, kind === 'count' ? 'dona' : kind === 'volume' ? 'm3' : 'kg')) === null)
    .map((kind) => `${cellText(lines.find((l) => l.r === fields.get(kind)!.r)!.cells[labelCol] ?? null).slice(0, 40)} «${cellText(value(kind)).slice(0, 40)}» — aniq emas`);
  const good: GoodsRow = {
    description: clipUnits(description, 300),
    quantity: read('count', 'dona'),
    unit: cellText(value('unit')).slice(0, 20) || null,
    weightKg,
    volumeM3,
    amount: parseNumber(value('total')) ?? parseNumber(value('price')),
    tnvedCode: code && 'code' in code ? code.code : null,
    note:
      [
        tnvedText === '' ? null : code && 'problem' in code ? `TNVED «${code.text}» — 9 xonali: boshida 0 tushib qolganmi?` : code === null ? `TNVED «${tnvedText.slice(0, 40)}» — kod emas` : null,
        ...unread,
      ]
        .filter(Boolean)
        .join(' · ') || null,
  };
  const weightKind: WeightKind = value('net') !== null && read('net', 'kg') !== null ? 'net' : weightKg !== null ? 'plain' : null;
  return {
    goods: [good],
    headerRow: named.r,
    shape: 'invoice',
    weightKind,
    grossKg,
    grossColumn: fields.has('gross'),
    volumeM3,
  };
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
  // …and WHAT the list names, as the forwarder's own headers say it: «Наименование
  // продукции / груза / изделия / материала / работ», «Описание груза», «Вид
  // товара», «Yuk nomi», «Tovar turi», «Cargo description» (the fix round's
  // reader-a-break-onecell-heading-too-narrow: each was refused as a heading and
  // landed as product #1).
  'продукции', 'продукта', 'продуктов', 'груза', 'грузов', 'изделия', 'изделий', 'материала', 'материалов', 'работ',
  'услуг', 'вид',
  'tovar', 'tovarlar', 'tovarlarning', 'nomi', 'nomlari', 'mahsulot', 'mahsulotlar', "ro'yxati", "ro'yxat", 'yuk', 'turi',
  'товарлар', 'товарларнинг', 'номи', 'номлари', 'маҳсулот', 'маҳсулотлар', 'махсулот', 'махсулотлар', 'рўйхати', 'рўйхат',
  'юк', 'тури',
  'name', 'names', 'goods', 'list', 'item', 'items', 'product', 'products', 'description', 'of', 'cargo',
]);
/**
 * A joining word INSIDE a heading made of list words — «Наименование и
 * описание товара», «Names and quantities» — and never one that opens or
 * closes it, nor a heading's second word: «Name and address labels» is a
 * product.
 */
const LIST_JOINS = new Set(['и', 'and', 'va', 'ва']);
/** …and in Chinese, which writes them with nothing between: «商品名称», «货物清单», «产品描述», «品名规格». */
const LIST_WORDS_HAN = ['品名', '名称', '货物', '商品', '产品', '清单', '列表', '货品', '明细', '描述', '规格'];

/** A line's words, lower-cased, the Uzbek apostrophe in one spelling. */
const lineWords = (text: string): string[] => text.toLowerCase().replace(/[ʻ‘’`]/g, "'").match(/[\p{L}']+/gu) ?? [];

/** A cell made of nothing but list words — «Наименование товара», «Tovar nomi», «Goods list», «商品名称». */
function listHeading(text: string): boolean {
  const words = lineWords(text);
  if (words.length === 0 || words.length > 4) return false;
  return words.every(
    (word, at) => LIST_WORDS.has(word) || hanListWords(word) || (LIST_JOINS.has(word) && at > 0 && at < words.length - 1),
  );
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

/** A SUBTOTAL's own word — a total row, never the sheet's grand total («подытог», «subtotal», «小计»). */
const SUBTOTAL_WORD = /sub\s*-?\s*total|подытог|小计|小計/iu;

/**
 * The sheet's total rows under the header, in order, with where each stands —
 * a packing list closes with one («TOTAL … 190 … 1.6»), and a sectioned one
 * closes each section with its own (fix review FR-SELL-3). Any cell may carry
 * the label: the «No.» column as often as the name's. A label is a total by
 * the row filter's OWN rule (`totalRowOf`, #513, reader-5.4ab-vocab): so
 * «Umumiy», «Итог», «Общий итог» are read here, and a «TOTAL QUARTZ 9000»
 * oil kept as a good no longer nulls the Σ as the sheet's «grand total».
 */
function totalRows(rows: Cell[][], from: number, covered: Covered | null): { d: number; row: Cell[] }[] {
  const out: { d: number; row: Cell[] }[] = [];
  for (let d = from; d < rows.length; d++) {
    const row = rows[d]!;
    const says = row.some((cell, i) => {
      if (covered?.has(d, i) || typeof cell !== 'string') return false;
      return totalRowOf({ name: cell, figures: true }) === 'total' && !SUBTOTAL_WORD.test(cell);
    });
    if (says) out.push({ d, row });
  }
  return out;
}

/**
 * A total row's figure, with the half of its last printed decimal — what
 * rounding it to that place may move (fix review FR-REGR-4): «0.7» stands
 * for 0.65-0.75, «211» for 210.5-211.5. A text cell whose one separator is
 * followed by exactly three digits («1,650», «1.650») is a thousands figure
 * or a decimal, nobody can say which: it states nothing (the kernel's
 * `readNumberCell` asks that very cell), and so contradicts nothing.
 */
function statedFigure(cell: Cell | undefined, unit: 'kg' | 'm3' | null): { value: number; half: number } | null {
  if (cell === null || cell === undefined) return null;
  const text = typeof cell === 'number' ? String(Number(cell.toPrecision(12))) : cell.trim().replace(/\s+/gu, '');
  if (typeof cell === 'string' && /^[1-9]\d{0,2}[.,]\d{3}(?![\d.,])/u.test(text)) return null;
  const value = unit === null ? parseNumber(cell) : parseMeasure(cell, unit);
  if (value === null || value <= 0) return null;
  const decimals = /[.,](\d+)(?!.*[.,]\d)/u.exec(text)?.[1]?.length ?? 0;
  return { value, half: 0.5 * 10 ** -decimals };
}

/**
 * Do the sheet's own total rows CONTRADICT the column's Σ — apart by more
 * than rounding (the stated figure's own place, `step`, or 0.5 %)? The last
 * total row is read as the grand total, and so — when there are several —
 * is their sum: a «TOTAL» under each section and none at the end
 * (FR-SELL-3) adds up to the Σ section by section, and a closing «TOTAL»
 * over sections is the Σ itself. Only a Σ that NO reading agrees with is
 * refused: a pallet in the total, one carton's column read for the line's.
 */
function contradicts(sum: number, rows: readonly Cell[][], column: number, unit: 'kg' | 'm3', step: number, divisor = 1): boolean {
  // A total row states its figure in the column's OWN unit (X6): cm³ under
  // «Volume (cm3)», converted here as the lines were.
  const stated = rows.map((row) => {
    const figure = statedFigure(row[column], divisor === 1 ? unit : null);
    return figure && divisor !== 1 ? { value: figure.value / divisor, half: figure.half / divisor } : figure;
  });
  const readings: { value: number; half: number }[] = [];
  const last = stated.at(-1);
  if (last) readings.push(last);
  if (stated.length > 1 && stated.every((f) => f !== null)) {
    const figures = stated as { value: number; half: number }[];
    readings.push({ value: figures.reduce((n, f) => n + f.value, 0), half: figures.reduce((n, f) => n + f.half, 0) });
  }
  if (readings.length === 0) return false;
  return readings.every(({ value, half }) => {
    const gap = Math.abs(sum - value);
    return !(gap < step || gap <= half + 1e-9 || gap <= 0.005 * Math.max(sum, value));
  });
}

/**
 * How a figure column writes its comma (§5.9, xlsxN-07's verifier): a text
 * «1,500» is fifteen hundred pieces on an English packing list and 1.5 kg
 * on a Russian one, and `parseNumber` read every lone comma as a decimal —
 * so the ERP's «Export to Excel» (an HTML table named .xls) and Excel's
 * «Save as CSV» (the displayed «"1,500"») landed 1000× small, with no word.
 */
export type Comma = 'decimal' | 'thousands';
/** The one shape that reads two ways — the kernel's AMBIGUOUS (`readNumberCell`): 1-3 digits, a comma, 3 digits. */
const AMBIGUOUS_COMMA = /^[1-9]\d{0,2},\d{3}$/;
/** The figure of a cell, without its spaces or the unit glued to it («1,050.50KGS»). */
function figureText(cell: Cell): string | null {
  if (typeof cell !== 'string' || cell.length > 64) return null;
  const text = cell.trim();
  const glued = GLUED_FIGURE.exec(text);
  return (glued ? glued[1]! : text).replace(/\s+/g, '').replace(/^-/, '');
}
/**
 * What ONE cell says of its file's comma, if anything:
 *  - thousands: two comma groups («1,500,000»), a group then a dot decimal
 *    («1,950.00»), or a dot decimal at all («0.15», «12.5» — never «1.500»,
 *    which reads two ways itself);
 *  - decimal: one comma that cannot group thousands — 1-2 or 4+ digits after
 *    it («142,5», «0,90», «1234,5678»), 4+ before it, a leading 0 («0,125»),
 *    or after dot-grouped thousands («1.234,56»).
 */
function commaEvidence(cell: Cell): Comma | null {
  const text = figureText(cell);
  if (!text) return null;
  if (/^\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?$|^\d{1,3}(?:,\d{3})+\.\d+$/.test(text)) return 'thousands';
  if (/^\d+\.\d+$/.test(text)) return /^[1-9]\d{0,2}\.\d{3}$/.test(text) ? null : 'thousands';
  if (/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(text) && !AMBIGUOUS_COMMA.test(text)) return 'decimal';
  return null;
}
/** A figure column's comma: what its OWN cells say, and what the sheet says where they say nothing. */
interface ColumnComma {
  /** The column's own cells' word — null when they say nothing or both. */
  own: Comma | null;
  /** …and the reading a bare text cell takes: `own` when the column said anything, else the sheet's. */
  bare: Comma | null;
}
/**
 * The comma of each figure column, settled ONCE from its own string cells;
 * a column with no evidence of its own takes the SHEET's — every figure
 * column's cells and what the file itself says (a «;» CSV is written with a
 * decimal comma, a «,» CSV quotes a thousands one). Evidence both ways is
 * null: nobody can say, and the ambiguous cell is asked («— aniq emas»).
 * The sheet's word is what lets an HTML export's «1,950» money beside its
 * «0.15» cube read 1950 (§5.9's pin): the money column itself held only
 * the ambiguous shape.
 */
function commaReadings(
  rows: Cell[][],
  from: number,
  columns: readonly (number | null)[],
  covered: Covered | null,
  hint: Comma | null,
): Map<number, ColumnComma> {
  const seen = new Map<number, Set<Comma>>();
  const sheet = new Set<Comma>(hint ? [hint] : []);
  for (const col of columns) {
    if (col === null || seen.has(col)) continue;
    const own = new Set<Comma>();
    for (let d = from; d < rows.length; d++) {
      if (covered?.has(d, col)) continue;
      const said = commaEvidence(rows[d]![col] ?? null);
      if (said) own.add(said);
    }
    seen.set(col, own);
    for (const said of own) sheet.add(said);
  }
  const one = (set: Set<Comma>): Comma | null => (set.size === 1 ? [...set][0]! : null);
  return new Map(
    [...seen].map(([col, own]): [number, ColumnComma] => [col, { own: one(own), bare: own.size > 0 ? one(own) : one(sheet) }]),
  );
}
/**
 * A figure cell read with its column's comma. Only the AMBIGUOUS shape is
 * ever decided here; anything else reads as before — `parseMeasure` for a
 * measured column, `parseNumber` otherwise — so «1.234,56», «-50», «0,125»
 * and every numeric cell are untouched.
 *  - A BARE text «1,500» takes the column's reading (`bare`); a PIECE count
 *    is fifteen hundred whatever the sheet says — 1.5 pieces is no count
 *    (`pieces`). With no reading it is null, and the line says «— aniq emas».
 *  - A figure with its unit GLUED on («1,200KGS», «12,500PCS») takes only
 *    what its OWN column says (`own`): «1,200KGS» beside «1,050.50KGS» is
 *    1200, and alone it stays unread — round 1's ruling for the glued shape
 *    (c0076-c0080, c0095, c0456, c0081, all three votes), which xlsxN-07's
 *    verifier kept.
 */
function readFigure(cell: Cell, accept: MeasuredIn | null, comma: ColumnComma | null, pieces = false): number | null {
  if (typeof cell === 'string' && cell.length <= 64) {
    const text = cell.trim();
    const glued = accept ? GLUED_FIGURE.exec(text) : null;
    const isGlued = glued !== null && unitOf(glued[2]!.replace(/\.$/, '')) === accept;
    const head = (isGlued ? glued[1]! : text).replace(/\s+/g, '');
    if (AMBIGUOUS_COMMA.test(head)) {
      const reading = isGlued ? (comma?.own ?? null) : pieces ? 'thousands' : (comma?.bare ?? null);
      return reading === null ? null : Number(reading === 'decimal' ? head.replace(',', '.') : head.replace(',', ''));
    }
  }
  return accept ? parseMeasure(cell, accept) : parseNumber(cell);
}

/** A volume column's figure as cubic metres (`ColumnMap.volumeDivisor`). */
const cubicMetres = (value: number | null, divisor: number): number | null => (value === null || divisor === 1 ? value : value / divisor);

/**
 * A row's SIZE as its cell — or its three cells — write it (§3.2 X3): three
 * sides through the kernel's own reader (`parseSize`), in the cell's own
 * unit, else the header's. Null beside its text when the cell holds what no
 * carton's size is — two sides (a sheet's «600x600»), four, or TWO sizes
 * («60x40x50 / 30x20x10», mixed cartons): nothing is multiplied from a guess,
 * and the text goes on the row's note.
 */
function readSize(cells: readonly Cell[], unit: CartonSize['unit'], of: SizeOwner | null): { size: CartonSize | null; text: string } {
  const texts = cells.map(cellText);
  if (texts.every((text) => text === '')) return { size: null, text: '' };
  const text = texts.filter((side) => side !== '').join(' x ');
  // A side left empty is no size: «60 x 45» is two sides of three.
  const token = texts.some((side) => side === '') ? null : parseSize(text);
  const size = token?.size ?? null;
  if (!token || !size || parseSize(text.slice(token.end)) !== null) return { size: null, text };
  return { size: { l: size.l, w: size.w, h: size.h, unit: size.unit ?? unit, of }, text };
}

/**
 * A cell that states a figure — a number, or a short text that reads as one
 * («300 PCS», «1,500»). Never a long text: a merged 30,000-character master
 * repeated down a sheet is no figure, and asked of every cell it cost
 * seconds (c1306, c1879).
 */
const figureCell = (cell: Cell): boolean =>
  typeof cell === 'number' || (typeof cell === 'string' && cell.length <= 64 && (readsAsFigure(cell) || parseNumber(cell) !== null));

/** A row as one line — its cells joined by « | », a merge's covered figure left out — for `dropped`. */
function rowText(row: readonly Cell[], d: number, covered: Covered | null): string {
  const cells = row.flatMap((cell, c) => {
    if (cell === null || (covered?.has(d, c) && readsAsFigure(cell))) return [];
    const text = clipUnits(String(cell).slice(0, 400).trim().replace(/\s*[\r\n]+\s*/g, ' / ').replace(/\s+/g, ' '), 100);
    return text ? [text] : [];
  });
  return clipUnits(cells.join(' | '), 300);
}

/**
 * What `parseGoods` read out of a sheet. `stoppedShort`: the reader stopped at
 * its ceiling (`MAX_GOODS_ROWS`) with goods rows left unread — the one truth
 * behind a capped file (as-built review REGRESSION-6): a list of exactly 500
 * read whole is no cut, and its caller had guessed one from the row count.
 */
export type ParsedGoods = { goods: GoodsRow[]; headerRow: number | null; dropped: DroppedRow[]; stoppedShort: boolean } & SheetShape;

/** What the FILE says about its figures beyond its cells (§5.9): the comma a CSV's delimiter implies. */
export interface SheetHints {
  comma?: Comma | null;
  /**
   * Keep the tail §5.5 trims as goods. The VED's paste (his B-round answer,
   * send-rows.ts): a line he selected and pasted is his, figures or none —
   * never a footer to drop. Only the footer trim: a total row (`totalRowOf`)
   * is still no good, pasted or not.
   */
  keepTail?: boolean;
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
 *
 * `dropped` names every row the sheet holds that the reader did not take as
 * a good, and why (§5.4, §5.5): a total row and a footer are not lost in
 * silence — the bot shows the model their text and says them on receipt,
 * and the deal import returns them beside the goods.
 */
export function parseGoods(rows: Cell[][], covered: Covered | null = null, hints: SheetHints = {}): ParsedGoods {
  const card = cardGood(rows, covered);
  if (card) return { ...card, dropped: [], stoppedShort: false };
  const header = findHeader(rows, covered);
  const detected = header.found;
  const goods: GoodsRow[] = [];
  const dropped: (DroppedRow & { d: number })[] = [];
  const said = (): DroppedRow[] => [...dropped].sort((a, b) => a.d - b.d).map(({ text, name, why }) => ({ text, name, why }));

  /** One row onto the list — or into `dropped` when `totalRowOf` says it is arithmetic. */
  const push = (row: GoodsRow, d: number, facts: Omit<TotalRowFacts, 'name'>): boolean => {
    const description = row.description.trim();
    if (!description) return false;
    const total = totalRowOf({ name: description, ...facts });
    if (total) {
      dropped.push({ d, text: rowText(rows[d] ?? [], d, covered), name: clipUnits(description, 300), why: total });
      return false;
    }
    // Cut by UTF-16 units as before, never through an emoji (§3.8): the half
    // left at the edge reached the state, the table and the next model pass.
    goods.push({ ...row, description: clipUnits(description, 300) });
    return true;
  };

  if (detected) {
    const { headerRow, dataFrom, columns } = detected;
    const headerName = cellText(rows[headerRow]![columns.name] ?? null).toLowerCase();
    const figureCols = [columns.quantity, columns.weight, columns.gross, columns.volume, columns.amount];
    // (X2-X3) The columns the row's packing is read from: figures too, read
    // with their column's comma — and stating one makes a row a line of the
    // list, never its footer.
    const pack = columns.pack;
    const packCols = [pack.cartons, pack.pieces?.index ?? null, pack.weight?.index ?? null, pack.volume?.index ?? null];
    const comma = commaReadings(rows, dataFrom, [...figureCols, ...packCols], covered, hints.comma ?? null);
    const commaOf = (col: number | null): ColumnComma | null => (col === null ? null : (comma.get(col) ?? null));
    // A row STATES something when a mapped figure column has a figure (or a
    // merge's covered figure stands there), or a TNVED code, or a unit
    // (reader-5.5-footer): the last good of a pair packed in one carton, its
    // figures merged down from the line above, and a last row carrying only
    // its code are goods — never a footer.
    const figureIn = (row: Cell[], d: number) => figureCols.some((i) => i !== null && !covered?.has(d, i) && figureCell(row[i] ?? null));
    const statesIn = (row: Cell[], d: number) =>
      figureIn(row, d) ||
      figureCols.some((i) => i !== null && covered?.has(d, i)) ||
      [...packCols, ...(pack.size?.cols ?? [])].some((i) => i !== null && cellText(row[i] ?? null) !== '') ||
      (columns.tnved !== null && cellText(row[columns.tnved] ?? null) !== '' && normalizeTnved(row[columns.tnved] ?? null) !== null) ||
      (columns.unit !== null && cellText(row[columns.unit] ?? null) !== '');
    // Per landed good: where it stands, what it states, and what it adds to
    // the sheet's two sums (a covered position is its master's, stated once).
    const landed: { d: number; states: boolean; figures: boolean; gross: number | 'covered' | null; volume: number | 'covered' | null }[] = [];
    // §5.4 (c)'s window: the goods landed since the sheet's start or the last
    // total row, summed per figure kind as Excel's SUM sums a column — a
    // BLANK cell adds nothing (review break-named-total-window-nan: one
    // brutto left empty, or a figure-less section heading, made every kind
    // NaN and «Итого по разделу Одежда» landed as a good, doubling the
    // shipment). A figure the reader could not read poisons its kind: nobody
    // knows that Σ, so it neither agrees nor refuses. A kind a line left
    // blank may differ — the total may count what the line did not state —
    // but some kind must agree, and every kind the lines stated whole must.
    const KINDS = ['quantity', 'weightKg', 'volumeM3', 'amount', 'gross'] as const;
    type Kind = (typeof KINDS)[number];
    const opened = () => ({
      rows: 0,
      last: '',
      sums: new Map<Kind, { sum: number; blank: boolean }>(KINDS.map((k) => [k, { sum: 0, blank: false }])),
    });
    let window = opened();
    const equalsWindow = (values: Record<Kind, number | null>): boolean => {
      if (window.rows === 0) return false;
      let matched = 0;
      for (const kind of KINDS) {
        const value = values[kind];
        if (value === null) continue;
        const { sum, blank } = window.sums.get(kind)!;
        if (Number.isNaN(sum)) continue;
        const decimals = /\.(\d+)$/.exec(String(Number(value.toPrecision(12))))?.[1]?.length ?? 0;
        if (Math.abs(sum - value) <= 0.5 * 10 ** -decimals + 1e-9 * Math.max(1, Math.abs(value))) matched += 1;
        else if (!blank) return false;
      }
      return matched > 0;
    };
    // (X4) A figure the row states that its own packing shows to be ONE
    // carton's is replaced by the product at the calc door (`applyPacking`,
    // DIM-8: «CBM» 0.12 beside twenty cartons of 60×40×50). The sheet's Σ of
    // that column is then a sum of single cartons, and no total: it is not
    // offered, and the lines' own sum stands for it.
    const corrected = { volume: false, weight: false };
    let r = dataFrom;
    for (; r < rows.length && goods.length < MAX_GOODS_ROWS; r++) {
      const row = rows[r]!;
      const at = (idx: number | null): Cell => (idx === null ? null : (row[idx] ?? null));
      const once = (idx: number | null): Cell => (idx !== null && covered?.has(r, idx) ? null : at(idx));
      // A row whose name IS the header's is the header again (S8, the second
      // review): repeated at a page break, or the sub-header row under a
      // two-row header, whose merged name cell now reads as its text — and so
      // is the header in its second language, wherever it stands (§5.12):
      // landed, «Description» was a product and nulled the sheet's Σ.
      if (isHeaderText(at(columns.name), headerName) || repeatsHeader(row, r, columns, covered)) continue;
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
      const unitText = cellText(at(columns.unit));
      // A PIECE count with no unit of its own other than pieces is never 1.5
      // pieces (§5.9): its ambiguous «1,500» is fifteen hundred.
      const pieces = columns.quantityUnit === null && (unitText === '' || unitOf(unitText) === 'dona');
      const qtyCell = once(columns.quantity);
      const weightCell = once(columns.weight);
      const volumeCell = once(columns.volume);
      const amountCell = columns.amountIsPrice ? at(columns.amount) : once(columns.amount);
      const figures: [what: string, cell: Cell, value: number | null][] = [
        // A piece column takes «300 PCS»; a column whose header names
        // another unit («Кол-во, м2») keeps the plain number, as before.
        ['soni', qtyCell, readFigure(qtyCell, columns.quantityUnit ? null : 'dona', commaOf(columns.quantity), pieces)],
        ['vazn', weightCell, readFigure(weightCell, 'kg', commaOf(columns.weight))],
        // A column in cm³, dm³ or litres holds plain numbers of that unit (X6).
        ['hajm', volumeCell, cubicMetres(readFigure(volumeCell, columns.volumeDivisor === 1 ? 'm3' : null, commaOf(columns.volume)), columns.volumeDivisor)],
        ['summa', amountCell, readFigure(amountCell, null, commaOf(columns.amount))],
      ];
      const [quantity, weightKg, rowVolume, amount] = figures.map(([, , value]) => value) as [number | null, number | null, number | null, number | null];
      const grossCell = once(columns.gross);
      const grossValue = columns.gross === columns.weight ? weightKg : readFigure(grossCell, 'kg', commaOf(columns.gross));
      const values: Record<Kind, number | null> = { quantity, weightKg, volumeM3: rowVolume, amount, gross: columns.gross === columns.weight ? null : grossValue };
      const cells: Record<Kind, Cell> = { quantity: qtyCell, weightKg: weightCell, volumeM3: volumeCell, amount: amountCell, gross: grossCell };
      const description = cellText(at(columns.name));
      if (!description) {
        // No name, and a total all the same: «TOTAL» in the «No.» column, or
        // the figures alone adding up — said like any other total row
        // (§5.4: every row (a)-(c) drops is named, review break-empty-name),
        // and the next subtotal sums from here. Said only with figures: a
        // two-row header's «PER CTN | TOTAL» line has its total word and no
        // figure, and is a header, never a total row.
        const labelled = row.some((cell, i) => !covered?.has(r, i) && typeof cell === 'string' && totalRowOf({ name: cell, figures: true }) === 'total');
        if (labelled || equalsWindow(values)) {
          if (figureIn(row, r)) dropped.push({ d: r, text: rowText(row, r, covered), name: '', why: labelled ? 'total' : 'subtotal' });
          window = opened();
        }
        continue;
      }
      // A figure cell the reader could not use is SAID, never dropped in
      // silence (round 1): «12,500PCS» and «1,200KGS» read two ways and land
      // empty — the paste door's own promise — and the line's note is where
      // the VED sees what the file stated.
      const unread = figures
        .filter(([, cell, value]) => value === null && /\d/.test(cellText(cell)))
        .map(([what, cell]) => `${what} «${cellText(cell).slice(0, 40)}» — aniq emas`);
      // The measure the count's ranking passed over (`alsoCounts`): its
      // header and the figure as the file wrote it.
      const also = columns.alsoCounts.flatMap(({ index, header: named }) => {
        const text = cellText(once(index));
        return /\d/.test(text) ? [`«${named}»: ${clipUnits(text, 40)}`] : [];
      });
      // (X2-X4) What the row states PER PACKAGE, copied into its packing: the
      // reader multiplies nothing (`applyPacking` does, at the calc door). The
      // carton COUNT is the line's own, and merged over two lines it is stated
      // once; what one carton weighs, holds and measures is every covered
      // line's, as a unit price is (R3-S3).
      const cartonsCell = once(pack.cartons);
      const piecesCell = at(pack.pieces?.index ?? null);
      const cartonKgCell = at(pack.weight?.index ?? null);
      const cartonM3Cell = at(pack.volume?.index ?? null);
      // One carton holds a count of what the HEADER names («PRS/CTN»); a header
      // naming none — or pieces — on a row that itself counts in pairs, m² or
      // litres counts that: «480 пар | 20 CTNS | PCS/CTN 24» is 24 pairs a
      // carton, never 480 pieces beside 480 pairs (review JR-1).
      const rowUnit = unitOf(unitText || columns.quantityUnit || '');
      const rowMeasure = rowUnit === 'juft' || rowUnit === 'm2' || rowUnit === 'litr' ? rowUnit : null;
      const said = pack.pieces?.unit ?? null;
      const piecesUnit: PerCartonUnit = (said === null || said === 'dona') && rowMeasure ? rowMeasure : (said ?? 'dona');
      const positive = (n: number | null) => (n !== null && n > 0 ? n : null);
      const packFigures: [what: string, cell: Cell, value: number | null][] = [
        ['karobka soni', cartonsCell, wholeCartons(readFigure(cartonsCell, 'karobka', commaOf(pack.cartons), true))],
        ['1 karobkadagi soni', piecesCell, positive(readFigure(piecesCell, piecesUnit, commaOf(pack.pieces?.index ?? null), piecesUnit === 'dona'))],
        ['1 karobka og‘irligi', cartonKgCell, positive(readFigure(cartonKgCell, 'kg', commaOf(pack.weight?.index ?? null)))],
        [
          '1 karobka hajmi',
          cartonM3Cell,
          positive(cubicMetres(readFigure(cartonM3Cell, pack.volume?.divisor === 1 ? 'm3' : null, commaOf(pack.volume?.index ?? null)), pack.volume?.divisor ?? 1)),
        ],
      ];
      const [cartons, pcsPerCarton, kgPerCarton, m3PerCarton] = packFigures.map(([, , value]) => value) as [number | null, number | null, number | null, number | null];
      const sized = pack.size ? readSize(pack.size.cols.map((i) => at(i)), pack.size.unit, pack.size.of) : null;
      const packing: Packing = {
        ...emptyPacking('file'),
        cartons,
        pcsPerCarton,
        kgPerCarton,
        kgPerCartonKind: kgPerCarton === null ? null : (pack.weight?.kind ?? null),
        m3PerCarton,
        size: sized?.size ?? null,
        ...(pcsPerCarton !== null && piecesUnit !== 'dona' ? { perCartonUnit: piecesUnit } : {}),
      };
      const rowWeightKind = kgPerCarton !== null && weightKg !== null && (columns.weightKind === 'gross' || columns.weightKind === 'net') ? columns.weightKind : null;
      if (packingStated(packing) && (rowVolume !== null || weightKg !== null)) {
        const applied = applyPacking({ quantity, weightKg, volumeM3: rowVolume, packing, ...(rowWeightKind ? { weightKind: rowWeightKind } : {}) }).line;
        if (rowVolume !== null && applied.volumeM3 !== rowVolume) corrected.volume = true;
        if (weightKg !== null && applied.weightKg !== weightKg) corrected.weight = true;
      }
      const unreadPack = [
        ...packFigures.filter(([, cell, value]) => value === null && /\d/.test(cellText(cell))).map(([what, cell]) => `${what} «${cellText(cell).slice(0, 40)}» — aniq emas`),
        ...(sized && sized.size === null && sized.text !== '' ? [`o‘lcham «${sized.text.slice(0, 40)}» — aniq emas`] : []),
      ];
      const hasFigures = figureIn(row, r);
      // A merge's covered figure is stated too (§5.5's own rule, `statesIn`):
      // «Colgate Total toothpaste» packed with the line above it is a good,
      // never a figure-less «SAY TOTAL» footer (review break-covered-total).
      const coveredFigure = figureCols.some((i) => i !== null && covered?.has(r, i));
      const sum = equalsWindow(values) ? { rows: window.rows, twin: window.rows === 1 && window.last === description } : null;
      const landedHere = push(
        {
          description,
          quantity,
          unit: (unitText || columns.quantityUnit || '').slice(0, 20) || null,
          weightKg,
          volumeM3: rowVolume,
          amount,
          tnvedCode: code && 'code' in code ? code.code : null,
          note: [codeNote, ...unread, ...unreadPack, ...also].filter(Boolean).join(' · ') || null,
          ...(packingStated(packing) ? { packing } : {}),
          // Which weight the row's own is, where the carton arithmetic asks (JN-4).
          ...(rowWeightKind ? { weightKind: rowWeightKind } : {}),
        },
        r,
        { figures: hasFigures || coveredFigure, sum },
      );
      if (!landedHere) {
        // A total row closes its window: the next subtotal sums what follows it.
        window = opened();
        continue;
      }
      const contribution = (col: number | null, value: number | null): number | 'covered' | null =>
        col === null ? null : covered?.has(r, col) ? 'covered' : value;
      landed.push({
        d: r,
        states: statesIn(row, r),
        figures: hasFigures || coveredFigure,
        gross: contribution(columns.gross, grossValue),
        volume: contribution(columns.volume, rowVolume),
      });
      // A line with no figure at all — a section heading («Раздел 1:
      // Одежда», V7) — is no line of the Σ: it neither counts nor blanks.
      if (!hasFigures && !coveredFigure) continue;
      window.rows += 1;
      window.last = description;
      for (const kind of KINDS) {
        const col = { quantity: columns.quantity, weightKg: columns.weight, volumeM3: columns.volume, amount: columns.amount, gross: columns.gross }[kind];
        if (col === null || covered?.has(r, col)) continue;
        const value = values[kind];
        const column = window.sums.get(kind)!;
        if (value !== null) column.sum += value;
        else if (cellText(cells[kind]) !== '') column.sum = Number.NaN;
        else column.blank = true;
      }
    }
    // A list the reader STOPPED at its ceiling sums nothing (review PF-ADV-2):
    // the Σ of its first 500 lines is a smaller number wearing the shipment's
    // name, and it outranks the model that may read the TOTAL row. A line
    // past the ceiling that is a footer by §5.5 — states nothing where the
    // list's lines state something — is no line left unread.
    const anyStates = landed.some((l) => l.states);
    const stoppedShort =
      goods.length >= MAX_GOODS_ROWS &&
      rows.slice(r).some((row, k) => {
        const d = r + k;
        const name = cellText(row[columns.name] ?? null);
        if (name === '' || repeatsHeader(row, d, columns, covered)) return false;
        if (totalRowOf({ name, figures: figureIn(row, d) })) return false;
        return !anyStates || statesIn(row, d);
      });
    const stated = totalRows(rows, r0(headerRow), covered);
    // §5.5 (reader-5.5-footer, xlsx1-06's verifier): the TAIL under the last
    // line that states anything is a footer — «Made in China», «Remarks:», a
    // stamp, «制表人» — never a good, and never a reason for the sheet's Σ to
    // be null. So is a figure-less line below the last grand-total row once
    // no line with figures follows it. Never mid-list (V7: a section heading
    // between goods stays), never when no line states anything (a names-only
    // list), never in the headerless branch, never on a list cut short.
    const footers = new Set<number>();
    if (!stoppedShort && anyStates && !hints.keepTail) {
      const lastStates = landed.findLastIndex((l) => l.states);
      const lastFigures = landed.findLastIndex((l) => l.figures);
      const grand = stated.at(-1)?.d ?? null;
      landed.forEach((l, k) => {
        if ((k > lastStates && !l.states) || (grand !== null && l.d > grand && k > lastFigures && !l.figures)) footers.add(k);
      });
    }
    const kept = goods.filter((_, k) => !footers.has(k));
    for (const k of footers) {
      dropped.push({ d: landed[k]!.d, text: rowText(rows[landed[k]!.d] ?? [], landed[k]!.d, covered), name: goods[k]!.description, why: 'footer' });
    }
    const keptLanded = landed.filter((_, k) => !footers.has(k));
    // The sheet's two sums over the rows it KEEPS (a total row is arithmetic,
    // never a line): null as soon as one kept row lacks its figure — a Σ one
    // line short is a smaller number wearing the shipment's name.
    const sumOf = (col: number | null, pick: (l: (typeof landed)[number]) => number | 'covered' | null): number | null => {
      if (col === null || stoppedShort) return null;
      let total = 0;
      for (const l of keptLanded) {
        const value = pick(l);
        if (value === 'covered') continue;
        if (value === null || value <= 0) return null;
        total += value;
      }
      return total;
    };
    let grossKg = corrected.weight && columns.gross === columns.weight ? null : sumOf(columns.gross, (l) => l.gross);
    let volumeM3 = corrected.volume ? null : sumOf(columns.volume, (l) => l.volume);
    // …and a Σ the sheet's OWN grand total contradicts is no total (as-built
    // review CRITIC-1, the belt): whatever header shape the reader misread,
    // the file's «TOTAL» row says what the column adds up to, and a Σ of
    // single cartons beside it is a smaller number wearing the shipment's
    // name. Refused, never corrected: the VED reads the file, the model reads
    // the row.
    if (stated.length > 0) {
      const totals = stated.map((t) => t.row);
      if (grossKg !== null && columns.gross !== null && contradicts(grossKg, totals, columns.gross, 'kg', 1)) grossKg = null;
      if (volumeM3 !== null && columns.volume !== null && contradicts(volumeM3, totals, columns.volume, 'm3', 0.01, columns.volumeDivisor)) volumeM3 = null;
    }
    // …and a brutto lighter than the lines' own netto is no brutto: a column
    // read wrong, never a figure to land.
    if (grossKg !== null && columns.weightKind === 'net' && columns.gross !== columns.weight) {
      const net = kept.every((g) => g.weightKg !== null) ? kept.reduce((n, g) => n + (g.weightKg ?? 0), 0) : null;
      if (net !== null && grossKg + 0.5 < net) grossKg = null;
    }
    // A money column is a money HEADER, claimed or not (PF-SPEC-1, §1.2.1's
    // «NO money column»): «Value (USD)», a unit price the amount did not take.
    const money = columns.amount !== null || rows[headerRow]!.some((cell) => MONEY_HEADER.test(cellText(cell)));
    const round = (n: number | null, places: number) => (n === null || kept.length === 0 ? null : Number(n.toFixed(places)));
    return {
      goods: kept,
      headerRow,
      dropped: said(),
      stoppedShort,
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
  let stoppedAt: number | null = null;
  for (let d = start; d < rows.length; d++) {
    if (goods.length >= MAX_GOODS_ROWS) {
      stoppedAt = d;
      break;
    }
    const row = rows[d]!;
    const first = row.find((cell) => typeof cell === 'string' && cell.trim().length > 0);
    push(
      {
        description: cellText(first ?? null),
        quantity: null,
        unit: null,
        weightKg: null,
        volumeM3: null,
        amount: null,
        tnvedCode: null,
        note: null,
      },
      d,
      // A headerless row's figures are whatever cell beside its name reads as one.
      { figures: row.some((cell, c) => cell !== first && !covered?.has(d, c) && figureCell(cell)) },
    );
  }
  // Stopped with a named row still below: a list cut short, as the header branch says it.
  const stoppedShort =
    stoppedAt !== null && rows.slice(stoppedAt).some((row) => row.some((cell) => typeof cell === 'string' && cell.trim().length > 0));
  return { goods, headerRow: null, dropped: said(), stoppedShort, shape: 'invoice', weightKind: null, grossKg: null, grossColumn: false, volumeM3: null };
}
