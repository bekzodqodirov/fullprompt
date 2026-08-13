import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every document route must gate on more than a login.
 *
 * The pre-go-live audit found two that did not: `handovers/[id]/act` and
 * `batches/[id]/manifest` asked `requireActor()` and nothing else, while
 * their builders do no authorization of their own — so any of the ~20 staff
 * could pull any customer's handover act (name, phone, signed box list) or
 * any truck's full cargo manifest with an id, and handover ids are published
 * into card feeds that sales roles read.
 *
 * Source-shape, because these routes cannot be integration-tested: they read
 * the session through `requireActor`, which needs a request scope (#531's
 * rule, fourth outing). The GATE is what this pins; the predicates it names
 * are tested for real where they live.
 */

const routes = [
  {
    file: 'src/app/api/handovers/[id]/act/route.ts',
    // The act must ask what the handover's own ATTACHMENTS ask — one document,
    // one rule (see access.ts's `handover` branch).
    permissions: ['scan.issue', 'receipts.unclaimed.resolve'],
    scopeColumn: 'warehouseId',
  },
  {
    file: 'src/app/api/batches/[id]/manifest/route.ts',
    // What the invoice and packing siblings ask.
    permissions: ['ved.docs', 'plans.manage'],
    scopeColumn: 'originWarehouseId',
  },
];

describe('document routes gate on permission AND warehouse, not just a session', () => {
  for (const route of routes) {
    it(`${route.file} checks its permissions and its scope`, () => {
      const source = readFileSync(route.file, 'utf8');

      // It must look the row up — a gate that cannot see the document's
      // warehouse cannot fence on it.
      expect(source, 'loads the owning row').toMatch(/db\.query\.\w+\.findFirst/);
      for (const permission of route.permissions) {
        expect(source, `asks ${permission}`).toContain(`'${permission}'`);
      }
      // Anchored on the CALL, never on the word: the first version of this
      // line asserted `toContain('inScope')` and stayed green with the check
      // stripped, because the import survived it (#166 — a red proof that
      // will not go red is evidence about the fixture).
      expect(source, 'fences on the warehouse').toMatch(
        new RegExp(`inScope\\(actor,\\s*row\\.${route.scopeColumn}\\)`),
      );
      // And it must actually refuse, not merely compute an opinion.
      expect(source, 'refuses with 403').toContain('403');
      expect(source, 'still answers 401 unauthenticated').toContain('401');
    });
  }

  it('the builders themselves stay unauthorized — the ROUTE is the gate', () => {
    // Stated rather than asserted-away: `buildHandoverAct(id)` and
    // `buildManifestXlsx(id)` take no actor by design (they are also called
    // from trusted server paths). That is exactly why the route above must
    // carry the whole fence, and why this file exists.
    const act = readFileSync('src/modules/wms/documents/handover-act.ts', 'utf8');
    const manifest = readFileSync('src/modules/wms/documents/manifest-xlsx.ts', 'utf8');
    expect(act).not.toContain('authorize(');
    expect(manifest).not.toContain('authorize(');
  });
});
