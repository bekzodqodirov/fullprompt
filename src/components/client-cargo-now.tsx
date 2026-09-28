import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { groupDigits } from '@/modules/platform/telegram/format';
import type { CargoNow, NowRow, NowSection } from '@/modules/wms/inventory/client-cargo-fold';
import { capRows, NOW_SECTIONS } from '@/modules/wms/inventory/client-cargo-fold';
import type { NowSibling, NowTruck } from '@/modules/wms/client-card/yuklar-view';
import type { TruckRow } from '@/modules/wms/tracking/on-road-state';
import { LightboxImg } from './lightbox-img';
import { truckRoadWords } from './truck-road';

/** In-page anchors — the Uzbek words, so a shared link reads as what it opens. */
export const SECTION_ANCHOR: Record<NowSection, string> = {
  china: 'xitoy',
  transit: 'tranzit',
  uz: 'uz',
  ready: 'tayyor',
};

/**
 * «Yuklar» — where this client's cargo is right now, section by section.
 *
 * A server component over the fold's output (`inventory/client-cargo-fold.ts`)
 * and the page's door answers: every link it draws was asked of the door of
 * the page it opens — a prixod of `receiptsReadableBy`, a truck of
 * `mayOpenBatchCard` — and a photograph is drawn only where the row's cargo
 * stands near the reader (the attachment gate's own rule, so a drawn photo is
 * always served). It prints no money: the tab has none, by the owner's rule.
 */
export async function ClientCargoNow({
  now,
  trucks,
  road,
  photos,
  photoRows,
  receiptsOpen,
  siblings,
  full,
  fullHref,
}: {
  now: CargoNow;
  trucks: ReadonlyMap<string, NowTruck>;
  road: ReadonlyMap<string, TruckRow>;
  photos: ReadonlyMap<string, string>;
  photoRows: ReadonlySet<string>;
  receiptsOpen: ReadonlySet<string>;
  siblings: readonly NowSibling[];
  full: boolean;
  fullHref: string;
}) {
  const t = await getTranslations('yuklar');
  const { word, sentence } = await truckRoadWords({ counts: false });
  const label: Record<NowSection, string> = {
    china: t('sections.china'),
    transit: t('sections.transit'),
    uz: t('sections.uz'),
    ready: t('sections.ready'),
  };
  const status: Record<string, string> = {
    in_stock: t('status.in_stock'),
    planned: t('status.planned'),
    loading: t('status.loading'),
    in_transit: t('status.in_transit'),
    ready_for_pickup: t('status.ready_for_pickup'),
  };
  const filled = NOW_SECTIONS.filter((s) => now.sections[s].rows.length > 0);

  // «5 📦 · 12.5 kg · 0.25 m³» as nowrap spans with the «·» INSIDE the span
  // that follows it, so a wrap never orphans a separator (#624).
  const size = (n: number, kg: number | null, m3: number | null, testId?: string) => (
    <span className="flex flex-wrap gap-x-1 font-mono tabular-nums" data-testid={testId}>
      <span className="whitespace-nowrap">{groupDigits(n)} 📦</span>
      {kg !== null && <span className="whitespace-nowrap">· {groupDigits(kg)} kg</span>}
      {m3 !== null && <span className="whitespace-nowrap">· {groupDigits(m3)} m³</span>}
    </span>
  );

  const truckLink = (id: string | null) => {
    const truck = id ? trucks.get(id) : undefined;
    if (!id || !truck) return <span className="text-ink-500">{t('unknownTruck')}</span>;
    const code = <span className="font-mono font-semibold">{truck.code}</span>;
    return truck.open ? (
      <Link href={`/batches/${id}`} className="text-brand-700 underline" data-testid="yuklar-truck-link">
        {code}
      </Link>
    ) : (
      code
    );
  };

  const place = (row: NowRow) => {
    if (row.truckId !== null || row.warehouseId === null) {
      const truck = row.truckId ? trucks.get(row.truckId) : undefined;
      const onRoad = row.truckId ? road.get(row.truckId) : undefined;
      return (
        <div className="text-xs text-ink-700">
          <p className="flex flex-wrap gap-x-1">
            <span>🚚</span>
            {truckLink(row.truckId)}
            {truck && (
              <span className="font-mono text-ink-500">
                ({truck.originCode} → {truck.destCode})
              </span>
            )}
            {onRoad && <span className="font-semibold">· {word(onRoad)}</span>}
          </p>
          {onRoad && <p className="text-ink-500">{sentence(onRoad)}</p>}
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-x-2 text-xs text-ink-700">
        <span className="whitespace-nowrap">
          🏭 <span className="font-mono font-semibold">{row.whCode ?? '—'}</span>
          {row.days !== null && (
            <span data-testid="yuklar-days"> · {t('daysHere', { n: row.days })}</span>
          )}
        </span>
        {row.arrivedOn.length > 0 && (
          <span className="flex flex-wrap gap-x-1" data-testid="yuklar-arrived-on">
            <span>🚚 {t('arrivedOn')}</span>
            {row.arrivedOn.map((a, i) => (
              <span key={`${a.id}-${i}`}>
                {i > 0 && ', '}
                {truckLink(a.id || null)}
              </span>
            ))}
          </span>
        )}
      </div>
    );
  };

  const parts = (row: NowRow) => {
    // A single part on the shelf or at the door says nothing the section has
    // not said; a planned/loading one names the truck it is going onto.
    const worth = row.parts.length > 1 || row.parts.some((p) => p.truckId !== null);
    if (!worth) return null;
    return (
      <p className="flex flex-wrap gap-x-1 text-xs text-ink-500" data-testid="yuklar-parts">
        {row.parts.map((p, i) => (
          <span key={`${p.status}-${p.truckId ?? ''}`} className="whitespace-nowrap">
            {i > 0 && '· '}
            {status[p.status] ?? p.status} {p.n}
            {p.truckId && (
              <>
                {' → '}
                {truckLink(p.truckId)}
              </>
            )}
          </span>
        ))}
      </p>
    );
  };

  return (
    <div className="space-y-3" data-testid="yuklar-now">
      <div className="card space-y-2 !p-3">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="section-title">{t('now')}</span>
          <b data-testid="yuklar-total">{size(now.total.boxes, now.total.kg, now.total.m3)}</b>
        </p>
        {filled.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {filled.map((s) => (
              <a
                key={s}
                href={`#${SECTION_ANCHOR[s]}`}
                data-testid={`yuklar-chip-${s}`}
                className="chip-neutral whitespace-nowrap"
              >
                {label[s]} · {groupDigits(now.sections[s].total.boxes)}
              </a>
            ))}
          </div>
        )}
        {/* What an unload declared missing on the road: its own warn line,
            OUTSIDE every section and the Σ — «O'zbekistonda» would be a claim
            the system has already withdrawn (the tab's judge, finding 1). The
            truck's «Yuklash» tab is where it is resolved. */}
        {now.missing.map((m) => {
          const truck = m.truckId ? trucks.get(m.truckId) : undefined;
          return (
            <p key={m.truckId ?? '-'} className="text-sm font-semibold text-warn" data-testid="yuklar-missing">
              ⚠ {t('missing')}: {groupDigits(m.n)} 📦
              {truck && (
                <>
                  {' · '}
                  {truck.open ? (
                    <Link
                      href={`/batches/${m.truckId}/yuklash#missing`}
                      className="font-mono underline"
                      data-testid="yuklar-missing-link"
                    >
                      {truck.code}
                    </Link>
                  ) : (
                    <span className="font-mono">{truck.code}</span>
                  )}
                </>
              )}
            </p>
          );
        })}
      </div>

      {/* The same person's other codes (round 25/32 — a shared phone is one
          person). Chips, never merged: a code's deals, ledger and lots are the
          code's own (#407), and the Σ above is this code's alone. */}
      {siblings.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="yuklar-siblings">
          <span className="text-xs text-ink-500">{t('siblings')}</span>
          {siblings.map((s) => (
            <Link
              key={s.id}
              href={`/admin/clients/${s.id}/yuklar`}
              className="chip-neutral whitespace-nowrap"
              data-testid="yuklar-sibling"
            >
              <span className="font-mono">{s.code}</span> · {groupDigits(s.boxes)} 📦 →
            </Link>
          ))}
        </div>
      )}

      {filled.length === 0 && now.missing.length === 0 && (
        <p className="card text-sm text-ink-500" data-testid="yuklar-empty">
          {t('empty')}
        </p>
      )}

      {filled.map((s) => {
        const section = now.sections[s];
        const { drawn, more } = capRows(section.rows, full);
        return (
          <section
            key={s}
            id={SECTION_ANCHOR[s]}
            data-testid={`yuklar-section-${s}`}
            className="card scroll-mt-20 space-y-1 !p-3"
          >
            <h2 className="flex flex-wrap items-baseline gap-x-2 text-base font-bold">
              <span>{label[s]}</span>
              <span className="text-sm font-normal text-ink-500" data-testid="yuklar-section-total">
                {size(section.total.boxes, section.total.kg, section.total.m3)}
              </span>
            </h2>
            <ul>
              {drawn.map((row) => {
                const photo = photoRows.has(row.key) ? photos.get(row.lotId) : undefined;
                return (
                  <li
                    key={row.key}
                    data-testid="yuklar-row"
                    data-section={s}
                    data-boxes={row.n}
                    className="flex gap-3 border-b border-line py-2 last:border-0"
                  >
                    {photo ? (
                      <LightboxImg attachmentId={photo} className="h-14 w-14 rounded-lg object-cover" />
                    ) : (
                      <span aria-hidden className="h-14 w-14 shrink-0 rounded-lg bg-surface-sunken" />
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                      <p className="font-semibold [overflow-wrap:anywhere]">
                        {row.letter && <span className="font-mono">{row.letter} · </span>}
                        {row.name}
                      </p>
                      {row.marking && (
                        <p className="text-xs text-ink-500 [overflow-wrap:anywhere]">
                          {t('marking')}: <span className="font-mono">{row.marking}</span>
                        </p>
                      )}
                      <div className="text-ink-700">{size(row.n, row.kg, row.m3, 'yuklar-row-size')}</div>
                      {parts(row)}
                      {place(row)}
                      <p className="text-xs text-ink-500">
                        {t('receipt')}{' '}
                        {receiptsOpen.has(row.receiptId) ? (
                          <Link
                            href={`/receipts/${row.receiptId}`}
                            className="font-mono text-brand-700 underline"
                            data-testid="yuklar-receipt-link"
                          >
                            {row.receiptNumber ?? '—'}
                          </Link>
                        ) : (
                          <span className="font-mono">{row.receiptNumber ?? '—'}</span>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {more > 0 && (
              <p className="text-sm">
                <span className="text-ink-500">+{groupDigits(more)} · </span>
                <Link href={fullHref} className="text-brand-700 underline" data-testid="yuklar-show-all">
                  {t('showAll')}
                </Link>
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
