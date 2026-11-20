/**
 * Does a reply SAY that the calculation was sent? (stage 1a P3, J9 — docs/ai-toliq/qurish/STAGE-0-1A.md.)
 *
 * Rule 11 dictates the words for a job that goes to the VED: «hisoblatishga yubordim, javob kelishi bilan aytaman». The
 * act is `calc_submit` in the reply's actions; the words are the model's. A reply that says them with no submit beside
 * it tells the customer his job went to the VED when nothing went — and under stage 1a such a reply is ordinary talk,
 * gone at once. The gate refuses it (`calc_claim_unbacked`) on this reading of the reply's own words.
 *
 * A CLOSED list of the dictated claim, in the six languages the model writes it in: the past first person of «send for
 * calculation», never the offer («hisoblab beraymi?»), a question («Отправить на расчёт?»), a condition («…yuborishim
 * uchun») or a word about the VED that claims no act. A sentence that ends in a question mark claims nothing. A miss
 * costs a false claim to the customer; a false hit costs one card — so the list holds the shapes the rule dictates and
 * their plain variants, and nothing wider.
 *
 * PURE. A free-text reader: every change runs the reader corpus (`calc_claim` rows) first.
 */

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const CLAIM = new RegExp(
  [
    // Uzbek Latin: «hisoblatishga yubordim», «hisoblash uchun yubordim», «VEDga yubordim» — at most one word between.
    `${B}his[oa]bla(?:tish|sh)(?:ga|\\s+uchun)\\s+(?:\\p{L}+\\s+)?(?:yubordim|yubordik|yuborildi|jo['‘’ʻ\`]?natdim|jo['‘’ʻ\`]?natdik|topshirdim|topshirdik)${E}`,
    `${B}VED(?:ga|\\s+bo['‘’ʻ\`]?limiga)\\s+(?:\\p{L}+\\s+)?(?:yubordim|yubordik|yuborildi|jo['‘’ʻ\`]?natdim|topshirdim)${E}`,
    // Uzbek Cyrillic, with «х» for «ҳ» as a Russian keyboard types it.
    `${B}[ҳх]исобла(?:тиш|ш)(?:га|\\s+учун)\\s+(?:\\p{L}+\\s+)?(?:юбордим|юбордик|юборилди|жўнатдим|жунатдим|топширдим)${E}`,
    // Russian: «отправил на расчёт», «передала ваш запрос на просчёт».
    `${B}(?:отправил|отправила|отправили|передал|передала|передали|направил|направила|направили)\\s+(?:\\p{L}+\\s+){0,2}на\\s+(?:рас|прос)ч[её]т${E}`,
    // English: «I've sent it for calculation», «I have sent your request for calculation».
    `${B}(?:i|we)(?:'ve|\\s+have)?\\s+(?:just\\s+|already\\s+)?(?:sent|passed|forwarded|submitted)\\s+(?:\\p{L}+\\s+){0,2}(?:for|to)\\s+(?:a\\s+|the\\s+)?(?:calculation|costing)${E}`,
    // Persian: «برای محاسبه فرستادم», «… را برای محاسبه ارسال کردم».
    'برای\\s+محاسبه\\s+(?:\\S+\\s+)?(?:فرستادم|فرستادیم|ارسال\\s+کردم|ارسال\\s+کردیم)',
    // Chinese: «已提交核算», «我已经发给同事计算了».
    '(?:已经?|我)(?:提交|发送|发给|转给|交给)了?[^，。！？?、]{0,8}(?:核算|计算)',
  ].join('|'),
  'iu',
);

/** The statements of a reply — a question claims nothing, so it is left out. */
function statements(body: string): string[] {
  return body
    .split(/(?<=[.!?。！？؟\n])/u)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/[?？؟]\s*$/u.test(s));
}

/** Rule 11's dictated claim, in any of the six languages, said as a statement. */
export function claimsCalcSent(body: string): boolean {
  return statements(body).some((s) => CLAIM.test(s));
}
