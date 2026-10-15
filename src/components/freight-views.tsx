'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { bandText, clientCentsOf, lotCents } from '@/modules/wms/costing/freight-split';
import { HELD_KEY } from '@/modules/wms/costing/freight-errors';
import type { FreightHeld, LotIdentity, LotView, SplitView } from '@/modules/wms/costing/freight-types';

/**
 * How a yo'lkira-tarifi split is DRAWN (docs/YOLKIRA-TAQSIMOT.md §6.2, §7) —
 * the preview under the amount, the note after a held save, the fold on a
 * saved bill and the re-basis preview all draw through these, so one band or
 * one held reason is never worded two ways (#513). Two lines per row at
 * 360 px; every line `min-w-0 break-words` (a 40-character unclaimed marking
 * has no break in it, #400).
 *
 * His 2b (2026-10-15): the split is per LOT, drawn per CLIENT — one row per
 * client, as before, and a client with several lots opens them under its
 * row. The lots of a closed client are not in the DOM at all (a 150-lot
 * truck must not be 150 rows inside the cost form — round 68's /stock).
 *
 * VALUE imports only from the pure costing modules (freight-split,
 * freight-errors) and types from freight-types — never from a module that
 * reaches the database (#276, fenced).
 */

const MORE_AFTER = 5;
/** The add form's preview shows this many clients until «+N mijoz» (judge J9). */
export const FREIGHT_PREVIEW_CAP = 5;
const fmt = (n: number, digits: number) => String(Math.round(n * 10 ** digits) / 10 ** digits);

function useBand() {
  const t = useTranslations('costing');
  return (band: LotView['band'], money: boolean) => {
    const b = bandText(band, { money });
    return t(b.key, { range: b.range, price: b.price });
  };
}

/**
 * A lot as a person names it: «GS777-A · Yostiq» — the goods are why a lot
 * row exists (2b). A CLAIMED lot keeps its unclaimed marking as its label
 * («470-A»: the carton says so), so its client's code goes in front, or a
 * one-lot client's row named nobody (the review as built — the ✎ rows above
 * it say «GS500»).
 */
export const lotName = (
  lot: Pick<LotIdentity, 'label' | 'goods' | 'clientKey' | 'clientLabel'>,
  opts: { underClient?: boolean } = {},
) => {
  const head =
    !opts.underClient && lot.clientKey.startsWith('c:') && !lot.label.startsWith(lot.clientLabel)
      ? `${lot.clientLabel} · ${lot.label}`
      : lot.label;
  return lot.goods ? `${head} · ${lot.goods}` : head;
};

/** A held bill's reasons, measure first, then the light lots, each lightest first. */
export function FreightHeldLines({ held, limit }: { held: FreightHeld; limit: number }) {
  const t = useTranslations('costing');
  if (held.reason !== 'cargo') {
    return <p className="min-w-0 break-words">{t(HELD_KEY[held.reason])}</p>;
  }
  return (
    <div className="space-y-1">
      {held.measureMissing.slice(0, MORE_AFTER).map((lot) => (
        <p key={lot.lotId} className="min-w-0 break-words">
          {/* A new tab: in the preview a same-tab click threw the typed
              amount and note away (the fix links' own rule, SP-5). */}
          <a className="underline" href={`/receipts/${lot.receiptId}`} target="_blank" rel="noopener">
            {t('freightHeldMeasure', { lot: lotName(lot) })}
          </a>
        </p>
      ))}
      {held.measureMissing.length > MORE_AFTER && <p>{t('freightHeldMore', { n: held.measureMissing.length - MORE_AFTER })}</p>}
      {held.tooLight.slice(0, MORE_AFTER).map((lot) => (
        <p key={lot.lotId} className="min-w-0 break-words">
          <a className="underline" href={`/receipts/${lot.receiptId}`} target="_blank" rel="noopener">
            {t('freightHeldLight', {
              lot: lotName(lot),
              m3: fmt(lot.m3, 3),
              kg: fmt(lot.kg, 3),
              density: lot.density ?? '—',
              limit,
            })}
          </a>
        </p>
      ))}
      {held.tooLight.length > MORE_AFTER && <p>{t('freightHeldMore', { n: held.tooLight.length - MORE_AFTER })}</p>}
      <p>{t('freightHeldFix')}</p>
    </div>
  );
}

/** The note a held SAVE leaves, outside the form (the truck tab closes it on success). */
export function FreightHeldNote({ held, limit }: { held: FreightHeld | null; limit: number }) {
  const t = useTranslations('costing');
  if (!held) return null;
  return (
    <div role="status" className="rounded-lg bg-warn/10 p-2 text-sm text-warn" data-testid="freight-held">
      <p className="font-semibold">{t('freightHeldTitle')}</p>
      <FreightHeldLines held={held} limit={limit} />
    </div>
  );
}

/**
 * The lots of a split, drawn per client (§15.4): «client · N lot · m³», then
 * the client's % (and, under money sight, its dollars — the SUM of its lots'
 * cents, `clientCentsOf`, so a client header and the lots under it can never
 * differ by a cent); a one-lot client prints its lot's band on its own row, a
 * client with several lots opens them. The cents are split over the LOTS by
 * `lotCents` (a typed preview) or read from the allocations per lot (a saved
 * bill, or the re-basis after-state computed on the server).
 *
 * `cap` (the add form's always-open preview only, judge J9): on a 40-client
 * truck the preview stood between the amount and «kim to'ladi» / Saqlash, on
 * every bill of the accountant's loop. Capped, it draws a summary line, the
 * first `cap` clients (the largest shares — the rollup's order) and one
 * «+N mijoz» button; the cents are split over ALL lots before the cut, so the
 * hidden clients' dollars on the button and the visible ones add up to the
 * bill. The saved fold and the re-basis fold are opened by a press already,
 * and stay whole.
 */
export function FreightLotRows({
  view,
  money,
  amount,
  currency,
  limit,
  cents,
  testid = 'freight-row',
  saved = false,
  cap,
}: {
  view: SplitView;
  money: boolean;
  /** The typed amount (preview) — or null where the dollars come from `cents`. */
  amount: number | null;
  currency: string;
  limit: number;
  /** The cents per LOT key the server computed (a saved bill, the re-basis after-state). */
  cents?: Record<string, number>;
  testid?: string;
  /** A SAVED bill's fold: a held one «was saved and not split», not «will be». */
  saved?: boolean;
  /** Show only this many clients until «+N mijoz» is pressed. */
  cap?: number;
}) {
  const t = useTranslations('costing');
  const band = useBand();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [all, setAll] = useState(false);
  if (view.kind === 'nothing') return <p className="text-sm text-ink-500">{t('freightHeldNothing')}</p>;
  if (view.kind === 'held') {
    return (
      <div className="text-sm text-warn" data-testid="freight-preview-held">
        <p className="font-semibold">{t(saved ? 'freightHeldTitle' : 'freightPreviewHeld')}</p>
        <FreightHeldLines held={view.held} limit={limit} />
      </div>
    );
  }
  const byLot: Record<string, number> | null = cents
    ? cents
    : money && amount !== null && amount > 0
      ? lotCents(amount, view.lots.map((l) => ({ key: l.key, weight: l.share })))
      : null;
  const byClient = byLot ? clientCentsOf(view.lots, byLot) : {};
  const unit = cents ? 'USD' : currency;
  const money$ = (usd: number | undefined) => (money && usd !== undefined ? ` · ${usd.toFixed(2)} ${unit}` : '');
  const byKey = new Map(view.lots.map((l) => [l.key, l]));
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const capped = cap !== undefined && view.clients.length > cap && !all;
  const shown = capped ? view.clients.slice(0, cap) : view.clients;
  const hidden = capped ? view.clients.slice(cap) : [];
  const hiddenUsd = hidden.every((c) => byClient[c.key] !== undefined)
    ? hidden.reduce((a, c) => a + Math.round(byClient[c.key]! * 100), 0) / 100
    : undefined;
  const totalM3 = view.clients.reduce((a, c) => a + c.m3, 0);

  return (
    <div className="w-full space-y-1.5">
      {cap !== undefined && view.clients.length > cap && (
        <p className="text-xs text-ink-700" data-testid={`${testid}-summary`}>
          {t('freightSplitSummary', { clients: view.clients.length, lots: view.lots.length, m3: fmt(totalM3, 3) })}
        </p>
      )}
      <ul className="w-full space-y-1.5 text-sm">
        {shown.map((c) => {
          const lots = c.lotKeys.map((k) => byKey.get(k)!).filter(Boolean);
          const total = byClient[c.key];
          if (lots.length === 1) {
            const l = lots[0]!;
            return (
              <li key={c.key} className="w-full min-w-0 break-words" data-testid={`${testid}-${c.key}`}>
                <div data-testid={`${testid}-${l.key}`}>
                  <span className="block font-semibold">
                    {t('freightRowLine1', { label: lotName(l), m3: fmt(l.m3, 3), density: l.density })}
                  </span>
                  <span className="block text-ink-700">
                    {band(l.band, money)} · {fmt(l.share * 100, 2)} %{money$(byLot?.[l.key])}
                  </span>
                </div>
              </li>
            );
          }
          const isOpen = open.has(c.key);
          const bands = new Set(lots.map((l) => `${l.band.min}|${l.band.max}|${l.band.perKg}`)).size;
          return (
            <li key={c.key} className="w-full min-w-0 break-words" data-testid={`${testid}-${c.key}`}>
              <span className="block font-semibold">
                {t('freightClientLine', { label: c.label, n: lots.length, m3: fmt(c.m3, 3) })}
              </span>
              <span className="block text-ink-700">
                {t('freightClientBands', { n: bands })} · {fmt(c.share * 100, 2)} %{money$(total)}
              </span>
              <button
                type="button"
                className="text-xs font-semibold text-brand-700 underline"
                aria-expanded={isOpen}
                data-testid={`${testid}-open-${c.key}`}
                onClick={() => toggle(c.key)}
              >
                {t(isOpen ? 'freightLotsHide' : 'freightLotsShow', { n: lots.length })}
              </button>
              {isOpen && (
                <ul className="ml-3 mt-1 space-y-1 border-l border-line pl-2">
                  {lots.map((l) => (
                    <li key={l.key} className="min-w-0 break-words" data-testid={`${testid}-${l.key}`}>
                      <span className="block">
                        {t('freightRowLine1', { label: lotName(l, { underClient: true }), m3: fmt(l.m3, 3), density: l.density })}
                      </span>
                      <span className="block text-ink-700">
                        {band(l.band, money)} · {fmt(l.share * 100, 2)} %{money$(byLot?.[l.key])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {cap !== undefined && view.clients.length > cap && (
        <button
          type="button"
          className="text-xs font-semibold text-brand-700 underline"
          aria-expanded={all}
          data-testid={`${testid}-more`}
          onClick={() => setAll((was) => !was)}
        >
          {all
            ? t('freightClientsHide')
            : `${t('freightClientsMore', { n: hidden.length })}${money$(hiddenUsd)}`}
        </button>
      )}
    </div>
  );
}
