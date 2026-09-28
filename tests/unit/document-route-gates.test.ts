import { globSync, readFileSync } from 'node:fs';
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

/** Comments out, so a fence cannot match the sentence explaining it (#725). */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ACT_DOOR = 'src/modules/wms/issue/act-door.ts';

/**
 * The handover act's door has ONE home (`issue/act-door.ts`) and every asker
 * goes through it — the act route, the attachment gate's `handover` branch,
 * and each screen that links to an act (the client card's «Yuklar» tab draws
 * «Akt» beside every handover it lists). It was two restatements with a
 * comment each saying they must never disagree; a third copy is how the
 * three would (the tab's judge, finding 5). And two parallel packages then
 * minted the door the same week, under one name, in two modules — so the
 * fence below does not trust a path: it walks `src/` for a second definition
 * and for a second statement of the permission pair.
 */
describe('the handover act asks one door, from every place that reads or links it', () => {
  it('the door names the two permissions and fences on the handover’s warehouse', () => {
    const door = code(ACT_DOOR);
    expect(door).toContain("'scan.issue'");
    expect(door).toContain("'receipts.unclaimed.resolve'");
    expect(door).toMatch(/inScope\(actor,\s*warehouseId\)/);
  });

  it('is defined once under src/, and the permission pair is stated nowhere else', () => {
    const files = globSync('src/**/*.{ts,tsx}');
    const defines = (name: string) =>
      files.filter((f) => new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(code(f)));
    expect(defines('mayReadHandoverAct')).toEqual([ACT_DOOR]);
    expect(defines('handoverActRefusal')).toEqual([ACT_DOOR]);
    // The grant list itself is the other place both codes are written; any
    // third file naming the pair is the rule restated beside the door.
    const pair = files.filter((f) => {
      const c = code(f);
      return c.includes("'scan.issue'") && c.includes("'receipts.unclaimed.resolve'");
    });
    expect(pair.sort()).toEqual([ACT_DOOR, 'src/modules/platform/rbac/catalog.ts'].sort());
  });

  it('the act route looks the handover up, asks the door with ITS warehouse, and refuses', () => {
    const route = code('src/app/api/handovers/[id]/act/route.ts');
    expect(route, 'loads the owning row').toMatch(/db\.query\.handovers\.findFirst/);
    // Anchored on the CALL and on the REFUSAL, never on the word (#166).
    expect(route).toMatch(
      /if \(!mayReadHandoverAct\(actor, row\.warehouseId\)\) return new Response\('Forbidden', \{ status: 403 \}\);/,
    );
    expect(route, 'still answers 401 unauthenticated').toContain('401');
  });

  it('the attachment gate’s handover branch asks the same door', () => {
    const access = code('src/modules/wms/attachments/access.ts');
    const branch = access.slice(access.indexOf("case 'handover':"), access.indexOf("case 'crm_activity':"));
    expect(branch).toMatch(/handoverActRefusal\(actor, row\.warehouseId\)/);
  });

  it('the «Yuklar» tab draws «Akt» only where the door admits, asked with the handover’s warehouse', () => {
    const view = code('src/modules/wms/client-card/yuklar-view.ts');
    expect(view).toMatch(/mayReadHandoverAct\(actor, warehouseId\)/);
    // …and the component draws the link from that answer alone.
    expect(code('src/components/client-cargo-history.tsx')).toMatch(/\{actOpen\.has\(h\.id\) && \(/);
  });

  it('the debt register draws «Akt» only where the same door admits, asked with the release’s warehouse', () => {
    // 0114's register links every release to its act; its reader is the
    // accountant, who holds neither grant — a link that bounces is worse than
    // none (the qarz judge's #7).
    const page = code('src/app/(protected)/finance/qarzga-berilgan/page.tsx');
    expect(page).toContain("from '@/modules/wms/issue/act-door'");
    expect(page).toMatch(/mayReadHandoverAct\(actor, row\.warehouseId\)/);
    expect(page).not.toContain("'scan.issue'");
  });
});

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
