import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOK_MISS_COOLDOWN_MS,
  bookIsStale,
  newBook,
  shouldRefreshOnMiss,
  WORK_MODE_TTL_MS,
  workModeChangeLine,
  workModeIsStale,
  workModeWord,
  type BookState,
} from '../../src/modules/wms/crm/telegram-live';

/**
 * «Ish raqami» reaching the RUNNING listener (2026-10-29). The switch decides
 * what a stranger's line becomes — a lead whose words are kept, or a tray
 * question whose words are not — and the listener used to re-read it only
 * with the ten-minute book, a clock every stranger's miss refresh resets.
 * The pure half is here; the listener is a gramjs closure no test can
 * import, so its wiring is pinned by source shape, in the
 * tg-listen-agent-wire tradition: each assertion names the defect it stops.
 */

describe('the switch’s own clock', () => {
  it('is half a minute — the agent settings’ cadence, not the book’s ten', () => {
    expect(WORK_MODE_TTL_MS).toBe(30_000);
    const read = { work: false, readAt: 1_000_000 };
    expect(workModeIsStale(read, 1_000_000 + 29_999)).toBe(false);
    expect(workModeIsStale(read, 1_000_000 + 30_000)).toBe(true);
  });

  it('the book alone never comes due while strangers keep writing — the switch’s clock does', () => {
    // A stranger a minute, for half an hour: the shape of a busy work number.
    let now = 1_000_000;
    let book: BookState = newBook([], now);
    let workMode = { work: false, readAt: now };
    let bookReads = 0;
    let modeReads = 0;
    for (let i = 0; i < 30; i += 1) {
      now += BOOK_MISS_COOLDOWN_MS;
      if (bookIsStale(book, now)) bookReads += 1;
      if (workModeIsStale(workMode, now)) {
        modeReads += 1;
        workMode = { work: workMode.work, readAt: now };
      }
      // The miss refresh — what tg-listen does for every stranger — resets the book's clock.
      if (shouldRefreshOnMiss(book, now)) book = { ...newBook([], now), missRefreshedAt: now };
    }
    expect(bookReads, 'the old and only place the switch was read').toBe(0);
    expect(modeReads).toBe(30);
  });

  it('says the mode in the owner’s words, and a change in one line — none when it did not move', () => {
    expect(workModeWord(true)).toBe('ish raqami');
    expect(workModeWord(false)).toBe('shaxsiy raqam');
    expect(workModeChangeLine(false, true)).toContain('«ish raqami»');
    expect(workModeChangeLine(true, false)).toContain('«shaxsiy raqam»');
    expect(workModeChangeLine(true, true)).toBeNull();
    expect(workModeChangeLine(false, false)).toBeNull();
  });
});

describe('the listener asks it (source shape)', () => {
  const src = readFileSync('scripts/tg-listen.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const body = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const handle = body('const handleMessage = async', 'const rethinkOnEdit = async');

  it('a stranger’s verdict asks the switch’s own clock — BEFORE the miss refresh, and the line is decided again when it moved', () => {
    const ask = handle.indexOf('if (suspectsStaleBook(verdict) && (await workModeMoved(now))) {');
    expect(ask, 'the stranger path asks the switch').toBeGreaterThan(0);
    const branch = handle.slice(ask, handle.indexOf('}', ask));
    expect(branch).toContain('verdict = decideIncoming(peer, msg, book.clients, rules, workMode.work);');
    // Ahead of the refresh that resets the book's clock — never only inside it.
    expect(ask).toBeLessThan(handle.indexOf('shouldRefreshOnMiss(book, now)'));
    const miss = handle.slice(handle.indexOf('shouldRefreshOnMiss(book, now)'), handle.indexOf('applySiteTag('));
    expect(miss).not.toContain('isWorkAccount(');
  });

  it('the stale book still reads it too, and every decision passes the one value the clock keeps', () => {
    const stale = handle.slice(handle.indexOf('if (bookIsStale(book, now)) {'), handle.indexOf('let verdict ='));
    expect(stale).toContain('await workModeMoved(now, true);');
    expect(src).not.toMatch(/\bworkAccount\b/);
    const decisions = [...src.matchAll(/decideIncoming\(peer, msg(?: as never)?, book\.clients, rules, ([\w.]+)\)/g)].map((m) => m[1]);
    expect(decisions.length, 'live, catch-up and the backfill').toBeGreaterThanOrEqual(5);
    expect(new Set(decisions)).toEqual(new Set(['workMode.work']));
  });

  it('the reader keeps its own clock, writes the change line, and one read is the only database question', () => {
    const moved = body('const workModeMoved = async', 'const tablesReady = async');
    expect(moved).toContain('if (!force && !workModeIsStale(workMode, now)) return false;');
    expect(moved).toContain('await isWorkAccount(account.managerUserId)');
    expect(moved).toContain('workModeChangeLine(workMode.work, work)');
    expect(moved).toContain('if (line) console.log(line);');
    // A failed read is not a personal number: the last answer stands until the next clock.
    expect(moved).toContain('workMode = { work: workMode.work, readAt: now };');
    expect(src.match(/isWorkAccount\(/g), 'the start and the reader').toHaveLength(2);
  });

  it('the start line names the mode', () => {
    expect(src).toContain('`tinglayapman: ${account.managerName} · ${tgPhone} · ${workModeWord(workMode.work)} · ');
  });
});
