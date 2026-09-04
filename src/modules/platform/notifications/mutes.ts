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
  // The calc queue's three everyday messages ride here beside the task ones:
  // a calculation IS a task in this company, and somebody who silenced «work
  // was assigned / work is done» means these too. The late one is an alarm and
  // lives below.
  // `CalcPrefilled` is the machine's own answer to a job the person just
  // submitted — the same family, and somebody who silenced «work was
  // assigned / work is done» means this too.
  tasks: [
    'TasksDue',
    'TaskAssigned',
    'TaskDone',
    'CalcRequested',
    'CalcTaken',
    'CalcDone',
    'CalcReturned',
    'CalcPrefilled',
  ],
  // "Something is wrong, act now." The three price-control messages belong
  // here rather than in `operations`: cargo that arrived is routine, cargo
  // that arrived at a different size to the one the client was quoted is not,
  // and it is only worth anything while the cargo is still in China.
  alerts: [
    'BoxScannedOnLoad',
    'UndocumentedTransfer',
    'MissingInTransit',
    'UnquotedCargo',
    // Same alarm one step earlier: the deal exists, the receipt is not on it
    // (round 107) — muting one and not the other would make no sense.
    'UnlinkedCargo',
    'DealDeviation',
    'DealDeferralEnded',
    // A promise landed at a different size to the one the client stated.
    'ArrivalDiff',
    // A debtor is standing at the counter: the ask and the answer are both
    // only worth anything while they are still standing there.
    'DebtApprovalRequested',
    'DebtApprovalDecided',
    // Round 107: money already left the warehouse's pocket — entering it is
    // work waiting, and the reporter deserves the answer. Same pair shape.
    'ExpenseRequested',
    'ExpenseRequestDecided',
    // A calculation blew its 30–120 minute deadline (round 28) — told to the
    // waiting salesperson and the owner while chasing it still helps. The
    // entry left with the clock's doors in round 84 and comes back with them
    // (VED phase A); its comment sat here orphaned in between.
    'CalcOverdue',
    // A customer has been waiting for an answer past the threshold (round 36).
    // An alert, not a digest: it is only worth anything before they ring.
    'ClientWaiting',
    // Telegram ended a manager's session (round 49). Delivered by the BOT,
    // deliberately: the account that would normally carry it is the one that
    // just died. Nothing this person types can reach a customer until they
    // reconnect, so it is an alarm and not news.
    'TelegramSessionEnded',
    // A driver phone on an in-transit trip went quiet past the map's own
    // staleness threshold (round 55). Raised by the SERVER, deliberately:
    // every alarm the phone itself could raise dies with the app.
    'TruckSilent',
    // A seller has quoted BELOW the sealed floor and the promise is waiting
    // on somebody who may allow it (VED phase D, law 4). An alarm and not
    // news: nothing has been said to the customer yet, and until this is
    // answered the seller is standing in front of one.
    'CalcBelowFloor',
    // The three warehouse corrections (owner's five reports, 2026-08-25).
    // Alarms, not news: each one means the record and the floor disagreed —
    // a box recorded on a truck was found standing in a warehouse (told to
    // the truck's planners), a carton was written off with a reason (told to
    // the client's seller, whose compensation conversation it starts), and a
    // manager corrected a receipt's measures over its author's head (told to
    // the author, the arrival-diff rule).
    'BoxFoundHere',
    'BoxLost',
    'ReceiptMeasureCorrected',
  ],
  operations: [
    'ReceiptConfirmed',
    'UnknownCargoReceived',
    'ReadyForPickup',
    'BoxIssued',
    'PlanApproved',
    'PlanChangesRequested',
    'InventoryCompleted',
    // How a truck actually went (round 36) — routine news for the people who
    // plan them, so it belongs here beside the arrivals, not among the
    // alarms: a deviation worth shouting about already has its own alert.
    'LoadFinished',
    'UnloadFinished',
    // A colleague wrote on a card you are involved in.
    'InternalNote',
    // The personal half of the same message: a colleague named YOU with @.
    'MentionedInNote',
    // A colleague showed you one message a client sent (2026-08-11). It sits
    // beside the note and the mention because it is the same act — somebody
    // deciding you need to see something — and not an alarm: nothing is on
    // fire, a person is asking.
    'ChatMessageShared',
    // Phase 7: a rule somebody wrote pinged you — mutable like any other
    // routine workflow message; the rule's author is not above your mutes.
    'AutomationRule',
    // Once a month: the VED dictionaries hold rows nobody has revisited (VED
    // phase C). Housekeeping and not an alarm — nothing is wrong today, a
    // stale baza simply prices tomorrow's cargo on last winter's numbers.
    'CalcDictReview',
    // A seller turned a sealed price into a client offer — sent to that
    // seller alone as the text they forward, so it is news about their own
    // press and never an alert.
    'CalcOffer',
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
