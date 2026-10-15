/**
 * Who may read «hisob vs haqiqat» (VED phase E1).
 *
 * A THIRD door, and deliberately not one of the two that already exist,
 * because it answers a third question. The screen is a pure COST breakdown —
 * what we quoted the state for customs against what we actually paid — and
 * carries no client price at all, so:
 *
 *   - It is **not** `upsaleScopeFor`. That one answers `'none'` for the
 *     `ved_manager` (no `finance.reports`), which is right for a screen
 *     carrying a client price and exactly wrong here: the VED is the person
 *     being measured and the one who has to see the number to act on it. And
 *     it answers `'own'` for every `sales_manager` (they hold `crm.leads`),
 *     which would put the company's landed customs costs on a seller's
 *     screen — law 10 says sellers read prices, never the cost breakdown.
 *   - It is **not** round 91's `seesAllMoney` either: that is
 *     `finance.manage || clients.manage`, which admits the VED to everybody's
 *     row rather than their own.
 *
 * No new permission code (#170), so the audience is a property of the matrix
 * the owner edits on /admin/roles — which is why the test enumerates every
 * seeded role instead of asserting the predicate's shape.
 */
export type CalcControlScope =
  /** Owner, admins, accountant: every calculation in the company. */
  | 'all'
  /** The VED: the calculations they sealed themselves. */
  | 'own'
  /** Everybody else, sellers included. */
  | 'none';

export function calcControlScopeFor(actor: {
  permissions: { has(code: string): boolean };
}): CalcControlScope {
  if (actor.permissions.has('finance.reports')) return 'all';
  if (actor.permissions.has('ved.docs')) return 'own';
  return 'none';
}

/**
 * Who may read the registry of SEALED calculations (`/hisoblash/tarix`).
 *
 * The owner's answer 2A: himself, the accountant and the VED people — and NOT
 * the sellers, because every figure on that screen is a FLOOR (law 4).
 *
 * A BOOLEAN and not a reuse of `calcControlScopeFor`, on purpose. That one's
 * `'own'` means «the calculations you sealed yourself», which is right for a
 * screen that MEASURES the person and wrong for a history: a VED pricing a
 * Guangzhou→Tashkent podklyuch needs the company's last answer on that route,
 * not their own. And it adds no read a `ved.docs` holder does not already
 * have — `quoteHistoryFor` on /hisoblash/narxlar is company-wide by code —
 * it adds a way to FIND it.
 */
export function mayReadCalcRegistry(actor: {
  permissions: { has(code: string): boolean };
}): boolean {
  return actor.permissions.has('finance.reports') || actor.permissions.has('ved.docs');
}

declare const CALC_REGISTRY: unique symbol;

/**
 * The proof that a render asked `mayReadCalcRegistry` (0119) — `companyMoneySight`'s
 * shape. A deal's calculation sheet (every figure on it a FLOOR, law 4) is
 * loaded and drawn only with one of these in hand, and the only way to hold
 * one is to ask the predicate: a sheet mounted on a seller's screen is a
 * compile error that names itself, not a leak found later.
 */
export type CalcRegistrySight = { readonly [CALC_REGISTRY]: true };

const REGISTRY_SIGHT = Object.freeze({}) as CalcRegistrySight;

/** The ONE mint. Null for everybody `mayReadCalcRegistry` refuses. */
export function calcRegistrySight(actor: {
  permissions: { has(code: string): boolean };
}): CalcRegistrySight | null {
  return mayReadCalcRegistry(actor) ? REGISTRY_SIGHT : null;
}

/**
 * Who reads the VED's INTERNAL note on a Готово answer (the owner's 9a, «ichki
 * ved uchun ozining izoxi … VED va rahbar»).
 *
 * `ved.docs` and nothing wider — held by the VED, the admins and the owner.
 * NARROWER than the registry's own door on purpose (review access-money-10):
 * the accountant reads the history and the deal's calculation sheet through
 * `mayReadCalcRegistry`, and the note is «how I got the figure», which 9a
 * keeps between the calculators and leadership. The accountant is the
 * behavioural test's case that must NOT see it.
 */
export function mayReadCalcInternalNote(actor: {
  permissions: { has(code: string): boolean };
}): boolean {
  return actor.permissions.has('ved.docs');
}

declare const INTERNAL_NOTE: unique symbol;

/**
 * The proof that a read asked `mayReadCalcInternalNote` — `CalcRegistrySight`'s
 * shape. The registry and the request detail SELECT the column only with one
 * of these in hand (the SQL names `NULL` otherwise), so the accountant's
 * screen is not merely spared the note — its query never fetched it.
 */
export type InternalNoteSight = { readonly [INTERNAL_NOTE]: true };

const NOTE_SIGHT = Object.freeze({}) as InternalNoteSight;

/** The ONE mint. Null for everybody `mayReadCalcInternalNote` refuses. */
export function internalNoteSight(actor: {
  permissions: { has(code: string): boolean };
}): InternalNoteSight | null {
  return mayReadCalcInternalNote(actor) ? NOTE_SIGHT : null;
}

/**
 * The nazorat page's READS (the owner's 12a, «ved hodimlari bir birini … ishini
 * korish imkoniyati»), split from the WRITE scope above (review
 * access-money-6, ved-correctness-3).
 *
 * `calcControlScopeFor` keeps its name and its value for its six callers —
 * the link ✅/❌, `assertMine`, the home count, the bot's link ask, the prixod
 * card's picker and the pricing page — because confirming a link SCORES the
 * colleague it measures, and that stays the sealer's own. This one widens the
 * lists only: a VED reads everybody's measurements, and the screen draws
 * buttons on his own rows alone.
 */
export function calcControlReadScopeFor(actor: {
  permissions: { has(code: string): boolean };
}): 'all' | 'none' {
  if (actor.permissions.has('finance.reports')) return 'all';
  if (actor.permissions.has('ved.docs')) return 'all';
  return 'none';
}
