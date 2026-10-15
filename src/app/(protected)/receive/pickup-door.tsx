'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OpenStopForOwner } from '@/modules/wms/pickups/service';

/**
 * The receive door's question (his 3a, docs/ZAVOD-YOPISH.md §3): «Bu yuk
 * ZR-… reysidan keldimi?». Asked the moment the owner is known — a client
 * chosen or a marking accepted — and only about OPEN trips heading here that
 * still carry an unanswered line of that owner. Nothing is linked by itself:
 * «Ha» is the operator's answer, «Yo'q» is remembered on the draft so the
 * question does not come back for that trip.
 *
 * Silent when the lookup fails or the network is down: the receipt of real
 * boxes must never wait on this (the deal picker's rule), and the trip's
 * card still offers the prixod to the logist afterwards.
 */
export function PickupDoorQuestion({
  warehouseId,
  clientId,
  marking,
  declined,
  onAccept,
  onDecline,
}: {
  warehouseId: string;
  clientId: string | null;
  marking: string | null;
  declined: string[];
  onAccept: (stop: OpenStopForOwner) => void;
  onDecline: (stopId: string) => void;
}) {
  const t = useTranslations('receive');
  const owner = clientId ? `c=${clientId}` : marking ? `m=${encodeURIComponent(marking)}` : '';
  const key = warehouseId && owner ? `${warehouseId}&${owner}` : '';
  // The answer is kept WITH the question it answers: a stale answer for the
  // previous owner never renders under the new one.
  const [answer, setAnswer] = useState<{ key: string; stops: OpenStopForOwner[] }>({ key: '', stops: [] });
  // The question lands a second after the pick (China → server); the buttons
  // wake 400 ms later so a thumb already moving to the goods field cannot
  // press «Ha» by accident (the judge's floor finding).
  const [armed, setArmed] = useState('');

  useEffect(() => {
    if (!key) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetch(`/api/receive/pickups?wh=${key}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { stops: [] }))
      .then((body: { stops?: OpenStopForOwner[] }) => {
        if (!current) return;
        setAnswer({ key, stops: body.stops ?? [] });
        timer = setTimeout(() => {
          if (current) setArmed(key);
        }, 400);
      })
      .catch(() => {
        if (current) setAnswer({ key, stops: [] });
      });
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  const stops = answer.key === key ? answer.stops : [];
  const shown = stops.filter((s) => !declined.includes(s.stopId));
  if (!shown.length) return null;
  const ready = armed === key;
  // One owner on two factories of one truck: one prixod per factory.
  const multiStop = new Set(shown.map((s) => s.pickupId)).size < shown.length;
  return (
    <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50 p-2.5 text-sm" data-testid="pickup-door">
      <p className="font-semibold">🏭 {t('pickupDoorTitle')}</p>
      {multiStop && <p className="text-xs text-ink-700">{t('pickupDoorPerFactory')}</p>}
      {shown.map((stop) => (
        <div key={stop.stopId} className="space-y-1 border-t border-brand-200 pt-2 first:border-t-0 first:pt-0" data-testid="pickup-door-stop">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono font-bold">{stop.code}</span>
            <span>
              {stop.seq}. {stop.factoryName}
            </span>
            {stop.vehiclePlate && <span className="text-xs text-ink-500">{stop.vehiclePlate}</span>}
          </p>
          <ul className="text-xs text-ink-700">
            {stop.lines.map((line) => (
              <li key={line.id} className="[overflow-wrap:anywhere]">
                {line.goods} · {t('pickupDoorCount', { factory: line.factoryBoxes, driver: line.driverBoxes ?? '—' })}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="pickup-door-yes"
              className="btn-primary !min-h-9 flex-1 !py-1 text-sm"
              disabled={!ready}
              onClick={() => onAccept(stop)}
            >
              {t('pickupDoorYes')}
            </button>
            <button
              type="button"
              data-testid="pickup-door-no"
              className="btn-secondary !min-h-9 flex-1 !py-1 text-sm"
              disabled={!ready}
              onClick={() => onDecline(stop.stopId)}
            >
              {t('pickupDoorNo')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
