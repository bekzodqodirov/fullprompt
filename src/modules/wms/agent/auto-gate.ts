import { isTashkentNight } from './send-step';

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
  category: 'bu turdagi javob o‘zi ketmaydi',
  status_unbacked: 'yuk holati tekshirilmagan',
  language: 'mijoz tili o‘zbek yoki rus emas',
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

/** The categories the layer may ever open (§18.3) — never price, complaint or other. One home: the CHECK says the same. */
export const AUTO_SEND_CATEGORIES = ['greeting', 'qualification', 'faq', 'status'] as const;
export type AutoCategory = (typeof AUTO_SEND_CATEGORIES)[number];

/** The customer's languages a reply may go in by itself (§18.3). */
export const AUTO_LANGUAGES = ['uz', 'uz_cyrl', 'ru'] as const;

/**
 * The tools whose output is a PRICE or a balance (tools.ts TOOL_SPECS): a run
 * that called any of them — answered or not — is a money reply whatever the
 * model labelled it (§18.3: «money makes it price»).
 */
export const MONEY_TOOLS = ['own_balance', 'yolkira_estimate', 'avia_estimate'] as const;

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
    perDay: number;
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
    /** A money figure in the policy ledger. */
    moneyLedger: boolean;
    /** A tool estimate stands behind the reply (`memory.hasEstimate`). */
    hasEstimate: boolean;
  };
  /** The run's tool calls (`agent_runs.tool_calls`). */
  tools: readonly { name: string; ok: boolean }[];
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
  if (draft.moneyLedger || draft.hasEstimate || input.tools.some((t) => (MONEY_TOOLS as readonly string[]).includes(t.name))) {
    hit.add('money');
  }
  const category = draft.category ?? '';
  if (!(AUTO_SEND_CATEGORIES as readonly string[]).includes(category) || !config.categories.includes(category)) hit.add('category');
  // The label must agree with the facts: «where is my cargo» answered without reading the cargo is a guess.
  if (category === 'status' && !input.tools.some((t) => t.name === STATUS_TOOL && t.ok)) hit.add('status_unbacked');
  if (!(AUTO_LANGUAGES as readonly string[]).includes(draft.language ?? '')) hit.add('language');
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
  if (input.pressedToday >= config.perDay) hit.add('daily_cap');
  if (input.budgetLeft !== null && input.budgetLeft <= 0) hit.add('budget_spent');
  if (input.sendingEnabled === false) hit.add('sending_disabled');
  if (input.listenerCurrent === false) hit.add('listener_behind');
  const reasons = AUTO_REFUSALS.filter((r) => hit.has(r));
  return { eligible: reasons.length === 0, reasons };
}
