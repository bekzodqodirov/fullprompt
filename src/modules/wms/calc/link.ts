/**
 * The join between a calculation and the cargo it priced (VED phase E1).
 *
 * Everything phase E can say rests on this one question — «which prixod was
 * this quote about?» — and until now nothing in the system could answer it.
 * `calc_requests` names a lead or a deal; `receipts` names a deal; a deal
 * carries many of both. So the join is written at the RECEIPT grain and this
 * file is its only writer (#513): three doors call `stampCalcLink`, and every
 * reader asks `measurableLinkSql` which link may be scored.
 *
 * The rule that makes it safe to guess at all: **an `auto` link is a
 * suggestion and never scores anybody.** `dealFor` sends every repeat client
 * to their newest OPEN deal and no seeded stage carries a cargo trigger, so
 * one open deal alive for months is the normal shape here — a link stamped on
 * «this deal has exactly one sealed calculation» would hang a whole quarter's
 * prixods on one April quote and report +1200 % against the person who priced
 * it correctly. A person confirms, or nothing is measured.
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '@/modules/platform/db/client';
import { calcRequests, calcVersions, receipts } from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';

export class CalcLinkError extends Error {
  constructor(
    public code:
      | 'receipt_not_found'
      | 'request_not_found'
      | 'request_foreign'
      | 'no_deal'
      | 'not_mine',
  ) {
    super(code);
  }
}

/**
 * Whose calculation is this, for somebody whose scope is 'own'?
 *
 * Every LIST on the control screen is scoped, and the three BUTTONS were not:
 * `calcControlScopeFor(actor) !== 'none'` was the whole gate, so a VED could
 * confirm — or erase — the link that measures a colleague, on a row they can
 * only have reached by URL. A door that filters what you see and not what you
 * press is not a door.
 *
 * The owner and the accountant answer 'all' and pass everything, which is
 * right: they are the audience the screen exists for.
 */
async function assertMine(
  requestId: string,
  scope: 'all' | 'own',
  actorId: string,
): Promise<void> {
  if (scope === 'all') return;
  const [row] = await db
    .select({ sealedBy: calcVersions.sealedBy })
    .from(calcVersions)
    .where(eq(calcVersions.requestId, requestId))
    .orderBy(sql`${calcVersions.versionNo} DESC`)
    .limit(1);
  // An unsealed request has nobody measured by it yet, so there is nothing to
  // protect and nothing to score — the same reason the accuracy query only
  // ever looks at sealed versions.
  if (row && row.sealedBy !== actorId) throw new CalcLinkError('not_mine');
}

/**
 * The single sealed calculation this cargo belongs to, or nothing.
 *
 * Two guards, and each answers a different way of being wrong:
 *
 * - **exactly one** sealed, non-superseded request on the deal. Two means the
 *   machine has no way to choose and a person must; zero means there is
 *   nothing to measure against yet.
 * - **the window**. A prixod confirmed before the price was even asked for,
 *   or after the quote expired, is not the cargo that quote was about — it is
 *   next season's shipment on the same long-lived deal. `valid_until` is the
 *   quote's own stated life (`quote_valid_days`), so the window is the
 *   business's answer and not a number invented here.
 *
 * `tx`-only on purpose: every caller is already inside a transaction, and a
 * pooled read from in there asks for a connection the transaction is holding
 * one of (#714).
 */
export async function stampCalcLink(
  tx: Tx,
  receiptId: string,
  dealId: string | null,
): Promise<string | null> {
  if (!dealId) return null;
  const rows = await tx
    .select({
      id: calcRequests.id,
      requestedAt: calcRequests.requestedAt,
      validUntil: calcVersions.validUntil,
    })
    .from(calcRequests)
    .innerJoin(calcVersions, eq(calcVersions.requestId, calcRequests.id))
    .where(
      and(
        eq(calcRequests.entityType, 'deal'),
        eq(calcRequests.entityId, dealId),
        sql`NOT EXISTS (
          SELECT 1 FROM calc_requests s WHERE s.supersedes_request_id = ${calcRequests.id}
        )`,
      ),
    )
    .limit(3);

  // One request may hold several versions (a correction seals a new one on a
  // NEW request, but the join above is per version all the same).
  const byRequest = new Map<string, { requestedAt: Date; validUntil: Date }>();
  for (const row of rows) {
    const seen = byRequest.get(row.id);
    // The LATEST version's validity is the quote that stands.
    if (!seen || seen.validUntil < row.validUntil) {
      byRequest.set(row.id, { requestedAt: row.requestedAt, validUntil: row.validUntil });
    }
  }
  if (byRequest.size !== 1) return null;
  const [requestId, window] = [...byRequest.entries()][0]!;

  const [receipt] = await tx
    .select({ confirmedAt: receipts.confirmedAt })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);
  // An unconfirmed prixod is a draft; it gets its link when it is confirmed.
  const at = receipt?.confirmedAt;
  if (!at) return null;
  if (at.getTime() < window.requestedAt.getTime()) return null;
  if (at.getTime() > window.validUntil.getTime()) return null;

  // Never over a link a PERSON has already made. `calc_link_source IS NULL`
  // is the whole condition — an unconfirmed 'auto' guess may be replaced by a
  // better guess, but a confirmed one is somebody's answer.
  const [stamped] = await tx
    .update(receipts)
    .set({ calcRequestId: requestId, calcLinkSource: 'auto' })
    .where(and(eq(receipts.id, receiptId), isNull(receipts.calcRequestId)))
    .returning({ id: receipts.id });
  return stamped ? requestId : null;
}

/** A person says the guess is right. This is what makes it measurable. */
export async function confirmCalcLink(
  receiptId: string,
  scope: 'all' | 'own',
  ctx: AuditContext,
): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new CalcLinkError('receipt_not_found');
  if (!receipt.calcRequestId) throw new CalcLinkError('request_not_found');
  // The same re-proof `setCalcLink` does, because this door writes the same
  // fact: a ✓ is what makes a link MEASURABLE, so blessing one whose request
  // belongs to another customer's deal is exactly what that rule forbids.
  // Reachable in one press if a prixod is re-filed between the render and the
  // tap, which is the moment a stale suggestion is most likely on screen.
  const request = await db.query.calcRequests.findFirst({
    where: eq(calcRequests.id, receipt.calcRequestId),
  });
  if (!request) throw new CalcLinkError('request_not_found');
  if (request.entityType !== 'deal' || request.entityId !== receipt.dealId) {
    throw new CalcLinkError('request_foreign');
  }
  await assertMine(receipt.calcRequestId, scope, ctx.actorId ?? '');
  await db
    .update(receipts)
    .set({
      calcLinkSource: 'person',
      calcLinkConfirmedAt: new Date(),
      calcLinkConfirmedBy: ctx.actorId ?? null,
    })
    .where(eq(receipts.id, receiptId));
  await writeAudit(db, ctx, {
    entityType: 'receipt',
    entityId: receiptId,
    action: 'update',
    after: { calcRequest: receipt.calcRequestId, calcLink: 'person' },
  });
}

/**
 * A person picks the calculation themselves — the door that makes the whole
 * feature fill up, because the auto guess is silent whenever a client has two
 * jobs open, which is the busy client's normal state.
 *
 * The target is re-proved against the RECEIPT's own deal, never taken from
 * the form: a hand-posted request id would otherwise measure one customer's
 * cargo against another customer's quote.
 */
export async function setCalcLink(
  receiptId: string,
  requestId: string | null,
  scope: 'all' | 'own',
  ctx: AuditContext,
): Promise<void> {
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) throw new CalcLinkError('receipt_not_found');
  const before = receipt.calcRequestId;
  // BOTH ends: clearing somebody else's confirmed link is the more damaging
  // of the two, because it silently removes them from the measurement.
  if (before) await assertMine(before, scope, ctx.actorId ?? '');
  if (requestId) await assertMine(requestId, scope, ctx.actorId ?? '');

  if (requestId === null) {
    await db
      .update(receipts)
      .set({
        calcRequestId: null,
        calcLinkSource: null,
        calcLinkConfirmedAt: null,
        calcLinkConfirmedBy: null,
      })
      .where(eq(receipts.id, receiptId));
  } else {
    if (!receipt.dealId) throw new CalcLinkError('no_deal');
    const request = await db.query.calcRequests.findFirst({
      where: eq(calcRequests.id, requestId),
    });
    if (!request) throw new CalcLinkError('request_not_found');
    if (request.entityType !== 'deal' || request.entityId !== receipt.dealId) {
      throw new CalcLinkError('request_foreign');
    }
    await db
      .update(receipts)
      .set({
        calcRequestId: requestId,
        calcLinkSource: 'person',
        calcLinkConfirmedAt: new Date(),
        calcLinkConfirmedBy: ctx.actorId ?? null,
      })
      .where(eq(receipts.id, receiptId));
  }

  await writeAudit(db, ctx, {
    entityType: 'receipt',
    entityId: receiptId,
    action: 'update',
    before: { calcRequest: before },
    after: { calcRequest: requestId, calcLink: requestId === null ? null : 'person' },
  });
}

/**
 * Which link may be measured, written once (#513).
 *
 * Consumed by `calcActuals` and by the coverage line, as a predicate over a
 * `receipts` alias called `r`. A voided prixod is not cargo: it carries boxes
 * that were struck out, so counting its m³ against a quote reads as cargo
 * that arrived and did not.
 */
export function measurableLinkSql(alias = 'r'): SQL {
  return sql.raw(`
    ${alias}.calc_request_id IS NOT NULL
    AND ${alias}.calc_link_confirmed_at IS NOT NULL
    AND ${alias}.status = 'confirmed'
    AND ${alias}.voided_at IS NULL
  `);
}

/**
 * How far Σ linked cargo may exceed the quote before the comparison refuses.
 *
 * Not a deviation threshold — that is `deal_deviation_threshold_pct` and it
 * asks a different question. This one asks «is the LINK plausible at all»: a
 * 3 m³ quote with thirteen prixods hung off it is somebody having confirmed
 * a year of shipments onto one calculation, and a percentage computed from it
 * is noise wearing a number's clothes.
 */
export const LINK_IMPLAUSIBLE_FACTOR = 3;

export interface CalcLinkOption {
  requestId: string;
  section: string;
  sealedAt: Date;
  versionNo: number;
  volumeM3: number | null;
  weightKg: number | null;
}

/**
 * The sealed calculations this receipt's own deal carries, for the picker.
 *
 * Sealed ones only: an open request has no price, so linking cargo to it
 * measures the cargo against nothing. Ordered newest first, which is what a
 * person filing this month's prixod wants at the top.
 */
export async function calcLinkOptions(dealId: string | null): Promise<CalcLinkOption[]> {
  if (!dealId) return [];
  const rows = await db
    .select({
      requestId: calcRequests.id,
      section: calcVersions.section,
      sealedAt: calcVersions.sealedAt,
      versionNo: calcVersions.versionNo,
      volumeM3: calcVersions.volumeM3,
      weightKg: calcVersions.weightKg,
    })
    .from(calcVersions)
    .innerJoin(calcRequests, eq(calcRequests.id, calcVersions.requestId))
    .where(and(eq(calcRequests.entityType, 'deal'), eq(calcRequests.entityId, dealId)))
    .orderBy(sql`${calcVersions.sealedAt} DESC`)
    .limit(20);
  const seen = new Set<string>();
  const out: CalcLinkOption[] = [];
  for (const row of rows) {
    if (seen.has(row.requestId)) continue;
    seen.add(row.requestId);
    out.push({
      requestId: row.requestId,
      section: row.section,
      sealedAt: row.sealedAt,
      versionNo: row.versionNo,
      volumeM3: row.volumeM3 === null ? null : Number(row.volumeM3),
      weightKg: row.weightKg === null ? null : Number(row.weightKg),
    });
  }
  return out;
}

export interface LinkedReceipt {
  receiptId: string;
  number: string | null;
  confirmedAt: Date | null;
  linkConfirmed: boolean;
  volumeM3: number;
  weightKg: number;
}

/** The prixods hung on one calculation — what the workspace shows back. */
export async function linkedReceipts(requestId: string): Promise<LinkedReceipt[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT r.id, r.number, r.confirmed_at, r.calc_link_confirmed_at,
           coalesce(m.volume_m3, 0) AS volume_m3,
           coalesce(m.weight_kg, 0) AS weight_kg
      FROM receipts r
      LEFT JOIN LATERAL (
        SELECT sum(rl.total_volume_m3) AS volume_m3, sum(rl.total_weight_kg) AS weight_kg
          FROM receipt_lots rl WHERE rl.receipt_id = r.id
      ) m ON true
     WHERE r.calc_request_id = ${requestId}
       AND r.voided_at IS NULL
     ORDER BY r.confirmed_at DESC NULLS LAST
     LIMIT 50
  `);
  return rows.map((row) => ({
    receiptId: String(row.id),
    number: row.number ? String(row.number) : null,
    confirmedAt: row.confirmed_at ? new Date(String(row.confirmed_at)) : null,
    linkConfirmed: row.calc_link_confirmed_at !== null,
    volumeM3: Number(row.volume_m3 ?? 0),
    weightKg: Number(row.weight_kg ?? 0),
  }));
}
