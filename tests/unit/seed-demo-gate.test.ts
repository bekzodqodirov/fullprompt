import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `seed.ts` runs on EVERY deploy, from the compose `migrate` service, against
 * the owner's live database. So it must contain no demo data at all.
 *
 * This used to be a much weaker test: the demo blocks lived in `seed.ts`
 * behind an `if (seedDemo)` flag, and this file checked that the flag was
 * wired up. The owner found out what that is worth by deploying — demo
 * warehouses and demo staff went to production alongside his own, because
 * «empty users table» is true of a real installation exactly once, on the day
 * it is created. The blocks now live in `seed-demo.ts`, which only the test
 * databases run, and this file asserts the SEPARATION rather than the flag:
 * there is no longer a condition to get wrong.
 */
const seed = readFileSync(new URL('../../scripts/seed.ts', import.meta.url), 'utf8');
const demo = readFileSync(new URL('../../scripts/seed-demo.ts', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('the production seed carries no demo data', () => {
  it('never mentions the demo password, the demo phones or the demo warehouses', () => {
    // The password is the sharpest of these: it is published in the repo and
    // in every test, so a `seed.ts` that knows it is a `seed.ts` that can
    // create an account anybody can sign in to.
    expect(seed).not.toContain('demo1234');
    expect(seed).not.toMatch(/\+99890000000\d/);
    for (const code of ['Guangzhou', 'Yiwu', 'Kashgar', 'Andijan', 'Tashkent 1']) {
      expect(seed, code).not.toContain(code);
    }
    expect(seed).not.toContain('GS777');
  });

  it('has no flag left to get wrong', () => {
    // The whole class of bug: one boolean between a live company and a set of
    // accounts with a published password.
    expect(seed).not.toContain('seedDemo');
    expect(seed).not.toContain('SEED_DEMO');
  });

  it('keeps writing the reference data every installation needs', () => {
    for (const always of [
      'insert(permissions)',
      'insert(roles)',
      'insert(rolePermissions)',
      'insert(settings)',
      'insert(currencies)',
      'costTypes',
      'truckPresets',
      'leadStages',
    ]) {
      expect(seed, always).toContain(always);
    }
  });
});

describe('the demo seed is a separate, guarded script', () => {
  it('refuses a database that holds a real account', () => {
    // A script that is safe only when nobody makes a mistake is not safe.
    expect(demo).toContain('safeToSeed');
    expect(demo).toMatch(/DEMO_PHONES\.has/);
    expect(demo).toContain("SEED_DEMO === '1'");
  });

  it('is reachable, and CI runs it', () => {
    expect(pkg.scripts['db:seed:demo']).toBe('tsx scripts/seed-demo.ts');
    expect(ci).toContain('pnpm db:seed:demo');
  });

  it('is NOT wired into the compose migrate service', () => {
    // `migrate` is what runs on the owner's server on every deploy.
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).not.toContain('db:seed:demo');
  });
});
