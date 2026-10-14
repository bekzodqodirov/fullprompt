import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The yo'lkira-tarifi split's wiring (docs/YOLKIRA-TAQSIMOT.md §11). Each rule
 * here is something no behavioural test can see — a second caller that
 * agrees today, an import that works until the module graph closes a loop, a
 * read of the live tariff that gives the same answer until he edits a row.
 * Source shape, comments stripped first (#725: a fence matching the sentence
 * that explains it tests nothing).
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const SRC = walk('src');
const COSTING = SRC.filter((f) => f.startsWith('src/modules/wms/costing/'));

/** The body of a top-level function, by brace matching from its declaration. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, `no ${signature}`).toBeGreaterThan(-1);
  // The body opens with the first brace that ENDS a line — a return type's
  // `{ … }` literal never does.
  const open = src.indexOf(' {\n', at) + 1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

describe('one pool', () => {
  it('allocateEntry is called only by costing/pool.ts', () => {
    const callers = SRC.filter((f) => /\ballocateEntry\(/.test(strip(read(f))) && !f.endsWith('costing/engine.ts'));
    expect(callers).toEqual(['src/modules/wms/costing/pool.ts']);
  });

  it('the recompute and the void guard both go through costPool + loadPoolInputs', () => {
    const service = strip(read('src/modules/wms/costing/service.ts'));
    const recompute = body(service, 'export async function recomputeEntry(');
    expect(recompute).toMatch(/loadPoolInputs\(entry, ids, tx\)/);
    expect(recompute).toMatch(/costPool\(/);
    const guard = strip(read('src/modules/wms/costing/void-guard.ts'));
    expect(guard).toMatch(/homed\(\s*costPool\(/);
    expect(guard).toMatch(/loadPoolInputs\(entry, boxIds, tx\)/);
  });

  it('the copy is read only behind basis «freight» (a weight recompute never touches the side table)', () => {
    const service = strip(read('src/modules/wms/costing/service.ts'));
    const load = body(service, 'export async function loadPoolInputs(');
    const guard = load.indexOf("if (entry.allocationBasis !== 'freight') return { measures, freight: null };");
    const copyRead = load.indexOf('freightCopyFor(entry.id, handle)');
    expect(guard).toBeGreaterThan(-1);
    expect(copyRead).toBeGreaterThan(guard);
  });

  it('the recompute, the pool and the void guard never read the LIVE tariff or the warehouse column', () => {
    const forbidden = /calc_freight_tariffs|calcFreightTariffs|tariff-read|\btariffFor\b|\btariffHistory\b|\btariffColumnOf\b|warehouse_tariff_columns|warehouseTariffColumns/;
    const service = strip(read('src/modules/wms/costing/service.ts'));
    expect(body(service, 'export async function recomputeEntry(')).not.toMatch(forbidden);
    expect(body(service, 'export async function loadPoolInputs(')).not.toMatch(forbidden);
    expect(strip(read('src/modules/wms/costing/pool.ts'))).not.toMatch(forbidden);
    expect(strip(read('src/modules/wms/costing/void-guard.ts'))).not.toMatch(forbidden);
  });
});

describe('one home for the frozen copy', () => {
  it('cost_entry_tariffs is named only by freight-copy.ts, the schema and the migration', () => {
    const naming = SRC.filter((f) => /cost_entry_tariffs|costEntryTariffs/.test(strip(read(f))));
    // freight-ready.ts names it in its catalog probe (to_regclass) — a
    // question about the schema, never a read of a row.
    expect(naming.sort()).toEqual(
      [
        'src/modules/platform/db/schema/wms.ts',
        'src/modules/wms/costing/freight-copy.ts',
        'src/modules/wms/costing/freight-ready.ts',
      ].sort(),
    );
  });
});

describe('the module graph', () => {
  it('no file under costing imports calc/dictionaries or calc/service (the costing ↔ calc loop)', () => {
    for (const f of COSTING) {
      expect(strip(read(f)), f).not.toMatch(/from ['"](\.\.\/calc|@\/modules\/wms\/calc)\/(dictionaries|service)['"]/);
    }
  });

  it('the leaves never import ./service (a static cycle crashes a top-level extends at load)', () => {
    for (const leaf of ['freight-copy', 'tariff-column', 'freight-ready', 'customs-ids', 'errors', 'pool', 'freight-split', 'freight-types']) {
      const rel = `src/modules/wms/costing/${leaf}.ts`;
      if (!existsSync(path.join(ROOT, rel))) continue;
      expect(strip(read(rel)), rel).not.toMatch(/from ['"]\.\/service['"]/);
    }
  });

  it('freight-split.ts and pool.ts stay pure (no database, no node)', () => {
    for (const rel of ['src/modules/wms/costing/freight-split.ts', 'src/modules/wms/costing/pool.ts', 'src/modules/wms/costing/freight-types.ts']) {
      const imports = [...strip(read(rel)).matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) expect(['../calc/pricing', './engine', './freight-split', './freight-types'], `${rel}: ${i}`).toContain(i);
    }
  });
});

describe('the lot door heals a freight split', () => {
  it("editLot's re-split gate names measureChange, not only the rounded totals", () => {
    const edit = strip(read('src/modules/wms/receipts/edit.ts'));
    expect(edit).toMatch(
      /if \(result\.labelsToPrint > 0 \|\| result\.labelsToDestroy\.length > 0 \|\| totalsChanged \|\| measureChange\) \{/,
    );
  });
});

describe('the warehouse form keeps its column', () => {
  const actions = strip(read('src/app/(protected)/admin/warehouses/actions.ts'));
  it('reads the field only through readTariffZoneField (absent ≠ empty, #171)', () => {
    expect(actions).not.toMatch(/formData\.get\('tariffZone'\)/);
    expect(actions).toMatch(/readTariffZoneField\(formData\)/);
  });
  it('the zone never reaches the warehouses row (no such column)', () => {
    const toValues = body(actions, 'function toValues(');
    expect(toValues).not.toMatch(/tariffZone/);
  });
  it('the row, the column and the history land in ONE transaction', () => {
    const update = body(actions, 'export async function updateWarehouseAction(');
    expect(update).toMatch(/db\.transaction\(async \(tx\) => \{[\s\S]*setTariffColumnInTx\(tx, id, posted\)[\s\S]*writeAudit\(\s*tx,/);
  });
});

describe('the browser bundle stays free of the database', () => {
  it('the cost panel and the freight views import only pure costing values (#276)', () => {
    const SERVER = /costing\/(service|freight-offer|freight-copy|tariff-column|freight-ready|rebase|customs-ids|cost-entry)['"]/;
    for (const rel of ['src/components/cost-panel.tsx', 'src/components/freight-views.tsx']) {
      const lines = strip(read(rel))
        .split('\n')
        .filter((l) => /^import /.test(l) && SERVER.test(l));
      for (const line of lines) expect(line, `${rel}: a value import from a server module`).toMatch(/^import type /);
    }
  });

  it('the reason line is drawn only under a freight type (SP-5)', () => {
    const panel = strip(read('src/components/cost-panel.tsx'));
    expect(panel).toMatch(/const isFreightType = flags\.freightTypeIds\.includes\(typeId\);/);
    expect(panel).toMatch(/\{isFreightType && offered\.includes\('freight'\) && !usable\.ok && freight && \(/);
  });

  it('the panel posts the digest of the version its preview drew (M6)', () => {
    const panel = strip(read('src/components/cost-panel.tsx'));
    expect(panel).toMatch(/basis === 'freight' && usable\.ok && usable\.version \? \{ freightSeen: usable\.version\.digest \}/);
  });
});

