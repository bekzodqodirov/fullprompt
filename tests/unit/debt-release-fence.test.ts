import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The fences of 0126 (the owner's D2-D7, 2026-10-07), DERIVED from the tree
 * so a new file that learns the counter's power, or prints the reason where a
 * stranger reads it, turns this red on its first run. Comments are stripped
 * first, or a fence matches the sentence explaining itself (#725).
 *
 * A PDF-bytes search for the reason on the act would be vacuous — the act
 * draws CJK glyph ids, not text (handover-act.ts) — so the act is fenced here,
 * by source (#494's shape).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
const SRC = walk('src');
const referencing = (pattern: RegExp) => SRC.filter((file) => pattern.test(read(file))).sort();

describe('D3a — the counter’s power stays at the counter', () => {
  it('exactly the predicate’s home, the service and the route that draws the tick ask `counterDebtRelease`', () => {
    // No approval, muddat, promise or register door may learn it: they keep
    // `mayGrantDebt`, which answers «none» for the warehouse manager.
    expect(referencing(/\bcounterDebtRelease\b/)).toEqual([
      'src/app/api/issue/list/route.ts',
      'src/modules/wms/finance/scope.ts',
      'src/modules/wms/issue/service.ts',
    ]);
  });
});

describe('the reason never reaches the act, the customer or the seller’s message', () => {
  it('names `debtNote` / `debt_note` in exactly these files', () => {
    expect(referencing(/debtNote|debt_note/)).toEqual([
      'src/app/(protected)/issue/issue-screen.tsx',
      'src/components/client-feed.tsx',
      'src/modules/platform/db/schema/wms.ts',
      'src/modules/wms/crm/feed.ts',
      'src/modules/wms/debt/releases.ts',
      'src/modules/wms/issue/service.ts',
    ]);
  });

  it('in particular: not the act, not the cabinet, not the customer notices, not the event renderer', () => {
    const forbidden = SRC.filter(
      (file) =>
        file === 'src/modules/wms/documents/handover-act.ts' ||
        file.startsWith('src/modules/wms/client-cabinet/') ||
        file.startsWith('src/modules/wms/notices/') ||
        file === 'src/modules/platform/notifications/service.ts',
    );
    expect(forbidden.length).toBeGreaterThan(3);
    for (const file of forbidden) expect(read(file), file).not.toMatch(/debtNote|debt_note/);
  });

  it('the seller’s and the customer’s «berildi» carry nothing new: the BoxIssued payload names no reason', () => {
    const service = read('src/modules/wms/issue/service.ts');
    const start = service.indexOf("type: 'BoxIssued',");
    expect(start).toBeGreaterThan(0);
    const payload = service.slice(start, service.indexOf('entityType:', start));
    expect(payload).toContain('personName: input.personName');
    expect(payload).not.toMatch(/debtNote|debt_note|reason/);
  });
});

describe('the render readers cannot crash on a database a release behind (#472)', () => {
  it('the register and the lenta never name the bare column — only `to_jsonb(alias)->>`', () => {
    for (const file of ['src/modules/wms/debt/releases.ts', 'src/modules/wms/crm/feed.ts']) {
      expect(read(file), file).not.toMatch(/\b[a-z_]+\.debt_note\b/);
    }
    expect(read('src/modules/wms/debt/releases.ts')).toContain("to_jsonb(${h})->>'debt_note'");
  });

  it('ONE reason rule (#513): the lenta calls it and writes no version of its own', () => {
    const feed = read('src/modules/wms/crm/feed.ts');
    expect(feed).toContain("'debtNote', ${opts.money ? debtReleaseReasonSql('h') : sql`NULL`}");
    expect(feed).not.toContain('request_note');
    const releases = read('src/modules/wms/debt/releases.ts');
    expect(releases).toContain("CASE WHEN l.kind IN ('tick', 'approval') THEN ${debtReleaseReasonSql('hn')} END AS reason");
    // The reason is keyed on the gate's own rule, exactly like the row's kind.
    const rule = releases.slice(releases.indexOf('export function debtReleaseReasonSql'));
    expect(rule).toMatch(/CASE WHEN NOT \$\{debtGateOpenedSql\(alias\)\} THEN NULL\s+WHEN \$\{h\}\.debt_ok THEN/);
  });
});
