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

// Moved to `cost-sight.ts` (no database, so the unit tests load it) when the
// VED stopped seeing the kassa (Q19); re-exported so the old imports hold.
export { maySeeTillNames } from './cost-sight';
