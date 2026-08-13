import { describe, expect, it } from 'vitest';
import {
  JOURNEY_KEYS,
  journeyFromEvents,
  type JourneyEvent,
} from '@/modules/wms/client-cabinet/journey';
import { CLIENT_LOCALES, clientLabels, journeyLabel } from '@/modules/platform/telegram/client-labels';

const D = (day: number) => new Date(Date.UTC(2026, 7, day));

const ev = (over: Partial<JourneyEvent> & { cause: string; at: Date }): JourneyEvent => ({
  toStatus: 'in_stock',
  toCountry: null,
  toType: null,
  ...over,
});

describe('journeyFromEvents — «qachon nima bo‘lgan», by table', () => {
  it('walks the whole road in order, from the movements alone', () => {
    const steps = journeyFromEvents(
      [
        ev({ cause: 'receipt', at: D(1), toCountry: 'CN', toType: 'origin' }),
        // The CN leg: batch_departed stamps the DESTINATION (the hub).
        ev({ cause: 'batch_departed', at: D(3), toCountry: 'CN', toType: 'hub', toStatus: 'in_transit' }),
        ev({ cause: 'unload_scan', at: D(9), toCountry: 'CN', toType: 'hub' }),
        ev({ cause: 'batch_departed', at: D(11), toCountry: 'UZ', toType: 'customs', toStatus: 'in_transit' }),
        ev({ cause: 'unload_scan', at: D(16), toCountry: 'UZ', toType: 'customs', toStatus: 'ready_for_pickup' }),
      ],
      null,
    );
    expect(steps.map((s) => s.key)).toEqual(['received', 'toHub', 'atHub', 'export', 'inUz', 'ready']);
    expect(steps[0]!.atIso).toBe(D(1).toISOString());
    expect(steps[1]!.atIso).toBe(D(3).toISOString());
    // The Uzbek unload is BOTH «entered Uzbekistan» and «ready» — one scan,
    // two honest lines, same timestamp.
    expect(steps[4]!.atIso).toBe(D(16).toISOString());
    expect(steps[5]!.atIso).toBe(D(16).toISOString());
  });

  it('the earliest box speaks for the lot', () => {
    // A two-hundred-box lot is unloaded over an hour; «reached the warehouse
    // starting here» is the honest date.
    const steps = journeyFromEvents(
      [
        ev({ cause: 'unload_scan', at: D(10), toCountry: 'CN', toType: 'hub' }),
        ev({ cause: 'unload_scan', at: D(9), toCountry: 'CN', toType: 'hub' }),
        ev({ cause: 'unload_scan', at: D(12), toCountry: 'CN', toType: 'hub' }),
      ],
      null,
    );
    expect(steps).toEqual([{ key: 'atHub', atIso: D(9).toISOString() }]);
  });

  it('the truck’s own facts join the history: the pin and the customs stamp', () => {
    // Neither ever touches box_movements — the paperwork happens to the LORRY
    // while the boxes still sit on it.
    const steps = journeyFromEvents([ev({ cause: 'batch_departed', at: D(11), toCountry: 'UZ' })], {
      inUzAt: D(14),
      customsClearedAt: D(15),
    });
    expect(steps.map((s) => s.key)).toEqual(['export', 'inUz', 'customs']);
    expect(steps[2]!.atIso).toBe(D(15).toISOString());
  });

  it('orders by the ladder, not the clock — two scanners can write out of order', () => {
    // «Entered Uzbekistan» stamped a minute before «export» (clock skew,
    // replayed offline queue): the list must still read down the road.
    const steps = journeyFromEvents(
      [
        ev({ cause: 'unload_scan', at: D(10), toCountry: 'UZ', toType: 'customs' }),
        ev({ cause: 'batch_departed', at: D(11), toCountry: 'UZ' }),
      ],
      null,
    );
    expect(steps.map((s) => s.key)).toEqual(['export', 'inUz']);
  });

  it('says nothing about what has not happened', () => {
    expect(journeyFromEvents([], null)).toEqual([]);
    // Movements a customer never asked about are not history lines.
    const steps = journeyFromEvents(
      [
        ev({ cause: 'plan_approved', at: D(2), toCountry: 'CN' }),
        ev({ cause: 'crate_packed', at: D(2), toCountry: 'CN' }),
        ev({ cause: 'load_scan', at: D(2), toCountry: 'CN' }),
      ],
      null,
    );
    expect(steps).toEqual([]);
  });

  /** The #163 anchor for the jrn* vocabulary, same fence as the stages. */
  it('every history line has a sentence in every language a client reads', () => {
    for (const locale of CLIENT_LOCALES) {
      const labels = clientLabels(locale);
      for (const key of JOURNEY_KEYS) {
        const label = journeyLabel(key, labels);
        expect(label, `${key} in ${locale}`).not.toBe(key);
        expect(label.length).toBeGreaterThan(3);
      }
    }
  });
});
