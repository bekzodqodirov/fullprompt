/**
 * «Sanab yuklash» — the arithmetic of one office count press, with nothing
 * imported (0112, the owner's Q1-Q7). The service reads the lot's cartons
 * under their row locks, hands them here, and does exactly what this says;
 * the unit test proves the rules on plain arrays.
 *
 * The number the office types is the lot's TOTAL on this truck — cartons a
 * phone already scanned included (his Q1 = b). So the press moves the
 * difference: up from the truck's own reservation first, then from the lot's
 * loose stock at the origin, then — when the prixod listed fewer cartons than
 * are physically there — by growing the lot (his Q3 = b). Down, it takes the
 * office's own cartons off before a phone's, the ones beyond the plan before
 * the planned ones, each in the reverse of the order it went on.
 *
 * The state after typing N depends on N and the plan, never on the order of
 * earlier presses: a double press, two tabs and a dial down-and-up all land
 * on the same cartons.
 */

export type CountRowStatus = 'planned' | 'loading' | 'in_stock' | 'ready_for_pickup';

export interface CountRow {
  id: string;
  shortCode: string;
  seq: number;
  status: CountRowStatus;
  /** The carton points at THIS truck (reserved or aboard). */
  onTruck: boolean;
  /** Carries the `added_on_spot` flag: it rode beyond the plan. */
  over: boolean;
  /** Its latest load event on this truck is the office's count. */
  byCount: boolean;
  /** A stickerless carton — preferred when the office picks from the shelf. */
  qrless: boolean;
  /**
   * Where it stood before this truck took it, for the way back — the
   * service reads `shelfBeforeSql`, the one rule every give-back asks.
   */
  loadedFrom: string | null;
  /**
   * Minted into the lot by a count press on THIS truck and never labelled:
   * taking it off does not send it to a shelf — it never existed — it is
   * voided and the lot shrinks (review money-3).
   */
  grown: boolean;
}

export type CountRefusal =
  | { kind: 'refuse'; code: 'over_reason_required'; plan: number | null; stock: number }
  | { kind: 'refuse'; code: 'grow_too_many'; max: number };

export interface CountMove {
  kind: 'move';
  /** Aboard before the press, and the number asked for. */
  aboard: number;
  target: number;
  plan: number | null;
  /** Aboard through a phone's scan, not the office's count. */
  phoneScanned: number;
  /** Reserved on this truck → loaded plain. */
  load: CountRow[];
  /** From the shelf, reserved back onto the truck (within the plan) → loaded plain. */
  reReserve: CountRow[];
  /** A quick truck has no plan: from the shelf, loaded plain. */
  loadSpare: CountRow[];
  /** From the shelf beyond the plan → loaded with the ⚠ mark. */
  loadOver: CountRow[];
  /** Cartons the prixod never listed: minted into the lot, loaded with the ⚠ mark. */
  grow: number;
  /** Taken off, the truck's reservation kept. */
  backToPlan: CountRow[];
  /** Taken off, back to the shelf they came from. */
  backToShelf: CountRow[];
  /** Taken off and taken back out of the prixod — the inverse of `grow`. */
  shrink: CountRow[];
}

export type CountPlan = CountRefusal | CountMove;

export interface CountPlanOpts {
  hasPlan: boolean;
  /** The approved plan's loose number for this lot (0 when the lot is not on it). */
  planN: number;
  overReason: string | null | undefined;
  /** How many cartons ONE press may add to a prixod. */
  growMax: number;
}

/** Stickerless first — the labelled ones can still be scanned onto a later truck — then the lowest sequence. */
function shelfOrder(a: CountRow, b: CountRow): number {
  if (a.qrless !== b.qrless) return a.qrless ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * What comes off first: the office's own cartons before a phone's (his
 * Q1 = b — a phone's scan is a witness, the office's number is a claim),
 * then the ones going back to the SHELF (beyond the plan, or anything on a
 * quick truck) before the planned ones, each in the exact reverse of the
 * order it went on — so dialling 5 → 2 lands where typing 2 lands.
 */
function offOrder(hasPlan: boolean) {
  return (a: CountRow, b: CountRow): number => {
    // The prixod's own growth went on LAST, so it comes off first: a dial up
    // past the stock and back lands on the lot it started from.
    if (a.grown !== b.grown) return a.grown ? -1 : 1;
    if (a.byCount !== b.byCount) return a.byCount ? -1 : 1;
    const homeA = !hasPlan || a.over;
    const homeB = !hasPlan || b.over;
    if (homeA !== homeB) return homeA ? -1 : 1;
    return homeA ? shelfOrder(b, a) : b.seq - a.seq;
  };
}

export function planCountMove(rows: readonly CountRow[], target: number, o: CountPlanOpts): CountPlan {
  const aboard = rows.filter((r) => r.onTruck && r.status === 'loading');
  const phoneScanned = aboard.filter((r) => !r.byCount).length;
  const reserved = rows
    .filter((r) => r.onTruck && r.status === 'planned')
    .sort((a, b) => a.seq - b.seq);
  const shelf = rows
    .filter((r) => !r.onTruck && (r.status === 'in_stock' || r.status === 'ready_for_pickup'))
    .sort(shelfOrder);
  const plan = o.hasPlan ? o.planN : null;
  const move: CountMove = {
    kind: 'move',
    aboard: aboard.length,
    target,
    plan,
    phoneScanned,
    load: [],
    reReserve: [],
    loadSpare: [],
    loadOver: [],
    grow: 0,
    backToPlan: [],
    backToShelf: [],
    shrink: [],
  };

  if (target > aboard.length) {
    const need = target - aboard.length;
    if (o.hasPlan) {
      // The reservation IS the plan: those cartons always load plain.
      move.load = reserved.slice(0, need);
      // Cartons the plan counted but «yuklash tugadi» or a removal gave back
      // to the shelf are reserved again first — «52 instead of 50» is
      // measured against the PLAN, not against what happens to be reserved.
      const aboardPlain = aboard.filter((r) => !r.over).length;
      const room = Math.max(0, o.planN - aboardPlain - move.load.length);
      // Either shelf status, as plan approval itself reserves: a truck from
      // Andijan is planned out of `ready_for_pickup` cargo. Review cargo-6 kept
      // those off the plan because «yuklash tugadi» and a cancel gave every
      // carton back `in_stock` — off every «tayyor» list at a collection
      // warehouse; they give it back as it stood now (`shelfBefore`), so a
      // carton the plan counted is a carton the plan counted, with no ⚠.
      move.reReserve = shelf.slice(0, Math.min(need - move.load.length, room));
      const reReserved = new Set(move.reReserve.map((r) => r.id));
      const rest = need - move.load.length - move.reReserve.length;
      move.loadOver = shelf.filter((r) => !reReserved.has(r.id)).slice(0, rest);
      move.grow = rest - move.loadOver.length;
    } else {
      move.loadSpare = shelf.slice(0, need);
      move.grow = need - move.loadSpare.length;
    }
    if (move.grow > o.growMax) return { kind: 'refuse', code: 'grow_too_many', max: o.growMax };
    const deviates = move.loadOver.length + move.grow > 0;
    if (deviates && (o.overReason?.trim().length ?? 0) < 3) {
      return {
        kind: 'refuse',
        code: 'over_reason_required',
        plan,
        stock: aboard.length + reserved.length + shelf.length,
      };
    }
    return move;
  }

  if (target < aboard.length) {
    const off = [...aboard].sort(offOrder(o.hasPlan)).slice(0, aboard.length - target);
    for (const row of off) {
      // A planned carton keeps its place on the plan; one beyond the plan —
      // and anything on a quick truck, which reserves nothing — goes home;
      // one the count itself minted goes back out of the prixod.
      if (row.grown) move.shrink.push(row);
      else if (o.hasPlan && !row.over) move.backToPlan.push(row);
      else move.backToShelf.push(row);
    }
  }
  return move;
}

/** What a carton taken off goes back to: where it stood before this truck, or the shelf. */
export function shelfStatus(loadedFrom: string | null): 'in_stock' | 'ready_for_pickup' {
  return loadedFrom === 'ready_for_pickup' ? 'ready_for_pickup' : 'in_stock';
}
