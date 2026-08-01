import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listPartnerTypes, listPartners } from '@/modules/wms/partners/service';
import { PageHeader } from '@/components/ui/page';
import { PartnerForm } from './partner-form';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { asc, eq } from 'drizzle-orm';

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
  if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
    redirect('/');
  }
  const t = await getTranslations('partners');
  const canManage = actor.permissions.has('finance.manage');

  const rows = await listPartners();
  const types = await listPartnerTypes();
  const owed = rows.filter((r) => r.balanceUsd > 0).reduce((a, r) => a + r.balanceUsd, 0);

  // For the "this counterparty is also one of our clients" picker. Active
  // clients only, and the list is long, so the form searches inside it.
  const clientOptions = canManage
    ? await db
        .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
        .from(clients)
        .where(eq(clients.active, true))
        .orderBy(asc(clients.clientCode))
    : [];

  const byType = types
    .map((type) => ({ type, rows: rows.filter((r) => r.typeCode === type.code) }))
    .filter((group) => group.rows.length > 0);

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
      </div>

      {canManage && <PartnerForm types={types} clients={clientOptions} />}

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
                    className="border-b border-line last:border-0 hover:bg-surface-sunken"
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
