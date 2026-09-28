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
 *
 * The full audit then found the OTHER three batch documents — packing,
 * packing-photos and invoice — asking for a permission and never for the
 * warehouse, which is how a scoped operator in Yiwu could pull another
 * country's whole cargo list with a batch id. Fixing them one file at a time
 * is what let them drift apart in the first place, so all four now ask one
 * helper and this file pins that they do.
 */

/**
 * The act route's own fence (REWRITTEN in 0114, recorded per #974): the rule
 * moved into `mayReadHandoverAct` (wms/issue/act-door.ts) so the debt
 * register can ask it before drawing an act link (the judge's #7 — a door
 * that bounces the accountant is worse than none). The route must still
 * load the row, ASK the predicate with the row's warehouse, and refuse; the
 * predicate must still name both grants and fence on the warehouse.
 */
const actRoute = {
  file: 'src/app/api/handovers/[id]/act/route.ts',
  door: 'src/modules/wms/issue/act-door.ts',
  // The act must ask what the handover's own ATTACHMENTS ask — one document,
  // one rule (see access.ts's `handover` branch).
  permissions: ['scan.issue', 'receipts.unclaimed.resolve'],
};

/** The four that share `guardBatchDocument`. */
const batchDocumentRoutes = [
  { file: 'src/app/api/batches/[id]/manifest/route.ts', permissions: ['ved.docs', 'plans.manage'] },
  { file: 'src/app/api/batches/[id]/packing/route.ts', permissions: ['ved.docs', 'plans.manage'] },
  { file: 'src/app/api/batches/[id]/invoice/route.ts', permissions: ['ved.docs', 'plans.manage'] },
  {
    file: 'src/app/api/batches/[id]/packing-photos/route.ts',
    permissions: ['ved.docs', 'plans.manage', 'scan.load'],
  },
];

describe('document routes gate on permission AND warehouse, not just a session', () => {
  it(`${actRoute.file} checks its permissions and its scope`, () => {
    const source = readFileSync(actRoute.file, 'utf8');
    const door = readFileSync(actRoute.door, 'utf8');

    // It must look the row up — a gate that cannot see the document's
    // warehouse cannot fence on it.
    expect(source, 'loads the owning row').toMatch(/db\.query\.\w+\.findFirst/);
    // Anchored on the CALL and on the REFUSAL, never on the word: the first
    // version of this line asserted `toContain('inScope')` and stayed green
    // with the check stripped, because the import survived it (#166 — a red
    // proof that will not go red is evidence about the fixture).
    expect(source, 'asks the door with the row\'s warehouse').toMatch(
      /if \(!mayReadHandoverAct\(actor, row\.warehouseId\)\) return new Response\('Forbidden', \{ status: 403 \}\);/,
    );
    expect(source, 'still answers 401 unauthenticated').toContain('401');
    for (const permission of actRoute.permissions) {
      expect(door, `asks ${permission}`).toContain(`'${permission}'`);
    }
    expect(door, 'fences on the warehouse').toMatch(/inScope\(actor,\s*warehouseId\)/);
  });

  for (const route of batchDocumentRoutes) {
    it(`${route.file} goes through the shared batch-document guard`, () => {
      const source = readFileSync(route.file, 'utf8');
      // Anchored on the CALL and on the RETURN, because an import that
      // survives a stripped check is how the first version of this file
      // passed while the gate was gone (#166).
      expect(source, 'asks the guard').toMatch(/const refused = await guardBatchDocument\(/);
      expect(source, 'and actually refuses').toMatch(/if \(refused\) return refused;/);
      for (const permission of route.permissions) {
        expect(source, `asks ${permission}`).toContain(`'${permission}'`);
      }
    });
  }

  it('the guard itself fences on both ends of the trip', () => {
    // A truck between two countries stands on nobody's floor, so either end
    // may read it — the rule the batch card and the bot lookup already use.
    const guard = readFileSync('src/modules/wms/documents/route-guard.ts', 'utf8');
    expect(guard).toMatch(/inScope\(actor,\s*row\.originWarehouseId\)/);
    expect(guard).toMatch(/inScope\(actor,\s*row\.destWarehouseId\)/);
    expect(guard, 'refuses with 403').toContain('403');
    expect(guard, 'still answers 401 unauthenticated').toContain('401');
    expect(guard, 'and 404s a batch that is not there').toContain('404');
  });

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
