import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calcWorkspaceHref } from '@/modules/wms/calc/card-door';

/**
 * The link from a price to the calculation that made it (his 2026-10-27:
 * «ved narx berdi shu narxni hisoblaydigan oynasiga link bolsin, chunki qayta
 * hisoblash kerak bo'lganda qidirib qolinyabti»).
 *
 * `/hisoblash/<request>` IS the cost breakdown (law 10, his 2A of
 * 2026-09-04), so ONE rule says who is handed the door — `ved.docs` — and
 * every card→calc link asks it (#513). A second home is a link drawn for a
 * seller that bounces him home (#1281) or, worse, one that does not.
 */

const SRC = join(process.cwd(), 'src');

/**
 * The places allowed to spell the workspace URL themselves:
 *  - the rule's own home;
 *  - the workspace's own page tree, which `ved.docs` alone reaches;
 *  - three PLATFORM copies, which cannot import wms (the task view, the bot,
 *    the notification links) and gate on the reader where they stand.
 */
const ALLOWED = [
  'modules/wms/calc/card-door.ts',
  'modules/platform/tasks/view.ts',
  'modules/platform/telegram/staff-bot.ts',
  'modules/platform/notifications/links.ts',
];
const ALLOWED_TREE = 'app/(protected)/hisoblash/';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Comments out — a sentence about the URL is not a link (#725). A `//` inside a string survives. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}])\/\/.*$/gm, '$1');

describe('calcWorkspaceHref — the one door from a card to its calculation', () => {
  const ved = { permissions: new Set(['ved.docs']) };
  const seller = { permissions: new Set(['crm.leads', 'deals.manage']) };
  const id = '0190a0b0-0000-7000-8000-000000000001';

  it('opens for ved.docs, with an optional anchor, and for nobody else', () => {
    expect(calcWorkspaceHref(ved, id)).toBe(`/hisoblash/${id}`);
    expect(calcWorkspaceHref(ved, id, '#savol')).toBe(`/hisoblash/${id}#savol`);
    expect(calcWorkspaceHref(seller, id)).toBeNull();
    // A card with no job behind its number draws no link at all.
    expect(calcWorkspaceHref(ved, null)).toBeNull();
    expect(calcWorkspaceHref(ved, undefined)).toBeNull();
  });

  it('no file outside its home spells `/hisoblash/${…}` itself', () => {
    const offenders = walk(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((rel) => !ALLOWED.includes(rel) && !rel.startsWith(ALLOWED_TREE))
      .filter((rel) => code(readFileSync(join(SRC, rel), 'utf8')).includes('/hisoblash/${'));
    expect(offenders).toEqual([]);
  });

  it('the fence can see: the allowed files really do spell it (or the walk reads nothing)', () => {
    for (const rel of ALLOWED) {
      expect(code(readFileSync(join(SRC, rel), 'utf8')), rel).toContain('/hisoblash/${');
    }
  });

  it('every card surface asks it — the panel, both Narx rows, the truck sheet, the prixod and the threads', () => {
    const asks = [
      'components/calc-panel.tsx',
      'app/(protected)/bitimlar/[id]/page.tsx',
      'app/(protected)/crm/leads/[id]/page.tsx',
      'app/(protected)/batches/[id]/pricing/page.tsx',
      'app/(protected)/receipts/[id]/page.tsx',
      'modules/wms/crm/thread.ts',
      'modules/wms/crm/internal-chat.ts',
    ];
    for (const rel of asks) expect(code(readFileSync(join(SRC, rel), 'utf8')), rel).toContain('calcWorkspaceHref(');
  });
});
