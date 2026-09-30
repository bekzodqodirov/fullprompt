import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FORMER_CODE_KEY, FORMER_CODE_PREDICATE } from '@/modules/wms/batches/former-codes';

/**
 * The rename's wiring, source-shape, comments stripped (#725) — the halves a
 * behavioural test cannot reach: the action's door (it calls `authorize`,
 * which no integration test can press, #531), the form's refresh, the card's
 * predicate, the service's ORDER of checks, and the derived fences that make
 * the audit trail safe to read as data.
 */
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

/** The text from `open` (an index of `{`) to its matching `}`. */
function block(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced');
}

/** The object literal enclosing `at`. */
function enclosingObject(src: string, at: number): { start: number; text: string } {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    if (src[i] === '}') depth += 1;
    else if (src[i] === '{') {
      if (depth === 0) return { start: i, text: block(src, i) };
      depth -= 1;
    }
  }
  throw new Error('no enclosing object');
}

/** A function's body: the first `{` that ends a line after `)` or a return type's `>`. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const opener = /[)>]\s*\{\s*\n/g;
  opener.lastIndex = at;
  const m = opener.exec(src)!;
  return block(src, src.indexOf('{', m.index));
}

const SRC_FILES = globSync('src/**/*.{ts,tsx}');

describe('the action and the screen ask the service’s door', () => {
  const ACTIONS = read('src/app/(protected)/plans/actions.ts');
  const FORM = read('src/app/(protected)/batches/[id]/batch-code-form.tsx');
  const CARD = read('src/app/(protected)/batches/[id]/batch-card.tsx');

  it('renameBatchAction asks authorizeOnBatch(plans.manage) before renameBatch, and posts what was seen', () => {
    const fn = body(ACTIONS, 'export async function renameBatchAction(');
    const door = fn.indexOf("authorizeOnBatch('plans.manage'");
    expect(door).toBeGreaterThan(-1);
    expect(fn.indexOf('renameBatch(')).toBeGreaterThan(door);
    // The service takes only a MINTED door, minted from the actor the door authorised.
    expect(fn).toContain('renameDoorFor(door.actor)');
    expect(fn).toMatch(/seen:\s*\{\s*code:\s*seenCode,\s*stage:\s*seenStage\s*\}/);
    expect(fn).toContain("formData.get('seenCode')");
    expect(fn).toContain("formData.get('seenStage')");
  });

  it('the form posts what it showed, has no Suspense, and refreshes only on a changed truck', () => {
    expect(FORM).toContain('name="seenCode"');
    expect(FORM).toContain('name="seenStage"');
    expect(FORM).not.toContain('<Suspense');
    const refreshes = [...FORM.matchAll(/router\.refresh\(/g)];
    expect(refreshes).toHaveLength(1);
    const line = FORM.slice(FORM.lastIndexOf('\n', refreshes[0]!.index!), refreshes[0]!.index!);
    expect(line).toContain("state.error === 'batch_changed'");
    expect(line).toContain("state.error === 'rename_closed'");
  });

  it('the card draws the pencil off mayRenameBatch, never an inline permission', () => {
    expect(CARD).toContain('mayRenameBatch(actor, batch, renameStage)');
    const form = CARD.indexOf('<BatchCodeForm');
    const around = CARD.slice(form - 400, CARD.indexOf('/>', form));
    expect(around).not.toContain("'plans.manage'");
    expect(around).toContain('mode={renameMode}');
  });
});

describe('the service checks in the one order that is safe', () => {
  it('door identity < name lock < loading lock < row lock < door < aboard < seen < road charset < shape < ever worn < write', () => {
    const fn = body(read('src/modules/wms/batches/rename.ts'), 'export async function renameBatch(');
    // The three locks first and in this order: the NAME before any truck lock
    // (a name's holder may wait on something waiting on a truck row), the
    // truck's LOADING lock before its row (departBatch's own order).
    const order = [
      'door.id !== ctx.actorId',
      'lockBatchCode(',
      'lockTruckLoading(',
      ".for('update')",
      'renameDoorOpens(',
      'awaitingUnloadCount(',
      'seen.stage',
      'roadCodeProblem(',
      'codeShapeProblem(',
      'codeEverWorn(',
      '.update(batches)',
    ];
    let last = -1;
    for (const marker of order) {
      const at = fn.indexOf(marker);
      expect(at, marker).toBeGreaterThan(last);
      last = at;
    }
  });

  it('nextBatchCode takes the name lock before asking whether the name was ever worn', () => {
    const fn = body(read('src/modules/wms/codes.ts'), 'export async function nextBatchCode(');
    const lock = fn.indexOf('lockBatchCode(');
    expect(lock).toBeGreaterThan(-1);
    expect(fn.indexOf('codeEverWorn(')).toBeGreaterThan(lock);
  });
});

describe('DERIVED: the audit trail is safe to read as a list of former names', () => {
  it('every batch audit entry passes `before` as an object literal, and only rename.ts puts a code in one', () => {
    let seen = 0;
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const src = strip(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/entityType:\s*'batch'/g)) {
        const obj = enclosingObject(src, m.index!);
        const b = /\bbefore\s*:/.exec(obj.text);
        if (!b) continue;
        seen += 1;
        const rest = obj.text.slice(b.index + b[0].length).trimStart();
        if (rest.startsWith('null')) continue;
        if (!rest.startsWith('{')) {
          offenders.push(`${file}: before is not an object literal`);
          continue;
        }
        const before = block(rest, 0);
        if (/\.\.\./.test(before)) offenders.push(`${file}: before spreads`);
        if (/[{,]\s*code\s*[:,}]/.test(before) && file !== 'src/modules/wms/batches/rename.ts') {
          offenders.push(`${file}: before carries a code`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Anchored: the finder must actually find the writers it guards.
    expect(seen).toBeGreaterThan(5);
  });

  it("every `before->>'code'` lives in former-codes.ts", () => {
    const homes = SRC_FILES.filter((file) => strip(readFileSync(file, 'utf8')).includes("before->>'code'"));
    expect(homes).toEqual(['src/modules/wms/batches/former-codes.ts']);
  });

  it('every ILIKE over a truck’s code lives in former-codes.ts, and both searches call the one match', () => {
    const homes = SRC_FILES.filter((file) =>
      /(\$\{batches\.code\}|"batches"\."code")\s+ILIKE/i.test(strip(readFileSync(file, 'utf8'))),
    );
    expect(homes).toEqual(['src/modules/wms/batches/former-codes.ts']);
    expect(read('src/modules/wms/search/service.ts')).toContain('batchTextMatchSql(');
    expect(read('src/app/(protected)/batches/page.tsx')).toContain('batchTextMatchSql(');
  });

  it("0121's partial index repeats the readers' predicate and key character for character", () => {
    const sql = readFileSync('src/modules/platform/db/migrations/0121_batch_rename.sql', 'utf8');
    expect(sql).toContain(`WHERE ${FORMER_CODE_PREDICATE('')};`);
    expect(sql).toContain(`((${FORMER_CODE_KEY('')}))`);
  });
});
