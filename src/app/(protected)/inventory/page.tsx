import { asc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayWriteOffBox } from '@/modules/wms/receipts/box-write-off';
import { InventoryScreen } from './inventory-screen';
import { AcceptFound } from './accept-found';
import { BinBox } from './bin-box';
import { QrlessPrintList } from './qrless-print-list';
import { PageHeader } from '@/components/ui/page';
import { qrlessCountsAt } from '@/modules/wms/labels/qrless';

/** Inventory mode entry: pick a warehouse (scoped staff see their own). */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ warehouseId?: string; mode?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('inventory');
  const tq = await getTranslations('qrsiz');
  const { warehouseId, mode } = await searchParams;
  // Printing stickers later is the RECEIPT's power (0112): whoever may print
  // a prixod's stickers may print them for the cartons standing in front of
  // them, even without the stocktake's own `scan.load`.
  const mayPrintLater = actor.permissions.has('receipts.create');
  if (!actor.permissions.has('scan.load') && !(mode === 'stiker' && mayPrintLater)) redirect('/');

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
  // The bin's own gate, asked from the ONE home (#513) — widening it there
  // widens the stocktake's tick-list in the same breath.
  const canWriteOff = mayWriteOffBox(actor);
  // The chooser's «stiker keyin» tile, only while there is something here to
  // print — a tile that opens an empty list is a door to nothing.
  const qrlessHere =
    selected && !mode && mayPrintLater
      ? ((await qrlessCountsAt([selected.id], actor))[0]?.n ?? 0)
      : 0;

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
      ) : selected && mode === 'stiker' && mayPrintLater ? (
        <>
          <p className="text-sm text-ink-700">
            <span className="font-mono font-extrabold">{selected.code}</span> · {tq('modeTile')}
          </p>
          <QrlessPrintList warehouseId={selected.id} actor={actor} />
        </>
      ) : selected && mode === 'musor' && canWriteOff ? (
        <>
          <p className="text-sm text-ink-700">
            <span className="font-mono font-extrabold">{selected.code}</span> · {t('binHint')}
          </p>
          <BinBox warehouseId={selected.id} />
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
          {qrlessHere > 0 && (
            <Link
              href={`/inventory?warehouseId=${selected.id}&mode=stiker`}
              data-testid="inventory-mode-stiker"
              className="card flex min-h-20 flex-col justify-center hover:bg-surface-sunken"
            >
              <span className="font-bold">{tq('modeTile')}</span>
              <span className="text-sm text-ink-500">{tq('modeTileHint', { n: qrlessHere })}</span>
            </Link>
          )}
          {/* A door that draws what it will not let you press is not a door
              (#818): the bin is offered only to whoever `mayWriteOffBox`
              answers for, and the sentence below says who that is rather than
              leaving a missing tile to read as a broken screen (#792). */}
          {canWriteOff ? (
            <Link
              href={`/inventory?warehouseId=${selected.id}&mode=musor`}
              data-testid="inventory-mode-musor"
              className="card flex min-h-20 flex-col justify-center hover:bg-surface-sunken"
            >
              <span className="font-bold">🗑 {t('modeBin')}</span>
              <span className="text-sm text-ink-500">{t('modeBinHint')}</span>
            </Link>
          ) : (
            <p className="text-2xs text-ink-500">{t('binWhoAsk')}</p>
          )}
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
