import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOCATION_BASES } from '@/modules/wms/costing/engine';

/**
 * ONE allocation-basis vocabulary (0132, docs/YOLKIRA-TAQSIMOT.md §9.3).
 *
 * The bases used to be written out four times — the engine's union, the zod
 * enum, the cost panel's list and the schema CHECK — and a FIFTH copy arrives
 * with 'freight' (0132's CHECK). A value one copy accepts and the next
 * refuses is a select that offers it and a save that answers a white page.
 * And the engine's old `default: return 1` meant a basis the switch did not
 * name split EVENLY BY BOX COUNT with no word anywhere.
 *
 * So the list lives in `engine.ts` (`ALLOCATION_BASES`) and everything else
 * either imports it or is pinned equal to it here. NOT `basis-vocabulary` —
 * that file is the BAZA vocabulary's fence (what a customs baza is per).
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const BASES = sorted(ALLOCATION_BASES);

/** The quoted words inside `allocation_basis IN (…)` / `${t.allocationBasis} IN (…)`. */
function checkList(text: string, needle: RegExp): string[] {
  const m = needle.exec(text);
  expect(m, `no basis CHECK matching ${needle}`).not.toBeNull();
  return sorted([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('allocation bases — one vocabulary', () => {
  it('the schema CHECK holds exactly the engine list', () => {
    const schema = read('src/modules/platform/db/schema/wms.ts');
    expect(checkList(schema, /'cost_entries_basis_check',\s*sql`\$\{t\.allocationBasis\} IN \(([^)]*)\)`/)).toEqual(BASES);
  });

  it('the NEWEST migration that re-adds the CHECK holds exactly the engine list', () => {
    const dir = 'src/modules/platform/db/migrations';
    const files = readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const adding = files.filter((f) => /ADD CONSTRAINT "?cost_entries_basis_check/i.test(read(`${dir}/${f}`)));
    expect(adding.length, 'some migration must widen the CHECK').toBeGreaterThan(0);
    const newest = adding.at(-1)!;
    expect(newest).toBe('0132_cost_freight_basis.sql');
    expect(
      checkList(read(`${dir}/${newest}`), /ADD CONSTRAINT "cost_entries_basis_check"\s*CHECK \("allocation_basis" IN \(([^)]*)\)\)/),
    ).toEqual(BASES);
  });

  it("0002's original list is a strict subset (the widening needs no backfill)", () => {
    const first = read('src/modules/platform/db/migrations/0002_shiny_the_hand.sql');
    const m = /cost_entries_basis_check" CHECK \("cost_entries"\."allocation_basis" IN \(([^)]*)\)\)/.exec(first)
      ?? /cost_entries_basis_check[^\n]*IN \(([^)]*)\)/.exec(first);
    expect(m).not.toBeNull();
    const old = sorted([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
    for (const b of old) expect(BASES).toContain(b);
    expect(old.length).toBeLessThan(BASES.length);
  });

  it('the zod enum and the cost panel import the list instead of restating it', () => {
    const service = stripComments(read('src/modules/wms/costing/service.ts'));
    expect(service).toMatch(/allocationBasis:\s*z\.enum\(ALLOCATION_BASES\)/);
    // The panel lists `offeredBases(…)`, which is built from the const (the
    // freight round, 0132) — so it imports the vocabulary second-hand.
    const panel = stripComments(read('src/components/cost-panel.tsx'));
    expect(panel).toMatch(/offeredBases\(scope, flags, typeId \|\| null\)/);
    expect(stripComments(read('src/modules/wms/costing/freight-split.ts'))).toMatch(
      /const old = ALLOCATION_BASES\.filter\(\(b\) => b !== 'freight'\);/,
    );
    // No hand-written list of its own: an array literal naming two bases.
    expect(panel).not.toMatch(/\[\s*'weight'\s*,\s*'volume'/);
  });

  it('every base has its words in all four bundles (costing.bases.<b>, #163)', () => {
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(read(`messages/${locale}.json`)) as { costing: { bases: Record<string, string> } };
      for (const b of ALLOCATION_BASES) {
        expect(typeof bundle.costing.bases[b], `${locale}: costing.bases.${b}`).toBe('string');
        expect(bundle.costing.bases[b]!.length).toBeGreaterThan(0);
      }
    }
  });
});
