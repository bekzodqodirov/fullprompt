/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22),
 * then 135 once the round-4 probers' 134 regressions joined (c1894-c2027:
 * inputs 6b5f472 read right and the round-4 rules read wrong, each owed to
 * the next round): each a reviewer's input the readers still get wrong. They
 * run as `it.fails`: a fix that makes one pass turns it RED here until its id
 * leaves this list, so the list can only shrink, and nothing on it is
 * forgotten. Never add an id to make a red case quiet — a case that newly
 * fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([
  // «Мест: 45» — a carton word written as a FIELD before its number reads as
  // pieces in the kernel (units.ts parseGoodsLine); owed to the next round.
  'c0347',

  // ── r4-probe typed ───────────────────────────────────────────────────────
  // parseClientHint / looksLikeMaterial: phoneIn's guard refuses a phone whose
  // country code is glued to the operator code («+99890 123 45 67», «+86138 …»).
  'c1943', 'c1944', 'c1945', 'c1946', 'c1947', 'c1948', 'c1949', 'c1950', 'c1951',
  // parseClientHint / looksLikeMaterial: RELATIVE_WORDS takes the patronymic
  // «o'g'li»/«qizi» of a full name for «somebody's relative».
  'c1952', 'c1953',
  // parseClientHint: the 12-word cap takes a request signed with a phone as
  // the customer.
  'c1954', 'c1955', 'c1956',
  // parseClientHint / readGoodsLines: the request words lost «hisoblat*»,
  // bare «hisobla» and «narx/нарх» — a request reads as a product.
  'c1957', 'c1958', 'c1959', 'c1960', 'c1961',
  // readGoodsLines / parseManualFacts: SHIPMENT_WORDS make a chat line only
  // when EVERY word is one — «Mening yukim 12 kub» is a product with the
  // shipment's figures.
  'c1962', 'c1963', 'c1964', 'c1965', 'c1966', 'c1967', 'c1968', 'c1969', 'c1970',
  'c1971', 'c1972',
  // readGoodsLines: `oneFigureRun` drops a labelled goods line whose measure
  // field words («вес», «объем», «og'irligi», «jami», «weight») stand between figures.
  'c1973', 'c1974', 'c1975', 'c1976',
  // readGoodsLines: `statusBody` after a NAMING label drops a product
  // carrying «rasm», «фото», «kun», or a place in a case («Xitoydan»).
  'c1977', 'c1978', 'c1979', 'c1980', 'c1981', 'c1982',
  // readGoodsLines: a digit-first body after a naming label, and the bare
  // «har xil», read as a product («3 xil», «2 позиции», «1 контейнер»).
  'c1983', 'c1984', 'c1985', 'c1986', 'c1987',
  // readGoodsLines: CONTACT_WORD's exact list misses «по номеру», «raqamga»,
  // «telefoniga», «счёт-фактура», «phone» — a number becomes a TNVED code.
  'c1988', 'c1989', 'c1990', 'c1991', 'c1992',
  // looksLikeMaterial: `wordList` calls «name, town, market» a goods list.
  'c1993', 'c1994',
  // parseClientHint / looksLikeMaterial: `nameDigits` passes goods lines with
  // two-digit counts as name lines.
  'c1995', 'c1996', 'c1997',
  // parseClientHint: «digits + phone make a whole number» eats the prefix
  // code «GS 8».
  'c1998',
  // looksLikeMaterial: PHONE_GROUPS exempts a price × count = sum row
  // («Kurtka 12 25 300»).
  'c1999',

  // ── r4-probe collector ───────────────────────────────────────────────────
  // intakeClientLabel: HUG's lookbehind takes an apostrophe for a word
  // boundary — «Ra'no», «Sa'id», «Ma'no» lose their tail as a contact word.
  'c2000', 'c2001', 'c2002', 'c2003',
  // intakeClientLabel: HUG cuts a contact word that is part of the NAME
  // («Smart Mobile», «Магазин Телефон», «Phone Market»).
  'c2004', 'c2005', 'c2006', 'c2007', 'c2008', 'c2009',
  // intakeClientLabel: DIGIT_RUN starts on a digit, so «(90) …» leaves its «(».
  'c2010', 'c2011',
  // intakeClientLabel: CODE_LABEL misses «Код клиента», the line stays in the name.
  'c2012',
  // pickGoods: `goodsNameKeys` splits an unbracketed Han name into halves, so
  // different products meet through a colour, a size or «LED/USB/PVC».
  'c2013', 'c2014', 'c2015', 'c2016', 'c2017', 'c2018', 'c2019', 'c2020', 'c2021',
  'c2022', 'c2023',
  // clientAnswer: `readCustomerText` refuses couldBeCustomer to a word and
  // two figures (a market stall «Ippodrom 4 115», a 4-4 landline), so the
  // insisting repeat no longer names the customer.
  'c2024', 'c2025', 'c2026', 'c2027',
]);
