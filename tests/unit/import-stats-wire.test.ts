import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { candidateStatement, chinaOriginSql } from '@/modules/wms/customs/import-stats-sql';

/**
 * The wiring of «Narxlar statistikasi» (his C1-C6), where a behaviour test
 * cannot see it: which parameters a route reads, which aggregate a module
 * may call, which pool a transaction body may touch, which press is the one
 * that drafts a price.
 *
 * Comments are stripped first (#725): a fence that trips on the sentence
 * explaining it is a fence that gets deleted.
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const STATS_ROUTE = read('src/app/api/calc/import-baza/stats/route.ts');
const LIST_ROUTE = read('src/app/api/calc/import-baza/route.ts');
const STATS = read('src/modules/wms/customs/import-stats.ts');
const STATS_SQL = read('src/modules/wms/customs/import-stats-sql.ts');
const SERVICE = read('src/modules/wms/customs/import-service.ts');
const BAZA_STATS = read('src/app/(protected)/hisoblash/[id]/baza-stats.tsx');
const SPREAD = read('src/components/charts/price-spread.tsx');
const DIALOG = read('src/app/(protected)/hisoblash/[id]/import-baza-dialog.tsx');

/** The text of one top-level function: from its signature to the next one. */
function bodyOf(source: string, signature: string): string {
  const at = source.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const next = source.slice(at + signature.length).search(/\n(export )?(async )?function /);
  return next === -1 ? source.slice(at) : source.slice(at, at + signature.length + next);
}

const dialect = new PgDialect();

describe('1. the stats route reads the item and the basis, and nothing else', () => {
  it('is behind ved.docs and asks only for item and basis', () => {
    expect(STATS_ROUTE).toContain("authorize('ved.docs')");
    const asked = [...STATS_ROUTE.matchAll(/params\.get\('([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(asked)).toEqual(new Set(['item', 'basis']));
    // No other door into the query string.
    expect(STATS_ROUTE).not.toMatch(/\.getAll\(|searchParams\.entries|searchParams\.forEach|params\.entries/);
  });
});

describe('2. disc percentiles only — no interpolation and no mean (#1297)', () => {
  it('the statistics speak percentile_disc and never _cont, avg or sum', () => {
    for (const source of [STATS, STATS_SQL]) {
      expect(source).toContain('percentile_disc');
      expect(source).not.toContain('percentile_cont');
      expect(source).not.toMatch(/\bavg\(/i);
      expect(source).not.toMatch(/\bsum\(/i);
    }
  });
});

describe('3. the ceiling transaction body touches only its tx (#714)', () => {
  it('readImportStats runs every statement on tx and never on the pool', () => {
    const body = bodyOf(STATS, 'export async function readImportStats(');
    expect(body).toContain('tx.execute');
    expect(body).not.toMatch(/\bdb\./);
    expect(body).not.toContain('getSetting');
  });
});

describe('4. only «Tanlash» drafts a price (C3)', () => {
  it('onPick is called once, inside the exemplar-pick button', () => {
    const calls = [...BAZA_STATS.matchAll(/\bonPick\(/g)];
    expect(calls).toHaveLength(1);
    const button = BAZA_STATS.indexOf('data-testid="calc-import-exemplar-pick"');
    expect(button).toBeGreaterThan(-1);
    const end = BAZA_STATS.indexOf('</button>', button);
    const call = calls[0]!.index!;
    expect(call).toBeGreaterThan(button);
    expect(call).toBeLessThan(end);
  });
});

describe('5. the chart is render-only', () => {
  it('has no hooks, no client directive and no render slots', () => {
    expect(SPREAD).not.toMatch(/useState|useEffect|useRef|useMemo/);
    expect(SPREAD).not.toContain("'use client'");
    expect(SPREAD).not.toMatch(/\bchildren\b/);
  });
});

describe('6. both routes read the row through ONE function (#513)', () => {
  it('readPickerItem is the item read, and the list route selects no item itself', () => {
    expect(STATS_ROUTE).toContain('readPickerItem(');
    expect(LIST_ROUTE).toContain('readPickerItem(');
    expect(LIST_ROUTE).not.toContain('calcRequestItems');
  });
});

describe('6b. the 📥 waits on a row whose code, count, weight or volume is drafted', () => {
  it('both routes read those off the SAVED row, so a dirty row cannot open the picker', () => {
    const TABLE = read('src/app/(protected)/hisoblash/[id]/items-table.tsx');
    // ONE rule (row-draft.ts), asked by the desktop ⋯ fold and the phone sheet.
    const ROW_DRAFT = read('src/modules/wms/calc/row-draft.ts');
    const rule = bodyOf(ROW_DRAFT, 'export function rowDirtyForPicker(');
    expect(rule).toContain("(['tnvedCode', 'quantity', 'weightKg', 'volumeM3'] as const).some(");
    expect(TABLE).toContain('rowDirty={rowDirtyForPicker(drafts)}');
    const at = TABLE.indexOf('data-testid="calc-import-pick"');
    expect(at).toBeGreaterThan(-1);
    expect(TABLE.slice(at, TABLE.indexOf('</button>', at))).toContain('disabled={rowDirty}');
    // The phone sheet's door: the same rule, and a disabled button.
    expect(TABLE).toContain("rowDirtyForPicker(d) ? 'row_dirty' : 'open'");
    const SHEET = read('src/app/(protected)/hisoblash/[id]/row-sheet.tsx');
    const door = SHEET.indexOf('data-testid="calc-phone-import"');
    expect(door).toBeGreaterThan(-1);
    expect(SHEET.slice(door, SHEET.indexOf('</button>', door))).toContain("model.importDoor === 'row_dirty'");
  });
});

describe('7. one intent left: every opener PICKS', () => {
  it('the phone’s look-only door is gone with its branch (the sheet’s 📥 picks, his B1 a)', () => {
    // A `mode` with a single value is a branch nobody can reach; the view
    // half went when the phone sheet's 📥 replaced the look-only door.
    const at = DIALOG.indexOf('export interface PickerTarget');
    const iface = DIALOG.slice(at, DIALOG.indexOf('\n}', at));
    expect(iface).not.toMatch(/\bmode\b/);
    for (const source of [DIALOG, BAZA_STATS]) {
      expect(source).not.toContain("'view'");
      expect(source).not.toMatch(/statsPickPhone|statsFewView|statsTimeoutView|viewonly/);
    }
  });
});

describe('8. a statement over its ceiling is a sentence', () => {
  it('the stats route maps a cancel to state timeout', () => {
    const at = STATS_ROUTE.indexOf('isQueryCanceled(err)');
    expect(at).toBeGreaterThan(-1);
    expect(STATS_ROUTE.slice(at, at + 400)).toContain("empty('timeout')");
  });
});

describe('9. «newest» has ONE order, clamped (his C6)', () => {
  it('both batch choosers ask batchRecencySql, and the previous one both ends', () => {
    const newest = bodyOf(SERVICE, 'export async function newestReadyBatchId(');
    const previous = bodyOf(SERVICE, 'export async function previousReadyBatchId(');
    for (const body of [newest, previous]) {
      expect(body).toContain('batchRecencySql(');
      expect(body).not.toContain('desc(customsImportBatches.uploadedAt)');
      expect(body).not.toMatch(/period_from\s+DESC/i);
    }
    expect(previous).toContain('batchEndSql(');
    expect(previous).toContain('batchStartSql(');
    expect(bodyOf(SERVICE, 'export function batchEndSql(')).toContain('LEAST(');
    expect(bodyOf(SERVICE, 'export function batchStartSql(')).toContain('LEAST(');
    expect(bodyOf(SERVICE, 'export function batchRecencySql(')).not.toMatch(/period_from/);
  });

  it('both DOORS ask the chooser — the stats route itself, the list route through suggestImportBaza', () => {
    // A fence on the chooser's body says nothing about whether the routes
    // call it; integration test 12 makes the two disagree under any other
    // order, and this names the two calls it depends on.
    expect(STATS_ROUTE).toContain('batchId = await newestReadyBatchId();');
    const call = LIST_ROUTE.slice(LIST_ROUTE.indexOf('suggestImportBaza('));
    const opts = call.slice(0, call.indexOf(');'));
    expect(opts).toContain('picker: true');
    expect(opts).not.toContain('batchId');
  });
});

describe('10. the auto-fill pays for no aggregate (rendered, not read)', () => {
  const input = { tnvedCode: '6702900000', name: 'x', units: ['kg' as const], weightPerUnitKg: null };
  const id = '00000000-0000-0000-0000-000000000000';
  it('the plain statement carries the country and nothing of the named series', () => {
    const text = dialect.sqlToQuery(candidateStatement(id, input, 'abcd', 10)).sql;
    expect(text).toContain('origin_country');
    expect(text).not.toContain('MATERIALIZED');
    expect(text).not.toContain('percentile_disc');
    expect(text).not.toContain('named_q');
  });
  it('the dialog statement rides the scan with the named series', () => {
    const text = dialect.sqlToQuery(candidateStatement(id, input, 'abcd', 10, { minSim: 0.45 })).sql;
    expect(text).toContain('MATERIALIZED');
    expect(text).toContain('percentile_disc');
    expect(text).toContain('named_q');
    expect(text).toContain('named_ex');
  });
});

describe('11. «Xitoy» names the territories that are NOT China', () => {
  it('the vocabulary carries КНР and excludes Hong Kong, Macao and Taiwan', () => {
    const q = dialect.sqlToQuery(chinaOriginSql(sql`o`));
    const rendered = `${q.sql} ${q.params.join(' ')}`;
    for (const word of ['КНР', 'ГОНКОНГ', 'МАКАО', 'ТАЙВАН', '156']) expect(rendered).toContain(word);
  });
});

describe('12. the weight label and the previous-quarter line each have one rule', () => {
  it('the weight label is `kg`, and the previous-quarter line asks `prevLine`', () => {
    expect(BAZA_STATS).toContain("t('statsWeight', { kg: kg(answer.perPieceKg) })");
    expect(BAZA_STATS).not.toMatch(/num\(answer\.perPieceKg/);
    expect(BAZA_STATS).toContain('prevLine(unit.prev, answer.filtered)');
    // The table's «oldingi chorak» cell follows the same decision.
    expect(BAZA_STATS).toContain("prev === 'median' ? cell(");
  });
});
