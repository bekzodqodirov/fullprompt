import type { AgentNightPrices } from '../../platform/settings/service';
import { isEstimateTool, saysTashkent } from './auto-money';
import { claimsCalcSent } from './calc-claim';
import { currencyBesideQuantity } from './digits';
import type { CalcPriceGateFacts } from './calc-price';
import type { PolicyCode } from './policy';
import { isTashkentNight } from './send-step';
import type { NoteCode } from './types';

export { AUTO_SEND_CATEGORIES, type AutoCategory } from './auto-categories';

/**
 * «O'zi yuborish» — may this reply go WITHOUT his press? (docs/AI-SOTUVCHI.md
 * §18.3, his answer of 2026-11-11: every ⭐ of §18.7 holds except question 1 —
 * no proof cell, no 1-in-5 holdback; an eligible reply goes from the day he
 * arms the layer.)
 *
 * PURE: `auto-send.ts autoFactsFor` reads the facts, this judges them — at the
 * scheduling (when the run writes the draft) AND again at the press, on facts
 * read afresh. Every reason is collected, never the first alone, in ONE stable
 * order: the rehearsal record is the list of everything that kept a reply
 * back, and a page that shows only the first hides the rest.
 *
 * What it does not judge, because the press itself does: the policy re-run
 * (a warning that stops the machine then refuses an auto press, `decideDraft`'s
 * `auto_warning` — `stopsMachine`, the one list both ask), the chat moved, the
 * identity, the send window. The machine press is the
 * same ✅ (`decideDraft`), so those cannot disagree.
 *
 * Three of the ✅'s own refusals ARE judged here at the SCHEDULING (fix pass
 * A, C8), because they are facts then already: the CRM's send switch, a
 * listener that is not current, and the agent's day of sends spent — the
 * replies still counting down included. A card must never count down to a
 * press that is certain to be refused: it holds his attention for the hold
 * and then says «o‘zi ketmadi». Refused at the scheduling, it is an ordinary
 * card from its first second. At the press they are null — not judged here:
 * the ✅ itself asks them, on its own clock.
 *
 * Stage 1a (docs/ai-toliq/qurish/STAGE-0-1A.md §6.2, his 11 a): what decides is what the reply DOES — its class
 * (`autoClassOf`) — never the model's opinion of itself. The model's rating, the ticked label and the two-in-a-row
 * rule are gone (their words stay, `RETIRED_REFUSAL_WORDS`, for the rows written before); a warning or a note stops
 * the machine unless it is one that only informs him (`stopsMachine`); the night bars a class by his setting
 * (`nightBars`); a complaint — the label, or the customer's own words — stays his.
 */

/** Every refusal, in the order the verdict lists them. */
export const AUTO_REFUSALS = [
  'not_armed',
  'agent_off',
  'not_reply',
  'not_pending',
  'blocked',
  'needs_owner',
  'warnings',
  'notes',
  'actions',
  // «Hisoblatishga yubordim» with no calculation sent (stage 1a, J9) — a false claim of an act, beside the acts.
  'calc_claim_unbacked',
  // A calculation the machine lands by itself (SPEC-P2-v2 §1.1) — asked only of a draft judged as `calc`.
  'calc_identity',
  'calc_foreign',
  'calc_refused',
  'calc_recent',
  'calc_file_missing',
  'money',
  // The money clause by OUTCOME (spec SPEC-P1-v2 §1.1, §1.8, §2.2): each its own refusal, its own words.
  'money_unread',
  // A numeral in a system no reader here reads reliably (Chinese numerals) — the machine presses none (0148 fix).
  'numeral_unread',
  'estimate_unnamed',
  'estimate_moved',
  'tariff_unconfirmed',
  'foreign_destination',
  'destination_unsaid',
  // A VED answer's price (SPEC-P2-v2 §2.3, §2.5) — asked of a calc-price line only.
  'markup_unconfirmed',
  'calc_price_moved',
  // His own 💵 for the quoted job arrived while the machine's price counted down (fix pass 1): his figure outranks it.
  'calc_owner_priced',
  // A person's offer became the card's newest word on the quoted job (review crm 1; fix pass 3): his or a seller's price.
  'calc_person_offer',
  'owner_figure',
  'owner_personal',
  'answer_stale',
  // The customer complains or asks for a person — the model's label, or the burst's own words (stage 1a, his «shikoyat
  // har doim sizga qoladi»): it takes the slot of the ticked label it replaces.
  'complaint',
  'status_unbacked',
  'language',
  // A Persian or Chinese tayyor matn he has not approved (stage 1a, J27) — the language's own refusal, beside it.
  'ready_text_unapproved',
  'media',
  'too_long',
  'stranger',
  'prospect',
  'chat_off',
  'human_active',
  'chat_muted',
  'not_work_account',
  'night',
  // The chat loop (stage 1a P2, loop.ts `gateLoopFor`): the reply about to go is one of our last sends, word for word,
  // or the chat is inside the half hour he was told the AI keeps out (J33). In the slot the two-in-a-row rule held.
  'loop',
  'daily_cap',
  'budget_spent',
  'sending_disabled',
  'listener_behind',
] as const;

export type AutoRefusal = (typeof AUTO_REFUSALS)[number];

/**
 * The refusals stage 1a took OUT of the gate (§6.2: the model's own rating, the label tick, two replies in a row).
 * Their words stay for ever: a verdict row stored before the deploy still names them, and the card prints it
 * (auto-card `autoRefusalWords`) — a code that lost its words would read «sababi noma'lum». Their word lives HERE,
 * once; none of them is in `AUTO_REFUSALS` any more.
 */
export const RETIRED_REFUSALS = ['low_confidence', 'category', 'streak'] as const;

export type RetiredRefusal = (typeof RETIRED_REFUSALS)[number];

export const RETIRED_REFUSAL_WORDS: Record<RetiredRefusal, string> = {
  low_confidence: 'AI o‘ziga yetarlicha ishonmaydi',
  category: 'bu turdagi javob o‘zi ketmaydi',
  streak: 'bu chatga ketma-ket 2 ta javob o‘zi ketdi',
};

/**
 * The refusals stage 1a ADDS (§6.2, J9, J27, J33), named and worded in the kernel so no package words one twice. None
 * is in `AUTO_REFUSALS` yet, because nothing emits it: the gate's own test drives every member of that list by its own
 * fact, and a code with no fact cannot stand there. Each moves into `AUTO_REFUSALS`, with its word, in the package that
 * gave it its fact — `complaint` P1 (the label or the burst's words, `AutoGateInput.complaint`), `loop` P2 (the
 * detector), `calc_claim_unbacked` and `ready_text_unapproved` P3 (the reply's own words, the tayyor matn's mark). All
 * four have moved: the list stays, empty, as the one place a later stage's coming refusal is named first.
 */
export const COMING_REFUSALS = [] as const;

export type ComingRefusal = (typeof COMING_REFUSALS)[number];

export const COMING_REFUSAL_WORDS: Record<ComingRefusal, string> = {
};

/** Each refusal in his words — the ONE map the card and the page print (never a code). */
export const AUTO_REFUSAL_WORDS: Record<AutoRefusal, string> = {
  not_armed: 'o‘zi yuborish yoqilmagan',
  agent_off: 'AI sotuvchi o‘chirilgan',
  not_reply: 'bu oddiy javob emas (narx yoki VED savoli)',
  not_pending: 'qoralama endi kutilmayapti (tahrirlangan yoki hal qilingan)',
  blocked: 'javob to‘xtatilgan (qoida buzilgan)',
  needs_owner: 'AI sizdan so‘ragan savol bor',
  warnings: 'kartada ogohlantirish bor',
  notes: 'kartada izoh bor',
  actions: 'javob bilan birga amal bor (hisoblatish yoki AI o‘chirish)',
  // J9: «hisoblatishga yubordim» said with no calculation sent — a false claim to the customer.
  calc_claim_unbacked: 'javobda «hisoblatishga yubordim» deyilgan, lekin hisoblatish yuborilmagan',
  calc_identity: 'chat telefon bilan tasdiqlanmagan — hisoblatishni o‘zingiz yuboring',
  calc_foreign: 'bu boshqa sotuvchining mijozi yoki lidi',
  calc_refused: 'VED navbati bu hisoblatishni olmaydi (lid yopilgan yoki ochiq so‘rovlar to‘la)',
  calc_recent: '14 kun ichida shu yuk uchun hisoblatish bor — ikkinchisini o‘zingiz yuboring',
  calc_file_missing: 'mijoz yuborgan fayl saqlanmagan — VED uni ko‘rmaydi',
  money: 'javobda pul (narx, balans yoki taxminiy hisob) bor',
  money_unread: 'javobda pul so‘zi bor, lekin raqami o‘qilmadi',
  numeral_unread: 'javobda ieroglif bilan yozilgan son bo‘lishi mumkin — uni o‘qib bo‘lmadi',
  estimate_unnamed: 'narx qaysi yuk uchunligi (kub, kg) aytilmagan',
  estimate_moved: 'narx jadvali o‘zgargan — narx qayta tekshirilmagan',
  tariff_unconfirmed: 'Xitoy tarifi o‘zgargan — birinchi narxni o‘zingiz tasdiqlang',
  foreign_destination: 'mijoz Toshkentdan boshqa shaharni aytgan',
  destination_unsaid: 'javobda «Toshkentgacha» deyilmagan',
  markup_unconfirmed: 'ustama o‘zgargan — birinchi VED narxini o‘zingiz tasdiqlang',
  calc_price_moved: 'VED javobi yoki ustama o‘zgardi — bu narx yuborilmadi',
  calc_owner_priced: 'bu ishga narxni 💵 bilan o‘zingiz bergansiz — sizning narxingiz ustun',
  calc_person_offer: 'kartada sotuvchining yangiroq narxi turibdi — o‘sha narx ustun',
  owner_figure: 'javobda sizning raqamingiz bor — ko‘rib yuboring',
  owner_personal: 'javobingizda boshqa mijoz ma’lumoti bor — ko‘rib yuboring',
  answer_stale: 'savolingizdan keyin mijoz yana yozdi',
  // J33: the one sentence for it on the card, the page and the morning line.
  complaint: 'mijoz shikoyat yoki menejer so‘radi — sizga qoldi',
  status_unbacked: 'yuk holati tekshirilmagan',
  language: 'mijoz tili aniq emas yoki javob boshqa tilda',
  // J27: a Persian or Chinese tayyor matn goes by itself only once he approved it.
  ready_text_unapproved: 'fors/xitoy tayyor matni hali tasdiqlanmagan',
  media: 'mijoz rasm, ovozli xabar yoki fayl yuborgan',
  too_long: 'javob juda uzun',
  stranger: 'chat mijoz yoki lidga bog‘lanmagan',
  prospect: 'bu lidni mijoz topuvchi agent topgan',
  chat_off: 'bu chatda o‘zi yuborish vaqtincha o‘chirilgan',
  human_active: 'suhbatni 🙋 bilan o‘zingiz oldingiz',
  chat_muted: 'bu suhbatda AI o‘chirilgan',
  not_work_account: 'raqam «Ish raqami» deb belgilanmagan',
  // J31: a reply the night alone held is judged again at the first working minute — never «yours in the morning».
  night: 'tun — ertalab qayta tekshiriladi',
  // J33: one word for the one loop — the notice (loop `LOOP_NOTICE`), the morning line, the 🔁 follow-up's «why no
  // question» (calc-loop `NO_DRAFT_WORDS`) and this card say the same.
  loop: 'suhbat aylanib qoldi',
  daily_cap: 'bugungi o‘zi yuborish chegarasi tugadi',
  budget_spent: 'bugungi AI yuborish chegarasi tugagan',
  sending_disabled: 'CRM’dan Telegramga yuborish o‘chirilgan',
  listener_behind: 'Telegram ko‘prigi (tinglovchi) yangilanmagan',
};

/**
 * A refusal code as a stored verdict row may carry it — today's, a retired one, or one a later build of this stage
 * wrote — in his words; null for a code nobody knows (the card says so plainly, never printing the code).
 */
export function refusalWordOf(code: string): string | null {
  // Retired first: a retired code is in no other map, and asking its own map first keeps its word wherever it moves.
  if (Object.hasOwn(RETIRED_REFUSAL_WORDS, code)) return RETIRED_REFUSAL_WORDS[code as RetiredRefusal];
  if (Object.hasOwn(AUTO_REFUSAL_WORDS, code)) return AUTO_REFUSAL_WORDS[code as AutoRefusal];
  if (Object.hasOwn(COMING_REFUSAL_WORDS, code)) return COMING_REFUSAL_WORDS[code as ComingRefusal];
  return null;
}

/**
 * The warnings that only INFORM him (stage 1a §6.2): a reply carrying one of these may still go by itself — the card
 * shows it. Every other warning code, and every code minted after this list, keeps the reply his.
 */
export const EYE_ONLY_WARNINGS = ['questions'] as const satisfies readonly PolicyCode[];

/** …and the one note that only informs him: the card was written late (card `lateNote`). */
export const EYE_ONLY_NOTES = ['late'] as const satisfies readonly NoteCode[];

/**
 * Does this warning (or note) keep the reply his — the ONE question both places ask where one stops the machine: the
 * gate (`warnings`, `notes`) and the ✅'s own machine press, on the policy it runs again (decide `auto_warning`). Two
 * lists would let the scheduling admit what the press refuses, or the reverse. Anything not on the eye-only list stops
 * — `avia_maybe`, a short `fingerprint`, a one-word `staff_name`, and every code minted after this was written.
 */
export function stopsMachine(kind: 'warning' | 'note', code: string): boolean {
  const eyeOnly: readonly string[] = kind === 'warning' ? EYE_ONLY_WARNINGS : EYE_ONLY_NOTES;
  return !eyeOnly.includes(code);
}

/**
 * The customer's languages a reply may go in by itself — all six the agent writes since 0148 (spec §4, his
 * «mijoz qaysi tilda yozsa usha tilda suhbat olib borilsin fors xitoy rus ingiliz ozbe»).
 */
export const AUTO_LANGUAGES = ['uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh'] as const;

/**
 * …of which these go only when the customer's own message CONFIDENTLY says that language (spec §4): G5 compares
 * scripts alone, so an English reply to an Uzbek Latin customer, or a Russian one to an Uzbek Cyrillic customer,
 * passes it — and the model's label is its own (`parseCompose` defaults to 'uz'). For the other three a confident
 * guess that differs refuses, and an unconfident one keeps today's rule.
 */
export const AUTO_STRICT_LANGUAGES = ['en', 'fa', 'zh'] as const;

/** The languages of a tayyor matn he cannot read himself (J27, his 10 ⭐ a) — each such one waits for his ✅. */
export const READY_TEXT_UNREAD = ['fa', 'zh'] as const;

/**
 * The tools whose output is a PRICE or a balance (tools.ts TOOL_SPECS). Judged by OUTCOME since 0148 (spec
 * §1.1): a run that called `own_balance`, or an estimate tool that refused, is a money reply whatever the model
 * labelled it; an estimate that answered with no price (`below_minimum`) is no money at all; a priced estimate
 * goes only through the money clause below.
 */
export const MONEY_TOOLS = ['own_balance', 'yolkira_estimate', 'avia_estimate'] as const;

/**
 * The tool that states a VED answer's CLIENT price (SPEC-P2-v2 §2.3, tools `CALC_PRICE_TOOL`). Its own branch of the
 * money clause: never an estimate (no «boj va QQS alohida» — a customs price includes them), its refusals no money.
 */
export const CALC_PRICE_TOOL_NAME = 'calc_price';

/** A tool call as the gate reads it — `estimate` is the tool's own flag (a priced answer), stored with the run. */
export interface AutoToolCall {
  name: string;
  ok: boolean;
  /** A priced yo'lkira or avia answer. A call stored before 0148 carries none and reads as one (fails closed). */
  estimate: boolean;
}

/** A line of the policy ledger as the gate reads it: what kind, and who vouched (`LedgerEntry`, spec §1.1). */
export interface AutoLedgerLine {
  kind: string;
  origin: string | null;
  tool: string | null;
  role: string | null;
}

/**
 * A draft whose ONLY act besides a follow-up is ONE calculation sent to the VED (SPEC-P2-v2 §1.1): judged as category
 * `calc` — by what it does, never by the model's label (the model labels a submit reply `price` or `qualification`).
 * A draft that also mutes, or that carries two submits, is not one. ONE home: the gate and `autoFactsFor`, which reads
 * the calc facts only for such a draft.
 */
export function isCalcSubmitOnly(actionTypes: readonly string[]): boolean {
  return actionTypes.filter((a) => a === 'calc_submit').length === 1 && actionTypes.every((a) => a === 'calc_submit' || a === 'set_followup');
}

/** The five gate facts of a calc submit (§1.1, read by calc-submit `calcSubmitFacts`) — each TRUE where it refuses. */
export interface CalcSubmitFacts {
  /** `calc_identity`: neither a lead chat nor a client the chat proved by phone. */
  unproven: boolean;
  /** `calc_foreign`: the landing's card is a colleague's (`machineMayTouch`, K3). */
  foreign: boolean;
  /** `calc_refused`: the queue would refuse — the lead closed, or the holder's open requests at their cap. */
  refused: boolean;
  /** `calc_recent`: a calculation of this section for this cargo within 14 days, or one still open. */
  recent: boolean;
  /** `calc_file_missing`: a line in the job's window carried a medium this system did not keep. */
  fileMissing: boolean;
}

/** Every fact refusing — a VED-price draft whose facts were not read (fails closed; calc-price's own constant, restated pure). */
const CALC_PRICE_FACTS_ALL: CalcPriceGateFacts = { unconfirmed: true, moved: true, ownerPriced: true, personOffer: true, foreign: true, media: true };

/** Every fact refusing — what a calc draft whose facts were not read is judged on (fails closed). */
export const CALC_FACTS_UNREAD: CalcSubmitFacts = { unproven: true, foreign: true, refused: true, recent: true, fileMissing: true };

/** The one tool whose answer backs a «status» reply: the customer's own cargo, read. */
export const STATUS_TOOL = 'cargo_status';

export interface AutoGateInput {
  /** agent_auto_config as read. */
  config: {
    armed: boolean;
    categories: readonly string[];
    maxChars: number;
    /** Auto presses a Tashkent day may hold; null = no cap (0148, his «7 chegara qoyma»). */
    perDay: number | null;
  };
  /** The agent runs (shadow) and speaks from the draft holder's account. */
  agentOn: boolean;
  draft: {
    kind: string;
    status: string;
    /** He wrote his own words for it (`final_body`). */
    ownText: boolean;
    blocked: boolean;
    needsOwner: boolean;
    /**
     * The policy's warnings by CODE (`policy.warnings[].code`; one that names none reads '?'): stage 1a frees the
     * `EYE_ONLY_WARNINGS` and nothing else, so the gate must see WHICH warning, never only how many.
     */
    warningCodes: readonly string[];
    /**
     * The draft's notes by code (stage 1a, K5 — auto-send `noteCodesOf`): `[]` = no notes; null = notes stored
     * without their codes (a draft written before 1a, or a writer that lost them) — refused like any note.
     */
    noteCodes: readonly string[] | null;
    /** The reply is a tayyor matn the code wrote (`policy.system`, stage 1a P3) — not the model's words. */
    systemAck: boolean;
    /**
     * The code put the honest line in front of the model's reply, or wrote it alone (`policy.honestLine`, run
     * `withBotAnswer` — the customer asked whether we are a bot): a tayyor matn too, in the reply's language.
     */
    honestLine: boolean;
    actionTypes: readonly string[];
    category: string | null;
    language: string | null;
    /** The words that would go — trimmed. */
    body: string;
    /** The model's own rating, as stored — read by nothing here since stage 1a (the evening sample weighs by it). */
    confidence: number | null;
    /** The policy ledger's lines (`policy.ledger`) — each with who vouched for it. */
    ledger: readonly AutoLedgerLine[];
    /** A tool estimate stands behind the reply (`memory.hasEstimate`). */
    hasEstimate: boolean;
    /** The run's priced estimates are stored on the draft (`memory.estimates`, §1.3) — what the press re-prices. */
    estimatesStored: boolean;
    /** A chat about rail (`memory.rail`): its price is his (§18.5). */
    rail: boolean;
    /** The run's VED answer prices are stored on the draft (`memory.calcPrices`, SPEC-P2-v2 §2.3) — what the press re-prices. */
    calcPricesStored: boolean;
    /** The customer's language as the run read the message the draft answers (`memory.customerLocale`); null = not stored. */
    customerLocale: { locale: string | null; confident: boolean; leans?: boolean } | null;
    /**
     * The reply holds a numeral in a system no reader here reads reliably — a Chinese numeral run (auto-money
     * `numeralUnread`, over the reply less its facts' quoted Chinese). A character is a word as often as a number.
     */
    unreadNumeral: boolean;
  };
  /** The run's tool calls (`agent_runs.tool_calls`). */
  tools: readonly AutoToolCall[];
  /**
   * The money facts read off the draft and the day (spec §1.1, §1.3, §1.6, §1.8, §2.2). Each refuses on its own;
   * the gate does not recompute them.
   */
  money: {
    /** A money line sits in a sentence that does not restate the load its estimate priced (`estimateUnnamed`). */
    unnamed: boolean;
    /** A stored estimate re-priced today gives another figure, or is refused (§1.3). */
    moved: boolean;
    /** The China column was written after his last ✅ on it (§1.6). */
    tariffUnconfirmed: boolean;
    /** The customer named a city or region other than Tashkent (§1.8). */
    foreignDestination: boolean;
    /** His ✍️ answer behind this redraft names another customer, or this chat's code to a chat not proven (§2.2). */
    ownerPersonal: boolean;
    /** The customer wrote again after the question his answer was given to — or edited, or deleted, that very line (§2.2). */
    answerStale: boolean;
    /**
     * His ✍️ answer behind this redraft held a figure of any kind (`policy.fromAnswer.figures`, §2.2, his Q2 a ⭐):
     * asked of the ANSWER, never of who the ledger says vouched — a figure the customer, a tool or a fact also
     * carries is attributed to them, and the reply made of his figure went by itself.
     */
    ownerFigure: boolean;
  };
  /** The customer's burst carried a photo, a voice note or a file. */
  burstMedia: boolean;
  /**
   * The five facts of a calculation the machine would land (SPEC-P2-v2 §1.1, calc-submit `calcSubmitFacts`) — read
   * only for a draft judged as `calc` (its one act a calc submit, and `calc` ticked); null otherwise. A calc draft
   * whose facts are null is judged as if every one refused (fails closed).
   */
  calc: CalcSubmitFacts | null;
  /**
   * The four facts of a reply quoting a VED answer's price (SPEC-P2-v2 §2.3, calc-price `calcPriceGateFacts`) — read
   * only for a draft with stored `memory.calcPrices` and the machine's words; null otherwise. A calc-price line judged
   * with null facts refuses every one (fails closed).
   */
  calcPrice: CalcPriceGateFacts | null;
  chat: {
    /** Bound to a client or a lead. */
    hasOwner: boolean;
    /** The client-finding agent's prospect (`sendWindowFor` = 'agent_lead'). */
    prospect: boolean;
    /** agent_auto_chats' `off_until`, or null. */
    offUntil: Date | null;
    /**
     * His 🙋 «Suhbat meniki» on this chat (`agent_conversations.human_until`), or null (final check): the chat is
     * his while it runs. The run reads it once, before its model call — a 🙋 pressed during that call reaches
     * only this fact, at the scheduling and again at the press.
     */
    humanUntil: Date | null;
    /** The AI was switched off in this chat (`agent_conversations.muted_at` — the customer's own wish, a block). */
    muted: boolean;
  };
  /** tg_accounts.work_account of the holder — «Ish raqami». */
  workAccount: boolean;
  /** When the reply would go: the due time at the scheduling, the press's own moment at the press. */
  at: Date;
  /**
   * The judging moment: at the scheduling, when the run writes the draft and its card is queued — the staff drain
   * sends that card at once, silently in the quiet hour (notifications `sendsSilently`), so a reply written in the
   * night's last hold is a night reply whatever its due time (the second check). At the press it is `at` itself.
   */
  now: Date;
  /**
   * The reply about to go is, folded, one of our last sends to this chat in the loop window (`own_repeat` — never of
   * a tayyor matn, whose repeat rule is «once per silence»), or he was told this chat loops less than the window before
   * it would go — the notice's half hour (J33). Stage 1a P2, auto-send `autoLoopFact` over loop `gateLoopFor`. The
   * anchor's two loop signals are eligibility's: such a run drafts nothing.
   */
  loop: boolean;
  /**
   * The customer's burst asks for a person or complains (stage 1a P3 `complaint.ts`; false until it lands). The gate
   * refuses `complaint` on this OR the model's own label `complaint`.
   */
  complaint: boolean;
  /**
   * Which prices may go by themselves at night (`agent_night_prices`, his 4 a): read on the pool before the gate is
   * asked — the night bars a class by it (`nightBars`).
   */
  nightPrices: AgentNightPrices;
  /**
   * Auto presses this Tashkent day — at the scheduling, with the replies still
   * counting down (waiting or being pressed): each of those is a press the cap
   * already owes (fix pass A, C8).
   */
  pressedToday: number;
  /**
   * The agent's sends it may still make today (today `sendsToday`: ceiling −
   * used), less the replies still counting down — the ✅'s `budget_spent`,
   * known before the hold. Null at the press (the ✅ asks it itself).
   */
  budgetLeft: number | null;
  /** The CRM's own send switch (`tg_sending_enabled`) — the ✅'s `sending_disabled`. Null at the press. */
  sendingEnabled: boolean | null;
  /** A current listener on the account (account-guard `listenerIsCurrent`) — the ✅'s `listener_behind`. Null at the press. */
  listenerCurrent: boolean | null;
}

export interface AutoVerdict {
  eligible: boolean;
  reasons: AutoRefusal[];
}

/** What a reply IS for the hold, the night and the language (stage 1a §4.1 K6) — never the model's label. */
export type AutoClass = 'talk' | 'price' | 'calc_price' | 'calc';

/**
 * The class a draft is judged as — the rule the relaxed language, the zero hold and the night all hang on, so it fails
 * CLOSED: anything that is not plainly talk is a price.
 *  - `calc`: its one act is a calculation sent to the VED (`isCalcSubmitOnly`);
 *  - `calc_price`: a VED answer's price stands behind it — whenever, even beside a table price (J5: the VED price is
 *    the one the night bars, so the mixed reply waits for the morning like the VED price alone);
 *  - `price`: ANY money — a ledger money line, an estimate, a money tool's call (`moneyVerdict.present`, refused or
 *    admitted), a currency beside a quantity no reader placed, a numeral no reader reads — and any act besides a
 *    follow-up (the gate refuses those as `actions` anyway);
 *  - `talk`: none of that.
 */
export function autoClassOf(input: AutoGateInput): AutoClass {
  const { draft } = input;
  if (isCalcSubmitOnly(draft.actionTypes)) return 'calc';
  const money = moneyVerdict(input);
  if (money.calcPriced) return 'calc_price';
  // `money_unread` / `numeral_unread` would fire: a price nobody read is a price all the same.
  const unread = (!money.lines && currencyBesideQuantity(draft.body)) || money.unquoted || draft.unreadNumeral;
  if (money.present || unread) return 'price';
  if (draft.actionTypes.some((a) => a !== 'set_followup')) return 'price';
  return 'talk';
}

/**
 * Does the night (22:00-08:00 Tashkent) bar a reply of this class from going by itself (his 4 a ⚠ and his ⭐ a of
 * question 1)? Talk never — the AI answers a customer who wrote, at any hour, and the pump never lets it write first
 * (send-step `releaseAt`). A calculation always: a VED job at night rings a colleague, and cards to colleagues wait
 * for the morning. A VED price unless he chose `all`; a table price only when he chose `none`. Asked by the gate at
 * the scheduling and by the press of a copy that did not ring — never by the clock alone.
 */
export function nightBars(cls: AutoClass, nightPrices: AgentNightPrices): boolean {
  switch (cls) {
    case 'talk':
      return false;
    case 'calc':
      return true;
    case 'calc_price':
      return nightPrices !== 'all';
    case 'price':
      return nightPrices === 'none';
  }
}

export function autoVerdict(input: AutoGateInput): AutoVerdict {
  const { config, draft } = input;
  const hit = new Set<AutoRefusal>();
  if (!config.armed) hit.add('not_armed');
  if (!input.agentOn) hit.add('agent_off');
  if (draft.kind !== 'reply') hit.add('not_reply');
  if (draft.status !== 'pending' || draft.ownText) hit.add('not_pending');
  if (draft.blocked) hit.add('blocked');
  if (draft.needsOwner) hit.add('needs_owner');
  // A warning or a note stops the machine unless it only informs him (`stopsMachine` — the press asks the same).
  // Notes stored without their codes are a stop of their own kind (`noteCodes` null): a draft written before 1a.
  if (draft.warningCodes.some((c) => stopsMachine('warning', c))) hit.add('warnings');
  if (draft.noteCodes === null || draft.noteCodes.some((c) => stopsMachine('note', c))) hit.add('notes');
  // A calculation goes by itself only as its own kind (SPEC-P2-v2 §1.1): a draft whose one act is a calc submit is
  // judged as `calc` — by what it DOES, never by the model's label — and only once he ticked «Hisoblatish». Unticked,
  // it is judged exactly as before: an action, refused.
  const calc = isCalcSubmitOnly(draft.actionTypes) && config.categories.includes('calc');
  if (draft.actionTypes.some((a) => a !== 'set_followup' && !(calc && a === 'calc_submit'))) hit.add('actions');
  // Rule 11's «hisoblatishga yubordim» with no calculation beside it (J9): the customer would be told his job went to
  // the VED when nothing went. Asked of the words that would go — the machine's — at the scheduling and the press.
  if (!draft.actionTypes.includes('calc_submit') && claimsCalcSent(draft.body)) hit.add('calc_claim_unbacked');
  if (calc) {
    const f = input.calc ?? CALC_FACTS_UNREAD;
    if (f.unproven) hit.add('calc_identity');
    if (f.foreign) hit.add('calc_foreign');
    if (f.refused) hit.add('calc_refused');
    if (f.recent) hit.add('calc_recent');
    if (f.fileMissing) hit.add('calc_file_missing');
  }
  const money = moneyVerdict(input);
  if (money.refused) hit.add('money');
  // A price nobody read (spec §1.1, narrowed and widened by the 0148 fix): a currency named beside a quantity no
  // reader placed — never the currency word alone, «narx dollarda kelishiladi» states no price — or a priced run
  // whose reply holds no figure of its estimate at all: it states no price, or one no reader could read. A VED price
  // the tool answered and the reply did not quote is the same (SPEC-P2-v2 §2.3, the `unquoted` analog).
  if ((!money.lines && currencyBesideQuantity(draft.body)) || money.unquoted || money.calcUnquoted) hit.add('money_unread');
  // …and a numeral no reader reads reliably, wherever it stands: the machine never presses a guess.
  if (draft.unreadNumeral) hit.add('numeral_unread');
  // The quote's own facts — asked of a priced reply the money clause admitted (a refused one is `money` already).
  const quote = money.priced && !money.refused;
  if (quote && input.money.unnamed) hit.add('estimate_unnamed');
  if (quote && input.money.moved) hit.add('estimate_moved');
  if (quote && input.money.tariffUnconfirmed) hit.add('tariff_unconfirmed');
  if (quote && input.money.foreignDestination) hit.add('foreign_destination');
  // The table is China → Tashkent (§1.8): a reply with an estimate says so, in addition to the city check.
  if (quote && !saysTashkent(draft.body)) hit.add('destination_unsaid');
  // A VED answer's price the clause admitted (SPEC-P2-v2 §2.3): its own facts — never the truck's (a customs price is
  // no table figure and names no destination). Facts not read refuse every one.
  const calcQuote = money.calcPriced && !money.refused;
  const cp = calcQuote ? (input.calcPrice ?? CALC_PRICE_FACTS_ALL) : null;
  if (cp?.unconfirmed) hit.add('markup_unconfirmed');
  if (cp?.moved) hit.add('calc_price_moved');
  if (cp?.ownerPriced) hit.add('calc_owner_priced');
  if (cp?.personOffer) hit.add('calc_person_offer');
  if (cp?.foreign) hit.add('calc_foreign');
  // A figure from HIS answer always comes back to him (§2.2, law 4): the AI never relays his number by itself.
  // Asked of his ANSWER as well as of the ledger: a figure of his that the customer, a tool or a fact also carries
  // is vouched for by them, and a redraft may quote the tool's figure where he gave another.
  if (draft.ledger.some((l) => l.origin === 'owner') || input.money.ownerFigure) hit.add('owner_figure');
  if (input.money.ownerPersonal) hit.add('owner_personal');
  if (input.money.answerStale) hit.add('answer_stale');
  // The label is free (stage 1a §4.2): what a reply DOES decides — its money by the clause above and his ticks, a
  // calculation by its act and his tick — so the four ordinary kinds are no longer read. One label still decides: a
  // complaint stays his (the arming words promise it: «shikoyat har doim sizga qoladi»), and so does a burst that
  // complains or asks for a person in its own words (`complaint`, P3's reader), whatever the reply does.
  const label = draft.category ?? '';
  if (label === 'complaint' || input.complaint) hit.add('complaint');
  // The label must agree with the facts: «where is my cargo» answered without reading the cargo is a guess —
  // asked of the model's OWN label, so a status claim riding an admitted quote is still asked for its reading.
  if (label === 'status' && !input.tools.some((t) => t.name === STATUS_TOOL && t.ok)) hit.add('status_unbacked');
  const cls = autoClassOf(input);
  // Today's language rule for every MODEL reply (J19), byte for byte, whatever its class. The ONE relaxation J19 rules
  // (a guess that names no language admits Uzbek) was measured against the reader corpus before a line of it was
  // written: eleven of its dangerous rows would go — a Russian customer writing in Latin letters («Skolko budet za 3
  // kuba?», «Kogda pridet gruz?») and an English one («Working hours?», «Services?») answered in Uzbek by themselves.
  // Those rows are the MODEL's words, so the lead's ruling (the merged-tree seam review, finding 4) gives the
  // relaxation to the tayyor matn alone (`systemAck`): a photo or a voice note shows no language at all, and «write it
  // as text» in Uzbek is a line he wrote himself and read once. A model reply to a message showing no language waits
  // for his ✅ as before; `language_money` and `language` in the corpus pin that side.
  if (!languageAdmits(draft.language, draft.customerLocale, draft.systemAck)) hit.add('language');
  // A tayyor matn in Persian or Chinese — a system line or the honest line (J27): he reads neither, and his answer 10
  // is that he approves each once by its Uzbek gloss. Until that list exists (stage 1b) every such reply is his card.
  if ((draft.systemAck || draft.honestLine) && (READY_TEXT_UNREAD as readonly string[]).includes(draft.language ?? '')) {
    hit.add('ready_text_unapproved');
  }
  // Not asked of a calculation (§1.1, judge regress 8): the burst's invoice IS the material — it goes to the VED with
  // the job (calc-files), and the reply («yubordim») claims nothing about reading it.
  // A VED answer's price asks it over the lines newer than the job's LANDING instead (§2.3): the request burst's own
  // files went to the VED with the job, so they are no file the reply ignores.
  // Never asked of a tayyor matn the code wrote (stage 1a, `systemAck`): THAT reply is the answer to the photo or the
  // voice note — «yozib yuboring» — and it reads nothing of it.
  if ((calcQuote ? cp!.media : input.burstMedia) && !calc && !draft.systemAck) hit.add('media');
  if (draft.body.length > config.maxChars) hit.add('too_long');
  if (!input.chat.hasOwner) hit.add('stranger');
  if (input.chat.prospect) hit.add('prospect');
  if (input.chat.offUntil !== null && input.chat.offUntil.getTime() > input.now.getTime()) hit.add('chat_off');
  // The chat is his (🙋), or no AI's at all: the human path would keep the card waiting for him — the machine never presses it.
  if (input.chat.humanUntil !== null && input.chat.humanUntil.getTime() > input.now.getTime()) hit.add('human_active');
  if (input.chat.muted) hit.add('chat_muted');
  if (!input.workAccount) hit.add('not_work_account');
  // The pump's own night (send-step `isTashkentNight`, AGENT_LIMITS' hours), for the classes it bars (`nightBars`, his
  // 4 a): such a card waits for the morning. Judged at the moment the reply would go AND at the moment its card is
  // queued (the second check): a card queued in the night arrives without a sound, and a countdown on it would run his
  // ⏸ window on a message nothing announced. Talk is never barred.
  if (nightBars(cls, input.nightPrices) && (isTashkentNight(input.at) || isTashkentNight(input.now))) hit.add('night');
  // Two replies in a row are no rule of their own any more: the loop detector (P2) takes that slot.
  if (input.loop) hit.add('loop');
  // NULL = no daily count (his «7 chegara qoyma»); the account's own send caps still bound the day (`budget_spent`).
  if (config.perDay !== null && input.pressedToday >= config.perDay) hit.add('daily_cap');
  if (input.budgetLeft !== null && input.budgetLeft <= 0) hit.add('budget_spent');
  if (input.sendingEnabled === false) hit.add('sending_disabled');
  if (input.listenerCurrent === false) hit.add('listener_behind');
  const reasons = AUTO_REFUSALS.filter((r) => hit.has(r));
  return { eligible: reasons.length === 0, reasons };
}

/**
 * The money clause by OUTCOME (spec §1.1, §1.4). A draft carries money when its ledger holds a money line, a tool
 * estimate stands behind it, a VED price was answered, or the run made a money call other than an estimate that
 * answered with no price (`below_minimum` — «1 kub yoki 100 kg dan kam»: no money at all). Such a draft passes only
 * when ALL hold:
 *  - every money call is a yo'lkira or avia estimate that ANSWERED — never `own_balance` (the customer's debt is
 *    his, ⭐ MAP Q2), never an estimate that refused (a reply after a refusal is the model's own price); a
 *    `calc_price` call is no such call (its refusals are no money, SPEC-P2-v2 §2.3);
 *  - every money line was vouched for by such a tool, as a total or a rate — or by `calc_price`, as a total; never a
 *    balance, a fact, his answer, or a line stored before 0148 with nobody named (fails closed);
 *  - an estimate's money: he ticked the price act (`price`), and the run's priced estimates are stored (§1.3);
 *  - a VED price: he ticked «VED narxi» (`calc_price`), and the run's VED prices are stored (`memory.calcPrices`);
 *  - the chat is not about rail (his price, §18.5).
 * `priced`: the money is an estimate's — the facts that concern only a quoted truck price (the tariff confirmed, the
 * destination) are asked of it alone. `calcPriced`: a VED price stands behind the reply (its own facts, §2.3).
 * `unquoted` / `calcUnquoted`: priced, and no line of the reply is that tool's figure.
 */
function moneyVerdict(input: AutoGateInput): {
  present: boolean;
  refused: boolean;
  priced: boolean;
  calcPriced: boolean;
  estimateMoney: boolean;
  lines: boolean;
  unquoted: boolean;
  calcUnquoted: boolean;
} {
  const { draft, tools, config } = input;
  const calls = tools.filter((t) => (MONEY_TOOLS as readonly string[]).includes(t.name));
  const noPrice = (t: AutoToolCall) => isEstimateTool(t.name) && t.ok && !t.estimate;
  const lines = draft.ledger.filter((l) => l.kind === 'money');
  const calcLine = (l: AutoLedgerLine) => l.origin === 'tool' && l.tool === CALC_PRICE_TOOL_NAME && l.role === 'total';
  const estimateLine = (l: AutoLedgerLine) => l.origin === 'tool' && isEstimateTool(l.tool) && (l.role === 'total' || l.role === 'rate');
  const priced = draft.hasEstimate || calls.some((t) => t.ok && t.estimate);
  const calcPriced = tools.some((t) => t.name === CALC_PRICE_TOOL_NAME && t.ok) || lines.some(calcLine);
  const present = lines.length > 0 || priced || calcPriced || calls.some((t) => !noPrice(t));
  if (!present) return { present, refused: false, priced: false, calcPriced: false, estimateMoney: false, lines: false, unquoted: false, calcUnquoted: false };
  // Everything that is not a VED price: the truck table, the avia rate, a balance, a line nobody vouched for.
  const estimateMoney = priced || calls.some((t) => !noPrice(t)) || lines.some((l) => !calcLine(l));
  const refused =
    (estimateMoney && !config.categories.includes('price')) ||
    (calcPriced && !config.categories.includes('calc_price')) ||
    !calls.every((t) => isEstimateTool(t.name) && t.ok) ||
    !lines.every((l) => estimateLine(l) || calcLine(l)) ||
    (priced && !draft.estimatesStored) ||
    // A VED price the reply STATES and the draft did not keep (fails closed). One the tool merely offered and the words
    // never said is kept by no draft (run `settleCalcPrices`) — that reply is `money_unread` alone, below.
    (lines.some(calcLine) && !draft.calcPricesStored) ||
    draft.rail;
  // A priced run whose reply carries no figure of an estimate (0148 fix): «到塔什干的运费大概六百左右» after a tool
  // that said 800 $ holds no money line at all — every clause above passes on an empty list.
  const unquoted = priced && !lines.some((l) => l.origin === 'tool' && isEstimateTool(l.tool));
  const calcUnquoted = calcPriced && !lines.some(calcLine);
  return { present, refused, priced, calcPriced, estimateMoney, lines: lines.length > 0, unquoted, calcUnquoted };
}

/**
 * The reply's language against the customer's (spec §4): one of the six; English, Persian and Chinese only when
 * the customer's message confidently says that very language; Uzbek and Russian on a confident guess of that very
 * language, or an unconfident one that LEANS on it (fix pass 4: the conversation's stored language, the one language
 * the greetings said, or Uzbek's word endings — run `memoryFor`). Where the rule cannot tell the customer's language
 * it holds (fix pass 6): a guess that leans on nothing, a guess naming no language, and a guess not stored (a draft
 * written before 0148) admit no reply by itself — each was «today's rule», which let the other language go. Save one
 * line (stage 1a, J19 as ruled for the merged tree): the code's own Uzbek tayyor matn on a guess naming no language.
 */
function languageAdmits(language: string | null, guess: AutoGateInput['draft']['customerLocale'], tayyorMatn: boolean): boolean {
  const lang = language ?? '';
  if (!(AUTO_LANGUAGES as readonly string[]).includes(lang)) return false;
  // Nothing known of the customer's language — no guess stored, or one that names none — admits no reply by itself.
  // One exception (J19's relaxation, the tayyor matn's alone — see `autoVerdict`): a guess that names none admits the
  // code's own Uzbek line. Never a guess not stored (a draft written before 0148 says nothing either way).
  if (guess === null) return false;
  if (guess.locale === null) return tayyorMatn && lang === 'uz';
  if (guess.confident) return guess.locale === lang;
  if ((AUTO_STRICT_LANGUAGES as readonly string[]).includes(lang)) return false;
  // An unconfident guess admits only the language it LEANS on — and one that leans on nothing admits none (fix pass 6,
  // the hunt #3): «Иудан Тошкентгача неча пул?» with no ў/қ/ғ/ҳ read as an unconfident «ru», and the Russian reply went
  // by itself; «Почём доставка из Китая?» the same with an Uzbek one.
  return guess.leans === true && guess.locale === lang;
}
