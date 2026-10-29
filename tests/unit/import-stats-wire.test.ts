import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { candidateStatement, chinaOriginSql, codeBounds, codeMatchSql } from '@/modules/wms/customs/import-stats-sql';

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

  it('the heading read’s ceiling body calls nothing but its own tx (review P2-NIT-5)', () => {
    // `queryCandidates` runs on the ceiling transaction for a heading, and
    // tx-pool.test.ts does not scan `underCeiling` bodies: a `getSetting(` or
    // a `db.` added there would hold two of the ten pool connections per 📥
    // and per pick, unseen. So every CALL in it — and in the ceiling
    // callback that reaches it — is on an allowlist of the tx and pure
    // helpers; anything else must be read before the transaction opens.
    const file = ts.createSourceFile(
      'import-baza.ts',
      readFileSync('src/modules/wms/customs/import-baza.ts', 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const callsIn = (node: ts.Node): string[] => {
      const out: string[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) out.push(n.expression.getText(file));
        ts.forEachChild(n, visit);
      };
      visit(node);
      return out;
    };
    let query: ts.FunctionDeclaration | undefined;
    let ceiling: ts.ArrowFunction | undefined;
    const find = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'queryCandidates') query = n;
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(file) === 'underCeiling' &&
        n.arguments[0] &&
        ts.isArrowFunction(n.arguments[0])
      ) {
        ceiling = n.arguments[0];
      }
      ts.forEachChild(n, find);
    };
    find(file);
    expect(query, 'queryCandidates moved — re-anchor this fence').toBeDefined();
    expect(ceiling, 'the heading read left underCeiling — re-anchor this fence').toBeDefined();
    const PURE = new Set(['candidateStatement', 'Number', 'rows.map', 'input.units.includes', 'namedSeriesOf', 'jsonRows']);
    const queryCalls = callsIn(query!.body!);
    expect(queryCalls).toContain('exec.execute');
    for (const call of queryCalls) {
      expect(call === 'exec.execute' || PURE.has(call), `queryCandidates calls ${call}`).toBe(true);
    }
    for (const call of callsIn(ceiling!.body)) {
      expect(['tx.execute', 'String', 'ask'].includes(call), `the ceiling body calls ${call}`).toBe(true);
    }
    expect(query!.body!.getText(file)).not.toMatch(/\bdb\b/);
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
    // The pick's own drafted code is exempt (review regression-18) — and the
    // pick then REPLACES a drafted code rather than spreading it under the
    // next declaration.
    expect(rule).toContain("!(k === 'tnvedCode' && draft?.importRowId !== undefined)");
    const pick = TABLE.slice(TABLE.indexOf('const pickImport = useCallback('));
    expect(pick.slice(0, pick.indexOf('[itemById]'))).toContain('delete rest.tnvedCode;');
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
    //
    // Re-anchored for round 2 (docs/SAKKIZ-R2.md §7.3): the chooser is PER
    // CODE now — `batchesForCodes` — and the stats route asks it for the
    // row's own code; `suggestImportBaza` asks the same chooser when no batch
    // is passed, which is what the list route relies on.
    expect(STATS_ROUTE).toContain('batchId = (await batchesForCodes([item.code])).get(item.code)?.batchId ?? null;');
    expect(STATS_ROUTE).not.toContain('newestReadyBatchId');
    const call = LIST_ROUTE.slice(LIST_ROUTE.indexOf('suggestImportBaza('));
    const opts = call.slice(0, call.indexOf(');'));
    expect(opts).toContain('picker: true');
    expect(opts).not.toContain('batchId');
    const BAZA = read('src/modules/wms/customs/import-baza.ts');
    expect(bodyOf(BAZA, 'export async function suggestImportBaza(')).toContain('batchesForCodes([input.tnvedCode])');
  });

  it('the per-code chooser orders by «enough rows», quarter, rows, then the ONE order of newest', () => {
    // `batchesForCodes` runs the statement its builder makes, and nothing
    // else — the builder is what batch-choice (h) EXPLAINs.
    expect(bodyOf(SERVICE, 'export async function batchesForCodes(')).toContain('batchChooserStatement(asked)');
    const chooser = bodyOf(SERVICE, 'export function batchChooserStatement(');
    // The heading's range from its ONE home, bound per code into a VALUES
    // list — one statement planned once (review P2-10).
    expect(chooser).toContain('codeBounds(');
    expect(chooser).toContain('VALUES ${values}');
    expect(chooser).not.toContain('UNION ALL');
    expect(chooser).toContain('r.tnved_code BETWEEN a.lo AND a.hi');
    expect(chooser).toContain('>= ${FEW}');
    expect(chooser).toContain("date_trunc('quarter'");
    expect(chooser).toContain('batchRecencySql(');
    // TOTAL: a code no batch holds still maps — onto the newest ready batch.
    expect(chooser).toContain('LEFT JOIN LATERAL');
    expect(chooser).toContain('COALESCE(p.id, n.id)');
    // Two steps (review performance-8): every batch is counted to FEW, and
    // only the newest quarter that has FEW is counted on to the cap.
    expect(chooser).toContain('LIMIT ${FEW}');
    expect(chooser).toContain('LIMIT ${CHOOSER_COUNT_CAP}');
    expect(chooser).toContain('= s.best');
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
  it('every shape computes the similarity ONCE per row, behind an OFFSET 0 fence (review perf-1)', () => {
    // Postgres shares no common subexpression: written into the select list
    // AND both arms of the score, `word_similarity` ran up to three times per
    // row — measured ~1.6× on a 30k-row heading. The fence keeps the planner
    // from pulling the inner select up and splicing it back in.
    const dona = { ...input, units: ['dona' as const], weightPerUnitKg: 0.5 };
    const shapes = [
      candidateStatement(id, input, 'abcd', 10),
      candidateStatement(id, dona, 'abcd', 10),
      candidateStatement(id, { ...dona, tnvedCode: '6702' }, 'abcd', 50),
      candidateStatement(id, dona, 'abcd', 10, { minSim: 0.45 }),
    ];
    for (const shape of shapes) {
      const text = dialect.sqlToQuery(shape).sql;
      expect(text.match(/word_similarity\(/g), text).toHaveLength(1);
      expect(text).toMatch(/OFFSET 0\)\s+r\b/);
    }
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

describe('13. a heading is a range, a full code is exact (round 2, §7.4)', () => {
  const input = { name: 'x', units: ['kg' as const], weightPerUnitKg: null };
  const id = '00000000-0000-0000-0000-000000000000';
  it('codeMatchSql: = for ten digits, BETWEEN … AND …9999 for a heading, both bounds TEXT', () => {
    const full = dialect.sqlToQuery(codeMatchSql(sql`r`, '6403991000'));
    expect(full.sql).toBe('r.tnved_code = $1');
    expect(full.params).toEqual(['6403991000']);
    const heading = dialect.sqlToQuery(codeMatchSql(sql`r`, '6403'));
    expect(heading.sql).toBe('r.tnved_code BETWEEN $1 AND $2');
    expect(heading.params).toEqual(['6403', '6403999999']);
    // No LIKE and no COLLATE: either forfeits the btree on the default
    // collation, and two collations would be two oracles (#653).
    expect(`${full.sql} ${heading.sql}`).not.toMatch(/LIKE|COLLATE/i);
    // The chooser's bounds come from the same home: a full code is both of
    // its own, a heading runs to …9999.
    expect(codeBounds('6403991000')).toEqual({ lo: '6403991000', hi: '6403991000' });
    expect(codeBounds('6403')).toEqual({ lo: '6403', hi: '6403999999' });
  });

  it('the candidate list takes the range; the named series never runs on a heading', () => {
    // ASKED for the named series (review P2-6): without the `minSim` the
    // statement could never carry it, whatever the code, and the assertion
    // below could not go red.
    const shortList = dialect.sqlToQuery(
      candidateStatement(id, { ...input, tnvedCode: '6403' }, 'abcd', 50, { minSim: 0.45 }),
    ).sql;
    expect(shortList).toContain('BETWEEN');
    expect(shortList).not.toContain('percentile_disc');
    const fullList = dialect.sqlToQuery(candidateStatement(id, { ...input, tnvedCode: '6403991000' }, 'abcd', 50)).sql;
    expect(fullList).not.toContain('BETWEEN');
    expect(fullList).toContain('r.tnved_code = $');
    // The dialog asks for the named series only on a full code.
    const BAZA = read('src/modules/wms/customs/import-baza.ts');
    expect(bodyOf(BAZA, 'export async function suggestImportBaza(')).toContain('const named = dialog && usable && !heading;');
  });

  it('the exact readers stay exact: the statistics scope and the picked-row check name the code with =', () => {
    expect(bodyOf(STATS_SQL, 'export function codeScopeCtes(')).toContain('r.tnved_code = ${code}');
    expect(bodyOf(STATS_SQL, 'export function codeScopeCtes(')).not.toContain('codeMatchSql');
    const BAZA = read('src/modules/wms/customs/import-baza.ts');
    expect(bodyOf(BAZA, 'export async function importRowForCode(')).toContain('AND r.tnved_code = ${tnvedCode}');
  });
});
