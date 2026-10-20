import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { formatEtaRange } from '@/modules/platform/telegram/client-labels';
import { estimateBasis, fixAge, gateWord, type TruckRow } from '@/modules/wms/tracking/on-road-state';
import { CHECKPOINT_LABEL } from '@/modules/wms/tracking/map-data';
import { LEG_KEYS, type LegKey } from '@/modules/wms/tracking/engine';
import type { RoadZone } from '@/modules/wms/tracking/place';
import { num } from '@/components/charts/format';

/** «27.09» in Tashkent — an estimate is always days away, so no year (formatEtaRange's rule). */
const etaDay = (iso: string) => formatEtaRange(iso, iso);

const isLegKey = (key: string): key is LegKey => (LEG_KEYS as readonly string[]).includes(key);

/**
 * The words a truck on the road is described in — ONE builder for the
 * dashboard's trucks card, the truck card's own header, the client card's
 * «Yuklar» and the batch board (#513), so they can never say different
 * things about one lorry.
 *
 * `word` is WHERE it is (owner, 2026-10-17: «yolda bosqichida mashina
 * qayerda»): the leg it is on in the map's own words («Qirg‘iziston
 * hududida», «Chegarada navbatda»), the place when no leg can be named, or
 * «Joyi aniq emas»; at the gate, «Tushirilmoqda» / «Tushirilmay turibdi».
 * It used to print the CUSTOMER's rung («Eksport yo‘lida»), which moves only
 * on a person's pin — the office now reads the place the driver's phone
 * says, and the customer's rung stays his design (docs/PARTIYA-DOSKASI.md
 * §2).
 *
 * `sentence` is the dated line under it: days on the road, then the
 * window, «overdue», or «no modelled road» — never an invented date (judge
 * O14) — with what the window is computed from; then the evidence that
 * placed the truck, dated ONCE (the logist's pin «belgi 2 kun oldin», never
 * «still there»; the phone's fix «GPS · 3 soat oldin»); the customs stamp;
 * and what departed on it.
 *
 * `counts: false` leaves out the two parts that count the WHOLE truck — what
 * departed on it and what still waits at its gate. The client card's «Yuklar»
 * tab prints this sentence under ONE client's row, whose own «5 📦» sits on
 * the same line; «… · 180 karobka jo'nadi» beside it reads as that client's
 * number (the tab's judge, finding 3). The board prints its own cargo line.
 * Everything else is the lorry's and stays.
 */
export async function truckRoadWords({ counts = true }: { counts?: boolean } = {}) {
  const t = await getTranslations('dashboard');
  const tb = await getTranslations('batches');
  const tm = await getTranslations('map');
  const tp = await getTranslations('place');
  const tu = await getTranslations('unloading');
  // Literal maps — a key built from a value escapes the i18n tripwire (#163),
  // and a Record over the union fails the build the day a leg is added.
  const LEG: Record<LegKey, string> = {
    cn_transit: tm('seg_cn_transit'),
    to_border: tm('seg_to_border'),
    border_wait: tm('seg_border_wait'),
    kz: tm('seg_kz'),
    uz_queue: tm('seg_uz_queue'),
    kg: tm('seg_kg'),
    uz: tm('seg_uz'),
    transit: tm('seg_transit'),
  };
  const ZONE: Record<RoadZone, string> = {
    cn: tp('road.cn'),
    border: tp('road.border'),
    transit: tp('road.transit'),
    uz: tp('road.uz'),
  };
  const AGO = {
    now: () => t('agoNow'),
    min: (n: number) => t('agoMin', { n }),
    hour: (n: number) => t('agoHour', { n }),
    day: (n: number) => t('agoDay', { n }),
  } as const;

  // At the gate, `gateWord` decides (an unloaded truck nobody finished is not
  // «Tushirilmay turibdi», and its word fits the dashboard's one-line chip —
  // the button it waits on is named in the sentence); on the road, the leg,
  // the place, or nothing.
  const GATE = {
    unloaded_open: () => t('truckUnloadedOpen'),
    stuck: () => t('truckKind.stuck'),
    unloading: () => t('truckKind.unloading'),
  } as const;
  const word = (row: TruckRow): string => {
    const gate = gateWord(row);
    return gate
      ? GATE[gate]()
      : row.atGate
        ? t('truckAtGate')
        : row.segKey && isLegKey(row.segKey) && row.segKey !== 'transit'
          ? LEG[row.segKey]
          : row.zone
            ? ZONE[row.zone]
            : tp('unknown');
  };

  // The button an unloaded truck waits on, named ONCE for every screen that
  // prints it — the sentence below and the board's arrived card, which leaves
  // the sentence out (its dates line already says when the truck came).
  const gateHint = (row: TruckRow): string | null =>
    gateWord(row) === 'unloaded_open' ? t('truckUnloadedOpenHint', { button: tu('finishUnload') }) : null;

  const byFix = (row: TruckRow) => row.source === 'gps' || row.source === 'manual';
  const BASIS = {
    gps: () => t('truckEstimateGps'),
    pin: () => t('truckEstimatePin'),
    schedule: () => t('truckEstimate'),
  } as const;

  const sentence = (row: TruckRow): ReactNode[] => {
    const parts: ReactNode[] = [];
    if (row.status === 'arrived') {
      parts.push(t('arrivedDays', { n: row.days }));
      if (counts && (row.awaitingUnload ?? 0) > 0) parts.push(t('truckGate', { n: num(row.awaitingUnload ?? 0) }));
      // The word is short — the dashboard prints it in a one-line chip — and
      // the button nobody pressed is named here, on every screen, whatever
      // `counts` says: it is the truck's own job, not a count of its boxes.
      const hint = gateHint(row);
      if (hint) parts.push(hint);
    } else {
      parts.push(t('roadDays', { n: row.days }));
      if (row.atGate && row.gateDays !== null) {
        // At its gate the driver has done his part: how long it has stood
        // there, and — past the stuck days — the unloading to check, never
        // «call the driver» (the recheck).
        parts.push(t('truckAtGateDays', { n: row.gateDays }));
        if (row.kind === 'stuck') {
          parts.push(
            <span key="stuck" className="font-semibold text-warn">
              {t('truckAtGateStuck')}
            </span>,
          );
        }
      } else if (row.kind === 'overdue') {
        parts.push(
          <span key="late" className="font-semibold text-warn">
            {tm('overdue')}
          </span>,
        );
      } else if (row.eta) {
        parts.push(
          `${t('truckEta', { from: etaDay(row.eta.fromIso), to: etaDay(row.eta.toIso) })} (${BASIS[
            estimateBasis(row.source)
          ]()})`,
        );
      } else if (row.kind === 'no_schedule') {
        parts.push(t('truckNoRoute'));
      }
      // The evidence that placed the truck, dated once. `row.checkpoint` is
      // already the truck's own road's pin (`pinOnRoute`); the words have one
      // home, beside the keys. A pin a newer fix outranked is not the
      // evidence, so it is not printed as if it were.
      if (byFix(row) && row.evidenceAt) {
        const age = fixAge((Date.now() - new Date(row.evidenceAt).getTime()) / 60_000);
        const ago = age.unit === 'now' ? AGO.now() : AGO[age.unit](age.n);
        parts.push(row.source === 'manual' ? t('truckFixManual', { ago }) : t('truckFixGps', { ago }));
      } else if (row.checkpoint) {
        parts.push(`${tb(CHECKPOINT_LABEL[row.checkpoint.key].label)} · ${t('truckPin', { n: row.pinDays ?? 0 })}`);
      }
      if (row.stage === 'customs_done') parts.push(t('truckStage.customs_done'));
      if (counts) parts.push(t('truckDeparted', { n: num(row.departedBoxes) }));
    }
    return parts.map((part, i) => (
      <span key={i}>
        {i > 0 && ' · '}
        {part}
      </span>
    ));
  };

  return { word, sentence, gateHint };
}
