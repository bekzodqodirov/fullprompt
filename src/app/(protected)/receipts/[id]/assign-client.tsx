'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { assignClientAction } from './edit-actions';

/** Disable-while-submitting (UX audit: double-tap re-fired the action). */
function ConfirmButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary ml-auto disabled:opacity-60">
      {pending ? '…' : `✅ ${label}`}
    </button>
  );
}

interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}

/** Assign / change the receipt's client (unclaimed resolution + mistake fix). */
export function AssignClient({ receiptId, current }: { receiptId: string; current: string | null }) {
  const t = useTranslations('receipts');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [selected, setSelected] = useState<ClientHit | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/clients/search?q=${encodeURIComponent(query)}`);
      if (res.ok) setHits(((await res.json()) as { results: ClientHit[] }).results);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="card space-y-2 !p-3">
      <p className="font-semibold">{current ? t('changeClient') : t('assignClient')}</p>
      {selected ? (
        <form action={assignClientAction} className="flex items-center gap-2">
          <input type="hidden" name="receiptId" value={receiptId} />
          <input type="hidden" name="clientId" value={selected.id} />
          <span className="font-mono font-extrabold text-blue-800">{selected.clientCode}</span>
          <span className="truncate text-sm">{selected.name}</span>
          <ConfirmButton label={t('assignConfirm')} />
          <button type="button" className="btn-secondary" onClick={() => setSelected(null)}>
            ✕
          </button>
        </form>
      ) : (
        <>
          <input
            className="input font-mono uppercase"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="GS777 / 444"
            autoComplete="off"
          />
          {hits.length > 0 && (
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 p-2.5 text-left hover:bg-gray-50"
                    onClick={() => setSelected(hit)}
                  >
                    <span className="font-mono font-extrabold text-blue-800">{hit.clientCode}</span>
                    <span className="truncate text-sm">{hit.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
