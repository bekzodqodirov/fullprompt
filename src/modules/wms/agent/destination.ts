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

import { chinaMentions } from './origin';

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
  // hyphen, and «Алмата» as often as «Алматы»; «Алматига», «Олматига» with the Uzbek «-и» (fix pass 3).
  'alma-?a?t[ayi]', 'алма-?а?т[аыуи]', 'олма-?ота', 'olma-?ota', 'олма-?а?т[аи]', 'olma-?a?t[ai]',
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
  // …and the farther places his customers name most (fix pass 3) — the destination FORM below catches the rest.
  'tehron', 'tehran', 'теҳрон', 'техрон', 'тегеран',
  `mashhad`, 'машҳад', 'машхад',
  'istanbul', 'стамбул', 'истанбул', 'истамбул',
  'dubay', 'dubai', 'дубай',
  `sh[iy]mkent`, 'шимкент',
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
  // …or with its abbreviation, «uchun», «tomon», a preposition or «г.» before it (fix pass 3: «Qarshi uchun», «Qarshi
  // sh.ga», «в г. Карши», «to Qarshi» were no place).
  `qarshi(?:ga|gacha|dan|da|ning|${TOWN}|\\s+sh\\.\\p{L}*|\\s+(?:uchun|tomon\\p{L}*))`, `қарши(?:га|гача|дан|да|нинг|${TOWN_CYRL}|\\s+(?:учун|томон\\p{L}*))`, `карши(?:га|гача|дан|да|${TOWN_CYRL})`,
  `(?:в|до|из|на|для)\\s+(?:г\\.?\\s*|город\\p{L}*\\s+)?карши`, '(?<![\\p{L}])г\\.\\s*карши', '(?:to|in|for)\\s+qarshi', 'karshi',
  // «osh» is the dish.
  // «O‘sh» is how Uzbek spells it — and «o‘sha» is «that», so only with the place's own endings; English and Russian
  // name it after a preposition («to Osh», «на Ош», «в г. Ош»), or after «г.» (fix pass 3).
  `osh(?:ga|gacha|dan|da|ning|${TOWN})`, `o${A}sh(?:ga|gacha|dan|da|ning|${TOWN})`, `ўш(?:га|гача|дан|да|${TOWN_CYRL})?`, `ош(?:га|гача|дан|${TOWN_CYRL})`,
  '(?:в|до|из|на|для)\\s+(?:г\\.?\\s*|город\\p{L}*\\s+)?ош[аеу]?', '(?<![\\p{L}])г\\.\\s*ош[аеу]?', '(?:to|in|for)\\s+osh',
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
  'تهران', 'مشهد', 'استانبول', 'دبی',
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
 * A list never ends — Iran, Turkey, the Emirates, the rest of Russia (fix pass 3). So the customer's own GRAMMAR is
 * read too: a destination FORM after the place the cargo starts from — «Yiwudan X-ga», «Xitoydan … X-ga», «из Иу в
 * X», «на X из Иу», «from Yiwu to X», «Иу — X», «从义乌到X», «از ایوو به X» — whose X is not Tashkent (nor
 * Uzbekistan, nor a district of Tashkent). What else stands in that slot is no place: a pronoun («bizga»), a place of
 * ours («omboringizga»), a unit or a price («5 kubga», «qanchaga»), a road («avtoga»), a verb («olib kelishga»), a
 * question («qayerga»). A Russian, English or route X must be capitalised (lower case there is every other word);
 * an Uzbek X with its case ending need not be — the ending says it. Errs toward naming a place, like the list.
 */
/** Tashkent, its districts and Uzbekistan — the table's own destination. */
const HOME = new RegExp(
  `^(?:to${A}shkent|tashkent|toshkand|тошкент|ташкент|o${A}zbekiston|uzbekiston|uzbekistan|ozbekiston|ўзбекистон|узбекистон|узбекистан|` +
    `chilonzor|yunusobod|sergeli|yakkasaroy|mirobod|olmazor|uchtepa|bektemir|shayxontohur|chuqursoy|yashnobod|yangihayot|mirzo|qo${A}yliq|ippodrom|abu|` +
    `чилонзор|юнусобод|сергели|яккасарой|миробод|олмазор|учтепа|бектемир|шайхонтоҳур|чуқурсой|чукурсой|яшнобод|мирзо|қўйлиқ|куйлюк|ипподром|` +
    `кита[йяеюи]|xitoy|хитой|china)`,
  'iu',
);
/** What else an Uzbek «-ga» right after the origin is: pronouns, ours, units, money, time, roads, cargo, a verb, a question. */
const NOT_PLACE_UZ = new RegExp(
  `^(?:(?:men|sen|biz|siz|sizlar|bizlar|ular|un|o${A}z\\p{L}*|мен|сен|биз|сиз|сизлар|бизлар|улар|ун|ўз\\p{L}*)(?:ga|га)|` +
    `\\p{L}*(?:imiz|ingiz|lar|im|ing|имиз|ингиз|лар|им|инг)(?:ga|га)|` +
    `\\p{L}+(?:ish|ash|иш|аш)(?:i|im|ing|imiz|ingiz|и|им|инг|имиз|ингиз)?(?:ga|га)|` +
    `(?:ombor|sklad|склад|омбор|filial|филиал|punkt|пункт|uy|уй|ofis|офис|do${A}kon|дўкон|bozor|бозор|` +
    `kub|куб|kilo|кило|kg|кг|tonn|тонн|gramm|грамм|metr|метр|dona|дона|karobka|коробк|quti|қути|mesta|мест|palet|паллет|` +
    `pul|пул|narx|нарх|qancha|қанча|канча|necha|неча|dollar|доллар|so${A}m|сўм|сум|yuan|юан|` +
    `kun|кун|hafta|ҳафта|хафта|oy|ой|soat|соат|ertaga|эртага|bugun|бугун|keyin|кейин|oldin|олдин|vaqt|вақт|муддат|muddat|` +
    `avto|авто|avia|авиа|mashina|машина|fura|фура|poyezd|поезд|samolyot|самолёт|самолет|temir|темир|konteyner|контейнер|kargo|карго|` +
    `yuk|юк|tovar|товар|mol|мол|bojxona|божхона|rastamojka|растаможка|chegara|чегара|granitsa|граница|` +
    `zakaz|заказ|buyurtma|буюртма|dostavka|доставка|fabrika|фабрика|zavod|завод|sotuvchi|сотувчи|postavshik|поставщик|` +
    `alibaba|taobao|pinduoduo|1688|` +
    `ikkala|иккала|hamma|ҳамма|хамма|bari|бари|har|ҳар|хар|qaysi|қайси|кайси|boshqa|бошқа|бошка|o${A}shan|ўшан|ушан|` +
    `qayer|қаер|каер|nima|нима|shun|шун|bun|бун|sha${A}?h[ae]r|шаҳар|шахар|viloyat|вилоят|tuman|туман)\\p{L}*)$`,
  'iu',
);
/** «shahriga», «tumaniga», «viloyatiga» — the place is the word BEFORE it («Tehron shahriga», «Toshkent shahriga»). */
const TOWN_WORD = /^(?:sha[hx](?:ri|ar)|шаҳ(?:ри|ар)|шах(?:ри|ар)|tuman|туман|viloyat|вилоят)\p{L}*$/iu;
/** The dative and the terminative: «-ga», «-gacha», and «-ka»/«-qa» only after the «k»/«q» they assimilate to («Bishkekka»). */
const UZ_DATIVE = /^\p{L}[\p{L}'‘’ʻʼ`´-]*?(?:gacha|ga|гача|га|(?<=[kк])(?:ka|ка)|(?<=[qқ])(?:qa|қа))$/iu;
const CLAUSE_END = /[.!?;\n。！？؟]/u;
const WORD_G = /[\p{L}\p{N}'‘’ʻʼ`´.-]+/gu;

/** The Uzbek form: «<origin>dan … X-ga» within six words of its clause. */
function uzbekDestination(line: string): boolean {
  return chinaMentions(line).some(({ index, match }) => {
    const rest = line.slice(index + match.length);
    // «Иудан» is one spelling of Yiwu with its ending already in the match.
    const glued = /(?:dan|дан)$/iu.test(match);
    const from = glued ? null : /^(?:\s+shahridan|['‘’ʻʼ`´]?(?:dan|дан))(?![\p{L}])/iu.exec(rest);
    if (!glued && !from) return false;
    const clause = rest.slice(from?.[0].length ?? 0).split(CLAUSE_END)[0] ?? '';
    const words = (clause.match(WORD_G) ?? []).slice(0, 7);
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i]!.replace(/[.,]+$/u, '');
      if (!UZ_DATIVE.test(w)) continue;
      // «Tehron shahriga»: the name is the word before.
      const name = TOWN_WORD.test(w) ? (words[i - 1] ?? '') : w;
      if (TOWN_WORD.test(w) && name === '') return false;
      if (HOME.test(name) || /^\p{N}/u.test(name)) return false;
      if (NOT_PLACE_UZ.test(w) && !TOWN_WORD.test(w)) continue;
      return true;
    }
    return false;
  });
}

/** A capitalised place word, Latin or Cyrillic — never Tashkent, Uzbekistan, China or a place the cargo starts at. */
function capitalisedElsewhere(word: string): boolean {
  if (!/^\p{Lu}/u.test(word) || HOME.test(word)) return false;
  return chinaMentions(word).length === 0;
}

/** The Russian, English and route forms: «из/с <origin> … в/на/до X», «X … из <origin>», «from <origin> to X», «<origin> — X». */
function otherDestination(line: string): boolean {
  for (const sentence of line.split(CLAUSE_END)) {
    const origins = chinaMentions(sentence);
    if (origins.length === 0) continue;
    const ru = /(?:^|[^\p{L}])(?:из|с|от)\s+$/iu;
    const fromRu = origins.some(({ index }) => ru.test(sentence.slice(Math.max(0, index - 6), index)));
    if (fromRu) {
      for (const m of sentence.matchAll(/(?:^|[^\p{L}])(?:[вВ]о?|[нН]а|[дД]о)\s+(?:г\.?\s*|город\p{L}*\s+)?([А-ЯЁЎҚҒҲ][\p{L}-]*)/gu)) {
        if (capitalisedElsewhere(m[1]!)) return true;
      }
    }
    const fromEn = origins.some(({ index }) => /(?:^|[^\p{L}])from\s+$/iu.test(sentence.slice(Math.max(0, index - 6), index)));
    if (fromEn) {
      for (const m of sentence.matchAll(/(?:^|[^\p{L}])[tT]o\s+(\p{Lu}[\p{L}-]*)/gu)) {
        if (capitalisedElsewhere(m[1]!)) return true;
      }
    }
    // The route: «Иу — Ош», «Yiwu-Qarshi», «Yiwu → Tehron».
    for (const { index, match } of origins) {
      const route = /^\s*(?:[-–—>→]+|->)\s*(\p{Lu}[\p{L}'‘’ʻʼ`´-]*)/u.exec(sentence.slice(index + match.length));
      if (route && capitalisedElsewhere(route[1]!)) return true;
    }
  }
  return false;
}

/** Han: «从义乌（运/发）到X», «义乌到X» — X the next Han word, its question tail taken off. */
const HAN_TAIL = /(?:多少钱|多少|需要|一共|大概|运费|怎么|可以|要|的|吗|呢|是|有|能|啊|呀)+$/u;
const HAN_NOT_PLACE = /^(?:了|达|货|时|底|处|期|这|那|你|我|您|仓|家|门|哪|手|齐|位|港口|账|付|发|运)/u;
const HAN_HOME = /^(?:塔什干|乌兹别克|中国)/u;
function hanDestination(line: string): boolean {
  return chinaMentions(line).some(({ index, match }) => {
    if (!/\p{Script=Han}/u.test(match)) return false;
    const m = /^[^。！？\n]{0,6}?到(\p{Script=Han}{2,6})/u.exec(line.slice(index + match.length));
    if (!m) return false;
    const x = m[1]!.replace(HAN_TAIL, '');
    return [...x].length >= 2 && !HAN_HOME.test(x) && !HAN_NOT_PLACE.test(x) && chinaMentions(x).length === 0;
  });
}

/** Persian: «از <origin> به/تا X». */
const FA_NOT_PLACE = /^(?:ما|شما|انبار\p{L}*|دفتر\p{L}*|کجا|چه|فردا|امروز|هفته|ماه|روز|کی|اینجا|آنجا)$/u;
const FA_HOME = /^(?:تاشکند|ازبکستان)/u;
function persianDestination(line: string): boolean {
  return chinaMentions(line).some(({ index, match }) => {
    if (!/\p{Script=Arabic}/u.test(match)) return false;
    if (!/(?:^|[^\p{L}])از\s+$/u.test(line.slice(Math.max(0, index - 4), index))) return false;
    const m = /^[^.!?؟\n]{0,12}?(?:^|[^\p{L}])(?:به|تا)\s+(\p{Script=Arabic}+)/u.exec(line.slice(index + match.length));
    if (!m) return false;
    return !FA_HOME.test(m[1]!) && !FA_NOT_PLACE.test(m[1]!) && chinaMentions(m[1]!).length === 0;
  });
}

/** The customer's own grammar names a destination that is not Tashkent. */
export function namesDestinationForm(line: string): boolean {
  return uzbekDestination(line) || otherDestination(line) || hanDestination(line) || persianDestination(line);
}

/**
 * Does any of these lines name a city, region or country other than Tashkent (§1.8)? Read over everything the
 * customer wrote in the window the rules read and the burst (run.ts `memoryFor`) — never our own lines: «narx
 * Toshkentgacha» is ours, and «Andijonga ham yetkazamiz» in a fact is no customer's destination.
 */
export function namesForeignPlace(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const t = line.normalize('NFKC');
    return PLACE.test(t) || namesDestinationForm(t);
  });
}
