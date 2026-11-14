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
 *
 * A LIST, and nothing else (fix pass 4, the readers' corpus — tests/unit/fixtures/agent-reader-corpus.ts). Fix pass 3
 * read the customer's grammar too — «<origin>dan X-ga», «из … в X», «from … to X», «到X», «به X» — to catch a place no
 * list holds, and the slot is an open lexicon: time words («qachongacha», «yangi yilgacha», «до Нового года», «到现在»),
 * pronouns and possessives («bizgacha», «firmangizga», «в Ваш склад», «به من»), Tashkent's own districts in two words or
 * a Russian spelling («Mirzo Ulug'bek tumaniga», «в Юнусабад»), everyday nouns («sotuvga», «magazinga») — every one held
 * an ordinary Tashkent quote, and no exclusion list ends either. The gate already demands that an estimate reply say
 * «Toshkentgacha» (`destination_unsaid`), so a destination this list misses gets an EXPLICIT Tashkent price, never a
 * silent wrong one: this check is defence in depth, and a missed exotic destination is the stated risk. Every place a
 * check named is on the list; a new one is added here, by name.
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
  // …the Andijan region's district towns, where the company has a warehouse of its own (fix pass 7, the check #10).
  // «Marhamat» is «please» and «Baliqchi» a fisherman: those two only in a place's own form (`ENDED`).
  'qorasuv', 'қорасув', 'корасув', 'xonobod', 'хонобод', 'ханабад', `oltinko${A}l`, 'олтинкўл', 'олтинкул', 'алтынкул',
  `paytug${A}`, 'пайтуғ', 'пайтуг', 'izboskan', 'избоскан', `qo${A}rg${A}ontepa`, 'қўрғонтепа', 'кургантепа', 'кургонтепа',
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
  // …and Kara-Suu, Naryn (fix pass 7, the check #10; Talas below).
  'kara-?\\s?suu', 'кара-?\\s?суу', 'карасуу', 'карасу', 'naryn', 'нарын', 'norin', 'норин',
  // Tajikistan.
  'tojikisto?n', 'тожикисто?н', 'таджикистан', 'tajikistan',
  'dushanbe', 'душанбе',
  `xo${A}jand`, 'хўжанд', 'худжанд', 'khujand', 'xujand',
  'bokhtar', 'бохтар', 'kulob', 'кулоб', 'куляб', 'istaravshan', 'истаравшан', 'panjakent', 'панджакент', 'пенджикент',
  // Afghanistan.
  `afg${A}onisto?n`, 'афғонисто?н', 'афганистан', 'afghanistan',
  'kobul', 'кобул',
  `mozori${A}?\\s*sharif`, 'мазари-?\\s*шариф', 'mazar-?i-?\\s*sharif', 'mazari\\s*sharif',
  // …and the Afghan hub as people write it (fix pass 7, the check #10): «Mazar-e Sharif», «Mazar», «Mozor», «Мазар»,
  // and Afghanistan in short — «Afg'on», «Афган».
  'mazar', 'мазар', 'mozor', 'мозор', `afg${A}on`, 'афғон', 'афгон', 'афган',
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
  // …and every place the check of that pass named (fix pass 4), now that the list is the whole reader: Azerbaijan and
  // Baku («Боку» is the Uzbek, and only with its endings — «на боку» is «on its side»), Minsk, Moldova, Temirtau, Abu
  // Dhabi, Isfahan, Kazan (Russian «Казань» with its «ь» — «казан» is a cauldron, and goods).
  `ozarbayjon`, 'озарбайжон', 'азербайджан', 'azerbaijan', 'azerbayjan',
  // …and the hunt over pass 5 (fix pass 6, #8): Iran and Turkey themselves beside their listed cities, Balkh, and the
  // usual h-for-x and u-for-o spellings of listed places («Buhoroga», «Fergonaga», «Qashqadaryaga», «Kukonga», «Horazm»).
  'eron', 'iran', 'иран', 'ерон', 'turkiy', 'turkey', 'турци', 'туркия',
  'balkh', 'balx', 'балх',
  'buhoro', 'bukhoro', 'buhara', 'fergon', 'qashqadar', 'kashkadar', 'қашқадар', 'кашкадар', 'ku[kq]on', 'horazm', 'hiva',
  'baku', 'баку',
  'minsk', 'минск', 'belarus', 'беларус',
  'moldov', 'молдов',
  'temirtau', 'темиртау',
  'abu-?\\s?dab', 'абу-?\\s?даб',
  'isfahan', 'esfahan', 'исфахан',
  'казань',
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
/** The place's ending, glued — or after a space, an apostrophe or a hyphen (fix pass 6, the hunt #8: «Qarshi ga», «Osh-ga»). */
const SEP = "[\\s'’ʻ`-]?";
const ENDED: readonly string[] = [
  // «qarshi» is «against».
  // …or with its abbreviation, «uchun», «tomon», a preposition or «г.» before it (fix pass 3: «Qarshi uchun», «Qarshi
  // sh.ga», «в г. Карши», «to Qarshi» were no place).
  `qarshi(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN}|\\s+sh\\.\\p{L}*|\\s+(?:uchun|tomon\\p{L}*))`, `қарши(?:${SEP}(?:га|гача|дан|да|нинг)|${TOWN_CYRL}|\\s+(?:учун|томон\\p{L}*))`, `карши(?:${SEP}(?:га|гача|дан|да)|${TOWN_CYRL})`,
  `(?:в|до|из|на|для)\\s+(?:г\\.?\\s*|город\\p{L}*\\s+)?карши`, '(?<![\\p{L}])г\\.\\s*карши', '(?:to|in|for)\\s+qarshi', 'karshi',
  // «osh» is the dish.
  // «O‘sh» is how Uzbek spells it — and «o‘sha» is «that», so only with the place's own endings; English and Russian
  // name it after a preposition («to Osh», «на Ош», «в г. Ош»), or after «г.» (fix pass 3).
  `osh(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN})`, `o${A}sh(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN})`, `ўш(?:${SEP}(?:га|гача|дан|да)|${TOWN_CYRL})?`, `ош(?:${SEP}(?:га|гача|дан)|${TOWN_CYRL})`,
  '(?:в|до|из|на|для)\\s+(?:г\\.?\\s*|город\\p{L}*\\s+)?ош[аеу]?', '(?<![\\p{L}])г\\.\\s*ош[аеу]?', '(?:to|in|for)\\s+osh',
  // «Chust» is a skullcap's and a knife's name too («Chust do'ppi») — the town only with its place endings or after a
  // preposition (fix pass 4: «Yiwudan Toshkentga emas, Chustga», «доставка в Чуст»).
  `chust(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN})`, `чуст(?:${SEP}(?:га|гача|дан|да|нинг)|${TOWN_CYRL})`, '(?:в|до|из|на|для)\\s+(?:г\\.?\\s*|город\\p{L}*\\s+)?чуст[аеу]?',
  // …the bare name after an address or city LABEL («Manzil: Qarshi», «Адрес: Ош», «Город: Ош», «Address: Osh»), and the
  // adjective («Ошская область») — fix pass 6, the hunt #8.
  `(?:manzil|shahar|shahri|address|city|адрес|город|манзил|шаҳар|шахар)\\p{L}*\\s*[:–—-]\\s*(?:qarshi|osh|o${A}sh|chust|қарши|карши|ош|ўш|чуст)`,
  '(?:ошск|каршинск|чустск)\\p{L}*',
  // «Boku», «Боку» — Baku in Uzbek — only with an ending; «Kazan» only after «to»/«in» (a «qozon» is a cauldron).
  `boku(?:ga|gacha|dan|da)`, `боку(?:га|гача|дан|да)`, '(?:to|in)\\s+kazan',
  // «Navoiy ko'chasi» is a street in every town.
  `navoiy?(?:ga|gacha|dan|da|ning)?(?![\\p{L}])(?!\\s*(?:ko${A}ch|кўч|коч|ул|str|прос|shoh|шоҳ))`,
  `навои[йи]?(?:га|гача|дан|да|нинг)?(?![\\p{L}])(?!\\s*(?:кўч|коч|ул|прос|шоҳ))`,
  // «Marhamat» is «please», «baliqchi» a fisherman — the Andijan towns only with a place's ending (fix pass 7).
  `marhamat(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN})`, `марҳамат(?:${SEP}(?:га|гача|дан|да|нинг)|${TOWN_CYRL})`, `мархамат(?:${SEP}(?:га|гача|дан|да)|${TOWN_CYRL})`,
  `baliqchi(?:${SEP}(?:ga|gacha|dan|da|ning)|${TOWN})`, `балиқчи(?:${SEP}(?:га|гача|дан|да|нинг)|${TOWN_CYRL})`, '(?:в|до|из)\\s+балыкчи',
  // «talash» is a quarrel: Talas only as itself or with its own ending.
  `talas(?:${SEP}(?:ga|gacha|dan|da|ning))?`, 'талас(?:а|е|у|ом|га|гача|дан|да)?',
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
  '德黑兰', '马什哈德', '伊斯坦布尔', '迪拜', '巴库', '阿塞拜疆', '明斯克', '喀山', '阿布扎比', '伊朗', '土耳其',
];
const PERSIAN: readonly string[] = [
  'اندیجان', 'نمنگان', 'فرغانه', 'سمرقند', 'بخارا', 'ترمذ', 'خوقند', 'خوارزم', 'جیزخ',
  'قزاقستان', 'آلماتی', 'الماتی', 'آستانه', 'شیمکنت', 'قرقیزستان', 'بیشکک', 'تاجیکستان', 'خجند',
  'افغانستان', 'کابل', 'مزار\\s*شریف', 'مزارشریف', 'هرات', 'قندهار', 'قندوز', 'حیرتان',
  'خیوه', 'ترکمنستان', 'عشق\\s*آباد', 'روسیه', 'مسکو',
  'تهران', 'مشهد', 'استانبول', 'دبی',
  'اصفهان', 'باکو', 'آذربایجان', 'مینسک',
  // fix pass 6, the hunt #8: Iran and Turkey, and the Afghan cities his Persian-writing customers name.
  'ایران', 'ترکیه', 'بلخ', 'جلال\\s*آباد', 'کندز', 'شبرغان', 'پلخمری', 'غزنی',
  // fix pass 7, the check #10: Iran's cities and Afghanistan's, in Persian — and «مزار» alone. «رشت», «قم», «یزد», «خوست»
  // end their word: «رشته» is a noodle.
  'شیراز', 'تبریز', 'کرج', 'بندر[\\s\\u200c]*عباس', 'اهواز', 'کرمانشاه', 'کرمان', 'همدان', 'ارومیه', 'زاهدان', 'سرخس',
  'قم(?![\\p{L}])', 'یزد(?![\\p{L}])', 'رشت(?![\\p{L}])', 'مزار',
  'فیض[\\s\\u200c]*آباد', 'تالقان', 'میمنه', 'بامیان', 'خوست(?![\\p{L}])', 'سمنگان', 'سر[\\s\\u200c]*پل', 'اندخوی', 'آقچه',
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
 * The route as a customer writes it — «Иу — Ош», «Yiwu-Qarshi», «Yiwu → Osh»: the places whose bare word is something
 * else too (`ENDED`), named bare right after the place the cargo starts from, are the destination. A list's names only:
 * the route's other end is never read as a place by its shape (fix pass 4).
 */
const ROUTE_BARE = /^\s*(?:[-–—>→]+|->)\s*(?:o['‘’ʻʼ`´]?sh|ош|ўш|qarshi|қарши|карши|chust|чуст)(?![\p{L}])/iu;
function namesRoute(line: string): boolean {
  return chinaMentions(line).some(({ index, match }) => ROUTE_BARE.test(line.slice(index + match.length)));
}

/**
 * Does any of these lines name a city, region or country other than Tashkent (§1.8)? Read over everything the
 * customer wrote in the window the rules read and the burst (run.ts `memoryFor`) — never our own lines: «narx
 * Toshkentgacha» is ours, and «Andijonga ham yetkazamiz» in a fact is no customer's destination.
 */
export function namesForeignPlace(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const t = line.normalize('NFKC');
    return PLACE.test(t) || namesRoute(t);
  });
}
