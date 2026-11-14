/**
 * «Forward only» — the stage a card belongs on when something wants it further down the funnel (SPEC-P2-v2 §3.2).
 * Pure and board-agnostic (leads and deals alike), the body `calcStageMove` (calc/intake-land.ts) always had,
 * lifted out unchanged so the AI's machine mover (`moveLeadByMachine`, crm/service.ts) asks the very same rule:
 *
 *   nothing wanted, or a wanted stage that is gone, inactive or not OPEN → leave the card where it is;
 *   no current stage → the wanted one;
 *   already there → nothing to do;
 *   otherwise the wanted one only when it lies FURTHER down by `sort_order` (the cargo-trigger rule, #392): a card
 *   further along is somebody's work in progress, and a machine dragging it backwards undoes a person's decision.
 *
 * It never looks at the CURRENT stage's kind or at the card's owner — the person path (a seller's own 🧮 that joins
 * a colleague's lead) moves exactly as it always did. The machine's own layer asks those on the locked row.
 */
export interface ForwardStage {
  id: string;
  sortOrder: number;
  kind: string;
  active: boolean;
}

export function forwardTarget(
  stages: readonly ForwardStage[],
  currentStageId: string | null,
  wantedId: string | null | undefined,
): string | null {
  if (!wantedId) return null;
  const target = stages.find((row) => row.id === wantedId);
  if (!target || !target.active || target.kind !== 'open') return null;
  if (!currentStageId) return target.id;
  if (currentStageId === target.id) return null;
  const current = stages.find((row) => row.id === currentStageId);
  return current && current.sortOrder < target.sortOrder ? target.id : null;
}

/**
 * The machine's own decision on a LOCKED lead (SPEC-P2-v2 §3.2, his item 4 ⭐): everything `forwardTarget` asks, and
 * three things the person path never asked —
 *
 *   the CURRENT stage is open: a won or lost stage the owner reordered before the target would otherwise be «moved
 *   forward», and the stage write clears `lost_reason` — a revived lead nobody revived (crm 1);
 *   the target lies strictly further down — `forwardTarget` already says so;
 *   the machine may touch the lead (`machineMayTouch` — its owner is nobody or the holder), decided by the caller
 *   and passed as `mayTouch`, so the rule has one home and this stays a table.
 *
 * Every refusal is a reason in words a test names; none is retried.
 */
export type MachineStageVerdict =
  | { move: true; stageId: string }
  | { move: false; reason: 'not_configured' | 'target_closed' | 'current_closed' | 'not_mine' | 'not_forward' };

export function machineStageVerdict(input: {
  stages: readonly ForwardStage[];
  currentStageId: string;
  wantedId: string | null | undefined;
  mayTouch: boolean;
}): MachineStageVerdict {
  if (!input.wantedId) return { move: false, reason: 'not_configured' };
  const target = input.stages.find((row) => row.id === input.wantedId);
  if (!target || !target.active || target.kind !== 'open') return { move: false, reason: 'target_closed' };
  const current = input.stages.find((row) => row.id === input.currentStageId);
  if (!current || current.kind !== 'open') return { move: false, reason: 'current_closed' };
  if (!input.mayTouch) return { move: false, reason: 'not_mine' };
  const to = forwardTarget(input.stages, input.currentStageId, input.wantedId);
  return to ? { move: true, stageId: to } : { move: false, reason: 'not_forward' };
}
