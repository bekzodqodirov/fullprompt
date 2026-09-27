import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * «QR yopishtirilmadi» wiring (0112, the owner's Q8). Source-shape on
 * purpose: every rule below is a WHERE clause or a gate that works on its own
 * — the fence is about who else may write the one column the rule reads, and
 * which warehouse a door asks about. A behavioural test proves only the doors
 * it happens to call (#531). Comments are stripped first, or a fence matches
 * the sentence explaining it (#725).
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The body of a top-level function, up to the next top-level declaration. */
function body(path: string, fn: string): string {
  const src = read(path);
  const start = src.search(new RegExp(`(export\\s+)?(async\\s+)?function ${fn}\\(`));
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |type |interface )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** The text between a call's own parentheses, `open` pointing at its `(`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** The name of the function whose body holds `index`: the last declaration before it. */
function enclosing(src: string, index: number): string {
  const before = src.slice(0, index);
  const decl = /(?:function\s+(\w+)\s*[<(]|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/g;
  let name = '?';
  for (const m of before.matchAll(decl)) name = m[1] ?? m[2] ?? name;
  return name;
}

const SHEET = 'src/modules/wms/labels/sheet.ts';
const QRLESS = 'src/modules/wms/labels/qrless.ts';
const INVENTORY = 'src/modules/wms/inventory/service.ts';

describe('who may put a label on a carton', () => {
  it('exactly two writers of label_printed_at — the receipt’s print record and «stikerlar yopishtirildi»', () => {
    // DERIVED: every `.set(`/`.values(` whose argument names the column, and
    // every raw `label_printed_at =`, anywhere in src/. Each writer silently
    // changes which cartons are QR-siz, because the rule READS this column —
    // so a third one must be a decision, not an accident.
    const writers = new Set<string>();
    for (const path of walk('src')) {
      const src = read(path);
      for (const call of src.matchAll(/\.(?:set|values)\(/g)) {
        const open = call.index! + call[0].length - 1;
        if (/\blabelPrintedAt\b/.test(argsAt(src, open))) {
          writers.add(`${relative('.', path)}:${enclosing(src, call.index!)}`);
        }
      }
      for (const raw of src.matchAll(/\blabel_printed_at\s*=(?!=)/g)) {
        writers.add(`${relative('.', path)}:${enclosing(src, raw.index!)}`);
      }
    }
    expect([...writers].sort()).toEqual([`${QRLESS}:confirmQrLabelled`, `${SHEET}:recordLabelPrint`]);
  });

  it('the receipt’s own sheet and its print record leave a QR-siz carton alone', () => {
    expect(body(SHEET, 'labelsForReceipt')).toContain('NOT ${qrlessBoxSql()}');
    expect(body(SHEET, 'recordLabelPrint')).toContain('NOT ${qrlessBoxSql()}');
  });

  it('the press stamps only what is here, still QR-siz, at a status this person may stamp', () => {
    const confirm = body(QRLESS, 'confirmQrLabelled');
    expect(confirm).toMatch(/const statuses = \[\.\.\.printableStatuses\(actor, warehouseId\)\]/);
    const update = confirm.slice(confirm.indexOf('.update(boxes)'));
    expect(update).toContain('eq(boxes.currentWarehouseId, warehouseId)');
    expect(update).toContain('inArray(boxes.status, statuses)');
    expect(update).toContain('qrlessBoxSql()');
    // The audit row is the PRINTING warehouse's.
    expect(confirm).toContain('writeAudit(tx, { ...ctx, warehouseId }');
    // A planned carton is the count door's (decision 31), from its one home.
    expect(body(QRLESS, 'printableStatuses')).toContain('mayCountMove(actor, warehouseId)');
    // The sheet asks the same list the press does.
    expect(body(QRLESS, 'qrlessLabelsAt')).toContain('printableStatuses(actor, warehouseId)');
  });
});

describe('the doors ask at the warehouse the cartons STAND in', () => {
  it('the PDF and the press authorise at the warehouse they were handed, never the receipt’s', () => {
    const pdf = read('src/app/api/inventory/qrsiz-labels/route.ts');
    expect(pdf).toContain("authorize('receipts.create', { warehouseId: query.data.warehouseId })");
    expect(pdf).toMatch(/qrlessLabelsAt\(\s*query\.data\.warehouseId,/);
    const stuck = read('src/app/api/inventory/qrsiz-labels/stuck/route.ts');
    expect(stuck).toContain("authorize('receipts.create', { warehouseId: body.data.warehouseId })");
    expect(stuck).toMatch(/confirmQrLabelled\(body\.data\.warehouseId, body\.data\.boxIds, actor,/);
    for (const route of [pdf, stuck]) expect(route).not.toMatch(/receipts?\.warehouseId/);
  });

  it('the print-later sheet checks the same warehouse and records nothing when it prints', () => {
    const page = read('src/app/(print)/print/qrsiz/page.tsx');
    expect(page).toContain("actor.permissions.has('receipts.create')");
    expect(page).toContain('inScope(actor, query.data.warehouseId)');
    const sheet = page.slice(page.indexOf('<PrintSheet'), page.indexOf('/>', page.indexOf('<PrintSheet')));
    expect(sheet).not.toContain('recordHref');
  });
});

describe('the stocktake cannot write one off (decision 33)', () => {
  it('the snapshot flags both kinds and the write-off refuses both, posted or not', () => {
    const snapshot = body(INVENTORY, 'inventorySnapshot');
    expect(snapshot).toMatch(/qrless: sql<boolean>`\$\{qrlessJoinedSql\(\)\}`/);
    expect(snapshot).toMatch(/countMoved: sql<boolean>`\$\{lastScanIsCountSql\(sql`\$\{boxes\}`\)\}`/);
    const reconcile = body(INVENTORY, 'reconcileInventory');
    const lost = reconcile.slice(reconcile.indexOf('const lost = await tx'));
    expect(lost).toContain('NOT ${qrlessBoxSql()}');
    expect(lost).toContain('NOT ${lastScanIsCountSql(sql`${boxes}`)}');
  });
});

describe('the wizard’s box', () => {
  it('is one element: a second testid would make a phone test’s .check() a strict-mode refusal', () => {
    const wizard = read('src/app/(protected)/receive/receive-wizard.tsx');
    expect(wizard.match(/data-testid="lot-qr-skipped"/g)).toHaveLength(1);
    expect(wizard).toContain('qrSkipped: Boolean(lot.qrSkipped)');
  });
});
