import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  deals,
  leads,
  users,
} from '@/modules/platform/db/schema';
import { getSetting } from '@/modules/platform/settings/service';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import type { ClientLocale } from '@/modules/platform/telegram/client-labels';
import { buildOfferPdf } from './offer-pdf';
import { offerLocaleFor } from './offer';
import type { CalcSectionName } from './pricing';
import { releasedOfferWhere } from './workspace';

/**
 * The offer sheet as a FILE — one home for the two places that print it: the
 * by-offer-id route (the «📄 PDF» link) and the staff drain, which since his
 * 2026-10-27 «narx taklifi text bolib sotuvchi telegramiga kelyabti pdf ham
 * birga kelsin … shu telegramni ozini jonatish imkoni uchun» sends the sheet
 * WITH the text, as one message the seller forwards whole. Two builders would
 * be two papers (round 112's «this route and the versionId sibling must print
 * the same paper», one level up).
 *
 * The door stays with each caller: the route asks the reader's scope, the
 * drain sends only to the seller who made the offer.
 */

export interface OfferSheetSource {
  offer: typeof calcOffers.$inferSelect;
  request: typeof calcRequests.$inferSelect;
  /** Absent on a «Готово»-anchored offer (phase 4): no seal, no version. */
  version: typeof calcVersions.$inferSelect | null;
}

/**
 * The offer a sheet is printed from — RELEASED only (`releasedOfferWhere`, in
 * the fetch itself): a pending below-floor price must not become a customer
 * sheet, by URL or by Telegram. Null for an id that is not an offer's.
 */
export async function offerSheetSource(offerId: string): Promise<OfferSheetSource | null> {
  if (!isUuidShaped(offerId)) return null;
  const [offer] = await db
    .select()
    .from(calcOffers)
    .where(and(eq(calcOffers.id, offerId), releasedOfferWhere()))
    .limit(1);
  if (!offer) return null;

  if (offer.versionId) {
    const [row] = await db
      .select({ version: calcVersions, request: calcRequests })
      .from(calcVersions)
      .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
      .where(eq(calcVersions.id, offer.versionId))
      .limit(1);
    return row ? { offer, request: row.request, version: row.version } : null;
  }
  if (!offer.requestId) return null;
  const request = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, offer.requestId) });
  return request ? { offer, request, version: null } : null;
}

/**
 * The name the CUSTOMER reads under the file — ASCII on purpose (a Telegram
 * client and a phone's Downloads both keep it whole), in the offer's language,
 * with the deal's code when there is one: «GSR-taklif-B-00123.pdf».
 */
export function offerFileName(docNo: string | null, locale: ClientLocale): string {
  const word = locale === 'ru' ? 'predlozhenie' : locale === 'en' ? 'offer' : 'taklif';
  const code = (docNo ?? '').replace(/[^A-Za-z0-9-]/g, '');
  return `GSR-${word}${code ? `-${code}` : ''}.pdf`;
}

/** The sheet's bytes and its file name, in `locale`. */
export async function offerSheetPdf(
  source: OfferSheetSource,
  locale: ClientLocale,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { offer, request: req, version } = source;

  // The sheet's furniture (round 112): the customer, the deal's code, the
  // goods from the request's OWN items, and the seller.
  let clientName: string | null = null;
  let clientCode: string | null = null;
  let clientPhone: string | null = null;
  let docNo: string | null = null;
  if (req.entityType === 'deal') {
    const [d] = await db
      .select({
        name: clients.name,
        code: clients.clientCode,
        phones: clients.phones,
        dealCode: deals.code,
      })
      .from(deals)
      .innerJoin(clients, eq(deals.clientId, clients.id))
      .where(eq(deals.id, req.entityId))
      .limit(1);
    clientName = d?.name ?? null;
    clientCode = d?.code ?? null;
    clientPhone = Array.isArray(d?.phones) && typeof d.phones[0] === 'string' ? d.phones[0] : null;
    docNo = d?.dealCode ?? null;
  } else {
    const lead = await db.query.leads.findFirst({
      where: eq(leads.id, req.entityId),
      columns: { name: true, company: true, phone: true },
    });
    clientName = lead ? lead.company || lead.name : null;
    clientPhone = lead?.phone ?? null;
  }
  const itemRows = await db
    .select({
      seq: calcRequestItems.seq,
      name: calcRequestItems.name,
      quantity: calcRequestItems.quantity,
      unit: calcRequestItems.unit,
      weightKg: calcRequestItems.weightKg,
      volumeM3: calcRequestItems.volumeM3,
      // The pair the job was priced on (0092) — «120 m²», never «120» (P1.7).
      measureUnit: calcRequestItems.measureUnit,
      measureQty: calcRequestItems.measureQty,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, req.id))
    .orderBy(asc(calcRequestItems.seq));
  const seller = await db.query.users.findFirst({
    where: eq(users.id, offer.offeredBy),
    columns: { fullName: true, phone: true },
  });
  const cellNum = (v: string | null) => (v === null ? null : Number(v));

  // The answer anchor has no stored valid_until — the sheet recomputes it the
  // way recordOffer did (completed_at + the setting's days).
  let validUntil: Date;
  if (version) {
    validUntil = version.validUntil;
  } else {
    const validDays = Number((await getSetting('quote_valid_days')) ?? 30);
    validUntil = new Date((req.completedAt ?? new Date()).getTime() + validDays * 86_400_000);
  }

  const bytes = await buildOfferPdf(
    {
      clientPriceUsd: Number(offer.clientPriceUsd),
      volumeM3:
        version?.volumeM3 != null ? Number(version.volumeM3) : req.volumeM3 === null ? null : Number(req.volumeM3),
      weightKg:
        version?.weightKg != null ? Number(version.weightKg) : req.weightKg === null ? null : Number(req.weightKg),
      section: (version?.section ?? req.section ?? 'podklyuch') as CalcSectionName,
      fromCity: req.fromCity,
      toCity: req.toCity,
      validUntil,
      clientName,
      clientCode,
      clientPhone,
      docNo,
      offeredAt: offer.offeredAt,
      managerName: seller?.fullName ?? null,
      managerPhone: seller?.phone ?? null,
      // Descriptors only — never a breakdown or a money column (#781).
      items: itemRows.map((i) => ({
        seq: i.seq,
        label: i.name,
        quantity: cellNum(i.quantity),
        unit: i.unit,
        weightKg: cellNum(i.weightKg),
        volumeM3: cellNum(i.volumeM3),
        measure:
          i.measureUnit && cellNum(i.measureQty) !== null ? { qty: cellNum(i.measureQty)!, unit: i.measureUnit } : null,
      })),
    },
    locale,
  );
  return { bytes, fileName: offerFileName(docNo, locale) };
}

/**
 * The drain's question: the sheet for this offer, in the language the seller
 * wrote the text in (`offer.locale`, so the caption and the paper agree).
 * Null when there is no released offer to print — the text then goes alone,
 * as it always did.
 */
export async function offerSheetFile(offerId: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const source = await offerSheetSource(offerId);
  if (!source) return null;
  return offerSheetPdf(source, offerLocaleFor(source.offer.locale));
}
