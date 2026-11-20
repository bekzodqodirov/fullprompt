import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAFETY_CASES, chatOf, isControl, type SafetyCase } from './fixtures/agent-customer-safety';
import { WALLS } from './fixtures/agent-customer-safety/walls';
import { wallsOf } from './fixtures/agent-reader-corpus-eval';

/**
 * The 303 dangerous first replies (DECISIONS #1619), judged against today's rules and compared with the snapshot stage
 * 1a's kernel took BEFORE any rule moved (K1, `fixtures/agent-customer-safety/walls.ts`) — critic-guard.md §C.2 step 1,
 * and the oracle of STAGE-0-1A.md §6.3.
 *
 * Stage 1a takes four things off ordinary talk: the model's own rating (`low_confidence`), the ticked label
 * (`category`), the two-in-a-row rule (`streak`) and a `questions` warning; it relaxes the language and the night for a
 * reply with no money in it. A case the snapshot holds by ANY other wall must still be held by one — that is «none
 * newly goes». A case NO wall held is «open»: the owner's question 82 is about exactly those, the list is committed so
 * it can only shrink, and a rule change that holds one more makes this file red until the snapshot is re-taken (the
 * ratchet shape of the reader corpus). The corpus's own controls stand where the snapshot put them, both ways.
 *
 * The harness sets confidence 0.9, a ticked label, no streak and noon, so the four relaxed walls can never show here —
 * which is why the open cases ARE what 1a changes: in production they waited behind the rating and the 2-minute hold,
 * and under 1a a reply with no money line goes at once.
 *
 * Re-take the snapshot only on purpose (a rule that now holds more): `WRITE_SAFETY_WALLS=1 pnpm vitest run
 * tests/unit/agent-customer-safety.test.ts`, then read the diff — a case leaving «open» is the only change it may show.
 */

/** The walls 1a removes from, or relaxes on, ordinary talk. Anything else is a wall that stays. */
const RELAXED = new Set(['low_confidence', 'category', 'streak', 'warnings', 'warnings:questions', 'language', 'night', 'notes']);

const kept = (walls: readonly string[]): string[] => walls.filter((w) => !RELAXED.has(w));

function wallsNow(c: SafetyCase): string[] {
  const chat = chatOf(c);
  return [...new Set(wallsOf(chat.reply, c.reply, chat.lines, chat.outcomes))].sort();
}

if (process.env.WRITE_SAFETY_WALLS === '1') {
  const rows = SAFETY_CASES.map((c) => `  ${JSON.stringify(c.key)}: ${JSON.stringify(wallsNow(c))},`).join('\n');
  writeFileSync(
    join(__dirname, 'fixtures', 'agent-customer-safety', 'walls.ts'),
    [
      '/**',
      ' * What held each of the 303 dangerous first replies on the rules of the commit that wrote this file — the gate\'s',
      ' * reasons, the policy\'s blocks and its warnings by code. An EMPTY list is an «open» case: no wall held it.',
      ' * Written by agent-customer-safety.test.ts with WRITE_SAFETY_WALLS=1; never edited by hand.',
      ' */',
      'export const WALLS: Readonly<Record<string, readonly string[]>> = {',
      rows,
      '};',
      '',
    ].join('\n'),
  );
}

describe('the customer-safety corpus itself', () => {
  it('holds the 303 cases, each named once, each in a chat the harness can build', () => {
    expect(SAFETY_CASES).toHaveLength(303);
    const keys = SAFETY_CASES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of SAFETY_CASES) expect(() => chatOf(c), c.key).not.toThrow();
  });

  it('the snapshot speaks of exactly these cases', () => {
    expect(Object.keys(WALLS).sort()).toEqual(SAFETY_CASES.map((c) => c.key).sort());
  });

  it('no dangerous case of the snapshot rests on a wall 1a relaxes alone — if one did, it is the owner\'s to hear first', () => {
    const relaxedOnly = SAFETY_CASES.filter((c) => !isControl(c))
      .filter((c) => WALLS[c.key]!.length > 0 && kept(WALLS[c.key]!).length === 0)
      .map((c) => `${c.key} ${WALLS[c.key]!.join(',')}`);
    expect(relaxedOnly).toEqual([]);
  });
});

describe.each(SAFETY_CASES.filter((c) => !isControl(c)).map((c) => [c.key, c] as const))('dangerous %s', (_key, c) => {
  it('is held now by a wall 1a keeps whenever the snapshot held it — and the open list only shrinks', () => {
    const before = kept(WALLS[c.key]!);
    const now = kept(wallsNow(c));
    if (before.length > 0) {
      expect(now, `${c.key} «${c.reply}» newly goes — it was held by ${before.join(', ')}`).not.toEqual([]);
    } else {
      expect(now, `${c.key} is held now (${now.join(', ')}) — the open list shrank: re-take the snapshot`).toEqual([]);
    }
  });
});

describe.each(SAFETY_CASES.filter(isControl).map((c) => [c.key, c] as const))('control %s', (_key, c) => {
  it('stands where the snapshot put it, in both directions', () => {
    const before = WALLS[c.key]!.length > 0 ? 'held' : 'goes';
    const now = wallsNow(c).length > 0 ? 'held' : 'goes';
    expect(now, `${c.key} «${c.reply}»`).toBe(before);
  });
});
