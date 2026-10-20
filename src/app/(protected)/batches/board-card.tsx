import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { truckRoadWords } from '@/components/truck-road';
import type { BoardTrip, BoardTruck } from '@/modules/wms/batches/board';
import { boardDay, boardRange, telOf, type RoadBand } from '@/modules/wms/batches/board-view';
import { CHECKPOINT_LABEL } from '@/modules/wms/tracking/map-data';
import type { RoadZone } from '@/modules/wms/tracking/place';
import { cargoLine } from './[id]/batch-card';
import { CheckpointButtons } from './[id]/mashina/checkpoint-buttons';

/**
 * The batch board's two cards (docs/PARTIYA-DOSKASI.md §3): a truck and a
 * factory trip. Each is a plain block holding ONE link (text only) and, for
 * a truck, the ⋯ fold beside it — interactive content is never inside a link
 * (a button in an anchor is a tap that does two things).
 *
 * The fold is a native `<details name="board-menu">`: one open at a time,
 * no script, and the card simply grows. Its summary sits in the card's
 * top-right corner, so the link keeps the room it needs (`pr-10`).
 */

/**
 * The road bar's places, in road order on the dashboard's ordinal ramp —
 * light to dark the way a truck goes, and redefined for dark mode by the
 * ramp itself. A literal map: a class built at runtime does not exist
 * (Tailwind compiles what it can read).
 */
export const ZONE_BAR: Record<RoadZone, string> = {
  cn: 'bg-viz-ord1',
  border: 'bg-viz-ord2',
  transit: 'bg-viz-ord3',
  uz: 'bg-viz-ord4',
};

const m3Of = (m3: number) => Math.round(m3 * 100) / 100;

/**
 * The truck's road, coloured by its places BY DISTANCE (4a) — the same
 * length the % is a share of — full colour behind the truck, faded ahead.
 * A queue has no length, so it is a gap at its post. Decoration only
 * (`aria-hidden`): the place, the % and the date are printed beside it.
 */
function RoadBar({ bands, notches, pct }: { bands: RoadBand[]; notches: number[]; pct: number }) {
  const fill = (faded: boolean) =>
    bands.map((band, i) => (
      <span
        key={i}
        className={`absolute inset-y-0 ${band.zone ? ZONE_BAR[band.zone] : 'bg-line-strong'} ${faded ? 'opacity-30' : ''}`}
        style={{ left: `${band.from * 100}%`, width: `${(band.to - band.from) * 100}%` }}
      />
    ));
  return (
    <div aria-hidden className="relative h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
      {fill(true)}
      <span className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
        {fill(false)}
      </span>
      {notches.map((at, i) => (
        <span key={i} className="absolute inset-y-0 w-0.5 bg-surface" style={{ left: `calc(${at * 100}% - 1px)` }} />
      ))}
    </div>
  );
}

export async function TruckCard({ card }: { card: BoardTruck }) {
  const t = await getTranslations('batches');
  const tb = await getTranslations('batches.board');
  const tc = await getTranslations('countLoad');
  const words = card.road ? await truckRoadWords({ counts: false }) : null;
  const tel = telOf(card.driverPhone);
  const menu = card.pins !== null || tel !== null;

  const cargo = (() => {
    if (card.status === 'forming' || card.status === 'loading') {
      if (!card.load || card.load.planned.boxes === 0) return tb('planNone');
      const { loaded, planned } = card.load;
      if (card.status === 'forming') {
        return tb('plan', { boxes: planned.boxes, cargo: cargoLine(planned.kg, planned.m3) });
      }
      const line = tb('loaded', {
        a: loaded.boxes,
        b: planned.boxes,
        m3a: m3Of(loaded.m3),
        m3b: m3Of(planned.m3),
        kga: Math.round(loaded.kg),
        kgb: Math.round(planned.kg),
      });
      return loaded.boxes === planned.boxes ? `${line} · ${tb('loadedAll')}` : line;
    }
    if (!card.rode) return null;
    const rode = tb('rode', { boxes: card.rode.boxes, cargo: cargoLine(card.rode.kg, card.rode.m3) });
    if (card.status !== 'arrived') return rode;
    const left = card.road?.awaitingUnload ?? 0;
    return `${rode} · ${tb('unloaded', { a: Math.max(0, card.rode.boxes - left), b: card.rode.boxes })}`;
  })();

  const dates: string[] = [];
  if (card.status === 'loading' && card.loadFrom) dates.push(tb('loadingSince', { date: boardDay(card.loadFrom) }));
  if ((card.status === 'in_transit' || card.status === 'arrived') && card.loadFrom && card.loadTo) {
    dates.push(tb('loadedRange', { range: boardRange(card.loadFrom, card.loadTo) }));
  }
  if (card.departedAt && card.status !== 'forming' && card.status !== 'loading') {
    dates.push(tb('departedOn', { date: boardDay(card.departedAt) }));
  }
  if (card.status === 'arrived' && card.arrivedAt) dates.push(tb('arrivedOn', { date: boardDay(card.arrivedAt) }));

  const pct = card.road?.roadPct ?? null;

  return (
    <article data-testid="batch-board-card" data-code={card.code} className="card relative !p-3">
      <Link href={`/batches/${card.id}`} className={`block space-y-1 ${menu ? 'pr-10' : ''}`}>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono font-extrabold text-brand-700">{card.code}</span>
          <span className="font-mono text-sm">
            {card.originCode} → {card.destCode}
          </span>
        </p>
        {(card.plate || card.internal) && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
            {card.plate && <span>🚛 {card.plate}</span>}
            {card.internal && (
              <span className="chip-neutral" data-testid="board-badge-internal">
                {tb('badgeInternal')}
              </span>
            )}
          </p>
        )}
        {cargo && (
          <p className="text-sm tabular-nums" data-testid="board-cargo">
            {cargo}
          </p>
        )}
        {dates.length > 0 && (
          <p className="text-xs text-ink-500" data-testid="board-dates">
            {dates.join(' · ')}
          </p>
        )}
        {card.road && words && (
          <div className="space-y-1 pt-1" data-testid="board-road">
            {card.bar && pct !== null && <RoadBar bands={card.bar.bands} notches={card.bar.notches} pct={pct} />}
            <p className="text-sm">
              <span className="font-semibold">{words.word(card.road)}</span>
              {pct !== null && <span className="tabular-nums text-ink-500"> · {tb('roadPct', { pct })}</span>}
            </p>
            <p className="text-xs text-ink-500">{words.sentence(card.road)}</p>
          </div>
        )}
        {card.awaitingCount && (
          <p data-testid="batch-count-awaiting" className="text-xs font-semibold text-warn">
            {tc('awaitingChip')}
          </p>
        )}
      </Link>
      {menu && (
        <details name="board-menu" data-testid="board-menu">
          <summary
            aria-label={tb('menu')}
            className="absolute right-1 top-1 flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg text-lg text-ink-500 hover:bg-surface-sunken [&::-webkit-details-marker]:hidden"
          >
            ⋯
          </summary>
          <div className="mt-2 space-y-2 border-t border-line pt-2">
            {card.pins && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-ink-500">📍 {t('whereIsTruck')}</p>
                {card.pins.current && (
                  <p className="text-xs" data-testid="board-pin-now">
                    {tb('pinNow', {
                      pin: `${CHECKPOINT_LABEL[card.pins.current].icon} ${t(CHECKPOINT_LABEL[card.pins.current].label)}`,
                    })}
                  </p>
                )}
                {card.pins.options.length > 0 && (
                  <CheckpointButtons
                    batchId={card.id}
                    current={card.pins.current}
                    options={card.pins.options.map((key) => ({
                      key,
                      label: `${CHECKPOINT_LABEL[key].icon} ${t(CHECKPOINT_LABEL[key].label)}`,
                    }))}
                  />
                )}
              </div>
            )}
            {tel && (
              // Not a `.btn`: its 15 px and 48 px floor break a phone number
              // over three lines in a 215 px desktop column.
              <a
                href={`tel:${tel}`}
                aria-label={`${tb('callDriver')} ${card.driverPhone}`}
                className="flex min-h-10 w-full items-center gap-2 rounded-xl border border-line-strong bg-surface-raised px-3 text-sm font-semibold hover:bg-surface-sunken"
                data-testid="board-call"
              >
                <span aria-hidden>📞</span>
                <span className="min-w-0 truncate">{card.driverPhone}</span>
              </a>
            )}
          </div>
        </details>
      )}
    </article>
  );
}

export async function TripCard({ card }: { card: BoardTrip }) {
  const tb = await getTranslations('batches.board');
  const missing = Math.max(card.m3Missing, card.kgMissing);
  const measured = card.lines > 0 && missing < card.lines;
  const cargo = [
    tb('tripCargo', { boxes: card.boxes }),
    measured ? cargoLine(card.kg, card.m3) : null,
    missing > 0 ? tb('tripUnknown', { n: missing }) : null,
  ].filter(Boolean);

  const dates: string[] = [];
  if (card.status === 'planned' && card.plannedOn) dates.push(tb('tripPlanned', { date: boardDay(card.plannedOn) }));
  if (card.collectedFrom && card.collectedTo) {
    dates.push(tb('tripCollectedRange', { range: boardRange(card.collectedFrom, card.collectedTo) }));
  }
  if (card.status === 'on_road' && card.arrival) {
    dates.push(tb('tripArrival', { range: boardRange(card.arrival.from, card.arrival.to) }));
  }
  if (card.status === 'arrived' && card.arrivedAt) dates.push(tb('arrivedOn', { date: boardDay(card.arrivedAt) }));

  return (
    <article data-testid="batch-board-card" data-code={card.code} className="card !p-3">
      <Link href={`/zavod/${card.id}`} className="block space-y-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono font-extrabold text-brand-700">{card.code}</span>
          <span className="font-mono text-sm">→ {card.destCode}</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
          <span className="chip-neutral" data-testid="board-badge-trip">
            🏭 {tb('badgeTrip')}
          </span>
          {card.plate && <span>🚛 {card.plate}</span>}
        </p>
        {card.stops > 0 && (
          <p className="text-sm tabular-nums">{tb('tripCollected', { a: card.collected, b: card.stops })}</p>
        )}
        <p className="text-sm tabular-nums" data-testid="board-cargo">
          {cargo.join(' · ')}
        </p>
        {dates.length > 0 && (
          <p className="text-xs text-ink-500" data-testid="board-dates">
            {dates.join(' · ')}
          </p>
        )}
        {card.warnings.includes('stale') && (
          <p className="text-xs font-semibold text-warn" data-testid="board-trip-stale">
            {tb('warnStale')}
          </p>
        )}
      </Link>
    </article>
  );
}
