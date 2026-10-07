import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequestItems } from '../../platform/db/schema';
import { isBazaBasis, type BazaBasis } from '../calc/pricing';
import { unitsForRow } from './import-baza';
import type { ImportUnit } from './import-parse';

/**
 * The ONE read of «which row is the 📥 dialog about» — shared by the list
 * route and the statistics route, so the two can never disagree about the
 * row's units (#513).
 *
 * The name, the code, the count, the weight and the volume are read HERE,
 * off the SAVED row: a browser that could pass its own search terms would be
 * a free text search over the whole customs dump behind a calc-screen door.
 * The one word a browser may add is the basis the VED has CHOSEN on the
 * screen (drafted, not yet saved) — a validated enum that can only reorder
 * and label what this row's code already holds. Anything else typed and not
 * saved is invisible here, which is why the 📥 button waits on a dirty row.
 */
export interface PickerItem {
  name: string;
  /** '' when the row has no code — no question to ask the file. */
  code: string;
  dutyUnit: string | null;
  units: ImportUnit[];
  /** kg per piece, only when `units` includes dona — what the list ranks by. */
  perPiece: number | null;
  /** kg per piece whenever the row states both a count and a weight (D5):
   * the dona tab of the statistics exists for a kg-first row too. */
  perPieceKg: number | null;
}

export async function readPickerItem(
  itemId: string,
  drafted: BazaBasis | null,
): Promise<PickerItem | null> {
  const [item] = await db
    .select({
      name: calcRequestItems.name,
      tnvedCode: calcRequestItems.tnvedCode,
      quantity: calcRequestItems.quantity,
      weightKg: calcRequestItems.weightKg,
      volumeM3: calcRequestItems.volumeM3,
      bazaBasis: calcRequestItems.bazaBasis,
      dutyUnit: calcGroups.dutyUnit,
    })
    .from(calcRequestItems)
    .leftJoin(calcGroups, eq(calcGroups.id, calcRequestItems.groupId))
    .where(eq(calcRequestItems.id, itemId))
    .limit(1);
  if (!item) return null;
  const code = (item.tnvedCode ?? '').trim();
  if (!code) {
    return { name: item.name, code: '', dutyUnit: item.dutyUnit, units: [], perPiece: null, perPieceKg: null };
  }

  const qty = item.quantity === null ? null : Number(item.quantity);
  const kg = item.weightKg === null ? null : Number(item.weightKg);
  const m3 = item.volumeM3 === null ? null : Number(item.volumeM3);
  // The unit the row is priced in: what the VED just picked, else what is
  // stored — `saveTable`'s own fill asks the same question.
  const chosen = drafted ?? (isBazaBasis(item.bazaBasis) ? item.bazaBasis : null);
  // EVERY unit the row accepts ranks first, not only the first of them
  // (0125): ranking by `[0]` dropped the per-piece weight re-rank — his
  // «donada har bir tovarni og'irligiga qaraymiz» — on every advalor row
  // that states a weight, because kilograms come first there.
  const units = unitsForRow({
    dutyUnit: item.dutyUnit,
    chosen,
    hasWeight: kg !== null && kg > 0,
    hasQuantity: qty !== null && qty > 0,
    hasVolume: m3 !== null && m3 > 0,
  });
  const perPieceKg = qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;
  const perPiece = units.includes('dona') ? perPieceKg : null;
  return { name: item.name, code, dutyUnit: item.dutyUnit, units, perPiece, perPieceKg };
}
