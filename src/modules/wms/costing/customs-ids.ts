import { eq, inArray } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { costTypes, settings } from '../../platform/db/schema';
import { CUSTOMS_CODES_SETTING, parseCustomsCodes } from '../calc/customs-codes';

/**
 * The cost types that are «rastamojka» — the ONE list the calc control
 * already reads (`calc_customs_cost_type_codes`, parsed by
 * `calc/customs-codes.ts` for both readers; DATA because the owner mints his
 * own types), resolved to ids. On the caller's handle: the recompute asks it
 * from inside its own transaction, where a pool read is #714's freeze — so
 * the setting row is read directly and not through `getSetting`.
 *
 * A leaf (it moved out of `./service`, which re-exports it) so the freight
 * copy module can ask it without importing the service.
 */
export async function customsCostTypeIds(handle: Db | Tx = db): Promise<string[]> {
  const [row] = await handle
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, CUSTOMS_CODES_SETTING));
  const codes = parseCustomsCodes(row?.value);
  const types = await handle.select({ id: costTypes.id }).from(costTypes).where(inArray(costTypes.code, codes));
  return types.map((type) => type.id);
}
