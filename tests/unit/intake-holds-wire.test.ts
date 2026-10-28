import { describe, expect, it } from 'vitest';
import { srcFiles } from '../fixtures/source-shape';

/**
 * «Waits 24 hours, holds 30 minutes» (docs/SAKKIZ-R3.md §6.2.7, regression-1)
 * as SOURCE SHAPE, derived over `src/` with comments stripped (#725).
 *
 * A «Hisoblatish» collection now outlives the half hour it holds the chat for.
 * A door that asks «is there a collection?» (`activeIntake`) where it means
 * «does one hold the chat?» (`holdingIntake`, or the ladder's `intakeTakes`
 * verdict) would let a parked collection swallow lookups, notes, tasks and the
 * assistant for a day — the very defect parking exists for. So every
 * `activeIntake(` call in the tree is named here, by file and function, on one
 * of two lists, each with its reason:
 *  - «presence»: the question really is whether a collection EXISTS (its own
 *    button, the landing, a job's read, the dispatcher's reads);
 *  - «holds»: a door that refuses or routes beside a collection — and each
 *    such call must ask `holdingIntake(` or `intakeTakes(` beside it.
 * An unlisted call fails, and so does a «holds» call that asks `activeIntake`
 * alone. A package adding a call adds it to a list with its reason (a press is
 * «presence»).
 */

const PRESENCE: Record<string, string> = {
  'calc-intake-sweep.ts:pressResume': 'a collection’s own «▶️» un-parks it',
  'calc-read.ts:analyseIntakeAndReply': 'the reading’s settle and release (P2 moves them, §7.2.4.6, §7.2.4.8)',
  'calc-store.ts:holdingIntake': 'the holds predicate itself',
  'calc-store.ts:loadIntake': 'a job’s read, after this process hydrated',
  'calc-store.ts:collectionSurvived': 'the backlog sentence: did a collection survive the restart',
  'staff-bot.ts:landCollectedIntake': 'the landing of the collection whose «Tasdiqlash» was pressed',
  'staff-handlers.ts:handleCalcCallback': 'the dispatcher’s reads: cancel, the restart question, the press’s state',
};

const HOLDS: Record<string, string> = {
  'staff-handlers.ts:registerStaffBot': 'the text, file and voice ladders — each one `intakeTakes` verdict',
  'staff-handlers.ts:answerStaffText': 'the orphan guard: «no HOLDING collection», the parked one handed in',
};

/** The four doors that refuse beside a collection — by the one predicate, never `activeIntake`. */
const DOORS: { site: string; needle: string }[] = [
  { site: 'task-handlers.ts:startTaskDraft', needle: 'if (holdingIntake(chatId)) {' },
  { site: 'staff-handlers.ts:handleNoteCallback', needle: 'if (holdingIntake(chatId)) {' },
  { site: 'staff-handlers.ts:handleThreadReplyPress', needle: 'if (holdingIntake(chatId)) {' },
  {
    site: 'staff-handlers.ts:registerStaffBot',
    needle: 'if (!holdingIntake(chatId) && !activeCapture(chatId) && (await draftMedia(ctx, chatId))) return;',
  },
];

const FILES = srcFiles();

/** The function a call sits in — the nearest declaration above it. */
function functionAt(text: string, at: number): string {
  const all = [...text.slice(0, at).matchAll(/(?:^|\n)\s*(?:export )?(?:async )?function (\w+)/g)];
  return all.length ? all[all.length - 1]![1]! : '(module)';
}

/** From a function's declaration to the next declaration in the file. */
function functionBody(text: string, name: string): string {
  const decl = new RegExp(`(?:export )?(?:async )?function ${name}\\(`).exec(text);
  if (!decl) return '';
  const from = decl.index + decl[0].length;
  const next = text.slice(from).search(/\n\s*(?:export )?(?:async )?function \w+\(/);
  return next < 0 ? text.slice(decl.index) : text.slice(decl.index, from + next);
}

interface Site {
  key: string;
  window: string;
}

const SITES: Site[] = FILES.flatMap(({ path, text }) => {
  const file = path.split('/').at(-1)!;
  const out: Site[] = [];
  for (let at = text.indexOf('activeIntake('); at >= 0; at = text.indexOf('activeIntake(', at + 1)) {
    if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue; // the definition
    out.push({ key: `${file}:${functionAt(text, at)}`, window: text.slice(Math.max(0, at - 200), at + 300) });
  }
  return out;
});

describe('every `activeIntake(` asks the question it means (§6.2.7)', () => {
  it('the call sites were found at all (a fence that finds nothing proves nothing, #720)', () => {
    expect(SITES.length).toBeGreaterThan(8);
    expect(SITES.some((s) => s.key === 'staff-handlers.ts:registerStaffBot')).toBe(true);
  });

  it('each call is on the «presence» or the «holds» list', () => {
    const unlisted = [...new Set(SITES.map((s) => s.key))].filter((k) => !(k in PRESENCE) && !(k in HOLDS));
    expect(unlisted, 'a call site on neither list — add it to one, with its reason').toEqual([]);
  });

  it('a «holds» call asks `holdingIntake(` or `intakeTakes(` beside it — never `activeIntake` alone', () => {
    const alone = SITES.filter((s) => s.key in HOLDS && !/\b(?:holdingIntake|intakeTakes)\(/.test(s.window)).map((s) => s.key);
    expect(alone).toEqual([]);
  });

  it('the four doors ask `holdingIntake`', () => {
    for (const door of DOORS) {
      const [file, fn] = door.site.split(':') as [string, string];
      const source = FILES.find((f) => f.path.endsWith(`/${file}`));
      expect(source, door.site).toBeDefined();
      expect(functionBody(source!.text, fn), door.site).toContain(door.needle);
    }
  });

  it('every listed key still names a call (a stale entry hides a moved one)', () => {
    const keys = new Set(SITES.map((s) => s.key));
    expect(Object.keys({ ...PRESENCE, ...HOLDS }).filter((k) => !keys.has(k))).toEqual([]);
  });
});
