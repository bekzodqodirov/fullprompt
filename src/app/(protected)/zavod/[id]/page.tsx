import Link from 'next/link';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  costEntries,
  costTypes,
  currencies,
  partners,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { PageHeader } from '@/components/ui/page';
import { CostPanel } from '@/components/cost-panel';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { listPartners } from '@/modules/wms/partners/service';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import {
  listFactories,
  loadPickup,
  mayReadPickup,
  PICKUP_WRITE,
  pickupCandidates,
} from '@/modules/wms/pickups/service';
import { pickupEstimate } from '@/modules/wms/pickups/eta';
import {
  AddStopForm,
  CollectForm,
  LinkReceiptButtons,
  PickupButtons,
  RemoveStopButton,
  StopLinesForm,
} from '../pickup-forms';

export const dynamic = 'force-dynamic';

export default async function PickupCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const actor = await getActor();
  if (!actor) redirect('/login');
  const loaded = await loadPickup(id);
  if (!loaded) notFound();
  const { pickup, dest, stops, createdByName } = loaded;
  if (!mayReadPickup(actor, pickup.destWarehouseId)) notFound();

  const t = await getTranslations('pickups');
  const format = await getFormatter();
  const canWrite = actor.permissions.has(PICKUP_WRITE);
  const live = pickup.status !== 'cancelled';
  const canCost = actor.permissions.has('costs.enter_batch') && inScope(actor, pickup.destWarehouseId);

  const costs = await db
    .select({ entry: costEntries, typeName: costTypes.name, partnerName: partners.name })
    .from(costEntries)
    .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
    .leftJoin(partners, eq(costEntries.partnerId, partners.id))
    .where(and(eq(costEntries.pickupId, id), isNull(costEntries.voidedAt)))
    .orderBy(asc(costEntries.createdAt));
  const costMeta = canCost
    ? {
        types: await db
          .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
          .from(costTypes)
          .where(eq(costTypes.active, true)),
        currencies: (
          await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true))
        ).map((c) => c.code),
        partners: (await listPartners()).map((row) => ({ id: row.id, name: row.name })),
      }
    : null;
  const candidates = live && canCost ? await pickupCandidates(id) : [];
  const factories = canWrite && live ? await listFactories() : [];
  const stamps = stops.length
    ? await db
        .select()
        .from(attachments)
        .where(inArray(attachments.entityId, stops.map((s) => s.id)))
        .orderBy(asc(attachments.createdAt))
    : [];

  // The estimate: where the truck should be and when it should be here, as
  // a RANGE (the legs' hours are a public router's car time stretched for a
  // lorry, an assumption, not a promise).
  const { position, eta } = pickupEstimate(stops);
  const unplaced = stops.filter((s) => s.factory.lat === null);
  const linkedCount = stops.reduce((a, s) => a + s.receipts.filter((r) => !r.voided).length, 0);
  const tz = 'Asia/Tashkent';
  const when = (value: Date | number) =>
    format.dateTime(new Date(value), { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        icon="truck"
        title={<span className="font-mono">{pickup.code}</span>}
        subtitle={`${t(`status.${pickup.status}`)} · → ${dest.code}`}
        back={{ href: '/zavod', label: t('title') }}
      />
      <div className="card space-y-1 text-sm" data-testid="pickup-facts">
        <p>
          <span className="text-ink-500">{t('destination')}:</span> {dest.code} — {dest.name}
        </p>
        {(pickup.vehiclePlate || pickup.driverName || pickup.driverPhone) && (
          <p>
            <span className="text-ink-500">{t('driver')}:</span> {pickup.vehiclePlate} {pickup.driverName}{' '}
            {pickup.driverPhone && (
              <a className="text-brand-700 underline" href={`tel:${pickup.driverPhone}`}>
                {pickup.driverPhone}
              </a>
            )}
          </p>
        )}
        {pickup.plannedOn && (
          <p>
            <span className="text-ink-500">{t('plannedOn')}:</span> {pickup.plannedOn}
          </p>
        )}
        {pickup.note && <p className="whitespace-pre-line text-ink-700">📝 {pickup.note}</p>}
        <p className="text-xs text-ink-500">
          {createdByName} · {when(pickup.createdAt)}
        </p>
        {live && eta && position && (
          <p data-testid="pickup-eta" className="rounded bg-surface-sunken px-2 py-1">
            🧭 {t('etaLine', { from: when(eta.from), to: when(eta.to) })}{' '}
            <span className="text-xs text-ink-500">({t('estimate')})</span>
          </p>
        )}
        {live && unplaced.length > 0 && (
          <p className="text-xs text-warn">
            ⚠ {t('unplaced', { names: unplaced.map((s) => s.factory.name).join(', ') })}
          </p>
        )}
        {pickup.status === 'arrived' && costs.length === 0 && (
          <p data-testid="pickup-no-cost" className="font-semibold text-warn">
            ⚠ {t('noCostLong')}
          </p>
        )}
        {live && mayReadBatches(actor.permissions) && (
          <Link href={`/map?zr=${pickup.id}`} className="inline-block text-brand-700 underline" data-testid="pickup-map-link">
            🗺 {t('onMap')}
          </Link>
        )}
      </div>

      {stops.map((stop) => (
        <section key={stop.id} className="card space-y-2" data-testid="pickup-stop">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="font-semibold">
              {stop.seq}. {stop.factory.name}
            </h2>
            {stop.collectedAt ? (
              <span className="chip chip-good" data-testid="stop-collected">
                ✓ {t('collectedAt', { at: when(stop.collectedAt) })}
              </span>
            ) : (
              <span className="chip chip-neutral">{t('notCollected')}</span>
            )}
          </div>
          <p className="text-xs text-ink-500">
            {[stop.factory.address, stop.factory.phone, stop.factory.wechat && `WeChat: ${stop.factory.wechat}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {stop.stampNote && <p className="text-xs">🖋 {stop.stampNote}</p>}
          <ul className="divide-y divide-line text-sm">
            {stop.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-baseline gap-x-2 py-1" data-testid="stop-line">
                <span className="font-mono font-semibold">{line.clientCode ?? line.marking}</span>
                {/* The goods may break anywhere, and the counts take their own
                    line on a phone: a one-word Chinese or Uzbek name used to
                    run INTO «zavod: 5» at 360 px (seen in the screenshot). */}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line.goods}</span>
                <span className="basis-full text-xs text-ink-700 sm:basis-auto">
                  {t('factoryShort')}: {line.factoryBoxes}
                  {line.driverBoxes !== null && (
                    <span className={line.driverBoxes !== line.factoryBoxes ? 'font-semibold text-warn' : ''}>
                      {' '}
                      · {t('driverShort')}: {line.driverBoxes}
                    </span>
                  )}
                  {line.volumeM3 !== null && ` · ${line.volumeM3} m³`}
                  {line.weightKg !== null && ` · ${line.weightKg} kg`}
                </span>
                {line.receipts.map((r) => (
                  <Link key={r.id} href={`/receipts/${r.id}`} className="text-xs text-brand-700 underline">
                    ✓ {r.number}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
          {canWrite && live && !stop.collectedAt && stop.lines.length > 0 && (
            <CollectForm
              stopId={stop.id}
              lines={stop.lines.map((l) => ({
                id: l.id,
                label: `${l.clientCode ?? l.marking} ${l.goods}`,
                factoryBoxes: l.factoryBoxes,
              }))}
            />
          )}
          {canWrite && live && stop.receipts.every((r) => r.voided) && (
            <StopLinesForm
              stopId={stop.id}
              initial={stop.lines.map((l) => ({
                owner: l.clientCode ?? l.marking ?? '',
                goods: l.goods,
                factoryBoxes: String(l.factoryBoxes),
                volumeM3: l.volumeM3 === null ? '' : String(l.volumeM3),
                weightKg: l.weightKg === null ? '' : String(l.weightKg),
              }))}
            />
          )}
          <AttachmentsPanel
            entityType="pickup_stop"
            entityId={stop.id}
            initial={stamps
              .filter((f) => f.entityId === stop.id)
              .map((f) => ({ id: f.id, fileName: f.fileName, contentType: f.contentType, kind: f.kind }))}
            editable={canWrite && live}
          />
          {canWrite && live && !stop.collectedAt && stop.receipts.length === 0 && stops.length > 1 && (
            <RemoveStopButton stopId={stop.id} />
          )}
        </section>
      ))}

      {canWrite && live && stops.length < 6 && factories.length > 0 && (
        <div className="card">
          <AddStopForm pickupId={pickup.id} factories={factories.map((f) => ({ id: f.id, label: f.name }))} />
        </div>
      )}

      <section className="card space-y-2" data-testid="pickup-costs">
        <h2 className="font-semibold">💰 {t('costs')}</h2>
        <p className="text-xs text-ink-500">{t('costHint', { n: linkedCount })}</p>
        <CostPanel
          scope="pickup"
          targetId={pickup.id}
          entries={costs.map(({ entry, typeName, partnerName }) => ({
            id: entry.id,
            typeName,
            amount: entry.amount,
            currency: entry.currency,
            amountUsd: entry.amountUsd,
            costDate: entry.costDate,
            allocationBasis: entry.allocationBasis,
            note: entry.note,
            partnerName,
          }))}
          costTypes={costMeta?.types ?? []}
          currencies={costMeta?.currencies ?? []}
          clientOptions={[
            ...new Map(
              stops
                .flatMap((s) => s.lines)
                .filter((l) => l.clientId && l.clientCode)
                .map((l) => [l.clientId!, { id: l.clientId!, clientCode: l.clientCode! }]),
            ).values(),
          ]}
          defaultCurrency={costMeta?.currencies.includes('CNY') ? 'CNY' : 'USD'}
          canEdit={Boolean(canCost && live)}
          partnerOptions={costMeta?.partners ?? []}
        />
      </section>

      {candidates.length > 0 && (
        <section className="card space-y-2" data-testid="pickup-candidates">
          <h2 className="font-semibold">📎 {t('candidatesTitle')}</h2>
          <p className="text-xs text-ink-500">{t('candidatesHint')}</p>
          <ul className="space-y-1 text-sm">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/receipts/${c.id}`} className="font-mono text-brand-700 underline">
                  {c.number}
                </Link>
                <span className="font-mono">{c.clientCode ?? c.unclaimedMarking}</span>
                <LinkReceiptButtons receiptId={c.id} stops={c.stops} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {canWrite && live && (
        <PickupButtons
          pickupId={pickup.id}
          canArrive={pickup.status !== 'arrived'}
          canCancel={costs.length === 0 && linkedCount === 0}
        />
      )}
    </div>
  );
}
