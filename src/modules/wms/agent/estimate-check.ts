import { logger } from '../../platform/logger';
import { tashkentDay } from '../../platform/time/tashkent';
import { tariffFor } from '../calc/tariff-read';
import { readAgentConfig } from './config';
import { repriceAll, storedEstimatesOf, type Reprice } from './estimate';

/**
 * Do the figures a draft quoted still stand TODAY (spec SPEC-P1-v2 §1.3)? The stored estimates (`memory.estimates`)
 * priced again with the same function the tools priced them with (estimate.ts), on today's tariff and today's avia
 * rate — asked by the send step at every step (drafts `draftOfferStands`, in the listener), by his ✅ and by the
 * machine's press (auto-send `autoFactsFor`). A tariff edit or a new avia rate between the quote and the send never
 * lets the old figure out.
 *
 * null: nothing stored to price again — a draft that quoted nothing, or one written before the figures were kept
 * (today's behaviour at the send step and his ✅; the machine refuses such a priced draft `money`, §1.1). Never an
 * exception — this runs in the listener: a read that fails, or a stored row nobody can read, is a figure that
 * moved (`estimate_moved`), so nothing goes on a price nobody could check.
 */
export async function estimatesStand(raw: unknown, now: Date): Promise<Reprice | null> {
  if (raw === undefined || raw === null) return null;
  const stored = storedEstimatesOf(raw);
  if (stored === null) return 'estimate_moved';
  if (stored.length === 0) return null;
  try {
    const day = tashkentDay(now);
    const bands = stored.some((e) => e.tool === 'yolkira_estimate') ? await tariffFor(day) : [];
    const aviaRate = stored.some((e) => e.tool === 'avia_estimate') ? ((await readAgentConfig())?.aviaUsdPerKg ?? null) : null;
    return repriceAll(stored, { day, bands, aviaRate });
  } catch (err) {
    logger.warn({ err }, '[agent] estimate not re-priced — held as moved');
    return 'estimate_moved';
  }
}
