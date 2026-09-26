'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LightboxImg } from '@/components/lightbox-img';
import type { PlaceCargoLot } from '@/modules/wms/tracking/place-cargo';

/**
 * The tapped place's cargo, lot by lot — photo, goods, whose, how much, and
 * the day it was received (the owner, 2026-09-26, item 2). Fetched on the
 * tap: the page carries only the chips, so a big warehouse costs nothing
 * until somebody opens it. On `/map?mijoz=` only that client's lots.
 */
const day = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Tashkent',
  }).format(new Date(iso));

export function PlaceCargo({
  place,
  clientCode,
}: {
  place: { wh: string } | { batch: string };
  clientCode: string | null;
}) {
  const t = useTranslations('map');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; lots: PlaceCargoLot[]; total: number }
  >({ kind: 'loading' });
  const query = new URLSearchParams(
    'wh' in place ? { wh: place.wh } : { batch: place.batch },
  );
  if (clientCode) query.set('mijoz', clientCode);
  const key = query.toString();

  useEffect(() => {
    // A new place remounts this component (the popup keys it by place), so
    // the first state is always «loading» and nothing is reset here.
    let live = true;
    fetch(`/api/map/cargo?${key}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { lots: PlaceCargoLot[]; total: number };
        if (live) setState({ kind: 'ready', ...body });
      })
      .catch(() => live && setState({ kind: 'failed' }));
    return () => {
      live = false;
    };
  }, [key]);

  if (state.kind === 'loading') return <p className="text-xs text-ink-500">{t('cargoLoading')}</p>;
  if (state.kind === 'failed') return <p className="text-xs text-bad">{t('cargoFailed')}</p>;
  if (state.lots.length === 0) return null;
  return (
    <div className="space-y-2 border-t border-line pt-2" data-testid="map-place-cargo">
      {state.lots.map((lot) => (
        <div key={lot.lotId} className="flex gap-2" data-testid="map-place-lot">
          {lot.photoId ? (
            <LightboxImg attachmentId={lot.photoId} alt={lot.goods} className="h-12 w-12 rounded object-cover" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-surface-sunken text-lg">
              📦
            </span>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-semibold [overflow-wrap:anywhere]">
              <span className="font-mono">{lot.clientCode}</span> · {lot.goods}
            </p>
            <p className="tabular-nums text-ink-700">
              {lot.boxes} 📦
              {lot.kg !== null && ` · ${lot.kg} kg`}
              {lot.m3 !== null && ` · ${lot.m3} m³`}
            </p>
            <p className="text-ink-500">
              {t('cargoReceived', { date: day(lot.receivedAt) })} ·{' '}
              <Link href={`/receipts/${lot.receiptId}`} className="font-mono text-brand-700 underline">
                {lot.receiptNumber ?? '—'}
              </Link>
            </p>
          </div>
        </div>
      ))}
      {state.total > state.lots.length && (
        <p className="text-xs text-ink-500">{t('cargoMore', { n: state.total - state.lots.length })}</p>
      )}
    </div>
  );
}
