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
  return SEES_ALL_MONEY_GRANTS.some((code) => actor.permissions.has(code));
}

/**
 * The grants that make a person's money view the whole company — the list
 * `seesAllMoney` asks, exported so a reader that cannot hold a whole actor
 * (the approval ping's recipient filter, which resolves holders from the
 * editable grants) asks the SAME list and not a copy of it.
 */
export const SEES_ALL_MONEY_GRANTS = ['finance.manage', 'clients.manage'] as const;

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
 * Does this person read client LEDGERS at all — `/finance` and the first of
 * `/finance/<id>`'s two questions?
 *
 * Asked BEFORE the client is looked up, on purpose: it does not depend on
 * which client, so refusing here says nothing about whether one exists. A
 * seller's `finance.view` passes it; WHICH ledgers is `ownsLedger`'s answer.
 */
export function mayReadLedgers(actor: MoneyActor): boolean {
  return actor.permissions.has('finance.view') || actor.permissions.has('finance.manage');
}

/**
 * Is this client's money in the reader's book? Everybody's for a whole-ledger
 * reader, a seller's own clients otherwise — `moneyOwnerFilter`'s answer
 * applied to one row, so there is still exactly one list of the grants that
 * see everything. «No filter» is the only answer that admits a stranger's
 * client; an owner id that happens to be falsy is still a filter.
 */
export function ownsLedger(actor: MoneyActor, client: { salesManagerId: string | null }): boolean {
  const owner = moneyOwnerFilter(actor);
  return owner === undefined || client.salesManagerId === owner;
}

/**
 * The client card's «Pul» tab: the ledger page's two questions in one.
 *
 * Also the question every CARD asks before it prints this client's money —
 * the cargo block's sums, the lenta's money rows and the tab's badge — which
 * is what «who sees money does not change» (the owner's 4a) means: a figure
 * reaches exactly the people the ledger it comes from would admit.
 *
 * The ledger PAGE does not call this: it asks `mayReadLedgers` before its
 * lookup (else a redirect) and `ownsLedger` after it (else a 404), because a
 * single check after the lookup would answer a seller whether the client
 * exists — a redirect for somebody else's, a 404 for nobody's.
 */
export function mayOpenClientLedger(actor: MoneyActor, client: { salesManagerId: string | null }): boolean {
  return mayReadLedgers(actor) && ownsLedger(actor, client);
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

declare const COMPANY_MONEY: unique symbol;

/**
 * The proof that this render asked `seesCompanyMoney` — every money card on
 * the dashboard takes one as a REQUIRED prop (round B, judge O6).
 *
 * The money-reader fence reads imports, so a card exported from an
 * allow-listed section file and mounted outside the page's `money` gate
 * passed it: the file was allowed, the new card was not. A branded value
 * cannot be written by hand — the only way to hold one is to ask the
 * predicate — so a money card mounted without the gate is a compile error
 * that names itself, not a leak somebody finds on the VED's screen.
 */
export type CompanyMoneySight = { readonly [COMPANY_MONEY]: true };

const SIGHT = Object.freeze({}) as CompanyMoneySight;

/**
 * The ONE mint. Null for everybody the predicate refuses; a single frozen
 * value otherwise, so it can be handed to `cache()`d loaders without
 * changing their identity.
 */
export function companyMoneySight(actor: MoneyActor): CompanyMoneySight | null {
  return seesCompanyMoney(actor) ? SIGHT : null;
}
