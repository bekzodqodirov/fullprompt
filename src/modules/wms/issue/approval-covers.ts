/**
 * Does a recorded permission cover the question the counter is asking?
 *
 * One approval row answers BOTH questions a handover can raise (0104): a debt
 * — «at least as large as today's», the ceiling the decider saw — and cartons
 * with no price — «every one of them was in the snapshot the decider saw».
 * A debt that grew, or a carton that landed after the approval, is a new
 * question and needs a new answer (#376's rule, and its price twin).
 *
 * PURE and import-free: the issue screen (a client component) asks it to
 * decide whether «ruxsat berildi» is true of the SELECTED boxes, and the
 * server asks its SQL twin (`approvalCoversSql` in approvals.ts) when it
 * locks the row. The two are pinned to agree by the integration suite, so the
 * screen never shows «approved» for a press the server will refuse.
 */

export interface ApprovalSnapshot {
  status: string;
  expiresAt: string | Date | null;
  blockingDebtUsd: number;
  unpricedBoxIds: string[];
}

/** What the handover needs permission for: a debt (null = none) and the gated cartons. */
export interface ApprovalQuestion {
  debtUsd: number | null;
  boxIds: string[];
}

export function approvalCovers(a: ApprovalSnapshot, q: ApprovalQuestion, now: number = Date.now()): boolean {
  if (a.status !== 'approved') return false;
  if (!a.expiresAt || new Date(a.expiresAt).getTime() <= now) return false;
  if (q.debtUsd !== null && !(a.blockingDebtUsd >= q.debtUsd - 0.009)) return false;
  return q.boxIds.every((id) => a.unpricedBoxIds.includes(id));
}
