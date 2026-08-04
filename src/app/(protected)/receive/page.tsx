import { asc, eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  clients,
  costTypes,
  currencies,
  expectedArrivals,
  warehouses,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { getSetting } from '@/modules/platform/settings/service';
import { ReceiveWizard, type ArrivalPrefill } from './receive-wizard';

export default async function ReceivePage({
  searchParams,
}: {
  searchParams: Promise<{ arrival?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('receipts.create')) redirect('/');
  const t = await getTranslations('receive');

  // A warehouse-scoped operator may ONLY receive into their assigned
  // warehouses — never fall back to "all" (submitting to an unassigned one
  // is rejected by authorize() anyway, so offering it just sets a trap).
  if (actor.warehouseScoped && actor.warehouseIds.length === 0) {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="mb-3 text-xl font-bold">{t('title')}</h1>
        <div className="card text-sm">⚠️ {t('noWarehouseAssigned')}</div>
      </div>
    );
  }

  const whs = await db
    .select({
      id: warehouses.id,
      code: warehouses.code,
      name: warehouses.name,
      country: warehouses.country,
    })
    .from(warehouses)
    .where(
      actor.warehouseScoped
        ? inArray(warehouses.id, actor.warehouseIds)
        : eq(warehouses.active, true),
    )
    .orderBy(asc(warehouses.code));

  const types = await db
    .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true));
  const currencyRows = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true));

  // Tapped «Qabul qilish» on a promise: open pre-filled with everything the
  // promise already knows, and carry its id so the confirm closes it. A
  // promise that is not waiting, or belongs to a warehouse this operator may
  // not receive into, prefills nothing — the screen still works plain.
  const params = await searchParams;
  let prefill: ArrivalPrefill | null = null;
  if (params.arrival && /^[0-9a-f-]{36}$/i.test(params.arrival)) {
    const row = await db.query.expectedArrivals.findFirst({
      where: eq(expectedArrivals.id, params.arrival),
    });
    if (row && row.status === 'waiting' && whs.some((wh) => wh.id === row.warehouseId)) {
      const client = row.clientId
        ? await db.query.clients.findFirst({ where: eq(clients.id, row.clientId) })
        : null;
      prefill = {
        arrivalId: row.id,
        warehouseId: row.warehouseId,
        clientId: row.clientId,
        clientLabel: client ? `${client.clientCode} — ${client.name}` : '',
        marking: row.marking ?? '',
        boxCount: row.boxCount,
        weightKg: row.weightKg === null ? null : Number(row.weightKg),
        volumeM3: row.volumeM3 === null ? null : Number(row.volumeM3),
      };
    }
  }

  return (
    <div className="mx-auto max-w-lg md:max-w-none">
      <h1 className="mb-3 text-xl font-bold">{t('title')}</h1>
      <ReceiveWizard
        warehouses={whs}
        costTypes={types}
        currencies={currencyRows.map((c) => c.code)}
        densityThresholds={await getSetting('density_thresholds')}
        prefill={prefill}
        canPickDeal={canWriteDeal(actor.permissions)}
      />
    </div>
  );
}
