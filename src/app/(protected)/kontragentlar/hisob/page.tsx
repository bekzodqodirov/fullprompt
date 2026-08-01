import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, currencies } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { listPartners } from '@/modules/wms/partners/service';
import { BackLink } from '@/components/back-link';
import { SettlementForm } from './settlement-form';

/**
 * The three-cornered settlement screen (owner's case: a client pays their
 * debt to us into our transport company's account in China).
 *
 * Its own page rather than a panel on either card, because it belongs to
 * neither: it moves a client balance and a partner balance at once and
 * touches no cash box of ours.
 */
export default async function SettlementPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('finance.manage')) redirect('/');
  const t = await getTranslations('partners');

  const [clientRows, partnerRows, currencyRows] = await Promise.all([
    db
      .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
      .from(clients)
      .where(eq(clients.active, true))
      .orderBy(asc(clients.clientCode)),
    listPartners(),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
  ]);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <BackLink href="/kontragentlar" label={t('title')} />
      <h1 className="text-xl font-bold">🔁 {t('settlement')}</h1>
      <p className="text-sm text-ink-700">{t('settlementHint')}</p>
      <SettlementForm
        clients={clientRows}
        partners={partnerRows.map((p) => ({ id: p.id, name: p.name, typeName: p.typeName }))}
        currencies={currencyRows.map((c) => c.code)}
      />
    </div>
  );
}
