import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The seed runs on EVERY deploy (compose `migrate` service). Demo accounts —
 * which carry a published password — must therefore only ever be created
 * while bootstrapping an empty database, or a deleted demo account would
 * come back on the next update. This test pins that wiring: it is cheap to
 * break by accident and expensive to notice in production.
 */
const seed = readFileSync(new URL('../../scripts/seed.ts', import.meta.url), 'utf8');

describe('seed demo gating', () => {
  it('decides demo seeding from an empty users table, with an explicit override', () => {
    expect(seed).toMatch(/SEED_DEMO.*===.*'1'/);
    expect(seed).toMatch(/count\(\*\)[\s\S]{0,80}from\(users\)/);
  });

  it('gates every demo block (users, clients, warehouses, FX example, receipt)', () => {
    // Each demo section must sit behind the flag.
    for (const marker of [
      'Warehouses (bootstrap only',
      'Demo users (bootstrap only',
      'Demo clients',
    ]) {
      expect(seed, marker).toContain(marker);
    }
    expect(seed).toMatch(/seedDemo \? \(await db\.select\(\)\.from\(users\)/); // FX example
    expect(seed).toMatch(/if \(!seedDemo\) return;/); // canonical receipt
    expect(seed).toMatch(/seedM1\(whIds, seedDemo\)/);
  });

  it('keeps reference data unconditional (permissions/roles/grants/settings)', () => {
    const gatedRegion = seed.slice(seed.indexOf('async function main'));
    for (const always of [
      'insert(permissions)',
      'insert(roles)',
      'insert(rolePermissions)',
      'insert(settings)',
      'insert(currencies)',
    ]) {
      expect(gatedRegion, always).toContain(always);
    }
    // The grants loop must not be nested in a seedDemo branch.
    const grantsIdx = seed.indexOf('insert(rolePermissions)');
    const demoIdx = seed.indexOf('if (seedDemo)');
    expect(grantsIdx).toBeLessThan(demoIdx);
  });
});
