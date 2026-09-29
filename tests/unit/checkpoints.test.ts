import { describe, expect, it } from 'vitest';
import { truckStage } from '@/modules/wms/client-cabinet/stages';
import { checkpointsFor, pinOnRoute } from '@/modules/wms/tracking/eta';
import { CHECKPOINT_KEYS, CHECKPOINT_LABEL, CHECKPOINT_SEGMENTS } from '@/modules/wms/tracking/map-data';

/**
 * The «where is the truck» pins follow the truck's own ROAD (the Horgos
 * round). A pin names a leg (`CHECKPOINT_SEGMENTS`); the engine ignores a pin
 * whose leg the route does not have, so a Kyrgyz pin on a Kazakh road was a
 * press that changed nothing while the button said it had. One pure answer
 * decides what the Mashina tab offers, what the service accepts and what the
 * dashboard draws.
 */
const AT = '2026-09-28T08:00:00.000Z';

describe('checkpointsFor — the pins a truck is offered and allowed', () => {
  it('the Kashgar road passes Kyrgyzstan, the Horgos road Kazakhstan', () => {
    expect(checkpointsFor('KA', 'TAS1', 'UZ')).toEqual(['at_border', 'in_kg', 'in_uz']);
    expect(checkpointsFor('YW', 'TAS1', 'UZ')).toEqual(['at_border', 'in_kg', 'in_uz']);
    expect(checkpointsFor('HOR', 'TAS1', 'UZ')).toEqual(['at_border', 'in_kz', 'in_uz']);
    expect(checkpointsFor('HOR', 'AND', 'UZ')).toEqual(['at_border', 'in_kz', 'in_uz']);
  });

  it('a leg inside China carries no pin at all', () => {
    expect(checkpointsFor('YW', 'HOR', 'CN')).toEqual([]);
    expect(checkpointsFor('YW', 'KA', 'CN')).toEqual([]);
  });

  it('a road with no border in it offers only «in Uzbekistan» — the customer’s rung', () => {
    expect(checkpointsFor('AND', 'TAS1', 'UZ')).toEqual(['in_uz']);
    // A generic straight line (nobody described the road): no leg to name,
    // so the rung alone — and nothing on a truck bound for China.
    expect(checkpointsFor('TAS1', 'AND', 'UZ')).toEqual(['in_uz']);
    expect(checkpointsFor('KA', 'HOR', 'CN')).toEqual([]);
    expect(checkpointsFor('NOPE', 'NADA', 'uz')).toEqual(['in_uz']);
    expect(checkpointsFor('NOPE', 'NADA', ' cn ')).toEqual([]);
  });

  it('every key it can answer has a leg and a label — one list, no copies', () => {
    for (const key of CHECKPOINT_KEYS) {
      expect(CHECKPOINT_SEGMENTS[key], key).toBeTruthy();
      expect(CHECKPOINT_LABEL[key].label, key).toMatch(/^cp[A-Z]/);
    }
  });
});

describe('pinOnRoute — a stored pin, if this road can carry it', () => {
  it('drops a Kyrgyz pin left on a Horgos truck, keeps a Kazakh one', () => {
    expect(pinOnRoute({ key: 'in_kg', at: AT }, 'HOR', 'TAS1', 'UZ')).toBeNull();
    expect(pinOnRoute({ key: 'in_kz', at: AT }, 'HOR', 'TAS1', 'UZ')).toEqual({ key: 'in_kz', at: AT });
    expect(pinOnRoute({ key: 'in_kz', at: AT }, 'KA', 'TAS1', 'UZ')).toBeNull();
  });

  it('keeps the shape checks the dashboard always made', () => {
    expect(pinOnRoute(null, 'KA', 'TAS1', 'UZ')).toBeNull();
    expect(pinOnRoute({ key: 'somewhere', at: AT }, 'KA', 'TAS1', 'UZ')).toBeNull();
    expect(pinOnRoute({ key: 'in_kg', at: 'not a date' }, 'KA', 'TAS1', 'UZ')).toBeNull();
    expect(pinOnRoute({ key: 'in_kg' }, 'KA', 'TAS1', 'UZ')).toBeNull();
    expect(pinOnRoute({ key: 'toString', at: AT }, 'KA', 'TAS1', 'UZ')).toBeNull();
  });
});

describe('truckStage — an «in Uzbekistan» pin on a China-bound truck is a slip', () => {
  it('reads the rung by the destination, whatever the pin says', () => {
    expect(
      truckStage({ originCountry: 'CN', destCountry: 'CN', status: 'in_transit', checkpointKey: 'in_uz', customsCleared: false }),
    ).toBe('cn_transit');
    expect(
      truckStage({ originCountry: 'CN', destCountry: 'UZ', status: 'in_transit', checkpointKey: 'in_uz', customsCleared: false }),
    ).toBe('in_uz');
  });
});
