import { asc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { InventoryScreen } from './inventory-screen';
import { AcceptFound } from './accept-found';
import { PageHeader } from '@/components/ui/page';

/** Inventory mode entry: pick a warehouse (scoped staff see their own). */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string; mode?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('scan.load')) redirect('/');
  const t = await getTranslations('inventory');
  const { warehouseId, mode } = await searchParams;

  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
    .from(warehouses)
    .where(
      actor.warehouseScoped
        ? actor.warehouseIds.length
          ? inArray(warehouses.id, actor.warehouseIds)
          : eq(warehouses.id, '00000000-0000-0000-0000-000000000000')
        : eq(warehouses.active, true),
    )
    .orderBy(asc(warehouses.code));

  const selected = warehouseId ? whs.find((wh) => wh.id === warehouseId) : null;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader icon="clipboard" title={t('title')} />
      {selected && mode === 'full' ? (
        <>
          <p className="text-sm text-ink-700">
            <span className="font-mono font-extrabold">{selected.code}</span> · {t('hint')}
          </p>
          <InventoryScreen
            warehouseId={selected.id}
            warehouseCode={selected.code}
            canMarkLost={actor.permissions.has('receipts.void')}
          />
        </>
      ) : selected && mode === 'bitta' ? (
        <>
          <p className="text-sm text-ink-700">
            <span className="font-mono font-extrabold">{selected.code}</span> · {t('acceptHint')}
          </p>
          <AcceptFound warehouseId={selected.id} />
        </>
      ) : selected ? (
        // Two jobs behind one door (owner, 2026-08-25): accepting ONE box
        // found on the floor, and counting the whole building. The single
        // accept comes first — it is the everyday one.
        <div className="grid grid-cols-1 gap-3">
          <Link
            href={`/inventory?warehouseId=${selected.id}&mode=bitta`}
            data-testid="inventory-mode-bitta"
            className="card flex min-h-20 flex-col justify-center hover:bg-surface-sunken"
          >
            <span className="font-bold">📦 {t('modeAccept')}</span>
            <span className="text-sm text-ink-500">{t('modeAcceptHint')}</span>
          </Link>
          <Link
            href={`/inventory?warehouseId=${selected.id}&mode=full`}
            data-testid="inventory-mode-full"
            className="card flex min-h-20 flex-col justify-center hover:bg-surface-sunken"
          >
            <span className="font-bold">📋 {t('modeFull')}</span>
            <span className="text-sm text-ink-500">{t('modeFullHint')}</span>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {whs.map((wh) => (
            <Link
              key={wh.id}
              href={`/inventory?warehouseId=${wh.id}`}
              className="card flex min-h-24 flex-col items-center justify-center text-center hover:bg-surface-sunken"
            >
              <span className="font-mono text-xl font-extrabold">{wh.code}</span>
              <span className="text-sm text-ink-700">{wh.name}</span>
            </Link>
          ))}
          {whs.length === 0 && <p className="text-sm text-ink-500">—</p>}
        </div>
      )}
    </div>
  );
}
