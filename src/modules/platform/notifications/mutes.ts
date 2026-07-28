/**
 * Per-user Telegram mute settings (spec §11). Stored on users as a jsonb
 * list of event type names ('all' = everything). The profile UI exposes
 * them as a few understandable groups instead of an 11-row type matrix.
 */

export const MUTE_GROUPS = {
  // The CRM digests belong here rather than in `operations`: they are the
  // same kind of "once a day, nothing is on fire" message as the warehouse
  // digest, and someone who mutes that means these too.
  digest: ['DailyDigest', 'CrmFollowUps', 'CrmDormant'],
  // A group of its own rather than folded into `digest`: someone silencing the
  // warehouse summary is not saying "stop telling me about the work I was
  // personally given", and that is the one message nobody should lose by
  // accident.
  // TaskAssigned/TaskDone are the instant halves of the same story the
  // morning digest tells; someone silencing one means all of it.
  tasks: ['TasksDue', 'TaskAssigned', 'TaskDone'],
  // "Something is wrong, act now." The three price-control messages belong
  // here rather than in `operations`: cargo that arrived is routine, cargo
  // that arrived at a different size to the one the client was quoted is not,
  // and it is only worth anything while the cargo is still in China.
  alerts: [
    'BoxScannedOnLoad',
    'UndocumentedTransfer',
    'MissingInTransit',
    'UnquotedCargo',
    'DealDeviation',
    'DealDeferralEnded',
  ],
  operations: [
    'ReceiptConfirmed',
    'UnknownCargoReceived',
    'ReadyForPickup',
    'BoxIssued',
    'PlanApproved',
    'PlanChangesRequested',
    'InventoryCompleted',
    // A colleague wrote on a card you are involved in.
    'InternalNote',
  ],
} as const;

export type MuteGroup = keyof typeof MUTE_GROUPS;

export function isTelegramMuted(muted: unknown, type: string): boolean {
  if (!Array.isArray(muted)) return false;
  return muted.includes('all') || muted.includes(type);
}

/** Which groups are fully covered by the stored list (for checkbox state). */
export function groupsFromList(muted: unknown): { all: boolean; groups: Record<MuteGroup, boolean> } {
  const list = Array.isArray(muted) ? (muted as string[]) : [];
  const all = list.includes('all');
  const groups = Object.fromEntries(
    (Object.keys(MUTE_GROUPS) as MuteGroup[]).map((g) => [
      g,
      all || MUTE_GROUPS[g].every((t) => list.includes(t)),
    ]),
  ) as Record<MuteGroup, boolean>;
  return { all, groups };
}

/** Build the stored list from the profile form's group checkboxes. */
export function listFromGroups(all: boolean, groups: Record<MuteGroup, boolean>): string[] {
  if (all) return ['all'];
  const list: string[] = [];
  for (const g of Object.keys(MUTE_GROUPS) as MuteGroup[]) {
    if (groups[g]) list.push(...MUTE_GROUPS[g]);
  }
  return list;
}
