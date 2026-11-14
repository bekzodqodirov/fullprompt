import { AGENT_LIMITS } from './limits';

/**
 * How old the customer's line a reply answers may be (SPEC-P2-v2 K2) — ONE clock, asked at all five places that
 * decide it: the owner-triggered run (`runOwnerTriggered`, by its trigger), the eligibility rule
 * (`eligibleForRun`'s REQUIRED `anchorMaxAgeMs`), his ✅ on an agent-sourced lead's chat (`decideDraft`'s
 * `window_closed`), the send step (`SendFacts.anchorMaxAgeMs`) and the sweep's expiry (`anchorMaxAgeMsSqlText`, the
 * same rule in SQL — a unit test holds the two to one grid).
 *
 * A reply the OWNER's side started on a VED answer — his 💵 (a price draft carrying its request,
 * `policy.priceRequestId`) or the machine's VED-answer reply (`policy.calcAnswer = {requestId}`, written by a
 * `calc_answer` run) — may answer a line up to a WEEK old (his §7 Q9 ⭐ a): the VED's answer comes when it comes,
 * and «24 hours» cancelled a 💵 he typed two days after the request. Every other reply keeps the 24 hours.
 *
 * Imports only limits.ts: the listener's send step reads it.
 */

/** The two marks a stored draft carries — what the clock and the live head's forgiveness ask. */
export interface ClockedDraft {
  kind: string | null;
  policy: unknown;
}

function policyOf(d: ClockedDraft): Record<string, unknown> {
  return d.policy !== null && typeof d.policy === 'object' ? (d.policy as Record<string, unknown>) : {};
}

/** A reply a `calc_answer` run wrote on the VED's answer (`policy.calcAnswer = {requestId}`). */
export function isCalcAnswerDraft(d: ClockedDraft): boolean {
  const mark = policyOf(d).calcAnswer;
  return mark !== null && typeof mark === 'object' && typeof (mark as { requestId?: unknown }).requestId === 'string';
}

/**
 * The mark itself, to carry into a REWRITE of such a card (fix pass 4): his ✍️ answer's redraft and his 📝 lesson's
 * rewrite replace the VED answer's card, and keep its week (K2) and its forgiven head (K1) — the rewrite is still the
 * reply the VED's answer started. Null on any other draft.
 */
export function calcAnswerMarkOf(d: ClockedDraft): { requestId: string } | null {
  return isCalcAnswerDraft(d) ? { requestId: (policyOf(d).calcAnswer as { requestId: string }).requestId } : null;
}

/** His 💵: a price draft that names the request his figure answers (calc-loop `priceDraftFromText`). */
export function isPriceRequestDraft(d: ClockedDraft): boolean {
  return d.kind === 'price' && typeof policyOf(d).priceRequestId === 'string';
}

/** The anchor's maximum age for this stored draft, in ms. */
export function anchorMaxAgeMsFor(d: ClockedDraft): number {
  return isCalcAnswerDraft(d) || isPriceRequestDraft(d) ? AGENT_LIMITS.calcAnswerMaxAgeMs : AGENT_LIMITS.anchorMaxAgeMs;
}

/** The owner-triggered runs (run.ts `runOwnerTriggered`). */
export type OwnerTrigger = 'hand_back' | 'calc_answer' | 'owner_edit';

/** The anchor's maximum age for a run that has no draft yet — by what started it. */
export function anchorMaxAgeMsForTrigger(trigger: OwnerTrigger | 'inbound'): number {
  return trigger === 'calc_answer' ? AGENT_LIMITS.calcAnswerMaxAgeMs : AGENT_LIMITS.anchorMaxAgeMs;
}

/**
 * Was this reply started by the OWNER's side (K1)? His 💵 (kind `price`), the VED hand-back's question (kind
 * `hand_back`), or the machine's reply to a VED answer (`policy.calcAnswer`). Such a reply anchors on the customer's
 * newest INBOUND line, and our own earlier send after that line — the AI's «hisoblatishga yubordim, javob kelishi
 * bilan aytaman» — must not cancel it as «he answered himself». Every other reply keeps today's rule: two inbound
 * replies approved for one burst must not both go.
 */
export function ownerStartedDraft(d: ClockedDraft): boolean {
  return d.kind === 'price' || d.kind === 'hand_back' || isCalcAnswerDraft(d);
}

/**
 * The same clock as `anchorMaxAgeMsFor`, in SQL over a stored `agent_drafts` row under `alias` (the sweep's expiry,
 * a bulk UPDATE). A constant alias only — it is spliced into the statement.
 */
export function anchorMaxAgeMsSqlText(alias: 'd'): string {
  return (
    `(CASE WHEN jsonb_typeof(${alias}.policy -> 'calcAnswer' -> 'requestId') = 'string'` +
    ` OR (${alias}.kind = 'price' AND jsonb_typeof(${alias}.policy -> 'priceRequestId') = 'string')` +
    ` THEN ${AGENT_LIMITS.calcAnswerMaxAgeMs} ELSE ${AGENT_LIMITS.anchorMaxAgeMs} END)`
  );
}

/** «24 soatdan» / «7 kundan» — the age a refusal names, in the clock's own unit. */
export function anchorAgeWords(maxAgeMs: number): string {
  const day = 24 * 60 * 60_000;
  if (maxAgeMs % day === 0 && maxAgeMs > day) return `${maxAgeMs / day} kundan`;
  return `${Math.round(maxAgeMs / 3_600_000)} soatdan`;
}
