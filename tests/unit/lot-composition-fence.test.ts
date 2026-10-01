import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Lot tarkibi's readers, as a shape (docs/LOT-TARKIBI.md §9, §11.1).
 *
 * THE RULE: the lot keeps its body. Only the customs papers, the agent file,
 * the Bojxona tab, the price history and the receipt card's own editor learn
 * that a lot has a composition — nobody knows which carton is which (the
 * owner's 2c) and the warehouse does no re-stickering (his 6), so a label,
 * a scan, a plan, the stock table, the cabinet or a push that printed
 * «Мышь» about a carton would be printing a guess.
 *
 * Two lists, because «EXACTLY the taught list» failed on day one (the judge's
 * R2: the labels, the audit fields and the uploader name none of the tokens)
 * and a builder would have loosened it to a subset check that also passes
 * when the scan finds nothing. ALLOWED is every file that MAY name the
 * tables or import the modules; MUST is the files that have to — a scan
 * that finds nothing is red.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

const TOKENS = [
  'lotCompositions',
  'lotCompositionLines',
  'batchSentCompositions',
  'lot_compositions',
  'lot_composition_lines',
  'batch_sent_compositions',
  'lot-composition',
  'composition-math',
];
const MODULES = ['src/modules/wms/receipts/lot-composition.ts', 'src/modules/wms/receipts/composition-math.ts'];

const MUST = [
  'src/modules/platform/db/schema/wms.ts',
  ...MODULES,
  'src/modules/wms/documents/composition-cells.ts',
  'src/modules/wms/documents/ved-xlsx.ts',
  'src/modules/wms/documents/packing-photos-xlsx.ts',
  'src/modules/wms/documents/agent-xlsx.ts',
  'src/modules/wms/tnved/batch-lots.ts',
  'src/modules/wms/tnved/service.ts',
  'src/modules/wms/finance/price-history.ts',
  'src/app/(protected)/receipts/[id]/page.tsx',
  'src/app/(protected)/receipts/[id]/composition-panel.tsx',
  'src/app/(protected)/receipts/[id]/composition-actions.ts',
  'src/app/(protected)/batches/[id]/tnved/page.tsx',
  'src/app/(protected)/batches/[id]/tnved/actions.ts',
  'src/app/(protected)/batches/batch-actions-server.ts',
];
const ALLOWED = new Set([
  ...MUST,
  'src/app/(protected)/receipts/[id]/lot-edit-form.tsx',
  'src/app/(protected)/batches/[id]/tnved/tnved-editor.tsx',
]);

/** The readers deliberately NOT taught — redundant with ALLOWED, but a failure here names the rule. */
const DENY = [
  'src/modules/wms/labels/sheet.ts',
  'src/modules/wms/scanning/',
  'src/modules/wms/planning/',
  'src/modules/wms/inventory/',
  'src/modules/wms/crates/',
  'src/modules/wms/client-cabinet/',
  'src/modules/wms/notices/',
  'src/modules/wms/bot/',
  'src/modules/wms/search/',
  'src/modules/platform/broadcast/',
  'src/modules/wms/documents/manifest-xlsx.ts',
  'src/modules/wms/documents/handover-act.ts',
  'src/modules/wms/costing/',
  'src/modules/wms/finance/pricing-view.ts',
  'src/modules/wms/finance/unpriced.ts',
  'src/modules/platform/ai/',
];

const files = globSync('src/**/*.{ts,tsx}');
const naming = files.filter((path) => MODULES.includes(path) || TOKENS.some((t) => read(path).includes(t)));

/** The text of `function NAME(` up to the next top-level declaration. */
function fn(source: string, name: string): string {
  const at = source.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`));
  expect(at, `function ${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(at + 1);
  const next = rest.search(/\n(export |async function |function |const |interface |type |class )/);
  return next === -1 ? source.slice(at) : source.slice(at, at + 1 + next);
}

describe('who learns that a lot has a composition', () => {
  it('only the ALLOWED files name the tables or import the modules', () => {
    const outside = naming.filter((path) => !ALLOWED.has(path));
    expect(outside, 'a reader outside docs/LOT-TARKIBI.md §9 learned the composition').toEqual([]);
  });

  it('…and every file that must, does — a scan that finds nothing is red', () => {
    for (const path of MUST) expect(naming, path).toContain(path);
  });

  it('the named deny list: labels, scans, plans, stock, crates, the cabinet, pushes, the bot, money, the AI', () => {
    const leaks = naming.filter((path) => DENY.some((deny) => path.startsWith(deny)));
    expect(leaks).toEqual([]);
  });
});

describe('the rules the shape can hold', () => {
  it('3. the writer never reaches the TNVED memory', () => {
    const src = read('src/modules/wms/receipts/lot-composition.ts');
    expect(src).not.toMatch(/\bsaveTnved\b/);
    expect(src).not.toMatch(/tnvedAssignments|tnved_assignments/);
  });

  it('4. the invoice prints a composed lot through paperLines, never the memory’s code; places come from the parts', () => {
    const src = read('src/modules/wms/documents/ved-xlsx.ts');
    const invoice = fn(src, 'buildInvoiceXlsx');
    const from = invoice.indexOf('if (comp) {');
    const to = invoice.indexOf('continue;', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const branch = invoice.slice(from, to);
    expect(branch).toContain('paperLines(');
    expect(branch).not.toContain('tnvedFor(');
    expect(branch).not.toContain('tnved.get(');
    expect(fn(src, 'invoicePlaces')).toContain('invoicePlaceParts(');
  });

  it('5. the price history counts kinds in their own CTE, never inside `load` (#432)', () => {
    const src = read('src/modules/wms/finance/price-history.ts');
    const from = src.indexOf('load AS (');
    const to = src.indexOf('),', from);
    expect(from).toBeGreaterThan(-1);
    expect(src.slice(from, to)).not.toContain('lot_composition_lines');
    const kinds = src.indexOf('kinds AS (');
    expect(kinds).toBeGreaterThan(-1);
    expect(src.slice(kinds, src.indexOf('),', kinds))).toContain('lot_composition_lines');
  });

  it('6. the TNVED editor keys every row by rowKey, never by its lot', () => {
    const src = read('src/app/(protected)/batches/[id]/tnved/tnved-editor.tsx');
    expect(src).not.toMatch(/r\.lotId === lotId/);
    expect(src).toContain('rowKey(');
    expect(src).toMatch(/!r\.line/);
  });

  it('7. the copy is ONE INSERT … SELECT … RETURNING with the positions; the tick takes the truck doors’ lock order first', () => {
    const service = read('src/modules/wms/receipts/lot-composition.ts');
    const copy = fn(service, 'copyCompositionsInTx');
    expect(copy.match(/\.execute\(/g) ?? []).toHaveLength(1);
    expect(copy).toMatch(/INSERT INTO batch_sent_compositions[\s\S]*segments[\s\S]*SELECT[\s\S]*RETURNING lot_id, rev, segments/);
    const freeze = fn(service, 'freezeCompositionsInTx');
    expect(freeze.indexOf('truckPositions(')).toBeGreaterThan(-1);
    expect(freeze.indexOf('copyCompositionsInTx(')).toBeGreaterThan(freeze.indexOf('truckPositions('));
    // The review's deadlock: count-load's advisory lock, then the truck row,
    // and only then the copy (whose FK checks key-share the lots) — the order
    // count-load (advisory → lot → truck) and the unload doors (truck → lot)
    // both meet as a wait, never as a cycle.
    const locks = fn(service, 'lockTruckForTickInTx');
    const advisory = locks.indexOf('lockTruckLoading(tx, batchId)');
    expect(advisory).toBeGreaterThan(-1);
    expect(locks.indexOf('FOR NO KEY UPDATE')).toBeGreaterThan(advisory);
    const action = fn(read('src/app/(protected)/batches/batch-actions-server.ts'), 'setSentToAgentAction');
    const truckRow = action.indexOf('lockTruckForTickInTx(tx, batchId)');
    const copied = action.indexOf('freezeCompositionsInTx(');
    const update = action.indexOf('.update(batches)');
    expect(truckRow).toBeGreaterThan(-1);
    expect(copied).toBeGreaterThan(truckRow);
    expect(update).toBeGreaterThan(copied);
    expect(action).toContain('paperStamp(frozen) !== postedStamp');
    // A wait that runs out and a half-applied deploy are sentences, not the error page.
    expect(action).toContain('isBusyError(err)');
    expect(action).toContain('isServerBehind(err)');
  });

  it('7b. the frozen-truck lists read the copy, never `sent_to_agent_at`', () => {
    for (const path of ['src/app/(protected)/receipts/[id]/page.tsx', 'src/app/(protected)/receipts/[id]/composition-actions.ts']) {
      const src = read(path);
      expect(src, path).toContain('truck.frozen');
      expect(src, path).not.toMatch(/sentAt/);
    }
  });

  it('9. the save day is Tashkent’s, and the panel’s two quiet refusals speak', () => {
    const page = read('src/app/(protected)/receipts/[id]/page.tsx');
    expect(page).toContain('savedDay: tashkentDay(c.savedAt)');
    const panel = read('src/app/(protected)/receipts/[id]/composition-panel.tsx');
    expect(panel).not.toMatch(/savedAt\.slice\(/);
    // The voided prixod's clear and a document's ✕ set a refusal on a failed answer.
    expect(panel).toContain('else setClearRefusal(res)');
    expect(fn(panel, 'removeDocument')).toContain("setRefusal({ error: code === 'in_use' ? 'in_use' : 'remove_failed' })");
  });

  it('8. compositionsFor defaults its handle to db (the tx-pool fence’s seed shape) and issues ONE statement', () => {
    const body = fn(read('src/modules/wms/receipts/lot-composition.ts'), 'compositionsFor');
    expect(body).toMatch(/exec: Db \| Tx = db/);
    expect(body.match(/\.execute\(/g) ?? []).toHaveLength(1);
  });
});
