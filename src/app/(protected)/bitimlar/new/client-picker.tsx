'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * Which client is this job for?
 *
 * Filtered in the browser over the whole list rather than searched on the
 * server: 1442 clients is a few tens of kilobytes, and a salesperson typing a
 * code wants the answer on the keystroke, not after a round trip. The same
 * choice the receiving screen's client picker already makes.
 */
export function ClientPicker({
  clients,
}: {
  clients: { id: string; code: string; name: string }[];
}) {
  const t = useTranslations('deals');
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clients.slice(0, 30);
    return clients
      .filter(
        (client) =>
          client.code.toLowerCase().includes(needle) ||
          client.name.toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [clients, query]);

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-testid="deal-client-search"
        aria-label={t('forClient')}
        placeholder={t('forClient')}
        className="input"
        autoFocus
      />
      <div className="space-y-1">
        {matches.map((client) => (
          <Link
            key={client.id}
            href={`/bitimlar/new?client=${client.id}`}
            data-testid="deal-client-option"
            className="card block !p-2.5 hover:bg-surface-sunken"
          >
            <span className="num font-bold text-good">{client.code}</span>
            <span className="ml-2">{client.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
