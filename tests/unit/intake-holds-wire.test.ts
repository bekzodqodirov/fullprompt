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
 *
 * «Beside it» is the call's OWN statement — the ternary that asks
 * `holdingIntake` first — or, for a call that binds its answer
 * (`const state = activeIntake(…)`), that binding handed to `intakeTakes(`.
 * A fixed window of text around the call passed a new door written two lines
 * from the ladder's `intakeTakes` (the P1 review's ADV-9). And `peekIntake`,
 * memory with NO expiry and no hold, is asked only by the sweep.
 */

const PRESENCE: Record<string, string> = {
  'calc-intake-sweep.ts:pressResume': 'a collection’s own «▶️» un-parks it',
  // The reading job (P2, §7.2.4): each asks only whether ITS token or ITS
  // stored reply is still the collection's — a parked collection is still the
  // one the seller pressed «Bo‘ldi» in.
  'calc-read.ts:pressAnalyse': 'the press re-reads its own token after the notice is out (§7.2.3)',
  'calc-read.ts:refuseStart': 'a refused start releases only its own token',
  'calc-read.ts:readOnce': 'the settle against the LIVE collection, and the stored reply re-read (§7.2.4.6)',
  'calc-read.ts:deliver': 'the send only while the reply is still the collection’s (§7.2.4.7)',
  'calc-read.ts:settleDelivered': 'the delivered table recorded on the collection it was for',
  'calc-read.ts:clearPending': 'a refused chat clears only its own stored reply',
  'calc-read.ts:lastAttemptFailed': 'the last attempt releases only its own token (§7.2.4.8)',
  'calc-read.ts:releaseDeadReading': 'the sweep’s release of a dead job’s token, only that token',
  'calc-read.ts:deliverStoredReply': 'the sweep’s late delivery of a stored reply',
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

/** The sweep's own reads of memory as it stands — the only callers of `peekIntake(`. */
const PEEK: Record<string, string> = {
  'calc-intake-sweep.ts:runIntakeSweep': 'the re-read after the facts’ awaits',
  'calc-intake-sweep.ts:remind': 'the reminder’s release, only of its own claim',
  'calc-intake-sweep.ts:resumeLanding': 'the clock put back, only if the seller did not act meanwhile',
};

interface Site {
  key: string;
  /** The statement the call sits in. */
  statement: string;
  /** What follows that statement — where a bound answer is handed on. */
  after: string;
}

/** The statement around `at`: from the last `;`, `{` or `}` before it to the next `;` at its own depth. */
function statementAt(text: string, at: number): { statement: string; end: number } {
  const from = Math.max(text.lastIndexOf(';', at), text.lastIndexOf('{', at), text.lastIndexOf('}', at)) + 1;
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) return { statement: text.slice(from, i), end: i };
    if (depth < 0) return { statement: text.slice(from, i), end: i };
  }
  return { statement: text.slice(from), end: text.length };
}

function sitesOf(needle: string): Site[] {
  return FILES.flatMap(({ path, text }) => {
    const file = path.split('/').at(-1)!;
    const out: Site[] = [];
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      if (/\w$/.test(text.slice(Math.max(0, at - 1), at))) continue; // another name ending in it
      if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue; // the definition
      const { statement, end } = statementAt(text, at);
      out.push({ key: `${file}:${functionAt(text, at)}`, statement, after: text.slice(end, end + 400) });
    }
    return out;
  });
}

const SITES: Site[] = sitesOf('activeIntake(');
const PEEKS: Site[] = sitesOf('peekIntake(');

/** Does a «holds» call ask its question — in its own statement, or by handing its bound answer to `intakeTakes(`? */
function asksHolds(site: Site): boolean {
  if (/\b(?:holdingIntake|intakeTakes)\(/.test(site.statement)) return true;
  const bound = /^\s*(?:const|let)\s+(\w+)\s*=\s*activeIntake\(/.exec(site.statement);
  return bound !== null && new RegExp(`\\bintakeTakes\\(${bound[1]}\\b`).test(site.after);
}

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
    const holds = SITES.filter((s) => s.key in HOLDS);
    expect(holds.length, 'the ladders and the orphan guard were found').toBeGreaterThanOrEqual(4);
    expect(holds.filter((s) => !asksHolds(s)).map((s) => `${s.key}: ${s.statement.trim()}`)).toEqual([]);
  });

  it('`peekIntake(` — no expiry, no hold — is the sweep’s alone', () => {
    expect(PEEKS.length, 'the sweep’s reads were found').toBeGreaterThanOrEqual(3);
    expect([...new Set(PEEKS.map((s) => s.key))].filter((k) => !(k in PEEK))).toEqual([]);
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
