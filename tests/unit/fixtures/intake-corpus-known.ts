/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22),
 * 135 once the round-4 probers' 134 regressions joined (c1894-c2027), none
 * after the fifth round read every one of them right (5c3b618, ca90c52,
 * a4f8815), then 65 once the round-5 probers' 65 regressions joined
 * (c2028-c2092: inputs 5e68eed read right and the round-5 rules read wrong,
 * each owed to the next round): each a reviewer's input the readers still get
 * wrong. They run as `it.fails`: a fix that makes one pass turns it RED here
 * until its id leaves this list, so the list can only shrink, and nothing on
 * it is forgotten. Never add an id to make a red case quiet — a case that
 * newly fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([
  // ── r5-probe sheets ──────────────────────────────────────────────────────
  // parseGoods: OWN_UNIT refuses every bracketed «Meas»/«Vol» header, so a
  // cubic-metre unit VOLUME_KEYS do not spell («(CU.M)», «(Cu.M)», «(CUBIC
  // METER)», «(cu m)») loses the line's volume.
  'c2028', 'c2029', 'c2030', 'c2031',
  // parseGoods: namesTheProduct wants EVERY head word a naming word, so a name
  // header qualified by its language or its cargo («Наименование товара на
  // русском языке», «Name in Russian», «中文品名», «Наименование груза») falls
  // below the description rung and the description becomes the name.
  'c2032', 'c2033', 'c2034', 'c2035',
  // parseGoods: TITLE_LINE's «накладн» anywhere in a line takes a product
  // («Светильник накладной», «Накладные ресницы», «Накладные ногти - 3000»)
  // for the waybill's title.
  'c2036', 'c2037', 'c2038',

  // ── r5-probe typed ───────────────────────────────────────────────────────
  // readGoodsLines / parseManualFacts: statusBody's STATUS_ALONE refuses a
  // status body only as ONE word or an Uzbek predicate, so «Товар: по
  // инвойсу», «Tovar: kecha yubordim», «Goods: will send photo later» land as
  // a product and the goods question is never asked.
  'c2039', 'c2040', 'c2041', 'c2042', 'c2043', 'c2044', 'c2045', 'c2046', 'c2047',
  'c2048', 'c2049', 'c2050', 'c2051',
  // readGoodsLines: contactWord reads CONTACT_FORMS in their cases and hyphen
  // parts, so «Telefonga chexol», «Mobil-telefon» lose their TNVED code as a
  // phone number.
  'c2052', 'c2053', 'c2054', 'c2055',
  // parseClientHint: nameDigits' ONE_WORD_COUNT voids the hint on an address
  // line («Chilonzor 12», «Do'kon 45», «Офис 12») beside the phone or code.
  'c2056', 'c2057', 'c2058', 'c2059', 'c2060',
  // parseClientHint: contactShaped refuses a long contact line holding a
  // CARGO_TALK / YUK word — a «… Cargo» firm, «Грузополучатель», «Consignee»,
  // «Yuk egasi», «yuk qabul qiluvchi» NAME the customer.
  'c2061', 'c2062', 'c2063', 'c2064', 'c2065', 'c2066',
  // parseClientHint: units.ts UNIT_FIELD_BEFORE with «kv»/«кв» as m² reads an
  // address's apartment «kv: 45» as goods.
  'c2067', 'c2068', 'c2069', 'c2070',
  // parseGoodsLine: UNIT_FIELD_BEFORE reads a name ending in a box word before
  // the colon («Pitsa korobka: 5000», «Lunch box: 500») as cartons only.
  'c2071', 'c2072', 'c2073', 'c2074',
  // clientAnswer (the collector's group; readCustomerText via figureRow in
  // intake-manual.ts): a word and TWO figures is believed on the repeat, so a
  // goods row («Kurtka 300 1200») becomes the customer.
  'c2075', 'c2076',

  // ── r5-probe collector ───────────────────────────────────────────────────
  // intakeClientLabel: nameOwnWord keeps a capitalised contact word of four
  // letters or more as the name's own word — a messenger's brand («WhatsApp»,
  // «Telegram», «Viber») or an all-caps «TELEFON» joins the lead's name.
  'c2077', 'c2078', 'c2079', 'c2080', 'c2081', 'c2082',
  // pickGoods: halfMeets' clash compares SCRIPTS, so the model's «Russian
  // (Chinese)» line whose outside shares a script with the cell's non-Han half
  // (the cell's own Russian or English, a Latin «Bluetooth»/«XL», another word
  // order) no longer meets the Excel's line and the order lands twice.
  'c2083', 'c2084', 'c2085', 'c2086', 'c2087', 'c2088', 'c2089',
  // clientAnswer: readCustomerText believes a word and two figures on the
  // repeat even when one is a DECIMAL — no stall number or phone group has one.
  'c2090', 'c2091', 'c2092',
]);
