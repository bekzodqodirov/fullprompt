import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * pricing.ts runs in the BROWSER now (the live per-row sums import
 * `customsFor`/`requestCustomsFor` into a 'use client' component), and its
 * purity was a header comment, not a fence. The day anyone adds a server
 * import — `db`, `next/headers`, `'server-only'` — the client bundle breaks,
 * and per #276's precedent typecheck and dev can both stay happy while the
 * build fails (or worse, quietly drags server code into the bundle).
 */
describe('pricing.ts stays pure', () => {
  const src = readFileSync('src/modules/wms/calc/pricing.ts', 'utf8');

  it('contains no import statements at all', () => {
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('never names a server-only surface', () => {
    for (const needle of ['server-only', 'next/headers', 'process.env', 'Date.now(']) {
      expect(src, `pricing.ts must not reach for ${needle}`).not.toContain(needle);
    }
  });
});
