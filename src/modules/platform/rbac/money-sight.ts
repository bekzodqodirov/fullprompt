/**
 * What the VED does not see (owner, 2026-09-25, Q19: «ved hodimi kassa foyda
 * zararni umuman ko'rmasin, tannarxni ham»). ONE function for every screen,
 * file, menu and the assistant (#513) — «umuman» is his word, so a surface
 * that restates the rule instead of asking it is the next leak.
 *
 * Identity is the `ved.docs` GRANT (#408), not the role code: a customs role
 * he invents on /admin/roles is covered the day it is ticked, and the bot's
 * and the search's actors carry no roles at all. The exemption is law 4's
 * key `finance.reports` (#790/#791) and NOT round 91's `seesAllMoney`, which
 * the VED passes through `finance.manage` — the owner, the admins and the
 * accountant keep everything. Anyone without `ved.docs` is untouched by
 * construction.
 *
 * Two kinds, and they nest (kassa ⇒ results):
 * - `results` — P&L, profit and margin anywhere, the landed cost (tannarx),
 *   a truck's full cost total and any per-unit cost, and the list of
 *   everybody's cost entries on a truck (the total one division away, #791).
 * - `kassa` — a till's balance, a drawer's name, a drawer picker, the
 *   «kassadan» fact. A VED who also holds `finance.expenses` (the kassa
 *   holders' grant, `accounting/till-door.ts`) keeps this one: he is then
 *   a kassa holder who happens to do customs.
 *
 * His follow-up «19 a» keeps client DEBTS open to him (the /finance list and
 * ledger, the bot's balance line), so debts are not a kind here.
 *
 * Zero imports: the pages, the actions, the client role card and the
 * platform assistant all ask it, and platform never imports wms.
 */
export type MoneySight = 'results' | 'kassa';

export interface Grants {
  has(code: string): boolean;
}

export function moneyHidden(kind: MoneySight, grants: Grants): boolean {
  if (!grants.has('ved.docs')) return false; // not the VED: nothing to say
  if (grants.has('finance.reports')) return false; // law 4's audience sees it all
  switch (kind) {
    case 'results':
      return true;
    case 'kassa':
      return !grants.has('finance.expenses');
    default: {
      const never: never = kind;
      return never;
    }
  }
}
