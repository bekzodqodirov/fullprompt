import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function HomePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('home');
  const tr = await getTranslations('receipts');
  const ts = await getTranslations('stock');
  const tSearch = await getTranslations('search');
  const tCrates = await getTranslations('crates');

  const isAdmin = actor.permissions.has('admin.warehouses.manage');
  const canReceive = actor.permissions.has('receipts.create');

  const comingSoon: { label: string; permission: string }[] = [
    { label: t('loading'), permission: 'scan.load' },
    { label: t('unloading'), permission: 'scan.unload' },
    { label: t('handover'), permission: 'scan.issue' },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('welcome', { name: actor.fullName })}</h1>
      <div className="grid grid-cols-2 gap-3">
        {canReceive && (
          <Link
            href="/receive"
            className="card flex min-h-28 items-center justify-center bg-blue-700 text-lg font-bold text-white hover:bg-blue-800"
          >
            {t('receiving')}
          </Link>
        )}
        {comingSoon
          .filter((op) => actor.permissions.has(op.permission))
          .map((op) => (
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
        <Link
          href="/receipts"
          className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
        >
          📄 {tr('title')}
        </Link>
        <Link
          href="/stock"
          className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
        >
          📦 {ts('title')}
        </Link>
        <Link
          href="/unclaimed"
          className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
        >
          ❓ {tr('unclaimedTitle')}
        </Link>
        {actor.permissions.has('crates.manage') && (
          <Link
            href="/crates"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            🧰 {tCrates('title')}
          </Link>
        )}
        <Link
          href="/search"
          className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
        >
          🔍 {tSearch('title')}
        </Link>
        {isAdmin && (
          <Link
            href="/admin/warehouses"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            {t('adminPanel')}
          </Link>
        )}
      </div>
    </div>
  );
}
