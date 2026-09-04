import { and, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcOffers,
  calcRequests,
  calcVersions,
  clients,
  deals,
  leads,
} from '@/modules/platform/db/schema';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { getSetting } from '@/modules/platform/settings/service';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { buildOfferPdf } from '@/modules/wms/calc/offer-pdf';
import { releasedOfferWhere } from '@/modules/wms/calc/workspace';
import { offerLocaleFor } from '@/modules/wms/calc/offer';
import type { CalcSectionName } from '@/modules/wms/calc/pricing';

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

  let offer;
  let req: typeof calcRequests.$inferSelect | undefined;
  let version: typeof calcVersions.$inferSelect | undefined;
  try {
    [offer] = await db
      .select()
      .from(calcOffers)
      .where(and(eq(calcOffers.id, offerId), releasedOfferWhere()))
      .limit(1);
    if (!offer) return new Response('Not found', { status: 404 });

    if (offer.versionId) {
      const [row] = await db
        .select({ version: calcVersions, request: calcRequests })
        .from(calcVersions)
        .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
        .where(eq(calcVersions.id, offer.versionId))
        .limit(1);
      version = row?.version;
      req = row?.request;
    } else if (offer.requestId) {
      req = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, offer.requestId) });
    }
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, offerId }, '[calc] offer pdf by id: server behind');
    return new Response('Not ready', { status: 503 });
  }
  if (!req) return new Response('Not found', { status: 404 });

  if (req.entityType === 'lead' && scope === 'own' && !actor.permissions.has('crm.leads')) {
    return new Response('Forbidden', { status: 403 });
  }
  if (scope === 'own' && offer.offeredBy !== actor.id) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const locale = offerLocaleFor(url.searchParams.get('til') ?? offer.locale);

  let clientName: string | null = null;
  if (req.entityType === 'deal') {
    const [d] = await db
      .select({ name: clients.name })
      .from(deals)
      .innerJoin(clients, eq(deals.clientId, clients.id))
      .where(eq(deals.id, req.entityId))
      .limit(1);
    clientName = d?.name ?? null;
  } else {
    const lead = await db.query.leads.findFirst({
      where: eq(leads.id, req.entityId),
      columns: { name: true, company: true },
    });
    clientName = lead ? lead.company || lead.name : null;
  }

  // The answer anchor has no stored valid_until — the sheet recomputes it the
  // way recordOffer did (completed_at + the setting's days).
  let validUntil: Date;
  if (version) {
    validUntil = version.validUntil;
  } else {
    const validDays = Number((await getSetting('quote_valid_days')) ?? 30);
    validUntil = new Date((req.completedAt ?? new Date()).getTime() + validDays * 86_400_000);
  }

  const pdf = await buildOfferPdf(
    {
      clientPriceUsd: Number(offer.clientPriceUsd),
      volumeM3:
        version?.volumeM3 != null
          ? Number(version.volumeM3)
          : req.volumeM3 === null
            ? null
            : Number(req.volumeM3),
      weightKg:
        version?.weightKg != null
          ? Number(version.weightKg)
          : req.weightKg === null
            ? null
            : Number(req.weightKg),
      section: (version?.section ?? req.section ?? 'podklyuch') as CalcSectionName,
      fromCity: req.fromCity,
      toCity: req.toCity,
      validUntil,
      clientName,
    },
    locale,
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="taklif.pdf"',
      'Cache-Control': 'private, no-store',
    },
  });
}
