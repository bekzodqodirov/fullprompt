'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CostPanel, type CostKept } from '@/components/cost-panel';

export interface DeskTruck {
  id: string;
  code: string;
  status: string;
  origin: string;
  dest: string;
  formerHit: string | null;
  entries: number;
  usd: number;
  unconverted: number;
}

type PanelProps = Omit<Parameters<typeof CostPanel>[0], 'initial' | 'onKept' | 'onBusy' | 'afterSave' | 'scope'>;

/**
 * The entry page's client half (docs/SARFLAR.md §2, his 5a): the truck
 * picker and ONE truck's CostPanel. It sits ABOVE the panel, which is keyed
 * by the truck, so what one bill leaves for the next — type, currency, date,
 * payer, a proportional basis — survives a switch to another truck; the
 * amount and the note never do. The search and every pick are CLIENT
 * navigations, or the kept values would die with a full page load. The
 * picker is inert while a save or a twin confirm is in flight.
 */
export function CostEntryDesk({
  q,
  trucks,
  total,
  chosenId,
  panel,
}: {
  q: string;
  trucks: DeskTruck[];
  total: number;
  chosenId: string | null;
  panel: PanelProps | null;
}) {
  const t = useTranslations('sarflar');
  const router = useRouter();
  const [kept, setKept] = useState<Partial<CostKept>>({});
  const [busy, setBusy] = useState(false);
  const [needle, setNeedle] = useState(q);
  const usd = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pickHref = (id: string) => `?${new URLSearchParams({ ...(q ? { q } : {}), p: id }).toString()}`;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section className="space-y-2" data-testid="entry-picker" aria-busy={busy}>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const params = new URLSearchParams();
            if (needle.trim()) params.set('q', needle.trim());
            if (chosenId) params.set('p', chosenId);
            router.push(`?${params.toString()}`);
          }}
        >
          <input
            type="search"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder={t('pickerSearch')}
            aria-label={t('pickerSearch')}
            data-testid="entry-search"
            className="input min-w-0 flex-1"
          />
          <button type="submit" className="btn-secondary px-3">
            🔍
          </button>
        </form>
        <p className="text-xs text-ink-500" data-testid="entry-count">
          {t('pickerCount', { shown: trucks.length, total })}
        </p>
        <ul className={`divide-y divide-line rounded-lg border border-line bg-surface ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          {trucks.map((truck) => (
            <li key={truck.id}>
              <Link
                href={pickHref(truck.id)}
                aria-current={truck.id === chosenId ? 'true' : undefined}
                aria-disabled={busy || undefined}
                tabIndex={busy ? -1 : undefined}
                data-testid="entry-truck"
                className={`block space-y-0.5 p-2 text-sm [overflow-wrap:anywhere] ${truck.id === chosenId ? 'bg-brand-50' : ''}`}
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono font-semibold">{truck.code}</span>
                  {truck.status === 'closed' && <span className="text-xs font-semibold text-warn">⚠ {t('closed')}</span>}
                  {truck.entries === 0 && <span className="chip text-xs">{t('noCosts')}</span>}
                  <span className="ml-auto font-mono tabular-nums text-ink-700">${usd(truck.usd)}</span>
                  {truck.unconverted > 0 && (
                    <span className="rounded bg-warn/15 px-1 text-xs font-semibold text-warn">{t('noRate', { count: truck.unconverted })}</span>
                  )}
                </span>
                <span className="block text-xs text-ink-500">
                  {truck.origin} → {truck.dest}
                  {truck.formerHit && <> · {t('formerName', { name: truck.formerHit })}</>}
                </span>
              </Link>
            </li>
          ))}
          {trucks.length === 0 && <li className="p-3 text-sm text-ink-500">{t('pickerEmpty')}</li>}
        </ul>
      </section>
      <section className="min-w-0">
        {panel && chosenId ? (
          <CostPanel
            key={chosenId}
            scope="batch"
            {...panel}
            afterSave="again"
            initial={kept}
            onKept={setKept}
            onBusy={setBusy}
          />
        ) : (
          <p className="card text-sm text-ink-500">{t('pickFirst')}</p>
        )}
      </section>
    </div>
  );
}
