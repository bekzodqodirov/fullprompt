import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { seesAllMoney } from '@/modules/wms/finance/scope';
import {
  groupPartnersByType,
  listPartnerTypes,
  listPartners,
  partnerTotals,
} from '@/modules/wms/partners/service';
import { PageHeader } from '@/components/ui/page';
import { PartnerForm } from './partner-form';
import { db } from '@/modules/platform/db/client';
import { clients, users } from '@/modules/platform/db/schema';
import { asc, eq } from 'drizzle-orm';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';

/**
 * Kimga qarzdormiz — the mirror of the client ledger.
 *
 * Positive balance is RED here for the opposite reason it is red on the
 * client screen: there it means somebody owes us, here it means we owe
 * somebody. Grouped by type, because "how much do we owe the transport
 * companies" is a question the owner asks about the group, not the firm.
 */
export default async function PartnersPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // Round 91's rule, applied to the OTHER side of the money: `finance.view`
  // alone is a seller, and a seller reads their own book — but a counterparty
  // balance is company-wide by construction (what GSR owes the transport and
  // customs firms; there is no «own» partner). So this screen asks the
  // MANAGEMENT predicate, not the viewing grant. The seller menu already
  // omitted this page; the gate now agrees with the menu.
  if (!seesAllMoney(actor)) redirect('/');
  const t = await getTranslations('partners');
  const canManage = actor.permissions.has('finance.manage');

  // Retired rows are READ here and hidden only when they are settled.
  //
  // Two screens were disagreeing about the same money. `companyBalance` counts
  // every partner row whether or not the account is retired — correctly, a
  // debt is real either way — while this page listed active accounts only and
  // summed those. So hiding a firm we still owed $8,000 dropped $8,000 off
  // «jami qarzimiz» here and changed nothing on /accounting/balance, which is
  // the page that LINKS here. Worse, the hide button lives on the card, and
  // after hiding, nothing on any screen linked to that card any more.
  //
  // A retired account with a live balance therefore keeps its row (dimmed, and
  // saying so); a retired account that is settled disappears, which is the
  // tidying the button was for.
  const seesStaff = maySeeStaffMoney(actor.permissions);
  const allRows = await listPartners({ includeInactive: true, includeStaff: seesStaff });
  const rows = allRows.filter((r) => r.active || Math.abs(r.balanceUsd) > 0.009);
  // Group over EVERY type, offer only the live ones on the form: hiding a type
  // on /admin/partner-types must not delete the accounts under it from the
  // screen while their debt stays in the total.
  const allTypes = await listPartnerTypes(true);
  // The «Hodim» type is offered only to whoever may see staff accounts (M3a):
  // for anybody else it would open an account the list then hides from them —
  // and the action refuses it anyway.
  const types = allTypes.filter((type) => type.active && (seesStaff || type.code !== 'staff'));
  const { owedByUs: owed, owedToUs } = partnerTotals(rows);

  // For the "this counterparty is also one of our clients" picker. Active
  // clients only, and the list is long, so the form searches inside it.
  const clientOptions = canManage
    ? await db
        .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
        .from(clients)
        .where(eq(clients.active, true))
        .orderBy(asc(clients.clientCode))
    : [];

  // The login picker, for the accountant and the admin alone — null draws no
  // select at all, and a form with no select posts no login, which the
  // service reads as «unchanged» (#171).
  const staffUsers =
    canManage && seesStaff
      ? await db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(eq(users.active, true))
          .orderBy(asc(users.fullName))
      : null;

  const byType = groupPartnersByType(rows, allTypes);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader
        icon="wallet"
        title={t('title')}
        actions={
          canManage ? (
            <Link href="/kontragentlar/hisob" className="btn-secondary px-3 text-sm">
              🔁 {t('settlement')}
            </Link>
          ) : undefined
        }
      />

      <div className="card flex items-baseline gap-2">
        <span className="text-sm text-ink-700">{t('totalOwed')}:</span>
        <span className="font-mono text-lg font-extrabold text-bad" data-testid="partners-total">
          ${owed.toFixed(2)}
        </span>
        {owedToUs > 0 && (
          <span className="ml-auto text-sm text-ink-700">
            {t('owedToUs')}:{' '}
            <b className="font-mono text-good" data-testid="partners-receivable">
              ${owedToUs.toFixed(2)}
            </b>
          </span>
        )}
      </div>

      {canManage && <PartnerForm types={types} clients={clientOptions} staffUsers={staffUsers} />}

      {byType.length === 0 && <p className="card text-center text-ink-500">{t('empty')}</p>}

      {byType.map(({ type, rows: group }) => (
        <section key={type.id} className="space-y-2">
          <p className="section-title">{type.name}</p>
          <div className="card overflow-x-auto !p-0">
            <table className="w-full text-sm">
              <tbody>
                {group.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-line last:border-0 hover:bg-surface-sunken ${
                      row.active ? '' : 'opacity-60'
                    }`}
                  >
                    <td className="p-0">
                      <Link
                        href={`/kontragentlar/${row.id}`}
                        className="block p-3"
                        data-testid="partner-row"
                      >
                        <span className="font-semibold">{row.name}</span>
                        {row.clientCode && (
                          <span className="ml-2 font-mono text-xs text-brand-700">
                            {row.clientCode}
                          </span>
                        )}
                        {/* Retired but still owed: the row stays so the money
                            stays visible and the card stays reachable — the
                            «Ko'rsatish» button lives on it. */}
                        {!row.active && (
                          <span className="ml-2 rounded bg-bad/15 px-1.5 py-0.5 text-xs font-bold text-bad">
                            {t('inactive')}
                          </span>
                        )}
                      </Link>
                    </td>
                    <td
                      className={`p-3 text-right font-mono font-bold ${
                        row.balanceUsd > 0.009
                          ? 'text-bad'
                          : row.balanceUsd < -0.009
                            ? 'text-good'
                            : 'text-ink-500'
                      }`}
                    >
                      ${row.balanceUsd.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <p className="text-xs text-ink-500">{t('balanceHint')}</p>
    </div>
  );
}
