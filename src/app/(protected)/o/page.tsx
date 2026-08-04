import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, EmptyState } from '@/components/ui/page';
import { Icon } from '@/components/ui/icon';
import { listCustomEntities, recordCounts } from '@/modules/platform/entities/service';

/**
 * Phase 8's front door: every list the owner has invented, with a live
 * count. Open to all staff — these are the reference lists everyone keeps
 * current; WRITING is gated per list by the choice made at its birth.
 */
export default async function CustomListsPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('objects');

  const [entities, counts] = await Promise.all([listCustomEntities(), recordCounts()]);
  const canDefine = actor.permissions.has('admin.dictionaries.manage');

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader
        icon="boxes"
        title={t('title')}
        actions={
          canDefine ? (
            <Link href="/admin/entities" className="btn-secondary">
              {t('define')}
            </Link>
          ) : undefined
        }
      />
      {entities.length === 0 ? (
        <EmptyState title={t('empty')} hint={canDefine ? t('emptyHint') : undefined} />
      ) : (
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
          {entities.map((entity) => (
            <Link
              key={entity.code}
              href={`/o/${entity.code}`}
              data-testid="object-tile"
              className="card-tap flex min-h-20 items-center gap-3 !p-4"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
                <Icon name="boxes" className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold leading-tight [overflow-wrap:anywhere]">
                  {entity.label ?? entity.code}
                </span>
                <span className="num text-xs text-ink-500">{counts.get(entity.code) ?? 0}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
