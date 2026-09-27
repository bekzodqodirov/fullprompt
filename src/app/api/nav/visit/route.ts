import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { recordVisit } from '@/modules/platform/nav/usage';

/**
 * «I opened this tab» — the automatic half of «Tez-tez» (0111).
 *
 * A POST from an effect in the tab strip, never a write inside a server
 * render: pages are prefetched on hover, and a prefetch that counted as a
 * visit would fill the menu with pages nobody opened (ChatMarkRead's rule).
 *
 * The body carries a TAB href and nothing else; `recordVisit` counts it only
 * if it is a tab this person is offered, so a forged post can at most reorder
 * the poster's own menu. Always 204 on a refusal — there is nothing for the
 * page to show, and a status the browser logs as an error would be noise.
 */
export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { href?: unknown } | null;
  const href = typeof body?.href === 'string' ? body.href : null;
  if (!href || href.length > 64) return new NextResponse(null, { status: 204 });
  await recordVisit(actor.id, { permissions: actor.permissions, roles: actor.roles }, href);
  return new NextResponse(null, { status: 204 });
}
