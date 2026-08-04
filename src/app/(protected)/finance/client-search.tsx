'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface ClientHit {
  id: string;
  clientCode: string;
  name: string;
}

/** Jump to any client's ledger — needed to enter old debts and first payments. */
export function FinanceClientSearch() {
  const t = useTranslations('finance');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);

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
    <div className="relative">
      <input
        className="input font-mono uppercase"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('findClient')}
        autoComplete="off"
      />
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full divide-y divide-line rounded-lg border border-line bg-surface-raised shadow-lg">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="flex w-full items-baseline gap-2 p-3 text-left hover:bg-surface-sunken"
                onClick={() => router.push(`/finance/${hit.id}`)}
              >
                <span className="font-mono font-extrabold text-brand-700">{hit.clientCode}</span>
                <span className="truncate">{hit.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
