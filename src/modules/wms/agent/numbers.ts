import {
  CURRENCY_AFTER_SRC,
  CURRENCY_BEFORE_SRC,
  CURRENCY_LABEL,
  currenciesNamed,
  currencyOf,
  MONEY_WORD,
  normalizeDigits,
  type Currency,
} from './digits';

/**
 * G1 by KIND and SOURCE (review money-1).
 *
 * The first design asked whether a number's VALUE was in a set of «allowed»
 * values — and the set held the persona phone's 998/95/018, the kb's street
 * numbers and the customer's own «90 qilib bering», so any of them could be
 * printed beside «$» as a price and pass. A number is now read with the word
 * beside it: money, a measure, a duration, a date, a count, a percent, or a
 * bare figure. A MONEY number passes only when a MONEY source of this run
 * holds it (the yo'lkira tool's figure, the customer's own balance, the offer
 * he typed); a measure only from a measure source (the customer's message, a
 * tool); and so on. Phones and approved links are taken out WHOLE before any
 * of this, so their digits are never figures.
 *
 * Pure. Every card prints the ledger this builds — each figure beside the
 * source that let it through — so the owner sees what he is approving.
 *
 * The review measured the word-beside rule failing three ways (P1): a
 * currency of more than one word («90 AQSH dollari», «300 US dollars») or one
 * it did not list («480 евро», «480 RMB», «480 у.е.») left the figure bare; a
 * figure GLUED to its currency («USD480», «Jami-480$») was skipped as a code;
 * and a figure whose currency sat elsewhere in the sentence («Narx (dollarda):
 * 480») was bare too — and a bare figure passes on the customer's own «480 kg».
 * So a currency is read in every spelling and glued as well as spaced, a scale
 * word is part of its figure («1,5 mln so'm» is 1 500 000), and in a text that
 * names money ANYWHERE every bare figure is money: in a reply it then needs a
 * money source, in a customer's or a fact's text it is `customer_money` and
 * vouches for nothing.
 */

export type NumberKind = 'money' | 'measure' | 'duration' | 'date' | 'count' | 'percent' | 'plain';

export interface FoundNumber {
  raw: string;
  value: number;
  kind: NumberKind;
  index: number;
  /**
   * A money figure's currency (K16): the one its spelling names, else the
   * one its text names, else dollars — every tool states dollars. Null =
   * nothing here can say which (two currencies named, a spelling with no
   * code), and such a figure matches no source.
   */
  currency?: Currency | null;
  /** Said per unit — «$/kub», «kilosiga 17», «за кг», «per kg» (K21): only a tool's RATE vouches for it. */
  perUnit?: boolean;
  /** Its FORM says what it is (an ordinal, an hour, a clock) — never read as money. */
  fixed?: boolean;
  /** A measure's or a day count's unit, when its word says one — «1 kub» is no «1 kg» (`FigureUnit`). */
  unit?: FigureUnit;
}

/**
 * The unit a measure or a duration is written in. A source that names one
 * vouches only for a figure in it (review): the company rule's «1 kub» stood
 * behind «Mashina uchun eng kamida 1 kg kerak», its «100 kg» behind «Sizning
 * 100 ta karobkangiz omborga keldi», the flight's «2 kun» behind «Narxni 2
 * soatda hisoblab beraman».
 */
export type FigureUnit = 'm3' | 'kg' | 'tonne' | 'm2' | 'day' | 'week' | 'month' | 'hour' | 'minute';

/**
 * What a money source IS (K21): the price of the whole load, a per-unit rate,
 * or the customer's balance. The yo'lkira tool gives a total and a rate, and
 * the rate of 110 $/kub vouched for «3 kub uchun taxminan 110 $» — the price
 * of three cubes quoted at the price of one. Absent = a total.
 */
export type MoneyRole = 'total' | 'rate' | 'balance';

/**
 * Who said a figure (policy review B3): a tool of this run, an approved kb
 * fact, or the customer. Without it a customer's own «5 kunda kelsinmi?»
 * backed the reply's «Odatda 5 kunda yetib keladi» — his wish, worded as our
 * estimate, passed G1 — and a fact's «15–25 kun» could not be told from his.
 */
export type SourceOrigin = 'tool' | 'kb' | 'customer';

export interface NumberSource {
  value: number;
  /** The kind this source vouches for. A customer's money figure is never a money source (`customer_money`). */
  kind: NumberKind | 'customer_money';
  /** Shown on the card's «🔢 Raqamlar» line. */
  label: string;
  /**
   * Absent reads as the CUSTOMER's — fails closed. Optional only because a
   * memory stored before B3 carries none, and the 💵 draft (calc-loop.ts),
   * whose words are his and never pass `checkAgentReply`, still writes one
   * without it.
   */
  origin?: SourceOrigin;
  /** A money source's currency (K16). Absent = dollars, which every tool states. */
  currency?: Currency;
  /** A money source's role (K21). Absent = a total. */
  role?: MoneyRole;
  /**
   * The figure's FORM says what it is — an hour, a clock, an ordinal, a
   * numbered thing (`FoundNumber.fixed`). A customer's fixed figure vouches
   * for the same fixed figure in a reply (fix round): «soat 10 da olib
   * ketaman» → «ertaga soat 10 da kutamiz», «Buyurtma raqamim 4521» →
   * «4521 raqamli buyurtmangiz» — never for a bare one.
   */
  fixed?: boolean;
  /**
   * The road a DURATION is the time of (fix round): the avia tool's and the
   * avia fact's «2–5 kun» are a flight's, the website's and the transit
   * fact's «15–25 kun» a truck's. Every chat's memory carries both seeded
   * facts, so without it «Odatda mashina bilan 5 kunda yetib keladi» was
   * backed by the AVIA fact's five. Absent = said of no road in particular.
   */
  mode?: TravelMode;
  /** The unit it is said in; absent = any (the customer's, the tools', a fact's bare figure). */
  unit?: FigureUnit;
  /**
   * The one SHAPE of sentence it vouches for (second review): the company's minimum is a source for «eng
   * kamida 100 kg», «Минимум — 1 куб», «от 1 кг», «1 kg dan qabul qilamiz» (`saidAsMinimum`) — never for «Sizning
   * 100 kg yukingiz Toshkentga yetib keldi», a weight nobody stated. Absent = any sentence.
   */
  said?: 'minimum';
}

/** How cargo travels — the three roads a day count can be the time of. */
export type TravelMode = 'air' | 'road' | 'rail';

/**
 * The words that name each road, in the six languages. «Avto» and «авто» are
 * the road's — but not «avtomat», «автор». A truck carries goods that are
 * machines too («kir yuvish mashinasi»); that reads as the road, which can
 * only make a flight's figure unusable, never the reverse. English «air» on
 * its own is a PRODUCT here far more often than a road — «air fryer», «air
 * conditioner», «Air Max» — and it counts only as «air freight», «air
 * cargo», «by air»; «aviator» is sunglasses. A bare «kargo» / «карго» is the
 * COMPANY («kargongiz», «kargo manzili», «Kargo narxini ayting»), never a road
 * — it once turned an avia follow-up into the truck's and ended the rail rule
 * (review #1538) — so only «oddiy / yig'ma kargo», «kargo bilan», «kargoda»,
 * «обычным карго» NAME it (#1539: «Kargo bilan necha kunda?» asks the truck's
 * time), and only the first two CHOOSE it: «kargo orqali avia yuboraman» is the
 * company the flight goes through (#1540). «Aviamodel» is a toy.
 */
const MODE_WORDS: Record<TravelMode, RegExp> = {
  air: /(?<![\p{L}])(?:avi(?:y)?a(?!tor|model)\p{L}*|avya\p{L}*|ави[ао](?!тор|модел)\p{L}*|sam[ao]l[yi]?[oe]t\p{L}*|сам[оа]л[её]т\p{L}*|sam[ao]l[yi]?[oe]t(?:da|ga)|sam[ao]l[yi]?[oe]t\s+(?:bilan|orqali)|сам[оа]л[её]т(?:ом|да|га|е)|сам[оа]л[её]т\s+(?:билан|орқали|оркали)|на\s+сам[оа]л[её]те|воздухом|air(?:freight|cargo)|air[\s-]+(?:freight\p{L}*|cargo|ship\p{L}*|deliver\p{L}*|mail|transport\p{L}*|express|parcel\p{L}*)|air[\s-]?(?:freighted|shipped)|(?:by|via)\s+air|(?:by|via|with|on)\s+(?:an?\s+)?(?:air)?plane|air(?=\s*(?:please|pls|plz)(?![\p{L}]))|flights?|по\s+воздуху|воздушн\p{L}*\s+(?:пут\p{L}*|транспорт\p{L}*|доставк\p{L}*)|[hx]avo\s+(?:yo['‘’ʻ`]?l\p{L}*|orqali|transport\p{L}*)|[ҳх]аво\s+(?:й[ўу]л\p{L}*|орқали|оркали)|plane)(?![\p{L}])|هوایی|هواپیما|با\s+(?:هواپیما|طیاره|طياره)|هوا[یي]ی|هوائی|ایر\s*کارگو|空运|空運|空派|空快|空邮|航空|航班|(?:走|坐|用)飞机|飞机(?:运|发|寄)|飞机/iu,
  road: /(?<![\p{L}])(?:mashina\p{L}*|avto(?![mr])\p{L}*|avtomobil\p{L}*|fura\p{L}*|машин\p{L}*|авто(?![мр])\p{L}*|автомобил\p{L}*|фур[аыуе]\p{L}*|(?:oddiy|yig['‘’ʻ`]?ma|sborniy|umumiy)\s+kargo\p{L}*|(?<!(?:avia|авиа)[\s-]{1,3})kargo(?:da|\s+(?:bilan|orqali))|(?:обычн|сборн)\p{L}*\s+карго\p{L}*|trucks?|trucking|by\s+road|road\s+freight)(?![\p{L}])|کامیون|زمینی|汽运|陆运|卡车|汽车/iu,
  rail: /(?<![\p{L}])(?:temir\s*yo['‘’ʻ`]?l\p{L}*|poyezd\p{L}*|темир\s*йўл\p{L}*|поезд\p{L}*|железн\p{L}*\s+дорог\p{L}*|ж\/д|rail\p{L}*|trains?)(?![\p{L}])|قطار|راه\s*آهن|铁路|火车/iu,
};

/** Whether a text names this road — in any of the six languages. */
export function namesMode(text: string, mode: TravelMode): boolean {
  return MODE_WORDS[mode].test(text);
}

/** The one road a text names, or null — none, or more than one. */
export function oneModeIn(text: string): TravelMode | null {
  const named = (Object.keys(MODE_WORDS) as TravelMode[]).filter((m) => MODE_WORDS[m].test(text));
  return named.length === 1 ? named[0]! : null;
}

/** The stretch of `text` around `index` that `boundary` closes on both sides. */
function spanAt(text: string, index: number, boundary: RegExp): string {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    if (m.index + m[0].length <= index) start = m.index + m[0].length;
    else if (m.index >= index) {
      end = m.index;
      break;
    }
  }
  return text.slice(start, end);
}

// A comma or a dash between two digits is inside a figure («1,5», «15–25»), not between clauses.
const FIGURE_CLAUSE = /(?<!\d)[,—–]|[,—–](?!\d)|[;:!?؟。！？\n]+|\.(?=\s|$)|\s-\s/gu;
const FIGURE_SENTENCE = /[!?؟。！？\n]+|\.(?=\s|$)/gu;

/**
 * A figure's road: the one its clause names, else its sentence's, else the road the text named LAST BEFORE it — or
 * null. The text's one road read anywhere (third review) took a road named AFTER the figure, in a sentence of its
 * own: «Eng kamida 1 kub yoki 100 kg qabul qilamiz. Avia orqali ham yuborish mumkin», «The minimum is 1 m3 or 100
 * kg. Air freight is also available» — the canonical answer to «what is your minimum?» — read the truck's minimum
 * as the flight's and refused it. A road named before it is the topic the figure stands in: «Avia orqali
 * yuboramiz. Eng kamida 1 kg» is the flight's.
 */
function modeAt(text: string, index: number): TravelMode | null {
  return oneModeIn(spanAt(text, index, FIGURE_CLAUSE)) ?? oneModeIn(spanAt(text, index, FIGURE_SENTENCE)) ?? lastModeBefore(text, index);
}

/** The road whose word stands nearest before `index`, or null. */
function lastModeBefore(text: string, index: number): TravelMode | null {
  const before = text.slice(0, index);
  let best: { mode: TravelMode; end: number } | null = null;
  for (const mode of Object.keys(MODE_WORDS) as TravelMode[]) {
    const every = new RegExp(MODE_WORDS[mode].source, `${MODE_WORDS[mode].flags.replace('g', '')}g`);
    for (const m of before.matchAll(every)) {
      const end = m.index + m[0].length;
      if (best === null || end > best.end) best = { mode, end };
    }
  }
  return best?.mode ?? null;
}

/**
 * «Eng kamida», «eng oz», «kamida», «minimal», «… va undan ko'p», «минимум», «не менее», «… и более», «at least»,
 * «… or more» — a minimum said anywhere in a figure's
 * sentence; and its threshold, «меньше», «менее», «less than», «under», «kamroq» (third review): «Если меньше 1
 * куба или 100 кг, то не принимаем» is the minimum said the other way round.
 */
const MINIMUM_WORD =
  /(?<![\p{L}])(?:eng\s+(?:kam(?:ida)?|oz)|kamida|kamdan[\s-]kam|kamroq|minimum\p{L}*|minimal\p{L}*|энг\s+(?:кам(?:ида)?|оз)|камида|камроқ|минимум\p{L}*|минимальн\p{L}*|не\s+менее|не\s+меньше|меньше|менее|at\s+least|less\s+than|under|(?:va|ва)\s+(?:undan|ундан)\s+(?:ko['‘’ʻ`]?p(?:roq)?|ortiq|yuqori|кўп(?:роқ)?|ортиқ|юқори)|и\s+(?:более|больше|выше)|(?:or|and)\s+(?:more|above|over))(?![\p{L}])/iu;
/**
 * …or the figure's own «from»: «от 1 кг», «from 1 kg» before it, «1 kg dan», «1 kubdan» after its unit — and over
 * a pair (third review): «Biz 1 kub yoki 100 kg dan qabul qilamiz», «Принимаем от 1 куба или 100 кг», «We accept
 * from 1 m3 or 100 kg» say one «from» for both figures, and the one without its own marker was refused.
 */
const MIN_UNIT = '(?:kub|kg|kilo|куб|кг|кило|m3|м3|cbm)\\p{L}*?';
const FROM_BEFORE = new RegExp(
  `(?<![\\p{L}])(?:от|from)\\s*(?:\\d+(?:[.,]\\d+)?\\s*${MIN_UNIT}\\s+(?:или|либо|и|or|and)\\s*)?$`,
  'iu',
);
const FROM_AFTER = new RegExp(
  `^\\s*${MIN_UNIT}\\s*(?:(?:yoki|va|ёки|ва)\\s+\\d+(?:[.,]\\d+)?\\s*${MIN_UNIT}\\s*)?(?:dan|дан)(?![\\p{L}])`,
  'iu',
);

/**
 * A minimum is said of what the company TAKES (third review), never of cargo that came: one hedge word made a
 * fabricated status the company's own — «Yukingizdan kamida 100 kg Toshkentga yetib keldi», «100 kg dan ortiq
 * yukingiz Toshkentga yetib keldi», «Груз от 100 кг уже прибыл в Ташкент» each passed on the 100 kg minimum.
 * So a sentence that says cargo arrived or stands somewhere is no minimum's; nor a clause about the customer's
 * own cargo, unless it states the condition or the obligation the minimum is — «Agar yukingiz 1 kub yoki 100 kg
 * dan kam bo'lsa», «Yukingiz kamida 1 kub bo'lishi kerak» — or our taking it in.
 */
const ARRIVED = new RegExp(
  [
    `(?<![\\p{L}])(?:kel(?:di|gan|ibdi)|tush(?:di|gan)|yetkazildi|keltirildi|topshirildi|turibdi|qabul\\s+qilin(?:di|gan))(?![\\p{L}])`,
    '(?<![\\p{L}])(?:кел(?:ди|ган|ибди)|туш(?:ди|ган)|етказилди|келтирилди|топширилди|турибди|қабул\\s+қилин(?:ди|ган))(?![\\p{L}])',
    '(?<![\\p{L}])(?:прибыл[аои]?|пришл[аои]|пришёл|пришел|доставлен[аоы]?|получен[аоы]?|поступил[аои]?|приехал[аои]?|дош[её]л|дошл[аои]|лежит|наход(?:ит|ят)ся)(?![\\p{L}])|уже\\s+(?:на\\s+склад\\p{L}*|в\\s+ташкент\\p{L}*|здесь)',
    "(?<![\\p{L}])(?:arrived|came\\s+in|reached|landed|(?:has|have)\\s+come|(?:was|were|been)\\s+delivered|(?:is|are)\\s+(?:here|in\\s+(?:the\\s+)?warehouse|in\\s+tashkent))(?![\\p{L}])",
  ].join('|'),
  'iu',
);
const HIS_CARGO =
  /(?<![\p{L}])(?:yuk(?:lar)?ingiz\p{L}*|юк(?:лар)?ингиз\p{L}*|ваш\p{L}*\s+(?:груз|товар|посылк)\p{L}*|your\s+(?:cargo|goods|shipment|parcel|order|boxes))/iu;
const MIN_SHAPE =
  /(?<![\p{L}])(?:agar|агар|если|if|kerak|керак|shart|шарт|lozim|лозим|должн\p{L}*|нужно|надо|must|need\p{L}*|should|has\s+to|qabul|қабул|olamiz|оламиз|принима\p{L}*|берём|берем|accept\p{L}*|take)(?![\p{L}])|bo['‘’ʻ`]?l(?:sa|ishi)(?![\p{L}])|бўл(?:са|иши)(?![\p{L}])/iu;

/** A figure said as a MINIMUM — the only shape the company's minimum vouches for (`NumberSource.said`). */
export function saidAsMinimum(text: string, index: number, end: number): boolean {
  const sentence = spanAt(text, index, FIGURE_SENTENCE);
  const marked =
    MINIMUM_WORD.test(sentence) ||
    FROM_BEFORE.test(spanAt(text.slice(0, index), index, FIGURE_CLAUSE)) ||
    FROM_AFTER.test(text.slice(end));
  if (!marked || ARRIVED.test(sentence)) return false;
  return !HIS_CARGO.test(spanAt(text, index, FIGURE_CLAUSE)) || MIN_SHAPE.test(sentence);
}

/** The two roads a person can CHOOSE between in a chat about price; rail is his, never the machine's. */
export type ChosenRoad = 'air' | 'road';

/**
 * A road CHOSEN in a statement (review #1538) — its word in a form that picks
 * the road: «avia bilan», «aviada», «mashinada», «fura», «avto bilan», «oddiy
 * kargo», «машиной», «by truck», «空运», a «Mashina» standing alone. Never the
 * goods («tikuv mashinasi», «avto chexol», «avtozapchast», «toy trucks»,
 * «samolyot o'yinchoq», «aviator ko'zoynak», «air fryer»), and never the
 * company («kargongiz»). It answers only the question «which road
 * is this chat on» (`chatRoadOf`, the receiving-fact test); a figure's road
 * keeps the wider `MODE_WORDS`, where a machine read as the road can only make
 * a flight's figure unusable.
 */
const CHOICE_WORDS: Record<ChosenRoad, RegExp> = {
  air: /(?<![\p{L}])(?:avi(?:y)?a(?!tor|model)\p{L}*|avya\p{L}*|ави[ао](?!тор|модел)\p{L}*|sam[ao]l[yi]?[oe]t(?:da|ga)|sam[ao]l[yi]?[oe]t\s+(?:bilan|orqali)|сам[оа]л[её]т(?:ом|да|га|е)|сам[оа]л[её]т\s+(?:билан|орқали|оркали)|на\s+сам[оа]л[её]те|воздухом|air(?:freight|cargo)|air[\s-]+(?:freight\p{L}*|cargo|ship\p{L}*|deliver\p{L}*|mail|transport\p{L}*|express|parcel\p{L}*)|air[\s-]?(?:freighted|shipped)|(?:by|via)\s+air|(?:by|via|with|on)\s+(?:an?\s+)?(?:air)?plane|air(?=\s*(?:please|pls|plz)(?![\p{L}]))|flights?|по\s+воздуху|воздушн\p{L}*\s+(?:пут\p{L}*|транспорт\p{L}*|доставк\p{L}*)|[hx]avo\s+(?:yo['‘’ʻ`]?l\p{L}*|orqali|transport\p{L}*)|[ҳх]аво\s+(?:й[ўу]л\p{L}*|орқали|оркали))(?![\p{L}])|با\s+(?:هواپیما|طیاره|طياره)|هوا[یي]ی|هوائی|ایر\s*کارگو|空运|空運|空派|空快|空邮|航空|航班|(?:走|坐|用)飞机|飞机(?:运|发|寄)/giu,
  road: /(?<![\p{L}])(?:(?:mashina|fura|avto|avtomobil)(?:da|ga)|(?:mashina|fura|avto|avtomobil)\s+(?:bilan|orqali)|(?<!\p{L}\s+)fura(?=\s*[.,!?]|\s*$)|furalar\s+bilan|(?:avto|oddiy|yig['‘’ʻ`]?ma|sborniy|umumiy)\s+kargo\p{L}*|(?:mashina|avto|fura)(?:ni)?\s+(?:bo['‘’ʻ`]?lsin|tanla\p{L}*)|(?<!\p{L}\s+)(?:mashina|avto)(?=\s*[.,!?]|\s*$)|машиной|на\s+машине|(?:давайте|лучше)\s+машин\p{L}*|(?<!\p{L}\s+)машин[уа](?=\s*[.,!?]|\s*$)|фурой|фурами|на\s+фуре|(?:давайте|лучше)\s+фур\p{L}*|(?<!\p{L}\s+)фур[ау](?=\s*[.,!?]|\s*$)|на\s+авто|автомобилем|(?:обычн|сборн)\p{L}*\s+карго\p{L}*|by\s+(?:truck|road)|truck(?:ing)?\s+(?:freight|delivery|shipping)|trucking|road\s+freight)(?![\p{L}])|با\s+کامیون|(?:ارسال|حمل|بار)\s+زمینی|زمینی\s+(?:بفرست\p{L}*|ارسال)|汽运|陆运|卡车运/giu,
};

/** The road words a refusal attaches to (the goods' «mashinasi» included: «mashinasi kerak emas» refuses nothing a person chose, and is read as nothing). */
const REFUSABLE: Record<ChosenRoad, string> = {
  air: String.raw`avi(?:y)?a(?!tor|model)\p{L}*|avya\p{L}*|ави[ао](?!тор|модел)\p{L}*|sam[ao]l[yi]?[oe]t\p{L}*|сам[оа]л[её]т\p{L}*|air(?:\s+(?:freight|cargo))?|by\s+air|flights?|по\s+воздуху|воздухом|[hx]avo\s+yo['‘’ʻ\u0060]?l\p{L}*|[ҳх]аво\s+й[ўу]л\p{L}*|هوا[یي]ی|هواپیما`,
  road: String.raw`mashina(?:da|ga)?|fura\p{L}*|avto(?:da|ga)?|avtomobil\p{L}*|машин\p{L}*|фур[аоеуы]\p{L}*|авто|trucks?|by\s+road|کامیون|زمینی`,
};
/**
 * «Aviada emas», «avia kerak emas», «avia qimmat ekan» (not «… qimmat emas»),
 * «mashinada uzoq ekan», «авиа не надо», «too expensive» — with a word or three
 * between them («Avia juda qimmat ekan», «Авиа нам не подходит», «Flights are
 * too expensive for us», #1539), never «avia bilan muammo yo'q». A refusal is
 * a whole word (#1540): «qimmatmi», «bo'lmaydimi», «ketmaydimi», «emasmi» ASK
 * about the road — and so does «qimmat ekanmi».
 */
const REFUSE_AFTER = String.raw`(?:\s+(?:narxi|ham|esa|bilan|orqali|juda|ancha|biz|bizga|menga|uchun|нам|мне|для|нас|is|are|for|us|очень|слишком|sal|ko['‘’ʻ\u0060]?p|it|takes?)){0,3}\s*,?\s*(?:kerak\s+emas|kerakmas|emas|shart\s+emas|(?<!muammo\s)yo['‘’ʻ\u0060]?q|qimmat(?:\s+ekan)?(?!\s+emas)|baland(?!\s+emas)|uzoq(?:\s+ekan)?(?!\s+emas)|sekin|to['‘’ʻ\u0060]?g['‘’ʻ\u0060]?ri\s+kelmaydi|bo['‘’ʻ\u0060]?lmaydi|ketmaydi|не\s+(?:надо|нужн\p{L}*|подходит|устраивает|интересует)|дорог\p{L}*|долго|не\s+успе\p{L}*|ulgurmay\p{L}*|kech\s+qol\p{L}*|ko['‘’ʻ\u0060]?p\s+vaqt(?:\s+ketadi)?|(?:too\s+)?(?:expensive|slow|long)|太贵|太慢|太久|来不及|不行|دیر|گرون\p{L}*)(?![\p{L}])(?!\s+\p{L}*mi(?![\p{L}]))`;
/** «Не авиа», «без авиа», «no air freight», «not by air». */
const REFUSE_BEFORE = String.raw`(?<![\p{L}])(?:не|без|нет|no|not|without|نه)\s+(?:by\s+|на\s+|через\s+)?`;
const refusalOf = (road: ChosenRoad, zh: string): RegExp =>
  new RegExp(
    `${REFUSE_BEFORE}(?:${REFUSABLE[road]})(?![\\p{L}])|(?<![\\p{L}])(?:${REFUSABLE[road]})${REFUSE_AFTER}|(?<![\\p{L}])(?:${road === 'air' ? 'avia|samolyot' : 'mashina|fura|avto'})siz(?![\\p{L}])|(?:不要|不用|别)(?:${zh})|(?:${zh})(?:太贵|太慢|太久|来不及|不行)`,
    'iu',
  );
const REFUSES: Record<ChosenRoad, RegExp> = { air: refusalOf('air', '空运|航空'), road: refusalOf('road', '汽运|陆运|卡车') };
/** Every refusal of `road` in a statement, as spans — what a choice word inside one is part of. */
const refusalSpans = (road: ChosenRoad, statement: string): [number, number][] =>
  [...statement.matchAll(new RegExp(REFUSES[road].source, 'giu'))].map((m) => [m.index, m.index + m[0].length]);
/**
 * Rail turned down in a statement (#1540) — «Poyezd kerak emas», «Temir yo'l
 * uzoq ekan», «Не поездом», read with the refusal words of the two roads: a
 * chat that turns rail down for the flight is the flight's, never his rail
 * question.
 */
const RAIL_REFUSABLE = String.raw`temir[\s-]?y[ou]['‘’ʻ\u0060]?l\p{L}*|po(?:ye|e|y)zd\p{L}*|темир[\s-]?й[ўу]л\p{L}*|поезд\p{L}*|железн\p{L}*\s+дорог\p{L}*|rail\p{L}*|trains?`;
const RAIL_REFUSED = new RegExp(`${REFUSE_BEFORE}(?:${RAIL_REFUSABLE})(?![\\p{L}])|(?<![\\p{L}])(?:${RAIL_REFUSABLE})${REFUSE_AFTER}`, 'iu');
export function railRefusedIn(statement: string): boolean {
  return !CHOSEN_ANYWAY.test(statement) && RAIL_REFUSED.test(statement);
}

/**
 * A road chosen IN SPITE of a word that sounds like a refusal (#1540): a
 * concession («Avia qimmat bo'lsa ham mayli», «Пусть авиа дорого», «даже если
 * дорого», «baribir avia»), a double negation («Без авиа никак», «Aviasiz
 * bo'lmaydi»), or a QUESTION about it («Авиа дорого выйдет?», «Is air freight
 * expensive?») — the road is being asked for, not turned down.
 */
const CHOSEN_ANYWAY =
  /(?<![\p{L}])(?:пусть|даже\s+если|хоть|хотя|even\s+if|even\s+though|hatto|garchi|baribir|всё\s+равно|все\s+равно|anyway)(?![\p{L}])|bo['‘’ʻ`]?lsa\s*(?:ham|-?da)(?![\p{L}])|ham\s+mayli|(?:без|without)\s+\p{L}+(?:\s+\p{L}+)?\s+(?:никак|нельзя|не\s+получится|no\s+way)|\p{L}+siz\s+(?:bo['‘’ʻ`]?lmaydi|iloji\s+yo['‘’ʻ`]?q|mumkin\s+emas)|[?？؟]\s*$/iu;
/**
 * A statement about ANOTHER leg (#1539): the factory or the supplier bringing
 * the goods to our warehouse («Zavod yukni mashinada olib keladi», «Поставщик
 * привезёт на машине», «工厂用卡车运到»), the pickup in Tashkent («Toshkentda
 * mashinaga ortib berasizlarmi?», «Toshkentdan olib ketaman»). A truck there
 * is not the road of this shipment; a flight never is a local leg, so the
 * flight is still read. Tashkent REACHED — «Toshkentga mashinada», «до
 * Ташкента» — is where this shipment goes, and its truck is chosen (#1540).
 * So is the leg to our warehouse or from the airport («Yukni omborga o'zim
 * mashinada olib boraman», «Сам привезу на склад на машине»), the delivery
 * inside Uzbekistan («Andijonga mashinada yetkazib berasizlarmi?») and a PAST
 * shipment («oldingi safar mashinada yuborgandim») (#1541).
 */
const OTHER_LEG =
  /zavod|fabrik|завод|фабрик|поставщик|postavshik|ta['‘’ʻ`]?minotchi|supplier|factory|vendor|工厂|厂家|供应商|(?:toshkent|тошкент)(?:da|dan|да|дан)(?![\p{L}])|в\s+ташкенте|из\s+ташкента|in\s+tashkent|from\s+tashkent|aeroport\p{L}*|аэропорт\p{L}*|airport|机场|omborga|omboringizga|skladga|skladingizga|на\s+склад|to\s+(?:your|the)\s+warehouse|你们仓库|到仓库|bozor\p{L}*|рын(?:ок|к\p{L}*)|market|olib\s+bor\p{L}*|привез\p{L}*|bring\s+it|yetkazib\s+ber\p{L}*|доставк\p{L}*\s+по|до\s+дома|uyga\p{L}*|oldingi|avvalgi|o['‘’ʻ`]?tgan\s+safar|прошл\p{L}*\s+раз|в\s+прошлый|раньше|last\s+time|previous|上次|以前/iu;
/** A sending verb — in «… ekan, avia bilan yuboraman» the road it follows is the one chosen. */
const SEND_VERB = /yubor|jo['‘’ʻ`]?nat|отправ|вышл|пошл|send|ship|寄|发/iu;

/**
 * The road one statement CHOOSES (review #1538): 'air' or 'road' when it picks
 * one; 'not_air' / 'not_road' when it only turns one down («Avia qimmat ekan»
 * — the flight refused, so the truck); 'both' when it compares them («avia va
 * mashinada qancha?»), unless one of the two is followed by the sending verb
 * («Fura 20 kun ekan, avia bilan yuboramiz»); null when no road is chosen.
 */
export function roadChoiceIn(statement: string): ChosenRoad | 'both' | 'not_air' | 'not_road' | null {
  // A concession, a double negation or a question chooses the road its refusal-sounding words name (#1540).
  const anyway = CHOSEN_ANYWAY.test(statement);
  const spans = { air: anyway ? [] : refusalSpans('air', statement), road: anyway ? [] : refusalSpans('road', statement) };
  const refused = { air: spans.air.length > 0, road: spans.road.length > 0 };
  // A choice word inside a refusal is the refusal's; one outside it is chosen («Avia qimmat, baribir avia»).
  const at = (road: ChosenRoad): number[] =>
    [...statement.matchAll(CHOICE_WORDS[road])]
      .filter((m) => !spans[road].some(([a, b]) => m.index >= a && m.index < b))
      .map((m) => m.index + m[0].length);
  const air = at('air');
  const road = OTHER_LEG.test(statement) ? [] : at('road');
  if (air.length && road.length) {
    const sends = (ends: number[]) => ends.some((e) => SEND_VERB.test(statement.slice(e, e + 25)));
    const a = sends(air);
    const r = sends(road);
    return a && !r ? 'air' : r && !a ? 'road' : 'both';
  }
  if (air.length) return 'air';
  if (road.length) return 'road';
  if (refused.air && !refused.road) return 'not_air';
  if (refused.road && !refused.air) return 'not_road';
  return null;
}

/** The clauses of `text`'s sentence around `index`, each with its start — a comma or dash between two digits is no clause break. */
function clausesOf(text: string, index: number): { text: string; start: number }[] {
  const sentence = spanAt(text, index, FIGURE_SENTENCE);
  const base = text.indexOf(sentence, Math.max(0, index - sentence.length));
  const out: { text: string; start: number }[] = [];
  let last = 0;
  for (const m of sentence.matchAll(FIGURE_CLAUSE)) {
    out.push({ text: sentence.slice(last, m.index), start: base + last });
    last = m.index + m[0].length;
  }
  out.push({ text: sentence.slice(last), start: base + last });
  return out;
}

/**
 * The road one clause of OUR line names: the road it chooses (a road turned
 * down is the other one — «Mashinada bo'lmaydi, 30 kg — 510 $» priced the
 * flight), else its LABEL — the road word it opens with («Mashina 1 kub
 * 250$», «Avto (mashina) narxi», «Avia: 30 kg»). Never a road word inside the
 * goods («o'yinchoq samolyotlar», «avtozapchast», «tikuv mashinasi», #1540).
 */
const LABEL = /^[\s(«"'*•\-–—]*(avto|mashina|fura|avia|авто|машина|фура|авиа|truck|air)(?![\p{L}])/iu;
function clauseRoad(clause: string): ChosenRoad | 'both' | null {
  const c = roadChoiceIn(clause);
  if (c) return c === 'not_air' ? 'road' : c === 'not_road' ? 'air' : c;
  const label = LABEL.exec(clause)?.[1]?.toLowerCase();
  if (!label) return null;
  return /^(?:avia|авиа|air)$/u.test(label) ? 'air' : 'road';
}

/** A price by the cube: the truck's (the flight is never priced by volume). */
const BY_THE_CUBE = /\d\s*(?:kub|куб|m³|m3|м³|cbm|立方)/iu;

/**
 * The road OUR priced line quoted (review #1538, #1539), read at each money
 * figure: its own clause, else the nearest clause before it in the sentence
 * that names a road («Mashinada 1 kubdan kam olinmaydi, faqat avia: 30 kg —
 * taxminan 510 $» quoted the flight; «Avto (mashina) narxi: 3 kub — taxminan
 * 640 $» the truck), else the nearest after it — never the sentence's last
 * statement («… power bank faqat avto bilan ketadi» priced nothing). A line
 * that prices by the cube with no road word is the truck's (the flight is
 * never priced by volume). Null: no price, or a price that names no road.
 */
export function pricedRoadOf(text: string): ChosenRoad | 'both' | null {
  const roads = new Set<ChosenRoad>();
  const money = extractNumbers(text).filter((f) => f.kind === 'money');
  for (const f of money) {
    const clauses = clausesOf(text, f.index);
    const at = Math.max(0, clauses.findLastIndex((c) => c.start <= f.index));
    // Its own clause by the cube is the truck's; the walk to its neighbours stops at another price (#1540).
    const own = clauses[at]!;
    const pricesElse = (c: { text: string; start: number }) =>
      money.some((g) => g !== f && g.index >= c.start && g.index < c.start + c.text.length);
    const walk = (cs: { text: string; start: number }[]) => {
      const out: { text: string; start: number }[] = [];
      for (const c of cs) {
        if (pricesElse(c)) break;
        out.push(c);
      }
      return out;
    };
    const order = [...walk(clauses.slice(0, at).reverse()), ...walk(clauses.slice(at + 1))];
    const road =
      clauseRoad(own.text) ??
      (BY_THE_CUBE.test(own.text) ? 'road' : null) ??
      order.map((c) => clauseRoad(c.text)).find((r) => r !== null) ??
      neighbourSentenceRoad(text, f.index) ??
      null;
    if (road === 'air' || road === 'both') roads.add('air');
    if (road === 'road' || road === 'both') roads.add('road');
  }
  if (roads.size === 2) return 'both';
  if (roads.size === 1) return [...roads][0]!;
  return money.length > 0 && BY_THE_CUBE.test(text) && !airMentionIn(text) ? 'road' : null;
}

/**
 * The road of the nearest OTHER sentence of our line that names one — «1 kg
 * uchun 17 $. Avia bilan 2–5 kunda keladi.» priced the flight (#1541). A
 * sentence that only says what a road does not carry («Avia orqali … yuborilmaydi»)
 * is no road named.
 */
function neighbourSentenceRoad(text: string, index: number): ChosenRoad | 'both' | null {
  const sentences: { text: string; start: number }[] = [];
  let last = 0;
  for (const m of text.matchAll(FIGURE_SENTENCE)) {
    sentences.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  sentences.push({ text: text.slice(last), start: last });
  const at = Math.max(0, sentences.findLastIndex((x) => x.start <= index));
  const others = sentences
    .map((x, k) => ({ ...x, d: Math.abs(k - at) }))
    .filter((x) => x.d > 0 && !PROHIBITS.test(x.text))
    .sort((a, b) => a.d - b.d);
  for (const x of others) {
    const r = statementsOf(x.text, FIGURE_CLAUSE).map(clauseRoad).find((y) => y !== null);
    if (r) return r;
  }
  return null;
}

/** A sentence that says what a road does NOT carry — the seeded «Avia orqali litiy batareya … yuborilmaydi». */
export const PROHIBITS =
  /yuborilmaydi|olib\s+kelinmaydi|ketmaydi|mumkin\s+emas|taqiqlan\p{L}*|нельзя|не\s+принима\p{L}*|не\s+перевоз\p{L}*|запрещ\p{L}*|not\s+allowed|prohibited|cannot\s+(?:be\s+)?(?:sent|shipped)|不能|禁止/iu;

/**
 * The flight is SPOKEN of in this text — chosen, asked about, or turned down
 * (#1539, #1540). Wider than a choice on purpose: it is what makes a China
 * address in a reply his question even when the chat's road could not be
 * decided (`avia_maybe`), and a refusal the words misread («Avia qimmatmi?»)
 * must still be seen. The flight's own words only, never the goods («o'yinchoq
 * samolyotlar», «aviamodel», «toy plane», «飞机»).
 */
// A choice, or a refusal — never the bare word, which is also the goods («o'yinchoq samolyotlar»).
const AIR_SPOKEN = new RegExp(`${CHOICE_WORDS.air.source}|${REFUSES.air.source}`, 'iu');
export function airMentionIn(text: string): boolean {
  return AIR_SPOKEN.test(text);
}

/**
 * The statements of a text, each with what ENDS it — the question mark a
 * refusal's reading turns on (#1540) — cut where `boundary` cuts.
 */
export function statementsOf(text: string, boundary: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(boundary.source, boundary.flags.replace('g', '') + 'g'))) {
    out.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((st) => st.trim() !== '');
}

export interface LedgerEntry {
  /** As the card prints it — a money figure with the currency it was READ in («330 $», «330 yuan»), K16. */
  raw: string;
  kind: NumberKind;
  /** The source that let it through, or null — a null is a G1 block. */
  source: string | null;
  /** A money figure's currency as read; null = none could be told. */
  currency?: Currency | null;
}

/** A phone in any spelling: an optional +, then ≥ 9 digits with spaces, dashes, dots or brackets between. */
export const PHONE_RE = /\+?\d(?:[\s\-.()]*\d){8,}/gu;

/** Digits only — how two phones are compared. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/gu, '');
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+\.(?:uz|ru|com|cn|net|org|io|me|app|ir|af)\/[^\s<>()]*/giu;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,!?)»]+$/u, ''));
}

/** «480 $», «480 AQSH dollari», and «500-dollarlik» — Uzbek hangs a case or suffix on a figure with a hyphen. */
const MONEY_AFTER = new RegExp(`^\\s*-?(?:${CURRENCY_AFTER_SRC})`, 'iu');
/** The currency touching the figure, no space: «480$», «480usd» — a glued figure is money, never a code. */
const MONEY_GLUED_AFTER = new RegExp(`^(?:${CURRENCY_AFTER_SRC})`, 'iu');
const MONEY_BEFORE = new RegExp(`(?:${CURRENCY_BEFORE_SRC})\\s*:?\\s*$`, 'iu');
/** The letters glued before a figure are a currency, not a code prefix: «USD480», «RMB480», «US480». */
const MONEY_GLUED_BEFORE = new RegExp(`(?:${CURRENCY_BEFORE_SRC}|(?<![\\p{L}])us)$`, 'iu');
/**
 * `\b` is an ASCII word edge even under `u`, so «кг\b» never matched before a space: «за 1 кг 17 $» read the
 * one kilo as MONEY in any text that names money (final review, met while reading K21's per-unit prices) —
 * and «cbm», how an English customer writes a cube, was no measure at all.
 */
const MEASURE_AFTER =
  /^\s*(?:kg\b|кг(?![\p{L}\d])|kilo\w*|кило\w*|kub\w*|куб\w*|cbm\b|cubic\s+met\w*|m3\b|м3(?![\p{L}\d])|m³|м³|m2\b|м2(?![\p{L}\d])|tonna\w*|тонн\w*|公斤|千克|吨|立方|کیلو\w*|متر\s*مکعب|کیلوگرم)/iu;
/**
 * The word a day count is written with. A working or a calendar day is a
 * day too (fix round): «5 ish kunida», «через 5 рабочих дней», «in 5
 * business days», «5 sutkada» read as bare figures, a bare figure takes any
 * source — the customer's own «5 kunda kelsinmi?» among them — and G2 saw no
 * duration to judge.
 */
const DURATION_AFTER =
  /^\s*(?:(?:ish|иш)\s+(?:kun\w*|кун\w*)|(?:рабоч|календарн)\p{L}*\s+(?:дн\p{L}*|день|сут\p{L}*)|(?:business|working|calendar)\s+day\w*|个?工作(?:日|天)|kun\w*|кун\w*|день|дн[яейь]\w*|сут\w*|sutka\w*|day\w*|天|日|روز|hafta\w*|ҳафта\w*|недел\w*|week\w*|周|星期|هفته|soat\w*|соат\w*|час\w*|hour\w*|小时|ساعت|oy\b|ой\b|месяц\w*|month\w*|个月|ماه|daqiqa\w*|дақиқа\w*|минут\w*|minute\w*|分钟|دقیقه)/iu;
/**
 * A size word between a count and its carton — «30 mayda quti», «10 katta karobka», «5 больших коробок»
 * (final review K17): read as a bare figure, the customer's own count could vouch for nothing once a bare
 * figure of his stopped vouching for anything.
 */
const SIZE_WORD =
  "(?:mayda|katta|kichik|kichkina|o['‘’ʻ`]?rta|og['‘’ʻ`]?ir|yengil|майда|катта|кичик|кичкина|ўрта|оғир|енгил|больш\\p{L}*|маленьк\\p{L}*|крупн\\p{L}*|мелк\\p{L}*|средн\\p{L}*|small|big|large|heavy|light)\\s+";
/**
 * The things cargo is counted in — the cartons, and every other bundle a
 * customer writes (fix round): «200 juft krossovka», «50 qop», «20 мешков»,
 * «20 bags», «10 rulon», «3 xil tovar», «5包货» read as bare figures, and a
 * customer's bare figure vouches for nothing (K17), so the reply could not
 * repeat his own count back. `\b` is an ASCII edge even under `u`, so «5 та»
 * — Cyrillic — was never a count at all: every edge here is a letter's.
 */
const COUNT_UNIT = [
  'ta(?![\\p{L}])',
  'та(?![\\p{L}])',
  'dona\\p{L}*',
  'дона\\p{L}*',
  'шт\\p{L}*',
  'штук\\p{L}*',
  'pcs(?![\\p{L}])',
  'piece\\p{L}*',
  '件',
  '个',
  '箱',
  '包',
  '袋',
  '双',
  '卷',
  '套',
  'عدد',
  'کارتن',
  'جعبه',
  'mesta(?![\\p{L}])',
  'мест\\p{L}*',
  'joy(?![\\p{L}])',
  'juft\\p{L}*',
  'жуфт\\p{L}*',
  'qop\\p{L}*',
  'қоп\\p{L}*',
  'meshok\\p{L}*',
  'мешок',
  'мешк\\p{L}*',
  'pachka\\p{L}*',
  'пачк\\p{L}*',
  'rulon\\p{L}*',
  'рулон\\p{L}*',
  'paket\\p{L}*',
  'пакет\\p{L}*',
  'komplekt\\p{L}*',
  'комплект\\p{L}*',
  'xil(?![\\p{L}])',
  'хил(?![\\p{L}])',
  'пар[аыу]?(?![\\p{L}])',
  'упаков\\p{L}*',
  '(?:bag|sack|roll|pair|set|pack|package|bundle)s?(?![\\p{L}])',
].join('|');
const COUNT_AFTER = new RegExp(
  `^\\s*(?:${COUNT_UNIT}|(?:${SIZE_WORD})?(?:karobka\\p{L}*|коробк\\p{L}*|коробок|box\\p{L}*|carton\\p{L}*|quti\\p{L}*|қути\\p{L}*))`,
  'iu',
);
const PERCENT_AFTER = /^\s*(?:%|٪|foiz\w*|фоиз\w*|процент\w*|percent\w*)/iu;
/**
 * A month after a day. Each stem ends where its month does (policy review B4):
 * «2 marta» is TWICE, not the second of March, so «Mashina haftada 2 marta
 * chiqadi» asked for a date source; «5 maydon» is no May, «5 майка» is five
 * T-shirts, «2 separate boxes» no September, and the English stems are words
 * of their own, never the head of «marta», «market», «decimal».
 *
 * The fix round found the same trap three more ways, and the opposite one:
 *  - «mayda» / «майда» is also the Uzbek «small» — «30 mayda quti» is thirty
 *    small boxes, and as a date it was a figure only the company could vouch
 *    for, so the customer's own count could not be repeated back: before a
 *    thing that is counted it is no May;
 *  - the Uzbek Cyrillic «2 марта» is «twice» where the Russian is «of March»:
 *    in a text that writes the Uzbek letters (ў қ ғ ҳ) it is no date, and
 *    «мартаба» never is one;
 *  - «Box 2 may arrive» is the English modal before its verb;
 *  - and the other way, «5-mayigacha», «5-mayni», «5-майигача» (the
 *    possessive and the accusative) and «sentyabr», «oktyabr» (the common
 *    Latin spellings) ARE dates — read as bare figures they took any source.
 */
const MAY_ENDING = '(?:i(?:ga|gacha|dan|da|ning|ni)?|ni|da|dan|ga|gacha|ning)?';
const MAY_ENDING_CYRL = '(?:и(?:га|гача|дан|да|нинг|ни)?|ни|да|дан|га|гача|нинг)?';
/** What «mayda» means «small» before, and what English «may» is a modal before. */
const NOT_MAY_AFTER =
  '(?:-?\\s*(?:chuyda|чуйда)|\\s+(?:quti|karobka|korobka|yuk|tovar|posilka|paket|narsa|detal|qism|buyum|қути|коробк|юк|товар|посилка|пакет|нарса|детал|қисм|буюм)|' +
  '\\s+(?:be|not|arrive|take|need|come|have|get|vary|change|cost|differ|require|depend|reach|leave|also|still|only|already|apply|exceed|include|contain|weigh)(?![\\p{L}]))';
const MONTH_AFTER = new RegExp(
  '^\\s*-?\\s*(?:(?:yanvar|fevral|mart(?!a)|aprel|' +
    `may${MAY_ENDING}(?![\\p{L}])(?!${NOT_MAY_AFTER})|` +
    'iyun|iyul|avgust|sent(?:y)?abr|okt(?:y)?abr|noyabr|dekabr|январ|феврал|март(?!аба)|апрел|' +
    `ма(?:я|й${MAY_ENDING_CYRL})(?![\\p{L}])(?!${NOT_MAY_AFTER})|` +
    'июн|июл|август|сентябр|октябр|ноябр|декабр)|' +
    '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![\\p{L}])|月)',
  'iu',
);
/** The Uzbek Cyrillic «марта» — «times» — after a figure, in a text that writes the Uzbek letters. */
const UZ_CYRL_TIMES = /^\s*марта(?![\p{L}])/iu;
const UZ_CYRL_LETTERS = /[ўқғҳ]/iu;

/**
 * A range: «15-25 kun», «15 dan 25 gacha», «15 дан 25 кунгача», «15 до 25». The unit after the second number names
 * both. The Uzbek Cyrillic «дан» was missing (fourth check), so «Авто карго одатда 15 дан 25 кунгача келади» read
 * its 15 as a bare figure and the kb's own transit days lost their ✅.
 */
const RANGE_TAIL = /^\s*(?:[-–—~]|dan|дан|до|to|تا|到|至)\s*\d+(?:[.,]\d+)?(?:\s*(?:gacha|гача))?/iu;

/**
 * A scale word after a figure is part of it: «1,5 mln so'm» is 1 500 000 and
 * must not pass on a $1.5 tariff, and «480 ming» is money even with no
 * currency — in this business nobody counts cartons in thousands without
 * saying so («5 ming dona» stays a count). «k» only GLUED («10k», «10к»):
 * spaced it is not how anyone writes it, and «10кг» is a weight.
 */
const SCALES: readonly (readonly [RegExp, number])[] = [
  [/^[kк](?![\p{L}])/iu, 1e3],
  [/^\s*(?:ming(?:dan|ga|lik)?|минг\p{L}*|тыс(?:яч\p{L}*|\.)?|тыщ\p{L}*|thousand\p{L}*|هزار)(?![\p{L}])/iu, 1e3],
  [/^\s*(?:million\p{L}*|миллион\p{L}*|mln\.?|млн\.?|میلیون)(?![\p{L}])/iu, 1e6],
  [/^\s*(?:mlrd\.?|milliard\p{L}*|billion\p{L}*|миллиард\p{L}*|млрд\.?)(?![\p{L}])/iu, 1e9],
  // Han has no word edges: «2千元» is 2 000 yuan, «3万» 30 000.
  [/^\s*百万/u, 1e6],
  [/^\s*亿/u, 1e8],
  [/^\s*万/u, 1e4],
  // …but «千克» is a kilogram and «千米» a kilometre: there 千 is the unit's, not a thousand (fix round:
  // «500千克» read as 500 000 of money, and a Chinese customer's weight stopped vouching for itself).
  [/^\s*千(?![克米瓦伏])/u, 1e3],
];

/**
 * «стоит 480», «будет стоить 480» — the price verb right before a bare figure. Not a money word for the
 * whole text: «стоит» is also «stands», and «Машина стоит на границе, в очереди 15» is a status line.
 */
const PRICE_VERB_BEFORE =
  /(?<![\p{L}])(?:сто(?:ит|ят|ить|ило|ила|или|ил)|обойд[её]тся|обойдутся)\s+(?:(?:всего|около|примерно|только|лишь)\s+)?$/iu;
/**
 * …and the TOTAL's heading right before a bare figure (fourth check): «Hisob:\nJami: 800», «Итого — 2255», «Your
 * quote:\nTotal: 168», «5 kub uchun jami 800 bo'ladi», «Total comes to 800» name no currency and are the price of
 * the load all the same — read as bare figures, the customer's own 800 kg or an address's «2255号» vouched for
 * them. A money figure needs a money source. Only right before the figure: «jami 3 ta savol» is a count.
 */
// «Hammasi bo'lib», «всего выйдет», «in total», «~» / «≈» before the figure too (fifth check): «Hammasi bo'lib 800
// bo'ladi», «Всего выйдет 800», «Jami: ~800». «Всего» only with its verb or colon — «всего 3 склада» is a count.
const TOTAL_BEFORE =
  /(?:(?<![\p{L}])(?:jami|жами|итого|total|hammasi\s+bo['‘’ʻ`]?lib|ҳаммаси\s+бўлиб|in\s+total|altogether|all\s+in)(?:\s+(?:bo['‘’ʻ`]?ladi|bo['‘’ʻ`]?lib|chiqadi|бўлади|получается|получится|выйдет|выходит|составит|составляет|comes\s+to|is|will\s+be|of|amounts?\s+to))?|(?<![\p{L}])(?:всего|в\s+сумме|в\s+итоге)(?:\s+(?:получается|получится|выйдет|выходит|составит|составляет|будет)|\s*[:：]))\s*[:：—–=-]?\s*(?:(?:taxminan|тахминан|примерно|около|about|around|approximately|roughly)\s+|[~≈]\s*)?$/iu;

/**
 * Figures whose FORM says what they are, so a money word elsewhere in the text never makes them money:
 * an Uzbek ordinal glued to its noun («3-ko'chada», «2-omborda», «15-uy» — but not a case ending on a
 * cardinal, «480-ga»), and an hour of the day after «soat» («soat 9 dan 18 gacha»). Before this a fact
 * «To'lov naqd, ombor 3-ko'chada» read as a price and the kb refused it.
 */
// Latin only: a Russian «480-ти долларов» hangs a CARDINAL's case on the hyphen, and must stay money.
const ORDINAL_AFTER = /^-(?!(?:ga|da|dan|ni|ning|gacha|cha|lik|dek|ta|tadan|tasi|tagacha)(?![\p{L}]))[a-z]/iu;
const HOUR_BEFORE = /(?<![\p{L}])(?:soat|соат|ساعت)\s*(?:\d{1,2}(?:[.:]\d{2})?\s*(?:dan|дан|-|–|—|تا)\s*)?$/iu;
/**
 * A NUMBERED thing — «Buyurtma raqamim 4521», «заказ № 4521», «order number
 * 4521», «4521 raqamli buyurtma» (fix round): an identifier, never a price or
 * a count, which the customer's own message vouches for as itself.
 */
const ID_BEFORE = /(?:№|(?<![\p{L}])(?:raqam\p{L}*|рақам\p{L}*|номер\p{L}*|(?:order|invoice)\s+(?:no\.?|number|#)))\s*:?\s*$/iu;
const ID_AFTER = /^\s*-?\s*(?:raqamli|рақамли)(?![\p{L}])/iu;

/**
 * A figure said PER UNIT (K21) — the price of one kilo or one cube, never of
 * the load. After it: «110 $/kub», «17 $ kilosiga», «17 долларов за кг»,
 * «$17 per kg», «110 $ har kub uchun», «17美元/公斤», «۱۷ دلار برای هر کیلو».
 * Before it: «kubiga 110 $», «1 kub uchun $110», «за 1 кг 17 $», «per kg $17»,
 * «每公斤17美元», «کیلویی ۱۷ دلار», a hedge allowed between («kubiga
 * taxminan 110 $»). «3 kub uchun 330 $» is the price of three cubes: only ONE
 * unit, or none, before «uchun» makes a rate.
 *
 * A figure multiplied by a measure is the price of one unit too (fix round):
 * «3 kub × 110 $ = taxminan 330 $» is the avia tool's own «30 kg × 17 $/kg»
 * with the slash dropped, and read as a total its 110 vouched for nothing.
 * «Tarif» and «rate» alone are NOT a unit: «Sayt tarifi: taxminan 330 $» is
 * the website's price of the load, which read as per-unit no total backed.
 */
const UNIT_WORD =
  '(?:kg|кг|kilo\\p{L}*|кило\\p{L}*|kub\\p{L}*|куб\\p{L}*|m3|м3|m³|м³|cbm|cubes?|cubic\\s+met\\p{L}*|tonn\\p{L}*|тонн\\p{L}*|tons?|公斤|千克|方|立方\\p{L}*|کیلو\\p{L}*|متر\\s*مکعب)';
/** «×», «*», or a spaced «x» / Cyrillic «х» — the multiplication sign as people type it. */
const TIMES = '(?:\\s*[×✕*]|\\s+[xх](?=\\s))';
const PER_UNIT_AFTER = new RegExp(
  `^\\s*(?:(?:\\/|per\\s+|за\\s+|в\\s+|for\\s+(?:one|1|each|a|every)\\s+|har\\s+(?:bir\\s+)?|(?:برای\\s+)?هر\\s+|每)\\s*(?:1\\s*)?${UNIT_WORD}|(?:kilo(?:si)?ga|kub(?:i)?ga|tonna(?:si)?ga|кило(?:си)?га|куб(?:и)?га|کیلویی)(?![\\p{L}])|${TIMES}\\s*\\d+(?:[.,]\\d+)?\\s*${UNIT_WORD})`,
  'iu',
);
const PER_UNIT_BEFORE = new RegExp(
  '(?:' +
    [
      'kilo(?:si)?ga|kub(?:i)?ga|tonna(?:si)?ga|кило(?:си)?га|куб(?:и)?га',
      '(?<![\\p{L}])(?<!\\d\\s{0,2})(?:kilosi|kubi)',
      `(?:kilo(?:si|sining)?|kub(?:i|ining)?)\\s+narxi`,
      `(?<![\\p{L}\\d.,])(?:1|bir)\\s+${UNIT_WORD}(?:\\s+(?:uchun|narxi|ga))?`,
      `har\\s+(?:bir\\s+)?${UNIT_WORD}\\s*(?:uchun|ga)?`,
      `per\\s+${UNIT_WORD}`,
      `(?<![\\d.,])(?:a|one|1)\\s+${UNIT_WORD}\\s+(?:costs?|is)`,
      `за\\s+(?:1\\s+|один\\s+|одну\\s+)?${UNIT_WORD}`,
      `(?<![\\p{L}])${UNIT_WORD}${TIMES}`,
      '每(?:公斤|千克|方|立方米?)',
      '(?:برای\\s+)?هر\\s+(?:کیلو\\p{L}*|متر\\s*مکعب)|کیلویی',
    ].join('|') +
    ')\\s*[:\\-–—=]?\\s*(?:(?:taxminan|тахминан|примерно|около|about|around|approximately|roughly|大约|约|حدود|تقریباً?)\\s*)?' +
    `(?:(?:${CURRENCY_BEFORE_SRC})\\s*:?\\s*)?$`,
  'iu',
);

/** A figure as written: thousands by space, comma or dot groups of three, decimals by dot or comma. */
const NUMBER_RE = /\d{1,3}(?:[ ,. ]\d{3})+(?![\d])(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
/** dd.mm(.yyyy) with a two-digit month — the spelling every date the system prints uses («dd.MM»). */
const DATE_RE = /(?<!\d)(\d{1,2})[./](\d{2})(?:[./](\d{2,4}))?(?!\d)/gu;
const TIME_RE = /(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;

/** «1 200», «1,200», «1.200» → 1200; «1,5» → 1.5; «330.50» → 330.5. */
export function parseFigure(raw: string): number {
  const s = raw.replace(/ /gu, ' ');
  // Groups of exactly three after a separator are thousands.
  if (/^\d{1,3}(?:[ ,.]\d{3})+$/u.test(s)) return Number(s.replace(/[ ,.]/gu, ''));
  const grouped = /^(\d{1,3}(?:[ ,.]\d{3})+)([.,]\d+)$/u.exec(s);
  if (grouped) return Number(`${grouped[1]!.replace(/[ ,.]/gu, '')}.${grouped[2]!.slice(1)}`);
  return Number(s.replace(',', '.'));
}

interface Reading {
  kind: NumberKind;
  /** 1, or the scale word's factor. */
  scale: number;
  /** The scale word as written right after the figure («mln»), for the ledger's `raw`; '' when none or after a range. */
  scaleText: string;
  /** The currency as written beside the figure, when one is (K16). */
  token: string | null;
  /** What follows the figure, its range, its scale word and its currency — where a per-unit word stands (K21). */
  rest: string;
  /** A measure's or a duration's unit, as its word says. */
  unit?: FigureUnit;
}

/** Which unit the word after a measure or a duration is — read on the tail `MEASURE_AFTER` / `DURATION_AFTER` matched. */
const UNIT_OF: readonly (readonly [RegExp, FigureUnit])[] = [
  [/^\s*(?:kub|куб|cbm|cubic|cubes?|m3|м3|m³|м³|立方|متر\s*مکعب)/iu, 'm3'],
  [/^\s*(?:kg|кг|kilo|кило|公斤|千克|کیلو)/iu, 'kg'],
  [/^\s*(?:tonn|тонн|tons?|吨)/iu, 'tonne'],
  [/^\s*(?:m2|м2)/iu, 'm2'],
  [/^\s*(?:(?:ish|иш)\s+|(?:рабоч|календарн)\p{L}*\s+|(?:business|working|calendar)\s+)?(?:kun|кун|день|дн|сут|sutka|day|天|日|روز|个?工作)/iu, 'day'],
  [/^\s*(?:hafta|ҳафта|недел|week|周|星期|هفته)/iu, 'week'],
  [/^\s*(?:soat|соат|час|hour|小时|ساعت)/iu, 'hour'],
  [/^\s*(?:oy(?![\p{L}])|ой(?![\p{L}])|месяц|month|个月|ماه)/iu, 'month'],
  [/^\s*(?:daqiqa|дақиқа|минут|minute|分钟|دقیقه)/iu, 'minute'],
];
function unitOf(tail: string): FigureUnit | undefined {
  return UNIT_OF.find(([re]) => re.test(tail))?.[1];
}

/** The word beside a figure — before it, after it, after its range and its scale word. */
function readAt(text: string, start: number, end: number): Reading {
  let tail = text.slice(end, end + 48);
  const range = RANGE_TAIL.exec(tail);
  if (range) tail = tail.slice(range[0].length);
  let scale = 1;
  let scaleText = '';
  for (const [re, factor] of SCALES) {
    const m = re.exec(tail);
    if (!m) continue;
    scale = factor;
    if (!range) scaleText = m[0];
    tail = tail.slice(m[0].length);
    break;
  }
  const at = (kind: NumberKind, token: string | null = null, rest = tail): Reading => ({ kind, scale, scaleText, token, rest });
  const before = MONEY_BEFORE.exec(text.slice(Math.max(0, start - 12), start));
  if (before) {
    // «$480 /kg»: a currency written after it too is still part of the figure's phrase.
    const after = MONEY_AFTER.exec(tail);
    return at('money', before[0], after ? tail.slice(after[0].length) : tail);
  }
  if (PERCENT_AFTER.test(tail)) return at('percent');
  const money = MONEY_AFTER.exec(tail);
  if (money) return at('money', money[0], tail.slice(money[0].length));
  if (MEASURE_AFTER.test(tail)) return { ...at('measure'), unit: unitOf(tail) };
  if (DURATION_AFTER.test(tail)) return { ...at('duration'), unit: unitOf(tail) };
  if (MONTH_AFTER.test(tail) && !(UZ_CYRL_TIMES.test(tail) && UZ_CYRL_LETTERS.test(text))) return at('date');
  if (COUNT_AFTER.test(tail)) return at('count');
  // «480 ming», «1,5 mln» with no unit: a scaled figure is money.
  return at(scale === 1 ? 'plain' : 'money');
}

function kindAt(text: string, start: number, end: number): NumberKind {
  return readAt(text, start, end).kind;
}

/** The text as the figures are read: digits folded, the given strings, links and phones blanked out. */
function blanked(text: string, removeWhole: readonly string[]): string {
  let t = normalizeDigits(text);
  for (const r of removeWhole) {
    const whole = r ? normalizeDigits(r) : '';
    if (whole) t = t.split(whole).join(' '.repeat(whole.length));
  }
  for (const u of urlsIn(t)) t = t.split(u).join(' '.repeat(u.length));
  return t.replace(PHONE_RE, (m) => ' '.repeat(m.length));
}

/**
 * A list's own numbers are no figures (incident 2026-10-29). Prompt rule 3
 * asked for «bitta raqamlangan ro'yxat» and calc_checklist wrote «1) … 2) …»,
 * and every marker read as a bare figure — as MONEY in a reply that names
 * money anywhere — so the commonest first reply, «Narxni hisoblashim uchun
 * yozing: 1. Tovar nomi 2. Hajmi (kub) …», lost its ✅ as «manbasi yo‘q
 * raqam: 1 $». A marker is taken OUT, not marked `fixed`: a fixed figure
 * still asks a source of its own value, and nothing vouches for a «4».
 *
 * A marker is a one- or two-digit number with «.», «)» or a keycap after it
 * and a word — or the item's own figure, «1. 500 $» — after that. The list's
 * FIRST item stands where an item starts: a line's head, after «:» or «;».
 * The rest may follow a comma or a space too («…: 1) tovar nomi, 2) necha
 * kub», «1️⃣ tovar 2️⃣ hajmi»), in the same style. And the markers count 1, 2,
 * 3 in order, two at least: a lone «5.», a «2)» no «1)» came before, a
 * «Narxi: 1.» stand as figures — a list of one is no list to prove itself.
 * «1.5 kub» is a decimal, and the item's figure after a marker is read as
 * ever.
 *
 * Reviewed both ways. The model writes markdown, so «**1.** Tovar», «1.
 * **Tovar**», «📦 1. Tovar», «1.Tovar» and «1 - tovar» are markers too, and a
 * «1)» or a keycap may open a list inside a sentence — «…uchun 1) tovar
 * nomi, 2) hajmi», «напишите 1) товар 2) объём» — when its «2)» follows in
 * that sentence. And a marker never swallows a PRICE: «narxi kg uchun 2.
 * Avto», «цена за кг 2) доллара», «1️⃣ avia kg 2️⃣ dollar» each took the rate
 * out of the ledger. So an item that is a currency is no item, a «1.»-style
 * marker inside a line continues no list, and no marker continues after a
 * price or a unit word.
 */
const LIST_MARKER =
  /(?<![\p{L}\p{N}.,])(\(?)(\d{1,2})(\.(?!\d)|\)|️?⃣|[ \t ]+[-–—](?=[ \t ]+[*_«"“(]*\p{L}))(?=[*_]*(?:[ \t ]+[*_«"“(]*[\p{L}\p{N}]|\p{L}))/gu;
const ITEM_HEAD = /[\n:;：；]/u;
/** What may stand between an item's head and its marker: spaces, markdown, an emoji. Never a line's end. */
const DECORATION = /[ \t \r*_\p{Extended_Pictographic}\u{FE0F}\u{200D}]+$/u;
const LAST_WORD = /([\p{L}$€¥£₽][\p{L}'‘’ʻ`]*)(?:\s+([\p{L}'‘’ʻ`]+))?$/u;
/** A price word or a unit — a marker after it is the figure it prices: «kg 2️⃣», «цена за кг 2)», «kg uchun 2)». */
const PRICE_OR_UNIT = new RegExp(`^(?:${UNIT_WORD}|m[23]|м[23])$|${MONEY_WORD.source}`, 'iu');
const PER_WORD = /^(?:uchun|учун|ga|га|за|per|for|each|по)$/iu;

function pricedBefore(head: string): boolean {
  const m = LAST_WORD.exec(head);
  if (!m) return false;
  const [, first, second] = m;
  if (second === undefined) return PRICE_OR_UNIT.test(first!);
  return PRICE_OR_UNIT.test(second) || (PER_WORD.test(second) && PRICE_OR_UNIT.test(first!));
}

function listMarkerSpans(t: string): [number, number][] {
  const out: [number, number][] = [];
  let run: [number, number][] = [];
  let style = '';
  // The run opened inside a sentence: its second item must stand in that sentence.
  let inline = false;
  for (const m of t.matchAll(LIST_MARKER)) {
    const raw = t.slice(0, m.index);
    const head = raw.replace(DECORATION, '');
    const last = head.at(-1);
    const atHead = last === undefined || ITEM_HEAD.test(last);
    const spaced = head.length < raw.length;
    const afterComma = last === ',' || last === '，';
    const at = m.index + m[1]!.length;
    const span: [number, number] = [at, at + m[2]!.length];
    const mark = m[3]!.trim().replace('️', '');
    const shape = `${m[1]}${mark}`;
    const dash = /^[-–—]$/u.test(mark);
    // «1)», «(1)», «1️⃣» are written inside a line; «1.» and «1 -» only at its head.
    const inlineStyle = mark === ')' || mark === '⃣';
    const value = Number(m[2]);
    const end = m.index + m[0].length;
    if (MONEY_AFTER.test(t.slice(end, end + 24))) continue;
    const midLine = !dash && inlineStyle && spaced && !pricedBefore(head);
    if (value === 1 && (atHead || midLine)) {
      if (run.length >= 2) out.push(...run);
      run = [span];
      style = shape;
      inline = !atHead;
    } else if (run.length > 0 && value === run.length + 1 && shape === style && (atHead || (!dash && afterComma) || midLine)) {
      if (inline && run.length === 1 && /[.!?\n]/u.test(t.slice(run[0]![1], m.index))) continue;
      run.push(span);
    }
  }
  if (run.length >= 2) out.push(...run);
  return out;
}

/**
 * «1688» beside the marketplaces it is one of (fourth check): «Tovar havolasini (1688, Taobao) yuborsangiz ham
 * bo'ladi», «ссылку с 1688 или Taobao», «1688.com» — a NAME, never a figure, so it asks no source. Only beside
 * another marketplace, a link or a site, and only bare: «1688 $», «Narxi 1688» (no marketplace beside it) are figures.
 */
const MARKETPLACE =
  "(?:taobao|tmall|alibaba|aliexpress|ali\\s*express|pinduoduo|pdd|jd\\.com|wechat|淘宝|天猫|阿里巴巴|拼多多|京东|таобао|алибаба|алиэкспресс)";
const MARKET_LINK = '(?:sayt\\p{L}*|havola\\p{L}*|link\\p{L}*|site|сайт\\p{L}*|ссылк\\p{L}*|платформ\\p{L}*|platform\\p{L}*|marketplace\\p{L}*)';
const MARKET_JOIN = "\\s*(?:[,/;]|\\s(?:yoki|va|или|и|or|and|ёки|ва))?\\s*";
const MARKET_LINK_AFTER = new RegExp(`^(?:\\.com(?![\\p{L}])|\\s*(?:dagi|dan|da|ga)?\\s*${MARKET_LINK})`, 'iu');
const MARKET_LINK_BEFORE = new RegExp(`${MARKET_LINK}${MARKET_JOIN}(?:\\(\\s*)?$`, 'iu');
const MARKET_PEER_AFTER = new RegExp(`^${MARKET_JOIN}${MARKETPLACE}`, 'iu');
const MARKET_PEER_BEFORE = new RegExp(`${MARKETPLACE}${MARKET_JOIN}(?:\\(\\s*)?$`, 'iu');
/**
 * …and beside another MARKETPLACE only when its own clause names no price before it (fifth check): «Narxi 1688,
 * Taobao narxi bilan bir xil», «Kubiga 1688, Alibaba'dagi kabi» are prices said beside a marketplace. A list in
 * brackets is names whatever stands before it: «Tovar havolasini (1688, Taobao) yuborsangiz ham bo'ladi».
 */
function marketplaceName(t: string, start: number, after: string): boolean {
  if (MARKET_LINK_AFTER.test(after) || MARKET_LINK_BEFORE.test(t.slice(Math.max(0, start - 40), start))) return true;
  if (!MARKET_PEER_AFTER.test(after) && !MARKET_PEER_BEFORE.test(t.slice(Math.max(0, start - 40), start))) return false;
  if (/\(\s*$/u.test(t.slice(Math.max(0, start - 3), start))) return true;
  const clause = t.slice(0, start).split(/[,;:.!?\n—–(]/u).at(-1) ?? '';
  return !MONEY_WORD.test(clause) && !PER_UNIT_BEFORE.test(clause) && !PRICE_VERB_BEFORE.test(clause) && !TOTAL_BEFORE.test(clause);
}

/** Whether a text names money anywhere — read after the phones and links are out: «gsrlogistics.uz/narxlar» names none. */
export function namesMoney(text: string): boolean {
  return MONEY_WORD.test(blanked(text, []));
}

/**
 * Every figure in a text, with its kind. `removeWhole` are strings taken out
 * before anything is read (the persona phone, an approved link) — whole, so
 * their digits are never figures. Phones are always taken out; the caller
 * judges them separately (G6). `moneyContext` says money was named around
 * this text, not in it — a customer's earlier «Narxi qancha?» (customerSources).
 */
export function extractNumbers(
  text: string,
  removeWhole: readonly string[] = [],
  opts: { moneyContext?: boolean } = {},
): FoundNumber[] {
  const t = blanked(text, removeWhole);
  const moneyText = opts.moneyContext === true || MONEY_WORD.test(t);
  // A figure that is money because its TEXT names money takes the one currency the text names — «Narx
  // (yuanda): 480» is yuan — dollars when it names none, and no currency at all when it names two (K16).
  let textCurrency: Currency | null | undefined;
  const currencyOfText = (): Currency | null => {
    if (textCurrency !== undefined) return textCurrency;
    const named = currenciesNamed(t);
    textCurrency = named.size === 0 ? 'USD' : named.size === 1 ? [...named][0]! : null;
    return textCurrency;
  };
  const out: FoundNumber[] = [];
  // A list's markers are out before anything is read: never a figure, never a date's day.
  const taken: [number, number][] = listMarkerSpans(t);
  for (const m of t.matchAll(DATE_RE)) {
    if (taken.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
    const day = Number(m[1]);
    const month = Number(m[2]);
    // «1.50 kg», «12.50 $» are figures with a unit, not the first of May.
    if (kindAt(t, m.index, m.index + m[0].length) !== 'plain') continue;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      out.push({ raw: m[0], value: day * 100 + month, kind: 'date', index: m.index });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  // A clock is a time of day whatever the text says — never upgraded to money below.
  for (const m of t.matchAll(TIME_RE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out.push({ raw: m[0], value: Number(m[0].replace(':', '.')), kind: 'plain', index: m.index, fixed: true });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(NUMBER_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    // A digit glued to letters is part of a code («GS777», «B-000124»), not a figure — G6 judges codes.
    // Unless the letters ARE a currency, or a currency is glued on the other side: «USD480», «Jami-480$».
    const prev = t[start - 1];
    const after = t.slice(end, end + 24);
    const gluedAfter = MONEY_GLUED_AFTER.exec(after);
    const gluedBefore = prev !== undefined ? MONEY_GLUED_BEFORE.exec(t.slice(Math.max(0, start - 12), start)) : null;
    const glued = gluedAfter !== null || gluedBefore !== null;
    if (!glued && prev !== undefined && /[\p{L}]/u.test(prev) && !/[\p{Script=Han}]/u.test(prev)) continue;
    if (prev === '-' && /[\p{L}]/u.test(t[start - 2] ?? '') && !glued && !MONEY_AFTER.test(after)) continue;
    const read = readAt(t, start, end);
    const value = parseFigure(m[0]) * read.scale;
    if (!Number.isFinite(value)) continue;
    if (
      m[0] === '1688' &&
      !glued &&
      read.kind === 'plain' &&
      marketplaceName(t, start, after)
    ) {
      continue;
    }
    const before = t.slice(Math.max(0, start - 24), start);
    const fixed = ORDINAL_AFTER.test(after) || HOUR_BEFORE.test(before) || ID_BEFORE.test(before) || ID_AFTER.test(after);
    const priced = PRICE_VERB_BEFORE.test(before) || TOTAL_BEFORE.test(before);
    // In a text that names money anywhere, a bare figure is money (P1): «Narx (dollarda): 480».
    const kind: NumberKind =
      glued || (read.kind === 'plain' && !fixed && (moneyText || priced)) ? 'money' : read.kind;
    const token = read.token ?? gluedAfter?.[0] ?? gluedBefore?.[0] ?? null;
    const perUnit = PER_UNIT_AFTER.test(read.rest) || PER_UNIT_BEFORE.test(t.slice(Math.max(0, start - 40), start));
    out.push({
      raw: `${m[0]}${read.scaleText}`.trimEnd(),
      value,
      kind,
      index: start,
      ...(kind === 'money' ? { currency: token !== null ? currencyOf(token) : currencyOfText() } : {}),
      ...(perUnit ? { perUnit } : {}),
      ...(fixed ? { fixed } : {}),
      ...(kind === read.kind && read.unit ? { unit: read.unit } : {}),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * A price, a day count or a day in a reply is the COMPANY's word (B3): only a
 * tool of this run or an approved fact may vouch for it. The customer's own
 * «5 kunda kelsinmi?» is his wish, and «Odatda 5 kunda yetib keladi» on it
 * would be our estimate made of his number; a date is the same claim in
 * another shape, and G2 reads no dates. His kilos, cubes and cartons are his
 * to have repeated back.
 */
const COMPANY_KINDS: ReadonlySet<NumberKind> = new Set(['money', 'duration', 'date', 'percent']);
const companySaid = (s: NumberSource) => s.origin === 'tool' || s.origin === 'kb';

/**
 * A money figure and a money source are one claim only when they are in one
 * currency (K16) and the same KIND of money (K21): a figure said per unit is
 * a rate's, anything else a total's or a balance's.
 */
function moneyFits(found: FoundNumber, s: NumberSource): boolean {
  if (s.kind !== 'money') return false;
  if ((found.currency ?? null) === null || found.currency !== (s.currency ?? 'USD')) return false;
  const role = s.role ?? 'total';
  return found.perUnit === true ? role === 'rate' : role !== 'rate';
}

/**
 * Which source lets a figure through, or null. A money figure needs a money
 * source of its currency and its role, and nothing else will do; every other
 * kind takes a source of its own kind, and a bare figure takes any source but
 * money.
 *
 * A percent is the company's word too (K20): «Ha, boj 20% bo'ladi» on the
 * customer's own «Boj 20% bo'ladimi?» is a duty rate confirmed on his guess.
 * And a BARE figure of the customer's vouches for nothing (K17): «Ivudan 3
 * kub, 250 bo'ladimi?» in a chat whose inbound messages name no money left
 * his 250 'plain', and «Ha, 250 bo'ladi» agreed to his price — a figure with
 * no unit has no kind he can be said to have stated.
 *
 * Both rules are about what the SOURCE is, not only the reply figure (fix
 * round): the reply that drops the «%» — «Ha, boj 20 bo'ladi» — is a bare
 * figure, and a bare figure took the customer's percent; and a bare figure
 * took ANY money source, the yo'lkira RATE among them, so «3 kub yukingiz
 * uchun 110 chiqadi» quoted the price of one cube as the load's with no
 * hedge, no exclusion and no warehouse condition asked (G11 reads money
 * lines). A money source vouches only through `placedLedger`'s upgrade, which
 * asks the role and the currency.
 */
export function sourceFor(
  found: FoundNumber,
  sources: readonly NumberSource[],
  mode: TravelMode | null = null,
  minimum = false,
): NumberSource | null {
  const fits = (s: NumberSource) => {
    if (!sameValue(s.value, found.value)) return false;
    if (s.said === 'minimum' && !minimum) return false;
    if (s.unit !== undefined && found.unit !== s.unit) return false;
    if (s.kind === 'customer_money') return false;
    if (COMPANY_KINDS.has(found.kind) && !companySaid(s)) return false;
    // His percent, day count or date is his wish or his guess, whatever form the reply figure takes.
    if (COMPANY_KINDS.has(s.kind) && !companySaid(s)) return false;
    // His clock, his hour, his order number — said as the same fixed figure — and nothing bare of his.
    if (s.kind === 'plain' && !companySaid(s)) return s.fixed === true && found.fixed === true;
    // A fact's bare figure is a house, a building, a distance in an address — «29号», «3栋», «168米» — and
    // vouches for that address said again, never for a time or a count of the same value: «Yukingiz taxminan
    // 29 kunda yetib keladi» passed on Guangzhou's house number (incident 2026-10-29, the fail-open side).
    if (s.kind === 'plain' && s.origin === 'kb' && found.kind !== 'plain') return false;
    if (found.kind === 'plain' && s.kind === 'money') return false;
    // A day count said of one road is never vouched for by another road's: a truck's «5 kunda» on the
    // flight's five is a promise nobody made. A day count naming NO road — and the customer asked none —
    // is the truck's, the road the company is (review): «Yukingiz taxminan 5 kunda yetib keladi» passed on
    // the flight's 2-5 days in every first chat, the commonest chat there is.
    // A measure the same: the flight's «eng kamida 1 kg» is no truck's minimum («Mashina uchun eng kamida 1 kg»).
    if ((found.kind === 'duration' || found.kind === 'measure') && s.mode !== undefined && s.mode !== (mode ?? 'road')) {
      return false;
    }
    if (found.kind === 'money') return moneyFits(found, s);
    if (found.kind === 'plain') return true;
    // A measure can be stated as a bare count of the same thing and vice versa.
    if (found.kind === 'count') return s.kind === 'count' || s.kind === 'measure' || s.kind === 'plain';
    return s.kind === found.kind || s.kind === 'plain';
  };
  return sources.find(fits) ?? null;
}

/**
 * A small COUNT the reply makes good itself (fourth check): «Xitoyda 3 ta qabul ombori bor: Ivu, Guanchjou va
 * Xorgos», «2 xil yo'l bor: avto va avia», «4 ta ma'lumot kerak: tovar nomi, kub, kg va shahar», «Есть 2
 * варианта: авто и авиа», «There are 2 options: truck and air». Prompt rule 1 asked for digits and the knowledge
 * counts in words, so each was «manbasi yo‘q raqam» while «uchta» passed — and a plain «3» passed only when an
 * address's «3栋» happened to stand behind it. The list right after it, opened by a colon, holding EXACTLY that many
 * items, is its source; nothing else is. Never a count of cartons or cargo, nor of something that came — «3 ta
 * karobka keldi: …» is a status nobody stated —, never a figure with a unit, a currency or a «per», never one the
 * list does not match, and never past nine.
 *
 * Read as a WHITELIST since the fifth check: the guard on «cartons, cargo, something that came» missed the forms it
 * did not list — «Omborimizda 3 ta joyingiz saqlanyapti: kiyim, poyabzal va sumka», «Готовы к выдаче 2 позиции:
 * одежда и обувь», «Yukingizdan 2 tasi yo'lga chiqdi: …», «Your order has 2 items waiting: …», «Sizga 2 ta reys
 * bor: dushanba va payshanba» — each a status or a schedule nobody stated, vouched for by its own list. So the
 * head must NAME what a first reply counts — warehouses, roads, options, ways, questions, things, details, steps,
 * cities, services, documents —, and neither it nor the sentence before the figure may say where cargo stands or
 * that it moved. A dash opens the list as a colon does («3 ta omborimiz bor — Ivu, …»), and «…, ular:» too.
 */
export const LISTED_COUNT = 'javobdagi ro‘yxat';
const AP = "['‘’ʻ`]";
const LISTED_HEAD =
  /^\s*((?:[\p{L}'‘’ʻ`-]+\s+){0,6}?[\p{L}'‘’ʻ`-]+)(?:\s*,\s*(?:ular|bular|улар|булар|они|это|they\s+are|these\s+are))?\s*(?:[:：]|[—–](?=\s))/iu;
const LISTED_NOUN = new RegExp(
  [
    `(?<![\\p{L}])(?:ombor\\p{L}*|sklad\\p{L}*|yo${AP}?l(?:i|lar|lari|imiz|larimiz)?|variant\\p{L}*|savol\\p{L}*|narsa\\p{L}*|ma${AP}?lumot\\p{L}*|usul\\p{L}*|shahar\\p{L}*|qadam\\p{L}*|bosqich\\p{L}*|xizmat\\p{L}*|hujjat\\p{L}*|shart\\p{L}*|tur(?:i|lari)?|xil)(?![\\p{L}])`,
    '(?<![\\p{L}])(?:омбор\\p{L}*|склад\\p{L}*|йўл(?:и|лар|лари|имиз)?|вариант\\p{L}*|савол\\p{L}*|нарса\\p{L}*|маълумот\\p{L}*|усул\\p{L}*|шаҳар\\p{L}*|қадам\\p{L}*|босқич\\p{L}*|хизмат\\p{L}*|ҳужжат\\p{L}*|шарт\\p{L}*|хил)(?![\\p{L}])',
    '(?<![\\p{L}])(?:вариант\\p{L}*|способ\\p{L}*|вопрос\\p{L}*|вещ\\p{L}*|пункт\\p{L}*|шаг\\p{L}*|этап\\p{L}*|город\\p{L}*|услуг\\p{L}*|документ\\p{L}*|услови\\p{L}*|маршрут\\p{L}*|пут(?:ь|и|ей)|вид(?:а|ов)?|тип(?:а|ов)?|данн(?:ых|ые))(?![\\p{L}])',
    '(?<![\\p{L}])(?:warehouses?|options?|ways?|questions?|things?|details?|steps?|routes?|roads?|city|cities|services?|documents?|conditions?|types?|kinds?|choices?|methods?)(?![\\p{L}])',
  ].join('|'),
  'iu',
);
/** Where cargo stands, or that it moved — said before the count or in its head, a status no list may vouch for. */
const LISTED_STATUS = new RegExp(
  `(?<![\\p{L}])(?:saqlan\\p{L}*|yo${AP}?lga\\s+chiq\\p{L}*|jo${AP}?natil\\p{L}*|turib\\p{L}*|tayyor\\p{L}*|сақлан\\p{L}*|йўлга\\s+чиқ\\p{L}*|жўнатил\\p{L}*|туриб\\p{L}*|тайёр\\p{L}*|готов\\p{L}*|выдач\\p{L}*|отправлен\\p{L}*|хран\\p{L}*|waiting|ready|stored|shipped|dispatched|on\\s+the\\s+way|in\\s+stock)(?![\\p{L}])`,
  'iu',
);
/** The ways to PAY are a count of ways: «2 способа оплаты: наличные и карта», «3 ta to'lov usuli: …». */
const PAY_WAYS = new RegExp(
  `(?<![\\p{L}])(?:способ\\p{L}*\\s+оплат\\p{L}*|оплат\\p{L}*\\s+способ\\p{L}*|to${AP}?lov\\s+usul\\p{L}*|usul\\p{L}*\\s+to${AP}?lov\\p{L}*|тўлов\\s+усул\\p{L}*|ways?\\s+to\\s+pay|payment\\s+(?:methods?|options?)|(?:methods?|options?)\\s+of\\s+payment)(?![\\p{L}])`,
  'giu',
);
const LISTED_NOT =
  /(?<![\p{L}])(?:karob\p{L}*|korob\p{L}*|коробк\p{L}*|коробок|quti\p{L}*|қути\p{L}*|box\p{L}*|carton\p{L}*|mesta|мест\p{L}*|joy(?:i)?|yuk\p{L}*|юк\p{L}*|груз\p{L}*|cargo|goods|shipments?|posilka\p{L}*|посылк\p{L}*|parcels?|packages?|paket\p{L}*|пакет\p{L}*|pallet\p{L}*|паллет\p{L}*|qop\p{L}*|қоп\p{L}*|мешк\p{L}*|мешок|bags?|sacks?|partiya\p{L}*|парти\p{L}*|mashina\p{L}*|машин\p{L}*|fura\p{L}*|фур\p{L}*|trucks?)(?![\p{L}])/iu;
const LIST_END = /[.!?؟。！？\n]|$/u;
const LIST_JOIN = /\s*[,،，;/]\s*|\s+(?:va|ва|и|and|or|yoki|ёки|или|hamda|ҳамда|yoxud|&)\s+/iu;
const BULLET_LINE = /^[ \t]*(?:[•·▪●◦\-–—*]|\d{1,2}[.)]|\p{Extended_Pictographic})/u;

function listItems(after: string): number {
  const line = after.slice(0, after.search(/\n|$/u));
  const tail = line.slice(0, line.search(LIST_END));
  if (tail.trim() !== '') return tail.split(LIST_JOIN).filter((x) => x.trim() !== '').length;
  // The items on lines of their own, each with its bullet: «4 ta ma'lumot kerak:\n• tovar nomi\n• kub …».
  if (line.trim() !== '') return 0;
  let n = 0;
  for (const l of after.split('\n').slice(1)) {
    if (!BULLET_LINE.test(l)) break;
    n += 1;
  }
  return n;
}

function listedCount(t: string, f: FoundNumber): boolean {
  if (f.fixed === true || f.perUnit === true || !Number.isInteger(f.value) || f.value < 2 || f.value > 9) return false;
  const end = f.index + f.raw.length;
  if (MONEY_GLUED_AFTER.test(t.slice(end)) || MONEY_GLUED_BEFORE.test(t.slice(Math.max(0, f.index - 12), f.index))) return false;
  const read = readAt(t, f.index, end);
  if (read.kind !== 'plain' && read.kind !== 'count') return false;
  const head = LISTED_HEAD.exec(t.slice(end));
  if (!head) return false;
  const words = head[1]!;
  if (!LISTED_NOUN.test(words)) return false;
  if (LISTED_NOT.test(words) || ARRIVED.test(words) || LISTED_STATUS.test(words) || MONEY_WORD.test(words.replace(PAY_WAYS, ' '))) return false;
  const sentence = t.slice(Math.max(0, t.slice(0, f.index).search(/[^.!?؟。！？\n]*$/u)), f.index);
  if (LISTED_STATUS.test(sentence) || ARRIVED.test(sentence)) return false;
  return listItems(t.slice(end + head[0].length)) === f.value;
}

/** A ledger line and where its figure stands in the (digit-normalised) text — the policy reads clauses around it. */
export interface PlacedEntry extends LedgerEntry {
  index: number;
  /** Where the figure as written ends — before its currency. */
  end: number;
  /** The figure was said per unit (K21). */
  perUnit: boolean;
}

/**
 * The ledger with each figure's place (G11 asks the hedge in the price's own
 * clause, K12). A BARE figure only a money source vouches for IS money (K13):
 * «3 kub yukingiz uchun 330 chiqadi» names no currency and still quotes the
 * tool's 330 dollars, and as a 'plain' line it was asked for no hedge, no
 * exclusion sentence and no warehouse condition — while «330 $» was. A figure
 * whose FORM says what it is (an hour, an ordinal, a clock) never is.
 */
export function placedLedger(
  text: string,
  sources: readonly NumberSource[],
  removeWhole: readonly string[] = [],
  askedMode: TravelMode | null = null,
): PlacedEntry[] {
  const t = blanked(text, removeWhole);
  return extractNumbers(text, removeWhole).map((f) => {
    let found = f;
    let source: NumberSource | null = null;
    if (f.kind === 'plain' && f.fixed !== true) {
      // Read as money first — in dollars, the only currency a text naming none can be in.
      const asMoney: FoundNumber = { ...f, kind: 'money', currency: 'USD' };
      source = sourceFor(asMoney, sources);
      if (source) found = asMoney;
    }
    source ??= sourceFor(
      f,
      sources,
      f.kind === 'duration' || f.kind === 'measure' ? (modeAt(t, f.index) ?? askedMode) : null,
      f.kind === 'measure' && saidAsMinimum(t, f.index, f.index + f.raw.length),
    );
    // A count the reply's own list makes good — read as a count, whatever money the text names, and named by the
    // list even where another source holds the same digit (fifth check): an address's «3栋» vouching for «3 narsa
    // kerak: …» made it a figure, and the same greeting to a fifth chat lost its ✅ to G10.
    let listed = false;
    if (listedCount(t, f)) {
      listed = true;
      found = { ...f, kind: 'count' };
    }
    const money = found.kind === 'money';
    const currency = money ? (found.currency ?? null) : undefined;
    return {
      raw: money ? `${f.raw} ${currency ? CURRENCY_LABEL[currency] : '(valyuta noma’lum)'}` : f.raw,
      kind: found.kind,
      source: listed ? LISTED_COUNT : (source?.label ?? null),
      ...(money ? { currency } : {}),
      index: f.index,
      end: f.index + f.raw.length,
      perUnit: f.perUnit === true,
    };
  });
}

/**
 * The ledger for one text: each figure beside the source that let it through.
 * A day count takes the road its clause, its sentence or the text names, and
 * when the text names none, `askedMode` — the one road the customer asked
 * about: «Mashinada 5 kunda kelsinmi?» → «Odatda 5 kunda yetib keladi» is
 * the truck's time. A money line carries the currency it was read in, so the
 * card's «🔢 Raqamlar» says «330 yuan» where the tool said 330 dollars (K16).
 */
export function numberLedger(
  text: string,
  sources: readonly NumberSource[],
  removeWhole: readonly string[] = [],
  askedMode: TravelMode | null = null,
): LedgerEntry[] {
  return placedLedger(text, sources, removeWhole, askedMode).map(ledgerLine);
}

/** A placed line as the card and the draft store it — without its place. */
export function ledgerLine(e: PlacedEntry): LedgerEntry {
  return { raw: e.raw, kind: e.kind, source: e.source, ...(e.currency !== undefined ? { currency: e.currency } : {}) };
}

/**
 * Sources from text the CUSTOMER wrote: every figure of theirs vouches for
 * itself as a measure, a count, a duration — but a money figure of theirs
 * («90$ qilib bering», «90 AQSH dollari», a bare «90» in a conversation that
 * asks the price) is a request, never a price we may repeat as ours, and never
 * a bare-number source either: «Mayli, 90 bo'ladi» agrees to it just the same.
 */
export function customerSources(texts: readonly { text: string; label: string }[]): NumberSource[] {
  // Bargaining spans messages: «Narxi qancha?», then «90 bo'lsa olaman». So money named in ANY of the
  // texts (the context window, AGENT_LIMITS.contextMessages) makes every bare figure in all of them money.
  const moneyContext = texts.some((t) => namesMoney(t.text));
  const out: NumberSource[] = [];
  for (const { text, label } of texts) {
    for (const f of extractNumbers(text, [], { moneyContext })) {
      out.push({
        value: f.value,
        kind: f.kind === 'money' ? 'customer_money' : f.kind,
        label,
        origin: 'customer',
        ...(f.fixed ? { fixed: true } : {}),
      });
    }
  }
  return out;
}

/**
 * Sources from ONE approved kb fact (B2). Each fact is read alone: the
 * payment fact names money, and read joined with the rest it made every bare
 * figure of every other fact — a street number, an hour — `customer_money`,
 * so the reply could not repeat the address the owner approved. A money
 * figure of a fact is still never a money source (money-9).
 */
export function factSources(text: string, label: string): NumberSource[] {
  const t = blanked(text, []);
  return extractNumbers(text).map((f): NumberSource => {
    // The road a fact's day count is the time of — its own clause's, sentence's or the fact's; and so a measure's
    // (second review): the seed's «Avto orqali eng kamida 1 kub yoki 100 kg» is the truck's minimum, and vouched
    // for «Avia orqali eng kamida 100 kg» — the flight's is 1 kg.
    const mode = f.kind === 'duration' || f.kind === 'measure' ? modeAt(t, f.index) : null;
    return {
      value: f.value,
      kind: f.kind === 'money' ? 'customer_money' : f.kind,
      label,
      origin: 'kb',
      ...(mode ? { mode } : {}),
      // A fact's «15–25 kun» is days and its «100 kg» kilos — never minutes, cubes or cartons (review).
      ...(f.unit ? { unit: f.unit } : {}),
      // …and a minimum it states vouches for a minimum, as the company's rule does (second review).
      ...(f.kind === 'measure' && saidAsMinimum(t, f.index, f.index + f.raw.length) ? { said: 'minimum' as const } : {}),
    };
  });
}
