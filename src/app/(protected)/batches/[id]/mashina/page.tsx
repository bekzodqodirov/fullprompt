import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { inScope } from '@/modules/platform/rbac/scope';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { loadBatchHead } from '@/modules/wms/batches/card-head';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { devicesForBatch } from '@/modules/wms/tracking/devices';
import { Panel } from '@/components/panel';
import {
  createDriverDeviceAction,
  revokeDriverDeviceAction,
  setTrackingCheckpointAction,
} from '../../batch-actions-server';
import { BatchCard, batchTabMetadata } from '../batch-card';
import { VehicleForm } from '../vehicle-form';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return batchTabMetadata((await params).id, 'mashina');
}

/**
 * «Mashina» — the truck itself: plate and driver, the driver's phone, and the
 * logist's «where is it» pins (docs/CARD-TABS.md). They were the card's rail,
 * folded panels a loader scrolled past; here they are the page, so each
 * section is open. The ETA is the header's — said once.
 *
 * The door is the card's own; each control keeps its own door, unchanged.
 */
export default async function BatchTruckTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const head = await loadBatchHead(id);
  if (!head) notFound();
  if (!mayOpenBatchCard(actor, head.batch)) notFound();
  const { batch } = head;
  const t = await getTranslations('batches');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const canVehicle = actor.permissions.has('batches.vehicle_info');
  const open = !['closed', 'cancelled'].includes(batch.status);
  const devices = canVehicle ? await devicesForBatch(id) : [];
  // /map lets in only the batch readers (read-door.ts); a link it bounces is
  // worse than none (#1023).
  const mapDoor = mayReadBatches(actor.permissions);
  const checkpointKey = (batch.trackingCheckpoint as { key?: string } | null)?.key ?? null;

  return (
    <BatchCard head={head} actor={actor} active="mashina">
      <div className="max-w-2xl space-y-4">
        {/* Editable until the batch closes — a wrong plate must be fixable even
            after departure — by whoever `saveVehicleAction` admits: the
            permission AT THE ORIGIN. It was drawn to a destination-scoped
            holder whose save then answered «forbidden». */}
        <Panel title={`🚛 ${t('vehicleTitle')}`} badge={batch.vehiclePlate || undefined} open>
          {canVehicle && open && inScope(actor, batch.originWarehouseId) ? (
            <VehicleForm
              batchId={batch.id}
              vehiclePlate={batch.vehiclePlate ?? ''}
              driverName={batch.driverName ?? ''}
              driverPhone={batch.driverPhone ?? ''}
            />
          ) : (
            <p className="text-sm">
              <span className="font-mono font-bold">{batch.vehiclePlate || '—'}</span>
              {batch.driverName && ` · ${batch.driverName}`}
              {batch.driverPhone && ` · ${batch.driverPhone}`}
            </p>
          )}
        </Panel>

        {/* Driver phone (owner's flow): while the truck is being loaded the
            warehouse worker installs the app on the driver's phone and types
            this code once. Android then streams real positions; iPhone /
            HarmonyOS stay on the manual pins below. */}
        {canVehicle && open && (
          <Panel
            title={`📲 ${t('driverPhone')}`}
            badge={devices.find((d) => d.pairCode)?.pairCode ?? (devices.length > 0 ? '✅' : undefined)}
            testId="batch-driver-panel"
            open
          >
            {devices.length === 0 && <p className="text-xs text-ink-500">{t('driverPhoneHint')}</p>}
            {/* A paired phone on a moving truck IS the reason somebody opens
                the map (owner: «ulangan telefonni kirgizganda tagida kartaga
                o'tish havolasi turar edi»). */}
            {batch.status === 'in_transit' && devices.some((d) => !d.pairCode) && mapDoor && (
              <Link
                href="/map"
                className="block text-sm font-semibold text-brand-700 underline"
                data-testid="device-map-link"
              >
                🗺 {t('openMap')} →
              </Link>
            )}
            {devices.map((device) => (
              <div key={device.id} className="flex flex-wrap items-center gap-2 border-b border-line pb-2 text-sm last:border-0">
                {device.pairCode ? (
                  <>
                    <span className="font-mono text-2xl font-extrabold tracking-widest text-brand-700">
                      {device.pairCode}
                    </span>
                    <span className="text-xs text-ink-500">{t('pairCodeHint')}</span>
                  </>
                ) : (
                  <span className="font-semibold text-good">
                    ✅ {device.label || t('driverPhone')}
                    {device.lastSeenAt
                      ? ` · ${t('lastSeen', { when: format.dateTime(new Date(device.lastSeenAt), { dateStyle: 'short', timeStyle: 'short' }) })}`
                      : ` · ${t('noFixesYet')}`}
                    {device.fixes > 0 && ` · ${device.fixes} 📍`}
                  </span>
                )}
                <form action={revokeDriverDeviceAction} className="ml-auto">
                  <input type="hidden" name="deviceId" value={device.id} />
                  <input type="hidden" name="batchId" value={batch.id} />
                  <button type="submit" className="text-xs font-semibold text-bad underline">
                    ✖ {tc('delete')}
                  </button>
                </form>
              </div>
            ))}
            <form action={createDriverDeviceAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="batchId" value={batch.id} />
              <input
                name="label"
                className="input min-w-40 flex-1"
                placeholder={batch.driverName || t('driverPhoneLabel')}
                maxLength={100}
              />
              <button type="submit" className="btn-secondary whitespace-nowrap px-3">
                📲 {t('newPairCode')}
              </button>
            </form>
          </Panel>
        )}

        {/* Tracking map pins: the logist marks where the truck ACTUALLY is —
            the map's estimate re-anchors from that moment (owner's feature). */}
        {batch.status === 'in_transit' && canVehicle && (
          <Panel
            title={`📍 ${t('whereIsTruck')}`}
            badge={
              checkpointKey
                ? t(checkpointKey === 'at_border' ? 'cpBorder' : checkpointKey === 'in_kg' ? 'cpKg' : 'cpUz')
                : undefined
            }
            testId="batch-where-panel"
            open
          >
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['at_border', `🛃 ${t('cpBorder')}`],
                  ['in_kg', `🇰🇬 ${t('cpKg')}`],
                  ['in_uz', `🇺🇿 ${t('cpUz')}`],
                ] as const
              ).map(([key, label]) => {
                const active = checkpointKey === key;
                return (
                  <form key={key} action={setTrackingCheckpointAction} className="flex-1">
                    <input type="hidden" name="batchId" value={batch.id} />
                    <input type="hidden" name="key" value={key} />
                    <button
                      type="submit"
                      className={`w-full whitespace-nowrap rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
                        active ? 'border-blue-700 bg-brand-50 text-brand-700' : 'border-line text-ink-700'
                      }`}
                    >
                      {label}
                    </button>
                  </form>
                );
              })}
            </div>
          </Panel>
        )}

        {mapDoor && (
          <Link href="/map" className="block text-sm font-semibold text-brand-700 underline" data-testid="batch-map-link">
            🗺 {t('openMap')} →
          </Link>
        )}
      </div>
    </BatchCard>
  );
}
