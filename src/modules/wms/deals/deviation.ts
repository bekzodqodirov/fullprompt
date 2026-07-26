/**
 * Quote versus reality — the one calculation this whole feature exists for.
 *
 * The owner's account of the problem: a client is quoted 200 USD for 1 m³ and
 * 100 kg; the cargo reaches the warehouse at 1.4 m³. If the sales manager
 * happens to notice, they re-price and call the client, who either agrees or
 * takes the cargo back. If nobody notices, it reaches Tashkent and there is an
 * argument about the price.
 *
 * Pure on purpose: no database, no clock, no formatting. The alert, the deal
 * card and the tests all call THIS function, so there is one definition of
 * "how far out are we" rather than three that drift (DECISIONS #166).
 */

export interface Quote {
  volumeM3: number | null;
  weightKg: number | null;
  amount: number | null;
}

export interface Reality {
  volumeM3: number;
  weightKg: number;
}

export interface Deviation {
  /** Signed percentages: +40 means the cargo came out 40 % bigger than quoted. */
  volumePct: number | null;
  weightPct: number | null;
  /** The measure that moved most, and by how much. */
  worstPct: number | null;
  driver: 'volume' | 'weight' | null;
  /** Is the gap big enough to be worth a message? */
  exceeds: boolean;
  /**
   * The quoted amount scaled by the driving measure — a STARTING POINT for the
   * conversation, never a price the system sets by itself. Deliberately not
   * written anywhere: only a human may change what a client is charged.
   */
  suggestedAmount: number | null;
  /** True when there is nothing to compare against — no quoted size at all. */
  incomparable: boolean;
}

/**
 * Is this gap worth sending somebody a message about?
 *
 * NOT the same question as "is it outside the threshold", and the difference
 * was found by a test rather than by review. Cargo that comes out BIGGER than
 * the quote is the owner's actual pain — the client is about to be charged
 * more than they agreed, and the argument happens in Tashkent. Cargo that has
 * come out SMALLER so far is, on an open job, almost always just the rest of
 * the shipment not having arrived yet: "half today, half tomorrow" is normal
 * here, as is "10 boxes sent, 9 arrived, 1 late". Alerting on that would send
 * a false alarm on every split shipment the company does, and a channel that
 * cries wolf weekly is one nobody reads by the second month.
 *
 * So the under-delivery half is shown on the deal card, where somebody is
 * already looking, and never pushed. The over-delivery half is pushed at once.
 */
export function worthAlerting(deviation: Deviation): boolean {
  return deviation.exceeds && deviation.worstPct !== null && deviation.worstPct > 0;
}

/** Percent change, or null when the baseline is missing or zero. */
function pct(quoted: number | null, actual: number): number | null {
  if (quoted === null || !Number.isFinite(quoted) || quoted <= 0) return null;
  return ((actual - quoted) / quoted) * 100;
}

export function compareQuote(quote: Quote, reality: Reality, thresholdPct: number): Deviation {
  const volumePct = pct(quote.volumeM3, reality.volumeM3);
  const weightPct = pct(quote.weightKg, reality.weightKg);

  // Whichever moved further from the quote decides, in EITHER direction.
  // Cargo that came out smaller matters as much as cargo that came out bigger:
  // the client who was charged for 1.4 m³ and shipped 1.0 m³ complains just as
  // loudly, and is right to.
  let worstPct: number | null = null;
  let driver: 'volume' | 'weight' | null = null;
  if (volumePct !== null && (weightPct === null || Math.abs(volumePct) >= Math.abs(weightPct))) {
    worstPct = volumePct;
    driver = 'volume';
  } else if (weightPct !== null) {
    worstPct = weightPct;
    driver = 'weight';
  }

  const incomparable = worstPct === null;
  const exceeds = worstPct !== null && Math.abs(worstPct) >= thresholdPct;

  const suggestedAmount =
    quote.amount !== null && worstPct !== null
      ? Math.round(quote.amount * (1 + worstPct / 100) * 100) / 100
      : null;

  return { volumePct, weightPct, worstPct, driver, exceeds, suggestedAmount, incomparable };
}

/**
 * How much of a deal's cargo is still not in the client's hands.
 *
 * This is the end condition for a deferred payment ("I'll pay when it is all
 * here"): the deferral expires by itself when this reaches zero, so nobody has
 * to remember to lift it. A LOST box is excluded rather than counted as
 * outstanding — it is never going to arrive, and leaving it in the denominator
 * would hold the deferral open for ever, which is precisely how a debt gate
 * quietly stops working.
 */
export const ARRIVED_BOX_STATUSES = ['ready_for_pickup', 'issued'] as const;
export const SETTLED_BOX_STATUSES = [...ARRIVED_BOX_STATUSES, 'lost', 'void'] as const;

export function allArrived(counts: { total: number; pending: number }): boolean {
  return counts.total > 0 && counts.pending === 0;
}
