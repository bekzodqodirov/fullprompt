/**
 * Where the cargo is going, as far as the AI's PRICE is concerned (spec SPEC-P1-v2 §1.8, ⭐ MAP Q7 a).
 *
 * The table every estimate is priced on is China → TASHKENT. Neither the tool nor G11 reads a destination, so a
 * customer in Andijan, Almaty or Kabul would be told the Tashkent figure as his own. A GATE fact, never a policy
 * block: the reply still gets his ✅ — his hand-approved Andijan estimates keep their ✅ with the layer off — but
 * it never goes by itself (`foreign_destination`).
 *
 * A NEW list, on purpose: the road guards' own lists (run.ts `ARRIVAL` and every other) stay byte-identical — six
 * review layers built them for another question. This one names places, nothing else: the other regions and big
 * cities of Uzbekistan (Tashkent's own region's towns included — they are not Tashkent), and the cities of
 * Kazakhstan, Kyrgyzstan, Tajikistan and Afghanistan, with the countries themselves, in the six languages the
 * customers write. It errs toward naming a place: a word read as a city costs him one look at a card.
 *
 * Left out, each with its reason (stated): Persian «دوشنبه» (Dushanbe) is also «Monday»; Uzbek «qarshi» is also
 * «against» («qarshi emasman»), so Qarshi counts only with its place endings; Uzbek «osh» is also the dish, so Osh
 * counts only with its endings; «Navoiy» is a street in every town, so it counts only when no street word follows.
 */

/** An apostrophe as people type it in Uzbek Latin. */
const A = "['‘’ʻʼ`´]?";

/** Stems that take Uzbek / Russian endings («Andijonga», «в Андижане», «Samarqanddan»). */
const STEMS: readonly string[] = [
  // Uzbekistan — the regions and their centres, the big towns, Tashkent region's own towns.
  'andijo?n', 'андижо?н', 'андижан', 'andijan',
  'namangan', 'наманган',
  `farg${A}ona`, 'фарғона', 'ферган', 'ferg(?:h)?ana',
  'samarqand', 'самарқанд', 'самарканд', 'samarkand',
  'buxoro', 'бухоро', 'бухар', 'bukhara',
  'termiz', 'термиз', 'термез', 'termez',
  'jizzax', 'жиззах', 'джизак', 'jizzakh', 'djizak',
  'guliston', 'гулисто?н', 'гулистан', 'gulistan',
  'sirdaryo', 'сирдарё', 'сырдарь', 'syrdarya',
  'xorazm', 'хоразм', 'хорезм', 'khorezm', 'khorazm',
  'urganch', 'урганч', 'ургенч', 'urgench',
  'nukus', 'нукус',
  `qoraqalpog${A}iston`, 'қорақалпоғисто?н', 'каракалпак', 'karakalpak',
  `qo${A}qon`, 'қўқон', 'коканд', 'kokand', 'quqon',
  `marg${A}ilon`, 'марғилон', 'маргилан', 'margilan',
  'surxondaryo', 'сурхондарё', 'сурхандарь', 'surkhandarya',
  'qashqadaryo', 'қашқадарё', 'кашкадарь', 'kashkadarya',
  'chirchiq', 'чирчиқ', 'чирчик', 'chirchik',
  'angren', 'ангрен',
  'olmaliq', 'олмалиқ', 'алмалык', 'almalyk',
  'shahrisabz', 'шаҳрисабз', 'шахрисабз',
  // …and the district towns a customer names as easily as a region (0148 fix: «Xivaga», «Denovga», «Bekobodga»
  // each read as no place at all). Left out, each a word or a Tashkent landmark too: Kitob («book»), Shirin
  // («sweet»), Muborak («blessed»), Pop, Chust, Quva, Beruniy and Parkent (a street and a bazaar of Tashkent).
  'xiva', 'хива', 'khiva',
  'denov', 'денов', 'denau', 'денау',
  'bekobod', 'бекобод', 'bekabad', 'бекабад',
  `yangiyo${A}l`, 'янгийўл', 'янгиюл',
  'ohangaron', 'оҳангарон', 'охангарон', 'ахангаран',
  'nurafshon', 'нурафшон',
  'asaka', 'асака',
  'shahrixon', 'шаҳрихон', 'шахрихан',
  'quvasoy', 'қувасой', 'кувасай',
  'rishton', 'риштон', 'риштан',
  'kosonsoy', 'косонсой', 'касансай',
  `kattaqo${A}rg${A}on`, 'каттақўрғон', 'каттакурган',
  'urgut', 'ургут',
  `g${A}ijduvon`, 'ғиждувон', 'гиждуван',
  'kogon', 'когон', 'каган',
  'zarafshon', 'зарафшон', 'зарафшан',
  'uchquduq', 'учқудуқ', 'учкудук',
  `g${A}uzor`, 'ғузор', 'гузар',
  'sherobod', 'шеробод', 'шерабад',
  'boysun', 'бойсун', 'байсун',
  'yangiyer', 'янгиер',
  'hazorasp', 'ҳазорасп', 'хазарасп',
  `qo${A}ng${A}irot`, 'қўнғирот', 'кунград',
  `to${A}rtko${A}l`, 'тўрткўл', 'турткуль',
  `mo${A}ynoq`, 'мўйноқ', 'муйнак',
  `xo${A}jayli`, 'хўжайли', 'ходжейли',
  // Kazakhstan.
  `qozog${A}iston`, 'қозоғисто?н', 'казахстан', 'kazakhstan', 'qazaqstan',
  // «Olmaota» is the Uzbek for Almaty — in Latin too (0148 fix: «Olmaotaga» read as no place), with or without its
  // hyphen, and «Алмата» as often as «Алматы».
  'alma-?a?t[ayi]', 'алма-?а?т[аыу]', 'олма-?ота', 'olma-?ota',
  'astana', 'астан',
  'shymkent', 'chimkent', 'шымкент', 'чимкент',
  'qarag(?:ʻ|\'|‘|’)?andi', 'караганд', 'karaganda',
  'aktobe', 'актобе', 'aqtobe',
  'atyrau', 'атырау',
  'taraz', 'тараз',
  'turkisto?n', 'туркисто?н', 'туркестан', 'turkestan',
  'aktau', 'актау', 'aqtau',
  'kostanay', 'костанай', 'qostanay',
  'pavlodar', 'павлодар',
  'semey',
  'kyzylorda', 'кызылорда', `qizil-?o${A}rda`,
  'saryagash', 'сарыагаш', `sariog${A}och`,
  // Kyrgyzstan.
  `qirg${A}iziston`, 'қирғизисто?н', 'кыргызстан', 'киргизи', 'kyrgyzstan', 'kirgiz',
  'bishkek', 'бишкек',
  'jalol-?obod', 'жалол-?обод', 'джалал-?абад', 'jalal-?abad',
  'karakol', 'каракол',
  'batken', 'баткен', 'tokmok', 'токмок', `o${A}zgan`, 'ўзган', 'узген',
  // Tajikistan.
  'tojikisto?n', 'тожикисто?н', 'таджикистан', 'tajikistan',
  'dushanbe', 'душанбе',
  `xo${A}jand`, 'хўжанд', 'худжанд', 'khujand', 'xujand',
  'bokhtar', 'бохтар', 'kulob', 'кулоб', 'куляб', 'istaravshan', 'истаравшан', 'panjakent', 'панджакент', 'пенджикент',
  // Afghanistan.
  `afg${A}onisto?n`, 'афғонисто?н', 'афганистан', 'afghanistan',
  'kobul', 'кобул',
  `mozori${A}?\\s*sharif`, 'мазари-?\\s*шариф', 'mazar-?i-?\\s*sharif', 'mazari\\s*sharif',
  'hirot', 'ҳирот', 'герат', 'herat',
  'qandahor', 'қандаҳор', 'кандагар', 'kandahar',
  'qunduz', 'қундуз', 'кундуз', 'kunduz',
  'hayraton', 'ҳайратон', 'хайратон', 'hairatan',
  // Farther still — the table is no more theirs than Andijan's.
  'turkmanisto?n', 'туркманисто?н', 'туркменистан', 'turkmenistan',
  'ashxobod', 'ашхобод', 'ашхабад', 'ashgabat',
  'rossiya', 'россия', 'россию', 'россии', 'russia',
  'moskva', 'москв', 'moscow',
];

/**
 * «… shahri», «… shahriga», «… shahar», «… tumani», «… viloyati» after the bare word — the place's own form with ANY
 * ending (0148 fix): the Qarshi line took «shahri» only GLUED to the stem and Osh's stopped at the bare word, so
 * «Qarshi shahriga», «Қарши шаҳрига» and «Osh shahriga yuk bor» were no place and the Tashkent price went by itself.
 * «x» for «h» and «шахри» as a Russian keyboard writes it.
 */
const TOWN = '\\s+(?:sha[hx](?:ri|ar)|tuman|viloyat)\\p{L}*';
const TOWN_CYRL = '\\s+(?:ша[ҳх](?:ри|ар)|туман|вилоят)\\p{L}*';
/**
 * Places whose bare word is something else too — counted only in a place's own form: with an Uzbek place ending
 * («Qarshiga», «Oshdan»), after a Russian preposition («в Ош», «до Карши»), or with «shahri»/«город».
 */
const ENDED: readonly string[] = [
  // «qarshi» is «against».
  `qarshi(?:ga|gacha|dan|da|ning|${TOWN})`, `қарши(?:га|гача|дан|да|нинг|${TOWN_CYRL})`, `карши(?:га|гача|дан|да|${TOWN_CYRL})`, '(?:в|до|из|город)\\s+карши', 'karshi',
  // «osh» is the dish.
  `osh(?:ga|gacha|dan|da|ning|${TOWN})`, `ўш(?:га|гача|дан|да|${TOWN_CYRL})?`, `ош(?:га|гача|дан|${TOWN_CYRL})`, '(?:в|до|из|город)\\s+ош[аеу]?',
  // «Navoiy ko'chasi» is a street in every town.
  `navoiy?(?:ga|gacha|dan|da|ning)?(?![\\p{L}])(?!\\s*(?:ko${A}ch|кўч|коч|ул|str|прос|shoh|шоҳ))`,
  `навои[йи]?(?:га|гача|дан|да|нинг)?(?![\\p{L}])(?!\\s*(?:кўч|коч|ул|прос|шоҳ))`,
  // «kabul qilasizmi», «кабул киласизми» is «qabul» typed without its «q» — «accept».
  'kabul(?:ga|gacha|dan|da)?(?![\\p{L}])(?!\\s*(?:qil|kil|etil))', 'кабул(?:га|гача|дан|да|е|а)?(?![\\p{L}])(?!\\s*(?:қил|кил))',
];

/** Han and Persian spellings — no word boundary in Han; Persian takes its own (Arabic letters are letters). */
const SCRIPT_ONLY: readonly string[] = [
  // Uzbekistan
  '安集延', '纳曼干', '费尔干纳', '撒马尔罕', '布哈拉', '纳沃伊', '卡尔希', '铁尔梅兹', '吉扎克', '乌尔根奇', '努库斯', '浩罕', '花剌子模', '希瓦',
  // Kazakhstan, Kyrgyzstan, Tajikistan, Afghanistan
  '哈萨克斯坦', '阿拉木图', '阿斯塔纳', '奇姆肯特', '吉尔吉斯', '比什凯克', '奥什', '塔吉克斯坦', '杜尚别', '苦盏', '阿富汗', '喀布尔', '马扎里沙里夫', '赫拉特', '坎大哈',
  '土库曼斯坦', '阿什哈巴德', '俄罗斯', '莫斯科',
];
const PERSIAN: readonly string[] = [
  'اندیجان', 'نمنگان', 'فرغانه', 'سمرقند', 'بخارا', 'ترمذ', 'خوقند', 'خوارزم', 'جیزخ',
  'قزاقستان', 'آلماتی', 'الماتی', 'آستانه', 'شیمکنت', 'قرقیزستان', 'بیشکک', 'تاجیکستان', 'خجند',
  'افغانستان', 'کابل', 'مزار\\s*شریف', 'مزارشریف', 'هرات', 'قندهار', 'قندوز', 'حیرتان',
  'خیوه', 'ترکمنستان', 'عشق\\s*آباد', 'روسیه', 'مسکو',
];

const PLACE = new RegExp(
  [
    `(?<![\\p{L}])(?:${STEMS.join('|')})\\p{L}*`,
    `(?<![\\p{L}])(?:${ENDED.join('|')})(?![\\p{L}])`,
    `(?:${SCRIPT_ONLY.join('|')})`,
    `(?<![\\p{L}])(?:${PERSIAN.join('|')})`,
  ].join('|'),
  'iu',
);

/**
 * Does any of these lines name a city, region or country other than Tashkent (§1.8)? Read over everything the
 * customer wrote in the window the rules read and the burst (run.ts `memoryFor`) — never our own lines: «narx
 * Toshkentgacha» is ours, and «Andijonga ham yetkazamiz» in a fact is no customer's destination.
 */
export function namesForeignPlace(lines: readonly string[]): boolean {
  return lines.some((line) => PLACE.test(line.normalize('NFKC')));
}
