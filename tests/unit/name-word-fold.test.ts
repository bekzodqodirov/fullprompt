import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The taught name example's read-back shares the rows' fold (the CHK-1
 * verify's PERF-1), as SOURCE SHAPE — a fold count is internal to
 * line-address.ts and no timing threshold belongs in a test (#9).
 *
 * `nameWordFor` reads its example back through the real parser (CHK-1), and
 * the parser's own `rowName` per row per candidate made one render 0.4-1.2 s
 * on 1000 long customs descriptions — on the one process the web app, the bot
 * poller and pg-boss share. So the parser takes the caller's fold
 * (`readTable(…, nameOf)`), `nameWordFor` hands it the names it folded, and
 * those are folded once per table (`FOLDED_ROWS`, keyed by the rows array).
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
const SOURCE = strip(readFileSync('src/modules/wms/calc/line-address.ts', 'utf8'));

function body(name: string): string {
  const decl = new RegExp(`function ${name}\\(`).exec(SOURCE);
  expect(decl, name).not.toBeNull();
  const from = decl!.index;
  const next = SOURCE.slice(from + 1).search(/\n(?:export )?function \w+\(/u);
  return next < 0 ? SOURCE.slice(from) : SOURCE.slice(from, from + 1 + next);
}

describe('the name example’s read-back folds the rows once (PERF-1)', () => {
  it('nameWordFor reads back through readTable with its own fold — never parseTableAnswer’s', () => {
    const fn = body('nameWordFor');
    expect(fn).toContain('readTable(example, ref, nameOf)');
    expect(fn).not.toContain('parseTableAnswer(');
    expect(fn).toContain('FOLDED_ROWS.get(rows)');
  });

  it('the reader folds only through the nameOf it was given', () => {
    expect(body('readSegment')).not.toContain('rowName(');
    expect(body('readTable')).not.toContain('rowName(');
    // The only folds: the definition, the default fold, nameWordFor's fallback and its once-per-table fold.
    expect(SOURCE.match(/\browName\(/gu)?.length).toBe(4);
  });
});
