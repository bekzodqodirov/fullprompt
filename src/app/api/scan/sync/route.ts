import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { syncBodySchema, syncScans } from '@/modules/wms/scanning/sync';

/**
 * Offline outbox sync endpoint (spec §15, edge cases 13/14): accepts a batch
 * of load/unload scan events, returns per-item acks. Replays are idempotent.
 *
 * Thin on purpose: the per-truck decision is `syncScans`' (the reroute
 * round), where a test can press it. Two whole-body answers remain, and both
 * are about the PERSON, never about one truck: 401 when nobody is signed in
 * (logging in again makes every row sendable), and 403 only when nothing in
 * the body is theirs at all — a truck they lost no longer blocks the others.
 */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const parsed = syncBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'validation' }, { status: 400 });

  const result = await syncScans(actor, parsed.data.scans, await requestMeta());
  if (result.acks.length === 0 && result.withheld.length > 0) {
    return Response.json({ error: 'forbidden', withheld: result.withheld }, { status: 403 });
  }
  return Response.json(result);
}
