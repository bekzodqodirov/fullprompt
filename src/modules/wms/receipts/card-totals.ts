/**
 * The prixod card's own arithmetic (docs/PRIXOD-KARTA.md §7.1, §7.3) — pure,
 * client-safe, and importing NOTHING: `lot-composition-fence.test.ts` lists
 * who may learn that a lot has a composition, and a card total is not one of
 * them. So the few lines of exact arithmetic it needs are its own.
 *
 * The card printed a lot's figures as the columns spell them, «250.000 kg ·
 * 1.2500 m³», and said nowhere how much the whole prixod holds: three lots
 * were three sums in the reader's head. Both answers live here.
 */

/** `receipt_lots.total_weight_kg` is numeric(…,3); `total_volume_m3` numeric(…,4). */
const KG_SCALE = 3;
const M3_SCALE = 4;

/**
 * A stored decimal → integer units at `scale`, by STRING arithmetic. Anything
 * that is not a plain non-negative decimal of at most `scale` places reads as
 * zero: a total must never be poisoned by one unreadable row.
 */
function units(raw: string | number | null | undefined, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(raw ?? '').trim());
  if (!match) return 0n;
  const frac = match[2] ?? '';
  if (frac.length > scale) return 0n;
  return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0') || '0');
}

/** Units → the column's own spelling: 600000 at scale 3 → '600.000'. */
function spell(value: bigint, scale: number): string {
  const base = 10n ** BigInt(scale);
  return `${value / base}.${(value % base).toString().padStart(scale, '0')}`;
}

/**
 * A stored measure without its trailing zeros: '250.000' → '250',
 * '1.2500' → '1.25', '2.1438' stays.
 *
 * TRIMMED, never rounded. The lot tarkibi must sum to these figures exactly,
 * so the card may drop only what carries no value. And the zeros were worse
 * than noise: `ru` is the default locale, where «250.000» reads as two
 * hundred and fifty THOUSAND.
 */
export function trimMeasure(raw: string | number | null | undefined): string {
  const text = String(raw ?? '').trim();
  // Anything that is not a plain decimal is printed as it came — the card
  // must never turn a value it cannot read into a zero.
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text === '' ? '0' : text;
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

export interface CardLot {
  boxCount: number;
  totalWeightKg: string | number | null;
  totalVolumeM3: string | number | null;
}

export interface CardTotals {
  lots: number;
  boxes: number;
  /** Trimmed, exact: the sum of the lots' own figures in integer units. */
  kg: string;
  m3: string;
}

/**
 * What the prixod holds, from the lots the page already read.
 *
 * Summed in the columns' integer units (grams, and tenths of a litre), the
 * tarkib's own arithmetic: `0.1 + 0.2` in floating point is not 0.3, and a
 * total that disagrees with its own rows in the fourth decimal is the one
 * figure on the card nobody could trust.
 */
export function receiptTotals(lots: readonly CardLot[]): CardTotals {
  let boxes = 0;
  let kg = 0n;
  let m3 = 0n;
  for (const lot of lots) {
    boxes += lot.boxCount;
    kg += units(lot.totalWeightKg, KG_SCALE);
    m3 += units(lot.totalVolumeM3, M3_SCALE);
  }
  return {
    lots: lots.length,
    boxes,
    kg: trimMeasure(spell(kg, KG_SCALE)),
    m3: trimMeasure(spell(m3, M3_SCALE)),
  };
}
