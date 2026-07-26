'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createArrivalAction, type ArrivalFormState } from './actions';

interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}

/**
 * "A client is sending us cargo" — written days before any of it exists.
 *
 * The client is picked by searching, not from a dropdown: there are three
 * hundred codes and a `<select>` of three hundred options is unusable on a
 * phone. Someone with no code yet is recorded by the marking that will be
 * written on their boxes, which is the same string the unclaimed pool uses.
 */
export function ArrivalForm({
  warehouses,
  today,
}: {
  warehouses: { id: string; code: string }[];
  today: string;
}) {
  const t = useTranslations('arrivals');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<ArrivalFormState, FormData>(
    createArrivalAction,
    {},
  );
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [picked, setPicked] = useState<ClientHit | null>(null);

  useEffect(() => {
    if (!query.trim() || picked) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/clients/search?q=${encodeURIComponent(query)}`);
      if (res.ok) setHits(((await res.json()) as { results: ClientHit[] }).results);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, picked]);

  return (
    <form action={formAction} className="space-y-2.5">
      <div className="flex gap-2">
        <select name="warehouseId" aria-label={t('warehouse')} className="input !w-28 shrink-0 font-mono font-bold">
          {warehouses.map((wh) => (
            <option key={wh.id} value={wh.id}>
              {wh.code}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="expectedOn"
          aria-label={t('expectedOn')}
          className="input min-w-0 flex-1"
          defaultValue={today}
        />
      </div>

      <div className="relative">
        <input type="hidden" name="clientId" value={picked?.id ?? ''} />
        <input
          aria-label={t('client')}
          data-testid="arrival-client"
          className="input font-mono uppercase"
          value={picked ? `${picked.clientCode} — ${picked.name}` : query}
          onChange={(event) => {
            setPicked(null);
            setQuery(event.target.value);
          }}
          placeholder={t('clientPlaceholder')}
          autoComplete="off"
        />
        {hits.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto divide-y divide-line rounded-lg border border-line bg-surface-raised shadow-lg">
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-surface-sunken"
                  onClick={() => {
                    setPicked(hit);
                    setHits([]);
                  }}
                >
                  <span className="font-mono font-extrabold text-brand-700">{hit.clientCode}</span>
                  <span className="truncate text-sm">{hit.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-2">
        <input
          name="marking"
          aria-label={t('marking')}
          className="input min-w-0 flex-1"
          placeholder={t('markingPlaceholder')}
          maxLength={200}
        />
        <input
          name="boxCount"
          aria-label={t('boxCount')}
          className="input !w-24 shrink-0 text-center"
          inputMode="numeric"
          placeholder="📦"
        />
      </div>

      <input name="note" aria-label={t('note')} className="input" placeholder={t('note')} maxLength={2000} />

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {state.error === 'who_required' ? t('whoRequired') : tc('error')}
        </p>
      )}
      <button
        type="submit"
        data-testid="save-arrival"
        disabled={pending}
        className="btn-primary w-full disabled:opacity-60"
      >
        {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
      </button>
    </form>
  );
}
