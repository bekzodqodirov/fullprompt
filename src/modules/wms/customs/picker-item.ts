import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequestItems } from '../../platform/db/schema';
import { isBazaBasis, type BazaBasis } from '../calc/pricing';
import { unitsForItem } from './import-baza';
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
  /**
   * The row's own figures, with the basis the VED chose (drafted, else
   * stored) — what `unitsForItem` reads. Round 2's heading list judges EACH
   * candidate by its own code's law over exactly these (regression-7): a
   * pick recodes the row, so the candidate's law is the one the save will
   * apply, never the heading's.
   */
  row: Parameters<typeof unitsForItem>[0];
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
      measureUnit: calcRequestItems.measureUnit,
      measureQty: calcRequestItems.measureQty,
      dutyUnit: calcGroups.dutyUnit,
    })
    .from(calcRequestItems)
    .leftJoin(calcGroups, eq(calcGroups.id, calcRequestItems.groupId))
    .where(eq(calcRequestItems.id, itemId))
    .limit(1);
  if (!item) return null;
  const code = (item.tnvedCode ?? '').trim();
  const qty = item.quantity === null ? null : Number(item.quantity);
  const kg = item.weightKg === null ? null : Number(item.weightKg);
  const m3 = item.volumeM3 === null ? null : Number(item.volumeM3);
  // The unit the row is priced in: what the VED just picked, else what is
  // stored — `saveTable`'s own fill asks the same question.
  const chosen = drafted ?? (isBazaBasis(item.bazaBasis) ? item.bazaBasis : null);
  const row = {
    quantity: qty,
    weightKg: kg,
    volumeM3: m3,
    bazaBasis: chosen,
    measureUnit: item.measureUnit,
    measureQty: item.measureQty === null ? null : Number(item.measureQty),
  };
  if (!code) {
    return { name: item.name, code: '', dutyUnit: item.dutyUnit, units: [], perPiece: null, perPieceKg: null, row };
  }

  // EVERY unit the row accepts ranks first, not only the first of them
  // (0125): ranking by `[0]` dropped the per-piece weight re-rank — his
  // «donada har bir tovarni og'irligiga qaraymiz» — on every advalor row
  // that states a weight, because kilograms come first there. Through the
  // ONE row → units mapping (K10), the save's and the pick's own.
  const units = unitsForItem(row, item.dutyUnit);
  const perPieceKg = qty !== null && qty > 0 && kg !== null && kg > 0 ? kg / qty : null;
  const perPiece = units.includes('dona') ? perPieceKg : null;
  return { name: item.name, code, dutyUnit: item.dutyUnit, units, perPiece, perPieceKg, row };
}
