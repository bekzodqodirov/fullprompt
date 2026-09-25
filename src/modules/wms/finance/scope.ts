/**
 * Whose money a person may read.
 *
 * The owner, testing as a seller: «men sotuvchi accountidan kirdim va
 * financelar ko'rinib yotibti, menga boshqa clientlarning financi ko'rinyabti
 * — unga faqat o'zini ko'rinishi yetarli». He was right, and the hole was
 * exactly one permission wide: `sales_manager` holds `finance.view`, and
 * `/finance` ran an unscoped query, so every seller could read the whole
 * company's receivables — every client's charges, payments, balance, and the
 * total debt at the top.
 *
 * The rule here is not invented. `/my-clients` has scoped a seller to their
 * own book since it shipped, with the same predicate the CRM funnel uses, and
 * the seller's other two grants — `clients.view_own` and
 * `reports.own_clients` — say what was always intended. This states it once
 * so the three money screens cannot each answer it differently.
 *
 * Stated to the owner, because it is a real cost: 1,402 of his 1,692 clients
 * carry NO sales manager, so a seller sees only what has been ASSIGNED to
 * them. That is the deferred item CLAUDE.md has been carrying — «scoping
 * clients to their sales manager needs the 17 logins first, or it hides
 * nearly every client from sales» — and he has now answered it: hiding is the
 * point.
 */

export interface MoneyActor {
  id: string;
  permissions: Set<string>;
}

/**
 * Reads every client's money, or only their own book?
 *
 * `finance.manage` is the accountant and the owner — the people whose job IS
 * the whole ledger. `clients.manage` is the administrator of the client book.
 * A seller has neither, and gets their own clients.
 *
 * Deliberately NOT `finance.view`: that is the grant a seller holds, and
 * treating it as company-wide is the bug this file exists to end.
 */
export function seesAllMoney(actor: MoneyActor): boolean {
  return actor.permissions.has('finance.manage') || actor.permissions.has('clients.manage');
}

/**
 * The `sales_manager_id` a money query must filter on, or undefined for no
 * filter at all.
 *
 * Undefined and "this person's id" are the only two answers — there is no
 * third that means "everything" for a scoped person, which is the shape
 * `warehouseScope` settled on for the same reason (#199): a filter that can
 * silently become "no filter" fails in the permissive direction.
 */
export function moneyOwnerFilter(actor: MoneyActor): string | undefined {
  return seesAllMoney(actor) ? undefined : actor.id;
}

/**
 * The COMPANY's money — the kassa totals, the P&L and its plan, the
 * receivable in aggregate, the dollars at risk: the dashboard's money
 * blocks, the admin home's «Pul» card and the cargo-risk report. Law 4's key
 * `finance.reports` AND round 91's whole-ledger reader (audit A5: a seller's
 * `finance.view` must not open the company's receivable).
 *
 * ONE predicate for the three screens that each restated it (#513), and the
 * reason the VED sees none of them (owner's Q19, «kassa foyda zararni umuman
 * ko'rmasin»): he holds `finance.manage` and never `finance.reports`, which
 * `platform/rbac/money-sight.ts` makes the exemption — so whoever that rule
 * blinds fails this one by construction, and the role test says so.
 */
export function seesCompanyMoney(actor: MoneyActor): boolean {
  return seesAllMoney(actor) && actor.permissions.has('finance.reports');
}
