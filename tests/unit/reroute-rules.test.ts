import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { inScope, mayAt } from '@/modules/platform/rbac/scope';
import { countryKey } from '@/modules/wms/batches/country-key';
import { isInternalLeg } from '@/modules/wms/batches/internal';
import {
  REROUTE_REFUSALS,
  lostThroughReroute,
  mayRerouteTruck,
  rerouteRefusal,
} from '@/modules/wms/batches/reroute-rules';
import { truckStage, type StageBatch } from '@/modules/wms/client-cabinet/stages';

/**
 * «Yo'nalishni o'zgartirish» — the pure rules (the reroute round). The door
 * is behavioural over every SEEDED role, because who may press it is a
 * property of a matrix the owner edits with checkboxes (#170), never a list of
 * role names written here (count-door.test.ts's shape).
 */

const ORIGIN = '00000000-0000-4000-8000-0000000e0001';
const DEST = '00000000-0000-4000-8000-0000000e0002';
const TARGET = '00000000-0000-4000-8000-0000000e0003';
const OTHER = '00000000-0000-4000-8000-0000000e0004';

const truck = { originWarehouseId: ORIGIN, destWarehouseId: DEST, destCountry: 'UZ' };
const target = (over: Partial<{ id: string; active: boolean; country: string | null }> = {}) => ({
  id: TARGET,
  active: true,
  country: 'UZ',
  ...over,
});

function actor(role: RoleCode, warehouseIds: string[] = [DEST]) {
  return {
    permissions: new Set<string>(ROLE_MATRIX[role]),
    warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
    warehouseIds,
  };
}

describe('rerouteRefusal — each answer, in the order a person can act on', () => {
  it('nothing chosen', () => {
    expect(rerouteRefusal(truck, null)).toBe('bad_target');
  });

  it('the truck’s own two ends', () => {
    expect(rerouteRefusal(truck, target({ id: DEST }))).toBe('same_destination');
    expect(rerouteRefusal(truck, target({ id: ORIGIN }))).toBe('destination_is_origin');
    // Same destination beats inactive: the first answer that applies.
    expect(rerouteRefusal(truck, target({ id: DEST, active: false }))).toBe('same_destination');
  });

  it('the target’s own state, then the country', () => {
    expect(rerouteRefusal(truck, target({ active: false }))).toBe('target_inactive');
    expect(rerouteRefusal(truck, target({ active: false, country: 'CN' }))).toBe('target_inactive');
    expect(rerouteRefusal(truck, target({ country: '' }))).toBe('country_unknown');
    expect(rerouteRefusal(truck, target({ country: null }))).toBe('country_unknown');
    expect(rerouteRefusal({ ...truck, destCountry: ' ' }, target())).toBe('country_unknown');
    expect(rerouteRefusal(truck, target({ country: 'CN' }))).toBe('other_country');
    expect(rerouteRefusal({ ...truck, destCountry: 'CN' }, target())).toBe('other_country');
  });

  it('admits the same country, spelled any way the free-text column allows', () => {
    expect(rerouteRefusal(truck, target())).toBeNull();
    expect(rerouteRefusal({ ...truck, destCountry: ' uz ' }, target({ country: 'Uz' }))).toBeNull();
  });

  it('every code it can answer is on the refusal list the screen fences', () => {
    const answers = [
      rerouteRefusal(truck, null),
      rerouteRefusal(truck, target({ id: DEST })),
      rerouteRefusal(truck, target({ id: ORIGIN })),
      rerouteRefusal(truck, target({ active: false })),
      rerouteRefusal(truck, target({ country: '' })),
      rerouteRefusal(truck, target({ country: 'CN' })),
    ];
    for (const code of answers) expect(REROUTE_REFUSALS).toContain(code);
  });
});

describe('mayRerouteTruck — the owner’s 2a over the seeded matrix', () => {
  const onRoad = { status: 'in_transit', destWarehouseId: DEST };

  it('opens for super_admin, admin and logist — and nobody else the seed ships', () => {
    const opens = (Object.keys(ROLE_MATRIX) as RoleCode[]).filter((r) => mayRerouteTruck(actor(r), onRoad)).sort();
    expect(opens).toEqual(['admin', 'logist', 'super_admin']);
    for (const role of ['warehouse_manager', 'warehouse_operator', 'ved_manager', 'accountant', 'sales_manager', 'viewer'] as RoleCode[]) {
      expect([role, mayRerouteTruck(actor(role), onRoad)]).toEqual([role, false]);
    }
  });

  it('only a truck on the road — never one loading, arrived or unloaded', () => {
    for (const status of ['forming', 'loading', 'arrived', 'unloaded', 'closed', 'cancelled']) {
      expect([status, mayRerouteTruck(actor('logist'), { status, destWarehouseId: DEST })]).toEqual([status, false]);
    }
  });

  it('an invented scoped role holding plans.manage: only at its own warehouses', () => {
    const scoped = { permissions: new Set(['plans.manage']), warehouseScoped: true, warehouseIds: [DEST] };
    expect(mayRerouteTruck(scoped, onRoad)).toBe(true);
    expect(mayRerouteTruck({ ...scoped, warehouseIds: [OTHER] }, onRoad)).toBe(false);
    expect(mayRerouteTruck({ ...scoped, warehouseIds: [] }, onRoad)).toBe(false);
  });
});

describe('lostThroughReroute — the old destination’s staff', () => {
  const operatorAt = (wh: string) => actor('warehouse_operator', [wh]);

  it('an operator at a former destination lost the truck', () => {
    expect(lostThroughReroute(operatorAt(DEST), 'scan.unload', [DEST], TARGET)).toBe(true);
  });

  it('an operator at the live destination did not', () => {
    expect(lostThroughReroute(operatorAt(TARGET), 'scan.unload', [DEST], TARGET)).toBe(false);
  });

  it('an unrelated warehouse, no history, or no permission: not a reroute', () => {
    expect(lostThroughReroute(operatorAt(OTHER), 'scan.unload', [DEST], TARGET)).toBe(false);
    expect(lostThroughReroute(operatorAt(DEST), 'scan.unload', [], TARGET)).toBe(false);
    expect(lostThroughReroute(actor('viewer', [DEST]), 'scan.unload', [DEST], TARGET)).toBe(false);
  });

  it('rerouted BACK to the warehouse: not lost', () => {
    expect(lostThroughReroute(operatorAt(DEST), 'scan.unload', [DEST, TARGET], DEST)).toBe(false);
  });

  it('an unscoped person never loses a truck by a reroute', () => {
    expect(lostThroughReroute(actor('logist', []), 'plans.manage', [DEST], TARGET)).toBe(false);
  });
});

describe('mayAt — authorize’s two refusals as one predicate', () => {
  it('reads exactly what authorize reads: the permission, then inScope', () => {
    // Source-shape for the gate (a behavioural call needs a session — the
    // integration file presses it with one), so the two cannot drift apart.
    const gate = readFileSync('src/modules/platform/rbac/authorize.ts', 'utf8');
    expect(gate).toContain('if (!actor.permissions.has(permission)) {');
    expect(gate).toContain('if (opts.warehouseId && !inScope(actor, opts.warehouseId)) {');
  });

  it('over sampled actors', () => {
    const cases: [ReturnType<typeof actor>, string, string | null, boolean][] = [
      [actor('logist', []), 'plans.manage', DEST, true],
      [actor('logist', []), 'scan.unload', DEST, actor('logist').permissions.has('scan.unload')],
      [actor('warehouse_operator', [DEST]), 'scan.unload', DEST, true],
      [actor('warehouse_operator', [DEST]), 'scan.unload', OTHER, false],
      [actor('warehouse_operator', []), 'scan.unload', DEST, false],
      [actor('warehouse_operator', [DEST]), 'scan.unload', null, false],
      [actor('warehouse_operator', [DEST]), 'plans.manage', DEST, false],
      [actor('viewer', []), 'scan.unload', DEST, false],
    ];
    for (const [a, permission, wh, want] of cases) {
      expect(mayAt(a, permission, wh), `${permission}@${wh}`).toBe(want);
      expect(mayAt(a, permission, wh)).toBe(a.permissions.has(permission) && inScope(a, wh));
    }
  });
});

describe('answer 5a — nothing that reads the COUNTRIES can tell a rerouted truck', () => {
  const COUNTRIES = ['CN', 'UZ'] as const;
  it('internal leg, border crossing and the customer’s rung are unchanged for every admitted reroute', () => {
    let admitted = 0;
    for (const o of COUNTRIES) {
      for (const d of COUNTRIES) {
        for (const t of COUNTRIES) {
          const refusal = rerouteRefusal(
            { originWarehouseId: ORIGIN, destWarehouseId: DEST, destCountry: d },
            { id: TARGET, active: true, country: t },
          );
          if (refusal !== null) {
            expect(refusal).toBe('other_country');
            continue;
          }
          admitted += 1;
          expect(isInternalLeg(o, t)).toBe(isInternalLeg(o, d));
          const crosses = (a: string, b: string) => countryKey(a) === '' || countryKey(a) !== countryKey(b);
          expect(crosses(o, t)).toBe(crosses(o, d));
          for (const status of ['in_transit', 'arrived']) {
            for (const checkpointKey of [null, 'at_border', 'in_kg', 'in_kz', 'in_uz']) {
              for (const customsCleared of [false, true]) {
                const before: StageBatch = { originCountry: o, destCountry: d, status, checkpointKey, customsCleared };
                expect(truckStage({ ...before, destCountry: t })).toBe(truckStage(before));
              }
            }
          }
        }
      }
    }
    expect(admitted).toBe(4);
  });
});
