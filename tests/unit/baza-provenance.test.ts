import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A baza and where it came from move TOGETHER (0094).
 *
 * `baza_usd`, `baza_basis`, `baza_source` and `import_row_id` are one fact
 * in four columns: the price, what it is per, who supplied it and which
 * declaration it was taken from. A writer that moves the first three and
 * leaves the fourth puts the «📥 taxmin» chip — and the ✅'s own
 * `baza_from_import` record — on a number the import did not supply, which
 * is a lie with a provenance mark on it.
 *
 * Nothing about BEHAVIOUR can see that: every screen renders, every figure
 * prices, and the chip is simply wrong. So the fence is SOURCE SHAPE and it
 * is DERIVED — it finds the UPDATE blocks itself rather than naming today's
 * three, so a fourth writer turns it red the day it is added (#789's idiom).
 *
 * Comments are stripped first (#725): a rule that trips on the sentence
 * explaining it is a rule that gets deleted.
 */
const source = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Every balanced `.set({ … })` argument in the file. */
function setBlocks(text: string): string[] {
  const out: string[] = [];
  const marker = '.set({';
  let at = text.indexOf(marker);
  while (at !== -1) {
    let depth = 1;
    let i = at + marker.length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') depth -= 1;
    }
    out.push(text.slice(at + marker.length, i));
    at = text.indexOf(marker, i);
  }
  return out;
}

describe('the baza carries its provenance', () => {
  it('every UPDATE that writes a baza source also writes the import row', () => {
    const writing = setBlocks(source).filter((b) => b.includes('bazaSource'));
    // Today: setItemBaza, pullBazasFromDictionary and the import fill in
    // saveTable. If this number moves, the new writer belongs below.
    expect(writing.length).toBeGreaterThanOrEqual(3);
    for (const block of writing) {
      expect(block, `a .set() writing bazaSource must write importRowId:\n${block}`).toContain(
        'importRowId',
      );
    }
  });

  it('the edit loop clears it on both branches — the clear and the retype', () => {
    // The row edit builds a `patch` object rather than a `.set()` literal,
    // so it is checked by its own shape: three assignments to bazaSource
    // (null on a clear, 'import' or 'typed' on a write) and a paired
    // importRowId beside each.
    const sources = source.match(/patch\.bazaSource = /g) ?? [];
    const rows = source.match(/patch\.importRowId = /g) ?? [];
    expect(sources.length).toBeGreaterThan(0);
    expect(rows.length).toBe(sources.length);
  });

  it('a correction inherits the provenance with the price', () => {
    // `recalcFromSealed` copies the items onto the new request. Losing the
    // column there would drop the chip and the confirm's record the moment
    // anybody re-priced a job.
    const at = source.indexOf('export async function recalcFromSealed');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf('\nexport ', at + 40));
    expect(body).toContain('bazaSource: item.bazaSource');
    expect(body).toContain('importRowId: item.importRowId');
  });
});
