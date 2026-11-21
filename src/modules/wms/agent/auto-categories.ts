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

/** The three boxes he ticks, read once: a table price («Narx»), a VED price («VED narxi»), a calculation («Hisoblatish»). */
export interface AutoTicks {
  table: boolean;
  ved: boolean;
  calc: boolean;
}

export function autoTicksOf(categories: readonly string[]): AutoTicks {
  return { table: categories.includes('price'), ved: categories.includes('calc_price'), calc: categories.includes('calc') };
}

/**
 * His three ticks as ONE key — the one words source of «what waits on its card and what stays his» (the independent
 * check of the seam fixes, F3): the page's numbers line and arming confirm select on it (`agentAi.autoNumbers`,
 * `autoNumbersNoCap`, `autoArmConfirm`, an ICU `select` over these eight) and the bot's arming words are keyed by it
 * (bot-door `autoArmedWords`). Each ticked box waits the layer's hold with ⏸ (the gate's `holdSecFor`: every class but
 * talk); each unticked price stays his. A price is two boxes — the table's (with his avia rate) and the VED's — and
 * the key keeps them apart: one key for «a price» told him, with only «VED narxi» ticked, that a price waits and only a
 * complaint stays his, while the gate kept the table price his (and the page's hint said a price goes only under
 * «Narx»). With no price box ticked no price goes by itself at all, so no price hold is said (review D3, the merged-tree
 * seam review's finding 5). `prices` = both price boxes, `all` = both and the calculation.
 */
export const AUTO_WAITS = ['none', 'table', 'ved', 'prices', 'calc', 'table_calc', 'ved_calc', 'all'] as const;
export type AutoWaits = (typeof AUTO_WAITS)[number];

export function autoWaitsOf(categories: readonly string[]): AutoWaits {
  return autoWaitsKey(autoTicksOf(categories));
}

/** The key of three ticks — `autoTicksOfWaits`'s inverse. */
export function autoWaitsKey(t: AutoTicks): AutoWaits {
  const price = t.table && t.ved ? 'prices' : t.table ? 'table' : t.ved ? 'ved' : null;
  if (!t.calc) return price ?? 'none';
  return price === null ? 'calc' : price === 'prices' ? 'all' : (`${price}_calc` as const);
}

/** The ticks a key stands for — so a reader handed the key alone says what it says, never more. */
export function autoTicksOfWaits(w: AutoWaits): AutoTicks {
  return {
    table: w === 'table' || w === 'prices' || w === 'table_calc' || w === 'all',
    ved: w === 'ved' || w === 'prices' || w === 'ved_calc' || w === 'all',
    calc: w === 'calc' || w === 'table_calc' || w === 'ved_calc' || w === 'all',
  };
}
