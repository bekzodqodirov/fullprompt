import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, clients, crmPeople, receiptLots, receipts } from '../../platform/db/schema';

/**
 * Who is standing at this warehouse waiting for cargo.
 *
 * The owner, handing cargo over (2026-09-14): «topshirish jarayonida AND
 * belgilab keyin klient kodi yozilyabti … spiska tursin isim tel nomer va
 * unga tegishli kodlar … yolchi GS555 700boxes gs777 400 boxes bekzod GS5564
 * 5boxes». The screen has always asked the operator to TYPE a code, which
 * assumes they know it; at the counter the customer says a name and a phone
 * number, and one human being routinely holds three codes.
 *
 * So: the list is built from the CARGO, never from the client book. A code
 * with nothing on this shelf is not on it — which is also the whole of the
 * privacy answer to his 3.3a («telefon to'liq ko'rinsin»): a warehouse
 * operator reads the number of the person whose boxes they are about to hand
 * over, and of nobody else. The client book stays behind `clients.view`.
 */

/**
 * What «issuable» means, and it has exactly one home.
 *
 * `ready_for_pickup` is the status unloading writes; `in_stock` is here
 * because cargo received AT the issuing warehouse never rode a truck and was
 * never unloaded (a Tashkent walk-in). `/api/issue/list` asks the same
 * question about one client, so the two must agree — a list that offers a
 * person the box screen then shows nothing is worse than no list.
 */
export const ISSUABLE_STATUSES = ['ready_for_pickup', 'in_stock'] as const;

export interface PartyCode {
  clientId: string;
  code: string;
  name: string;
  boxes: number;
}

export interface IssueParty {
  /** The person, when the codes have been grouped under one; else null. */
  personId: string | null;
  /** What to print big: the person's name, or the single code's own name. */
  name: string;
  phones: string[];
  codes: PartyCode[];
  boxes: number;
}

export interface UnclaimedParty {
  receiptId: string;
  marking: string;
  boxes: number;
}

/**
 * One grouped query for the codes, one for the markings — never a query per
 * row (#432). Both are bounded: a warehouse holding cargo for more parties
 * than the cap is a reason to search, and the screen says so.
 */
export async function issueParties(warehouseId: string, limit = 120) {
  const codeRows = await db
    .select({
      clientId: clients.id,
      code: clients.clientCode,
      name: clients.name,
      phones: clients.phones,
      personId: clients.personId,
      personName: crmPeople.name,
      personPhones: crmPeople.phones,
      boxes: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(crmPeople, eq(clients.personId, crmPeople.id))
    .where(
      and(
        eq(boxes.currentWarehouseId, warehouseId),
        inArray(boxes.status, [...ISSUABLE_STATUSES]),
      ),
    )
    .groupBy(
      clients.id,
      clients.clientCode,
      clients.name,
      clients.phones,
      clients.personId,
      crmPeople.name,
      crmPeople.phones,
    )
    .orderBy(desc(sql`count(*)`), asc(clients.clientCode));

  /**
   * Cargo whose owner is not known yet — a carton carrying only a
   * hand-written marking (his 3.2a: «alohida qator, markasi bilan»). It
   * cannot be handed over from this screen at all, because there is no client
   * to bill or to sign for it; the row is a LINK to the prixod, where
   * somebody with the right to say so names the client first.
   */
  const unclaimedRows = await db
    .select({
      receiptId: receipts.id,
      marking: receipts.unclaimedMarking,
      boxes: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(boxes.currentWarehouseId, warehouseId),
        inArray(boxes.status, [...ISSUABLE_STATUSES]),
        sql`${receipts.clientId} IS NULL`,
        sql`coalesce(${receipts.unclaimedMarking}, '') <> ''`,
      ),
    )
    .groupBy(receipts.id, receipts.unclaimedMarking)
    .orderBy(desc(sql`count(*)`));

  const byParty = new Map<string, IssueParty>();
  for (const row of codeRows) {
    // A code with no person is its own party, keyed on itself — never on a
    // null person, or every ungrouped customer in the warehouse would fold
    // into one row called «null».
    const key = row.personId ?? `client:${row.clientId}`;
    const party =
      byParty.get(key) ??
      ({
        personId: row.personId,
        name: row.personId ? (row.personName ?? row.name) : row.name,
        phones: [],
        codes: [],
        boxes: 0,
      } satisfies IssueParty);
    const phones = [
      // The person's own numbers first when there is a person — that is the
      // one somebody typed deliberately — then whatever the codes carry.
      ...(row.personId && Array.isArray(row.personPhones) ? (row.personPhones as string[]) : []),
      ...(Array.isArray(row.phones) ? (row.phones as string[]) : []),
    ].filter((phone): phone is string => typeof phone === 'string' && phone.trim() !== '');
    for (const phone of phones) if (!party.phones.includes(phone)) party.phones.push(phone);
    party.codes.push({
      clientId: row.clientId,
      code: row.code,
      name: row.name,
      boxes: Number(row.boxes),
    });
    party.boxes += Number(row.boxes);
    byParty.set(key, party);
  }

  const parties = [...byParty.values()].sort((a, b) => b.boxes - a.boxes);
  const unclaimed: UnclaimedParty[] = unclaimedRows.map((row) => ({
    receiptId: row.receiptId,
    marking: row.marking ?? '',
    boxes: Number(row.boxes),
  }));

  return {
    parties: parties.slice(0, limit),
    /** Said only when the cap bites, so the screen never claims a slice is all. */
    more: Math.max(0, parties.length - limit),
    unclaimed: unclaimed.slice(0, limit),
  };
}
