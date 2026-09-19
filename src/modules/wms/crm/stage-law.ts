/**
 * The one rule the funnel has about closing something, in the one place both
 * doors can ask it.
 *
 * «Yo'qotildi» is the only stage whose meaning is not on the board: won and
 * open say what happened, lost says only THAT it happened and the business
 * question is always why. So a move into a lost stage demands a written
 * reason, and a move back out clears the one it carried — a revived lead
 * still holding «narx qimmat» prints that in red above an open card.
 *
 * `moveLead`/`moveDeal` enforced both halves from the day they shipped, and
 * the ✏️ forms — which write `stage_id` through `updateLead`/`updateDeal`
 * and offer a `<select>` of every stage — enforced neither. That is the
 * shape #528 named as the source of nearly every live money bug: a PAIR RULE
 * enforced in one direction only. Here it is one function, and the form
 * passes NO reason, so the same law that lets the board through refuses the
 * form without a second condition being written anywhere.
 */

export type StageWrite =
  | { ok: true; lostReason: string | null }
  | { ok: false; reason: 'reason_required' };

/**
 * What `lost_reason` must become for a move to a stage of this kind, or the
 * refusal. The caller throws in its own vocabulary — the lead board and the
 * deal board spell the refusal differently on the wire and `useMoveErrors`
 * carries both spellings (#512), so translating an exception here would be a
 * third spelling nobody reads.
 *
 * Two characters, because a one-character reason is a keystroke rather than
 * an answer. `moveDeal` used to accept it; unifying on the stricter of the
 * two is the point of having one law.
 */
export function stageWrite(targetKind: string, typedReason?: string | null): StageWrite {
  if (targetKind !== 'lost') return { ok: true, lostReason: null };
  const clean = (typedReason ?? '').trim();
  if (clean.length < 2) return { ok: false, reason: 'reason_required' };
  return { ok: true, lostReason: clean };
}

/**
 * Whether a typed reason is one the owner's list allows (round 98, «yopilish
 * sababini listdan belgilaydigan qilishimiz kerak»). An EMPTY list means the
 * dictionary has not been set up and free text stays legal — day one must not
 * make losing a lead impossible. Non-empty, the reason must be one of the
 * listed labels: the pickers only offer those, so anything else is a forged
 * post, not a person's choice (#514's rule about URL params, on a form body).
 */
export function reasonAllowed(label: string, activeLabels: string[]): boolean {
  return activeLabels.length === 0 || activeLabels.includes(label);
}

/**
 * What `closed_at` must become when a card MOVES to a stage of this kind
 * (0076). Only on an actual move — an ordinary save of an already-closed
 * record keeps the stamp it has, which every caller already guarantees by
 * applying stage law only when the stage changed. A move between two closed
 * kinds (lost → won) re-stamps: it is a new decision.
 */
export function closedAtFor(targetKind: string, now: Date): Date | null {
  return targetKind === 'won' || targetKind === 'lost' ? now : null;
}

/**
 * The stages an edit FORM may offer.
 *
 * A screen must not offer what the service refuses — the person would press
 * Save and be told no by a form that put the option there. Lost stages are
 * dropped, because losing something belongs to the board's own dialog, which
 * asks why.
 *
 * The exception is the trap this function exists to avoid: a record ALREADY
 * in a lost stage keeps its own stage in the list. Drop it and the `<select>`
 * falls back to its first option, so opening the form to fix a phone number
 * and pressing Save would silently REVIVE the lead — a worse bug than the one
 * being fixed.
 */
export function formStages<T extends { id: string; kind: string }>(
  stages: T[],
  currentId: string | null | undefined,
): T[] {
  return stages.filter((stage) => stage.kind !== 'lost' || stage.id === currentId);
}

/**
 * The stages a LEAD form may offer (round 107). Won leaves the pickers too:
 * winning demands the convert dialog — a client and a deal — which no form
 * supplies, so offering it would be a Save the service refuses. Same
 * fall-back trap as above: the record's own stage always stays, or opening
 * the ✏️ on a won lead would silently move it.
 *
 * Deals deliberately keep `formStages`: a deal's won move needs no ceremony.
 */
export function leadFormStages<T extends { id: string; kind: string }>(
  stages: T[],
  currentId: string | null | undefined,
): T[] {
  return stages.filter((stage) => stage.kind === 'open' || stage.id === currentId);
}

/**
 * Does a stage change clear the follow-up date?
 *
 * The owner, on go-live day: «bosqichni o'zgartirgan zahoti avtomatik
 * tushsin — bugun qo'ng'iroq qildim deb hisoblansin». `moveLead` has done
 * that since round 102 — but the ✏️ FORM writes `stage_id` too, and it wrote
 * the date straight back, so a seller who moved a lead to «bog'lanildi» from
 * the card still found it on their day screen tomorrow. His item 4, first
 * sentence: «agar sotuvchi uni boglanildi etapiga otgazsa moy dendan chiqib
 * ketishi kerak». Same pair-rule shape as the lost reason above (#528) and
 * the same answer: one function, both doors.
 *
 * The EXCEPTION is what makes it safe to apply to a form. A board move posts
 * no date at all (`typedAt` undefined) and always clears. A form posts one,
 * and if the person typed a NEW date while changing the stage, that date is
 * their decision and outranks the rule — «ertaga ertalab qayta qo'ng'iroq»
 * is exactly the case, and silently deleting it would be the system
 * overruling a human being about their own day.
 */
export function clearsFollowUp(input: {
  /** Did the stage actually change? An ordinary save decides nothing. */
  moved: boolean;
  /** What the form posted, or `undefined` where there is no form. */
  typedAt?: string | null;
  /** What the record carries right now. */
  storedAt: string | null;
}): boolean {
  if (!input.moved) return false;
  if (input.typedAt === undefined) return true;
  return (input.typedAt || null) === (input.storedAt || null);
}
