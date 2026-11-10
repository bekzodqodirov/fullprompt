import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Invoys» on the Bojxona tab is a BUTTON whose download is a navigation of
 * the tab it stands in (docs/TARKIB-TUZATISH.md §6.4). Two rules of the
 * dialog cannot be met by a service test — both work or fail only in a
 * browser, and the browser half (m9zzx) needs a build — so their wiring is
 * pinned here, source-shape, comments stripped (#725):
 *
 *  1. the file is followed ONLY right after the list was read. A list that
 *     cannot be read (a deploy recreating the server, a session run out) is
 *     said and nothing is followed: the file's address would fail for the
 *     same reason, and a failed download replaces the screen — and every
 *     code typed or suggested and not saved goes with it;
 *  2. «Invoysni olish» reads the list AGAIN and, when it moved under the
 *     open dialog, shows the new list instead of sending answers about one
 *     that no longer exists.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SRC = strip(readFileSync('src/app/(protected)/batches/[id]/tnved/invoice-download.tsx', 'utf8'));

/** A function's text: from `async function <name>(` to the next line that begins a sibling. */
function body(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/\n {2}(async function |const |return \()/);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

describe('the invoice dialog follows a file only after the list was read', () => {
  it('the reader answers null for ANY failure — a refused answer and a thrown fetch alike', () => {
    const read = body('readGroups');
    expect(read).toContain('if (!res.ok) return null;');
    expect(read).toMatch(/catch \{\s*return null;\s*\}/);
  });

  it('the press: an unread list is said, and nothing is followed', () => {
    const press = body('press');
    expect(press).toMatch(/if \(!body\) \{\s*setListFailed\(true\);\s*return;\s*\}/);
    // The one download of the press comes AFTER the list answered.
    expect(press.match(/followDownload\(/g)).toHaveLength(1);
    expect(press.indexOf('followDownload(')).toBeGreaterThan(press.indexOf('if (!body)'));
    expect(press).not.toMatch(/catch[^}]*followDownload/);
  });

  it('«Invoysni olish» reads the list again; a moved list is shown and asked again', () => {
    const download = body('download');
    const order = [
      'await readGroups()',
      'if (!now) {',
      'if (now.fp !== view.fp) {',
      'setMoved(true);',
      'remember(batchId, chosen);',
      'await followDownload(',
    ];
    let at = -1;
    for (const step of order) {
      const next = download.indexOf(step);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    // Both early exits leave without a file.
    expect(download).toMatch(/if \(!now\) \{\s*setListFailed\(true\);\s*return;\s*\}/);
    expect(download).toMatch(/setMoved\(true\);\s*return;/);
    // The answers that still name a group are kept — the rest are asked again.
    expect(download).toContain('setChosen(new Set([...chosen].filter((key) => known.has(key))));');
    expect(download.match(/followDownload\(/g)).toHaveLength(1);
  });

  it('both sentences are drawn where the person is looking — inside the open dialog', () => {
    expect(SRC).toMatch(/\{moved && \([\s\S]{0,160}data-testid="invoice-moved"/);
    expect(SRC.match(/data-testid="invoice-list-failed"/g)).toHaveLength(2);
    expect(SRC).toContain('{listFailed && !open && (');
  });
});
