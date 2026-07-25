import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

function Tile({
  href,
  label,
  primary = false,
  small = false,
}: {
  href: string;
  label: string;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`card flex items-center justify-center text-center font-bold [overflow-wrap:anywhere] ${
        small ? 'min-h-20 text-base' : 'min-h-28 text-lg'
      } ${primary ? 'bg-blue-700 text-white hover:bg-blue-800' : 'hover:bg-gray-100'}`}
    >
      {label}
    </Link>
  );
}

/**
 * Role-aware home: tiles grouped into daily operations / information /
 * management so the screen stays scannable as features grow (UX round).
 */
export default async function HomePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('home');
  const tr = await getTranslations('receipts');
  const ts = await getTranslations('stock');
  const tSearch = await getTranslations('search');
  const tCrates = await getTranslations('crates');
  const tPlans = await getTranslations('plans');
  const tPipeline = await getTranslations('pipeline');
  const tCosting = await getTranslations('costing');
  const tDashboard = await getTranslations('dashboard');
  const tInventory = await getTranslations('inventory');
  const tReports = await getTranslations('reports');
  const tFinance = await getTranslations('finance');
  const tMap = await getTranslations('map');

  const has = (p: string) => actor.permissions.has(p);
  const canDashboard = has('reports.all_warehouses') || has('reports.own_warehouse');

  const operations = [
    ...(has('receipts.create') ? [{ href: '/receive', label: t('receiving'), primary: true }] : []),
    ...(has('scan.load') ? [{ href: '/batches', label: t('loading') }] : []),
    ...(has('plans.manage') ? [{ href: '/plans', label: `🚛 ${tPlans('title')}` }] : []),
    ...(has('scan.issue') ? [{ href: '/issue', label: t('handover') }] : []),
    ...(has('crates.manage') ? [{ href: '/crates', label: `🧰 ${tCrates('title')}` }] : []),
    ...(has('scan.load') ? [{ href: '/inventory', label: `📋 ${tInventory('title')}` }] : []),
  ];

  const info = [
    { href: '/stock', label: `📦 ${ts('title')}` },
    { href: '/map', label: `🗺 ${tMap('title')}` },
    { href: '/receipts', label: `📄 ${tr('title')}` },
    { href: '/unclaimed', label: `❓ ${tr('unclaimedTitle')}` },
    { href: '/search', label: `🔍 ${tSearch('title')}` },
    ...(canDashboard
      ? [
          { href: '/dashboard', label: `📊 ${tDashboard('title')}` },
          { href: '/reports', label: `📑 ${tReports('title')}` },
        ]
      : []),
    ...(actor.roles.includes('sales_manager')
      ? [{ href: '/pipeline', label: `📈 ${tPipeline('title')}` }]
      : []),
    ...(has('finance.view') || has('finance.manage')
      ? [{ href: '/finance', label: `💰 ${tFinance('title')}` }]
      : []),
  ];

  const management = [
    ...(has('costs.fx.manage') ? [{ href: '/admin/fx', label: `💱 ${tCosting('fxTitle')}` }] : []),
    ...(has('plans.manage') ? [{ href: '/trucks', label: `🚛 ${tPlans('trucksTitle')}` }] : []),
    ...(has('admin.warehouses.manage')
      ? [{ href: '/admin/warehouses', label: t('adminPanel') }]
      : []),
  ];

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">{t('welcome', { name: actor.fullName })}</h1>

      {operations.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t('sectionOperations')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {operations.map((tile) => (
              <Tile key={tile.href} {...tile} />
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t('sectionInfo')}
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {info.map((tile) => (
            <Tile key={tile.href} small {...tile} />
          ))}
        </div>
      </section>

      {management.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t('sectionManagement')}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {management.map((tile) => (
              <Tile key={tile.href} small {...tile} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
