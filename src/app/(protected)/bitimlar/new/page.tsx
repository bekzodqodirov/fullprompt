import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { getActor } from '@/modules/platform/rbac/authorize';
import { db } from '@/modules/platform/db/client';
import { clients, leads } from '@/modules/platform/db/schema';
import { PageHeader } from '@/components/ui/page';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { canWriteDeal, listStages } from '@/modules/wms/deals/service';
import { formStages } from '@/modules/wms/crm/stage-law';
import { DealForm } from '../deal-form';
import { ClientPicker } from './client-picker';

/**
 * A new deal always starts from a CLIENT.
 *
 * There is no "deal for a stranger": somebody with no code yet is a lead, and
 * winning that lead creates the client. Keeping the two apart is what stops
 * the deal board turning back into the funnel it replaced (docs/DEALS.md).
 */
export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; lead?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!canWriteDeal(actor.permissions)) redirect('/');

  const t = await getTranslations('deals');
  const params = await searchParams;
  const [stages, managers] = await Promise.all([listStages(), salesManagerOptions()]);

  // Arrived from a client card: the client is already decided and asking again
  // is a question with one possible answer.
  const preset = params.client
    ? await db.query.clients.findFirst({ where: eq(clients.id, params.client) })
    : null;
  // Arrived from a WON lead's «Bitim ochish»: the price hisoblatish produced
  // and the seller wrote on the lead opens the deal's quote, typed once
  // (round 71 — «shu narx yutildimi yo'qmi etapiga o'tadi»). Only a lead that
  // really belongs to this client may hand its numbers over: a `lead=` in the
  // URL is a forged post until proven (#514).
  const fromLead = params.lead
    ? await db.query.leads.findFirst({ where: eq(leads.id, params.lead) })
    : null;
  const quote = fromLead && preset && fromLead.clientId === preset.id ? fromLead : null;

  if (!preset) {
    const list = await db
      .select({ id: clients.id, code: clients.clientCode, name: clients.name })
      .from(clients)
      .where(eq(clients.active, true))
      .orderBy(asc(clients.clientCode))
      .limit(2000);
    return (
      <div className="space-y-4">
        <PageHeader
          icon="handshake"
          back={{ href: '/bitimlar', label: t('title') }}
          title={t('newDeal')}
        />
        <ClientPicker clients={list} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon="handshake"
        back={{ href: '/bitimlar', label: t('title') }}
        title={t('newDeal')}
        subtitle={
          <span className="num font-bold text-good">
            {preset.clientCode} · {preset.name}
          </span>
        }
      />
      <DealForm
        stages={formStages(stages, null)}
        managers={managers}
        initial={{
          clientId: preset.id,
          ownerId: preset.salesManagerId,
          title: null,
          quotedVolumeM3: quote?.quotedVolumeM3 ?? null,
          quotedWeightKg: quote?.quotedWeightKg ?? null,
          quotedAmount: quote?.quotedAmount ?? null,
          quotedCurrency: quote?.quotedCurrency ?? 'USD',
          note: null,
        }}
      />
    </div>
  );
}
