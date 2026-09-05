import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every attachable entity type has a branch in the read gate.
 *
 * The two lists have always had to agree and nothing has ever said so. Miss
 * the second edit and the type falls to `default: { allow: false, rule:
 * 'unmapped' }` — the ONE deny the wrapper deliberately does not stamp
 * `enforce` (#369), written for the free-form strings that predate the
 * allowlist — so `/api/attachments/[id]` logs «WOULD DENY» and SERVES THE
 * BYTES to anyone with a login. The failure is a log line and nothing else:
 * every screen renders, every test passes, and a personal note's photograph is
 * readable by a colleague who guesses a uuid.
 *
 * With this fence `unmapped` can only ever describe what it was written for.
 *
 * Comments are stripped first (#725), and the scan is asserted to have found
 * something BEFORE anything is asserted about it (#494).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the attachment allowlist and the read gate', () => {
  const route = read('src/app/api/files/upload/route.ts');
  const access = read('src/modules/wms/attachments/access.ts');

  const allowlist = (() => {
    const block = /const ATTACHABLE = \[([\s\S]*?)\] as const;/.exec(route);
    if (!block) return [];
    return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  })();

  const cases = [...access.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!);

  it('found both lists', () => {
    expect(allowlist.length, 'ATTACHABLE not found — re-anchor').toBeGreaterThanOrEqual(10);
    expect(cases.length, 'the decide() switch not found — re-anchor').toBeGreaterThanOrEqual(10);
  });

  it('every uploadable type is decided rather than left to unmapped', () => {
    const missing = allowlist.filter((type) => !cases.includes(type));
    expect(missing, `no read branch: ${missing.join(', ')}`).toEqual([]);
  });

  it('the notes type is on both lists', () => {
    expect(allowlist).toContain('staff_note');
    expect(cases).toContain('staff_note');
  });
});
