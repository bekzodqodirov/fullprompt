import { and, desc, eq } from 'drizzle-orm';
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
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { buildOfferPdf } from '@/modules/wms/calc/offer-pdf';
import { releasedOfferWhere } from '@/modules/wms/calc/workspace';
import { offerLocaleFor } from '@/modules/wms/calc/offer';
import type { CalcSectionName } from '@/modules/wms/calc/pricing';

/**
 * The offer sheet a seller sends a customer.
 *
 * The gate is EXPLICIT and lives here, because this app has no middleware at
 * all — every `/api` route carries its own door, and a route that forgot one
 * is how `/transit`, both batch documents and the partner screens each leaked
 * (#721-726). The door is LAW 4's — `upsaleScopeFor` — because the sheet is a
 * client price and who may hold one is the only question here. The card's own
 * gate was the wrong question in both directions: it admitted the VED, whom
 * law 4 excludes, and it shut out the accountant, who pays the commission
 * measured off this very number.
 *
 * The PRICE is the offer's, not the seal's. A sheet rendered from
 * `calc_versions.total_usd` would print the company's floor to the customer;
 * this reads the newest recorded offer and 404s when there is none, so the
 * only way to get a sheet is to have made an offer.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  // Law 4 IS this route's door. The sheet is a client price, so who may hold
  // one is the only question — and `canWriteDeal` was the wrong question in
  // both directions: it let the VED through (`DEAL_WRITE_PERMISSIONS` carries
  // `ved.docs`, which is what makes a deal card theirs to work on) and it shut
  // out the accountant, who pays the commission measured off this number.
  const scope = upsaleScopeFor(actor);
  if (scope === 'none') return new Response('Forbidden', { status: 403 });

  const { versionId } = await params;

  let row;
  let offer;
  try {
    [row] = await db
      .select({ version: calcVersions, request: calcRequests })
      .from(calcVersions)
      .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
      .where(eq(calcVersions.id, versionId))
      .limit(1);
    if (!row) return new Response('Not found', { status: 404 });
    // A seller reaches a lead's sheet only if they could open the lead at all.
    // The owner and the accountant are not held to the funnel's own gate:
    // paying a commission on a lead's quote must not need `crm.leads`.
    if (
      row.request.entityType === 'lead' &&
      scope === 'own' &&
      !actor.permissions.has('crm.leads')
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    // RELEASED offers only (law 4's promise lock): a below-floor price that
    // no admin has allowed must not become a customer sheet by URL — the
    // panel hiding its link is a courtesy, this WHERE is the door. Filtered,
    // not fetched-then-refused, so a pending re-offer does not take away the
    // sheet of the released price the card still shows.
    [offer] = await db
      .select()
      .from(calcOffers)
      .where(and(eq(calcOffers.versionId, versionId), releasedOfferWhere()))
      .orderBy(desc(calcOffers.offeredAt))
      .limit(1);
  } catch (err) {
    // 0087's table. On deploy morning this route is a 503 and not a stack
    // trace on a page the seller is standing in front of a customer with.
    if (!isServerBehind(err)) throw err;
    logger.error({ err, versionId }, '[calc] offer pdf: server behind');
    return new Response('Not ready', { status: 503 });
  }
  if (!offer) return new Response('Not found', { status: 404 });
  // A seller may reprint what THEY promised, and nobody else's.
  if (scope === 'own' && offer.offeredBy !== actor.id) {
    return new Response('Forbidden', { status: 403 });
  }

  // The language is the seller's pick, checked against the three we have —
  // a hand-typed one falls back rather than reaching the label bundle.
  const url = new URL(request.url);
  const locale = offerLocaleFor(url.searchParams.get('til') ?? offer.locale);

  // The customer's name heads the sheet, resolved the same way the Telegram
  // text resolved it — the two must not greet different people.
  let clientName: string | null = null;
  if (row.request.entityType === 'deal') {
    const [d] = await db
      .select({ name: clients.name })
      .from(deals)
      .innerJoin(clients, eq(deals.clientId, clients.id))
      .where(eq(deals.id, row.request.entityId))
      .limit(1);
    clientName = d?.name ?? null;
  } else {
    const lead = await db.query.leads.findFirst({
      where: eq(leads.id, row.request.entityId),
      columns: { name: true, company: true },
    });
    clientName = lead ? lead.company || lead.name : null;
  }

  const pdf = await buildOfferPdf(
    {
      clientPriceUsd: Number(offer.clientPriceUsd),
      volumeM3: row.version.volumeM3 === null ? null : Number(row.version.volumeM3),
      weightKg: row.version.weightKg === null ? null : Number(row.version.weightKg),
      section: row.version.section as CalcSectionName,
      fromCity: row.request.fromCity,
      toCity: row.request.toCity,
      validUntil: row.version.validUntil,
      clientName,
    },
    locale,
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="offer-${versionId.slice(0, 8)}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}
