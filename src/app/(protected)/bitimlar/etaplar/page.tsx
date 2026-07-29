import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Panel } from '@/components/panel';
import { PageHeader } from '@/components/ui/page';
import { dealStageUsage, listStages } from '@/modules/wms/deals/service';
import { DealStageForm } from './stage-form';

/**
 * The deal funnel's editor — born in round 26, because until the cargo
 * trigger there was nothing about a deal stage to edit: the seeded columns
 * were the whole design. Now a stage can FOLLOW the cargo («mashina jo'nadi»
 * → the deal moves by itself), and which stage follows which state is the
 * owner's call, so it has to be a screen.
 *
 * Same gate as the lead funnel's settings: reshaping the funnel everyone
 * works in is `crm.manage`, not the deal-write list.
 */
export default async function DealStagesPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.manage')) redirect('/bitimlar');
  const t = await getTranslations('deals');
  const tc = await getTranslations('crm');

  const [stages, usage] = await Promise.all([listStages(true), dealStageUsage()]);
  const rows = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: stage.kind,
    color: stage.color,
    sortOrder: stage.sortOrder,
    active: stage.active,
    cargoTrigger: stage.cargoTrigger,
  }));

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <Link href="/bitimlar" className="text-sm text-ink-500 underline">
        ← {t('title')}
      </Link>
      <PageHeader icon="settings" title={t('stageSettings')} />
      <p className="text-sm text-ink-500">{t('cargoTriggerHint')}</p>

      <Panel title={`➕ ${tc('addStage')}`}>
        <DealStageForm />
      </Panel>
      <Panel title={`✏️ ${tc('stages')}`} badge={rows.length}>
        {rows.map((stage) => (
          <div key={stage.id}>
            {/* How many deals sit here — the number that makes deactivating
                a column an informed decision rather than a surprise. */}
            <p className="pt-2 text-xs text-ink-500">
              {stage.name} · {usage[stage.id] ?? 0}
            </p>
            <DealStageForm stage={stage} />
          </div>
        ))}
      </Panel>
    </div>
  );
}
