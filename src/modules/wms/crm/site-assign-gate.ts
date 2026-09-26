import { getSetting } from '../../platform/settings/service';
import { parseOrigins } from '../../platform/http/origins';
import { TokenBuckets } from './site-assign-rules';

/**
 * The public door's front step: everything decided BEFORE the database is
 * touched (round 113).
 *
 * `/api/lead/assign` is called from visitors' browsers, so its address is in
 * the website's public code and anybody can call it. The app is ONE Node
 * process whose pool of ten connections serves every staff screen (#714,
 * round 74), so a flood must be turned away here, in memory, at no cost to the
 * warehouse — and «turned away» means the website's own fallback list answers
 * the visitor, which is always safe. Held in module state because the route
 * file may export nothing but its methods, and the panel on /admin/taqsimot
 * reads the same counters in the same process.
 */

/** Per caller (IPv4 address or IPv6 /64): 20 questions per 10 minutes. */
const perCaller = new TokenBuckets(20, 20 / (10 * 60_000));
/** Everybody together: a burst ceiling far above any real advert. */
const overall = new TokenBuckets(120, 120 / 60_000, 1);
/** At most this many questions reach the database at once. */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

export type Refusal = 'origin' | 'rate' | 'busy' | 'invalid' | 'deadline' | 'error';

/** Since the process started — what the panel shows as «rad etilgan». */
const counters: Record<Refusal | 'answered' | 'nobody', number> = {
  answered: 0,
  nobody: 0,
  origin: 0,
  rate: 0,
  busy: 0,
  invalid: 0,
  deadline: 0,
  error: 0,
};
const startedAt = new Date();

export function count(what: keyof typeof counters): void {
  counters[what] += 1;
}

export function gateCounters(): { since: Date; counts: Readonly<typeof counters> } {
  return { since: startedAt, counts: { ...counters } };
}

/** May this caller ask right now? Both buckets, the caller's first. */
export function admit(key: string, now = Date.now()): boolean {
  return perCaller.take(key, now) && overall.take('all', now);
}

/** A slot for the database, or false when the door is already busy. */
export function enter(): boolean {
  if (inFlight >= MAX_IN_FLIGHT) return false;
  inFlight += 1;
  return true;
}

export function leave(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/**
 * The allowed origins, read from the setting at most once a minute — so a
 * call from a foreign page costs no query at all, and a change on
 * /admin/settings is in force within the minute without a restart.
 */
const ORIGINS_TTL_MS = 60_000;
let origins: { list: string[]; at: number } | null = null;

export async function allowedOrigin(origin: string | null): Promise<string | null> {
  if (!origin) return null;
  if (!origins || Date.now() - origins.at > ORIGINS_TTL_MS) {
    origins = { list: parseOrigins(await getSetting('lead_assign_origins')), at: Date.now() };
  }
  return origins.list.includes(origin) ? origin : null;
}
