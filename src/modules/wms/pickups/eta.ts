import { pickupPosition, pickupTimeline, type PickupTimeline } from '../tracking/pickup-route';

/**
 * How much longer than the router's estimate the truck may reasonably take.
 * An ASSUMPTION to calibrate against the first real trips, not the owner's
 * number: the legs are a public router's car time stretched for a lorry
 * (LORRY_FACTOR), and loading at a factory is guessed (DWELL_HOURS).
 */
export const ETA_SPREAD = 1.5;

/**
 * The arrival as a RANGE, never one date — a single figure from an
 * uncalibrated factor is a promise nobody made. Internal only: the client's
 * message deliberately carries no date at all.
 */
export function etaRange(timeline: PickupTimeline, etaAt: number): { from: number; to: number } | null {
  if (timeline.startedAt === null) return null;
  const span = Math.max(0, etaAt - timeline.startedAt);
  return { from: etaAt, to: timeline.startedAt + span * ETA_SPREAD };
}

/**
 * The card's estimate from its stops: where the truck should be and the
 * arrival range. One function for the card, so the page does not restate
 * how a stop becomes a timeline input.
 */
export function pickupEstimate(
  stops: {
    factory: { lat: string | null; lon: string | null };
    collectedAt: Date | null;
    legPoints: [number, number][] | null;
    legHours: number | null;
  }[],
  now: number = Date.now(),
) {
  const timeline = pickupTimeline(
    stops.map((s) => ({
      point: [Number(s.factory.lon ?? 0), Number(s.factory.lat ?? 0)] as [number, number],
      collectedAt: s.collectedAt,
      leg: s.legPoints && s.legHours ? { points: s.legPoints, hours: s.legHours } : null,
    })),
  );
  const position = timeline ? pickupPosition(timeline, now) : null;
  const eta = timeline && position?.etaAt ? etaRange(timeline, position.etaAt) : null;
  return { timeline, position, eta };
}
