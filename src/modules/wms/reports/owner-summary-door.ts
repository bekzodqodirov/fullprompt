import { companyMoneySight, type CompanyMoneySight, type MoneyActor } from '../finance/scope';

/**
 * Who reads the evening summary (the owner's answer 7a, 2026-09-28: «har kuni
 * 20:00 faqat sizga + dushanba haftalik») — the push, the «📊 Holat» button,
 * the typed /holat, the command menu entry and the profile's checkbox all ask
 * THIS, so nobody is offered a button that answers «faqat egasi uchun».
 *
 * Two halves, both required:
 *
 *  - the super_admin ROLE — «faqat sizga» names a person, and the owner's own
 *    account is the one super_admin; a grant would admit anybody the matrix
 *    is later edited to give it (round 21's shape: breadth is a role, #170);
 *  - the company's money sight (`companyMoneySight`, the dashboard's money
 *    gate) — the summary IS the company's money, and a super_admin role whose
 *    grants were customised away from `finance.reports` reads no kassa on the
 *    screen, so the bot must not read it to him either.
 *
 * The judge proposed the dashboard's wider door (admins too); the owner said
 * «faqat sizga», so admins read the dashboard and receive nothing here.
 *
 * Pure: no database, so the profile page, the bot and the job can all ask it
 * of an actor they already hold, and a test can hand it a built one (#166).
 */
export interface OwnerSummaryActor extends MoneyActor {
  roles: readonly string[];
}

export function readsOwnerSummary(actor: OwnerSummaryActor): boolean {
  return actor.roles.includes('super_admin') && companyMoneySight(actor) !== null;
}

/**
 * The door and the token in one: the sight to hand `composeOwnerSummary`, or
 * null. The ONLY way a caller outside the dashboard obtains the token for the
 * summary, so «asked the door» and «holds the token» cannot come apart.
 */
export function ownerSummarySight(actor: OwnerSummaryActor): CompanyMoneySight | null {
  return readsOwnerSummary(actor) ? companyMoneySight(actor) : null;
}
