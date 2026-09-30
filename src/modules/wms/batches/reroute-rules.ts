import { inScope, mayAt, type ScopedActor } from '../../platform/rbac/scope';
import { countryKey } from './country-key';

/*
 * «Yo'nalishni o'zgartirish» — the pure half of changing a truck's receiving
 * warehouse while it is on the road (owner, 2026-09-30: 1a 2a 3a 4a, and his
 * unanswered 5 built as its starred default «a» — the same country only).
 *
 * Pure on purpose, and importing only pure modules (`country-key`, the scope
 * rules): the Mashina tab's form imports the refusal TYPE from here, and a
 * value import that reached `platform/db` would put postgres into the phone's
 * bundle (#276). The service (`reroute.ts`) is the one door that writes; these
 * are the questions it, the screen and the unload doors all ask.
 */

/** Every refusal the reroute can give — a sentence each on the Mashina tab (#906). */
export const REROUTE_REFUSALS = [
  'forbidden',
  'out_of_scope',
  'batch_not_found',
  'not_in_transit',
  'dest_changed',
  'reason_required',
  'reason_too_long',
  'bad_target',
  'same_destination',
  'destination_is_origin',
  'target_inactive',
  'country_unknown',
  'other_country',
] as const;
export type RerouteErrorCode = (typeof REROUTE_REFUSALS)[number];

/**
 * Whether THIS warehouse may take the truck, judged on the rows as read — the
 * truck's status is the service's question, asked on the LOCKED row.
 *
 * In this order, because the first answer that applies is the one a person
 * can act on: nothing chosen, then the truck's own two ends, then the target's
 * own state, then the country. `other_country` is what keeps every money rule,
 * the customer's journey and the VED's papers unchanged by a reroute: they
 * read only the two ends' COUNTRIES (answer 5a). Widening it is its own round
 * — `tests/unit/batch-reroute-wire.test.ts` goes red at the reader that must
 * change first.
 */
export function rerouteRefusal(
  truck: { originWarehouseId: string; destWarehouseId: string; destCountry: string | null },
  target: { id: string; active: boolean; country: string | null } | null,
): RerouteErrorCode | null {
  if (!target) return 'bad_target';
  if (target.id === truck.destWarehouseId) return 'same_destination';
  // `batches_route_check` would refuse it as a 23514 and a white page.
  if (target.id === truck.originWarehouseId) return 'destination_is_origin';
  if (!target.active) return 'target_inactive';
  const from = countryKey(truck.destCountry);
  const to = countryKey(target.country);
  // A belt: the warehouse form stores two upper-case letters, NOT NULL.
  if (!from || !to) return 'country_unknown';
  if (from !== to) return 'other_country';
  return null;
}

/**
 * Who may be OFFERED the form (owner's 2a: «admin va logist»): `plans.manage`
 * — seeded on exactly super_admin, admin and logist, editable on /admin/roles
 * like every grant (#170), the count door's own power — on a truck that is on
 * the road, at its LIVE destination. `inScope(dest)` already implies the
 * card's door. The service asks all of it again on the locked row, plus the
 * target's scope (#531: a screen that offers only the right form proves
 * nothing about a hand-made post).
 */
export function mayRerouteTruck(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  batch: { status: string; destWarehouseId: string },
): boolean {
  return (
    actor.permissions.has('plans.manage') &&
    batch.status === 'in_transit' &&
    inScope(actor, batch.destWarehouseId)
  );
}

/**
 * A person who could act at a warehouse the truck was heading to and cannot
 * act at the one it heads to now — the old destination's staff after a
 * reroute. They are told «endi {to} ga boradi» instead of «not your
 * warehouse / session expired», which sent them into a re-login loop.
 */
export function lostThroughReroute(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  permission: string,
  former: readonly string[],
  liveDest: string,
): boolean {
  return !mayAt(actor, permission, liveDest) && former.some((w) => mayAt(actor, permission, w));
}
