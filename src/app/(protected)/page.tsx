import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function HomePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('home');

  const isAdmin = actor.permissions.has('admin.warehouses.manage');
  const ops: { label: string; permission: string }[] = [
    { label: t('receiving'), permission: 'receipts.create' },
    { label: t('loading'), permission: 'scan.load' },
    { label: t('unloading'), permission: 'scan.unload' },
    { label: t('handover'), permission: 'scan.issue' },
  ];
  const visibleOps = ops.filter((op) => actor.permissions.has(op.permission));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('welcome', { name: actor.fullName })}</h1>
      <div className="grid grid-cols-2 gap-3">
        {visibleOps.map((op) => (
          <button
            key={op.label}
            disabled
            title={t('comingSoon')}
            className="card flex min-h-28 flex-col items-center justify-center text-lg font-bold opacity-60"
          >
            {op.label}
            <span className="mt-1 text-xs font-normal text-gray-500">{t('comingSoon')}</span>
          </button>
        ))}
        {isAdmin && (
          <Link
            href="/admin/warehouses"
            className="card flex min-h-28 items-center justify-center text-lg font-bold hover:bg-gray-100"
          >
            {t('adminPanel')}
          </Link>
        )}
      </div>
    </div>
  );
}
