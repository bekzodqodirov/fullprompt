/**
 * How a lot's cartons stand in crates on the stock screen — the PURE half
 * (owner, 2026-09-30, his «B»: «qolgan tovarlar spiskasi bilan birga turadi,
 * faqat ichini ko'radigan bo'ladi»).
 *
 * The table keeps its lot × warehouse row. A row whose cartons were packed
 * says so — «🧰 10 yashik», or «7 yashik + 30 📦» when part of the lot is
 * still loose — and opens to the crates themselves. The queries live in
 * `stock-crates.ts`; every decision about what those rows MEAN lives here,
 * with zero imports, so it can be tested without a database.
 *
 * The one real decision is the PLACE. The skladchi prints the Ostatka and
 * walks the shelf counting pieces, a crate being one piece (his answer 3:
 * «u 1 yashikni 1 dona deb hisoblaydi»). So each row carries its places:
 * loose cartons plus the crates it OWNS. A crate may hold cartons of several
 * lots of one client, and counted under every lot it touches it would be two
 * pieces on paper and one on the shelf — so exactly one row owns it: the lot
 * with the most cartons inside, then the lower letter, then the lot id. That
 * is the customs invoice's own rule for a pallet's place (`invoicePlaces`,
 * documents/ved-xlsx.ts), plus the lot-id tiebreak a screen needs to draw
 * the same answer twice.
 */

export interface CrateDims {
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: string | null;
}

/**
 * A crate's measured size against the goods inside it (round 107/109's rule,
 * lifted out of `mapCrateRows` so the truck card and the stock rows cannot
 * answer it differently).
 *
 * A dimension typed as 0 is storable (the crate EDIT path has no minimum), so
 * a non-positive measure is «unmeasured», never a permanent ⚠ against a 0 m³
 * box. The overflow compares the values AS PRINTED — kg to the integer, m³ to
 * two decimals — because a raw-float compare can flag ⚠ between two numbers
 * that print identically.
 */
export function crateMeasure(
  dims: CrateDims,
  kgRaw: number,
  m3Raw: number,
): { kg: number; m3: number; statedM3: number | null; statedKg: number | null; over: boolean } {
  const kg = Math.round(kgRaw);
  const m3 = Math.round(m3Raw * 100) / 100;
  const { lengthCm: l, widthCm: w, heightCm: h } = dims;
  const statedM3 =
    l && w && h && l > 0 && w > 0 && h > 0 ? Math.round(((l * w * h) / 1e6) * 100) / 100 : null;
  const measuredKg = dims.weightKg === null ? null : Number(dims.weightKg);
  const statedKg = measuredKg !== null && measuredKg > 0 ? Math.round(measuredKg) : null;
  return {
    kg,
    m3,
    statedM3,
    statedKg,
    over: (statedM3 !== null && m3 > statedM3) || (statedKg !== null && kg > statedKg),
  };
}

/** The key a stock row is known by: one lot at one warehouse. */
export function rowKey(lotId: string, warehouseId: string): string {
  return `${lotId}|${warehouseId}`;
}

/**
 * The carton numbers printed on the labels («Box 3 / 100»), folded into
 * runs — «1–10», «21–26, 30» — so ten cartons are one short line and not
 * ten chips. Duplicates and order are the input's problem only in theory:
 * the query hands them over sorted, and this sorts again rather than trust it.
 */
export function seqRanges(seqs: readonly number[]): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
    } else if (n !== (prev as number) + 1) {
      parts.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(', ');
}

/** One (crate, lot) group as the query returns it. */
export interface CratePart {
  crateId: string;
  code: string;
  kind: string;
  lotId: string;
  warehouseId: string;
  letter: string;
  /** The code the lot's cartons carry — marking first, as the table prints it. */
  lotCode: string;
  n: number;
  seqs: number[];
  kg: number;
  m3: number;
  dims: CrateDims;
}

/** The whole crate, whatever the search box narrowed the parts to. */
export interface CrateTotal {
  total: number;
  kg: number;
  m3: number;
}

export interface CrateInRow {
  id: string;
  code: string;
  kind: string;
  /** This row's cartons in the crate, and their numbers on the labels. */
  n: number;
  seqs: number[];
  /** True where this crate is counted as one place. */
  owned: boolean;
  /** The row that counts it, when that is not this one. */
  ownerCode: string | null;
  /** The crate's other contents — the other lots packed with this one. */
  others: { code: string; n: number }[];
  /** Present cartons in the whole crate. */
  total: number;
  /**
   * Cartons in the crate that no row of this result shows — a search matched
   * part of it. What makes «1/3» worth printing: a mixed crate with nothing
   * hidden already names its other contents line by line.
   */
  unseen: number;
  statedM3: number | null;
  statedKg: number | null;
  over: boolean;
}

export interface RowCrates {
  /** This row's cartons standing in a crate here. */
  crated: number;
  /** Crates this row counts as places. */
  owned: number;
  crates: CrateInRow[];
}

export interface CrateSummary {
  id: string;
  code: string;
  over: boolean;
}

/**
 * The parts, folded into what each row says.
 *
 * Ownership is decided over the parts it is GIVEN — the same filtered set the
 * rows and the Σ are counted from — so under a search that shows only one
 * lot of a mixed crate, that lot owns it and the crate is still one place.
 * The ⚠ is decided over the WHOLE crate (`totals`), because an overfull crate
 * does not stop being overfull when somebody searches one of its lots.
 */
export function groupCrates(
  parts: readonly CratePart[],
  totals?: ReadonlyMap<string, CrateTotal>,
): { byRow: Map<string, RowCrates>; crates: CrateSummary[] } {
  const byCrate = new Map<string, CratePart[]>();
  for (const part of parts) {
    const list = byCrate.get(part.crateId);
    if (list) list.push(part);
    else byCrate.set(part.crateId, [part]);
  }

  const byRow = new Map<string, RowCrates>();
  const summaries: CrateSummary[] = [];
  for (const [crateId, list] of byCrate) {
    const ranked = [...list].sort(
      (a, b) => b.n - a.n || a.letter.localeCompare(b.letter) || a.lotId.localeCompare(b.lotId),
    );
    const owner = ranked[0]!;
    const whole = totals?.get(crateId) ?? {
      total: list.reduce((sum, part) => sum + part.n, 0),
      kg: list.reduce((sum, part) => sum + part.kg, 0),
      m3: list.reduce((sum, part) => sum + part.m3, 0),
    };
    const measure = crateMeasure(owner.dims, whole.kg, whole.m3);
    summaries.push({ id: crateId, code: owner.code, over: measure.over });

    const shown = list.reduce((sum, part) => sum + part.n, 0);
    for (const part of ranked) {
      const key = rowKey(part.lotId, part.warehouseId);
      const row = byRow.get(key) ?? { crated: 0, owned: 0, crates: [] };
      const owned = part === owner;
      row.crated += part.n;
      if (owned) row.owned += 1;
      row.crates.push({
        id: crateId,
        code: part.code,
        kind: part.kind,
        n: part.n,
        seqs: part.seqs,
        owned,
        ownerCode: owned ? null : owner.lotCode,
        others: ranked
          .filter((other) => other !== part)
          .map((other) => ({ code: other.lotCode, n: other.n })),
        total: whole.total,
        unseen: Math.max(0, whole.total - shown),
        statedM3: measure.statedM3,
        statedKg: measure.statedKg,
        over: measure.over,
      });
      byRow.set(key, row);
    }
  }

  // Inside a row, an overfull crate comes first (round 109, his «ogohlantirish
  // spiskaning tepasida tursa»), then label order — the order the operator
  // finds them stacked, since codes are minted as they are built.
  for (const row of byRow.values()) {
    row.crates.sort((a, b) => Number(b.over) - Number(a.over) || a.code.localeCompare(b.code));
  }
  summaries.sort((a, b) => a.code.localeCompare(b.code));
  return { byRow, crates: summaries };
}

/**
 * How many pieces a row is on the shelf: its loose cartons plus the crates it
 * owns. A row with nothing crated is its carton count, as it always was.
 */
export function placesOf(boxes: number, row: RowCrates | undefined): number {
  if (!row) return boxes;
  return boxes - row.crated + row.owned;
}
