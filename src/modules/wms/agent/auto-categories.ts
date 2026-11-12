/**
 * The kinds of reply «o'zi yuborish» may ever open (docs/AI-SOTUVCHI.md §18.3)
 * — ONE home, read by the gate (`auto-gate.ts`), the writer of his choice
 * (`auto-send.ts setAutoCategories`) and the page's boxes (`agent-ui.tsx`, a
 * client file: it must not import the gate, which would pull the send step
 * into the browser bundle). Imports nothing. The 0146 CHECK says the same.
 *
 * `price` is the fifth since 0146 (spec §1.5, his Q1 ⭐): a reply whose only
 * money is the yo'lkira table's or his avia rate × the customer's kilos — the
 * gate's money clause decides that by OUTCOME, and only when he ticks it. Never
 * complaint or other. The calibration's measured list stays the four
 * (calibration.ts `AUTO_CATEGORIES`): price is gated, not measured.
 */
export const AUTO_SEND_CATEGORIES = ['greeting', 'qualification', 'faq', 'status', 'price'] as const;
export type AutoCategory = (typeof AUTO_SEND_CATEGORIES)[number];
