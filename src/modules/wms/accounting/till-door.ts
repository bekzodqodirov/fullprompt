/**
 * Who may name the KASSA money left from (0101, owner 3b + M2a): the
 * accountant and the admin, i.e. `finance.expenses` — the kassa screens' own
 * door. ONE predicate, asked by every door that writes a kassa onto a cost
 * (the cost form, the grid, the place-later queue, the merge) and by the
 * void of a cost that carries one: voiding it puts the money BACK into the
 * till, and the void is otherwise open to the warehouse and the logist
 * (`costs.enter_*`), who hold no finance grant at all.
 *
 * Zero imports: the pages compute the props with it and the actions refuse
 * with it, and the two must not disagree (#513).
 */
export const TILL_PERMISSION = 'finance.expenses';

export function mayPickTill(permissions: ReadonlySet<string>): boolean {
  return permissions.has(TILL_PERMISSION);
}
