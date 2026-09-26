/**
 * Who may say that money is «kurs farqi» (0103, the owner's Q12 A and Q19):
 * the accountant and the admin — `finance.manage` AND `finance.reports`, law
 * 4's audience (`upsaleScopeFor`'s). A kurs farqi row moves the P&L, and the
 * VED (`finance.manage` without `finance.reports`) must not see the P&L, let
 * alone write into it: he keeps typing a firm's correction (Q19 B) and it
 * waits unclassified beside the P&L for the accountant. ONE predicate for the
 * partner form's radio, both classify doors, the client card's «Kurs farqi
 * bilan yopish» (Q24 b) and every link to «Kurs qoldiqlari». Zero imports.
 */
export function mayClassifyFx(permissions: ReadonlySet<string>): boolean {
  return permissions.has('finance.manage') && permissions.has('finance.reports');
}
