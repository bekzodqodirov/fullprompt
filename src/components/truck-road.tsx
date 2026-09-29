import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { formatEtaRange } from '@/modules/platform/telegram/client-labels';
import type { TruckRow } from '@/modules/wms/tracking/on-road-state';
import { num } from '@/components/charts/format';

/** «27.09» in Tashkent — an estimate is always days away, so no year (formatEtaRange's rule). */
const etaDay = (iso: string) => formatEtaRange(iso, iso);

/**
 * The words a truck on the road is described in — ONE builder for the
 * dashboard's trucks card and the truck card's own header (#513), so the two
 * can never say different things about one lorry. It moved here out of the
 * dashboard's card, where it was a local function.
 *
 * `word` is the short state («Yo'lda — Qirg'iziston», «Tushirilmoqda»),
 * `sentence` the dated line under it: days on the road, then the schedule's
 * window, «overdue», or «no modelled road» — never an invented date (judge
 * O14) — then the logist's latest pin as a DATED fact («belgi 2 kun oldin»,
 * never «still there»), then what departed on it.
 *
 * `counts: false` leaves out the two parts that count the WHOLE truck — what
 * departed on it and what still waits at its gate. The client card's «Yuklar»
 * tab prints this sentence under ONE client's row, whose own «5 📦» sits on
 * the same line; «… · 180 karobka jo'nadi» beside it reads as that client's
 * number (the tab's judge, finding 3). Everything else is the lorry's and
 * stays.
 */
export async function truckRoadWords({ counts = true }: { counts?: boolean } = {}) {
  const t = await getTranslations('dashboard');
  const tb = await getTranslations('batches');
  const tm = await getTranslations('map');
  const STAGE: Record<NonNullable<TruckRow['stage']>, string> = {
    cn_transit: t('truckStage.cn_transit'),
    export_transit: t('truckStage.export_transit'),
    in_uz: t('truckStage.in_uz'),
    customs_done: t('truckStage.customs_done'),
  };
  const PIN: Record<string, string> = { at_border: tb('cpBorder'), in_kg: tb('cpKg'), in_uz: tb('cpUz') };

  const word = (row: TruckRow): string =>
    row.kind === 'stuck'
      ? t('truckKind.stuck')
      : row.kind === 'unloading'
        ? t('truckKind.unloading')
        : row.stage
          ? STAGE[row.stage]
          : t('truckStage.export_transit');

  const sentence = (row: TruckRow): ReactNode[] => {
    const parts: ReactNode[] = [];
    if (row.status === 'arrived') {
      parts.push(t('arrivedDays', { n: row.days }));
      if (counts && (row.awaitingUnload ?? 0) > 0) parts.push(t('truckGate', { n: num(row.awaitingUnload ?? 0) }));
    } else {
      parts.push(t('roadDays', { n: row.days }));
      if (row.kind === 'overdue') {
        parts.push(
          <span key="late" className="font-semibold text-warn">
            {tm('overdue')}
          </span>,
        );
      } else if (row.eta) {
        parts.push(`${t('truckEta', { from: etaDay(row.eta.fromIso), to: etaDay(row.eta.toIso) })} (${t('truckEstimate')})`);
      } else if (row.kind === 'no_schedule') {
        parts.push(t('truckNoRoute'));
      }
      if (row.checkpoint && PIN[row.checkpoint.key]) {
        parts.push(`${PIN[row.checkpoint.key]} · ${t('truckPin', { n: row.pinDays ?? 0 })}`);
      }
      if (counts) parts.push(t('truckDeparted', { n: num(row.departedBoxes) }));
    }
    return parts.map((part, i) => (
      <span key={i}>
        {i > 0 && ' · '}
        {part}
      </span>
    ));
  };

  return { word, sentence };
}
