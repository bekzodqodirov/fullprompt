import { asc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, currencies, warehouses } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { CrateBuilder, type CrateBuilderInitial } from './crate-builder';
import { warehouseScope } from '@/modules/platform/rbac/scope';
import { isUuidShaped } from '@/modules/platform/audit/fields';

export default async function NewCratePage({
  searchParams,
}: {
  searchParams: Promise<{ wh?: string; client?: string; lot?: string; kind?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crates.manage')) redirect('/');
  const t = await getTranslations('crates');

  const whs = await db
    .select({ id: warehouses.id, code: warehouses.code, country: warehouses.country })
    .from(warehouses)
    .where(
      warehouseScope(actor, warehouses.id),
    )
    .orderBy(asc(warehouses.code));
  const currencyRows = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.active, true));

  // Opened from a «🧱 Palet qilish» door (0112, Q10 d): the warehouse, the
  // client, the lot and the kind arrive filled. Every value is validated out
  // of the URL (#514) — a warehouse this person does not build crates at, or
  // a string that is not an id, is dropped and the builder opens plain.
  const params = await searchParams;
  const whId = params.wh && whs.some((wh) => wh.id === params.wh) ? params.wh : undefined;
  const client =
    params.client && isUuidShaped(params.client)
      ? ((await db.query.clients.findFirst({
          where: eq(clients.id, params.client),
          columns: { id: true, clientCode: true, name: true },
        })) ?? null)
      : null;
  const initial: CrateBuilderInitial = {
    warehouseId: whId,
    client: client ?? undefined,
    lotId: params.lot && isUuidShaped(params.lot) ? params.lot : undefined,
    kind: params.kind === 'palet' || params.kind === 'karkas' ? params.kind : undefined,
  };

  return (
    <div className="mx-auto max-w-lg md:max-w-3xl">
      <h1 className="mb-3 text-xl font-bold">🧰 {t('createTitle')}</h1>
      <CrateBuilder warehouses={whs} currencies={currencyRows.map((c) => c.code)} initial={initial} />
    </div>
  );
}
