import { eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { partners, partnerTypes } from '../../platform/db/schema';

/**
 * A STAFF counterparty (0101, owner A1c): the account of a person who works
 * here — money they paid out of pocket is our debt to them, a cash advance
 * is theirs to us.
 *
 * Who may see and move it is the owner's M2a/M3a: «faqat buxgalter va
 * admin». That is `finance.expenses` — the kassa screens' own door — and NOT
 * the counterparty screens' `finance.manage` / `seesAllMoney`, which admit
 * the VED (finance.manage) and the logist (clients.manage): a colleague's
 * advance is payroll, not a supplier's bill.
 *
 * A partner is staff when it is linked to a login OR carries the seeded
 * 'staff' type: the link is what the owner's accountant sets, the type is
 * what an account opened before the link reads as — keyed on either, so
 * hiding the «Hodim» type on /admin/partner-types cannot un-hide the people.
 */
export const STAFF_MONEY_PERMISSION = 'finance.expenses';

export function maySeeStaffMoney(permissions: ReadonlySet<string>): boolean {
  return permissions.has(STAFF_MONEY_PERMISSION);
}

/** The staff rule over the partners and partner_types tables in a query. */
export function staffPartnerSql(): SQL {
  return sql`(${partners.userId} IS NOT NULL OR ${partnerTypes.code} = 'staff')`;
}

/** Is this counterparty somebody's staff account? False when it does not exist. */
export async function isStaffPartner(partnerId: string): Promise<boolean> {
  const [row] = await db
    .select({ staff: sql<boolean>`${staffPartnerSql()}` })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .where(eq(partners.id, partnerId))
    .limit(1);
  return row?.staff === true;
}

/** The staff account of one login, if the accountant has opened it. */
export async function staffPartnerOfUser(userId: string) {
  const [row] = await db
    .select({ id: partners.id, name: partners.name, active: partners.active })
    .from(partners)
    .where(eq(partners.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Staff accounts of several logins at once (the Kiritish queue, #432). */
export async function staffPartnersOfUsers(userIds: string[]) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: partners.id, userId: partners.userId })
    .from(partners)
    .where(or(...ids.map((id) => eq(partners.userId, id))));
  return new Map(rows.filter((r) => r.userId).map((r) => [r.userId!, r.id]));
}

/**
 * Does choosing this TYPE make an account staff? The type half of
 * `staffPartnerSql`, asked of a form's posted type before the row exists —
 * or a VED could open a «Hodim» account the screen would then hide from them.
 */
export async function isStaffType(typeId: string): Promise<boolean> {
  const [row] = await db
    .select({ code: partnerTypes.code })
    .from(partnerTypes)
    .where(eq(partnerTypes.id, typeId))
    .limit(1);
  return row?.code === 'staff';
}
