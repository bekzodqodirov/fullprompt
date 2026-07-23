import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

interface WarehouseFill {
  code: string;
  capacityM3: number;
  occupiedM3: number;
  pct: number;
}

/**
 * Fill level per warehouse with a set capacity (owner's request): occupied m³
 * = per-box volume of everything in stock / ready. Thresholds per the owner:
 * ≥60% yellow, ≥80% red — "time to ship".
 */
async function warehouseFill(warehouseIds?: string[]): Promise<WarehouseFill[]> {
  const rows = await db
    .select({
      code: warehouses.code,
      capacityM3: warehouses.capacityM3,
      // NB: "warehouses"."id" is spelled out — drizzle shortens ${warehouses.id}
      // to bare "id" in single-table queries, which is ambiguous inside the
      // subquery (boxes/receipt_lots have id too).
      occupied: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count)
        FROM ${boxes} b JOIN ${receiptLots} rl ON b.lot_id = rl.id
        WHERE b.current_warehouse_id = "warehouses"."id"
          AND b.status IN ('in_stock', 'planned', 'loading', 'ready_for_pickup')
      ), 0)`,
    })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.active, true),
        isNotNull(warehouses.capacityM3),
        warehouseIds?.length ? inArray(warehouses.id, warehouseIds) : undefined,
      ),
    )
    .orderBy(asc(warehouses.code));
  return rows.map((r) => {
    const capacityM3 = Number(r.capacityM3);
    const occupiedM3 = Math.round(Number(r.occupied) * 10) / 10;
    return {
      code: r.code,
      capacityM3,
      occupiedM3,
      pct: capacityM3 > 0 ? Math.round((occupiedM3 / capacityM3) * 100) : 0,
    };
  });
}

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

  const isAdmin = actor.permissions.has('admin.warehouses.manage');
  const canReceive = actor.permissions.has('receipts.create');

  // Warehouse-scoped staff see their own warehouses' fill; managers see all.
  const fills = await warehouseFill(actor.warehouseScoped ? actor.warehouseIds : undefined);

  const comingSoon: { label: string; permission: string }[] = [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('welcome', { name: actor.fullName })}</h1>

      {fills.length > 0 && (
        <div className="card space-y-2 !p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t('warehouseFill')}
          </p>
          {fills.map((fill) => {
            const color =
              fill.pct >= 80 ? 'bg-red-600' : fill.pct >= 60 ? 'bg-yellow-500' : 'bg-green-600';
            const text =
              fill.pct >= 80 ? 'text-red-700' : fill.pct >= 60 ? 'text-yellow-700' : 'text-gray-600';
            return (
              <div key={fill.code} className="flex items-center gap-2">
                <span className="w-14 shrink-0 font-mono text-sm font-extrabold">{fill.code}</span>
                <div className="h-3 min-w-0 flex-1 overflow-hidden rounded bg-gray-200">
                  <div className={`h-full ${color}`} style={{ width: `${Math.min(100, fill.pct)}%` }} />
                </div>
                <span className={`w-32 shrink-0 text-right font-mono text-xs font-bold ${text}`}>
                  {fill.occupiedM3}/{fill.capacityM3} m³ · {fill.pct}%
                </span>
                {fill.pct >= 80 && <span title={t('fillShipHint')}>🚨</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {canReceive && (
          <Link
            href="/receive"
            className="card flex min-h-28 items-center justify-center bg-blue-700 text-lg font-bold text-white hover:bg-blue-800"
          >
            {t('receiving')}
          </Link>
        )}
        {actor.permissions.has('scan.load') && (
          <Link
            href="/batches"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            {t('loading')}
          </Link>
        )}
        {actor.permissions.has('plans.manage') && (
          <Link
            href="/plans"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            🚛 {tPlans('title')}
          </Link>
        )}
        {actor.permissions.has('scan.issue') && (
          <Link
            href="/issue"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            {t('handover')}
          </Link>
        )}
        {actor.roles.includes('sales_manager') && (
          <Link
            href="/pipeline"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            📈 {tPipeline('title')}
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
        {actor.permissions.has('costs.fx.manage') && (
          <Link
            href="/admin/fx"
            className="card flex min-h-28 items-center justify-center text-center text-lg font-bold [overflow-wrap:anywhere] hover:bg-gray-100"
          >
            💱 {tCosting('fxTitle')}
          </Link>
        )}
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
