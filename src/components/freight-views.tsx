'use client';

import { useTranslations } from 'next-intl';
import { bandText, splitCents } from '@/modules/wms/costing/freight-split';
import { HELD_KEY } from '@/modules/wms/costing/freight-errors';
import type { FreightHeld, GroupView, HeldLot, SplitView } from '@/modules/wms/costing/freight-types';

/**
 * How a yo'lkira-tarifi split is DRAWN (docs/YOLKIRA-TAQSIMOT.md §6.2, §7) —
 * the preview under the amount, the note after a held save, the fold on a
 * saved bill and the re-basis preview all draw through these, so one band or
 * one held reason is never worded two ways (#513). Two lines per row at
 * 360 px; every line `min-w-0 break-words` (a 40-character unclaimed marking
 * has no break in it, #400).
 *
 * VALUE imports only from the pure costing modules (freight-split,
 * freight-errors) and types from freight-types — never from a module that
 * reaches the database (#276, fenced).
 */

const MORE_AFTER = 5;
const fmt = (n: number, digits: number) => String(Math.round(n * 10 ** digits) / 10 ** digits);

function useBand() {
  const t = useTranslations('costing');
  return (band: GroupView['band'], money: boolean) => {
    const b = bandText(band, { money });
    return t(b.key, { range: b.range, price: b.price });
  };
}

function LotLines({ lots }: { lots: HeldLot[] }) {
  const t = useTranslations('costing');
  return (
    <ul className="ml-4 list-disc">
      {lots.slice(0, MORE_AFTER).map((lot) => (
        <li key={lot.lotId} className="min-w-0 break-words">
          <a className="underline" href={`/receipts/${lot.receiptId}`}>
            {t('freightHeldLot', { lot: lot.label, density: lot.density ?? '—' })}
          </a>
        </li>
      ))}
      {lots.length > MORE_AFTER && <li>{t('freightHeldMore', { n: lots.length - MORE_AFTER })}</li>}
    </ul>
  );
}

/** A held bill's reasons, measure first, each group's lots lightest first. */
export function FreightHeldLines({ held, limit }: { held: FreightHeld; limit: number }) {
  const t = useTranslations('costing');
  if (held.reason !== 'cargo') {
    return <p className="min-w-0 break-words">{t(HELD_KEY[held.reason])}</p>;
  }
  return (
    <div className="space-y-1">
      {held.measureMissing.slice(0, MORE_AFTER).map((lot) => (
        <p key={lot.lotId} className="min-w-0 break-words">
          <a className="underline" href={`/receipts/${lot.receiptId}`}>
            {t('freightHeldMeasure', { lot: lot.label })}
          </a>
        </p>
      ))}
      {held.measureMissing.length > MORE_AFTER && <p>{t('freightHeldMore', { n: held.measureMissing.length - MORE_AFTER })}</p>}
      {held.tooLight.slice(0, MORE_AFTER).map((group) => (
        <div key={group.key} className="min-w-0 break-words">
          <p>
            {t('freightHeldLight', {
              group: group.label,
              m3: fmt(group.m3, 3),
              kg: fmt(group.kg, 3),
              density: group.density,
              limit,
            })}
          </p>
          <LotLines lots={group.lots} />
        </div>
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
 * The groups of a split: «label · m³ · kg/m³», then the band and the share
 * (and, under money sight, the share of the typed amount by the largest
 * remainder in cents — the column adds up to the bill).
 */
export function FreightGroupRows({
  view,
  money,
  amount,
  currency,
  limit,
  cents,
  testid = 'freight-row',
}: {
  view: SplitView;
  money: boolean;
  /** The typed amount (preview) — or null where the dollars come from `cents`. */
  amount: number | null;
  currency: string;
  limit: number;
  /** The allocations' own cents per group key (a saved bill). */
  cents?: Record<string, number>;
  testid?: string;
}) {
  const t = useTranslations('costing');
  const band = useBand();
  if (view.kind === 'nothing') return <p className="text-sm text-ink-500">{t('freightHeldNothing')}</p>;
  if (view.kind === 'held') {
    return (
      <div className="text-sm text-warn" data-testid="freight-preview-held">
        <p className="font-semibold">{t('freightPreviewHeld')}</p>
        <FreightHeldLines held={view.held} limit={limit} />
      </div>
    );
  }
  const shares = view.groups.map((g) => g.share);
  const typed = money && amount !== null && amount > 0 ? splitCents(amount, shares) : null;
  return (
    <ul className="w-full space-y-1.5 text-sm">
      {view.groups.map((g, i) => {
        const dollars = cents ? cents[g.key] : typed ? typed[i] : undefined;
        return (
          <li key={g.key} className="w-full min-w-0 break-words" data-testid={`${testid}-${g.key}`}>
            <span className="block font-semibold">
              {t('freightRowLine1', { label: g.label, m3: fmt(g.m3, 3), density: g.density })}
            </span>
            <span className="block text-ink-700">
              {band(g.band, money)} · {fmt(g.share * 100, 2)} %
              {money && dollars !== undefined ? ` · ${dollars.toFixed(2)} ${cents ? 'USD' : currency}` : ''}
            </span>
            {g.lightLots.map((lot) => (
              <span key={lot.lotId} className="block text-xs text-warn">
                {t('freightLightLot', { lot: lot.label, density: lot.density ?? '—', limit })}
              </span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
