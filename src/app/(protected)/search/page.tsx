import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { globalSearch, type SearchHit, type SearchKind } from '@/modules/wms/search/service';

/**
 * The search PAGE — the same answers as the ⌘K palette, from the same
 * function, on a screen that needs no JavaScript.
 *
 * It used to run its own four queries with no scoping at all: any signed-in
 * person could find any box in any warehouse and list the whole client book.
 * Round 58 moved the queries into `wms/search/service.ts`, where every group
 * asks the question its own screen asks.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('search');
  const { q = '' } = await searchParams;
  const query = q.trim();
  const hits = query ? await globalSearch(actor, query) : [];

  // Grouped for reading, in the order the service already sorted them.
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.kind);
    if (list) list.push(hit);
    else groups.set(hit.kind, [hit]);
  }

  return (
    <div className="space-y-4">
      <form method="get">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder={t('placeholder')}
          className="input"
          autoFocus
        />
      </form>

      {query && hits.length === 0 && <p className="text-ink-500">{t('nothing')}</p>}

      {[...groups.entries()].map(([kind, list]) => (
        <section key={kind}>
          <h2 className="mb-1 text-sm font-bold text-ink-500">
            {t(`kind.${kind}` as 'kind.client')}
          </h2>
          {list.map((hit) => (
            <Link
              key={`${hit.kind}-${hit.id}`}
              href={hit.href}
              data-testid="search-hit"
              className="card mb-1 flex items-baseline gap-2 !p-3 hover:bg-surface-sunken"
            >
              <span className="shrink-0 whitespace-nowrap font-mono font-extrabold text-brand-700">
                {hit.code}
              </span>
              {hit.label && <span className="truncate text-ink-700">{hit.label}</span>}
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}
