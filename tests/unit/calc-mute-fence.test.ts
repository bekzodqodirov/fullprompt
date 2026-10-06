import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTE_GROUPS } from '@/modules/platform/notifications/mutes';

/**
 * Every push the calc module sends can be muted (review tests-completeness-11).
 *
 * The mutes tripwire reads `buildRecipients`; a type sent straight through
 * `notifyStaffTelegram` is invisible to it, so a new one (this round's
 * `CalcRecalc`) would ship unmuteable with every test green. DERIVED from the
 * module's own source: each `type: '…'` handed to `notifyStaffTelegram` in
 * src/modules/wms/calc must sit in a mute group.
 */
const DIR = 'src/modules/wms/calc';
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sentTypes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
    const src = strip(readFileSync(join(DIR, name), 'utf8'));
    for (let at = src.indexOf('notifyStaffTelegram('); at >= 0; at = src.indexOf('notifyStaffTelegram(', at + 1)) {
      const call = src.slice(at, at + 600);
      const m = /type:\s*'(\w+)'/.exec(call);
      if (m) out.set(m[1]!, name);
    }
  }
  return out;
}

describe('the calc module’s pushes are all mutable', () => {
  const types = sentTypes();
  const grouped = new Set(Object.values(MUTE_GROUPS).flat() as string[]);

  it('finds the pushes (a fence that finds nothing proves nothing)', () => {
    expect([...types.keys()]).toEqual(expect.arrayContaining(['CalcDone', 'CalcReturned', 'CalcRecalc']));
  });

  it('every one sits in a mute group', () => {
    const loose = [...types.entries()].filter(([type]) => !grouped.has(type)).map(([t, f]) => `${t} (${f})`);
    expect(loose).toEqual([]);
  });
});
