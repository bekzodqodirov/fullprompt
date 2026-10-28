import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { offerSheetPdf, offerSheetSource, type OfferSheetSource } from '@/modules/wms/calc/offer-sheet-file';
import { offerLocaleFor } from '@/modules/wms/calc/offer';

/**
 * The offer sheet, fetched by the OFFER's own id — phase 4's one route for
 * both anchors (a version-keyed URL is a literal `null` on a Готово-anchored
 * offer). The versionId sibling stays for links already delivered.
 *
 * The door is the sibling route's, clause for clause (this app has no
 * middleware — every /api route carries its own door, #721-726):
 * - `upsaleScopeFor` is the gate: the sheet is a CLIENT price, law 4's
 *   question, not the card's;
 * - a seller reaches a lead's sheet only if they could open the lead;
 * - scope 'own' reprints only what THEY promised;
 * - `releasedOfferWhere` in the FETCH itself: a pending below-floor price
 *   must not become a customer sheet by URL — and by-id makes that easier to
 *   reach, since `recordOffer` returns the id to the seller who is exactly
 *   the person the lock waits on.
 * A SUPERSEDED offer's sheet deliberately still prints: the row stores what
 * the customer was told, and «what did we tell them» must stay answerable
 * after a correction — the standing clause gates money and the card's price,
 * never the record.
 */
export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  const scope = upsaleScopeFor(actor);
  if (scope === 'none') return new Response('Forbidden', { status: 403 });

  const { offerId } = await params;

  let source: OfferSheetSource | null;
  try {
    source = await offerSheetSource(offerId);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, offerId }, '[calc] offer pdf by id: server behind');
    return new Response('Not ready', { status: 503 });
  }
  if (!source) return new Response('Not found', { status: 404 });
  const { offer, request: req } = source;

  if (req.entityType === 'lead' && scope === 'own' && !actor.permissions.has('crm.leads')) {
    return new Response('Forbidden', { status: 403 });
  }
  if (scope === 'own' && offer.offeredBy !== actor.id) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const locale = offerLocaleFor(url.searchParams.get('til') ?? offer.locale);
  // The sheet itself is `offerSheetPdf`'s — the same paper the seller's
  // Telegram copy carries (his 2026-10-27).
  const { bytes, fileName } = await offerSheetPdf(source, locale);

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
