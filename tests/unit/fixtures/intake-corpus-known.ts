/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22),
 * 135 once the round-4 probers' 134 regressions joined (c1894-c2027), none
 * after the fifth round read every one of them right (5c3b618, ca90c52,
 * a4f8815), then 65 once the round-5 probers' 65 regressions joined
 * (c2028-c2092: inputs 5e68eed read right and the round-5 rules read wrong,
 * each owed to the next round), none again once the sixth round's three
 * packages (sheets, typed, collector) were merged, and 85 once the round-6
 * final probers' 85 cases joined (c2093-c2177: the fix rounds were over, so
 * they are RECORDED, not fixed — each owed to a later round, its severity in
 * the fixture), and 40 after the lead undid the three round-6 sub-rules
 * behind the COMMON ones (DECISIONS #1466): each a reviewer's input the
 * readers still get wrong. They run
 * as `it.fails`: a fix that makes one pass turns it RED here until its id
 * leaves this list, so the list can only shrink, and nothing on it is
 * forgotten. Never add an id to make a red case quiet — a case that newly
 * fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([
  // ── r6-probe sheets (recorded, not fixed) ────────────────────────────────
  // parseGoods: TITLE_LINE reads «Накладная» as the waybill before its
  // number, a code, a dash or «от / на / для / за»; any other word after it
  // reads as the adjective's own use («Накладная петля»), so «Накладная
  // поставщика» becomes the first product. Rare.
  'c2098',
  // parseGoods: NAME_IN cuts a name header after «по» / «в» / «as per», so
  // «Наименование (товара) по ТН ВЭД», «… в соответствии с ТН ВЭД», «… по
  // классификатору», «Name as per HS code» rank as the product name and the
  // tariff heading's text names the line. Rare.
  'c2103', 'c2104', 'c2105', 'c2106', 'c2107',
  // parseGoods: WHICH_NAME / WHICH_NAME_HAN lift a language-qualified name
  // header («中文品名», «中文名称», «Chinese name», «Xitoycha nomi», «Name in
  // English») to rung 1, and leftmost it names the lines in that language
  // instead of the Russian column. Rare.
  'c2108', 'c2109', 'c2110', 'c2111', 'c2112',
  // parseGoods: «груза» / «yuk» are naming words now, so «Наименование груза»
  // / «Yuk nomi» (the cargo's kind) outranks the product name column. Rare.
  'c2113', 'c2114',
  // parseGoods: CUBIC_METRE admits a bracketed «(CU.M)» and the volume path
  // has no PER_PACKAGE refusal, so one carton's m³ («MEAS./CTN(CU.M)»,
  // «Measurement per ctn (cu.m)») becomes the line's volume, 10× short —
  // f44a5a6 left it empty and asked. Rare.
  'c2115', 'c2116',

  // ── r6-probe typed (recorded, not fixed) ─────────────────────────────────
  // parseGoodsLine: unitField keeps a carton noun as the product's own unless
  // the word before it is a digit, a unit or a TOTAL_WORD — and «NO. OF
  // CARTON: 45» has «OF» there, so the carton total reads as 45 pieces. Rare.
  'c2121',
  // parseGoodsLine / readGoodsLines / parseManualFacts: unitField's prior-word
  // class takes «kurtkasi.» (the dot included) as a word of the name, so a
  // full stop does not set «Karobka: 45» off the way «,» «-» «;» do and the
  // carton count lands in the product's name. Rare.
  'c2122', 'c2123', 'c2124', 'c2125',
  // readGoodsLines: contactWord reads the FIRST hyphen part only («Моб-тел»,
  // «Kontakt-telefon») and CONTACT_BARE_CASE takes «telefonga» as a contact
  // only before nothing or a verb («Telefonga SMS»), so a phone number becomes
  // a TNVED-coded product. Rare.
  'c2126', 'c2127', 'c2128',
  // parseClientHint / looksLikeMaterial: contactShaped reads a capitalised
  // «Cargo» after the first word as a firm's name and «груза» / «Yuk» beside
  // «Владелец» / «egasi» as a role, so a request, a question or a complaint
  // signed with a number becomes the customer's contact. Rare.
  'c2129', 'c2130', 'c2131', 'c2132', 'c2133',
  // parseClientHint / looksLikeMaterial: nameDigits passes a one-word count
  // whose word is an ADDRESS_WORD, and «kv» / «кв» are among them, so goods
  // and their m² over a phone («Kafel / Kv 45 / …») become the customer. Rare.
  'c2134', 'c2135',
  // clientAnswer (readCustomerText via figureRow): TWO_FIGURE_ROW refuses a
  // word and two figures (the first ≥ 100) unless the word is an ADDRESS_WORD,
  // which names Ippodrom / Chorsu / Abu Saxiy only — a stall at another market
  // («Oloy 120 5», «Kuyluk 110 3») is refused on the insisting repeat. Rare.
  'c2136', 'c2137',

  // ── r6-probe collector (recorded, not fixed) ─────────────────────────────
  // intakeClientLabel: nameOwnWord keeps a contact word only written
  // Capital+lower (or hyphened), so an all-caps shop name joined by a space
  // («MEGA MOBILE», «SMART PHONE», «ТЕХНО КОНТАКТ», «MOBILE CENTER») loses its
  // contact word — a distinct shape of the package's stated trade-off. Rare.
  'c2170', 'c2171', 'c2172', 'c2173', 'c2174', 'c2175', 'c2176', 'c2177',
]);
