import { codeCandidates } from '../calc/channel-post';
import {
  ASKING_DURATION,
  CURRENCY_AFTER_SRC,
  CURRENCY_BEFORE_SRC,
  normalizeDigits,
  SPELLED_DURATION_SRC,
  unverifiableNumeral,
  vagueDuration,
} from './digits';
import { AGENT_LIMITS } from './limits';
import { AGENT_LOCALES, dominantScript, scriptOf, type AgentLocale, type ScriptName } from './locale';
import {
  airMentionIn,
  extractNumbers,
  namesMode,
  ledgerLine,
  phoneDigits,
  PHONE_RE,
  placedLedger,
  statementsOf,
  urlsIn,
  type LedgerEntry,
  type NumberSource,
  type TravelMode,
} from './numbers';
import { mentionsRail } from './worthy';

/**
 * The rules a reply must pass before ✅ exists (spec §6, review §17.6).
 *
 * PURE and BLOCKING: every hit is a reason the card carries no ✅ and
 * `decideDraft` re-runs this on the stored body and refuses. «Everything is a
 * draft anyway» was the first design's sentence and it is exactly how a
 * warning line beside a live button gets pressed past (leak-3). The model is
 * told these rules too, but nothing here trusts it: they are checked after it.
 *
 * Every check reads the DIGIT-NORMALISED text (leak-7).
 */

export type PolicyRule = 'G1' | 'G2' | 'G4' | 'G5' | 'G6' | 'G10' | 'G11';

export type PolicyCode =
  | 'number_unverifiable'
  | 'number_unsourced'
  | 'promise'
  | 'too_long'
  | 'questions'
  | 'empty'
  // Written by decideDraft's ✅ only, never by the checks below: a machine draft with no stored memory cannot be re-checked.
  | 'memory_missing'
  | 'wrong_script'
  | 'other_client_code'
  | 'system_code'
  | 'foreign_phone'
  | 'staff_name'
  | 'canary'
  | 'ai_denial'
  | 'url'
  | 'mention'
  | 'map_unasked'
  | 'fingerprint'
  | 'url_cap'
  | 'estimate_unhedged'
  | 'warehouse_condition'
  | 'gloss_missing'
  | 'avia_address'
  | 'avia_maybe';

export interface PolicyHit {
  rule: PolicyRule;
  code: PolicyCode;
  /** What was found — a category, a code, the figure. Shown on the card in words. */
  detail?: string;
}

export const PROMISE_CATEGORIES = [
  'discount',
  'guarantee',
  'credit_release',
  'refund',
  'free_extras',
  'dispatch_promise',
  'customs_included',
  'no_duty',
] as const;
export type PromiseCategory = (typeof PROMISE_CATEGORIES)[number];

/**
 * Leaving and arriving, per language — read by the day rule below and by
 * `timePromise`. The STEM is open, as the shipped rule had it: «jo'natib
 * beraman», «jo'natib qo'yamiz», «jo'natyapmiz», «jo'natishadi», «отправляем»,
 * «отправка», «shipping», «will be dispatched» are all one promise (the fix
 * round measured the package's closed lists of future endings passing every
 * one of them). Two things are taken out, each by what follows the stem: the
 * CUSTOMER's forms («yuboring», «jo'natasiz», «yuborsangiz», «отправьте») —
 * his doing, never ours — and, only beside «bugun» / «сегодня» / «today», the
 * PAST («jo'natildi», «jo'natib yubordik», «отправили», «shipped»), a fact
 * about cargo that left. Beside «ertaga» / «завтра» / «tomorrow» there is no
 * past to take out, and the participle is the future: «будет отправлен
 * завтра», «will be shipped tomorrow».
 */
const AP = "['‘’ʻ`]";
const UZ_YOURS = `(?:i|a)?(?:ng|sa|siz)|ish(?:ingiz|ing)|(?:il)?ib\\s+(?:yubor|ber|qo${AP}?y)(?:ing|asiz|sa)`;
const UZ_PAST = `(?:il)?(?:di|gan)|(?:il)?ib\\s+(?:yubor|bo${AP}?l|qo${AP}?y|ber|ket|chiq)(?:di|gan)`;
/** …and the negative, «jo'natmaymiz», «yetib kelmaydi» — a refusal, never a promise. */
const UZ_NEG = 'ma(?:y|s|ng|gan|di)';
/** The verbs that say cargo travels by what they ARE — sending, delivering, arriving. */
const uzSending = (not: string) =>
  `(?:jo${AP}?nat|yubor|yetkaz)(?!${not})\\p{L}*|yetib\\s+(?:kel|bor)(?!${not})\\p{L}*|jo${AP}?na(?:ydi|ymiz|b\\s+ketadi)`;
/** …and «leaves» / «goes out», which say it only of something that travels — never «vaqt ketadi», «it takes time». */
const UZ_LEAVING = `(?<![\\p{L}])(?<!vaqt\\s)(?:chiq|ket)(?:adi|amiz|aman|ishadi|yapti|yapmiz|moqda)(?![\\p{L}])`;
const uzGoing = (not: string) => `${uzSending(not)}|${UZ_LEAVING}`;
const UZC_YOURS = '(?:и|а)?(?:нг|са|сиз)|иш(?:ингиз|инг)|(?:ил)?иб\\s+(?:юбор|бер|қўй)(?:инг|асиз|са)';
const UZC_PAST = '(?:ил)?(?:ди|ган)|(?:ил)?иб\\s+(?:юбор|бўл|қўй|бер|кет|чиқ)(?:ди|ган)';
const UZC_NEG = 'ма(?:й|с|нг|ган|ди)';
const uzcSending = (not: string) => `(?:жўнат|юбор|етказ)(?!${not})\\p{L}*|етиб\\s+(?:кел|бор)(?!${not})\\p{L}*`;
const UZC_LEAVING = '(?<![\\p{L}])(?<!вақт\\s)(?:чиқ|кет)(?:ади|амиз|аман|ишади|япти|моқда)(?![\\p{L}])';
const uzcGoing = (not: string) => `${uzcSending(not)}|${UZC_LEAVING}`;
const RU_YOURS = 'ьте|ь(?![\\p{L}])|ите|ишь';
const ruSending = (past: boolean) => {
  const not = past ? `ил|лял|лен|${RU_YOURS}` : RU_YOURS;
  return [
    `отправ(?!${not})\\p{L}*`,
    `достав(?!${not})\\p{L}*`,
    `отгру[зж](?!${past ? 'ил|ал|ен|' : ''}${RU_YOURS})\\p{L}*`,
    `привез(?!${past ? 'л|[её]н|' : ''}${RU_YOURS}|и(?![\\p{L}]))\\p{L}*`,
    'прибуд\\p{L}*|прибыва\\p{L}*|доед\\p{L}*|дойд[её]т|дойдут',
    '(?:будет|будут)\\s+(?:отправлен|отгружен|доставлен)\\p{L}*',
  ].join('|');
};
/** «Придёт», «будет в Ташкенте» — the cargo's only when the sentence is about cargo: «Ответ придёт» is not. */
const RU_COMING =
  'выед\\p{L}*|выезжа\\p{L}*|уед\\p{L}*|уезжа\\p{L}*|прид[её]т|придут|приед(?!ете|ешь)\\p{L}*|(?:будет|будут)\\s+(?:у|в|на)(?=\\s)';
const ruGoing = (past: boolean) => `${ruSending(past)}|${RU_COMING}`;
const EN_GO_ANY = '(?:ship|send|sent|dispatch|deliver|leav|depart)\\p{L}*';
const EN_GO_NOW =
  '(?:shipp?(?:ing)?|ships?|shipment|send(?:s|ing)?|dispatch(?:es|ing)?|deliver(?:s|ing|y)?|leav(?:e|es|ing)|depart(?:s|ing|ure)?)(?![\\p{L}])';
const EN_FUTURE = `(?:will|'ll|shall|going\\s+to|gonna)\\s+(?:\\p{L}+\\s+){0,2}${EN_GO_ANY}`;
/** «Please send the invoice tomorrow» is the customer's errand, not our dispatch; «not shipping» no dispatch at all. */
const EN_NOT_YOURS = "(?<!(?:please|you\\s+can|you\\s+could|you\\s+should|not|never|n['’]t)\\s+)";
/** A word that turns the verb after it into a refusal: «завтра не отправим», «won't ship tomorrow». */
const NEG_WORD = "(?:не|not|never|won['’]t|can['’]t|cannot|don['’]t|didn['’]t|isn['’]t)(?![\\p{L}'‘’])";
/** Up to two words between the day and the verb — never the negation. */
const GAP = `(?:(?!${NEG_WORD})[\\p{L}'‘’ʻ\`]+\\s+){0,2}`;
const UZ_DAY_ANY = '(?<![\\p{L}])(?:ertaga|indinga)\\p{L}{0,4}';
const UZ_TODAY = '(?<![\\p{L}])bugun\\p{L}{0,4}';
const UZC_DAY_ANY = '(?<![\\p{L}])(?:эртага|индинга)\\p{L}{0,4}';
const UZC_TODAY = '(?<![\\p{L}])бугун\\p{L}{0,4}';
const RU_DAY_ANY = '(?:после)?завтра(?:шн\\p{L}*)?';
const RU_TODAY = '(?<![\\p{L}])сегодня(?:шн\\p{L}*)?';

/** Lowering a price as OUR doing, now or offered: «-aman», «-amiz», «-ib beramiz», «-ishimiz mumkin», «-sak». */
const UZ_OFFER = `(?:aman|amiz|ib\\s+(?:beraman|beramiz|qo${AP}?yaman|qo${AP}?yamiz)|ishim(?:iz)?\\s+mumkin(?!\\s+emas)|sak|sam)`;
const UZC_OFFER = '(?:аман|амиз|иб\\s+(?:бераман|берамиз|қўяман|қўямиз)|ишим(?:из)?\\s+мумкин(?!\\s+эмас)|сак|сам)';

/** The day and the verb, either order, up to two words between: «ertaga albatta jo'natamiz», «отправим ваш груз завтра». */
const dayRule = (day: string, going: string) =>
  `(?:${day})\\s+${GAP}(?:${going})|(?<![\\p{L}'‘’ʻ\`])(?<!${NEG_WORD}\\s+)(?:${going})\\s+${GAP}(?:${day})`;

/**
 * A refusal anywhere in the clause, per language — «…berilmaydi»,
 * «bermaymiz», «qila olmaymiz», «не выдаём», «нет», «cannot», «not
 * possible», «نمی‌دهیم», «不能». The final review's concession rows (K19)
 * matched the agent's own REFUSALS: «To'lovsiz yuk berilmaydi, avval
 * to'lovni qiling» — the owner's payment rule said to a customer — and «Мы
 * не выдаём груз без оплаты», «Afsuski, maxsus narx qila olmaymiz», «We are
 * unable to give a better price» each lost their ✅ as a promise.
 */
const DENY_UZ =
  "(?<![\\p{L}])(?:emas|yo['‘’ʻ]?q)(?![\\p{L}])|\\p{L}ma(?:ydi|ymiz|yman|ysiz|ysan|gan|ng|nglar)(?![\\p{L}])|olmay\\p{L}*";
const DENY_UZC = '(?<![\\p{L}])(?:эмас|йўқ)(?![\\p{L}])|\\p{L}ма(?:йди|ймиз|йман|йсиз|ган|нг)(?![\\p{L}])|олмай\\p{L}*';
const DENY_RU = '(?<![\\p{L}])(?:не|нет|нельзя|невозможно|никак)(?![\\p{L}])';
const DENY_EN = "(?<![\\p{L}])(?:not|no|never|cannot|unable|impossible)(?![\\p{L}])|n['’]t(?![\\p{L}])";
const DENY_FA = 'نمی|نیست|ندار|نخواه';
const DENY_ZH = '[不没无未]';
/** A clause: up to the next comma or sentence end, in every script. */
const IN_CLAUSE = '[^.!?؟;,،，。！？；\\n]*';

/** A customs word NOT in a case of place («bojxonaga», «bojxonada», «bojxonadan») — where cargo goes is no price. */
const UZ_NOT_PLACE = '(?![\\p{L}]*(?:ga|da|dan|gacha)(?![\\p{L}]))';
/** A word between the customs and «kiradi» that does not say the opposite — never «alohida», never «emas». */
const UZ_GAP_WORD = "(?!(?:alohida|emas)(?![\\p{L}]))[\\p{L}'‘’ʻ]+";

/** The row, unless its clause — before it, inside it or after it — says no. */
function unlessDenied(src: string, deny: string): RegExp {
  return new RegExp(`(?<!(?:${deny})${IN_CLAUSE})(?!${IN_CLAUSE}(?:${deny}))(?:${src})`, 'iu');
}

/**
 * A row of the table (P9, P10): a pattern — or a test of a few lines, for
 * the two rows whose exception a pattern cannot state without misreading it:
 * WHAT is free, and WHEN the cargo is paid for. RegExp is one.
 */
interface Matcher {
  test(text: string): boolean;
}

/** The statements those rows judge: sentence by sentence, «;» ending one too. */
function statementsFor(text: string): string[] {
  return sentencesOf(text)
    .flatMap((s) => s.split(/[;；]/u))
    .filter((s) => s.trim() !== '');
}

/**
 * Paid on ARRIVAL is no credit when the statement ENDS on the company's own
 * rule (P10): the seed's payment@1 — «toʻlov yuk Toshkentga yetib kelganda,
 * yukni olishdan oldin» — said in Russian, «Оплата по прибытии груза в
 * Ташкент, перед получением», was refused as a release on credit while the
 * Uzbek one passed.
 *
 * The first version exempted the row whenever «before the cargo is taken»
 * stood anywhere in the sentence, and the review measured credit promises
 * passing on it: «Оплата по прибытии, не обязательно перед получением»,
 * «You pay on arrival, there is no need to pay before you collect», «Yuk
 * kelganda to'laysiz, olishdan oldin to'lashingiz shart emas», «Груз выдадим
 * до получения оплаты, оплата по прибытии» (the receipt of the MONEY), «…,
 * перед получением просто позвоните». So the words must be the statement's
 * TAIL, after the arrival, with nothing after them but the cargo, the place,
 * the currency or the paying verb; nothing in the statement may say no, not
 * necessarily or later; and nothing may hand the cargo over before the
 * money. Only the rows whose time is the ARRIVAL take this: «потом», «после
 * получения», «pay later», «yukni olgandan keyin» are after the handover and
 * stay credit whatever follows.
 */
interface PaidFirst {
  /**
   * «Before the cargo is taken». «До получения оплаты» — the MONEY's receipt — needs no fence here: nothing but
   * the tail may follow these words, and «оплаты» is no tail word; `handFirst` names it as well.
   */
  first: string;
  /** What may follow it to the end of the statement. */
  tail: string;
  /** A word that says no, not necessarily, or later — anywhere in the statement. */
  deny: string;
  /** The cargo handed over before the money — anywhere in the statement. */
  handFirst: string;
  /**
   * What, in ANY OTHER statement of the reply, takes the rule back — this, `anchor`, `agree` and `back` (second
   * review): it was asked of the next
   * statement alone, and of its «not necessary» words alone, so «Оплата по прибытии груза в Ташкент, перед
   * получением. Но можно и позже, когда вам удобно», «… olishdan oldin. Pul bo'lmasa, kelishib olamiz», «…
   * before collection. That said, it's flexible» were the company's rule with credit offered beside it — the
   * same takeback joined by a comma was refused. So: the cargo handed over before the money; a later or an
   * earlier time beside the paying or the taking; an agreement, a wait for the money, «not strict», «not for
   * you». Never the words alone: «Narxni keyinroq aytaman», «Расчёт пришлю чуть позже», «Darhol hisoblab
   * beraman», «Груз выдаём на складе в Чукурсае», «Javobingizni kutamiz» say nothing about when he pays.
   *
   * The third review measured both directions. A time anchored to the PAYMENT is the rule said again — «После
   * оплаты груз можно забрать сразу», «To'lovdan keyin olib ketasiz», «Avval to'lov, keyin olib ketish», «After
   * payment we hand it over first thing» — so `later` is read only where `anchor` is not; paying EARLY is no
   * credit («можете оплатить сразу при получении»), so a pay verb takes back only with «later», a handover only
   * with «earlier». An agreement about the PRICE says nothing of when he pays («Narxni kelishib olamiz», «О цене
   * договоримся»), so `agree` is read only where the payment, or no price, is named. What is always a takeback is
   * `back`; and what every language shares — an exception, a concession, no hurry, our wait, our trust, «go
   * ahead and take it», regular clients, special terms, a contrast that turns to the money or the handover — is
   * `SOFTENED` below.
   */
  later: string;
  /** A time said FROM the payment — «to'lovdan keyin», «после оплаты», «once paid», «pay first». */
  anchor: string;
  /** An agreement — read only where the payment, or no price, is its subject. */
  agree: string;
  /** What takes it back in any statement, whatever it is anchored to. */
  back: string;
}

/** The statement after the rule taking it back: «Shart emas.», «Но это не обязательно.», «Not required.» */
const UNDONE_NEXT =
  /^\s*(?:lekin|ammo|biroq|лекин|аммо|но|однако|but|however)?[\s,]*(?:[\p{L}'‘’ʻ`]+\s+){0,2}?(?:shart\s+emas|kerak\s+emas|majburiy\s+emas|шарт\s+эмас|керак\s+эмас|не\s+обязательно|необязательно|не\s+нужно|не\s+надо|not\s+(?:required|necessary|needed|mandatory)|no\s+need|optional)/iu;

/**
 * What takes the rule back in any language (third review): «Но бывают исключения», «Lekin istisnolar bo'lishi
 * mumkin», «Exceptions are possible»; «Но мы всегда идём навстречу», «Lekin sizga yon beramiz», «We can be
 * lenient»; «Хотя можно обсудить»; «Ammo shoshilmasangiz ham bo'ladi», «But no rush»; «Но если что, подождём»;
 * «Biroq sizga ishonamiz, yukni beraveramiz»; regular clients, special terms. A wait for HIS answer is none of
 * these: «Javobingizni kutamiz», «Ждём ваш ответ».
 */
const SOFTENED = new RegExp(
  `(?<![\\p{L}])(?:${[
    'istisno\\p{L}*|истисно\\p{L}*|исключени\\p{L}*|exception\\p{L}*',
    'yon\\s+ber\\p{L}*|ён\\s+бер\\p{L}*|навстречу|lenien\\p{L}*|accommodat\\p{L}*',
    `shoshil(?:ma|mas)\\p{L}*|шошил(?:ма|мас)\\p{L}*|не\\s+(?:спеш|тороп)\\p{L}*|no\\s+(?:rush|hurry)|take\\s+your\\s+time|whenever\\s+you\\s+can`,
    'ishonamiz|ишонамиз|доверяем|we\\s+trust\\s+you',
    '(?:ber|ol|topshir)aver\\p{L}*|olib\\s+ketaver\\p{L}*|(?:бер|ол|топшир)авер\\p{L}*|олиб\\s+кетавер\\p{L}*',
    `doimiy\\s+mijoz\\p{L}*|доимий\\s+мижоз\\p{L}*|постоянн\\p{L}*\\s+клиент\\p{L}*|regular\\s+(?:clients|customers)`,
    `особ\\p{L}*\\s+услови\\p{L}*|индивидуальн\\p{L}*\\s+(?:услови|подход)\\p{L}*|alohida\\s+shart\\p{L}*|special\\s+(?:terms|conditions|arrangement)|different\\s+(?:terms|deal)`,
  ].join('|')})(?![\\p{L}])`,
  'iu',
);
/** …a discussion, or our wait — unless what is discussed is the price, or what is awaited is his answer. */
const TALK_OR_WAIT = new RegExp(
  `(?<![\\p{L}])(?:обсуд\\p{L}*|обсужда\\p{L}*|muhokama\\p{L}*|discuss\\p{L}*|kut(?:ib\\s+tur)?(?:amiz|aman|ishimiz|ishim|a\\s+olamiz)|кут(?:иб\\s+тур)?(?:амиз|аман|ишимиз)|подожд\\p{L}*|(?:can|could|will|['’]ll)\\s+wait)(?![\\p{L}])`,
  'iu',
);
const HIS_ANSWER =
  /(?<![\p{L}])(?:javob\p{L}*|xabar\p{L}*|ma['‘’ʻ`]?lumot\p{L}*|savol\p{L}*|sizni|жавоб\p{L}*|хабар\p{L}*|ответ\p{L}*|сообщени\p{L}*|информаци\p{L}*|вас|reply|answer|response|details)(?![\p{L}])/iu;
/** The PRICE as a statement's subject — and the money, whose naming makes it the payment's after all. */
const PRICE_TOPIC = /(?<![\p{L}])(?:narx\p{L}*|нарх\p{L}*|kurs\p{L}*|курс\p{L}*|цен[аеуыой]\p{L}*|стоимост\p{L}*|price\p{L}*|rate|tariff\p{L}*)(?![\p{L}])/iu;
const PAY_TOPIC = new RegExp(
  `(?<![\\p{L}])(?:to${AP}?l\\p{L}*|pul\\p{L}*|тўл\\p{L}*|пул\\p{L}*|оплат\\p{L}*|плат\\p{L}*|заплат\\p{L}*|деньг\\p{L}*|денег|pay\\p{L}*|money)(?![\\p{L}])`,
  'iu',
);
/** …and the handover: a contrast turned to the money or the cargo's release takes the rule back however it is worded. */
const HANDOVER_TOPIC = new RegExp(
  `(?<![\\p{L}])(?:olib\\s+ket\\p{L}*|topshir\\p{L}*|yukni\\s+ber\\p{L}*|олиб\\s+кет\\p{L}*|топшир\\p{L}*|юкни\\s+бер\\p{L}*|выда\\p{L}*|выдад\\p{L}*|отда\\p{L}*|отдад\\p{L}*|забр\\p{L}*|забир\\p{L}*|забер\\p{L}*|hand\\p{L}*|release\\p{L}*|collect\\p{L}*|pick\\s+up)(?![\\p{L}])`,
  'iu',
);
const CONTRAST_OPEN =
  /^\s*(?:lekin|ammo|biroq|лекин|аммо|бироқ|но|однако|хотя|зато|впрочем|but|though|however|although|that\s+said|اما|ولی)(?![\p{L}])/iu;

/** Whether the statement `piece` of `text` is a question — its own «?» after it. */
function asks(text: string, piece: string): boolean {
  const at = text.indexOf(piece);
  return at !== -1 && /^\s*[!.…]*[?؟？]/u.test(text.slice(at + piece.length));
}

function onArrival(row: RegExp, p: PaidFirst): Matcher {
  const every = new RegExp(row.source, `${row.flags.replace('g', '')}g`);
  const rule = new RegExp(`(?:${p.first})(?:[\\s,]+(?:${p.tail}))*[\\s,.!?…]*$`, 'iu');
  const deny = new RegExp(p.deny, 'iu');
  const handFirst = new RegExp(p.handFirst, 'iu');
  const word = (src: string) => new RegExp(`(?<![\\p{L}])(?:${src})(?![\\p{L}])`, 'iu');
  const later = word(p.later);
  const anchor = word(p.anchor);
  const agree = word(p.agree);
  const back = word(p.back);
  const takenBack = (text: string, o: string) =>
    back.test(o) ||
    SOFTENED.test(o) ||
    (TALK_OR_WAIT.test(o) && !HIS_ANSWER.test(o) && (PAY_TOPIC.test(o) || !PRICE_TOPIC.test(o))) ||
    (agree.test(o) && (PAY_TOPIC.test(o) || !PRICE_TOPIC.test(o))) ||
    (later.test(o) && !anchor.test(o)) ||
    (CONTRAST_OPEN.test(o) && (PAY_TOPIC.test(o) || HANDOVER_TOPIC.test(o)) && !asks(text, o));
  return {
    test: (text) => {
      const statements = statementsFor(text);
      return statements.some((s, i) => {
        const rows = [...s.matchAll(every)];
        if (rows.length === 0) return false;
        const tail = rule.exec(s);
        const paidFirst =
          tail !== null &&
          rows.every((m) => m.index + m[0].length <= tail.index) &&
          !deny.test(s) &&
          !handFirst.test(s) &&
          !UNDONE_NEXT.test(statements[i + 1] ?? '') &&
          !statements.some((o, k) => k !== i && takenBack(text, o));
        return !paidFirst;
      });
    },
  };
}

/** The cargo handed over before the money, said anywhere: «to'lovdan oldin», «to'lovsiz», «до оплаты», «без оплаты», «without payment». */
const UZ_UNPAID = `to${AP}?lov(?:dan|ni)?\\s+(?:oldin|avval|kutmasdan)|to${AP}?lamasdan|to${AP}?lovsiz|pulsiz`;
const UZC_UNPAID = 'тўлов(?:дан|ни)?\\s+(?:олдин|аввал|кутмасдан)|тўламасдан|тўловсиз|пулсиз';
const RU_UNPAID =
  '(?<![\\p{L}])до\\s+(?:получения\\s+|поступления\\s+)?(?:оплат|денег|плат[её]ж|расч[её]т|средств)\\p{L}*|(?<![\\p{L}])без\\s+(?:пред)?оплат\\p{L}*';
const EN_UNPAID = '(?<![\\p{L}])before\\s+(?:the\\s+|your\\s+|any\\s+)?payment|(?<![\\p{L}])without\\s+(?:any\\s+)?pay\\p{L}*';

const PAID_FIRST_UZ: PaidFirst = {
  first:
    "(?<![\\p{L}])(?:olish|olib\\s+ketish|topshirish|topshirilish|berilish|chiqarish|chiqarilish)(?:ingiz|i)?dan\\s+(?:oldin|avval|ilgari)|(?<![\\p{L}])olmasdan\\s+(?:oldin|avval)",
  tail: `yuk\\p{L}*|so${AP}?m\\p{L}*|dollar\\p{L}*|naqd\\p{L}*|karta\\p{L}*|click|payme|o${AP}?tkazma\\p{L}*|bank\\p{L}*|orqali|yoki|va|ombor\\p{L}*|toshkent\\p{L}*|qilinadi|qilasiz|to${AP}?lanadi|to${AP}?laysiz|berasiz|amalga|oshiriladi|ham|esa`,
  deny: `${DENY_UZ}|(?<![\\p{L}])(?:shart|majburiy|keyinroq|kechroq)(?![\\p{L}])`,
  handFirst: `${UZ_UNPAID}|(?<![\\p{L}])(?:darhol|darrov)(?![\\p{L}])`,
  later: [
    `(?:keyinroq|kechroq|keyin)\\s+ham\\s+(?:bo${AP}?ladi|mumkin)`,
    `(?:keyinroq|kechroq|keyin)\\s+(?:ham\\s+)?(?:to${AP}?la\\p{L}*|o${AP}?tkaz\\p{L}*|yop(?:asiz|sangiz)|olib\\s+ket\\p{L}*)`,
    `(?:to${AP}?la|o${AP}?tkaz|yop)\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,2}(?:keyinroq|kechroq)`,
  ].join('|'),
  anchor: `to${AP}?lov(?:dan|ni\\s+qil(?:gach|ganingizdan|gandan)|\\s+qilin(?:gach|gandan))|to${AP}?la(?:gach|ganingizdan|gandan|b\\s+bo${AP}?lgach)|(?:avval|oldin|birinchi)\\s+to${AP}?l\\p{L}*`,
  agree: 'kelishib|kelishamiz|kelishsak',
  back: [
    UZ_UNPAID,
    `qat${AP}?iy\\s+emas`,
    '(?:avval|oldin|birinchi)\\s+(?:yukni\\s+)?olib\\s+ket\\p{L}*',
    'siz(?:ga)?\\s+uchun\\s+emas',
    `pul\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,2}kut\\p{L}*`,
    'muhlat\\p{L}*|nasiya|qarzga',
  ].join('|'),
};
const PAID_FIRST_UZC: PaidFirst = {
  first:
    '(?<![\\p{L}])(?:олиш|олиб\\s+кетиш|топшириш|топширилиш|берилиш|чиқариш)(?:ингиз|и)?дан\\s+(?:олдин|аввал)|(?<![\\p{L}])олмасдан\\s+(?:олдин|аввал)',
  tail: 'юк\\p{L}*|сўм\\p{L}*|доллар\\p{L}*|нақд\\p{L}*|карта\\p{L}*|ўтказма\\p{L}*|банк\\p{L}*|орқали|ёки|ва|омбор\\p{L}*|тошкент\\p{L}*|қилинади|қиласиз|тўланади|тўлайсиз|берасиз|амалга|оширилади|ҳам|эса',
  deny: `${DENY_UZC}|(?<![\\p{L}])(?:шарт|мажбурий|кейинроқ|кечроқ)(?![\\p{L}])`,
  handFirst: `${UZC_UNPAID}|(?<![\\p{L}])(?:дарҳол|дарров)(?![\\p{L}])`,
  later: [
    '(?:кейинроқ|кечроқ|кейин)\\s+ҳам\\s+(?:бўлади|мумкин)',
    '(?:кейинроқ|кечроқ|кейин)\\s+(?:ҳам\\s+)?(?:тўла\\p{L}*|ўтказ\\p{L}*|ёп(?:асиз|сангиз)|олиб\\s+кет\\p{L}*)',
    '(?:тўла|ўтказ|ёп)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:кейинроқ|кечроқ)',
  ].join('|'),
  anchor: 'тўлов(?:дан|ни\\s+қил(?:гач|ганингиздан|гандан)|\\s+қилин(?:гач|гандан))|тўла(?:гач|ганингиздан|гандан)|(?:аввал|олдин|биринчи)\\s+тўл\\p{L}*',
  agree: 'келишиб|келишамиз|келишсак',
  back: [
    UZC_UNPAID,
    'қатъий\\s+эмас',
    '(?:аввал|олдин|биринчи)\\s+(?:юкни\\s+)?олиб\\s+кет\\p{L}*',
    'сиз(?:га)?\\s+учун\\s+эмас',
    'пул\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}кут\\p{L}*',
    'муҳлат\\p{L}*|насия|қарзга',
  ].join('|'),
};
const PAID_FIRST_RU: PaidFirst = {
  first:
    '(?<![\\p{L}])(?:перед|до)\\s+(?:получением|получения|выдачей|выдачи)|(?<![\\p{L}])(?:перед\\s+тем|до\\s+того),?\\s+как\\s+(?:забрать|получить|забер\\p{L}*|получ\\p{L}*)|(?<![\\p{L}])прежде\\s+чем\\s+(?:забрать|получить|забер\\p{L}*|получ\\p{L}*)',
  tail: 'груз\\p{L}*|товар\\p{L}*|посылк\\p{L}*|со|с|из|на|в|склад\\p{L}*|ташкент\\p{L}*|андижан\\p{L}*|сум\\p{L}*|наличн\\p{L}*|карт\\p{L}*|перевод\\p{L}*|через|или|и|ваш\\p{L}*|его|их',
  deny: `${DENY_RU}|(?<![\\p{L}])(?:необязательн\\p{L}*|позже|потом|когда\\s+(?:вам\\s+)?удобно|в\\s+любое\\s+время)(?![\\p{L}])`,
  handFirst: `${RU_UNPAID}|(?<![\\p{L}])(?:выдад|выда[её]м|отдад|отда[её]м|отпуст|можно\\s+(?:сразу\\s+)?(?:забрать|получить))\\p{L}*|(?<![\\p{L}])(?:сразу|немедленно)(?![\\p{L}])`,
  later: [
    // «Можно и позже», «можно и раньше» — the time alone, its verb left to the rule before it; with its verb
    // before it, paying takes it back only later and taking only earlier: «Оплатить можно и раньше» is the rule.
    '(?<!(?:оплат|заплат|рассчита|забрать|забер|забир|получ)\\p{L}*\\s+(?:груз\\p{L}*\\s+)?)(?:можно|можете|сможете)\\s+(?:(?:и|тоже|также|даже)\\s+){0,2}(?:позже|потом|раньше)',
    '(?:оплат|заплат|рассчита)\\p{L}*\\s+(?:\\p{L}+\\s+)?(?:можно|можете)\\s+(?:(?:и|тоже|также|даже)\\s+){0,2}(?:позже|потом)',
    '(?:забрать|забер|забир|получ)\\p{L}*\\s+(?:груз\\p{L}*\\s+)?(?:можно|можете)\\s+(?:(?:и|тоже|также|даже)\\s+){0,2}(?:раньше|сразу)',
    // Paying LATER, never early: «можете оплатить сразу при получении» is the rule (third review).
    '(?:можно|можете|сможете)\\s+(?:(?:и|тоже|также|даже)\\s+){0,2}(?:оплатить|заплатить|платить|рассчитаться)\\s+(?:\\p{L}+\\s+)?(?:позже|потом)',
    '(?:оплат|заплат)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:позже|потом)(?!\\s+(?:забир|забер|забрать|получ|выда|отда)\\p{L}*)',
    // …and taking the cargo EARLY: «Но забрать груз можно и раньше», «выдадим и раньше».
    '(?:можно|можете|сможете)\\s+(?:(?:и|тоже|также|даже|груз)\\s+){0,2}(?:забрать|получить|забирать)\\s+(?:(?:груз|его|товар)\\s+)?(?:(?:и|тоже|даже)\\s+)?(?:раньше|сразу)',
    '(?:забрать|забер|выдад|выда[её]м|отдад|отда[её]м)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:раньше|сразу)',
  ].join('|'),
  anchor:
    'после\\s+(?:оплаты|того,?\\s+как\\s+(?:вы\\s+)?(?:оплат|заплат)\\p{L}*)|как\\s+только\\s+(?:вы\\s+)?(?:оплат|заплат)\\p{L}*|(?:сначала|сперва)\\s+(?:оплат|заплат)\\p{L}*',
  agree: 'договорим\\p{L}*|договор[её]нност\\p{L}*',
  back: [
    RU_UNPAID,
    'не\\s+строго|не\\s+для\\s+вас|ничего\\s+страшного',
    'подожд\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:с\\s+)?(?:оплат|деньг|плат)\\p{L}*',
    'отсрочк\\p{L}*|рассрочк\\p{L}*|в\\s+долг|в\\s+кредит',
  ].join('|'),
};
const PAID_FIRST_EN: PaidFirst = {
  first:
    '(?<![\\p{L}])before\\s+(?:you\\s+)?(?:collect|pick|receiv|tak|get)\\p{L}*(?:\\s+up)?|(?<![\\p{L}])(?:before|prior\\s+to)\\s+(?:the\\s+)?(?:collection|pick-?up|release|handover|hand-over)',
  tail: 'the|your|it|them|cargo|goods|shipment|parcel|order|from|at|in|our|warehouse|tashkent|cash|card|transfer|bank|by|via|or|and|uzs',
  deny: `${DENY_EN}|(?<![\\p{L}])(?:without|later|whenever|optional|any\\s*time)(?![\\p{L}])`,
  handFirst: `${EN_UNPAID}|(?<![\\p{L}])(?:right\\s+away|immediately)(?![\\p{L}])|(?<![\\p{L}])(?:release|hand|give)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:first|now)(?![\\p{L}])`,
  later: [
    '(?:collect|pick)\\p{L}*(?:\\s+up)?\\s+(?:(?:it|them|the\\s+cargo|the\\s+goods|your\\s+cargo|your\\s+goods)\\s+)?first',
    '(?:release|hand|give)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}first',
  ].join('|'),
  anchor: "after\\s+(?:the\\s+|your\\s+)?payment|after\\s+you\\s+pa(?:y|id)|once\\s+(?:you(?:['’]ve|\\s+have)?\\s+)?pa(?:y|id)|as\\s+soon\\s+as\\s+(?:you\\s+)?pa(?:y|id)|(?:you\\s+)?pay\\s+first",
  agree: 'negotiable',
  back: [
    EN_UNPAID,
    'wait\\p{L}*\\s+(?:\\p{L}+\\s+){0,4}(?:money|payment)',
    'flexible|not\\s+strict\\p{L}*|not\\s+for\\s+you',
    'on\\s+credit|deferred|instal{1,2}ments?',
  ].join('|'),
};
/** Paid by YOU, in the Uzbek rows' verbs: «berasiz», «qilasiz», «to'laysiz», «o'tkazsangiz», «yopasiz». */
const UZ_YOU_PAY = `berasiz|bersangiz|qilasiz|qilsangiz|o${AP}?tkazasiz|o${AP}?tkazsangiz|to${AP}?laysiz|to${AP}?lasangiz|yopasiz|yopsangiz`;
const UZC_YOU_PAY = 'берасиз|берсангиз|қиласиз|қилсангиз|ўтказасиз|ўтказсангиз|тўлайсиз|тўласангиз|ёпасиз|ёпсангиз';
/**
 * The cargo's ARRIVAL, as Uzbek says when it happens — «kelganda», «yetib kelgach», «tushgandan keyin» —
 * and only that: «Pulni yukni olgandan keyin berasiz» is paid after he TAKES the cargo (review), credit
 * whatever follows, as Russian «после получения» always was. «Yetkazilganda» is the delivery to him.
 */
const UZ_ARRIVE = '(?<![\\p{L}])(?:kel|yet(?!kaz)|tush|kir)\\p{L}*?';
const UZ_ON_ARRIVAL = `${UZ_ARRIVE}(?:ganda|gach)(?![\\p{L}])|${UZ_ARRIVE}gandan\\s+(?:keyin\\p{L}*|so${AP}?ng)`;
/** …and every other «then» — a bare «keyin», «olganda», «olib ketgach», «olgandan keyin». */
const UZ_LATER = `(?<!${UZ_ARRIVE}gandan\\s+)(?:keyin\\p{L}*|so${AP}?ng)|(?<![\\p{L}])(?!(?:kel|yet(?!kaz)|tush|kir))\\p{L}+(?:ganda|gach)(?![\\p{L}])`;
const UZC_ARRIVE = '(?<![\\p{L}])(?:кел|ет(?!каз)|туш|кир)\\p{L}*?';
const UZC_ON_ARRIVAL = `${UZC_ARRIVE}(?:ганда|гач)(?![\\p{L}])|${UZC_ARRIVE}гандан\\s+(?:кейин\\p{L}*|сўнг)`;
const UZC_LATER = `(?<!${UZC_ARRIVE}гандан\\s+)(?:кейин\\p{L}*|сўнг)|(?<![\\p{L}])(?!(?:кел|ет(?!каз)|туш|кир))\\p{L}+(?:ганда|гач)(?![\\p{L}])`;
const RU_PAY = 'оплат|заплат|рассчита|плат(?:а|у|ой|ите|ить|ишь|им|ят|ит|[её]ж)';
const RU_ON_ARRIVAL = 'после\\s+(?:прибытия|доставки|разгрузки)|по\\s+факту|по\\s+прибытии|при\\s+получении|на\\s+месте';
const RU_ON_ARRIVAL_BEFORE = 'после\\s+(?:прибытия|доставки|разгрузки)|по\\s+прибытии|при\\s+получении';

/**
 * «Bepul», «бесплатно», «free» — unless it is the CALCULATION that is free
 * (P9): «Narxni hisoblash bepul», «Расчёт бесплатный», «The quote is free»
 * are the same true fact as «hisoblash uchun pul olinmaydi», which the rows
 * always let through.
 *
 * The first version took any calculating word beside the free word, and the
 * review measured free storage and free delivery passing on it: «Omborda
 * saqlash bepul hisoblanadi» (passive «is counted as» — the most natural
 * Uzbek for «X is free»), «Narxini hisoblab bepul yetkazib beramiz»,
 * «Хранение посчитаем бесплатно», «Рассчитаем бесплатную доставку», «The
 * estimated delivery is free». So only the calculation as a NOUN may be the
 * free thing, right beside the free word; a verb counts only with the PRICE
 * as its object («Narxni bepul hisoblab beraman», «Рассчитаем стоимость
 * бесплатно», «We calculate it for free»). A service anywhere in the
 * statement takes the exception away — «Hisoblash bepul, xuddi yetkazish
 * kabi», «Бесплатный расчёт и доставка» — except as what the calculation is
 * OF, which is the calculation still: «Расчёт стоимости доставки
 * бесплатный», «Yetkazish narxini hisoblash bepul». Nor may a «too» carry it
 * over: «Hisoblash bepul, qolgani ham». Anything else free is one, as before.
 */
interface FreeTerms {
  free: string;
  /** The calculation as a noun, and the words that may stand between it and the free word. */
  calc: string;
  fill: string;
  /** Our calculating with the price as its object, the free word beside it. */
  priced: string;
  service: string;
  /** A service named as what the calculation is OF, its calculation as the named group `calc`. */
  ofCalc: string;
}

/** A «too» that closes its clause: «…, qolgani ham», «…, остальное тоже», «…, the rest too». */
const ALSO_AT_END = /(?<![\p{L}])(?:ham|ҳам|тоже|также|too|also|as\s+well|likewise)\s*[.!?…]*\s*$/iu;
/** …or a statement of its own after the free calculation: «Hisoblash bepul. Saqlash ham.», «Остальное — тоже.» */
const ALSO_ALONE =
  /^\s*(?:[\p{L}'‘’ʻ`-]+(?:\s*[—–]\s*|\s+-\s+|\s+)){0,3}(?:ham|ҳам|тоже|также|too|also|as\s+well|likewise)\s*[.!?…]*\s*$/iu;

/**
 * The rest of what carries the free calculation over to something else (second review). A «too» was read only
 * where it closed a clause or stood alone in the next statement, and the review measured the free word lent on:
 * «Hisoblash bepul, boshqa xizmatlarimiz ham shunday», «Расчёт бесплатный, как и все наши услуги», «The quote
 * is free, and so is everything else» — a LIKENESS; «Hisoblash bepul. Bojxona rasmiylashtiruvi ham bizdan»,
 * «Расчёт бесплатный. Растаможку тоже берём на себя», «The quote is free. Storage is on us as well» — a service,
 * or «the rest», with its «too» or its «nothing charged» in any later statement. A later statement about
 * calculating is the calculation still: «Yetkazish narxini ham hisoblab beraman», «Стоимость хранения тоже
 * посчитаю». Nor does «too» alone: «Narxni hisoblash bepul. Tovar nomini ham yozing» asks for the goods' name.
 */
const LIKE_AFTER =
  /(?<![\p{L}])(?:(?:ham|xuddi|ҳам|худди)\s+(?:[\p{L}'‘’ʻ]+\s+)?(?:shunday|шундай)|как\s+и(?!\s+(?:где|когда|куда|откуда|сколько|почему|зачем|что|какой|какие|обычно|всегда|раньше|прежде|договаривались|положено)(?![\p{L}]))|аналогичн\p{L}*|то\s+же\s+самое|so\s+(?:is|are|does|do)|(?:the\s+)?same\s+(?:goes|applies|for|with)|just\s+like|like\s+(?:all|every|the\s+rest)|likewise)(?![\p{L}])/iu;
/** …and in the free statement's own rest, «kabi» and «singari» too: «Hisoblash bepul, boshqa xizmatlar kabi». */
const LIKE_REST = new RegExp(`${LIKE_AFTER.source}|(?<![\\p{L}])(?:kabi|singari|каби|сингари)(?![\\p{L}])`, 'iu');
const ALSO_WORD = /(?<![\p{L}])(?:ham|ҳам|тоже|также|too|also|as\s+well)(?![\p{L}])/iu;
const OTHER_SERVICES =
  /(?<![\p{L}])(?:qolgan\p{L}*|(?:boshqa|barcha|hamma)\s+(?:[\p{L}'‘’ʻ]+\s+)?xizmat\p{L}*|қолган\p{L}*|(?:бошқа|барча|ҳамма)\s+(?:\p{L}+\s+)?хизмат\p{L}*|остальн\p{L}*|(?:все|други\p{L}*)\s+(?:\p{L}+\s+)?услуг\p{L}*|everything\s+else|the\s+rest|(?:all|other)\s+(?:\p{L}+\s+)?services)(?![\p{L}])/iu;
/**
 * Nothing charged, in the words people use for it (third review added the gift, the expense and the cost): «sovg'a
 * qilamiz», «hisobimizga olamiz», «дарим», «за свой счёт», «не оплачивается», «won't cost you anything», «at our
 * own expense». Alone it says the thing is free; read by `freeUnlessCalc` in a statement after the free
 * calculation, it is never the calculation's however that statement speaks of calculating — «Доставку тоже
 * рассчитываем за наш счёт» skipped as a statement about calculating.
 */
const NOTHING_CHARGED =
  /(?<![\p{L}])(?:hech\s+narsa\s+(?:so['‘’ʻ`]?ramaymiz|olmaymiz)|pul\s+olmaymiz|(?:bizning\s+)?hisobimiz(?:dan|ga)|sovg['‘’ʻ`]?a\p{L}*|tekinga|ҳеч\s+нарса\s+(?:сўрамаймиз|олмаймиз)|пул\s+олмаймиз|ҳисобимиз(?:дан|га)|совға\p{L}*|ничего\s+не\s+(?:берём|берем|возьмём|возьмем|просим|стоит)|(?:за|на)\s+(?:наш|свой)\s+сч[её]т|дари(?:м|ть)|в\s+подарок|не\s+оплачива\p{L}*|(?:платить|оплачивать)\s+не\s+нужно|(?:is|are)\s+on\s+us|on\s+the\s+house|free\s+of\s+charge|no\s+(?:extra\s+)?charge|at\s+no\s+(?:extra\s+)?cost|at\s+our\s+(?:own\s+)?expense|(?:won['’]t|will\s+not|doesn['’]t|does\s+not)\s+cost|costs?\s+nothing|complimentary)(?![\p{L}])/iu;
/** …and «we cover» — said of a service, never of the whole country: «We cover the packing», «We cover all of Uzbekistan». */
const WE_COVER = /(?<![\p{L}])(?:we\s+(?:cover|pay\s+for)|covered\s+by\s+us)(?![\p{L}])/iu;
/** A statement about calculating — «hisoblab beraman», «посчитаю», «we will quote» — never «hisobimizdan», at our expense. */
const CALCULATING =
  /(?<![\p{L}])(?:hisob(?!(?:imiz|i|ingiz)?dan)\p{L}*|ҳисоб(?!(?:имиз|и|ингиз)?дан)\p{L}*|(?:рас|по|про|под)сч[иё]т\p{L}*|расч[её]т\p{L}*|calculat\p{L}*|quot\p{L}*|estimat\p{L}*)/iu;
/** …and telling him a PRICE is calculating it: «Yetkazish narxini ham aytaman», «Стоимость доставки тоже скажу». */
const PRICE_TOLD = new RegExp(
  `(?<![\\p{L}])(?:narx\\p{L}*|нарх\\p{L}*|стоимост\\p{L}*|цен[аеуыой]\\p{L}*|price\\p{L}*|cost\\p{L}*)(?![\\p{L}])[^.!?]*?(?<![\\p{L}])(?:ayt(?:aman|amiz|ib\\s+beraman|ib\\s+beramiz)|ma${AP}?lum\\s+qilaman|айт(?:аман|амиз|иб\\s+бераман)|скажу|скажем|сообщу|сообщим|назову|назов[её]м|напишу|tell\\s+you|let\\s+you\\s+know|send\\s+you|include)(?![\\p{L}])|(?<![\\p{L}])(?:ayt(?:aman|amiz)|айт(?:аман|амиз)|скажу|сообщу|назову|tell\\s+you)(?![\\p{L}])[^.!?]*?(?<![\\p{L}])(?:narx\\p{L}*|нарх\\p{L}*|стоимост\\p{L}*|цен[аеуыой]\\p{L}*|price\\p{L}*|cost\\p{L}*)(?![\\p{L}])`,
  'iu',
);
/**
 * A statement that ASKS something of the customer — «yozing», «yuboring», «so'rashingiz mumkin», «пришлите»,
 * «расскажу о других услугах», «ask me anytime»: «Hisoblash bepul. Qolgan ma'lumotlarni ham yozib yuboring» asks
 * for the rest of the details, and its «ham» lends the free word to nothing (third review).
 */
const ASKS_HIM = new RegExp(
  [
    `(?<![\\p{L}])(?:(?:yoz|yubor|ayt|tashla|jo${AP}?nat|ko${AP}?rsat|bildir|kirit)(?:ing|ib\\s+(?:yuboring|bering|qo${AP}?ying))|so${AP}?ra(?:ng|shingiz|sangiz)|murojaat\\s+qiling)(?![\\p{L}])`,
    '(?<![\\p{L}])(?:(?:ёз|юбор|айт|ташла|жўнат|кўрсат|билдир|кирит)(?:инг|иб\\s+(?:юборинг|беринг))|сўра(?:нг|шингиз|сангиз)|мурожаат\\s+қилинг)(?![\\p{L}])',
    '(?<![\\p{L}])(?:пришлите|напишите|укажите|скажите|сообщите|отправьте|присылайте|пишите|спрашивайте|обращайтесь|уточните|дайте\\s+знать|расскаж\\p{L}*|рассказать)(?![\\p{L}])',
    '(?<![\\p{L}])(?:please|send\\s+(?:me|us)|let\\s+(?:me|us)\\s+know|ask\\s+(?:me|us)|feel\\s+free|tell\\s+(?:me|us)|tell\\s+you\\s+about|write\\s+(?:me|us|to\\s+us))(?![\\p{L}])',
  ].join('|'),
  'iu',
);

function freeUnlessCalc(t: FreeTerms): Matcher {
  const free = new RegExp(t.free, 'iu');
  const service = new RegExp(t.service, 'iu');
  const ofCalc = new RegExp(t.ofCalc, 'giu');
  const exempt = new RegExp(`(?:${t.calc})\\s+(?:(?:${t.fill})\\s+){0,4}(?:${t.free})|(?:${t.free})\\s+(?:${t.calc})|${t.priced}`, 'giu');
  return {
    test: (text) => {
      const statements = statementsFor(text);
      return statements.some((s, i) => {
        if (!free.test(s)) return false;
        const named = s.replace(ofCalc, (...m) => (m.at(-1) as { calc: string }).calc);
        if (service.test(named)) return true;
        const rest = named.replace(exempt, ' ');
        if (free.test(rest)) return true;
        if (rest === named) return false;
        const after = statements.slice(i + 1);
        return (
          rest.split(/[,，:;—–]/u).some((clause) => ALSO_AT_END.test(clause)) ||
          LIKE_REST.test(rest) ||
          ALSO_ALONE.test(after[0] ?? '') ||
          after.some((o) => {
            // A question after it lends nothing: «The quote is free. So are you shipping by truck or by air?».
            if (asks(text, o)) return false;
            const another = service.test(o) || OTHER_SERVICES.test(o);
            // Nothing charged is a free thing however the statement calculates — unless it is the calculation alone.
            if (NOTHING_CHARGED.test(o)) return another || !CALCULATING.test(o);
            if (CALCULATING.test(o) || PRICE_TOLD.test(o)) return false;
            if (LIKE_AFTER.test(o)) return true;
            if (ASKS_HIM.test(o)) return false;
            return another && (ALSO_WORD.test(o) || WE_COVER.test(o));
          })
        );
      });
    },
  };
}
const UZ_SERVICE = `(?<![\\p{L}])(?:yetkaz|saqla|qadoq|upakovk|sug${AP}?urt|fotootchet|foto\\s*hisobot|tushir|ortish|dostavk|eshikkacha|uy(?:ingiz)?gacha|tashi|rastamojk|bojxona|yo${AP}?lkira)\\p{L}*`;
const UZ_CALC = '(?<![\\p{L}])(?:hisob-?kitob(?:i|imiz|lar)?|hisoblash(?:i|imiz|ingiz)?|hisoblatish(?:i)?)(?![\\p{L}])';
const FREE_UZ: FreeTerms = {
  free: '(?<![\\p{L}])(?:bepul|tekin)\\p{L}*',
  calc: UZ_CALC,
  fill: 'ham|esa|mutlaqo|butunlay|tamomila|xizmati|xizmatimiz|siz|sizga|uchun|bizda',
  priced: '(?<![\\p{L}])narx\\p{L}*\\s+(?:(?:siz(?:ga)?|uchun|ham)\\s+){0,2}(?:bepul|tekin)\\s+hisoblab\\s+ber\\p{L}*',
  service: UZ_SERVICE,
  ofCalc: `(?:${UZ_SERVICE})\\s+(?:(?:narx|to${AP}?lov|xarajat|haq)\\p{L}*\\s+)?(?<calc>${UZ_CALC})`,
};
const UZC_SERVICE = '(?<![\\p{L}])(?:етказ|сақла|қадоқ|упаковк|суғурт|тушир|ортиш|эшиккача|таши|растаможк|божхона|йўлкира)\\p{L}*';
const UZC_CALC = '(?<![\\p{L}])(?:ҳисоб-?китоб(?:и|имиз|лар)?|ҳисоблаш(?:и|имиз|ингиз)?|ҳисоблатиш(?:и)?)(?![\\p{L}])';
const FREE_UZC: FreeTerms = {
  free: '(?<![\\p{L}])(?:бепул|текин)\\p{L}*',
  calc: UZC_CALC,
  fill: 'ҳам|эса|мутлақо|бутунлай|хизмати|хизматимиз|сиз|сизга|учун|бизда',
  priced: '(?<![\\p{L}])нарх\\p{L}*\\s+(?:(?:сиз(?:га)?|учун|ҳам)\\s+){0,2}(?:бепул|текин)\\s+ҳисоблаб\\s+бер\\p{L}*',
  service: UZC_SERVICE,
  ofCalc: `(?:${UZC_SERVICE})\\s+(?:(?:нарх|тўлов|харажат|ҳақ)\\p{L}*\\s+)?(?<calc>${UZC_CALC})`,
};
const RU_SERVICE =
  '(?<![\\p{L}])(?:доставк|достав(?:им|лю|ляем|ят)|хранени|храни|упаковк|переупаков|страхов|фотоотч|погрузк|разгрузк|перевозк|растаможк|тамож|до\\s+двер)\\p{L}*';
const RU_CALC = '(?<![\\p{L}])(?:расч[её]т|просч[её]т|подсч[её]т|калькуляци|оценк)\\p{L}*';
const FREE_RU: FreeTerms = {
  free: '(?<![\\p{L}])бесплатн\\p{L}*',
  calc: RU_CALC,
  // «Расчёт сделаем бесплатно» (third review) — the doing of the calculation, never a second thing done.
  fill: 'стоимост\\p{L}*|цен\\p{L}*|у\\s+нас|для\\s+вас|вам|абсолютно|полностью|совершенно|всегда|сдела(?:ю|ем)|дела(?:ю|ем)|провед(?:у|ём|ем)|[—–-]',
  priced:
    '(?<![\\p{L}])(?:рассчита|посчита|просчита)\\p{L}*\\s+(?:(?:вам|для\\s+вас)\\s+)?(?:стоимост|цен)\\p{L}*\\s+(?:(?:вам|для\\s+вас)\\s+)?бесплатн\\p{L}*|(?<![\\p{L}])бесплатн\\p{L}*\\s+(?:рассчита|посчита|просчита)\\p{L}*\\s+(?:(?:вам|для\\s+вас)\\s+)?(?:стоимост|цен)\\p{L}*',
  service: RU_SERVICE,
  ofCalc: `(?<calc>${RU_CALC})\\s+(?:(?:стоимост|цен)\\p{L}*\\s+)?(?:${RU_SERVICE})(?:\\s+(?:платеж|пошлин|сбор)\\p{L}*)?`,
};
const EN_SERVICE =
  '(?<![\\p{L}])(?:deliver|storage|stor(?:e|ing)(?![\\p{L}])|pack(?:ing|aging)|insurance|photo|shipping|door|customs|clearance|transport|freight|unload)\\p{L}*';
const EN_CALC = '(?<![\\p{L}])(?:calculations?|quotes?|quotations?|estimates?|price\\s+checks?)(?![\\p{L}])';
const FREE_EN: FreeTerms = {
  free: '(?<![\\p{L}])free(?![\\p{L}])',
  calc: EN_CALC,
  fill: 'is|are|will\\s+be|always|completely|totally|absolutely|entirely|for|you|your|the|cargo|goods|shipment|[—–-]',
  priced: '(?<![\\p{L}])calculat\\p{L}*\\s+(?:(?:it|this|the\\s+(?:price|cost|quote))\\s+)?for\\s+free(?![\\p{L}])',
  service: EN_SERVICE,
  ofCalc: `(?<calc>${EN_CALC})\\s+(?:of|for)\\s+(?:the\\s+|your\\s+)?(?:${EN_SERVICE})(?:\\s+(?:costs?|prices?|fees?))?`,
};

/**
 * G2: what may never be promised from his account by a machine, in every
 * language a reply can be written in (money-8). A CLOSED table: a category is
 * a business decision someone else's door makes (a discount is the VED's, a
 * release on credit is `counterDebtRelease`'s, a refund is the accountant's),
 * and his Q8 ⭐ — none of the website's extras exists in the system, so none
 * is stated. Run over EVERY language at once: a Russian promise inside an
 * Uzbek reply is still a promise.
 *
 * The review measured everyday phrasings passing the whole policy (P2):
 * «narxni tushirib beraman», «arzon qilamiz», «10% kamroq qilamiz», «скинем
 * 10%», «сбавлю цену», «10% off», «ertaga albatta jo'natamiz» (one word
 * between the day and the verb), «pulini keyin berasiz», «оплатите после
 * получения». Each stem is tied to the money or the day it is about, because
 * the bare verb is ordinary work here: «yukni tushiramiz» is unloading,
 * «скиньте фото» is «send a photo», «narxni tushuntiraman» explains a price,
 * and «отправим после оплаты» is the opposite of credit.
 */
export const PROMISE_TABLE: Record<PromiseCategory, readonly Matcher[]> = {
  discount: [
    /chegirma|skidka|arzonroq|arzonlashtir|arzon\s+qilib/iu,
    // The price lowered by US, now or as an offer — «tushiraman», «tushirib beramiz», «tushirishimiz mumkin»,
    // «tushirsak» — never the tariff's own «kub narxi kamayadi», the past «pasaygan», nor the advice
    // «narxini kamaytirib yozmang» (fix round: each read as a discount the package had promised).
    new RegExp(
      `narx\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+)?(?:(?:tushir|pasaytir|kamaytir|arzonlashtir)${UZ_OFFER}|tushib\\s+(?:beraman|beramiz)|arzon\\s+qil${UZ_OFFER})`,
      'iu',
    ),
    /arzon(?:roq)?\s+(?:qil|ber|chiqar)|kamroq\s+(?:qil|ber|olamiz|olaman|olib)/iu,
    /чегирма|арзонроқ|арзонлаштир/iu,
    new RegExp(
      `нарх\\p{L}*\\s+(?:\\p{L}+\\s+)?(?:(?:тушир|пасайтир|камайтир|арзонлаштир)${UZC_OFFER}|тушиб\\s+(?:бераман|берамиз)|арзон\\s+қил${UZC_OFFER})`,
      'iu',
    ),
    /арзон(?:роқ)?\s+(?:қил|бер)|камроқ\s+(?:қил|бер|олам)/iu,
    /скидк|дешевле|уступ(лю|им|ка)/iu,
    // «Скинем 10%», «скину цену» — never the imperative «скиньте фото и цену товара», nor «не можем снизить».
    /(?<!не\s+(?:\p{L}+\s+)?)скин(?!ь)\p{L}*\s+(?:\p{L}+\s+){0,2}(?:\d+\s*%|цен|процент)|(?<!не\s+(?:\p{L}+\s+)?)сбав(?:лю|им|ит|ить|ляем|ляю)|(?<!не\s+(?:\p{L}+\s+)?)сниз\p{L}*\s+(?:\p{L}+\s+)?цен|цен\p{L}*\s+(?:(?!не(?!\p{L}))\p{L}+\s+)?сниз/iu,
    /\bdiscount|\bcheaper\b|(?<!(?:can['’]?t|cannot|won['’]?t|not)\s+)(?:lower|reduce)\s+(the\s+)?price/iu,
    // A better price with no figure (final review K19): «Sizga yaxshi narx qilib beramiz», «Arzonlatib beramiz»,
    // «Siz uchun maxsus narx», «Сделаем вам хорошую цену», «Для вас сделаем цену ниже», «a better price», «Special
    // price for you», «قیمت ویژه برای شما», «给您特价». «Alohida narx» is never one (fix round): «Qadoqlash alohida
    // narxda qilinadi» is an extra that COSTS, «Sizga alohida narx hisoblab beramiz» an individual quote, and
    // «zavoddan olib kelish alohida narxda» his own factory-leg sentence. Each row is said unless its clause
    // refuses it: «Afsuski, maxsus narx qila olmaymiz» is the polite «no».
    unlessDenied("(?<![\\p{L}])(?:yaxshi|maxsus|qulay)\\s+narx", DENY_UZ),
    unlessDenied(`(?<![\\p{L}])arzonlat(?:ib\\s+(?:beraman|beramiz|qo${AP}?yaman|qo${AP}?yamiz)|aman|amiz|ishim(?:iz)?\\s+mumkin|sak|sam)`, DENY_UZ),
    unlessDenied('(?<![\\p{L}])(?:яхши|махсус|қулай)\\s+нарх|арзонлат(?:иб\\s+(?:бераман|берамиз)|аман|амиз|сак)', DENY_UZC),
    unlessDenied(
      '(?:хорош|специальн|особ|льготн|выгодн)\\p{L}*\\s+цен|(?:сдела|дад|предлож)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}цен\\p{L}*\\s+(?:пониже|ниже|меньше)',
      DENY_RU,
    ),
    unlessDenied('(?:better|special|best|good|lower|reduced|discounted)\\s+(?:price|rate|deal|offer)(?![\\p{L}])', DENY_EN),
    unlessDenied('قیمت\\s+(?:ویژه|خوب|مناسب|بهتر|استثنایی)', DENY_FA),
    unlessDenied('特价|好价(?:格|钱)|最低价(?:给|算)|(?:给|算)(?:你|您)(?:一个)?(?:好|优惠|特别|特殊)的?价', DENY_ZH),
    /\boff\s+the\s+price|price\s+(?:cut|drop)|knock\s+(?:\S+\s+){0,2}off\b/iu,
    // A percent taken off, in any language: «10% kamroq», «10 foiz arzonroq», «10% off», «10%优惠».
    /\d+(?:[.,]\d+)?\s*(?:%|٪|foiz\p{L}*|фоиз\p{L}*|процент\p{L}*|percent)\s*(?:\p{L}+\s+)?(?:kam|arzon|chegirma|skidka|кам|арзон|скид|дешевле|меньше|off\b|less\b|cheaper|تخفیف|کمتر|折|优惠|便宜|少)/iu,
    /تخفیف|ارزان‌تر|ارزانتر/u,
    /(?:قیمت|نرخ)\s+(?:\p{L}+\s+){0,2}کم(?:تر)?(?!\p{L})/u,
    /折扣|优惠|打折|便宜点|减价|让利/u,
    /便宜(?:些|一点|一些)|给(?:你|您)便宜|算(?:你|您)?便宜|降价|少收|打\d+折/u,
  ],
  guarantee: [
    /kafolat|garantiya|muammo\s+bo['‘’ʻ]?lmaydi|muammosiz/iu,
    /кафолат|муаммо\s+бўлмайди/iu,
    /гарант|без\s+проблем|100\s?%\s+(будет|придет|доставим)/iu,
    /guarantee|no\s+problem\b|definitely\s+(arrive|deliver)/iu,
    /تضمین|ضمانت|بدون\s+مشکل/u,
    /保证|担保|肯定没问题|百分之百/u,
  ],
  credit_release: [
    // «…kelgandan keyin to'laysiz» is paid on ARRIVAL, the row below's (P10); a bare «keyin to'laysiz» is later.
    new RegExp(
      `qarzga|nasiya|(?<!${UZ_ARRIVE}gandan\\s+)keyin\\s+to${AP}?laysiz|to${AP}?lovsiz\\s+(beramiz|beraman|olib\\s+ketasiz)`,
      'iu',
    ),
    // Released with no payment in any word order (K19): «Yukni to'lovsiz olib ketishingiz mumkin», «pulsiz berib
    // yuboramiz» — never the refusal «To'lovsiz yuk berilmaydi», «Pulsiz yuk bermaymiz», «…olib ketib bo'lmaydi».
    unlessDenied("(?<![\\p{L}])(?:to['‘’ʻ]?lovsiz|pulsiz)\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,2}(?:olib\\s+ket|ber|chiqar|ol)\\p{L}*", DENY_UZ),
    unlessDenied('(?<![\\p{L}])(?:тўловсиз|пулсиз)\\s+(?:\\p{L}+\\s+){0,2}(?:олиб\\s+кет|бер|чиқар|ол)\\p{L}*', DENY_UZC),
    // «Pulini keyin berasiz», «to'lovni keyinroq qilasiz» — the money, later, paid by you; and «pulini yuk
    // kelgandan so'ng berasiz», «yuk kelgach to'laysiz» — paid once the cargo comes, the same credit (fix round).
    // «To'lovni keyinroq qilsangiz ham bo'ladi», «Qarzni keyin yopasiz» (K19) — the debt too, and the «-sangiz» forms.
    // Paid once the cargo COMES is credit unless the statement ends on the company's own rule (P10, `onArrival`):
    // «To'lovni yuk kelganda qilasiz, yukni olishdan oldin». Up to three words between the money and its time —
    // «To'lovni yukni olib ketgandan keyin qilasiz» held three and passed (review).
    unlessDenied(
      `(?:pul|to${AP}?lov|haq|summa|qarz)\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,3}(?:${UZ_LATER})\\s+(?:${UZ_YOU_PAY})`,
      DENY_UZ,
    ),
    onArrival(
      unlessDenied(`(?:pul|to${AP}?lov|haq|summa|qarz)\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,3}(?:${UZ_ON_ARRIVAL})\\s+(?:${UZ_YOU_PAY})`, DENY_UZ),
      PAID_FIRST_UZ,
    ),
    new RegExp(`(?:${UZ_LATER})\\s+(?:to${AP}?la(?:ysiz|sangiz)|o${AP}?tkazasiz)`, 'iu'),
    onArrival(new RegExp(`(?:${UZ_ON_ARRIVAL})\\s+(?:to${AP}?la(?:ysiz|sangiz)|o${AP}?tkazasiz)`, 'iu'), PAID_FIRST_UZ),
    /қарзга|насия/iu,
    unlessDenied(
      `(?:пул|тўлов|ҳақ|қарз)\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}(?:${UZC_LATER})\\s+(?:${UZC_YOU_PAY})|(?:${UZC_LATER})\\s+тўла(?:йсиз|сангиз)`,
      DENY_UZC,
    ),
    onArrival(
      unlessDenied(
        `(?:пул|тўлов|ҳақ|қарз)\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}(?:${UZC_ON_ARRIVAL})\\s+(?:${UZC_YOU_PAY})|(?:${UZC_ON_ARRIVAL})\\s+тўла(?:йсиз|сангиз)`,
        DENY_UZC,
      ),
      PAID_FIRST_UZC,
    ),
    /в\s+долг|в\s+кредит|рассрочк|оплатите\s+(потом|позже)|потом\s+заплатите/iu,
    // «Груз выдадим без оплаты» (K19), either order — never «Мы не выдаём груз без оплаты», «Без оплаты груз не выдаём».
    unlessDenied(
      '(?:выда|отда|отпуст|забер|заб(?:ир|е)р)\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}без\\s+(?:\\p{L}+\\s+)?(?:пред)?оплат|без\\s+(?:\\p{L}+\\s+)?(?:пред)?оплат\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}(?:выда|отда|отпуст|забер|заб(?:ир|е)р)',
      DENY_RU,
    ),
    // «Оплатите после получения», «…после того, как получите», a bare «оплатите после», «по факту», «при
    // получении» are credit; «отправим после оплаты» is the opposite and is not matched — nor is «оплату
    // после расчёта сообщим». Paid on ARRIVAL — «по прибытии», «после прибытия», «по факту», «при получении»,
    // «на месте» — is the company's rule when the statement ends on it (P10, `onArrival`): «Оплата по
    // прибытии груза в Ташкент, перед получением». «Потом» and «после получения / выдачи» never are.
    /(?:оплат|заплат|рассчита|плат(?:а|у|ой|ите|ить|ишь|им|ят|ит|[её]ж))\p{L}*\s+(?:\p{L}+\s+){0,2}(?:потом|позже|после(?=\s*(?:[.,!?;]|$|того|как))|после\s+(?:получения|выдачи))/iu,
    onArrival(new RegExp(`(?:${RU_PAY})\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}(?:${RU_ON_ARRIVAL})`, 'iu'), PAID_FIRST_RU),
    /после\s+(?:получения|выдачи)\s*,?\s+(?:\p{L}+\s+){0,2}(?:оплат|заплат|плат)/iu,
    onArrival(new RegExp(`(?:${RU_ON_ARRIVAL_BEFORE})\\s*,?\\s+(?:\\p{L}+\\s+){0,2}(?:оплат|заплат|плат)`, 'iu'), PAID_FIRST_RU),
    /наложенн\p{L}*\s+плат[её]ж/iu,
    /on\s+credit|pay\s+later|deferred\s+payment|cash\s+on\s+delivery/iu,
    // Paid on arrival, unless the statement ends on «before you collect» (P10).
    onArrival(/payment\s+(?:on|upon)\s+(?:delivery|arrival|receipt)/iu, PAID_FIRST_EN),
    // «Pay when you can», «release it without payment» (K19) — never «We cannot release cargo without payment».
    unlessDenied(
      "pay\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}when(?:ever)?\\s+you(?:['’]re)?\\s+(?:can|able|ready)|(?:release|give|hand|collect|take)\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}without\\s+(?:any\\s+)?pay(?:ment|ing)",
      DENY_EN,
    ),
    /pay\p{L}*\s+(?:\p{L}+\s+){0,2}(?:later|after\s+you\s+(?:get|receive|collect)|when\s+(?:it|they|the\s+\p{L}+|your\s+\p{L}+|you)\s+(?:\p{L}+\s+)?(?:get|receiv|collect|pick)|when\s+you\s+(?:\p{L}+\s+)?(?:arriv|deliver|reach))/iu,
    onArrival(
      /pay\p{L}*\s+(?:\p{L}+\s+){0,2}(?:after\s+(?:delivery|arrival|it\s+arrives)|when\s+(?:it|they|the\s+\p{L}+|your\s+\p{L}+)\s+(?:\p{L}+\s+)?(?:arriv|deliver|reach)|(?:on|upon)\s+(?:delivery|arrival|receipt))/iu,
      PAID_FIRST_EN,
    ),
    /نسیه|قرضی|بعدا\s+پرداخت/u,
    /بعد(?:اً|ًا|ا)?\s+(?:\p{L}+\s+)?(?:پرداخت|بپردازید)|پرداخت\s+(?:\p{L}+\s+)?بعد(?:اً|ًا|ا)?(?!\p{L})/u,
    /赊账|赊欠|先发货后付款|后付款/u,
    /以后(?:再)?付|晚点付|过后付|到货(?:后|再)付|货到付款|到付|收到货(?:后|再)付/u,
    /(?:پس|بعد)\s+از\s+(?:تحویل|رسیدن|دریافت)\s+(?:\p{L}+\s+){0,2}(?:پرداخت|بپردازید|می‌?\s?پردازید)/u,
    // Released with no payment, in Persian and Chinese (fix round): «بار را بدون پرداخت تحویل می‌دهیم», «不用付款就可以提货».
    unlessDenied(
      'بدون\\s+(?:\\p{L}+\\s+)?پرداخت\\s+(?:\\p{L}+\\s+){0,3}(?:تحویل|ببرید|بگیرید|بدهیم|می‌?\\s?دهیم)|(?:تحویل|ببرید|بگیرید)\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}بدون\\s+(?:\\p{L}+\\s+)?پرداخت',
      DENY_FA,
    ),
    /不用(?:先)?(?:付|交)(?:款|钱|费)?(?:就|也)|不用(?:先)?(?:付|交)(?:款|钱|费)[^，。！？,.!?]{0,6}(?:提货|取货|发货|拿货|拿走|带走)/u,
  ],
  refund: [
    /pul\p{L}*\s+qaytar|qaytarib\s+beramiz|kompensatsiya|tovon/iu,
    /пул\p{L}*\s+қайтар|компенсация|товон/iu,
    /верн(ём|ем|у)\s+деньги|возврат\s+денег|компенсац|возмест/iu,
    /refund|compensat|money\s+back|reimburs/iu,
    /بازپرداخت|پس\s+می‌?دهیم|جبران\s+خسارت|غرامت/u,
    /退款|赔偿|退钱|补偿/u,
  ],
  free_extras: [
    /sug['‘’ʻ]?urta|eshikkacha|uyingizgacha|fotootchet|foto\s*hisobot|qayta\s+qadoq/iu,
    // «Bepul», «tekin» — never the calculation's (P9).
    freeUnlessCalc(FREE_UZ),
    // «…sizdan pul olinmaydi» beside a service (K19) — never «hisoblash uchun pul olinmaydi», which is true.
    /(?:saqla|qadoq|upakovk|yetkaz|sug['‘’ʻ]?urt|foto|rasm|tushir|ortish|dostavk)\p{L}*\s+(?:[\p{L}'‘’ʻ]+\s+){0,3}(?:pul|haq|to['‘’ʻ]?lov)\p{L}*\s+(?:olinmaydi|olmaymiz|olmayman|so['‘’ʻ]?ralmaydi)/iu,
    /суғурта|эшиккача/iu,
    freeUnlessCalc(FREE_UZC),
    // «Сақлаш учун сиздан пул олинмайди» — the Latin row's twin (fix round).
    /(?:сақла|қадоқ|упаковк|етказ|суғурт|фото|расм|тушир|ортиш)\p{L}*\s+(?:\p{L}+\s+){0,3}(?:пул|ҳақ|тўлов)\p{L}*\s+(?:олинмайди|олмаймиз|олмайман|сўралмайди)/iu,
    /страхов|до\s+двери|фотоотч|переупаков/iu,
    freeUnlessCalc(FREE_RU),
    // A service «без оплаты» / «без доплаты» (K19) — never «Груз со склада без оплаты не выдаётся».
    unlessDenied(
      '(?:хранени|доставк|упаковк|страховк|фото|погрузк|разгрузк|склад)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}без\\s+(?:\\p{L}+\\s+)?(?:до)?оплат|без\\s+(?:до)?оплат\\p{L}*\\s+(?:\\p{L}+\\s+)?(?:хранени|доставк|упаковк|страховк|фото|погрузк|разгрузк)|без\\s+доплат',
      DENY_RU,
    ),
    /insurance|door[\s-]to[\s-]door|door\s+delivery|photo\s+report|repack|at\s+no\s+(?:extra\s+|additional\s+)?(?:cost|charge)/iu,
    freeUnlessCalc(FREE_EN),
    /رایگان|مجانی|بیمه|درب\s+منزل/u,
    /免费|保险|送货上门|拍照报告|重新包装/u,
  ],
  dispatch_promise: [
    // Up to two words between the day and the verb — «ertaga albatta jo'natamiz», «bugun kechqurun yuboramiz» —
    // and beside «bugun» never the past: «yukingiz bugun Toshkentga yetib keldi» is the commonest status there is.
    new RegExp(dayRule(UZ_DAY_ANY, uzGoing(`${UZ_YOURS}|${UZ_NEG}`)), 'iu'),
    new RegExp(dayRule(UZ_TODAY, uzGoing(`${UZ_YOURS}|${UZ_NEG}|${UZ_PAST}`)), 'iu'),
    /va['‘’ʻ]?da\s+(beraman|beramiz)|kafolatlay/iu,
    new RegExp(dayRule(UZC_DAY_ANY, uzcGoing(`${UZC_YOURS}|${UZC_NEG}`)), 'iu'),
    new RegExp(dayRule(UZC_TODAY, uzcGoing(`${UZC_YOURS}|${UZC_NEG}|${UZC_PAST}`)), 'iu'),
    /ваъда\s+бер/iu,
    new RegExp(dayRule(RU_DAY_ANY, ruGoing(false)), 'iu'),
    new RegExp(dayRule(RU_TODAY, ruGoing(true)), 'iu'),
    // «Не обещаю» and the system's own «(не обещание)» promise nothing.
    /(?<!не\s)обеща/iu,
    new RegExp(`${EN_NOT_YOURS}${EN_GO_ANY}\\s+${GAP}tomorrow|tomorrow\\s+${GAP}${EN_GO_ANY}`, 'iu'),
    new RegExp(`(?:${EN_NOT_YOURS}${EN_GO_NOW}|${EN_FUTURE})\\s+${GAP}today|today\\s+${GAP}(?:${EN_GO_NOW}|${EN_FUTURE})`, 'iu'),
    /\bi\s+promise|\bwe\s+promise|will\s+arrive\s+(by|on)\b/iu,
    // A day beside a verb is `dayPromise`'s, in every language (K15): «فردا ارسال» and «明天发货» were the
    // only Persian and Chinese days, and «فردا بار شما می‌رسد», «下周发货» passed.
    /قول\s+می‌?دهم/u,
    /承诺|保证到/u,
  ],
  customs_included: [
    // A customs word in a case of PLACE — «bojxonadan o'tib omborga kiradi», «bojxonaga kiradi» — is where the
    // cargo goes, never what the price holds (fix round: the commonest status line read as customs included).
    new RegExp(
      `(?:boj|bojxona|rastamojka)${UZ_NOT_PLACE}\\p{L}*\\s+(?:ham\\s+)?(?:(?:narx(?:ga|ida)?\\s+)?(?:kiradi(?!\\s+emas)|bilan\\s+birga)|narx\\p{L}*\\s+ichida(?!\\s+emas))`,
      'iu',
    ),
    // The ordinary word orders (final review K12): «Boj ham shu narxga kiradi», «Boj kiritilgan», «Narxda boj bor»,
    // «Narxga boj ham kiradi», «…boj ham kirgan», «narxda boj ham hisoblangan» — never the negative «kirmaydi»,
    // «kiritilmagan», «kiritilgan emas», «narx ichida emas», nor «Boj alohida hisoblangan». A bare «kiradi»
    // needs the price in the clause or no PLACE before it: «bojxona omboriga kiritilgan» is a warehouse.
    new RegExp(
      `(?:boj|bojxona|rastamojka|qqs)${UZ_NOT_PLACE}\\p{L}*\\s+(?:(?:${UZ_GAP_WORD}\\s+){0,3}?(?:narx|yo${AP}?lkira|summa|hisob)\\p{L}*\\s+(?:${UZ_GAP_WORD}\\s+)?(?:kiradi|kiritilgan|qo${AP}?shilgan|kirgan|hisoblangan)|(?:(?![\\p{L}'‘’ʻ]*ga(?![\\p{L}]))${UZ_GAP_WORD}\\s+){0,2}(?:kiradi|kiritilgan|qo${AP}?shilgan|kirgan))(?![\\p{L}])(?!\\s+emas)`,
      'iu',
    ),
    new RegExp(
      `narx\\p{L}*\\s+(?:[\\p{L}'‘’ʻ]+\\s+){0,2}(?:boj|bojxona|rastamojka|qqs)\\p{L}*\\s+(?:ham\\s+)?(?:bor|kiradi|kiritilgan|kirgan|hisoblangan)(?![\\p{L}])(?!\\s+emas)`,
      'iu',
    ),
    /(бож|божхона|растаможка)(?![\p{L}]*(?:га|да|дан|гача)(?![\p{L}]))\p{L}*\s+(ҳам\s+)?(киради(?!\s+эмас)|нарх\p{L}*\s+ичида(?!\s+эмас))/iu,
    /(?:бож|божхона|растаможка|ққс)(?![\p{L}]*(?:га|да|дан|гача)(?![\p{L}]))\p{L}*\s+(?:(?:(?!(?:алоҳида|эмас)(?![\p{L}]))\p{L}+\s+){0,3}?(?:нарх|йўлкира|сумма|ҳисоб)\p{L}*\s+(?:(?!(?:алоҳида|эмас)(?![\p{L}]))\p{L}+\s+)?(?:киради|киритилган|қўшилган|кирган|ҳисобланган)|(?:(?![\p{L}]*га(?![\p{L}]))(?!(?:алоҳида|эмас)(?![\p{L}]))\p{L}+\s+){0,2}(?:киради|киритилган|қўшилган|кирган))(?![\p{L}])(?!\s+эмас)|нарх\p{L}*\s+(?:\p{L}+\s+){0,2}(?:бож|божхона|растаможка|ққс)\p{L}*\s+(?:ҳам\s+)?(?:бор|киради|киритилган|кирган|ҳисобланган)(?![\p{L}])(?!\s+эмас)/iu,
    /(растаможк|таможн|пошлин)\p{L}*\s+(тоже\s+)?включ|с\s+растаможкой|включая\s+(таможн|растаможк|пошлин)/iu,
    // «Растаможка тоже входит в цену», «В цену входит растаможка», «Цена включает растаможку» — never «не входит»;
    // «учтён» only IN a price («учтена в цене»): «После растаможки груз будет учтён на складе» is the stock book.
    /(?:растаможк|таможн|пошлин|ндс)\p{L}*\s+(?:(?!не(?![\p{L}]))\p{L}+\s+){0,3}(?:входит|входят|включен\p{L}*|учт[её]н\p{L}*(?=\s+в\s+(?:цен|стоимост|сумм|тариф|расч[её]т)))|(?<!не\s)(?:входит|входят|включа\p{L}*)\s+(?:\p{L}+\s+){0,2}(?:растаможк|таможн|пошлин|ндс)/iu,
    // «Примерно 330 $ с учётом растаможки», «…вместе с пошлиной» (fix round) — never «без учёта».
    /с\s+уч[её]том\s+(?:\p{L}+\s+)?(?:растаможк|таможн|пошлин|ндс)|вместе\s+с\s+(?:\p{L}+\s+)?(?:растаможк|таможн|пошлин|ндс)/iu,
    /(customs|duty|duties)\s+(is\s+|are\s+)?included|including\s+(customs|duty|duties)/iu,
    // «Customs duty is in the price», «Customs clearance is included in the price», «The price covers customs».
    /(?:customs|dut(?:y|ies)|clearance|vat)\s+(?:\p{L}+\s+){0,2}(?:is|are)\s+(?:also\s+)?(?:in(?:cluded)?\s+(?:in\s+)?the\s+(?:price|quote|rate)|part\s+of\s+the\s+(?:price|quote)|covered)|(?<!(?:not|n['’]t)\s+)(?:includes?|covers?)\s+(?:the\s+)?(?:\p{L}+\s+)?(?:customs|dut(?:y|ies)|clearance|vat)/iu,
    // «About $330 with customs», «customs duty already counted in» (fix round) — never «not counted in».
    /(?:\d|price|cost|quote|total)\s*\$?\s+with\s+(?:the\s+)?(?:customs|dut(?:y|ies)|clearance)|(?:customs|dut(?:y|ies)|vat|clearance)\s+(?:(?![\p{L}'’]*n['’]t|not(?![\p{L}])|never(?![\p{L}]))[\p{L}'’]+\s+){0,2}(?:counted|built|factored)\s+in(?![\p{L}])/iu,
    /(گمرک|عوارض)\s+(هم\s+)?شامل(?!(?:\s+\p{L}+){0,2}\s*(?:نمی|نیست))/u,
    // Persian says «not» at the END of the sentence: «این قیمت شامل عوارض گمرکی و مالیات نمی‌شود» is the exclusion itself.
    /(?:قیمت\s+(?:\p{L}+\s+){0,2}شامل\s+(?:\p{L}+\s+)?(?:گمرک|عوارض|ترخیص|مالیات)|(?:گمرک|عوارض|ترخیص)\p{L}*\s+(?:\p{L}+\s+){0,2}(?:در|داخل)\s+قیمت\s+(?:\p{L}+\s+)?(?:است|هست))(?![^.!?؟]*(?:نمی|نیست))/u,
    // «حدود ۳۳۰ دلار همراه با گمرک», «با احتساب عوارض» (fix round).
    /(?:همراه\s+با|با\s+احتساب)\s+(?:\p{L}+\s+)?(?:گمرک|عوارض|ترخیص|مالیات)(?![^.!?؟]*(?:نمی|نیست))/u,
    // …never inside its negation: «运费不包含关税» holds «含关税» (K12).
    /(?<![不没未])包税|(?<![不没未包])含税|(?<![不没未])包清关|(?<![不没未包])含关税/u,
    // «关税包含在运费内», «运费包括关税» — never «不包含», «不含».
    /(?:关税|增值税|清关|税费)[^，。！？,.!?不没未]{0,8}?(?<![不没未])(?:包含|包括|已含|在内)|(?:(?<![不没未])(?:包含|包括)|(?<![不没未包])含)了?[^，。！？,.!?不没未]{0,4}(?:关税|增值税|清关)/u,
    // «关税已算进去», «连关税一起» (fix round) — never «关税不算在内».
    /(?:关税|增值税|清关|税费)[^，。！？,.!?]{0,6}?(?<![不没未])(?:算进|算在)|连(?:同)?(?:关税|增值税|清关)[^，。！？,.!?]{0,4}一起/u,
  ],
  no_duty: [
    /bojsiz|boj\s+yo['‘’ʻ]?q|boj\s+to['‘’ʻ]?lamaysiz/iu,
    /божсиз|бож\s+йўқ/iu,
    /без\s+пошлин|пошлин\p{L}*\s+нет|без\s+растаможки/iu,
    /duty[\s-]free|no\s+(customs\s+)?dut(y|ies)|without\s+dut(y|ies)/iu,
    /بدون\s+(گمرک|عوارض)|معاف\s+از\s+گمرک/u,
    /免税|免关税|不用交税/u,
  ],
};

/**
 * An arrival or a dispatch in the FUTURE tense — «yetib keladi», «придёт»,
 * «will arrive». The past («yetib keldi», «arrived») is a fact about cargo
 * that came, and is no promise. Two tiers (fix round): SENDING verbs say cargo
 * travels by what they are; COMING verbs — a bare «keladi», «chiqadi»,
 * «придёт», receiving («olasiz», «получите», «you will have it») and being
 * there («Toshkentda bo'ladi», «будет в Ташкенте») — are the cargo's only when
 * the sentence is about cargo (`aboutCargo`): «Hisob-kitob 1 soatda chiqadi»,
 * «Ответ придёт в течение 2 часов» promise nothing about the cargo.
 */
const SENDING_VERB: readonly RegExp[] = [
  new RegExp(uzSending(`${UZ_YOURS}|${UZ_NEG}|${UZ_PAST}`), 'iu'),
  new RegExp(uzcSending(`${UZC_YOURS}|${UZC_NEG}|${UZC_PAST}`), 'iu'),
  new RegExp(ruSending(true), 'iu'),
  /\b(?:arrive|arrives|deliver|delivers|ship|ships|reach|reaches|dispatch)\b|get\s+there|will\s+be\s+(?:shipped|delivered|dispatched|sent)\b/iu,
  /می‌?\s?رسد|میرسد|می‌?\s?رسه|ارسال\s+(?:می|خواه)|تحویل\s+می|می‌?\s?فرستیم|خواهد\s+رسید/u,
  /到达|送到|运到|到货|发货|发出|寄出|运出|出发|能到|会到|送达|抵达/u,
];
const COMING_VERB: readonly RegExp[] = [
  // With a day count a bare «keladi» / «boradi» is the cargo's: «mashina 5 kunda boradi».
  new RegExp(
    `${UZ_LEAVING}|(?<![\\p{L}])(?:keladi|boradi|olasiz|tegadi)(?![\\p{L}])|olib\\s+ketasiz|qabul\\s+qilasiz|(?:da|ga)\\s+bo${AP}?ladi|tayyor\\s+bo${AP}?ladi`,
    'iu',
  ),
  new RegExp(
    `${UZC_LEAVING}|(?<![\\p{L}])(?:келади|боради|оласиз|тегади)(?![\\p{L}])|олиб\\s+кетасиз|(?:да|га)\\s+бўлади|тайёр\\s+бўлади`,
    'iu',
  ),
  new RegExp(`${RU_COMING}|получ(?:ите|ишь|ат|им)|забер[её]те|(?:будет|будут)\\s+готов`, 'iu'),
  /will\s+(?:have|get|receive|collect)\b|you(?:'ll|\s+will)\s+(?:have|get|receive)\b|will\s+be\s+(?:\p{L}+\s+)?(?:in|with|at|ready|there)\b/iu,
  /دریافت\s+(?:می|خواهید)|به\s+دستتان/u,
  // «明天货就到了» — «就到», «要到», «将到» say the cargo comes; «了» after a coming day is no past.
  /收到|拿到|到手|(?:就|要|将|可以)到/u,
];

/**
 * «Taxminan», «odatda», «примерно», «usually», «大约» — adverbs that make a day
 * count an estimate when they stand before it in the same clause.
 */
const HEDGE_ADVERB =
  /taxmin|odatda|o['‘’ʻ]?rtacha|тахмин|одатда|ўртача|примерн|ориентировочн|приблизительн|обычно|в\s+среднем|approx|estimat|usually|typically|roughly|normally|on\s+average|تقریب|معمولا|大约|大概|预计|通常|一般/iu;

/**
 * …and the words that hedge only the figure they stand right beside: «около 2
 * дней», «about 2 days», «~2», «约3天», «2 kun atrofida», «3天左右». Anywhere
 * else they are no hedge (fix round): «около Ташкента» is a place, «Don't
 * worry about it» an idiom, «我们约定3天» — «we AGREED on three days» — the
 * opposite of an estimate, and a «~» at the end of a line decoration.
 */
// The Persian «حدود» takes its adverb's ending as often as not — «حدوداً ۳۳۰ دلار» (fix round).
const HEDGE_BEFORE_FIGURE = /(?:около|about|around|~|约(?![定好])|حدود[\p{L}\p{M}]*|chamasi|qariyb)\s*(?:через\s+|in\s+)?$/iu;
const HEDGE_AFTER_FIGURE =
  /^(?:\s*[-–—~]\s*\d+(?:[.,]\d+)?)?\s*\p{L}*\s*(?:atrofida|chamasi\p{L}*|左右|примерно|приблизительно|or\s+so\b)/iu;

/** The system's own disclaimer — «Yuk 15-20 kunda yetib keladi (va'da emas).» — says the whole sentence is no promise. */
const DISCLAIMER = /va['‘’ʻ]?da\s+emas|ваъда\s+эмас|не\s+обещани|not\s+a\s+promise/iu;

/** …and the words that make it a promise again, hedged or not: «taxminan 2 kunda ALBATTA yetib boradi». */
const CERTAINTY =
  /albatta|shubhasiz|kafolat|албатта|шубҳасиз|кафолат|обязательно|непременно|гарантир|definitely|certainly|guarantee|for\s+sure|\bpromise|حتما|حتماً|قطعا|قطعاً|تضمین|一定|肯定|保证|绝对|100\s*%/iu;

/**
 * OUR sending in the first person — «yetkazamiz», «jo'natamiz», «yetkazib beramiz», «olib kelamiz»,
 * «доставим», «отправим», «we deliver» — what an asking count of days may never be said with (P5, review).
 * `SENDING_VERB` is wider: its «yetib kelishi» is the cargo's own coming, the very thing a question asks.
 */
const WE_SEND =
  /(?<![\p{L}])(?:(?:jo['‘’ʻ`]?nat|yubor|yetkaz)\p{L}*?(?:amiz|aman|ib\s+beramiz|ib\s+beraman)|olib\s+kel(?:amiz|aman)|keltir(?:amiz|aman)|(?:жўнат|юбор|етказ)\p{L}*?(?:амиз|аман|иб\s+берамиз|иб\s+бераман)|олиб\s+кел(?:амиз|аман)|(?:отправ|достав|отгруз|привез)(?:им|лю|ляем|ем|ём|у)|we(?:['’]ll|\s+will|\s+shall)?\s+(?:ship|send|deliver|dispatch|bring))(?![\p{L}])/iu;

/** «Har 3 kunda», «каждые 3 дня», «every 3 days», «每3天» — right before the figure, a timetable and not a promise. */
const FREQUENCY = /(?:(?<![\p{L}])(?:har|ҳар|каждые|каждый|каждую|every|هر)\s*|每\s*)$/iu;

/**
 * Whose time a COMING verb tells (fix round): «Hisob-kitob 1 soatda chiqadi»,
 * «Ответ придёт в течение 2 часов» are about the answer or the paperwork, and
 * no promise about cargo. A clause naming the cargo is the cargo's; one naming
 * only something else is not; a clause naming neither takes its sentence's
 * subject, and a sentence naming neither — «Через 2 дня придёт» — is the
 * cargo's, because that is what this chat is about.
 */
const CARGO_SUBJECT =
  /(?<![\p{L}])(?:yuk|mashina|fura|tovar|karobka|quti|posilka|partiya|юк|машина|фура|товар|коробк|қути|груз|машин|фур|посылк|парти|cargo|goods|shipment|parcel|truck|package|box|بار|محموله|کالا|کامیون)|货|车|包裹|箱/iu;
const NOT_CARGO =
  /(?<![\p{L}])(?:javob|hisob|narx|xabar|ma['‘’ʻ]?lumot|hujjat|invoys|жавоб|ҳисоб|нарх|хабар|ҳужжат|ответ|расч[её]т|цен[аыу]|стоимост|звонок|сообщени|информаци|документ|инвойс|answer|reply|quote|price|calculation|message|information|document|invoice|پاسخ|جواب|قیمت|محاسبه)|答复|回复|报价|价格|计算|文件|发票/iu;

function aboutCargo(clause: string, sentence: string): boolean {
  if (CARGO_SUBJECT.test(clause)) return true;
  if (NOT_CARGO.test(clause)) return false;
  return CARGO_SUBJECT.test(sentence) || !NOT_CARGO.test(sentence);
}

/** A text's sentences — a decimal point is not a full stop. */
const SENTENCE_END = /[!?؟。！？\n]+|\.(?=\s|$)/u;
function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_END).filter((s) => s.trim() !== '');
}

/**
 * The same sentences, each with whether it ASKS — ends in its own «?» (P5): «Yuk qachon kerak, necha kunda
 * yetib kelishi kerak?» asks the customer when he needs it, and was read as our promise to deliver.
 */
const SENTENCE_TAIL = new RegExp(`(?:${SENTENCE_END.source})$`, 'u');
function askedSentencesOf(text: string): { text: string; asked: boolean }[] {
  return statementsOf(text, SENTENCE_END)
    .map((st) => {
      const tail = SENTENCE_TAIL.exec(st)?.[0] ?? '';
      return { text: st.slice(0, st.length - tail.length), asked: /[?؟？]/u.test(tail) };
    })
    .filter((s) => s.text.trim() !== '');
}

/** Which sentence of the text the character at `index` stands in — counted as `sentencesOf` cuts. */
function sentenceIndexAt(text: string, index: number): number {
  return [...text.slice(0, index).matchAll(new RegExp(SENTENCE_END.source, 'gu'))].length;
}

/** «And» between two clauses of travel — never «和» / «及», which join nouns («关税和增值税»). */
const CONJ = /(?<![\p{L}])(?:va|hamda|ва|ҳамда|и|and|و)(?![\p{L}])|并且|并|然后/gu;
/**
 * A verb of any tense, roughly, in the six languages — only the gate for a
 * cut at «va» / «и» / «and»: the left side must say something of its own, or
 * «Taxminan 5 va 7 kunda yetib keladi» would lose its hedge to a cut.
 */
const VERB_LIKE =
  /(?<![\p{L}])\p{L}{2,}(?:di|gan|ildi|ilgan|adi|aydi|amiz|aman|asiz|yapti|yapmiz|moqda|ди|ган|илди|илган|ади|айди|амиз|аман|асиз|япти|моқда)(?![\p{L}])|(?<![\p{L}])\p{L}{2,}(?:ил|ла|ли|ло|лен|лена|лено|лены|ит|ет|ут|ют|ят|ем|им|ется|ются)(?![\p{L}])|(?<![\p{L}])(?:was|were|is|are|has|have|had|will|shall|should|would|can|could|may|might)(?![\p{L}])|(?<![\p{L}])\p{L}{2,}ed(?![\p{L}])|已|了|شد|رسید|کرد|است|می‌?\s?\p{L}+/iu;

/**
 * A sentence's clauses — a hedge or a timetable is judged in the clause of its
 * figure, so «Xavotir olmang, odatda tez ishlaymiz, yukingiz 2 kunda yetib
 * keladi» and «Mashina har 3 kunda chiqadi, yukingiz 5 kunda yetib keladi» are
 * promises. A clause that is ONLY a hedge — «Taxminan, 2 kunda…» — belongs to
 * the next one.
 */
function clausesOf(sentence: string): { text: string; at: number }[] {
  const cut: { text: string; at: number }[] = [];
  let last = 0;
  // A dash or a comma BETWEEN two figures is inside a range or a figure — «taxminan 05.11 – 09.11», «1,200» —
  // never between clauses (final review K14: cut there, the range's second date lost its hedge). The Chinese
  // and Persian commas are commas too (fix round): «截至今天，您的货在喀什，预计5-7天到达» was one clause.
  for (const m of sentence.matchAll(/(?<!\d\s?)[,—–]|[,—–](?!\s?\d)|[;:，、،；：]|(?<!\d)\s-\s|\s-\s(?!\d)/gu)) {
    cut.push({ text: sentence.slice(last, m.index), at: last });
    last = m.index + m[0].length;
  }
  cut.push({ text: sentence.slice(last), at: last });
  // …and so is «va» / «и» / «and» / «و» / «并» between two verbs (fix round): «Yukingiz 03.11 da jo'natilgan va
  // taxminan 05.11 – 09.11 da yetib keladi» judged the date that PASSED by the verb of the one to come.
  const parts: { text: string; at: number }[] = [];
  for (const part of cut) {
    let from = 0;
    for (const m of part.text.matchAll(CONJ)) {
      const left = part.text.slice(from, m.index);
      if (VERB_LIKE.test(left) && finiteVerbIn(part.text.slice(m.index + m[0].length))) {
        parts.push({ text: left, at: part.at + from });
        from = m.index + m[0].length;
      }
    }
    parts.push({ text: part.text.slice(from), at: part.at + from });
  }
  const out: { text: string; at: number }[] = [];
  let carryAt: number | null = null;
  for (const part of parts) {
    const words = part.text.trim().split(/\s+/u).filter(Boolean);
    if (words.length > 0 && words.length <= 2 && HEDGE_ADVERB.test(part.text)) {
      carryAt ??= part.at;
      continue;
    }
    const at = carryAt ?? part.at;
    out.push({ text: sentence.slice(at, part.at + part.text.length), at });
    carryAt = null;
  }
  if (carryAt !== null) out.push({ text: sentence.slice(carryAt), at: carryAt });
  return out;
}

const SPELLED_DURATION_G = new RegExp(SPELLED_DURATION_SRC, 'giu');
/** The first figure of a range is where its hedge or its «har» stands: «около 2-5», «har 2-3». */
const RANGE_START = /\d+(?:[.,]\d+)?\s*(?:[-–—~]|dan|до|to|تا|到|至)\s*$/iu;

/**
 * The Chinese past (fix round): «已» says it happened, «了» too unless the
 * clause says what is coming — «明天就到了», «快到了» are the future. Chinese
 * verbs carry no tense, so «发出», «到达» in these lists are past and future
 * alike, and only the word beside them tells.
 */
function zhPast(clause: string): boolean {
  return /已/u.test(clause) || (/了(?!解)/u.test(clause) && !/[就要将快会]/u.test(clause));
}

/** A day the cargo is EXPECTED on — the estimate said as one: «kutilmoqda», «ожидается», «is expected to», «预计». */
const DATE_EXPECTED =
  /(?<![\p{L}])(?:kutil(?:moqda|yapti|adi)|кутил(?:моқда|япти|ади)|ожида(?:ется|ются|ем)|expected\s+to|(?:is|are)\s+expected)(?![\p{L}])|预计|پیش[\s‌]?بینی\s+می|انتظار\s+می[\s‌]?رود/iu;

/** Every date in a text — «09.11», «5-noyabr» — as [start, end). */
function datesIn(text: string): [number, number][] {
  return extractNumbers(text)
    .filter((f) => f.kind === 'date')
    .map((f) => [f.index, f.index + f.raw.length]);
}

/** Every duration in a clause — written in digits or in words — as [start, end). */
function durationsIn(clause: string): [number, number][] {
  const out: [number, number][] = extractNumbers(clause)
    .filter((f) => f.kind === 'duration')
    .map((f) => [f.index, f.index + f.raw.length]);
  for (const m of clause.matchAll(SPELLED_DURATION_G)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * The NOUNS made of the travel verbs — «yetib borishi», «jo'natilishi»,
 * «yetkazib berish», «доставка», «отправка» — which name the trip and say
 * nothing about when this cargo comes: «…, yetib borishi 2-5 kun» is the
 * earlier clause's estimate said again. The Uzbek «-ish» noun ends there, or
 * takes a case or a possessive; «jo'natishadi», «yetib kelishadi» go on into a
 * verb ending and are verbs.
 */
const UZ_NOUN_END = '(?:i|ni|ga|da|dan|ning|i(?:ga|da|dan|ni|ning)|lari\\p{L}*)?(?![\\p{L}])';
const VERBAL_NOUN = new RegExp(
  [
    `(?<![\\p{L}])(?:jo${AP}?nat|yubor|yetkaz)(?:il)?ish${UZ_NOUN_END}`,
    `(?<![\\p{L}])(?:jo${AP}?nat|yubor|yetkaz)ib\\s+(?:ber|yubor)(?:il)?ish${UZ_NOUN_END}`,
    `(?<![\\p{L}])yetib\\s+(?:kel|bor)ish${UZ_NOUN_END}`,
    '(?<![\\p{L}])(?:жўнат|юбор|етказ)(?:ил)?иш(?:и|ни|га|да|дан|нинг|и(?:га|да|дан|ни|нинг))?(?![\\p{L}])',
    '(?<![\\p{L}])етиб\\s+(?:кел|бор)иш(?:и|ни|га|да|дан|нинг)?(?![\\p{L}])',
    '(?<![\\p{L}])(?:доставк|отправк|отгрузк)\\p{L}*',
  ].join('|'),
  'giu',
);

/** The clause says when cargo comes or goes with a verb of its OWN — a finite one, not a noun of the trip. */
function finiteVerbIn(clause: string): boolean {
  const verbs = clause.replace(VERBAL_NOUN, (m) => ' '.repeat(m.length));
  return SENDING_VERB.some((re) => re.test(verbs)) || COMING_VERB.some((re) => re.test(verbs));
}

/**
 * A clause that turns against what came before it — «…, lekin yukingiz 2
 * kunda», «…, sizniki esa 5 kunda», «…, но ваш через 2 дня» — says its own
 * figure, and no earlier estimate covers it.
 */
const CONTRAST =
  /(?<![\p{L}])(?:lekin|ammo|biroq|esa|лекин|аммо|бироқ|эса|но|однако|зато|а|but|however|whereas|while|though|although|اما|ولی|ولیکن)(?![\p{L}])|但|而|可是|不过|然而/iu;

/** A figure's hedge, inside its own clause: an adverb before it, or a word right beside it. */
function hedgedAt(clause: string, start: number, end: number): boolean {
  const before = clause.slice(0, start).replace(RANGE_START, '');
  return HEDGE_ADVERB.test(before) || HEDGE_BEFORE_FIGURE.test(before) || HEDGE_AFTER_FIGURE.test(clause.slice(end));
}

/**
 * The clause states an ESTIMATE: a price or a day count with its hedge
 * (B1). «Avia bilan taxminan 680 $ bo'ladi, yetib borishi 2-5 kun» is one
 * estimate in two clauses — the hedge spoken first covers the days said
 * after it. A hedge on something that is no figure — «odatda tez ishlaymiz»
 * — covers nothing that follows: that is how a promise is softened.
 */
function statesEstimate(clause: string): boolean {
  const figures: [number, number][] = [
    ...extractNumbers(clause)
      .filter((f) => f.kind === 'money' || f.kind === 'duration')
      .map((f): [number, number] => [f.index, f.index + f.raw.length]),
    ...durationsIn(clause),
  ];
  return figures.some(([start, end]) => hedgedAt(clause, start, end));
}

/**
 * A time that points BACK instead of stating a count (second review): «shuncha kunda», «shu muddatda», «o'sha
 * kunga», «aytgan kuningizga», «в этот срок», «к нужному дню», «by then», «in that time» — and «o'z vaqtida»,
 * «вовремя», «on time», the same deadline met. After «Necha kunda kerak?» it is whatever the customer names:
 * «Necha kunda kerak? Shuncha kunda yetkazib beramiz» carried no count for G1 to refuse and no duration for G2
 * to read, and a4e1b1c caught it only because G1 then refused every «necha kunda» — the very question the
 * incident freed («Yuk qachon kerak, necha kunda yetib kelishi kerak?»).
 */
const BACKREF_TIME = new RegExp(
  [
    `(?<![\\p{L}])(?:shuncha|o${AP}?shancha)\\s+(?:kun|hafta|oy|soat)\\p{L}*`,
    `(?<![\\p{L}])(?:shu|o${AP}?sha)\\s+(?:muddat|kun|vaqt|sana)\\p{L}*`,
    `(?<![\\p{L}])(?:aytgan|xohlagan|istagan|so${AP}?ragan|belgilagan|kerakli)\\s+(?:kun|muddat|vaqt|sana)\\p{L}*`,
    `(?<![\\p{L}])o${AP}?z\\s+vaqtida(?![\\p{L}])`,
    // «Shunga moslab yetkazib beramiz», «Доставим к нему» (third review): his date, met whatever it is.
    '(?<![\\p{L}])shunga\\s+mos(?:lab|ravishda)(?![\\p{L}])',
    '(?<![\\p{L}])шунга\\s+мос(?:лаб|равишда)(?![\\p{L}])',
    '(?<![\\p{L}])(?:к|до)\\s+(?:нему|ней|этому\\s+числу|тому\\s+числу)(?![\\p{L}])',
    '(?<![\\p{L}])accordingly(?![\\p{L}])',
    '(?<![\\p{L}])шунча\\s+(?:кун|ҳафта|ой|соат)\\p{L}*',
    '(?<![\\p{L}])(?:шу|ўша)\\s+(?:муддат|кун|вақт|сана)\\p{L}*',
    '(?<![\\p{L}])(?:айтган|хоҳлаган|истаган|сўраган|белгилаган|керакли)\\s+(?:кун|муддат|вақт|сана)\\p{L}*',
    '(?<![\\p{L}])ўз\\s+вақтида(?![\\p{L}])',
    '(?<![\\p{L}])(?:в|за|к)\\s+(?:этот|тот|этому|тому|указанн\\p{L}*|нужн\\p{L}*|ваш\\p{L}*)\\s+(?:срок\\p{L}*|день|дню|дату|числу)(?![\\p{L}])',
    '(?<![\\p{L}])в\\s+(?:эту|ту|нужную|вашу|указанную)\\s+дату(?![\\p{L}])',
    '(?<![\\p{L}])(?:в\\s+срок|вовремя)(?![\\p{L}])',
    '(?<![\\p{L}])за\\s+столько\\s+(?:же\\s+)?(?:дней|недель|часов)(?![\\p{L}])',
    '(?<![\\p{L}])(?:by\\s+then|on\\s+time|in\\s+(?:that|this)\\s+(?:time|period|timeframe)|within\\s+(?:that|this|your)\\s+(?:time|period|timeframe|deadline)|by\\s+(?:that|your|the)\\s+(?:date|deadline|day))(?![\\p{L}])',
  ].join('|'),
  'giu',
);

/**
 * OUR meeting his deadline, whatever verb says it (third review): «Ulguramiz», «Успеем к нужному сроку», «Уложимся в
 * ваш срок», «We'll make the deadline», «We'll get it to you in time» — none is a sending or a coming verb, so the
 * verb gate passed each untouched. First person only, and never denied: «Ulgurmaymiz», «Не успеем» refuse.
 */
const DEADLINE_MET =
  /(?<![\p{L}])(?:ulgur(?:amiz|aman|ib\s+beramiz|ib\s+qolamiz)|улгур(?:амиз|аман|иб\s+берамиз)|(?<!не\s)(?:успе(?:ем|ю)|уложимся|уложусь)|(?<!(?:not|n['’]t)\s)(?:make|meet|hit)\s+(?:the|your)\s+deadline|(?:get|deliver|bring|ship)\s+(?:it|them|your\s+cargo|the\s+cargo|your\s+goods)\s+(?:to\s+you\s+)?(?:in|on)\s+time)(?![\p{L}])/iu;

/**
 * A clause that only says WHY or IF (third review) — «Yukni o'z vaqtida yetkazish uchun necha kub ekanini bilishim
 * kerak», «Чтобы доставить вовремя, нам нужно знать объём», «To ship on time, we need the volume», «…shu muddatda
 * yetib kelishi uchun avia tavsiya qilaman»: its «on time» is the purpose of a question or a piece of advice, and
 * promises nothing. The clause it serves is judged on its own («Agar 10 kunda kerak bo'lsa, shuncha kunda yetkazamiz»).
 */
const PURPOSE_OR_IF =
  /\p{L}(?:i?sh(?:i|imiz|ingiz)?)\s+uchun(?![\p{L}])|(?<![\p{L}])(?:agar|агар|если|чтобы|in\s+order\s+to|so\s+that|if)(?![\p{L}])|\p{L}(?:и?ш(?:и|имиз|ингиз)?)\s+учун(?![\p{L}])|^\s*to\s+\p{L}+/iu;

/** A question about the customer's own deadline — «necha kunda?», «через сколько дней?», «how many days?», «by when?». */
const DEADLINE_QUESTION =
  /(?<![\p{L}])(?:qachon\s+kerak|qaysi\s+kun(?:ga|gacha)|қачон\s+керак|через\s+сколько|за\s+сколько\s+(?:дней|недель|времени)|сколько\s+дней|к\s+какому\s+(?:числу|сроку|дню)|когда\s+(?:вам\s+)?(?:нужно|нужен|надо)|how\s+(?:many\s+days|soon|long)|by\s+when|when\s+do\s+you\s+need)(?![\p{L}])/iu;
function asksDeadline(sentence: string): boolean {
  if (DEADLINE_QUESTION.test(sentence)) return true;
  return [...sentence.matchAll(SPELLED_DURATION_G)].some((m) => ASKING_DURATION.test(m[0]));
}

/**
 * How the cargo USUALLY comes, in the present tense the future lists leave out — «Обычно груз приходит за пару
 * дней», «Груз идёт несколько дней», «Cargo usually comes in a few days»: a habit is no promise of a day, and a
 * vague count of one is still the time he reads.
 */
const HABITUAL_COMING =
  /(?<![\p{L}])(?:(?:приход|прибыва|доставля|доход|отправля|отгружа)\p{L}*|(?:ид[её]т|ед[её]т|везут|возим)(?![\p{L}])|(?:comes|gets\s+there|reaches)(?![\p{L}]))/iu;

/**
 * A VAGUE count of days the cargo comes or goes in (second review): «Yukingiz taxminan bir necha kunda Toshkentga
 * yetib keladi», «Груз придёт примерно через несколько дней», «We usually deliver within a couple of days». The
 * incident took vague counts out of G1, since they state no figure to ask a source for, and G2 lets a HEDGED
 * time pass because G1 checks its figure — a vague count has none, so a hedged one passed both: a delivery time
 * the seeded transit fact («15–25 kunda») says is false, with ✅. a4e1b1c refused it in G1, as a numeral
 * spelled out, and so does this — only where the cargo comes or goes. «Narxni bir necha daqiqada hisoblab
 * beraman», «Расчёт займёт несколько дней», «Javob bir necha soatda keladi» stay what the incident made them.
 */
export function vagueTravelTime(text: string): boolean {
  for (const { text: s } of askedSentencesOf(normalizeDigits(text))) {
    const sending = SENDING_VERB.some((re) => re.test(s)) || WE_SEND.test(s);
    const coming = COMING_VERB.some((re) => re.test(s)) || HABITUAL_COMING.test(s);
    // The trip or the cargo, named with nothing else as the subject (third review): «Bir necha kun ichida yukingiz
    // Toshkentda», «Delivery takes a couple of days», «A few days and it's at your door», «Yo'lda bir necha kun
    // bo'ladi» — no verb of the lists, and the time the cargo comes in all the same.
    const tripOf = (t: string) => (TRIP_SUBJECT.test(t) || CARGO_SUBJECT.test(t)) && !NOT_CARGO.test(t);
    for (const { text: c } of clausesOf(s)) {
      // The supplier's own delivery to our warehouse is no time of ours: «Поставщик обычно отправляет товар на наш
      // склад за пару дней».
      if (zhPast(c) || SUPPLIER_SUBJECT.test(c)) continue;
      const trip = tripOf(c) || (!NOT_CARGO.test(c) && tripOf(s));
      if (!trip && !sending && !coming) continue;
      if (!trip && !aboutCargo(c, s) && (!sending || NOT_CARGO.test(c))) continue;
      for (const m of c.matchAll(SPELLED_DURATION_G)) {
        if (FREQUENCY.test(c.slice(0, m.index)) || SINCE_OR_AGO.test(c.slice(m.index + m[0].length))) continue;
        if (vagueDuration(m[0])) return true;
      }
    }
  }
  return false;
}

/** The trip as a subject — «yetkazish», «yo'lda», «доставка», «в пути», «delivery», «shipping», «at your door». */
const TRIP_SUBJECT =
  /(?<![\p{L}])(?:yetkaz(?:ish|ib\s+berish)\p{L}*|yo['‘’ʻ`]?lda|tranzit\p{L}*|етказ(?:иш|иб\s+бериш)\p{L}*|йўлда|транзит\p{L}*|доставк\p{L}*|перевозк\p{L}*|в\s+пути|delivery|shipping|transit|(?:at|to)\s+your\s+door|eshigingiz\p{L}*)(?![\p{L}])/iu;
/** …and the supplier as one — his trip to our warehouse, never ours. */
const SUPPLIER_SUBJECT =
  /(?<![\p{L}])(?:yetkazib\s+beruvchi\p{L}*|етказиб\s+берувчи\p{L}*|поставщик\p{L}*|продав\p{L}*|supplier\p{L}*|vendor\p{L}*)(?![\p{L}])/iu;
/** A count of days AGO or SINCE — «bir necha kun oldin», «bir necha kundan beri», «несколько дней назад». */
const SINCE_OR_AGO = /^\s*(?:oldin|avval|ilgari|beri|олдин|аввал|бери|назад|ago)(?![\p{L}])/iu;

/**
 * G2 for a day count (P2, his §17.14 answer): «2 kunda yetib keladi» is a
 * promise; «taxminan 2-5 kunda yetib boradi» — the avia window he said the AI
 * may give — is an ESTIMATE and passes, with G1 checking the days against
 * the tool's source. A sentence that says when cargo arrives or leaves, with
 * a duration — in digits or in words, «bir haftada» — and no hedge on THAT
 * duration, or a certainty word anywhere, is a dispatch promise; a timetable
 * («mashina har 3 kunda chiqadi») is a fact about the company. The hedge must
 * be in the same sentence as the figure — in its clause, before it or right
 * after it — or, for a clause with no verb of its own, in an EARLIER clause
 * that states an estimate itself (B1: «Avia bilan taxminan 680 $ bo'ladi,
 * yetib borishi 2-5 kun» is one hedged estimate): «Taxminan shunday. 2 kunda
 * yetib keladi.» still promises.
 */
export function timePromise(text: string): boolean {
  const sentences = askedSentencesOf(normalizeDigits(text));
  const deadlineAsked = sentences.some(({ text: s, asked }) => asked && asksDeadline(s));
  for (const { text: s, asked } of sentences) {
    // OUR sending in the first person is a sending verb too: «Biz shu muddatda olib kelamiz» (second review).
    const sending = SENDING_VERB.some((re) => re.test(s)) || WE_SEND.test(s);
    if (!asked && DEADLINE_MET.test(s) && !DISCLAIMER.test(s)) return true;
    if (!sending && !COMING_VERB.some((re) => re.test(s))) continue;
    const certain = CERTAINTY.test(s);
    if (!certain && DISCLAIMER.test(s)) continue;
    // A DATE is the same promise as a day count in another shape (final review K14): cargo_status hands the
    // model «taxminan 05.11 – 09.11», and «Yukingiz 09.11 da albatta yetib keladi» restated the window as a
    // dated promise — G1 found the date sourced and the day rule saw no duration. A certainty word beside a
    // date the cargo comes or goes on is a promise wherever its commas fall.
    if (certain && datesIn(s).length > 0 && (sending || aboutCargo(s, s))) return true;
    // An estimate stated in an earlier clause of THIS sentence (B1).
    let estimated = false;
    for (const { text: c } of clausesOf(s)) {
      const before = estimated;
      estimated ||= statesEstimate(c);
      // A date only where the clause ITSELF says the cargo comes or goes — «Yukingiz 03.11 da omborga keldi,
      // …» is a fact about a day that passed, and its past verb is no verb of these lists. Chinese writes the
      // past as a word of its own (fix round): «您的货物已于03.11发出» is a departure that happened. A day the
      // cargo is EXPECTED on — «…yetib kelishi kutilmoqda», «ожидается», «is expected to arrive» — is the
      // estimate cargo_status gave, said as one.
      if (!zhPast(c) && (SENDING_VERB.some((re) => re.test(c)) || (COMING_VERB.some((re) => re.test(c)) && aboutCargo(c, s)))) {
        for (const [start, end] of datesIn(c)) {
          if (!hedgedAt(c, start, end) && !DATE_EXPECTED.test(c)) return true;
        }
      }
      // A sending verb whose object is the answer or the quote is no time of the cargo's (third review): «Narxni bir
      // necha daqiqada hisoblab yuboraman», «Расчёт отправлю через пару часов», «Hisobni bir necha soatda yuboraman».
      if (!aboutCargo(c, s) && (!sending || NOT_CARGO.test(c))) continue;
      // A clause with a verb of its own — «…, yukingiz 2 kunda yetib keladi», «…, 2 kunda jo'natamiz» — is
      // judged ALONE: it says when THIS cargo comes, whatever was estimated before it. Only a clause with
      // none — «…, reys bo'lsa 2 kunda», «…, yetib borishi 2-5 kun» — is the earlier clause's figure said
      // again, and takes the estimate that clause stated; never one that turns against it («…, lekin …»,
      // «… esa …»). A hedge on no figure («odatda tez ishlaymiz») covers nothing (B1 review).
      const covered = before && !finiteVerbIn(c) && !CONTRAST.test(c);
      // «您的货物5天前已经发出» — a trip that happened is no promise, whatever its count of days.
      if (zhPast(c)) continue;
      // A time pointed BACK at (second review) — «shuncha kunda», «shu muddatda», «в этот срок», «by then» — is a
      // promise as a count is: unhedged, or certain, or after he was asked how many days he needs, whatever hedges
      // it — then it is HIS deadline, and nothing vouches that we meet it.
      for (const m of c.matchAll(BACKREF_TIME)) {
        if (asked && !certain && !WE_SEND.test(s)) continue;
        if (PURPOSE_OR_IF.test(c)) continue;
        if (certain || deadlineAsked || (!covered && !hedgedAt(c, m.index, m.index + m[0].length))) return true;
      }
      for (const [start, end] of durationsIn(c)) {
        if (FREQUENCY.test(c.slice(0, start).replace(RANGE_START, ''))) continue;
        // A question whose count ASKS — «necha kunda kerak?», «几天到？» — states no time of ours (P5). A
        // figure, or a count it states («10 kunda keladi, xo'pmi?», «bir haftada, maqulmi?»), is ours still;
        // and so is the asking count WE deliver in, or the certain one (review): «Necha kunda kerak bo'lsa,
        // shuncha kunda albatta yetkazib beramiz, kelishdikmi?» promises whatever time he names.
        if (asked && !certain && !WE_SEND.test(s) && ASKING_DURATION.test(c.slice(start, end))) continue;
        // A certainty word anywhere in the sentence makes it a promise again, estimate or not.
        if (certain) return true;
        if (!covered && !hedgedAt(c, start, end)) return true;
      }
    }
  }
  return false;
}

/**
 * A DAY the cargo comes or goes on, in the six languages (final review K15):
 * tomorrow and today, the weekdays, «keyingi / kelasi hafta», «на следующей
 * неделе», «next week / month», «oy oxirigacha», a named month. The shipped
 * day rule paired «ertaga / bugun / indinga / tomorrow / today» with the
 * SENDING verbs alone (Russian added its coming ones), so «Ertaga yukingiz
 * Toshkentga keladi», «Yukingiz ertaga tayyor bo'ladi», «You will get your
 * cargo tomorrow», «Dushanba kuni jo'natamiz», «Your cargo will arrive next
 * week», «Yukingiz yanvar oyida keladi», «明天货就到了», «فردا بار شما
 * می‌رسد» each passed G2 with no digit for G1 to ask about.
 */
const UZ_MONTHS = `(?:yanvar|fevral|mart(?!a)|aprel|iyun|iyul|avgust|sent(?:y)?abr|okt(?:y)?abr|noyabr|dekabr)\\p{L}{0,6}(?:\\s+oy\\p{L}*)?|may(?:ga|gacha|ning|dan)(?![\\p{L}])|may\\s+oy\\p{L}*`;
const UZC_MONTHS = '(?:январ|феврал|март(?!а)|апрел|июн|июл|август|сентябр|октябр|ноябр|декабр)\\p{L}{0,6}(?:\\s+ой\\p{L}*)?|май(?:га|гача|нинг|дан)(?![\\p{L}])|май\\s+ой\\p{L}*';
const DAY_WORD = new RegExp(
  [
    `(?<![\\p{L}])(?:(?:ertaga|indinga|bugun)\\p{L}{0,4}|(?:dushanba|seshanba|chorshanba|payshanba|shanba|yakshanba)\\p{L}{0,5}(?:\\s+kun\\p{L}*)?|juma(?:da|gacha|ga|\\s+kun\\p{L}*)(?![\\p{L}])|(?:keyingi|kelasi|kelgusi|shu|ushbu)\\s+(?:hafta|oy)\\p{L}*|(?:hafta|oy)\\s+(?:oxiri|boshi)\\p{L}*|${UZ_MONTHS})`,
    `(?<![\\p{L}])(?:(?:эртага|индинга|бугун)\\p{L}{0,4}|(?:душанба|сешанба|чоршанба|пайшанба|шанба|якшанба)\\p{L}{0,5}(?:\\s+кун\\p{L}*)?|жума(?:да|гача|га|\\s+кун\\p{L}*)(?![\\p{L}])|(?:кейинги|келаси|келгуси|шу)\\s+(?:ҳафта|ой)\\p{L}*|(?:ҳафта|ой)\\s+(?:охири|боши)\\p{L}*|${UZC_MONTHS})`,
    '(?<![\\p{L}])(?:(?:после)?завтра|сегодня)(?:шн\\p{L}*)?',
    '(?<![\\p{L}])(?:к\\s+выходным|в\\s+(?:эти\\s+|ближайшие\\s+)?выходные|на\\s+выходных|на\\s+днях)(?![\\p{L}])',
    '(?<![\\p{L}])(?:в|во|к|до|с)\\s+(?:(?:эт|следующ|ближайш|будущ)\\p{L}*\\s+)?(?:понедельник\\p{L}*|вторник\\p{L}*|сред[уеы]|четверг\\p{L}*|пятниц[уеы]|суббот[уеы]|воскресень[еяю])',
    '(?<![\\p{L}])на\\s+(?:эт|следующ|будущ)\\p{L}*\\s+недел\\p{L}*|(?<![\\p{L}])(?:в|на)\\s+(?:следующ|будущ|эт)\\p{L}*\\s+месяц\\p{L}*|(?<![\\p{L}])(?:до|к)\\s+конц[ау]\\s+(?:недел|месяц)\\p{L}*',
    '(?<![\\p{L}])(?:в|к|до)\\s+(?:январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[еюя](?![\\p{L}])',
    '(?<![\\p{L}])(?:tomorrow|today|tonight|(?:(?:on|this|next|by|until)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:next|this|the\\s+following)\\s+(?:week|month|weekend)|by\\s+the\\s+weekend|(?:by|until|at)\\s+the\\s+end\\s+of\\s+(?:the|this|next)\\s+(?:week|month)|(?:in|by|until|early|late|mid|next)\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))(?![\\p{L}])',
    '(?<![\\p{L}])(?:فردا|پس[\\s\\u200c]?فردا|امروز|امشب|(?:دوشنبه|سه[\\s\\u200c]?شنبه|چهارشنبه|پنج[\\s\\u200c]?شنبه|جمعه|یکشنبه|شنبه)|هفته[\\s\\u200c]?(?:ی\\s+)?(?:بعد|آینده|دیگر)|ماه[\\s\\u200c]?(?:ی\\s+)?(?:بعد|آینده|دیگر)|آخر\\s+(?:ماه|هفته)|ژانویه|فوریه|مارس|آوریل|ژوئن|ژوئیه|سپتامبر|اکتبر|نوامبر|دسامبر|فروردین|اردیبهشت|خرداد|مرداد|شهریور|آبان|بهمن|اسفند)',
    '明天|明日|后天|今天|今日|今晚|(?:下|本|这)?(?:个)?周末|下(?:个)?(?:周|星期|礼拜)[一二三四五六日天]?|(?:本|这)(?:个)?(?:周|星期|礼拜)[一二三四五六日天]?|(?:周|星期|礼拜)[一二三四五六日天]|下(?:个)?月|月底|月末|(?:这个|本)月|(?:十[一二]|[一二三四五六七八九十])月(?!份?\\d)',
  ].join('|'),
  'giu',
);
/**
 * «har dushanba», «каждую пятницу», «every Monday», «每周一» — a timetable, as for a day count. «Juma» is
 * Friday only as a day — «juma kuni», «jumada» — because it is also a customer's name: «Juma aka, …».
 */
const DAY_FREQUENCY =
  /(?:(?<![\p{L}])(?:har|ҳар|каждые|каждый|каждую|каждое|every|هر)\s+(?:bir\s+|бир\s+)?(?:(?:hafta(?:ning)?|ҳафта(?:нинг)?|недел[юи]|week|هفته)\s+)?|每\s*)$/iu;
/** «Shanba kunlari», «shanbalari» — on Saturdays: a timetable written as a plural day (fix round). */
const PLURAL_DAY = /(?:lari|лари)\p{L}*$/iu;
/**
 * «Bugungi holat bo'yicha», «на сегодня», «as of today», «截至今天» — the day
 * a STATUS is told on, never the day cargo comes (fix round): «Bugungi holat
 * bo'yicha yukingiz Qashg'arda, Toshkentga taxminan 5-7 kunda yetib keladi»
 * is the answer to «yukim qachon keladi?», and the frame's «today» was carried
 * to the hedged arrival as a promise.
 */
const AS_OF_FRAME =
  /(?<![\p{L}])(?:bugungi\s+(?:holat|kun)\p{L}*|бугунги\s+(?:ҳолат|кун)\p{L}*|на\s+сегодня(?:шний\s+день)?|по\s+состоянию\s+на\s+сегодня|as\s+of\s+today|تا\s+امروز)(?![\p{L}])|截至今[天日]|到今天为止/giu;
/**
 * The words a clause that is ONLY the day may hold beside it — «inshaalloh»,
 * «albatta», «ertalab», the hour: «Ertaga, inshaalloh, …», «Jo'natamiz,
 * ertaga ertalab». «Bugun tekshirdim» says something else, and its «today» is
 * no day the cargo comes on.
 */
const DAY_FILLER =
  /(?<![\p{L}])(?:insh?aal+oh|insh?al+oh|иншаал+оҳ|иншалла[хҳ]|albatta|албатта|ertalab|kechqurun|kunduzi|tushdan|keyin|oldin|soat|da|ham|эрталаб|кечқурун|соат|утром|вечером|днём|днем|уже|morning|evening|afternoon|in|the|by|at|on|انشاالله|صبح|عصر|شب)(?![\p{L}])|早上|上午|下午|晚上|点|\d+(?:[.:]\d+)?/giu;
/** «today» is also the day cargo LEFT: «今天已经发货了», «今天到货了» are facts, not promises. */
const TODAY_WORD = /bugun|бугун|сегодня|today|tonight|امروز|امشب|今天|今日|今晚/iu;
const ZH_DONE = /已|了(?!解)/u;
const NEGATED = /(?<![\p{L}])(?:не|not|never)(?![\p{L}])|won['’]t|can['’]t|cannot|don['’]t|didn['’]t|isn['’]t|نمی|نخواه|不|没|未/iu;
/** A Chinese day with a bare «到» right after it — «货下个礼拜到», «周末到» (fix round): the coming verb, said short. */
const ZH_DAY_ARRIVES =
  /(?:明天|后天|今天|今晚|(?:下|本|这)?(?:个)?周末|(?:下|本|这)?(?:个)?(?:周|星期|礼拜)[一二三四五六日天]?|下(?:个)?月|月底|月末)(?:货|就|会|能)?到(?![底达])/u;

/** The clause is the day and nothing of its own besides — what may be carried to a verb before or after it. */
function dayAlone(clause: string, days: readonly RegExpMatchArray[]): boolean {
  let rest = clause;
  for (const m of days) rest = rest.replace(m[0], ' ');
  return rest.replace(DAY_FILLER, ' ').replace(/[\s\p{P}\p{S}]+/gu, '') === '';
}

/**
 * G2 for a DAY (K15): a clause naming a day the cargo comes or goes on, with a
 * SENDING verb, or a COMING one about the cargo (`aboutCargo` — «Ertaga hisob
 * tayyor bo'ladi» is the calculation's time), is a dispatch promise; a
 * timetable («har dushanba chiqadi», «shanba kunlari jo'naydi») and a refusal
 * («завтра не отправим») are not. A clause that is only the day is carried to
 * the verb beside it, in either order — «Ertaga, inshaalloh, yukingiz yetib
 * keladi», «Jo'natamiz, ertaga» (fix round: the day said after its verb was
 * lost). A clause whose own figure is HEDGED says an estimate, and its day is
 * the frame the estimate is told in — «Bugun tekshirdim, yukingiz taxminan 10
 * kunda keladi» — as is a status's «bugungi holat bo'yicha».
 */
export function dayPromise(text: string): boolean {
  for (const s of sentencesOf(normalizeDigits(text))) {
    const frames = [...s.matchAll(AS_OF_FRAME)].map((m) => [m.index, m.index + m[0].length] as const);
    let pendingDay = false;
    let pendingVerb = false;
    for (const { text: c, at } of clausesOf(s)) {
      const days = [...c.matchAll(DAY_WORD)].filter(
        (m) =>
          !DAY_FREQUENCY.test(c.slice(0, m.index)) &&
          !PLURAL_DAY.test(m[0]) &&
          !frames.some(([a, b]) => at + m.index >= a && at + m.index < b),
      );
      const sending = SENDING_VERB.some((re) => re.test(c));
      const coming = (COMING_VERB.some((re) => re.test(c)) || ZH_DAY_ARRIVES.test(c)) && aboutCargo(c, s);
      if (!sending && !coming) {
        const alone = dayAlone(c, days);
        if (days.length > 0 && alone && pendingVerb) return true;
        // A day alone waits for its verb; a filler («inshaalloh») keeps what waits; anything else ends it.
        pendingDay = days.length > 0 ? alone : pendingDay && alone;
        pendingVerb = pendingVerb && days.length === 0 && alone;
        continue;
      }
      const day = days.length > 0 || pendingDay;
      pendingDay = false;
      pendingVerb = false;
      if (NEGATED.test(c) || statesEstimate(c)) continue;
      if (!day) {
        pendingVerb = true;
        continue;
      }
      // «Today» with a finished verb is the cargo that left — in Chinese the tense is a word of its own.
      if (days.length > 0 && days.every((m) => TODAY_WORD.test(m[0])) && ZH_DONE.test(c)) continue;
      return true;
    }
  }
  return false;
}

/** «I am not a bot» in every language — never written by a machine about itself (spec G6). */
const AI_DENIAL = [
  /bot\s+emas(man)?|men\s+(odam|inson)(man)?\b|robot\s+emas/iu,
  /бот\s+эмас|мен\s+(одам|инсон)/iu,
  /я\s+не\s+(бот|робот)|я\s+(живой\s+)?человек/iu,
  /\bi['’]?m\s+not\s+a\s+(bot|robot)|\bi\s+am\s+not\s+a\s+(bot|robot)|\bi\s+am\s+(a\s+)?(real\s+)?human/iu,
  /ربات\s+نیستم|من\s+انسان/u,
  /我不是机器人|我是真人/u,
];

/**
 * Spec G11: the approximation word, per language — in the PRICE's own clause
 * (final review K12). Read across the whole text it was satisfied by a hedge
 * on the days: «3 kub uchun narx 330 $. Yetib kelishi taxminan 15-25 kun»
 * stated the price flat and passed. «About», «around», «около», «حدود», «约»
 * hedge only right beside the figure (`HEDGE_BEFORE_FIGURE`): «the info about
 * your cargo: $330» is no estimate, and «约定» — «agreed» — is the opposite.
 */
const APPROX: Record<AgentLocale, RegExp> = {
  uz: /taxmin/iu,
  uz_cyrl: /тахмин/iu,
  ru: /примерн|ориентировочн|приблизительн/iu,
  en: /approx|estimat|roughly/iu,
  fa: /تقریب/u,
  zh: /大约|(?<!预)约(?![定好束])|大概|预计|估计/u,
};
/** …and the hedge said right AFTER the figure and its currency: «330 $ atrofida», «330美元左右», «$330 or so», «$330 approx.». */
const APPROX_AFTER =
  /^\s*\p{L}*\s*(?:atrofida|chamasi\p{L}*|атрофида|左右|примерно|приблизительно|or\s+so\b|approx(?:imately)?(?![\p{L}])|roughly|تقریب[\p{L}\p{M}]*|حدود[\p{L}\p{M}]*)/iu;
const CURRENCY_BEFORE_END = new RegExp(`(?:${CURRENCY_BEFORE_SRC})\\s*:?\\s*$`, 'iu');
const CURRENCY_AFTER_START = new RegExp(`^\\s*-?(?:${CURRENCY_AFTER_SRC})`, 'iu');
const RANGE_AFTER = /^\s*(?:[-–—~]|dan|до|to|تا|到|至)\s*\d+(?:[ ,.]\d{3})*(?:[.,]\d+)?/iu;

/** A price's clause: cut at commas and sentence ends, never between digits («1,200 $») — every script's comma. */
const PRICE_CLAUSE_BREAK = /(?<!\d)[,，、]|[,，、](?!\d)|[;；!?؟。！？\n،]+|\.(?=\s|$)/gu;

/**
 * The figure at `[start, end)` is hedged in its OWN clause (K12): the
 * approximation word before it in the clause, or a hedge right beside it. A
 * clause that is only the hedge — «Taxminan, 330 $» — is the next one's, and
 * so is a header line ending in «:» that says the hedge — «Taxminiy narx (Ivu
 * → Toshkent):» over a «330 $» on its own line (fix round).
 *
 * The approximation word is the NEAREST figure's (fix round): «Yetib kelishi
 * taxminan 15-25 kun va 3 kub uchun narx 330 $» hedges the days and states
 * the price flat — a price, a day count or a date standing between the word
 * and this figure has taken it. Measures do not («Taxminan 3 kub va 300 kg
 * uchun 330 $» is one approximate price).
 */
function priceHedged(text: string, start: number, end: number, language: AgentLocale): boolean {
  const cuts = [...text.matchAll(PRICE_CLAUSE_BREAK)].map((m) => [m.index, m.index + m[0].length] as const);
  let from = 0;
  let prevFrom = 0;
  let to = text.length;
  for (const [a, b] of cuts) {
    if (b <= start) {
      prevFrom = from;
      from = b;
    } else if (a >= end) {
      to = a;
      break;
    }
  }
  const prev = text.slice(prevFrom, from).replace(PRICE_CLAUSE_BREAK, ' ').trim();
  const words = prev.split(/\s+/u).filter(Boolean);
  const hedgeWord = APPROX[language].test(prev) || HEDGE_ADVERB.test(prev);
  if (from > 0 && words.length > 0 && hedgeWord && (words.length <= 2 || /:\s*$/u.test(prev))) from = prevFrom;
  const before = text.slice(from, start).replace(RANGE_START, '').replace(CURRENCY_BEFORE_END, '');
  let after = text.slice(end, to).replace(RANGE_AFTER, '');
  after = after.replace(CURRENCY_AFTER_START, '');
  return nearestHedge(before, APPROX[language]) || HEDGE_BEFORE_FIGURE.test(before) || APPROX_AFTER.test(after);
}

/** The approximation word in `before`, with no price, day count or date of its own between it and the end. */
function nearestHedge(before: string, approx: RegExp): boolean {
  const all = [...before.matchAll(new RegExp(approx.source, 'giu'))];
  const last = all.at(-1);
  if (!last) return false;
  const between = before.slice(last.index + last[0].length);
  return !extractNumbers(between).some((f) => f.kind === 'money' || f.kind === 'duration' || f.kind === 'date');
}

/**
 * Spec G11: «boj va QQS alohida», per language — with POLARITY (K12). A bag
 * of words passed «Boj ham shu narxga kiradi, QQS alohida» (duty IS in the
 * price) and «Примерно 330 $, растаможка тоже входит в цену, НДС отдельно».
 *
 * The polarity is a REQUIREMENT, not a blacklist (fix round): the fix's list
 * of «in the price» verbs was beaten by every synonym nobody listed — «bu
 * narxga boj ham kirgan», «с учётом растаможки», «with customs», «همراه با
 * گمرک», «关税已算进去». Now EVERY clause that names the duty, the VAT or the
 * clearance must itself say apart or not-in, in a clause that does not deny
 * it — so whatever it says instead, it fails. A clause that only LISTS them
 * («Boj, QQS va yig'im alohida») belongs to the next one. The «in the price»
 * words stay as a second, cheaper no.
 */
interface ExclusionTerms {
  duty: RegExp;
  vat: RegExp;
  /** Any word of the customs — duty, VAT, clearance — whose clause must say it is apart. */
  customs: RegExp;
  apart: RegExp;
  notIn: RegExp;
  inPrice: RegExp;
  denied: RegExp;
  /** GLOBAL: what a clause that only lists the customs holds — their names, «va», «и», «and», «和». */
  list: RegExp;
}

const EXCLUSION: Record<AgentLocale, ExclusionTerms> = {
  uz: {
    duty: /(?<![\p{L}])boj/iu,
    vat: /qqs/iu,
    customs: /(?<![\p{L}])boj|qqs|rastamojka|bojxona/iu,
    apart: /alohida/iu,
    notIn: /(?<![\p{L}])kirmaydi(?![\p{L}])|narx\p{L}*\s+ichida\s+emas|qo['‘’ʻ]?shilmaydi|kiritilmagan/iu,
    inPrice: /(?<![\p{L}])(?:kiradi|kiritilgan|qo['‘’ʻ]?shilgan|ichida|birga)(?![\p{L}])|narx(?:da|ida)\s+(?:[\p{L}'‘’ʻ]+\s+){0,2}bor(?![\p{L}])/iu,
    denied: /(?<![\p{L}])(?:emas|yo['‘’ʻ]?q)(?![\p{L}])|\p{L}ma(?:ydi|ymiz|ysiz|gan)(?![\p{L}])/iu,
    list: /(?<![\p{L}])(?:boj\p{L}*|qqs\p{L}*|rastamojka\p{L}*|va|ham|hamda|yoki|to['‘’ʻ]?lov\p{L}*|yig['‘’ʻ]?im\p{L}*|rasmiylashtir\p{L}*)(?![\p{L}])/giu,
  },
  uz_cyrl: {
    duty: /(?<![\p{L}])бож/iu,
    vat: /ққс/iu,
    customs: /(?<![\p{L}])бож|ққс|растаможка|божхона/iu,
    apart: /алоҳида/iu,
    notIn: /(?<![\p{L}])кирмайди(?![\p{L}])|нарх\p{L}*\s+ичида\s+эмас|қўшилмайди|киритилмаган/iu,
    inPrice: /(?<![\p{L}])(?:киради|киритилган|қўшилган|ичида|бирга)(?![\p{L}])|нарх(?:да|ида)\s+(?:\p{L}+\s+){0,2}бор(?![\p{L}])/iu,
    denied: /(?<![\p{L}])(?:эмас|йўқ)(?![\p{L}])|\p{L}ма(?:йди|ймиз|йсиз|ган)(?![\p{L}])/iu,
    list: /(?<![\p{L}])(?:бож\p{L}*|ққс\p{L}*|растаможка\p{L}*|ва|ҳам|ҳамда|ёки|тўлов\p{L}*|йиғим\p{L}*|расмийлаштир\p{L}*)(?![\p{L}])/giu,
  },
  ru: {
    duty: /пошлин|растаможк|таможн/iu,
    vat: /ндс/iu,
    customs: /пошлин|растаможк|таможн|ндс/iu,
    apart: /отдельно/iu,
    notIn: /не\s+(?:входит|входят|включ)|исключ|сверх/iu,
    inPrice: /входит|входят|включ|в\s+том\s+числе|учт[её]н/iu,
    denied: /(?<![\p{L}])(?:не|нет|без)(?![\p{L}])/iu,
    list: /(?<![\p{L}])(?:пошлин\p{L}*|растаможк\p{L}*|таможн\p{L}*|ндс|и|а|также|сбор\p{L}*|оформлени\p{L}*|плат[её]ж\p{L}*)(?![\p{L}])/giu,
  },
  en: {
    duty: /dut(?:y|ies)|customs/iu,
    vat: /(?<![\p{L}])vat(?![\p{L}])/iu,
    customs: /dut(?:y|ies)|customs|(?<![\p{L}])vat(?![\p{L}])|clearance/iu,
    apart: /separate/iu,
    notIn: /(?:not|n['’]t)\s+(?:\p{L}+\s+)?included|excluded|excludes|not\s+part\s+of|on\s+top/iu,
    inPrice: /includ|in\s+the\s+(?:price|quote|rate)|part\s+of\s+the\s+(?:price|quote)|(?<![\p{L}])cover(?:s|ed)?(?![\p{L}])/iu,
    denied: /(?<![\p{L}])(?:not|no|never)(?![\p{L}])|n['’]t(?![\p{L}])/iu,
    list: /(?<![\p{L}])(?:customs|dut(?:y|ies)|vat|clearance|and|or|the|import|fees?|charges?|tax(?:es)?)(?![\p{L}])/giu,
  },
  fa: {
    duty: /عوارض|گمرک/u,
    vat: /مالیات/u,
    customs: /عوارض|گمرک|مالیات|ترخیص/u,
    apart: /جداگانه/u,
    notIn: /شامل\s+(?:\p{L}+\s+)?(?:نمی|نیست)/u,
    inPrice: /شامل|داخل\s+قیمت|در\s+قیمت/u,
    denied: /نمی|نیست|ندارد/u,
    list: /(?<![\p{L}])(?:عوارض|گمرک\p{L}*|مالیات|بر|ارزش|افزوده|ترخیص|و|هزینه\p{L}*)(?![\p{L}])/gu,
  },
  zh: {
    duty: /关税/u,
    vat: /增值税/u,
    customs: /关税|增值税|清关|税费/u,
    apart: /另|单独|额外/u,
    notIn: /不包括|不包含|不含|不在/u,
    inPrice: /包括|包含|含|在内|包税/u,
    denied: /不|没|未/u,
    list: /关税|增值税|清关|税费|和|及|与|以及/gu,
  },
};

/** Every clause naming the customs says it is apart, the duty and the VAT are each named so, and none says «in». */
function saysExclusion(text: string, language: AgentLocale): boolean {
  const terms = EXCLUSION[language];
  const excludes = (c: string) => (terms.apart.test(c) && !terms.denied.test(c)) || terms.notIn.test(c);
  let duty = false;
  let vat = false;
  for (const s of sentencesOf(text)) {
    let listed = '';
    for (const part of s.split(CLAUSE_BREAK)) {
      const c = `${listed} ${part}`;
      listed = '';
      if (!terms.customs.test(c)) continue;
      if (terms.inPrice.test(c) && !terms.denied.test(c)) return false;
      if (!excludes(c)) {
        // Only the names, as yet — «Boj,» in «Boj, QQS va yig'im alohida»: the next clause says what they are.
        if (c.replace(terms.list, ' ').replace(/[\s\p{P}\p{S}\p{N}]+/gu, '') === '') {
          listed = c;
          continue;
        }
        return false;
      }
      duty ||= terms.duty.test(c);
      vat ||= terms.vat.test(c);
    }
    // A list nothing after it said anything about.
    if (listed !== '') return false;
  }
  return duty && vat;
}

/** The exclusion sentence as the reply should carry it — the model is told it, and the policy checks it. */
export const EXCLUSION_SENTENCE: Record<AgentLocale, string> = {
  uz: 'Boj va QQS alohida hisoblanadi.',
  uz_cyrl: 'Бож ва ҚҚС алоҳида ҳисобланади.',
  ru: 'Пошлина и НДС считаются отдельно.',
  en: 'Customs duty and VAT are calculated separately.',
  fa: 'عوارض گمرکی و مالیات بر ارزش افزوده جداگانه محاسبه می‌شود.',
  zh: '关税和增值税另行计算。',
};

/**
 * His third set «3» (2026-10-24): «agar skladimizga jo'natib bersangiz
 * skladlarimizdan narxi shuncha deb aytsin. Va zavotidan olib skladga olib
 * kelish alohida hisoblanadi». A truck price for cargo that starts nowhere we
 * stand — «Xitoydan», «Shenzhendan» — is OUR warehouse's price, and the reply
 * says both halves of that in the customer's language: the condition, and
 * that the factory leg is extra. The model is told the sentences; G11 checks
 * each one is said, like the hedge.
 */
export const WAREHOUSE_SENTENCES: Record<AgentLocale, { condition: string; factory: string }> = {
  uz: {
    condition: 'Bu narx yukni Xitoydagi omborimizga yuborsangiz, omborimizdan hisoblanadi.',
    factory: 'Zavoddan omborimizgacha olib kelish alohida hisoblanadi.',
  },
  uz_cyrl: {
    condition: 'Бу нарх юкни Хитойдаги омборимизга юборсангиз, омборимиздан ҳисобланади.',
    factory: 'Заводдан омборимизгача олиб келиш алоҳида ҳисобланади.',
  },
  ru: {
    condition: 'Это цена от нашего склада в Китае, если вы отправите груз на наш склад.',
    factory: 'Доставка от завода до нашего склада считается отдельно.',
  },
  en: {
    condition: 'This price is from our warehouse in China, if you send the cargo there.',
    factory: 'Bringing the cargo from the factory to our warehouse is priced separately.',
  },
  fa: {
    condition: 'این قیمت از انبار ما در چین است، اگر بار را به انبار ما بفرستید.',
    factory: 'آوردن بار از کارخانه تا انبار ما جداگانه محاسبه می‌شود.',
  },
  zh: {
    condition: '如果您把货发到我们在中国的仓库，这是从我们仓库起的价格。',
    factory: '从工厂到我们仓库的运费另行计算。',
  },
};

/**
 * Both sentences in EVERY language the agent writes, as the model is told
 * them (the yolkira tool's text, prompt rule 8). Three languages was the
 * shipped list, so a Persian, Chinese or Uzbek Cyrillic reply had to invent
 * its own words and met a check that asks for exact ones (fix round).
 */
export function warehouseSentencesText(): string {
  return AGENT_LOCALES.map((l) => `${l} «${WAREHOUSE_SENTENCES[l].condition}» «${WAREHOUSE_SENTENCES[l].factory}»`).join('; ');
}

/** The exclusion sentence in every language, the same way. */
export function exclusionSentencesText(): string {
  return AGENT_LOCALES.map((l) => `${l} «${EXCLUSION_SENTENCE[l]}»`).join('; ');
}

/**
 * What each of the two sentences must hold, per language.
 *
 * The CONDITION: every word of its list inside ONE sentence that does not
 * deny it.
 *
 * The FACTORY LEG: a sentence that names it, says in a clause that does not
 * deny it that it is apart from the price — «alohida», «отдельно», «单独» —
 * or that it is NOT in the price — «narxga kirmaydi», «не входит», «not
 * included» — and says in no clause that it IS in the price. «alohida» from
 * «Boj va QQS alohida» must not stand in for it: «Zavoddan olib kelish ham
 * shu narxga kiradi, boj alohida» says the opposite in its first clause, and
 * so does «…alohida hisoblanmaydi». The fix round measured the words-only
 * check passing the first and refusing the natural «…narxga kirmaydi,
 * alohida hisoblanadi» and the Chinese «…需单独计算».
 */
interface WarehouseTerms {
  condition: readonly RegExp[];
  factory: RegExp;
  apart: RegExp;
  notIn: RegExp;
  inPrice: RegExp;
  denied: RegExp;
}

const WAREHOUSE_TERMS: Record<AgentLocale, WarehouseTerms> = {
  uz: {
    condition: [/narx|hisob/iu, /ombor|sklad/iu, /xitoy|hitoy/iu],
    factory: /zavod|fabrik|ishlab\s+chiqar/iu,
    apart: /alohida/iu,
    notIn: /(?<![\p{L}])kirmaydi(?![\p{L}])|narx\p{L}*\s+ichida\s+emas|qo['‘’ʻ]?shilmaydi/iu,
    inPrice: /(?<![\p{L}])(?:kiradi|kiritilgan|qo['‘’ʻ]?shilgan)(?![\p{L}])|narx\p{L}*\s+ichida/iu,
    denied: /(?<![\p{L}])(?:emas|yo['‘’ʻ]?q)(?![\p{L}])|\p{L}ma(?:ydi|ymiz|ysiz)(?![\p{L}])/iu,
  },
  uz_cyrl: {
    condition: [/нарх|ҳисоб/iu, /омбор|склад/iu, /хитой/iu],
    factory: /завод|фабрик/iu,
    apart: /алоҳида/iu,
    notIn: /(?<![\p{L}])кирмайди(?![\p{L}])|нарх\p{L}*\s+ичида\s+эмас|қўшилмайди/iu,
    inPrice: /(?<![\p{L}])(?:киради|киритилган|қўшилган)(?![\p{L}])|нарх\p{L}*\s+ичида/iu,
    denied: /(?<![\p{L}])(?:эмас|йўқ)(?![\p{L}])|\p{L}ма(?:йди|ймиз|йсиз)(?![\p{L}])/iu,
  },
  ru: {
    condition: [/цен|стоимост|расч[её]т/iu, /склад/iu, /кита[йяеюи]/iu],
    factory: /завод|фабрик|производ|поставщик/iu,
    apart: /отдельно/iu,
    notIn: /не\s+(?:входит|включ)|исключ/iu,
    inPrice: /входит|включ/iu,
    denied: /(?<![\p{L}])(?:не|нет|без)(?![\p{L}])/iu,
  },
  en: {
    condition: [/price|rate|quote|cost/iu, /warehouse/iu, /china/iu],
    factory: /factory|manufacturer|supplier/iu,
    apart: /separate/iu,
    notIn: /(?:not|n['’]t)\s+(?:\p{L}+\s+)?included|excluded|excludes|not\s+part\s+of/iu,
    inPrice: /includ/iu,
    denied: /(?<![\p{L}])(?:not|no|never)(?![\p{L}])|n['’]t(?![\p{L}])/iu,
  },
  fa: {
    condition: [/قیمت|نرخ/u, /انبار/u, /چین/u],
    factory: /کارخانه|تولیدکننده/u,
    apart: /جداگانه/u,
    notIn: /شامل\s+(?:\p{L}+\s+)?(?:نمی|نیست)/u,
    inPrice: /شامل/u,
    denied: /نمی|نیست|ندارد/u,
  },
  zh: {
    condition: [/价格|价|运费|报价/u, /仓库|仓/u, /中国/u],
    factory: /工厂|厂家|供应商/u,
    apart: /另|单独|额外/u,
    notIn: /不包括|不包含|不含/u,
    inPrice: /包括|包含|含/u,
    denied: /不|没|未/u,
  },
};

/** A sentence's clauses, as the factory check reads its polarity — every script's comma. */
const CLAUSE_BREAK = /[,，、;；:：—–،]|\s-\s/u;

/** Both of the warehouse sentences are in the reply, each in a sentence of its own words. */
function saysWarehouseCondition(text: string, language: AgentLocale): boolean {
  const terms = WAREHOUSE_TERMS[language];
  const sentences = sentencesOf(text);
  const condition = sentences.some((s) => !terms.denied.test(s) && terms.condition.every((re) => re.test(s)));
  const factory = sentences.some((s) => {
    if (!terms.factory.test(s)) return false;
    const clauses = s.split(CLAUSE_BREAK);
    if (clauses.some((c) => terms.inPrice.test(c) && !terms.denied.test(c))) return false;
    return clauses.some((c) => (terms.apart.test(c) && !terms.denied.test(c)) || terms.notIn.test(c));
  });
  return condition && factory;
}

/** The system's own minted shapes (crate, box, receipt, pickup, deal) — never in a customer reply. */
const SYSTEM_SHAPE_RES: readonly RegExp[] = [
  /\bCR-[A-Za-z0-9]*\d{2}-\d{5,}/u,
  /\b[A-Za-z][A-Za-z0-9]*\d{2}-\d{6,}/u,
  /\b[A-Za-z0-9]+\s?-\s?IN\s?-\s?\d{6}\s?-\s?\d+/u,
  /\bZR-\d{5,}/u,
  /\b[BБ](?:\s?[-‐‑‒–—_]\s?\d{6,}|\d{6,})/u,
];

const QUESTION_MARKS = /[?؟？]/gu;
const MENTION = /(?<![\p{L}\p{N}])@[A-Za-z][A-Za-z0-9_]{3,}/u;

export interface PolicyInput {
  body: string;
  /** The reply's language (compose_reply.language). */
  language: AgentLocale;
  /** The dominant script of the customer's last inbound messages; null = too little text to say. */
  customerScript: ScriptName | null;
  /** Every figure source of THIS run (tools, the offer, the customer's own figures, kb facts). */
  numberSources: readonly NumberSource[];
  /** Taken out whole before any figure is read: the persona's phone, an approved link. */
  removeWhole: readonly string[];
  /** This chat's own client codes (the chat's client and its phone siblings). */
  ownCodes: readonly string[];
  /** Of the draft's code candidates, those the client book holds — the IO layer asks. */
  bookCodes: ReadonlySet<string>;
  /** The client-code prefix setting (GS) — a prefix + digits is a code even when the book was not asked. */
  codePrefix: string;
  /** Phones that may appear: kb facts' phones, the customer's own manager's. Compared as digits. */
  allowedPhones: readonly string[];
  /** Links that may appear (approved kb facts). */
  allowedUrls: readonly string[];
  /** The map link — allowed only when the customer asked where (his Q12 ⭐). */
  mapUrls: readonly string[];
  askedLocation: boolean;
  /** Active staff names that may NOT appear (the customer's own manager is left out by the caller). */
  staffNames: readonly string[];
  /** The customer's own name — a colleague's namesake is not a colleague (G6, P3). Absent = nobody's name is exempt. */
  customerNames?: readonly string[];
  /** A random token inside the system prompt; seeing it in a reply is a prompt leak. */
  canary: string;
  /** Distinct OTHER peers that got this reply's fingerprint in the last 24 h. */
  fingerprintPeers: number;
  /** AI messages with a link: to this chat in 7 days, and on the account today. */
  urlsToChat7d: number;
  urlsToday: number;
  /** A yo'lkira figure from the tool is in the reply's sources (G11 applies). */
  hasEstimate: boolean;
  /** That figure is our China warehouses' price for cargo that starts elsewhere (his third set «3»): both sentences must be said. */
  fromOurWarehouse: boolean;
  /**
   * The capitalised words of the approved facts this run read (B9) — a
   * colleague a fact names («Yukni olish bo'yicha aloqa: Umriddin») is the
   * fact's, said with the owner's approval, like the fact's phone. Absent =
   * no name is the facts'.
   */
  factNameWords?: readonly string[];
  /**
   * The one road the customer asked about (`oneModeIn` over the chat) — the
   * road a reply's day count is the time of when the reply names none.
   * Absent = none known.
   */
  askedMode?: TravelMode | null;
  /**
   * The draft carries its Uzbek translation (`gloss_uz`). His 13 + ⭐3: a
   * Persian or Chinese reply comes with one, because he cannot read the reply
   * he is approving (final review K29). Absent = not asked (a caller with no
   * draft); `policyFor` always says.
   */
  hasGloss?: boolean;
  /**
   * The reply's figure is a flight's and no truck's (his fourth set «2»):
   * the flight's address is his, so a China address in it is refused. Absent
   * = not an avia quote.
   */
  aviaOnly?: boolean;
  /**
   * The flight was spoken of and the chat's road was not decided to be it
   * (#1539): a China address in the reply WARNS — the ✅ stays, the card asks
   * him to look. Absent = not spoken of.
   */
  aviaMentioned?: boolean;
  /**
   * The Chinese characters of the facts this run read (`hanOnly`): a run of
   * them the reply quotes — a warehouse address — is not the reply's script.
   * Absent = nothing is quoted, every character counts.
   */
  quotableHan?: string;
  /**
   * The receiving warehouses as the knowledge states them NOW (`addressAnchorsOf`
   * over every live receiving-address fact, `warehouseAddressTexts`) — what
   * `avia_address` recognises. Absent = none read, and no reply states one.
   */
  warehouseAddress?: AddressAnchors;
}

export interface PolicyResult {
  ok: boolean;
  blocks: PolicyHit[];
  warnings: PolicyHit[];
  ledger: LedgerEntry[];
}

/**
 * A phrase as a word of the text, case-insensitive, with up to `suffix`
 * letters of case ending after it — Uzbek and Russian put the case on the
 * name itself («Karimovga», «Каримову»).
 */
function wordIn(text: string, phrase: string, suffix = 0): boolean {
  const p = phrase.trim();
  if ([...p].length < 3) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}\\p{L}{0,${suffix}}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * G6 in the other script (P3): «ГС778» is GS778 to anyone who reads it, and
 * the shipped check matched Latin only, so another customer's code spelled
 * in Cyrillic — or with one Cyrillic «С» inside a Latin code — passed. A
 * text is checked as written AND as two Latin shadows: by SHAPE (Cyrillic and
 * Greek letters drawn like Latin ones — «СR-», «В-000124», «ΑΒ123») and by
 * SOUND (the Uzbek Latin transliteration — «ГС» → GS, «Умриддин» → Umriddin).
 * Keys are lower-case; an upper-case letter maps to the upper-cased value.
 */
const BY_SHAPE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'n', ο: 'o', ρ: 'p', τ: 't', υ: 'y', χ: 'x',
};
const BY_SOUND: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'",
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h', і: 'i',
  α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'x', ψ: 'ps', ω: 'o',
};

function mapLetters(text: string, map: Record<string, string>): string {
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    const to = map[low];
    out += to === undefined ? ch : ch === low ? to : to.toUpperCase();
  }
  return out;
}

/** The text as written and its two Latin shadows, distinct. */
function scriptShadows(text: string): string[] {
  return [...new Set([text, mapLetters(text, BY_SHAPE), mapLetters(text, BY_SOUND)])];
}

const APOSTROPHE = /[‘’ʻʼ`´]/gu;

/** How a name is compared: transliterated by sound, one apostrophe. «Ғулом» and «G‘ulom» are one name. */
function nameShadow(s: string): string {
  return mapLetters(s, BY_SOUND).replace(APOSTROPHE, "'");
}

/**
 * The words a set of approved facts could name a person by (B9): each word
 * written with a capital, compared the way staff names are (by sound, one
 * apostrophe). Only capitalised words — a name is written so — which keeps
 * the draft's stored memory to a short list, and a name a fact writes in
 * lower case is simply not exempt (the safe direction).
 */
export function nameWordsOf(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const word of normalizeDigits(t).split(/[^\p{L}'‘’ʻʼ`´]+/u)) {
      const w = word.replace(/^['‘’ʻʼ`´]+|['‘’ʻʼ`´]+$/gu, '');
      if ([...w].length < 3 || !/^\p{Lu}/u.test(w)) continue;
      out.add(nameShadow(w).toLowerCase());
    }
  }
  return [...out].sort();
}

/**
 * The company's own name, in Latin and in the Cyrillic's Latin shadow (second review): «Va alaykum assalom! GSR
 * Logistics.» read «Logist» — a colleague's first name, three letters of case ending away — as a colleague
 * named, and «⚠️ hodim ismi: Logist» sat on every greeting that said whose company it is. GSR LOGISTICS is the
 * name the prompt gives the reply to say; it names nobody.
 */
// …with its case ending (third review): «GSR Logistikaga xush kelibsiz», «GSR Logisticsga murojaat qilganingiz uchun» —
// the ending failed the lookahead, the name fell back to «gsr» alone, and «Logistikaga» read as the colleague again.
const COMPANY_NAME = /(?<![\p{L}\p{N}])gsr(?:[\s-]*(?:logisti(?:cs?|ks|ka)\p{L}{0,6}))?(?![\p{L}\p{N}])/giu;

/** Words of a full name that name nobody — «o'g'li», «qizi», «aka». */
const NAME_FILLER = new Set(["o'g'li", "og'li", 'ogli', 'ugli', 'qizi', 'kizi', 'aka', 'opa']);

/**
 * Every client-code candidate of a text in any of its spellings — what G6
 * judges and what the client book is asked about (policy-input.ts).
 */
export function codeCandidatesIn(text: string): string[] {
  return codeCandidates(scriptShadows(normalizeDigits(text)));
}

/** Codes in a text that are not this chat's: a book code, or the prefix followed by digits. */
export function foreignCodes(
  text: string,
  ctx: { ownCodes: readonly string[]; bookCodes: ReadonlySet<string>; codePrefix: string },
): string[] {
  const own = new Set(ctx.ownCodes.map((c) => c.toUpperCase()));
  const prefix = ctx.codePrefix.trim().toUpperCase();
  const out = new Set<string>();
  for (const c of codeCandidatesIn(text)) {
    if (own.has(c)) continue;
    const prefixed = prefix !== '' && c.startsWith(prefix) && /^\d+$/u.test(c.slice(prefix.length));
    if (ctx.bookCodes.has(c) || prefixed) out.add(c);
  }
  return [...out];
}

/** Every order of a short list — a name is two to four words, so at most 24. */
function orders(words: readonly string[]): string[][] {
  if (words.length <= 1) return [[...words]];
  return words.flatMap((w, i) => orders([...words.slice(0, i), ...words.slice(i + 1)]).map((rest) => [w, ...rest]));
}

/**
 * G6 for a colleague's name (P3), decided: the FULL stored name — in either
 * script, with its case ending, and in either ORDER (fix round: «Karimov
 * Umriddin», the order every Uzbek document writes, only warned while
 * «Umriddin Karimov» blocked) — BLOCKS, as it always did. One word of it
 * («Umriddin», «Karimovga») only WARNS: Uzbek first names and surnames are
 * shared by half the customers, so a block there would fire on the
 * customer's own name and on every namesake, costing him a ✏️ rewrite each
 * time — while the warning sits on the card beside ✅, which in phase 1 he
 * reads before anything is sent, so the colleague is never named unseen. A
 * word of the customer's own name is neither (a namesake is not a colleague);
 * a three-letter word must stand alone («Ali» is not «Alisher»).
 */
function staffNameHits(
  text: string,
  staffNames: readonly string[],
  customerNames: readonly string[],
  factWords: readonly string[],
  blocks: PolicyHit[],
  warnings: PolicyHit[],
): void {
  const seen = [text.replace(APOSTROPHE, "'"), nameShadow(text)].map((t) => t.replace(COMPANY_NAME, ' '));
  const customer = new Set(customerNames.flatMap((n) => nameShadow(n).toLowerCase().split(/\s+/u)).filter(Boolean));
  // A name the run's approved facts carry is the owner's own words (B9): the seeded «aloqa: Umriddin»
  // must not block the fact he seeded. A colleague the facts do not name still blocks.
  const fact = new Set(factWords.map((w) => w.toLowerCase()));
  for (const name of staffNames) {
    const words = name.trim().split(/\s+/u).filter(Boolean);
    const shadowWords = words.map((w) => nameShadow(w));
    if (shadowWords.length === 0) continue;
    if (shadowWords.every((w) => customer.has(w.toLowerCase())) || shadowWords.every((w) => fact.has(w.toLowerCase()))) continue;
    // Its naming words in any order, side by side — «o'g'li» and «aka» name nobody and may stay out.
    const naming = shadowWords.filter((w) => !NAME_FILLER.has(w.toLowerCase()));
    const whole = [shadowWords, ...(naming.length >= 2 && naming.length <= 4 ? orders(naming) : [])];
    if (whole.some((ws) => seen.some((s) => wordIn(s, ws.join(' '), 5)))) {
      blocks.push({ rule: 'G6', code: 'staff_name', detail: name });
      continue;
    }
    shadowWords.forEach((w, i) => {
      const low = w.toLowerCase();
      if (customer.has(low) || fact.has(low) || NAME_FILLER.has(low) || [...w].length < 3) return;
      if (seen.some((s) => wordIn(s, w, [...w].length >= 4 ? 5 : 0))) {
        warnings.push({ rule: 'G6', code: 'staff_name', detail: words[i]! });
      }
    });
  }
}

/** Phones in a text that are not allowed. */
/** The Chinese characters of a text, nothing else — how a quoted run is compared, whatever spacing or punctuation it was copied with. */
export function hanOnly(text: string): string {
  return text.replace(/[^\p{Script=Han}]/gu, '');
}

/** A stretch of Chinese with the punctuation and spaces Chinese is written with. */
const HAN_RUN = /[\p{Script=Han}，。：；、！？（）「」『』【】《》〈〉·][\p{Script=Han}，。：；、！？（）「」『』【】《》〈〉·\s]*/gu;

/**
 * The shortest stretch that counts as a QUOTATION of a fact (review D2). A
 * single «亿» is in the facts — Horgos's «金亿» — and taken out as «quoted»
 * it would let «1亿 dollar» through G1, so the figure check asks three
 * characters, a piece of a name or a street. The script check asks two: a
 * quoted «义乌» cannot carry a number, and kept it weighs three letters a
 * character.
 */
const QUOTED_MIN_FIGURE = 3;
const QUOTED_MIN_SCRIPT = 2;

/**
 * The reply with every Chinese stretch a fact holds verbatim taken out (his
 * fourth set): «Ivu ombori: 浙江省 义乌市 …» is an Uzbek sentence carrying
 * the supplier's address, and measured whole it read as Chinese — every
 * address reply was refused `wrong_script`. Inside each stretch the LONGEST
 * quoted piece is taken out wherever it starts (review R8): the model glues
 * its own words to what it copies («请发到霍尔果斯金亿…»), and asked of the
 * stretch whole, the glued words kept the quote — and its «亿» — in. What the
 * facts do NOT hold, the model's own Chinese, still counts.
 */
export function withoutQuotedHan(text: string, quotable: string, min = QUOTED_MIN_SCRIPT): string {
  if (!quotable) return text;
  return text.replace(HAN_RUN, (run) => {
    const chars = [...hanOnly(run)];
    const kept: string[] = [];
    let quoted = false;
    for (let i = 0; i < chars.length; ) {
      let len = 0;
      for (let j = chars.length; j - i >= min; j -= 1) {
        if (quotable.includes(chars.slice(i, j).join(''))) {
          len = j - i;
          break;
        }
      }
      if (len > 0) {
        quoted = true;
        kept.push(' ');
        i += len;
      } else {
        kept.push(chars[i]!);
        i += 1;
      }
    }
    if (!quoted) return run;
    const rest = kept.join('');
    return rest.trim() === '' ? ' ' : rest;
  });
}

/** The receiving warehouses as a reply would quote them: pieces of their addresses and names, their phones, their house numbers. */
export interface AddressAnchors {
  /** Five-character pieces of what is OURS in each address — never its province or city, never what every address says. */
  pieces: string[];
  /** Each contact's last nine digits — the comparison `foreignPhones` makes. */
  phones: string[];
  /** The street's house numbers («2255», «168») — recognised beside a street word in any script. */
  houseNumbers: string[];
}

/**
 * A street-level character: town, street, road, lane, house number, building,
 * community, village — or a zone inside a city («胜利工业区» is the Foshan
 * warehouse's own, not a district: #1539).
 */
const STREET_CHAR = /[镇街路道巷弄村号栋社]|工业区|开发区|园区|物流园/u;
/** An administrative-division character: province, city, district, county, prefecture. */
const ADMIN_CHAR = /[省市区县州]/u;
/**
 * The province → city → district chain an address opens with — «浙江省义乌市»,
 * «广东省佛山市南海区», «新疆维吾尔自治区伊犁哈萨克自治州霍尔果斯市». It is where a
 * customer's cargo STARTS as often as where ours is received, so none of it
 * anchors anything (review R7).
 */
const ADMIN_CHAIN = /(?:\p{Script=Han}{1,8}?(?:省|自治区|自治州|特别行政区|市|县|州|盟|旗))+(?:\p{Script=Han}{1,4}?区)?/gu;
/**
 * What every forwarder's name, every contact line and every Chinese address is
 * made of (review #1538) — «国际物流中心», «先生», «电话», «街道», «社区», «路»,
 * «交叉口正东方向…米左右» — so a piece needs other characters to name
 * anybody: «稠江街道» is the whole Choujiang subdistrict and «胜利社区» a
 * community every city has; «荷花南街» is our street.
 */
const GENERIC_CHARS = new Set([...'国际物流中心有限公司仓库货运快递园先生女士电话街道社区镇村路号栋楼巷弄区县市省交叉口方向米左右正与和工业提调车联系人收件']);
/** A house number in a FACT: three or four digits the street gives with 号 / 栋 — never «168米», a distance. */
const FACT_HOUSE_NUMBER = /(?<!\d)(\d{3,4})\s*(?:号|栋|幢|弄)/gu;
/** A house number in a REPLY: three or four digits standing alone — «2255,» ends a clause, «2.255» and «1,255» are amounts. */
const HOUSE_NUMBER = /(?<!\d)(?<!\d[.,])\d{3,4}(?!\d)(?![.,]\d)/gu;
/**
 * A street word in the scripts a transliterated address is written in — what
 * makes a bare «2255» a house number when it stands BESIDE it (review #1538:
 * not «дорого», not «by road», not a «28号» date).
 */
const STREET_WORD =
  /(?<![\p{L}])(?:ko['‘’ʻ`]?cha\p{L}*|кўча\p{L}*|yo['‘’ʻ`]?l(?:i|ida)?|йўл(?:и|ида)?|street|str\.?|avenue|ave\.?|(?<!by\s)road|no\.|улиц\p{L}*|ул\.|проспект\p{L}*|переул\p{L}*|дом|jiedao|jie|nanjie|beijie|dongjie|xijie|lu|hao|-?uy)(?![\p{L}])/iu;
/** How far a house number may stand from its street word, in characters. */
const STREET_REACH = 30;

/**
 * The anchors of the address facts (review D3, R5-R7, #1538, #1539). Read
 * from the facts, never from a list of its own — the warehouse he edits
 * tomorrow is the one refused. A piece is five characters of one run of a
 * fact's Chinese (a digit, a letter or a stop ends the run, so «工业区29号3栋» cannot
 * mint «区号栋», nor the reminder after a street «左右发货前»), or four of a
 * street («荷花南街» — never four of a name, «霍尔果斯» is a city), taken after the province/city chain is removed and kept only when
 * enough of it is not what every address is made of (`GENERIC_CHARS`): two
 * characters in five, three in four. A piece carrying no street character that
 * another address fact or `ordinary` (the GS reminder) also holds is
 * boilerplate; a STREET piece two facts share stays ours — two facts are then
 * one warehouse typed twice, and they must not cancel each other out.
 */
export function addressAnchorsOf(texts: readonly string[], ordinary: readonly string[] = []): AddressAnchors {
  const whole = texts.map((t) => hanOnly(normalizeDigits(t)));
  const common = ordinary.map((t) => hanOnly(normalizeDigits(t)));
  const pieces = new Set<string>();
  const phones = new Set<string>();
  const houseNumbers = new Set<string>();
  texts.forEach((raw, i) => {
    const text = normalizeDigits(raw);
    // Han RUNS (#1539): a digit, a letter or a stop ends one, a space does not
    // («福永街道 塘尾路» is one street line) — «胜利工业区29号3栋» is «胜利工业区», and
    // the GS reminder after «…168米左右.» glues nothing to it.
    const segments = (text.replace(ADMIN_CHAIN, '\u0000').match(/[\p{Script=Han}\s]+/gu) ?? [])
      .map((run) => run.replace(/\s+/gu, ''))
      .filter((seg) => [...seg].length >= 4);
    for (const seg of segments) {
      const chars = [...seg];
      for (const width of [5, 4]) {
        for (let k = 0; k + width <= chars.length; k += 1) {
          const piece = chars.slice(k, k + width).join('');
          const street = STREET_CHAR.test(piece);
          if (common.some((c) => c.includes(piece))) continue;
          if (!street && whole.some((w, j) => j !== i && w.includes(piece))) continue;
          if (ADMIN_CHAR.test(piece) && !street) continue;
          const own = [...piece].filter((c) => !GENERIC_CHARS.has(c)).length;
          // Four characters only of a STREET: «霍尔果斯» is the city a customer flies from.
          if (width === 5 ? own >= 2 : street && own >= 3) pieces.add(piece);
        }
      }
    }
    for (const m of text.matchAll(PHONE_RE)) {
      const d = phoneDigits(m[0]);
      if (d.length >= 9) phones.add(d.slice(-9));
    }
    for (const m of text.replace(PHONE_RE, ' ').matchAll(FACT_HOUSE_NUMBER)) houseNumbers.add(m[1]!);
  });
  return { pieces: [...pieces], phones: [...phones], houseNumbers: [...houseNumbers] };
}

/**
 * Does the reply state one of our receiving warehouses — its contact, a piece
 * of its street or its name, or its house number beside a street word in any
 * script («Hehua South Street 2255», «улица … 2255»)? Asked of an avia quote
 * only (his fourth set «2»): the flight's address is his. Anchored on the
 * warehouses themselves (review D3, R5-R7): neither «从哪个城市» nor the
 * customer's own «浙江省义乌市» is an address of ours. A Chinese mobile that is
 * no warehouse's is `foreign_phone`'s already.
 */
export function statesChinaAddress(text: string, anchors: AddressAnchors): boolean {
  const digits = normalizeDigits(text);
  const ours = new Set(anchors.phones);
  for (const m of digits.matchAll(PHONE_RE)) {
    const d = phoneDigits(m[0]);
    if (d.length >= 9 && ours.has(d.slice(-9))) return true;
  }
  const han = hanOnly(digits);
  if (anchors.pieces.some((piece) => han.includes(piece))) return true;
  const bare = digits.replace(PHONE_RE, ' ');
  return [...bare.matchAll(HOUSE_NUMBER)].some(
    (m) =>
      anchors.houseNumbers.includes(m[0]) &&
      STREET_WORD.test(bare.slice(Math.max(0, m.index - STREET_REACH), m.index + m[0].length + 12)),
  );
}

const CN_MOBILE = /^(?:86)?1[3-9]\d{9}$/u;
const WAREHOUSE_WORD = /ombor|sklad|склад|warehouse|仓库|qabul\s+qil|қабул/iu;
/**
 * A fact that DECLARES itself the flight's receiving point (#1539, #1540):
 * «Avia yuk qabul ombori», «Avia ombori», «Склад для авиа», «air cargo
 * warehouse», «空运仓», «机场货运站». Never a fact that only speaks of the flight
 * («Avia uchun manzilni men o'zim beraman» is a TRUCK warehouse writing down
 * his rule), stands near an airport («aeroportga yaqin», «рядом с
 * аэропортом», «机场北路»), or names a truck beside it («avto va avia yuklar
 * uchun») — in doubt, a fact is the truck's, and the flight's guard counts it.
 */
const FLIGHT_FACT =
  /(?:avia|авиа)[\s-]*(?:yuk\p{L}*\s+)?(?:qabul\s+)?(?:ombor|sklad|склад)\p{L}*|(?:склад|пункт\s+при[её]ма)\s+(?:для\s+)?авиа|air\s*(?:cargo|freight)\s+warehouse|空运(?:仓|收货点)|航空仓|机场(?:货运站|货站|仓)|(?:aeroport|airport)\s+(?:ombor|sklad|warehouse)\p{L}*|аэропорт\p{L}*\s+склад/iu;
/** …turned down in the fact: «avia yuk qabul qilinmaydi», «авиа не принимаем», «不收空运». */
const FLIGHT_REFUSED =
  /(?:avia|авиа|air)[^.!?\n。！？]{0,40}?(?:qabul\s+qilinmaydi|qabul\s+qilmaymiz|olinmaydi|olmaymiz|emas|не\s+принима\p{L}*|не\s+бер\p{L}*|нельзя|not\s+accept\p{L}*|no\s+(?:air|avia))|(?:不收|不接|不做)空运/iu;

/**
 * Pure: is this fact a receiving warehouse's address (review R9, #1538)? The
 * seed files its three under one key, and a warehouse he ADDS on the knowledge
 * page — or re-types instead of ✎ — carries none: a fact that speaks of a
 * warehouse and states a Chinese street or a Chinese mobile is one too. A
 * fact for the FLIGHT is not — it says it is one (`FLIGHT_FACT`), and does
 * not turn the flight down: an avia address he writes down himself is his to
 * have quoted. A truck warehouse that says «avia emas», «avia qabul
 * qilinmaydi» or stands on «机场路» stays ours (#1539) — in doubt, a fact is
 * the truck's, and the flight's guard counts it.
 */
export function isReceivingAddressFact(text: string): boolean {
  if ((FLIGHT_FACT.test(text) && !FLIGHT_REFUSED.test(text) && !namesMode(text, 'road')) || !WAREHOUSE_WORD.test(text)) return false;
  const digits = normalizeDigits(text);
  if ([...digits.matchAll(PHONE_RE)].some((m) => CN_MOBILE.test(phoneDigits(m[0])))) return true;
  return addressAnchorsOf([text]).pieces.some((piece) => STREET_CHAR.test(piece));
}

export function foreignPhones(text: string, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map(phoneDigits).filter((d) => d.length >= 9).map((d) => d.slice(-9)));
  const found: string[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const d = phoneDigits(m[0]);
    if (!ok.has(d.slice(-9))) found.push(m[0]);
  }
  return found;
}

/**
 * G10's fingerprint: what makes two replies «the same text» to Telegram's
 * spam heuristics — case, digits and spacing folded, the customer's own name
 * and codes taken out (they differ per chat by construction).
 */
export function textFingerprint(text: string, strip: readonly string[] = []): string {
  // Text and names both by SOUND, the way G6 compares a name (fix round): the book writes «Бобур Алиев»
  // and the reply greets «Bobur aka» in his Latin, so the name was never cut out of the row it greets.
  let t = nameShadow(normalizeDigits(text)).toLowerCase();
  for (const raw of strip) {
    const s = nameShadow(normalizeDigits(raw)).trim().toLowerCase();
    if (!s) continue;
    // As a WORD, with its endings (`NAME_ENDING`) — «Boburga», «Alijon», «Каримову»: each row is folded with
    // its own customer's names now (K1), and a substring cut — «Ali» out of «alohida» — would fold one text
    // and not the other, so the same sentence read as two.
    const esc = s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}${NAME_ENDING}(?![\\p{L}\\p{N}])`, 'gu'), ' ');
  }
  return t.replace(/\d+/gu, '#').replace(/[\s\p{P}]+/gu, ' ').trim();
}

/**
 * What a name carries in a greeting, as sound: the endearment («-jon»,
 * «-xon») and the case endings Uzbek and Russian hang on it («-ga»,
 * «-ning», «-dan», «-u», «-om», «-im»). A fixed list, for a three-letter
 * name too: «Alijon» is «Ali», where the open «any three letters» it
 * replaced took no ending on a short name at all.
 */
const NAME_ENDING = "(?:jon|xon)?(?:ga|ka|ning|ni|dan|da|lar|u|a|om|e|oy|im|ov)?";

export function questionCount(text: string): number {
  return (text.match(QUESTION_MARKS) ?? []).length;
}

/**
 * A podklyuch — «под ключ», turnkey — IS the road and the customs together,
 * so a sentence explaining it says customs is in THAT price, and says it
 * truly: «Подключ включает доставку и растаможку — какой вариант вам нужен?»
 * is prompt rule 11's own question when the section is not known (fix round).
 * Its sentence is no `customs_included` promise, in every language alike —
 * G11 still asks a yo'lkira estimate to say the customs is apart.
 */
const TURNKEY = /podkl(?:y|i)?uch\p{L}*|подкл[юу]ч\p{L}*|под\s+ключ|turn[\s-]?key|پادکلیوچ|کلید\s+در\s+دست|全包|一站式/iu;

/** Which promise categories a text hits. */
export function promiseHits(text: string): PromiseCategory[] {
  const t = normalizeDigits(text);
  const sentences = sentencesOf(t);
  return PROMISE_CATEGORIES.filter((c) =>
    c === 'customs_included'
      ? sentences.some((s) => !TURNKEY.test(s) && PROMISE_TABLE[c].some((re) => re.test(s)))
      : PROMISE_TABLE[c].some((re) => re.test(t)) || (c === 'dispatch_promise' && (timePromise(t) || dayPromise(t))),
  );
}

/** The full check of a MACHINE reply. */
export function checkAgentReply(input: PolicyInput): PolicyResult {
  const blocks: PolicyHit[] = [];
  const warnings: PolicyHit[] = [];
  const text = normalizeDigits(input.body);
  const trimmed = text.trim();

  if (trimmed === '') blocks.push({ rule: 'G4', code: 'empty' });
  if ([...trimmed].length > AGENT_LIMITS.maxReplyChars) {
    blocks.push({ rule: 'G4', code: 'too_long', detail: String([...trimmed].length) });
  }
  // Two question marks endanger nothing (incident 2026-10-29): the spec's own table sends G4's «one question» to
  // the draft, i.e. to his eye — and «Qanday yuk? Necha kub?», the commonest opener, lost its ✅ for being two.
  // A WARNING, then: the card says so, the ✅ stays. Too long and empty still block.
  if (questionCount(trimmed) > 1) warnings.push({ rule: 'G4', code: 'questions', detail: String(questionCount(trimmed)) });

  // G5 — the customer's script; Uzbek Cyrillic and Russian are one script here. A fact's Chinese
  // address quoted in the reply is the fact's script, not the reply's (his fourth set) — except in a
  // Chinese reply, where it IS the reply's: taken out, the fact's own Uzbek words and the reminder
  // outweighed «您好» and a Chinese customer's address reply read as Latin (review D1).
  const quotable = input.quotableHan ?? '';
  const draftScript = dominantScript(scriptOf(input.language) === 'han' ? trimmed : withoutQuotedHan(trimmed, quotable));
  if (input.customerScript && draftScript !== 'none' && draftScript !== input.customerScript) {
    blocks.push({ rule: 'G5', code: 'wrong_script', detail: `${input.customerScript}→${draftScript}` });
  }
  if (draftScript !== 'none' && draftScript !== scriptOf(input.language)) {
    blocks.push({ rule: 'G5', code: 'wrong_script', detail: `${input.language}→${draftScript}` });
  }
  // His 13 + ⭐3: a Persian or Chinese reply he cannot read is approved through its Uzbek translation — a
  // draft without one has nothing he can check, so it carries no ✅ (K29). Said in words beside the block.
  if ((input.language === 'fa' || input.language === 'zh') && input.hasGloss === false && trimmed !== '') {
    blocks.push({ rule: 'G5', code: 'gloss_missing' });
  }

  // G1 — numbers. A numeral character inside a quoted address is the fact's spelling, not a figure:
  // Horgos's «金亿» beside any «kub» read as a spelled-out number (review D2).
  // A vague count of days the cargo comes in is the same unreadable figure (second review, `vagueTravelTime`).
  const unverifiable =
    unverifiableNumeral(withoutQuotedHan(text, quotable, QUOTED_MIN_FIGURE)) ?? (vagueTravelTime(text) ? 'word_numeral' : null);
  if (unverifiable) blocks.push({ rule: 'G1', code: 'number_unverifiable', detail: unverifiable });
  const removeWhole = [...input.removeWhole, ...input.allowedUrls, ...input.mapUrls];
  // His «Temir yo'l mendan so'rasin» in the reply's OWN words (final review K18): a body that speaks of rail
  // carries no figure a machine found — the run's rail rule read the customer's burst only, so a truck figure
  // presented as the rail price passed once the rail question was one burst back.
  const rail = mentionsRail([text]);
  const sources = rail ? input.numberSources.filter((s) => s.kind !== 'money') : input.numberSources;
  const placed = placedLedger(text, sources, removeWhole, input.askedMode ?? null);
  const ledger: LedgerEntry[] = placed.map(ledgerLine);
  for (const e of placed) {
    if (e.source !== null) continue;
    const detail = rail && e.kind === 'money' ? `${e.raw} — temir yo‘l narxini Bekzod aytadi` : e.raw;
    blocks.push({ rule: 'G1', code: 'number_unsourced', detail });
  }

  // G2 — promises.
  for (const c of promiseHits(text)) blocks.push({ rule: 'G2', code: 'promise', detail: c });

  // G6 — whose things these are.
  for (const code of foreignCodes(text, input)) blocks.push({ rule: 'G6', code: 'other_client_code', detail: code });
  const shadows = scriptShadows(text);
  for (const re of SYSTEM_SHAPE_RES) {
    const m = shadows.map((s) => re.exec(s)).find((x) => x !== null);
    if (m) blocks.push({ rule: 'G6', code: 'system_code', detail: m[0] });
  }
  for (const p of foreignPhones(text, input.allowedPhones)) blocks.push({ rule: 'G6', code: 'foreign_phone', detail: p });
  // His fourth set «2»: avia cargo goes to the address HE gives — never to a receiving warehouse the facts name.
  const anchors = input.warehouseAddress ?? { pieces: [], phones: [], houseNumbers: [] };
  if (input.aviaOnly === true && statesChinaAddress(text, anchors)) blocks.push({ rule: 'G6', code: 'avia_address' });
  // The words did not decide the flight is the chat's road, yet it was spoken of — in the chat, or in this
  // very reply (#1539, #1540: «30 kg mashinaga kam, avia bilan yuborishingiz mumkin. Guanchjou ombori: …»).
  else if ((input.aviaMentioned === true || airMentionIn(text)) && statesChinaAddress(text, anchors)) {
    warnings.push({ rule: 'G6', code: 'avia_maybe' });
  }
  staffNameHits(text, input.staffNames, input.customerNames ?? [], input.factNameWords ?? [], blocks, warnings);
  if (input.canary && text.includes(input.canary)) blocks.push({ rule: 'G6', code: 'canary' });
  if (AI_DENIAL.some((re) => re.test(text))) blocks.push({ rule: 'G6', code: 'ai_denial' });
  if (MENTION.test(text)) blocks.push({ rule: 'G6', code: 'mention' });
  const urls = urlsIn(text);
  for (const u of urls) {
    const isMap = input.mapUrls.some((m) => u.startsWith(m) || m.startsWith(u));
    if (isMap) {
      if (!input.askedLocation) blocks.push({ rule: 'G10', code: 'map_unasked', detail: u });
    } else if (!input.allowedUrls.some((a) => u.startsWith(a) || a.startsWith(u))) {
      blocks.push({ rule: 'G6', code: 'url', detail: u });
    }
  }

  // G10 — the same text to many, links too often.
  if (input.fingerprintPeers > AGENT_LIMITS.fingerprintPeers) {
    blocks.push({ rule: 'G10', code: 'fingerprint', detail: String(input.fingerprintPeers) });
  }
  if (urls.length > 0 && (input.urlsToChat7d >= 1 || input.urlsToday >= AGENT_LIMITS.urlPerDay)) {
    blocks.push({ rule: 'G10', code: 'url_cap' });
  }

  // G11 — a yo'lkira figure is an approximation and says what it leaves out. «Quoted» is every money line
  // a source vouched for — a bare figure the tool's money alone vouches for is money too (K13) — and each is
  // hedged in its own clause (K12).
  const quotedAt = placed.filter((e) => e.kind === 'money' && e.source !== null);
  const quoted = quotedAt.length > 0;
  if (input.hasEstimate && quoted) {
    // A rate said beside its hedged total is that estimate's arithmetic (fix round): «Taxminan 330 $ bo'ladi,
    // kubiga 110 $ dan», «about $330 ($110/cbm)» — the tool's own «330 $ — 110 $/kub» — hedge the price once.
    const hedged = (e: (typeof quotedAt)[number]) => priceHedged(text, e.index, e.end, input.language);
    const sentence = (i: number) => sentenceIndexAt(text, i);
    const approx = quotedAt.every(
      (e) => hedged(e) || (e.perUnit && quotedAt.some((o) => !o.perUnit && sentence(o.index) === sentence(e.index) && hedged(o))),
    );
    if (!approx || !saysExclusion(text, input.language)) blocks.push({ rule: 'G11', code: 'estimate_unhedged' });
  }
  // …and our warehouse's price says where it starts, and that the factory leg is extra (his third set «3»).
  if (input.fromOurWarehouse && quoted && !saysWarehouseCondition(text, input.language)) {
    blocks.push({ rule: 'G11', code: 'warehouse_condition' });
  }

  return { ok: blocks.length === 0, blocks: dedupe(blocks), warnings: dedupe(warnings), ledger };
}

/**
 * His own ✏️ text — his words are his (§17.6): only what Telegram or the
 * outbox would refuse blocks; another client's code is a WARNING (he may mean
 * it, and he is the one who would know).
 */
export function checkOwnerReply(input: {
  body: string;
  ownCodes: readonly string[];
  bookCodes: ReadonlySet<string>;
  codePrefix: string;
}): PolicyResult {
  const blocks: PolicyHit[] = [];
  const warnings: PolicyHit[] = [];
  const text = normalizeDigits(input.body).trim();
  if (text === '') blocks.push({ rule: 'G4', code: 'empty' });
  if ([...text].length > 4000) blocks.push({ rule: 'G4', code: 'too_long', detail: String([...text].length) });
  for (const code of foreignCodes(text, input)) warnings.push({ rule: 'G6', code: 'other_client_code', detail: code });
  return { ok: blocks.length === 0, blocks, warnings, ledger: [] };
}

function dedupe(hits: PolicyHit[]): PolicyHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.rule}:${h.code}:${h.detail ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The figures a text holds — exported for the tools that build sources from tool outputs. */
export { extractNumbers };
