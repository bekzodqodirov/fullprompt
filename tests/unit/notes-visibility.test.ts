import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Who may read a zametka is decided in ONE place.
 *
 * `visibleNotes(actorId)` is «the company's, plus this person's own» and
 * everything that lists or loads a note must go through it — the bot's list,
 * the bot's send, the screen, and the free title lookup. A fourth reader added
 * next month that writes its own WHERE is how a personal note becomes visible
 * to a colleague, and nothing about the behaviour of the other three would
 * change, so no behavioural test can see it.
 *
 * DERIVED (#789's idiom): the readers are found by grepping the tree rather
 * than listed here, so a new one turns this red on the day it is written.
 * Comments are stripped (#725) and the scan is proven non-empty first (#494).
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Files that SELECT from the notes table at all. */
function readersOf(table: string): string[] {
  const out = execSync(`grep -rl "from(${table})" src/ || true`, { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

describe('the notes visibility rule', () => {
  const readers = readersOf('staffNotes');

  it('found the readers', () => {
    expect(readers.length, 'nothing selects from staffNotes — re-anchor').toBeGreaterThanOrEqual(1);
  });

  it('every select over the notes table goes through visibleNotes', () => {
    // The service is the one home, so it is the only file allowed to hold the
    // predicate — anything else selecting from the table must import it.
    const HOME = 'src/modules/platform/notes/service.ts';
    for (const file of readers) {
      const body = strip(readFileSync(file, 'utf8'));
      const selects = [...body.matchAll(/\.from\(staffNotes\)/g)].length;
      // The DEFINITION does not count as a use, or a fourth unguarded select
      // would be paid for by the `export function` line and this fence would
      // pass on exactly the change it exists to catch.
      const uses =
        [...body.matchAll(/visibleNotes\(/g)].length -
        [...body.matchAll(/function visibleNotes\(/g)].length;
      expect(uses, `${file}: selects notes without visibleNotes`).toBeGreaterThanOrEqual(selects);
      if (file === HOME) expect(body).toContain('export function visibleNotes(');
    }
  });

  it('the two gates that load a note by ID say why they may', () => {
    // Two callers deliberately do NOT use the visibility predicate: the upload
    // route and the attachment read gate, both of which look a note up by id
    // in order to APPLY its ownership rather than to show it. They use
    // `findFirst`, never a select, and each carries its own rule — asserted
    // here so «it looked fine» is not the reason they are exempt.
    const route = strip(readFileSync('src/app/api/files/upload/route.ts', 'utf8'));
    expect(route).toContain('note.userId === null ? canShareNotes(actor.permissions)');
    const access = strip(readFileSync('src/modules/wms/attachments/access.ts', 'utf8'));
    expect(access).toContain("case 'staff_note': {");
    expect(access).toContain("return { allow: true, rule: 'staff-note-company' };");
    expect(access).toContain('note.userId === actor.id');
  });
});
