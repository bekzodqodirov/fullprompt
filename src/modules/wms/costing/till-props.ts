import { listAccounts } from '../accounting/service';
import { mayPickTill } from '../accounting/till-door';

/**
 * The kassa options a cost form may offer this reader (0101): the open
 * kassas for a kassa holder, NOTHING for anybody else — the warehouse and
 * the logist type the cost, the accountant names the drawer (owner M2a).
 * Computed on the server so the select and the action cannot disagree.
 */
export async function tillOptionsFor(permissions: ReadonlySet<string>) {
  if (!mayPickTill(permissions)) return [];
  return (await listAccounts()).map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
}

/**
 * Whether a cost row may print the NAME of the kassa it was paid from: money
 * readers only. A warehouse operator reading a receipt's costs learns that a
 * kassa answered, never which drawer holds the company's cash.
 */
export function maySeeTillNames(permissions: ReadonlySet<string>): boolean {
  return (
    permissions.has('finance.view') || permissions.has('finance.manage') || permissions.has('finance.expenses')
  );
}
