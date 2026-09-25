import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every door that writes a box to `void` re-splits the costs that were
 * shared over it, AFTER its own transaction (audit U20; editLot's #998
 * precedent). A void box carries no share anywhere (#530/#849), and the two
 * doors that forgot this — voidReceipt and the box card — left the shares on
 * the phantom boxes for good, because since R1 a converted cost has no «next
 * recompute» to fix them.
 *
 * The writers are DERIVED from the code (a literal `toStatus: 'void'`
 * movement, a call to the one terminal writer `voidBoxRows`), so a new door
 * that voids boxes turns this red until it is listed here with its re-split.
 * The box card writes its status from a variable, so it is named, and its
 * schema is checked to still offer `void`. Source-shape, comments stripped
 * first (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

/** file → the exported door that voids, and the call that re-splits after it. */
const DOORS: Record<string, { fn: string; resplit: string }> = {
  'src/modules/wms/receipts/service.ts': { fn: 'voidReceipt', resplit: 'recomputeForLot(' },
  'src/modules/wms/receipts/edit.ts': { fn: 'editLot', resplit: 'recomputeForLot(' },
  'src/modules/wms/boxes/status.ts': { fn: 'setBoxStatus', resplit: 'recomputeForLot(' },
  // The annul has its own aftermath (#847-852), re-runnable by design.
  'src/modules/wms/receipts/annul.ts': { fn: 'annulReceipt', resplit: 'annulAftermath(' },
};
/** The one terminal writer itself — its callers are the doors. */
const HELPER = 'src/modules/wms/receipts/void-box.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/** The text of `export async function name` up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) return '';
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Where the first `db.transaction(` call starts and just past where it ends. */
function transactionSpan(body: string): [number, number] {
  const at = body.indexOf('db.transaction(');
  if (at === -1) return [-1, -1];
  let depth = 0;
  for (let i = body.indexOf('(', at); i < body.length; i += 1) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') {
      depth -= 1;
      if (depth === 0) return [at, i + 1];
    }
  }
  return [at, -1];
}

describe('every door that voids a box re-splits the money after it', () => {
  it('finds the void writers in the code, and each one is a listed door', () => {
    const writers = walk('src/modules/wms').filter((path) => {
      if (path === HELPER) return false;
      const src = read(path);
      return /toStatus:\s*'void'/.test(src) || /\bvoidBoxRows\(tx\b/.test(src);
    });
    // Anchors: the scan must find what it exists for (#166).
    expect(writers).toContain('src/modules/wms/receipts/service.ts');
    expect(writers).toContain('src/modules/wms/receipts/edit.ts');
    const strangers = writers.filter((path) => !(path in DOORS));
    expect(strangers, `a door that voids boxes and is not listed: ${strangers.join(', ')}`).toEqual(
      [],
    );
    // The box card writes its status from a variable — named, and still able to void.
    expect(read('src/modules/wms/boxes/status.ts')).toMatch(/to:\s*z\.enum\(\[[^\]]*'void'/);
  });

  for (const [path, door] of Object.entries(DOORS)) {
    it(`${door.fn} re-splits AFTER its transaction commits`, () => {
      const body = fnBody(read(path), door.fn);
      expect(body, `${door.fn} not found in ${path}`).not.toBe('');
      const [start, end] = transactionSpan(body);
      expect(end, `${door.fn} has no transaction`).toBeGreaterThan(0);
      const inside = body.slice(start, end);
      const after = body.slice(end);
      // Inside the transaction the engine would read settings and rates on the
      // pool (#714) and money could roll the warehouse's correction back.
      expect(inside, `${door.fn} re-splits inside its transaction`).not.toContain(door.resplit);
      expect(after, `${door.fn} never re-splits after its commit`).toContain(door.resplit);
    });
  }
});
