import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { IncomingTruck } from '@/modules/wms/pickups/service';

/**
 * «Zavoddan kelayotgan yuk» (0100): the factory trucks heading here, truck →
 * factory → owner, and only what has not been received from them yet — the
 * list empties itself as the prixods land. Each owner's «Qabul qilish» opens
 * the wizard pre-filled with that factory's lines, counts left to recount.
 *
 * A fold, closed unless a truck has already arrived: the receive screen is
 * the warehouse's busiest and most of its work is not a factory truck.
 */
export async function IncomingPickups({ trucks }: { trucks: IncomingTruck[] }) {
  const t = await getTranslations('pickups');
  const arrived = trucks.some((truck) => truck.status === 'arrived');
  return (
    <details className="card mb-3" data-testid="incoming-pickups" open={arrived}>
      <summary className="cursor-pointer text-sm font-semibold">
        🏭 {t('incomingTitle')} · {trucks.length}
      </summary>
      <ul className="mt-2 space-y-3">
        {trucks.map((truck) => (
          <li key={truck.pickupId} data-testid="incoming-truck" className="border-t border-line pt-2 text-sm">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono font-bold">{truck.code}</span>
              <span className="text-xs text-ink-500">{t(`status.${truck.status}`)}</span>
              {truck.vehiclePlate && <span className="text-xs text-ink-500">{truck.vehiclePlate}</span>}
              {truck.driverPhone && (
                <a className="text-xs text-brand-700 underline" href={`tel:${truck.driverPhone}`}>
                  {truck.driverName ?? truck.driverPhone}
                </a>
              )}
            </p>
            {truck.stops
              .filter((stop) => stop.owners.length)
              .map((stop) => (
                <div key={stop.id} className="mt-1 pl-2">
                  <p className="text-xs font-semibold text-ink-700">
                    {stop.seq}. {stop.factoryName} {stop.collected ? '✓' : `· ${t('notCollected')}`}
                  </p>
                  <ul className="space-y-1">
                    {stop.owners.map((owner) => (
                      <li key={owner.ownerKey} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="font-mono font-semibold">
                            {owner.clientCode ?? owner.marking}
                          </span>{' '}
                          <span className="text-xs text-ink-500">
                            {owner.lines
                              .map((line) => `${line.goods} · ${line.factoryBoxes} 📦`)
                              .join(' / ')}
                          </span>
                        </span>
                        <Link
                          data-testid="incoming-receive"
                          className="btn-secondary shrink-0 !min-h-9 !px-2 !py-1 text-xs"
                          href={`/receive?pickup=${stop.id}&c=${encodeURIComponent(owner.ownerKey)}`}
                        >
                          {t('receiveThis')}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
