import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { mayEditBorderQueue } from '@/modules/wms/tracking/border-queue';

/**
 * Who may type a border queue (the Horgos round). One number moves every
 * customer's date in the company, and a border post belongs to no warehouse
 * — so the door is the logist's own `plans.manage` AND not warehouse-scoped.
 * Behavioural over EVERY seeded role, because the matrix is his to edit with
 * checkboxes; plus an invented scoped role holding the permission, which is
 * the case the second clause exists for.
 */
const ROLES = Object.keys(ROLE_MATRIX) as RoleCode[];
const grants = (role: RoleCode) => ({
  permissions: new Set<string>(ROLE_MATRIX[role]),
  warehouseScoped: WAREHOUSE_SCOPED_ROLES.includes(role),
});

/** Comments out, so a fence cannot match the sentence explaining it (#725). */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('mayEditBorderQueue', () => {
  it('admits exactly the unscoped holders of plans.manage among the seeded roles', () => {
    const admitted = ROLES.filter((role) => mayEditBorderQueue(grants(role)));
    const expected = ROLES.filter(
      (role) => ROLE_MATRIX[role].includes('plans.manage') && !WAREHOUSE_SCOPED_ROLES.includes(role),
    );
    expect(admitted.sort()).toEqual(expected.sort());
    // The logist is the person the owner means; a seller and the VED are not.
    expect(admitted).toContain('logist');
    expect(admitted).not.toContain('sales_manager');
    expect(admitted).not.toContain('ved_manager');
  });

  it('refuses a warehouse-scoped role even when it holds plans.manage', () => {
    expect(mayEditBorderQueue({ permissions: new Set(['plans.manage']), warehouseScoped: true })).toBe(false);
    expect(mayEditBorderQueue({ permissions: new Set(['plans.manage']), warehouseScoped: false })).toBe(true);
    expect(mayEditBorderQueue({ permissions: new Set<string>(), warehouseScoped: false })).toBe(false);
  });
});

describe('the doors the panel draws and the actions obey', () => {
  const ACTIONS = read('src/app/(protected)/trucks/border-queue-actions.ts');
  const PANEL = read('src/app/(protected)/trucks/border-queue-panel.tsx');

  it('both actions ask the session for plans.manage before anything else', () => {
    for (const name of ['saveBorderWaitAction', 'resetBorderWaitAction']) {
      const at = ACTIONS.indexOf(`export async function ${name}(`);
      expect(at, name).toBeGreaterThan(-1);
      const body = ACTIONS.slice(at, ACTIONS.indexOf('\nexport ', at + 1) === -1 ? undefined : ACTIONS.indexOf('\nexport ', at + 1));
      const door = body.indexOf("authorize('plans.manage')");
      expect(door, name).toBeGreaterThan(-1);
      // …and the service (which re-asks the scope) only after it.
      expect(body.search(/(setBorderWait|clearBorderWait)\(/), name).toBeGreaterThan(door);
    }
  });

  it('the edit fold is drawn only for whoever the service obeys', () => {
    expect(PANEL).toContain('mayEditBorderQueue(actor)');
    const gate = PANEL.indexOf('const editable = mayEditBorderQueue(actor)');
    const fold = PANEL.indexOf('{editable && (');
    expect(gate).toBeGreaterThan(-1);
    expect(fold).toBeGreaterThan(gate);
    expect(PANEL.indexOf('<details', fold)).toBeGreaterThan(fold);
    // One fold, one gate: no second <details> outside it.
    expect(PANEL.match(/<details/g)).toHaveLength(1);
  });

  it('never posts who typed it — the service writes the actor', () => {
    const FORM = read('src/app/(protected)/trucks/border-queue-form.tsx');
    expect(FORM).not.toMatch(/name="updated|name="updatedBy|name="by/);
    expect(FORM).toContain('name="seenAt"');
  });
});
