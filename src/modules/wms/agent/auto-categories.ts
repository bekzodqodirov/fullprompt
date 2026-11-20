/**
 * The kinds of reply «o'zi yuborish» may ever open (docs/AI-SOTUVCHI.md §18.3)
 * — ONE home, read by the gate (`auto-gate.ts`), the writer of his choice
 * (`auto-send.ts setAutoCategories`) and the page's boxes (`agent-ui.tsx`, a
 * client file: it must not import the gate, which would pull the send step
 * into the browser bundle). Imports nothing. The last migration that re-makes
 * `agent_auto_config_categories_check` (0149) says the same seven.
 *
 * `price` is the fifth since 0148 (spec §1.5, his Q1 ⭐): a reply whose only
 * money is the yo'lkira table's or his avia rate × the customer's kilos — the
 * gate's money clause decides that by OUTCOME, and only when he ticks it. Never
 * complaint or other. The calibration's measured list stays the four
 * (calibration.ts `AUTO_CATEGORIES`): price is gated, not measured.
 *
 * `calc` and `calc_price` since 0149 (SPEC-P2-v2 §1.1, §2.3) — judged by what the
 * reply DOES, never by the model's label (`OUTCOME_CATEGORIES`): a reply whose
 * only act is a calculation sent to the VED, and the VED's answer told with his
 * markup through the closed `calc_price` tool. Both ship unticked (§7 Q1, Q2 ⭐).
 */
export const AUTO_SEND_CATEGORIES = ['greeting', 'qualification', 'faq', 'status', 'price', 'calc', 'calc_price'] as const;
export type AutoCategory = (typeof AUTO_SEND_CATEGORIES)[number];

/**
 * The two kinds no model label may name (§1.1: «`calc` is never a reply label»). The model labels a calculation's
 * reply `price` or `qualification` (tools.ts compose_reply), so judged by the label a `calc` tick would never free
 * the commonest calc reply — the gate decides these two from the draft's action and its tool calls instead.
 */
export const OUTCOME_CATEGORIES = ['calc', 'calc_price'] as const satisfies readonly AutoCategory[];

/** The kinds a model's own label may name — the seven less the two decided by outcome. */
export const LABEL_CATEGORIES: readonly AutoCategory[] = AUTO_SEND_CATEGORIES.filter(
  (c) => !(OUTCOME_CATEGORIES as readonly string[]).includes(c),
);

/** The kinds a server one migration behind 0149 cannot store (its CHECK refuses them). */
export const P2_CATEGORIES: readonly AutoCategory[] = OUTCOME_CATEGORIES;

/**
 * The four kinds of ordinary talk (stage 1a, STAGE-0-1A.md §4.2, his 11 a): no longer READ by the gate — ordinary talk
 * goes by itself unticked, its class decided by what it does (auto-gate `autoClassOf`) — but always STORED: 0149's
 * CHECK wants at least one kind, and a migration never flips what he stored. So his box saves the three below and the
 * writer adds these four every time (auto-send `setAutoCategories`).
 */
export const ORDINARY_CATEGORIES = ['greeting', 'qualification', 'faq', 'status'] as const satisfies readonly AutoCategory[];

/** The three kinds he still ticks (the page's boxes since stage 1a): a table price, a calculation, a VED price. */
export const TICKED_CATEGORIES: readonly AutoCategory[] = AUTO_SEND_CATEGORIES.filter(
  (c) => !(ORDINARY_CATEGORIES as readonly string[]).includes(c),
);
