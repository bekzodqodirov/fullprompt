import {
  chatLine,
  clientCodePrefix,
  notGoodsWord,
  parseClientHint,
  placeWord,
  prefixCode,
  statesGoods,
  type AmbiguousTotal,
  type CalcFacts,
  type ClientHintOpts,
} from './intake';
import type { MeasureUnit } from './pricing';
import {
  codeIn,
  normalizeTnved,
  parseGoodsLine,
  readAmountText,
  unitOf,
  type SellerUnit,
} from './units';

/**
 * The facts a staff member typed, read without a model.
 *
 * Two reasons this exists rather than leaning on the AI for everything.
 * First, honesty: a person who wrote «5 kub» stated a fact, and a model that
 * missed it must not be able to erase it — so these values WIN over the
 * model's reading. Second, availability: the intake has to work on a server
 * with no API key at all, or the feature dies the day a key expires.
 *
 * Deliberately narrow. It reads the shapes the office actually types — «250
 * kg», «5 kub», «Yiwu → Toshkent» — and leaves everything else to the model
 * and to the person's own eyes at the review step.
 */

/** A whole number with optional space-grouped thousands, or a decimal — the
 * shapes `readAmountText` reads; the regex only finds the candidate. */
const AMOUNT = String.raw`(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)`;

/**
 * «250 kg», «250kg», «250 кг», «vazni 250 kg» → 250.
 *
 * The end of the unit is a NEGATIVE LOOKAHEAD, not `\b`: JavaScript's word
 * boundary is defined on ASCII, so «120кг» ends on a non-word character as
 * far as it is concerned and `\b` never matches — which is exactly how the
 * office writes it. (Caught by the test, not by reading the regex.)
 *
 * The NUMBER is read by the kernel's free-text reader (`readAmountText`,
 * 2026-10-09): «1 200 kg» is twelve hundred — the old `\d+` read «200», a
 * sixfold error on the shipment's weight — and «1,200 kg» / «1.200 kg» are
 * AMBIGUOUS in somebody's Russian, so they answer nothing and are ASKED
 * (`AmbiguousTotal`), never guessed.
 *
 * It reads EVERY occurrence, not the first, and answers only when the whole
 * collection agrees on ONE number. The owner's report — «7 8 ta malumot
 * tashlaganda … faqat 1 tasini tahlil qilyabti» — is partly this: eight
 * forwarded messages are joined into one string, the first «12 kg» in a
 * packing line won, and because a typed fact deliberately BEATS the model's
 * reading, that one line became the shipment's whole weight and the model's
 * total was thrown away. Several different numbers mean the office wrote
 * several numbers: that is a question for the reader (the model, which sees
 * all of the text) or for the VED, who can now type it on the screen.
 */
function readNumber(
  text: string,
  units: string[],
): { value: number | null; ambiguous: { text: string; decimal: number; thousands: number } | null } {
  const seen = new Set<number>();
  let ambiguous: { text: string; decimal: number; thousands: number } | null = null;
  for (const unit of units) {
    const re = new RegExp(`(?<![\\d.,])${AMOUNT}\\s*${unit}(?![\\p{L}\\d])`, 'giu');
    for (let hit = re.exec(text); hit; hit = re.exec(text)) {
      const read = readAmountText(hit[1]!);
      if (read.state === 'ok') seen.add(read.value);
      else if (read.state === 'ambiguous' && !ambiguous) {
        ambiguous = { text: hit[1]!, decimal: read.decimal, thousands: read.thousands };
      }
    }
    // A unit that answered is the unit: «5 kub» and «5 m3» in one text are
    // one statement, and the next spelling must not add a second opinion.
    if (seen.size > 0 || ambiguous) break;
  }
  if (ambiguous) return { value: null, ambiguous };
  return { value: seen.size === 1 ? [...seen][0]! : null, ambiguous: null };
}

/**
 * «Yiwu → Toshkent», «Yiwu - Toshkent», «Guangzhou dan Andijon ga».
 * Only the arrow forms are trusted: a hyphen inside a product name would
 * otherwise turn half a packing list into a route.
 */
function readRoute(text: string): { fromCity: string | null; toCity: string | null } {
  const arrow = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})\s*(?:→|->|=>)\s*([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})/u.exec(
    text,
  );
  if (arrow) return { fromCity: arrow[1]!.trim(), toCity: arrow[2]!.trim() };

  const uz = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:dan|дан|из)\s+([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:ga|га|до|в)\b/iu.exec(
    text,
  );
  if (uz) return { fromCity: uz[1]!.trim(), toCity: uz[2]!.trim() };

  return { fromCity: null, toCity: null };
}

export function parseManualFacts(text: string): CalcFacts & { ambiguous: AmbiguousTotal[] } {
  const route = readRoute(text);
  const weight = readNumber(text, ['kg', 'кг', 'kilo', 'килограмм']);
  const volume = readNumber(text, ['kub', 'куб', 'm3', 'м3', 'м³', 'm³']);
  const ambiguous: AmbiguousTotal[] = [];
  if (weight.ambiguous) ambiguous.push({ field: 'weightKg', ...weight.ambiguous });
  if (volume.ambiguous) ambiguous.push({ field: 'volumeM3', ...volume.ambiguous });
  return {
    fromCity: route.fromCity,
    toCity: route.toCity,
    weightKg: weight.value,
    volumeM3: volume.value,
    goods: readGoodsLines(text),
    ambiguous,
  };
}

/**
 * A line naming itself a goods line: «Tovar: …», «Товар - …», «Tovar nomi:
 * …», «Tovarlar: …». The label is a WHOLE word (review #25): «Tovarni rasmi»
 * and «Tovarlar» were matched by their first five letters and glued the rest
 * of the word onto a product («lar Kurtka»). The separator is CAPTURED (group
 * 2), and so is whether the label says «the NAME is» (group 1, T7):
 *  - after a NAMING label — «Tovar nomi:», «Наименование:», «Product name:»,
 *    «品名:» — what follows is the product's name, figures or not;
 *  - after a plain «Tovar:» / «Товар -» a product with its figures reads as
 *    an unlabelled line does, and a body with NO figure is the product's
 *    name too (R3-T2: «Tovar: kurtka», «Товар: куртка» — the commonest
 *    labelled shape — came back «Tovarlar: —» when T7 asked for a figure),
 *    except what a customer says ABOUT the goods: a status or a time
 *    («Tovar: tayyor», «Товар: готов», «Tovar: keldi», `STATUS_WORDS`) or a
 *    body opening with a number («Mahsulot: 5 kun ichida», «Tovar: 3 xil»);
 *  - with no separator at all («Tovar синтетическое … 1.1 kub 240 kg», his
 *    screenshot) the line is read as an unlabelled one, the word list
 *    included (R3-T1) — «Tovar keldimi», «Tovar narxi 1200$», «Tovar vazni
 *    1200 kg» are about the goods, never a product.
 */
const GOODS_LABEL =
  /^\s*(?:(tovar(?:lar)?\s*nomi|товар(?:лар|ы)?\s*номи|mahsulot(?:lar)?\s*nomi|махсулот(?:лар)?\s*номи|наименование(?:\s*товара)?|название(?:\s*товара)?|(?:goods|products?)\s*names?|品名)|tovar(?:lar)?|товар(?:лар|ы)?|mahsulot(?:lar)?|махсулот(?:лар)?|goods|products?)(?![\p{L}\p{N}])\s*([:：\-–—])?\s*/iu;

/** A PLURAL plain label — «Tovarlar:», «Товары:», «Goods:» — names several products. */
const PLURAL_LABEL = /^\s*(?:tovarlar|товар(?:лар|ы)|mahsulotlar|махсулотлар|goods|products)(?![\p{L}\p{N}])/iu;

/** A body that is a LIST — «shim, kurtka». A comma between two digits is a decimal («2,5 kub»). */
const LIST_BODY = /[;、，；]|,(?!\d)|(?<!\d),/u;
const LIST_SPLIT = /\s*(?:[;、，；]|,(?!\d)|(?<!\d),)\s*/u;

/**
 * An «and so on» closing a list (round 4, T-r1 ND10): «va hokazo», «va
 * boshqalar», «и т.д.», «и др.», «etc.» name no product, and the split kept
 * them as one («va hokazo», «обувь и т.д»).
 */
const ETC_TAIL =
  /[\s,;]*(?:va\s+hokazo|va\s+boshqa(?:lar)?|и\s+т\.?\s*[дп]\.?|и\s+др\.?|и\s+прочее|etc\.?|and\s+so\s+on)[\s.!]*$/iu;

/**
 * A leading list marker — «1.», «2)», «-», «•» (round 4, T-r2 ND8). A numbered
 * list never read: the line's number was its «first figure» at position 0, so
 * «1. Kurtka 300 dona» named nothing, and R3-T3's give-way then found no
 * other product and kept the carton count as the only one.
 */
const LIST_MARKER = /^(?:\d{1,3}[.)]|[-•*·–—])\s+/u;

/**
 * What a customer says ABOUT the goods under a label (T7, R3-T2, round 4
 * T-r1 ND6 / T-r2 ND7): a status, a time, a place, a reference to a file or
 * a person. Compared lower-cased with every apostrophe dropped («yo'q»,
 * «jo'natildi»).
 *
 * Uzbek says it at the END — «rasmi bor», «hali kelmadi», «Toshkentga
 * ketyapti», «Yiwu skladida», «mijozniki» — so the predicate is read off the
 * LAST word (`STATUS_LAST`, `STATUS_ENDING`, a place or a store in the
 * locative), and a product that only OPENS with such a word stays a product:
 * «Bor kislotasi» is boric acid (T-r2 t12). A time, a file or a photo can
 * stand anywhere (`STATUS_ANY`: «ertaga yuboraman», «Excel faylda», «см.
 * файл»), and a Russian or English status opens with its preposition («в
 * пути», «на складе», «in transit», «see attached», «as per invoice»). A body
 * of one word that only points — «shu», «ok» — names nothing, and nor does
 * one opening with the customer's code («GS777 niki»).
 *
 * Narrowed where the round-3 list refused descriptions (T-r1 ND9): no «xil»
 * («har xil kiyimlar» — a variety COUNT opens with its digit, «3 xil»), «rasm»
 * only as the photo itself («rasmli futbolka» is printed), «kun» only as the
 * day («kunlik kiyim», «Kunlik krem», «kungaboqar» are products). The short
 * Russian forms only — «готов», «готовы» say a status; «готовая одежда» is a
 * description.
 */
const STATUS_LAST = new Set([
  'tayyor', 'keldi', 'kelmadi', 'keladi', 'kelyapti', 'ketdi', 'ketmadi', 'jonatildi', 'jonatilmadi', 'bor', 'yoq',
  'yolda', 'omborda', 'skladda', 'berildi', 'olindi', 'yuklandi', 'tushirildi', 'yetdi', 'yetkazildi', 'qoldi',
  'kutilmoqda', 'turibdi', 'turibti', 'emas', 'kerak', 'готов', 'готова', 'готово', 'готовы', 'есть', 'нет',
  'будет', 'знаю', 'ready', 'shipped', 'arrived', 'sent', 'delivered', 'loaded', 'attached',
]);
/** The Uzbek verb forms a status ends in — «kelmagan», «qilingan», «ketyapti», «tekshirildi», «tushirildimi», «yuboraman», «mijozniki». */
const STATUS_ENDING = /(?:magan|ilgan|ingan|yapti|yapdi|moqda|ildi|indi|dimi|raman|taman|laman|ayman|niki)$/u;
/** Where the goods ARE, in the locative — «skladida», «bojxonada», «faylda», «invoysda», «pastda», «mashinada». */
const STORE_LOCATIVE =
  /^(?:sklad|склад|ombor|bojxona|tamojnya|fayl|invoys|excel|pdf|past|yol|mashina|fura|konteyner|dokon)(?:i)?(?:da|dagi|ga|dan)$/u;
/** A place in the locative or the directive — «Guangzhouda», «Toshkentga» (the bare name is a product's origin: «Xitoy choyi»). */
const PLACE_CASES = ['da', 'ta', 'dagi', 'ga', 'ka', 'qa', 'dan', 'tan', 'га', 'да', 'дан'];
const STATUS_ANY = new Set([
  'qachon', 'когда', 'hali', 'ertaga', 'keyin', 'kecha', 'hafta', 'завтра', 'сегодня', 'вчера', 'пока', 'скоро',
  'позже', 'потом', 'tomorrow', 'later', 'soon', 'фото', 'photo', 'photos', 'excel', 'pdf', 'invoice', 'инвойс',
]);
const STATUS_ANY_STEMS =
  /^(?:rasm(?:i|lar|lari|ni|larni)?|kun(?:i|da|dan|ga|lari|larda)?|fayl\p{L}*|файл\p{L}*|invoys\p{L}*|инвойс\p{L}*|приш\p{L}*|отправ\p{L}*|отгруж\p{L}*|загруж\p{L}*|доставл\p{L}*)$/u;
/** A Russian or English status opens with its preposition. */
const STATUS_FIRST = new Set(['в', 'на', 'см', 'in', 'see', 'as', 'per']);
const POINTER_BODY = new Set(['shu', 'bu', 'mana', 'ok', 'ок', 'okay']);

function statusBody(body: string, prefix: string | null): boolean {
  const raw = body.split(/[\s,;:!()]+/u).filter(Boolean);
  if (raw.length > 0 && prefixCode(raw[0]!.replace(/[.,]+$/u, ''), prefix)) return true;
  const words = body
    .toLowerCase()
    .replace(/[’ʻʼ‘`´']/gu, '')
    .split(/[\s,.;:!()]+/u)
    .filter(Boolean);
  if (words.length === 0) return false;
  const last = words.at(-1)!;
  if (words.length === 1 && POINTER_BODY.has(last)) return true;
  if (STATUS_FIRST.has(words[0]!)) return true;
  if (words.some((w) => STATUS_ANY.has(w) || STATUS_ANY_STEMS.test(w))) return true;
  if (STATUS_LAST.has(last) || STATUS_ENDING.test(last) || STORE_LOCATIVE.test(last)) return true;
  return PLACE_CASES.some((e) => last.length > e.length && last.endsWith(e) && placeWord(last.slice(0, -e.length)));
}

/**
 * The carton nouns that are also products (T6/T12): «Korobka 1000 dona» is a
 * thousand boxes for sale, «Karobka: 45 ta» is how many cartons the goods
 * came in — a FIELD, the name followed by its separator — and so is a carton
 * noun beside a count or total word, «Karobka soni 45 ta», «Количество
 * коробок 45 шт», «Jami karobka 45 ta» (R3-T3).
 */
const CARTON_NOUNS = new Set([
  'karobka', 'karopka', 'korobka', 'коробка', 'коробки', 'коробок', 'qop', 'quti', 'кути', 'box', 'boxes', 'carton',
  'cartons', 'karobkalar', 'korobkalar', 'qoplar', 'qutilar',
]);
const FIELD_SHAPED = /^[\p{L}\s'’‘ʻ`-]+[:：]/u;

/** The measure fields of a goods line — its weight, volume, count — in the possessive a label puts them in. */
const MEASURE_FIELDS = new Set([
  'vazni', 'vazn', 'ogirligi', 'ogirlik', 'hajmi', 'hajm', 'soni', 'miqdori', 'miqdor', 'вес', 'весом', 'объем',
  'объём', 'обьем', 'количество', 'кол-во',
]);

/**
 * Words that make ten bare digits beside them a NUMBER and not a TNVED code
 * (T11): a line accepted on its code alone has no unit to vouch for it, so
 * «Telefon 8901234567» and «Mening raqamim 8901234567» are a phone — a phone
 * written with its 8 is ten digits, and 89 is a real chapter.
 */
const NUMBER_FIELD_WORDS = new Set([
  'tel', 'tlf', 'telefon', 'telefoni', 'telefonim', 'тел', 'телефон', 'raqam', 'raqami', 'raqamim', 'номер', 'nomer',
  'nomeri', 'nomerim', 'zakaz', 'заказ', 'order', 'invoice', 'инвойс', 'schet', 'счет', 'счёт', 'inn', 'инн', 'kurs',
  'курс', 'sana', 'дата', 'no', '№', 'nr', 'id',
]);

/**
 * A person, a contact or a document beside ten BARE digits (R3-T4): «Murod
 * aka 8901234567», «Murojaat uchun 8901234567», «Shartnoma 2026100001»,
 * «Buyurtma 1234567890». The contact FIELDS are whole words with their
 * possessive endings — «telefon», «telefonim», «raqami», «номер» — never a
 * stem (round 4, T-r1 ND2 / T-r2 ND4): «Telefonlar 8517130000», «Raqamli
 * kamera 8525890000», «Счётчики 9028301100», «Nomerli qulf 8301400000» are
 * phones, a camera, meters and a lock with their codes, and «karta» / «phone»
 * are products themselves («SIM karta», «Phone case»). Only the person, the
 * document and the request words keep their stems («shartnomasi», «заказа»).
 */
const CONTACT_FIELD = new Set([
  'aka', 'akam', 'akasi', 'akamiz', 'opa', 'opam', 'opasi', 'uka', 'ukam', 'ukasi', 'tel', 'tlf', 'telefon',
  'telefoni', 'telefonim', 'telefonimiz', 'telefoningiz', 'телефон', 'телефона', 'телефону', 'raqam', 'raqami',
  'raqamim', 'raqamimiz', 'raqamingiz', 'nomer', 'nomeri', 'nomerim', 'номер', 'номера', 'счёт', 'счет', 'счета',
  'schet',
]);
const CONTACT_STEM = /^(?:murojaat|shartnoma|buyurtma|договор|заказ|contract)/u;
const contactWord = (word: string) => CONTACT_FIELD.has(word) || CONTACT_STEM.test(word);

/**
 * Is a code-only line's code ten digits written BARE — no dots, no spaces, no
 * label? Only then can it be somebody's number; «6201.93.00.00», «6201 93
 * 0000» and «tnved 6201930000» keep T11's acceptance.
 */
function bareTenDigits(body: string): string | null {
  const found = codeIn(body);
  if (!found) return null;
  const span = body.slice(found.start, found.end);
  return /^\d{10}$/u.test(span) ? span : null;
}

/**
 * May ten bare digits after a name be its TNVED code (R3-T4)? T11 took any
 * ten, so a contact line in the material — a phone written with its trunk 8,
 * a Russian mobile, an order number — became a product with a code, and the
 * queued AI prefill coded it. Refused: a run opening 89 (an Uzbek mobile with
 * its 8 — and chapter 89, ships, is not this cargo), a line naming a person,
 * a contact or a document (`contactWord`), and a run that opens no real
 * heading. NOT every 8… or 9…: 84/85 (machinery, phones 8517) and 94/95
 * (furniture 9403, toys 9503) are this business's commonest codes. Left: a
 * Russian or Kazakh mobile after a bare first name, «Иван 9161234567» (91-61
 * reads as a heading) — the residue R3-T4 states, pinned so; the model and
 * the VED's eyes catch that one. The heading test here is R3-T4's (chapter
 * 01-97, no xx00), not the book's last heading the WRITTEN forms obey
 * (`opensRealHeading`), which would refuse that line against the decision.
 */
function bareCodeOk(code: string, words: string[]): boolean {
  if (code.startsWith('89') || !/^(?:0[1-9]|[1-8]\d|9[0-7])(?:0[1-9]|[1-9]\d)/u.test(code)) return false;
  return !words.some((w) => contactWord(w.replace(/[’ʻʼ‘`´']/gu, '')));
}

/**
 * A client code standing as a word of the name — «Mijoz GS777». The company's
 * prefix always is one; any other letters-and-digits word only when the line
 * states no count or pair, because then it is a MODEL (T12: «LED32 100 dona»
 * was dropped as a client code). Never a unit («m2»).
 */
function codeWord(word: string, prefix: string | null, counted: boolean): boolean {
  if (prefixCode(word, prefix)) return true;
  return !counted && /^[a-z]{1,4}\d{1,8}$/u.test(word) && unitOf(word) === null;
}

/**
 * The letters of a code written with a hyphen — «YW-123», «B-00066» — in a
 * line's text: the kernel reads «-123» as a bare count, so «Partiya YW-123 12
 * kub» was the product «Partiya YW» × 123 (round 1, #24). As a word of the
 * name, such letters are that code's.
 */
function gluedCodeLetters(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\d])(\p{L}{1,4})[-–]\d{1,8}(?![\p{L}\d])/gu)) out.add(m[1]!.toLowerCase());
  return out;
}

/** A client code on its own — glued, spaced or hyphenated («GS777», «GS 777», «GS-777»). */
const CLIENT_CODE_LINE = /^[A-Za-z]{1,4}\s*[-–]?\s*\d{1,8}$/;

/**
 * The tail of an unlabelled line: every token a figure, a unit word or a code
 * word, and — when `measured` is asked — at least ONE unit that is not a
 * carton (review #24). A bare trailing number is not a goods line — «Tel 90
 * 123 45 67», «Kurs 12650», «Sana 21.10.2026», «Partiya YW-123» were read as
 * products with that number as their count — and a carton count alone states
 * no measure of the goods.
 */
function unitFigures(tail: string, opts: { measured: boolean } = { measured: true }): boolean {
  const tokens = tail.split(/[\s,;/+]+/u).filter(Boolean);
  let measured = false;
  for (const token of tokens) {
    if (/^\d[\d.,]*$/u.test(token)) continue;
    const glued = /^(\d[\d.,]*)([\p{L}²³]+\.?)$/u.exec(token);
    const unit = unitOf(token) ?? (glued ? unitOf(glued[2]!) : null);
    if (unit !== null) {
      if (unit !== 'karobka') measured = true;
      continue;
    }
    if (/^(?:kod|код|tnved|тнвэд|hs)$/iu.test(token)) continue;
    return false;
  }
  return measured || !opts.measured;
}

/** Where the first figure starts its OWN token: «iPhone15 300 dona»'s is «300». */
const firstFigure = (body: string) => body.search(/(?<![\p{L}\p{N}])\d/u);

/**
 * A name, THEN figures — the figure starting its OWN token. «Bobur aka GS777»
 * and «Mijoz GS777» are not a name followed by «777» (review #6): the digit
 * sits inside a code. «iPhone15 300 dona» still reads: its first figure is
 * «300».
 */
function nameThenFigures(body: string): boolean {
  const at = firstFigure(body);
  return at > 0 && unitFigures(body.slice(at));
}

/**
 * A name, then its TNVED code — «Kurtka 6201930000», «Kurtka 6201.93.00.00»,
 * «Kurtka tnved 6201930000» (T11). The finding's own fix allowed «a count or a
 * pair unit … or a TNVED code», and `statesGoods` calls the line goods: with
 * the model down, a seller who typed products with their codes got «Tovarlar:
 * —» and lost the codes. Figures after the code may follow; nothing else.
 */
function nameThenCode(body: string): boolean {
  const at = firstFigure(body);
  return at > 0 && unitFigures(body.slice(at), { measured: false }) && parseGoodsLine(body).tnvedCode !== null;
}

/**
 * «Guangzhou - Toshkent 12 kub 3500 kg»: two place names joined by a dash and
 * only the shipment's totals after them is the ROUTE (review #22), which
 * `readRoute` does not trust from a hyphen alone. A product with a dash in it
 * states a count or a pair («Futbolka - oq 300 dona»), so it never reaches
 * this test, and «Coca-Cola» has no spaces round its hyphen.
 */
const DASH_ROUTE = /^\p{Lu}[\p{L}']*(?:\s+[-–—]\s+|\s*[–—]\s*)\p{Lu}[\p{L}']*$/u;

type TypedGoods = NonNullable<CalcFacts['goods']>[number];

const PROBLEM_KINDS = new Set(['ambiguous', 'repeated', 'two_pairs']);

/** A name's edges trimmed — «：» too, the full-width colon a Chinese list writes (R3-T8), and a list's bullet. */
const tidyName = (name: string) =>
  name
    .replace(/^[\s:：\-–—.,•·*]+|[\s:：\-–—.,•·*]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/** A name's words, lower-cased; a dotted abbreviation of single letters is ONE word («N.W.» → «nw»). */
const wordsOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/(?<!\p{L})(\p{L})\.(?=\p{L}(?!\p{L}))/gu, '$1')
    .split(/[\s,.;:：()]+/u)
    .filter(Boolean);

/** At least two letters, and not a name made only of total, field or greeting words. */
const nameOk = (name: string) => (name.match(/\p{L}/gu) ?? []).length >= 2 && !wordsOf(name).every(notGoodsWord);

const figureless = (name: string): TypedGoods => ({
  name: name.slice(0, 200),
  quantity: null,
  weightKg: null,
  volumeM3: null,
  measureUnit: null,
  measureQty: null,
  tnvedCode: null,
  note: null,
});

/**
 * A labelled body with no figure that vouches for it (R3-T2). With no figure
 * the words are the only evidence, so a name made only of not-goods words is
 * refused here too («Tovar: jami», «Tovar: yana»), although a FIGURED labelled
 * line skips the list (T6: «Tovar: Total 200 litr» is a motor oil).
 *
 * A body with no unit word and no code is a NAME, exactly as typed: a bare
 * number in it is no figure (#24 — «Tovar: Kurtka 1200» may be a count or a
 * price, and a guess there lands in the quantity column), so «Название:
 * iPhone 15» stays «iPhone 15» and never «iPhone» × 15. A comma list:
 *  - under a PLURAL plain label is several products — «Mahsulotlar: shim,
 *    kurtka» → shim, kurtka, each a figure-less name;
 *  - under a singular or a naming label is ONE name, its commas kept —
 *    «Наименование: Куртка женская, зимняя» is one jacket, and «Tovar:
 *    kurtka, shim» is what the seller typed, never «kurtka shim».
 * A body that states units but is not a name followed by figures («Tovar:
 * kurtka 300 dona qora rangda», «Tovar nomi: 300 dona kurtka») is the
 * kernel's reading, refused when the kernel cannot settle it — and when its
 * figures are not ONE run (round 4, T-r1 ND4): «Tovar: kurtka 300 dona, shim
 * 150 kg» is two products, and the kernel welded them into «kurtka shim» with
 * the jackets' count and the trousers' weight. Under a PLURAL label the list
 * is split and every piece read on its own — a name and its figures, or a
 * figure-less name — or nothing is read (`listPiece`).
 *
 * A body opening with a digit is a time or a count under a plain label
 * («Mahsulot: 5 kun ichida», «Tovar: 3 xil»); after a NAMING label it is the
 * name, as the label promises (T-r2 ND3: «Наименование: 3D принтер», «Tovar
 * nomi: 7up ichimlik», «Название: 4K монитор»). What a customer says about the
 * goods is refused under both (`statusBody`): «Tovar nomi: hali yo'q».
 */
function bareGoods(body: string, labelText: string, naming: boolean, prefix: string | null): TypedGoods[] {
  const text = body.trim().replace(ETC_TAIL, '');
  if (!text || (!naming && /^\d/u.test(text))) return [];
  if (statusBody(text, prefix)) return [];
  if (!naming && PLURAL_LABEL.test(labelText) && LIST_BODY.test(text)) {
    const pieces = text.split(LIST_SPLIT).map(tidyName).filter(Boolean).map(listPiece);
    return pieces.length > 0 && pieces.every((p) => p !== null) ? (pieces as TypedGoods[]) : [];
  }
  const parsed = parseGoodsLine(text);
  if (parsed.unitWords.length === 0 && parsed.tnvedCode === null) {
    const whole = tidyName(text);
    return nameOk(whole) ? [figureless(whole)] : [];
  }
  if (!oneFigureRun(text)) return [];
  const read = kernelGoods(parsed);
  return read ? [read] : [];
}

/** The kernel's reading of a goods text as one product, or null when it cannot be settled. */
function kernelGoods(parsed: ReturnType<typeof parseGoodsLine>): TypedGoods | null {
  if (parsed.problems.some((p) => PROBLEM_KINDS.has(p.kind))) return null;
  const name = tidyName(parsed.name);
  if (!nameOk(name)) return null;
  return {
    ...figureless(name),
    quantity: parsed.quantity,
    weightKg: parsed.weightKg,
    volumeM3: parsed.volumeM3,
    measureUnit: parsed.measureUnit,
    measureQty: parsed.measureQty,
    tnvedCode: parsed.tnvedCode,
  };
}

/**
 * One piece of a plural list — «kurtka 300 dona», «shim», «обувь 200 пар»: a
 * name and then its figures, or a name with none, read as a line of its own.
 */
function listPiece(piece: string): TypedGoods | null {
  if (/^\d/u.test(piece)) return null;
  if (nameThenFigures(piece)) return kernelGoods(parseGoodsLine(piece));
  const parsed = parseGoodsLine(piece);
  if (parsed.unitWords.length > 0 || parsed.tnvedCode !== null) return null;
  return nameOk(piece) ? figureless(piece) : null;
}

/**
 * Are a text's figures ONE run — every number and unit word side by side,
 * with no word of a name between them? «300 dona kurtka» and «kurtka 300 dona
 * qora rangda» are; «kurtka 300 dona, shim 150 kg» is two runs.
 */
function oneFigureRun(text: string): boolean {
  const tokens = text.split(/[\s,;/+]+/u).filter(Boolean);
  const figure = tokens.map((t) => /^\d/u.test(t) || unitOf(t) !== null);
  const first = figure.indexOf(true);
  const last = figure.lastIndexOf(true);
  return first < 0 || figure.slice(first, last + 1).every(Boolean);
}

/**
 * The goods a person TYPED, line by line, read without a model — so that when
 * the model is down or found nothing, the summary still says what the goods
 * are. His screenshot of 2026-10-21 is the case: «Tovar синтетическое
 * компрессорное масло 1.1 kub 240 kg» came back «Tovarlar: —» because this
 * reader used to return none, ever.
 *
 * Narrow on purpose — a wrong split reads as fact on the card. A line counts
 * only when it SAYS it is a goods line («Tovar: …»), or when it is a name
 * followed by nothing but figures that carry a unit («Kurtka 300 dona 150
 * kg»). Not a route line, not a line of totals, count or field words («vazni
 * 120 kg», «Кол-во: 300 шт», «Tel 90 123 45 67»), not a sentence with a
 * number in the middle («yana 250 kg deb yozishdi»), not a question, not a
 * client code. These lines sit LAST in every caller's order: an invoice's
 * rows and the model's reading both win over them.
 *
 * `labelledOnly` (review #22): when the model DID read the material and found
 * no goods, a regex must not overrule it with «Salom» or «Guangzhou -
 * Toshkent» — only a line that names itself goods still answers. When the
 * model did not read (no key, budget, failure), every typed line answers —
 * and then the word list is what keeps a totals line («Andijonga 5 kub 1200
 * kg», «Hayrli kun, 12 kub 3500 kg», «Yukimiz 12 kub») out (T1/T8), while
 * «Kurtka 150 kg» and «Kafel 12 kub» stay products.
 *
 * The word list skips only a SEPARATED label (T6): «Tovar: …» names the goods
 * explicitly, so «Tovar: korobka 1000 dona» is a thousand boxes. A label with
 * no separator is just «the goods'…» — «Tovar vazni 1200 kg», «Товар вес
 * 3500 кг», «Goods volume 12 m3» are totals, and with the list skipped they
 * were products even when the model had read and found none (R3-T1). Two
 * pinned cases meet here: the screenshot line has no separator either, and
 * still reads, because none of its words is on the list.
 *
 * A carton count is not a product (#24, R3-T3): a carton noun as a field
 * («Karobka: 45 ta») or beside a count or total word («Karobka soni 45 ta»);
 * and a line named only by carton nouns («Karobka 45 ta») gives way when the
 * text names another product — alone, «Korobka 1000 dona» is boxes for sale.
 * `prefix` is the company's client-code prefix (`ClientHintOpts`).
 */
export function readGoodsLines(
  text: string,
  opts?: { labelledOnly?: boolean } & ClientHintOpts,
): NonNullable<CalcFacts['goods']> {
  const prefix = clientCodePrefix(opts);
  const out: { goods: TypedGoods; labelled: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= 50) break;
    const line = raw.trim().replace(LIST_MARKER, '');
    if (!line || !/\p{L}/u.test(line)) continue;
    if (readRoute(line).fromCity !== null) continue;
    if (CLIENT_CODE_LINE.test(line)) continue;
    // «Tovar keldimi?» — a question about the goods is not a goods line.
    if (/[?？]$/u.test(line)) continue;
    const label = GOODS_LABEL.exec(line);
    if (opts?.labelledOnly && !label) continue;
    const naming = Boolean(label?.[1]);
    const separated = Boolean(label?.[2]);
    const body = label ? line.slice(label[0].length) : line;
    const figured = nameThenFigures(body);
    const coded = !figured && nameThenCode(body);
    // A list under a plural label is split before anything reads it whole:
    // «Tovarlar: shim, kurtka 300 dona» is two products, and as one «name then
    // figures» line it was «shim kurtka» × 300 (round 4, T-r2 t7).
    const listed = separated && !naming && PLURAL_LABEL.test(label![0]) && LIST_BODY.test(body);
    if (listed || (!figured && !coded)) {
      if (label && separated) {
        for (const goods of bareGoods(body, label[0], naming, prefix)) {
          if (out.length < 50) out.push({ goods, labelled: true });
        }
      }
      continue;
    }
    const parsed = parseGoodsLine(body);
    const name = tidyName(parsed.name);
    const words = wordsOf(name);
    if (words.length === 0) continue;
    const counted = parsed.quantity !== null || parsed.measureQty !== null;
    // «Tovar: vazni 150 kg» is the goods' weight under a label (round 3,
    // R3-T1's optional half): the list skip a label earns (T6, «Tovar: Total
    // 200 litr» is a motor oil) stops at a name made only of a measure FIELD.
    if (separated && words.every((w) => MEASURE_FIELDS.has(w.replace(/[’ʻʼ‘`´']/gu, '')))) continue;
    if (!separated) {
      const glued = gluedCodeLetters(body);
      if (words.every((w) => notGoodsWord(w) || codeWord(w, prefix, counted) || glued.has(w))) continue;
      const cartonish = words.every((w) => CARTON_NOUNS.has(w) || notGoodsWord(w));
      if (cartonish && (FIELD_SHAPED.test(line) || words.some(notGoodsWord))) continue;
      // A chat line about the shipment states no count, pair or code (R3-T8):
      // «Salom aka, 12 kub», «Bugun 5 kub», «Toshkent shahriga 12 kub» (`chatLine`).
      if (!counted && parsed.tnvedCode === null && chatLine(words)) continue;
    }
    // Ten digits on a line with no unit are a number when a field names them.
    if (coded && words.some((w) => NUMBER_FIELD_WORDS.has(w.replace(/[’ʻʼ‘`´']/gu, '')))) continue;
    const bare = coded ? bareTenDigits(body) : null;
    if (bare !== null && !bareCodeOk(bare, words)) continue;
    if ((name.match(/\p{L}/gu) ?? []).length < 2) continue;
    if (!separated && parsed.quantity === null && parsed.measureQty === null && DASH_ROUTE.test(name)) continue;
    // An answer the parser could not settle («1,200 kg») is not a figure, and
    // a unit stated twice («300 dona …, 200 dona») is two lines welded into
    // one — splitting them is the model's job.
    if (parsed.problems.some((p) => PROBLEM_KINDS.has(p.kind))) continue;
    out.push({
      goods: {
        ...figureless(name),
        quantity: parsed.quantity,
        weightKg: parsed.weightKg,
        volumeM3: parsed.volumeM3,
        measureUnit: parsed.measureUnit,
        measureQty: parsed.measureQty,
        tnvedCode: parsed.tnvedCode,
      },
      // A label with no separator is read as an unlabelled line (R3-T1), and
      // gives way as one too.
      labelled: separated,
    });
  }
  const cartonOnly = (g: TypedGoods) => wordsOf(g.name).every((w) => CARTON_NOUNS.has(w));
  const another = out.some((o) => !cartonOnly(o.goods));
  return out.filter((o) => !another || o.labelled || !cartonOnly(o.goods)).map((o) => o.goods);
}

/**
 * The answer to the bot's question about ONE line.
 *
 * The follow-up loop asks about a row its law (or the one-measure rule) says
 * cannot be priced yet, and whatever this returns is written onto that row
 * and priced — so the rule is «read it exactly or refuse». A refusal costs one
 * more question; a wrong reading costs a duty computed on a number nobody
 * stated.
 *
 * The amount grammar is the kernel's own (`parseGoodsLine`, 2026-10-09), the
 * same one the card form, the paste and the invoice reader use, so «1 200
 * kg» is 1200 everywhere, «120 m2» / «40 juft» / «50 litr» land in the
 * measure pair (they were refused before — the owner's «juftda o'tadigan
 * tovarlar»), «300 dona 150 kg» is BOTH (it was refused: it is the clothing
 * answer, a per-kg baza under a per-piece floor), and «120 ta juft» is 120
 * pairs, never 120 pieces.
 *
 *  - a TNVED code («6403990000», «6403.99.00.00», «kod 6907») is a CODE —
 *    never a 6.4-billion-kg weight (the audit's finding, which then blamed
 *    the server for the overflow);
 *  - a BARE number is handed back as `bare`: what it means is the LAW's
 *    question (`bareUnitFor`) or the seller's tap, never a default unit;
 *  - «1,200 kg» is `ambiguous`, with both readings and its unit;
 *  - a figure no column can hold (numeric(12,3): nine integer digits) is
 *    refused in words at parse time;
 *  - two pairs, two different weights, a carton count alone, or a unit this
 *    office does not price are refused with the reason, for the bot to word.
 */
export interface LineFigures {
  quantity: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  measureUnit: MeasureUnit | null;
  measureQty: number | null;
}

export type LineAnswerRefusal =
  | 'nothing'
  | 'too_large'
  | 'code_short'
  | 'cartons'
  | 'unknown_unit'
  | 'two_pairs'
  | 'unlabelled'
  | 'repeated';

export type LineAnswer =
  | { kind: 'figures'; figures: LineFigures; code: string | null }
  | { kind: 'bare'; value: number; code: string | null }
  | { kind: 'ambiguous'; decimal: number; thousands: number; unit: SellerUnit | null }
  | { kind: 'refused'; reason: LineAnswerRefusal; detail?: string };

/** numeric(12,3) holds nine integer digits; measure_qty numeric(14,4), ten. */
export const ROW_AMOUNT_CAP = 1e9;
export const PAIR_AMOUNT_CAP = 1e10;

/** The unit word written right after a number in the answer, if any. */
function unitAfter(text: string, numberText: string): SellerUnit | null {
  const at = text.indexOf(numberText);
  if (at < 0) return null;
  const word = /^\s*([\p{L}²³][\p{L}\d²³.]*)/u.exec(text.slice(at + numberText.length));
  return word ? unitOf(word[1]) : null;
}

export function parseLineAnswer(raw: string): LineAnswer {
  const text = raw.trim();
  if (!text) return { kind: 'refused', reason: 'nothing' };
  // A minus is not a quantity of anything; the kernel's amount grammar would
  // read «-5» as 5.
  if (/(?:^|\s)-\s*\d/.test(text)) return { kind: 'refused', reason: 'nothing' };

  // Nine bare digits are a code whose leading zero was lost, not 901 million
  // pieces — the kernel's rule for typed text (`normalizeTnved`).
  if (/^[\d.\s ]+$/.test(text)) {
    const code = normalizeTnved(text);
    if (code && 'problem' in code) return { kind: 'refused', reason: 'code_short', detail: code.text };
  }

  const line = parseGoodsLine(text);
  // Ten digits with a unit word after them are an AMOUNT no column can
  // hold, not a code: the kernel takes ten bare digits for a TNVED code
  // wherever they stand, so «2000000000 kg» would have answered the line
  // with a code and no figure.
  if (line.tnvedCode !== null && unitAfter(text, line.tnvedCode) !== null) {
    return { kind: 'refused', reason: 'too_large' };
  }
  for (const p of line.problems) {
    if (p.kind === 'ambiguous') {
      return { kind: 'ambiguous', decimal: p.decimal, thousands: p.thousands, unit: unitAfter(text, p.text) };
    }
  }
  for (const p of line.problems) {
    switch (p.kind) {
      case 'code_short':
        return { kind: 'refused', reason: 'code_short', detail: p.text };
      case 'two_pairs':
        return { kind: 'refused', reason: 'two_pairs' };
      case 'unlabelled':
        return { kind: 'refused', reason: 'unlabelled' };
      case 'repeated':
        return { kind: 'refused', reason: 'repeated' };
      case 'cartons_only':
        return { kind: 'refused', reason: 'cartons', detail: String(p.cartons) };
      case 'unknown_unit':
        return { kind: 'refused', reason: 'unknown_unit', detail: p.word };
      default:
        break;
    }
  }

  const figures: LineFigures = {
    quantity: line.quantity,
    weightKg: line.weightKg,
    volumeM3: line.volumeM3,
    measureUnit: line.measureUnit,
    measureQty: line.measureQty,
  };
  const tooLarge =
    [figures.quantity, figures.weightKg, figures.volumeM3].some((v) => v !== null && v >= ROW_AMOUNT_CAP) ||
    (figures.measureQty !== null && figures.measureQty >= PAIR_AMOUNT_CAP);
  if (tooLarge) return { kind: 'refused', reason: 'too_large' };

  const stated = [figures.quantity, figures.weightKg, figures.volumeM3, figures.measureQty].filter(
    (v) => v !== null,
  ).length;
  // A count is a COUNT only when a count word says so; the kernel reads a
  // lone bare number as one by its «nomi, soni» convention, which is right
  // for a list and wrong for an answer to «dona yoki kg?».
  const countSaid = line.unitWords.some((w) => unitOf(w) === 'dona');
  if (stated === 1 && figures.quantity !== null && !countSaid) {
    return { kind: 'bare', value: figures.quantity, code: line.tnvedCode };
  }
  if (stated === 0 && !line.tnvedCode) return { kind: 'refused', reason: 'nothing' };
  return { kind: 'figures', figures, code: line.tnvedCode };
}

/** «Shim 200», «Stol 1000»: one word and its count. */
const ONE_WORD_COUNT = /^\p{L}[\p{L}'’‘ʻ`-]*\s+\d{2,}$/u;
/**
 * «Samsung A54», «Xiaomi Redmi K60», «Televizor LG55», «Truba PPR20»: a
 * product and its model — one to three capitals and the digits (R3-T9 widened
 * it from one capital once two or three capitals beside a word stopped being
 * a client code).
 */
const MODEL_TAIL = /\p{L}\s+[A-Z]{1,3}\d{1,4}$/u;
/**
 * «Kurtka 1200 50 3000», «Futbolka 2000 10 5000»: a word and a ROW of two or
 * more bare figures — a packing-list row copied without its units. R3-T5 took
 * these out of the printed-code form, which had made them «goods» for the
 * wrong reason; without this they became a short line of words and a number,
 * i.e. the customer's NAME. A name carries one number at most («OOO Asia
 * Trade 2020», «Ali aka 2»).
 */
const NUMBER_ROW = /\p{L}\s+\d[\d.,]*(?:\s+\d[\d.,]*)+$/u;
/**
 * …but groups of two or three digits and nothing else are how a phone is
 * written, and one that is not whole is still a contact being typed — «Ali
 * aka 123 45 67», «Ali 90 123 45» (round 4, T-r2 ND9: NUMBER_ROW filed them
 * as goods). A row of figures carries what a phone never has: a group of four
 * digits or more, or a decimal. Left: «Kurtka 120 50 30» reads as a name;
 * the repeat rule and the model see it either way.
 */
const PHONE_GROUPS = /\p{L}\s+\d{2,3}(?:\s+\d{2,3})+$/u;
/** The label words of a customer's code: «Mijoz 777» names a customer, never a product's count (R3-T7). */
const CLIENT_WORD = /^(?:mijoz|мижоз|klient|клиент|client|kod|код)$/iu;

/** A line opening with a goods label, its separator and something after it — «Tovar: kurtka». */
function labelledGoodsLine(line: string): boolean {
  const label = GOODS_LABEL.exec(line);
  return Boolean(label?.[2]) && line.slice(label![0].length).trim() !== '';
}

/**
 * Is the first message of a collection MATERIAL rather than the customer's
 * name (his 1.7 b)? The bot asks «who is the customer» and a seller in a
 * hurry forwards the goods list instead; it used to become the lead's NAME
 * and was never shown to the model.
 *
 * Goods evidence decides FIRST (review #16, #23): a unit word, a TNVED code
 * or a line naming itself goods is material, whatever digits it also holds.
 * A line naming itself goods is material by its LABEL (R3-T2), whatever the
 * goods reader makes of its body: «Tovar: kurtka, shim», «Goods: jackets» and
 * «Товар - куртка» were filed as the CUSTOMER once T7 stopped reading
 * figure-less bodies — the lead named «Tovar: kurtka, shim» and the goods
 * never reached the model.
 * Then the customer: a code or a phone, written the ways people write them
 * («GS 777», «Bobur aka GS777», «Ali aka» over «+998 90 123 45 67»). Then
 * several lines or a long text is material. What is left — a short line of
 * words, perhaps with a bare number («Ali aka 2», «OOO Asia Trade 2020») —
 * is a NAME: filing a name as material re-asked the same question for ever.
 *
 * Except the two shapes a goods line has and a name does not (the second
 * review's T4): ONE word and its count («Shim 200», «Stol 1000», «Olma 300»
 * — the «nomi, soni» line of every list) unless the word is a customer's
 * label («Mijoz 777», R3-T7), and a product ending in its model («Samsung
 * A54», «Televizor LG55», «Bobur ABC777» — R3-T9). Both used to be read as a
 * client code nobody holds, so the goods named the lead and never reached the
 * model; as a NAME they would do the same. A seller who meant «Bobur ABC777»
 * as the customer sends it again, and the collector's repeat rule
 * (`readCustomerText`: one short line with no goods evidence could be a
 * customer) believes him — the safety net for every guess this one makes.
 * `opts.prefix` is the company's client-code prefix (`ClientHintOpts`),
 * which the bot passes.
 */
export function looksLikeMaterial(raw: string, opts?: ClientHintOpts): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (goodsEvidence(text, opts)) return true;
  if (parseClientHint(text, opts)) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const oneWordCount = ONE_WORD_COUNT.test(text) && !CLIENT_WORD.test(text.split(/\s+/u)[0]!);
  return (
    lines.length > 1 || text.length > 60 || oneWordCount || MODEL_TAIL.test(text) || figureRow(text) || wordList(text)
  );
}

/**
 * The goods evidence that decides FIRST, whatever else a text holds (review
 * #16, #23, R3-T2): some line states a unit or a code (`statesGoods`), names
 * itself goods («Tovar: …», `labelledGoodsLine`), or reads as a goods line
 * on its label alone. Exported for the customer question's «could this be a
 * customer» (round 4, integration defect 1): one test, so a line that is
 * material can never also be believed as the customer on a repeat.
 */
export function goodsEvidence(raw: string, opts?: ClientHintOpts): boolean {
  const labelled = { labelledOnly: true, prefix: opts?.prefix };
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .some((l) => labelledGoodsLine(l) || statesGoods(l) || readGoodsLines(l, labelled).length > 0);
}

/**
 * A word and a ROW of bare figures with no phone's shape (`NUMBER_ROW`,
 * `PHONE_GROUPS`) — «Kurtka 1200 50 3000». Exported for the same reason as
 * `goodsEvidence`: such a line is material, and on a repeat no customer.
 */
export function figureRow(raw: string): boolean {
  const text = raw.trim();
  return NUMBER_ROW.test(text) && !PHONE_GROUPS.test(text);
}

/**
 * Three or more single words in a comma list, none of them a place or a
 * total — «Kurtka, shim, sharf» (round 3, collector C3 note: a unit-less
 * goods list was taken as the customer on the first send). A contact is a
 * name and a place, «Rustam, Andijon», «Ali aka, Toshkent, Chilonzor», never
 * a list of bare nouns. A seller who meant it as the customer sends it again,
 * and the repeat rule believes one short line.
 */
function wordList(text: string): boolean {
  const items = text.split(/\s*[,，、;]\s*/u).filter(Boolean);
  return items.length >= 3 && items.every((i) => /^\p{L}[\p{L}'’‘ʻ`-]*$/u.test(i) && !notGoodsWord(i));
}
