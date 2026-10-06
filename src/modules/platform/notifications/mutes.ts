/**
 * Per-user Telegram mute settings (spec §11). Stored on users as a jsonb
 * list of event type names ('all' = everything). The profile UI exposes
 * them as a few understandable groups instead of an 11-row type matrix.
 */

export const MUTE_GROUPS = {
  // The warehouse svodka and the monthly «these clients have gone quiet»:
  // once a day, nothing is on fire, and someone who mutes one means both.
  digest: ['DailyDigest', 'CrmDormant'],
  // The morning call list has its OWN switch (owner's 4.3b, «alohida
  // o'chirish katagi bolsin»). It used to sit in `digest`, which meant
  // silencing it also silenced the warehouse summary — two different jobs'
  // messages behind one checkbox. It is also the one CRM message that
  // arrives every single working day, so it is the one somebody will want to
  // turn off on its own.
  // «Olib ketilmagan yuk» (0116) rides with it: the seller's morning «ring
  // these clients», about cargo instead of leads — not in `digest`, where a
  // seller who ticked «Kunlik svodka» to stop the monthly dormant list would
  // silently lose the feature's only message. A newcomer, so not a founder:
  // an old «calls» tick mutes it too.
  calls: ['CrmFollowUps', 'CargoWaiting'],
  // The advert lead (0113, the owner's 5a): the push a seller gets the moment
  // a lead is theirs, and the owner's «15 minutes and nobody has called».
  // A group of its OWN, not `calls`: whoever muted the morning call list holds
  // that group's founder, and folding these in would silently take new leads
  // away from exactly the sellers who wanted fewer morning messages.
  leads: ['InboundLeadArrived', 'InboundLeadUntouched'],
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
    // «Hisob tayyor» — the seal's own news (phase B). It shipped in NO group,
    // so the only way to silence it was to silence everything (round C's
    // scouts); it is the same family as «hisoblash tayyor».
    'CalcSealed',
    // «Bu prixodlar hisobingizga tegishlimi?» (0119) — a VED's own job, asked
    // with buttons. A newcomer, so never in FOUNDERS: a list that muted the
    // group before it existed must not start muting it by growing.
    'CalcLinkAsk',
    // The topshiriq round (docs/TELEGRAM-TOPSHIRIQ.md §7): what the people on
    // the two ends of a task tell each other through the bot — 👀 seen, ⏰
    // moved, 💬 a question and its answer, 🔔 a nudge, and «it was cancelled /
    // handed on». All newcomers, so NONE is a founder: somebody who muted
    // «vazifalar» before this round stays muted, and nobody's tick is read as
    // unticked because the group grew (round C).
    'TaskAccepted',
    'TaskRescheduled',
    'TaskQuestion',
    'TaskAnswer',
    'TaskReminder',
    'TaskCancelled',
    'TaskReassigned',
    // «GS777: narx qayta hisoblanmoqda — eski narx endi amal qilmaydi»
    // (docs/VED-TARIX.md §6) — the seller's own job, re-opened. A newcomer:
    // never in FOUNDERS.
    'CalcRecalc',
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
    // 0104: cargo with no price went out of the warehouse (by a tick or an
    // approval), and a truck finished loading with a price on cargo that
    // stayed behind — both are the accountant's to act on while the client
    // can still be billed.
    'UnpricedIssued',
    'PricedCargoLeft',
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
    // A counterparty's debt is due in three days, overdue, or at 80 % of the
    // limit we allow ourselves (0108). Money that must move before a firm
    // stops carrying our trucks — an alarm, not news.
    'PartnerDebtDue',
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
    // An office count found fewer cartons on a truck than it carried (0112,
    // the owner's Q6c). An alarm and not news: cargo is missing while the
    // truck is still at the gate. A newcomer, so never in FOUNDERS.
    'CountShortfall',
    // …and the other direction: a count went beyond the truck after the
    // accountant priced it, so the price no longer covers the cargo (review
    // money-4). The accountant's to act on while the client can be billed.
    'PricedCargoGrew',
    // 0105: a carton turned up on a prixod whose client was compensated for
    // it — the accountant and the seller must act before the cargo AND the
    // money leave. BoxLost's alarm, run backwards.
    'CompensatedCargoFound',
    'ReceiptMeasureCorrected',
    // A discount was written into a sealed price (phase D) — shipped in no
    // group, like CalcSealed; it moves money a seller is measured against.
    'CalcDiscounted',
    // A customer wrote to the BOT (round C). Until now those words went
    // nowhere at all; they are an alarm like ClientWaiting — only worth
    // anything while the customer is still waiting for an answer.
    'ClientBotMessage',
    // A client-cabinet link was refused or unverifiable (round C moves these
    // two Russian raw-fetch pings onto the drain, where they can be muted and
    // retried like every other staff message).
    'CabinetLinkAlert',
    // A debtor's payment promise passed unpaid (0114) — the call is due now,
    // while the client still remembers saying it. A newcomer: never in
    // FOUNDERS, so nobody's stored list is un-muted by it.
    'PaymentPromiseBroken',
  ],
  operations: [
    // A client's birthday (0109): a reminder to congratulate, not an alarm.
    'ClientBirthday',
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
    // A truck on the road now goes to another receiving warehouse (the
    // reroute round) — work news for the gate that will receive it and the
    // planners, beside the load and unload summaries; not an alarm. A
    // newcomer, so never in FOUNDERS: whoever muted «ish jarayoni» before
    // stays muted.
    'BatchRerouted',
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
  // The system watching itself (B9, 0115): a manager's Telegram bridge went
  // quiet and came back, and a disk crossed 80 / 90 %. A group of its OWN and
  // not `alerts`: `alerts` is muted by whoever holds its founders, and an admin
  // who silenced the price-control noise years ago must still hear that the
  // disk under the database is filling. Born with all three, so its founders
  // are its members.
  system: ['TelegramListenerQuiet', 'TelegramListenerBack', 'DiskFilling'],
  // The owner's evening summary (answer 7a, 2026-09-28) — its own switch on
  // /profile, drawn only for the person who receives it: silencing the
  // warehouse svodka is not silencing the company's day, and neither is a
  // reason to lose the other.
  owner: ['OwnerSummary'],
} as const;

export type MuteGroup = keyof typeof MUTE_GROUPS;

/**
 * The members each group has held CONTINUOUSLY since the day it was born —
 * read off this file's git history, not remembered. The profile is the only
 * writer of a stored list and it writes whole groups (`listFromGroups`), so
 * whoever ticked a group at ANY point in its life holds every one of these.
 *
 * That is the whole test for «this group was ticked», and it has to be this
 * set and no larger. Round C first judged a type against every other member of
 * its group — three newcomers at once meant each needed the other two, a list
 * nobody's checkbox ever wrote — and then against the members that had not
 * «joined later», which named round C's four newcomers and missed
 * `PartnerDebtDue`, added a day earlier: every production list predates it, so
 * every muted «alerts» box read back unticked and the next save un-muted all
 * of them (round C review, second pass). Groups have grown ~40 times since
 * 2026-07-24; a stored list can be from any of those days. `CalcOverdue` left
 * `alerts` on 2026-08-09 and came back on 08-22, so it is not here either.
 *
 * Never ADD a type to this map: a newcomer is exactly what old lists lack.
 * Remove one only together with removing it from its group (the unit fence
 * holds these to the groups).
 */
export const FOUNDERS: Readonly<Record<MuteGroup, readonly string[]>> = {
  digest: ['DailyDigest'],
  // Moved here from `digest` on 2026-09-19; every list that muted it did so
  // as part of `digest` before that, and still holds it.
  calls: ['CrmFollowUps'],
  // Born whole on 2026-09-28 with both members, so both are founders.
  leads: ['InboundLeadArrived', 'InboundLeadUntouched'],
  tasks: ['TasksDue'],
  alerts: ['BoxScannedOnLoad', 'UndocumentedTransfer', 'MissingInTransit'],
  operations: [
    'ReceiptConfirmed',
    'UnknownCargoReceived',
    'ReadyForPickup',
    'BoxIssued',
    'PlanApproved',
    'PlanChangesRequested',
    'InventoryCompleted',
  ],
  // Born whole on 2026-09-28 (0115), so every list that ever ticked it holds all three.
  system: ['TelegramListenerQuiet', 'TelegramListenerBack', 'DiskFilling'],
  // Born 2026-09-28 with its one member — its birth list, not an addition.
  owner: ['OwnerSummary'],
};

/**
 * Is this person silencing this type? By name, or because the list holds its
 * group's founders — so a type that JOINS a group after somebody ticked it
 * stays silenced for them, and growing a group never un-mutes it.
 */
export function isTelegramMuted(muted: unknown, type: string): boolean {
  if (!Array.isArray(muted)) return false;
  if (muted.includes('all') || muted.includes(type)) return true;
  for (const group of Object.keys(MUTE_GROUPS) as MuteGroup[]) {
    if (!(MUTE_GROUPS[group] as readonly string[]).includes(type)) continue;
    const founders = FOUNDERS[group];
    if (founders.length > 0 && founders.every((t) => muted.includes(t))) return true;
  }
  return false;
}

/**
 * Which groups are fully covered by the stored list (for checkbox state).
 * Asked through `isTelegramMuted`, so a group that grew reads back as ticked
 * — and the next save writes the newcomer into the list for good.
 */
export function groupsFromList(muted: unknown): { all: boolean; groups: Record<MuteGroup, boolean> } {
  const list = Array.isArray(muted) ? (muted as string[]) : [];
  const all = list.includes('all');
  const groups = Object.fromEntries(
    (Object.keys(MUTE_GROUPS) as MuteGroup[]).map((g) => [
      g,
      all || MUTE_GROUPS[g].every((t) => isTelegramMuted(list, t)),
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
