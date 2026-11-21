import { describe, expect, it } from 'vitest';
import { ASSUMED_DESTINATION, truckDestination } from '@/modules/wms/agent/calc-destination';
import { actionLines } from '@/modules/wms/agent/card-io';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';

/**
 * The truck job's destination beside the route reader the checklist always read (his «T a», 2026-11-21): the
 * destination reader first, the route reader's `toCity` for a line it reads nothing in, the newest line winning — and a
 * China place the route reader hands over is never where the cargo goes. The reader's own words are the corpus's
 * (`calc_destination`, `calc_destination_default` in tests/unit/fixtures/agent-reader-corpus.ts).
 */

const route = (line: string) => parseManualFacts(line).toCity ?? null;

describe('truckDestination beside the route reader', () => {
  it('the route reader still answers a Latin «Adan Bga» the destination reader also reads — one city', () => {
    expect(truckDestination(['Yiwudan Samarqandga 3 kub'], route)).toEqual({ toCity: 'Samarqand', assumed: false });
  });

  it('a city only the route reader knows is still read, as it always was («Kitob» is a word too, so the place list leaves it out)', () => {
    expect(truckDestination(['Guanchjoudan Kitobga 3 kub'], route)).toEqual({ toCity: 'Kitob', assumed: false });
  });

  it('the newest line wins, whichever reader read it', () => {
    expect(truckDestination(['Andijonga', 'Yiwu → Toshkent'], route)).toEqual({ toCity: 'Toshkent', assumed: false });
    expect(truckDestination(['Yiwu → Toshkent', 'Андижонга'], route)).toEqual({ toCity: 'Андижон', assumed: false });
  });

  it('a China place the route reader reads as the far end («Toshkentdan Xitoyga» → «Xitoy») is no destination: Tashkent is taken', () => {
    expect(route('Toshkentdan Xitoyga 3 kub')).toBe('Xitoy');
    expect(truckDestination(['Toshkentdan Xitoyga 3 kub'], route)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true });
  });

  it('nothing said and no other place named: Tashkent, taken', () => {
    expect(truckDestination(['Ivudan 3 kub 450 kg kiyim', 'ha', '200 dona'], route)).toEqual({ toCity: 'Toshkent', assumed: true });
  });
});

describe('his card says what the VED will read', () => {
  const submit = (toCityAssumed?: boolean) => ({
    type: 'calc_submit' as const,
    section: 'podklyuch' as const,
    facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 450, volumeM3: 3, goods: [] },
    fromOurWarehouse: false,
    ...(toCityAssumed === undefined ? {} : { toCityAssumed }),
    citedMessageIds: [],
  });

  it('a destination taken, not said, is on the line ✅ also does', () => {
    expect(actionLines([submit(true)])[0]).toContain('manzil aytilmagan — Toshkent deb olindi');
  });

  it('a destination said — or an action stored before the flag — reads as said', () => {
    expect(actionLines([submit(false)])[0]).not.toContain('manzil aytilmagan');
    expect(actionLines([submit()])[0]).not.toContain('manzil aytilmagan');
  });
});
