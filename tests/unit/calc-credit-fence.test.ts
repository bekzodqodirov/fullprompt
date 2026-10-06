import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE answer predicate and ONE credit rule (docs/VED-TARIX.md §2, §11).
 *
 * «Who priced it» was asked four ways before this round — the history by
 * sealer, the totals by the holder, the closed page by `completed_via` alone,
 * the panel by «an amount is set» — and each answered a different question
 * about the same row. `credit.ts` is the home now (`isAnswerSql` = 0093's own
 * CHECK body: `completed_via = 'task' AND answer_amount > 0 AND <> 'NaN'`),
 * and this fence finds the predicate restated anywhere else.
 *
 * DERIVED — every file under src is read, comments stripped first (#725: a
 * sentence explaining the rule is not a restatement of it). The allowlist is
 * named, each with its reason; a new site is a decision nobody made.
 */
const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** The predicate's pieces, in both spellings the codebase uses. */
const PATTERNS: RegExp[] = [
  /completed_via\s*=\s*'task'/,
  /completedVia\s*[!=]==\s*'task'/,
  /eq\(\s*calcRequests\.completedVia\s*,\s*'task'\s*\)/,
  // A drizzle template restating it: sql`${t.completedVia} = 'task' …`.
  /\$\{\s*\w+\.completedVia\s*\}\s*=\s*'task'/,
  /answer_amount\s*>\s*0/,
  /answer_amount\s+IS\s+NOT\s+NULL/i,
  /isNotNull\(\s*calcRequests\.answerAmount\s*\)/,
];

const ALLOWED: Record<string, string> = {
  'src/modules/wms/calc/credit.ts': 'the home',
  // The answer FLOOR: five fences (completed, > 0, USD, not superseded, no
  // newer answer or seal) — a narrower question than «is it an answer», and
  // the one money reads (phase 4, #883).
  'src/modules/wms/calc/version-set.ts': 'answerFloorStandsSql — the floor, not the credit',
  // lastAnswerAnchorFor's candidate scan: it asks the floor above whether
  // the newest amount stands; the scan itself credits nobody.
  'src/modules/wms/calc/workspace.ts': 'lastAnswerAnchorFor — the anchor scan under answerFloorStandsSql',
  // The schema's partial index over answered rows (the migration's own
  // shape) — an index definition, not a reader.
  'src/modules/platform/db/schema/wms.ts': 'the answered-rows partial index definition',
};

describe('the answer predicate lives in credit.ts', () => {
  const hits = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    const source = strip(readFileSync(file, 'utf8'));
    const found = PATTERNS.filter((re) => re.test(source)).map(String);
    if (found.length > 0) hits.set(rel, found);
  }

  it('finds the home (a fence that finds nothing proves nothing)', () => {
    expect(hits.get('src/modules/wms/calc/credit.ts')?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('no other file restates it', () => {
    const offenders = [...hits.keys()].filter((file) => !(file in ALLOWED));
    expect(offenders, 'restated outside credit.ts — import isAnswerSql / isAnswer').toEqual([]);
  });

  it('every allowlisted file still holds a site (a stale exemption is a hole)', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(hits.has(file), `${file} no longer restates it — drop it from ALLOWED`).toBe(true);
    }
  });
});
