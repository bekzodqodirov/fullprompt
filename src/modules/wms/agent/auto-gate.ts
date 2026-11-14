import { AUTO_SEND_CATEGORIES } from './auto-categories';
import { isEstimateTool, saysTashkent } from './auto-money';
import { currencyBesideQuantity } from './digits';
import { isTashkentNight } from './send-step';

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
 * (any WARNING then refuses an auto press, `decideDraft`'s `auto_warning`),
 * the chat moved, the identity, the send window. The machine press is the
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
  'owner_figure',
  'owner_personal',
  'answer_stale',
  'category',
  'status_unbacked',
  'language',
  'media',
  'too_long',
  'low_confidence',
  'stranger',
  'prospect',
  'chat_off',
  'human_active',
  'chat_muted',
  'not_work_account',
  'night',
  'streak',
  'daily_cap',
  'budget_spent',
  'sending_disabled',
  'listener_behind',
] as const;

export type AutoRefusal = (typeof AUTO_REFUSALS)[number];

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
  money: 'javobda pul (narx, balans yoki taxminiy hisob) bor',
  money_unread: 'javobda pul so‘zi bor, lekin raqami o‘qilmadi',
  numeral_unread: 'javobda ieroglif bilan yozilgan son bo‘lishi mumkin — uni o‘qib bo‘lmadi',
  estimate_unnamed: 'narx qaysi yuk uchunligi (kub, kg) aytilmagan',
  estimate_moved: 'narx jadvali o‘zgargan — narx qayta tekshirilmagan',
  tariff_unconfirmed: 'Xitoy tarifi o‘zgargan — birinchi narxni o‘zingiz tasdiqlang',
  foreign_destination: 'mijoz Toshkentdan boshqa shaharni aytgan',
  destination_unsaid: 'javobda «Toshkentgacha» deyilmagan',
  owner_figure: 'javobda sizning raqamingiz bor — ko‘rib yuboring',
  owner_personal: 'javobingizda boshqa mijoz ma’lumoti bor — ko‘rib yuboring',
  answer_stale: 'savolingizdan keyin mijoz yana yozdi',
  category: 'bu turdagi javob o‘zi ketmaydi',
  status_unbacked: 'yuk holati tekshirilmagan',
  language: 'mijoz tili aniq emas yoki javob boshqa tilda',
  media: 'mijoz rasm, ovozli xabar yoki fayl yuborgan',
  too_long: 'javob juda uzun',
  low_confidence: 'AI o‘ziga yetarlicha ishonmaydi',
  stranger: 'chat mijoz yoki lidga bog‘lanmagan',
  prospect: 'bu lidni mijoz topuvchi agent topgan',
  chat_off: 'bu chatda o‘zi yuborish vaqtincha o‘chirilgan',
  human_active: 'suhbatni 🙋 bilan o‘zingiz oldingiz',
  chat_muted: 'bu suhbatda AI o‘chirilgan',
  not_work_account: 'raqam «Ish raqami» deb belgilanmagan',
  night: 'tun — ertalab o‘zingiz qaror qilasiz',
  streak: 'bu chatga ketma-ket 2 ta javob o‘zi ketdi',
  daily_cap: 'bugungi o‘zi yuborish chegarasi tugadi',
  budget_spent: 'bugungi AI yuborish chegarasi tugagan',
  sending_disabled: 'CRM’dan Telegramga yuborish o‘chirilgan',
  listener_behind: 'Telegram ko‘prigi (tinglovchi) yangilanmagan',
};

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

/**
 * The tools whose output is a PRICE or a balance (tools.ts TOOL_SPECS). Judged by OUTCOME since 0148 (spec
 * §1.1): a run that called `own_balance`, or an estimate tool that refused, is a money reply whatever the model
 * labelled it; an estimate that answered with no price (`below_minimum`) is no money at all; a priced estimate
 * goes only through the money clause below.
 */
export const MONEY_TOOLS = ['own_balance', 'yolkira_estimate', 'avia_estimate'] as const;

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

/** The one tool whose answer backs a «status» reply: the customer's own cargo, read. */
export const STATUS_TOOL = 'cargo_status';

/** Auto replies in a row in one chat before he must speak again (§18.3). */
export const AUTO_STREAK_MAX = 2;

export interface AutoGateInput {
  /** agent_auto_config as read. */
  config: {
    armed: boolean;
    categories: readonly string[];
    maxChars: number;
    minConfidence: number;
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
    warnings: number;
    notes: number;
    actionTypes: readonly string[];
    category: string | null;
    language: string | null;
    /** The words that would go — trimmed. */
    body: string;
    confidence: number | null;
    /** The policy ledger's lines (`policy.ledger`) — each with who vouched for it. */
    ledger: readonly AutoLedgerLine[];
    /** A tool estimate stands behind the reply (`memory.hasEstimate`). */
    hasEstimate: boolean;
    /** The run's priced estimates are stored on the draft (`memory.estimates`, §1.3) — what the press re-prices. */
    estimatesStored: boolean;
    /** A chat about rail (`memory.rail`): its price is his (§18.5). */
    rail: boolean;
    /** The customer's language as the run read the message the draft answers (`memory.customerLocale`); null = not stored. */
    customerLocale: { locale: string | null; confident: boolean } | null;
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
  /** Auto replies already in a row in this chat since his own decision or message. */
  streak: number;
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

export function autoVerdict(input: AutoGateInput): AutoVerdict {
  const { config, draft } = input;
  const hit = new Set<AutoRefusal>();
  if (!config.armed) hit.add('not_armed');
  if (!input.agentOn) hit.add('agent_off');
  if (draft.kind !== 'reply') hit.add('not_reply');
  if (draft.status !== 'pending' || draft.ownText) hit.add('not_pending');
  if (draft.blocked) hit.add('blocked');
  if (draft.needsOwner) hit.add('needs_owner');
  if (draft.warnings > 0) hit.add('warnings');
  if (draft.notes > 0) hit.add('notes');
  if (draft.actionTypes.some((a) => a !== 'set_followup')) hit.add('actions');
  const money = moneyVerdict(input);
  if (money.refused) hit.add('money');
  // A price nobody read (spec §1.1, narrowed and widened by the 0148 fix): a currency named beside a quantity no
  // reader placed — never the currency word alone, «narx dollarda kelishiladi» states no price — or a priced run
  // whose reply holds no figure of its estimate at all: it states no price, or one no reader could read.
  if ((!money.lines && currencyBesideQuantity(draft.body)) || money.unquoted) hit.add('money_unread');
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
  // A figure from HIS answer always comes back to him (§2.2, law 4): the AI never relays his number by itself.
  // Asked of his ANSWER as well as of the ledger: a figure of his that the customer, a tool or a fact also carries
  // is vouched for by them, and a redraft may quote the tool's figure where he gave another.
  if (draft.ledger.some((l) => l.origin === 'owner') || input.money.ownerFigure) hit.add('owner_figure');
  if (input.money.ownerPersonal) hit.add('owner_personal');
  if (input.money.answerStale) hit.add('answer_stale');
  // Money makes it price (§18.3): a draft whose money the clause admitted is judged as `price` — which it passes
  // only because he ticked it. But only a label that is itself one of the kinds that ever go: a quote the model
  // labelled «complaint» or «other» stays his whatever it prices (the arming words promise it: «shikoyat va
  // savolli javoblar har doim sizga qoladi»). Refused, the label the model gave is judged as it always was.
  const label = draft.category ?? '';
  const goes = (AUTO_SEND_CATEGORIES as readonly string[]).includes(label);
  const category = money.present && !money.refused && goes ? 'price' : label;
  if (!(AUTO_SEND_CATEGORIES as readonly string[]).includes(category) || !config.categories.includes(category)) hit.add('category');
  // The label must agree with the facts: «where is my cargo» answered without reading the cargo is a guess —
  // asked of the model's OWN label, so a status claim riding an admitted quote is still asked for its reading.
  if (label === 'status' && !input.tools.some((t) => t.name === STATUS_TOOL && t.ok)) hit.add('status_unbacked');
  if (!languageAdmits(draft.language, draft.customerLocale)) hit.add('language');
  if (input.burstMedia) hit.add('media');
  if (draft.body.length > config.maxChars) hit.add('too_long');
  if (draft.confidence === null || !Number.isFinite(draft.confidence) || draft.confidence < config.minConfidence) hit.add('low_confidence');
  if (!input.chat.hasOwner) hit.add('stranger');
  if (input.chat.prospect) hit.add('prospect');
  if (input.chat.offUntil !== null && input.chat.offUntil.getTime() > input.now.getTime()) hit.add('chat_off');
  // The chat is his (🙋), or no AI's at all: the human path would keep the card waiting for him — the machine never presses it.
  if (input.chat.humanUntil !== null && input.chat.humanUntil.getTime() > input.now.getTime()) hit.add('human_active');
  if (input.chat.muted) hit.add('chat_muted');
  if (!input.workAccount) hit.add('not_work_account');
  // The pump's own night (send-step `isTashkentNight`, AGENT_LIMITS' hours): the card waits for the morning (his Q4 ⭐).
  // Judged at the moment the reply would go AND at the moment its card is queued (the second check): a card queued
  // in the night arrives without a sound, and a countdown on it would run his ⏸ window on a message nothing announced.
  if (isTashkentNight(input.at) || isTashkentNight(input.now)) hit.add('night');
  if (input.streak >= AUTO_STREAK_MAX) hit.add('streak');
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
 * estimate stands behind it, or the run made a money call other than an estimate that answered with no price
 * (`below_minimum` — «1 kub yoki 100 kg dan kam»: no money at all). Such a draft passes only when ALL hold:
 *  - he ticked the price act (`price` among the stored categories);
 *  - every money call is a yo'lkira or avia estimate that ANSWERED — never `own_balance` (the customer's debt is
 *    his, ⭐ MAP Q2), never an estimate that refused (a reply after a refusal is the model's own price);
 *  - every money line was vouched for by such a tool, as a total or a rate — never a balance, a fact, his answer,
 *    or a line stored before 0148 with nobody named (fails closed);
 *  - the run's priced estimates are stored on the draft (what the press re-prices, §1.3);
 *  - the chat is not about rail (his price, §18.5).
 * `priced`: the money is an estimate's — the facts that concern only a quoted price (the tariff confirmed, the
 * destination) are asked of it alone. `unquoted`: priced, and no line of the reply is an estimate's figure.
 */
function moneyVerdict(input: AutoGateInput): { present: boolean; refused: boolean; priced: boolean; lines: boolean; unquoted: boolean } {
  const { draft, tools, config } = input;
  const calls = tools.filter((t) => (MONEY_TOOLS as readonly string[]).includes(t.name));
  const noPrice = (t: AutoToolCall) => isEstimateTool(t.name) && t.ok && !t.estimate;
  const lines = draft.ledger.filter((l) => l.kind === 'money');
  const priced = draft.hasEstimate || calls.some((t) => t.ok && t.estimate);
  const present = lines.length > 0 || priced || calls.some((t) => !noPrice(t));
  if (!present) return { present, refused: false, priced: false, lines: false, unquoted: false };
  const refused =
    !config.categories.includes('price') ||
    !calls.every((t) => isEstimateTool(t.name) && t.ok) ||
    !lines.every((l) => l.origin === 'tool' && isEstimateTool(l.tool) && (l.role === 'total' || l.role === 'rate')) ||
    (priced && !draft.estimatesStored) ||
    draft.rail;
  // A priced run whose reply carries no figure of an estimate (0148 fix): «到塔什干的运费大概六百左右» after a tool
  // that said 800 $ holds no money line at all — every clause above passes on an empty list.
  const unquoted = priced && !lines.some((l) => l.origin === 'tool' && isEstimateTool(l.tool));
  return { present, refused, priced, lines: lines.length > 0, unquoted };
}

/**
 * The reply's language against the customer's (spec §4): one of the six; English, Persian and Chinese only when
 * the customer's message confidently says that very language; Uzbek and Russian unless it confidently says
 * another. A guess not stored (a draft written before 0148) is no confident guess.
 */
function languageAdmits(language: string | null, guess: AutoGateInput['draft']['customerLocale']): boolean {
  const lang = language ?? '';
  if (!(AUTO_LANGUAGES as readonly string[]).includes(lang)) return false;
  const confident = guess !== null && guess.confident && guess.locale !== null;
  if ((AUTO_STRICT_LANGUAGES as readonly string[]).includes(lang)) return confident && guess!.locale === lang;
  return !confident || guess!.locale === lang;
}
