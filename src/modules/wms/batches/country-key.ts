/**
 * A warehouse's country as a rule compares it — trimmed and upper-cased,
 * because `warehouses.country` is free text and «cn », «CN» and «Cn» are one
 * country. ONE normalisation (#513) for the money rule (`isInternalLeg`) and
 * the reroute's «same country only» (`rerouteRefusal`).
 *
 * Zero imports on purpose: `internal.ts` imports the database client, and the
 * reroute's pure rules must not drag postgres into the phone's bundle through
 * it (#276). An empty key is «unknown», which every caller treats as its own
 * answer, never as a match.
 */
export function countryKey(country: string | null | undefined): string {
  return (country ?? '').trim().toUpperCase();
}
