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
  workModeSwitch,
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

/**
 * The running listener's switch (`workModeSwitch`), driven as gramjs drives
 * it: two strangers' lines decided at the same moment, a read that takes a
 * database round trip. The review of L1 reproduced the old reader handing the
 * second stranger a tray question after the owner had switched to «Ish raqami».
 */
describe('two strangers at once after the flip', () => {
  /** The switch over reads the test releases — the database round trip; every read asked is answered. */
  function slowSwitch(initial: boolean) {
    const seen = { reads: 0, lines: [] as string[], warnings: 0 };
    const waiting: ((work: boolean) => void)[] = [];
    const sw = workModeSwitch({
      initial,
      now: 0,
      read: () => {
        seen.reads += 1;
        return new Promise<boolean>((resolve) => {
          waiting.push(resolve);
        });
      },
      log: (line) => seen.lines.push(line),
      warn: () => {
        seen.warnings += 1;
      },
    });
    return { sw, seen, release: (work: boolean) => waiting.splice(0).forEach((answer) => answer(work)) };
  }

  it('both are decided again — not only the one whose read saw the change', async () => {
    const { sw, release } = slowSwitch(false);
    const t = WORK_MODE_TTL_MS;
    const a = sw.movedFrom(false, t);
    const b = sw.movedFrom(false, t + 3);
    await Promise.resolve();
    release(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(sw.work).toBe(true);
  });

  it('share the read in flight — one database question, one change line', async () => {
    const { sw, seen, release } = slowSwitch(false);
    const t = WORK_MODE_TTL_MS;
    const lines = [sw.movedFrom(false, t), sw.movedFrom(false, t + 1), sw.refresh(t + 2, true)];
    await Promise.resolve();
    release(true);
    await Promise.all(lines);
    expect(seen.reads).toBe(1);
    expect(seen.lines).toHaveLength(1);
    // …and the clock it set holds the next stranger off for half a minute.
    expect(await sw.movedFrom(true, t + 10)).toBe(false);
    expect(seen.reads).toBe(1);
  });

  it('a line decided with the old value is decided again even when somebody else’s read already landed', async () => {
    const { sw, release } = slowSwitch(false);
    const forced = sw.refresh(5, true);
    await Promise.resolve();
    release(true);
    await forced;
    // The clock is fresh — no read — but this line was decided with «shaxsiy».
    expect(await sw.movedFrom(false, 6)).toBe(true);
    expect(await sw.movedFrom(true, 6)).toBe(false);
  });

  it('a line about to be STORED reads the switch afresh — a flip to «Shaxsiy raqam» stops the very next lead (2026-10-29 review)', async () => {
    // The probe: «Ish raqami» read at t0, flipped to personal in the database, a stranger's line at t0+25 s.
    let work = true;
    let reads = 0;
    const sw = workModeSwitch({ initial: true, now: 0, read: async () => ((reads += 1), work), log: () => {}, warn: () => {} });
    work = false;
    // A line that would only be passed over keeps the clock — a late «yes» costs one line…
    expect(await sw.movedFrom(true, 25_000)).toBe(false);
    expect(reads).toBe(0);
    // …a line that would be written asks now: no stored lead on a half-minute-old «Ish raqami».
    expect(await sw.movedFrom(true, 25_000, true)).toBe(true);
    expect({ reads, work: sw.work }).toEqual({ reads: 1, work: false });
  });

  it('a failed read keeps the last answer and waits for the next clock', async () => {
    let reads = 0;
    let warned = 0;
    const sw = workModeSwitch({
      initial: true,
      now: 0,
      read: async () => {
        reads += 1;
        throw new Error('connection terminated');
      },
      log: () => {},
      warn: () => {
        warned += 1;
      },
    });
    expect(await sw.movedFrom(true, WORK_MODE_TTL_MS)).toBe(false);
    expect(await sw.movedFrom(true, WORK_MODE_TTL_MS + 1)).toBe(false);
    expect({ work: sw.work, reads, warned }).toEqual({ work: true, reads: 1, warned: 1 });
  });
});

describe('the listener asks it (source shape)', () => {
  const src = readFileSync('scripts/tg-listen.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const body = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const handle = body('const handleMessage = async', 'const rethinkOnEdit = async');

  it('a stranger’s verdict asks the switch’s own clock — BEFORE the miss refresh, and the line is decided again when it moved', () => {
    const decided = handle.indexOf('const decidedWith = workMode.work;\n      let verdict = decideIncoming(peer, msg, book.clients, rules, decidedWith);');
    expect(decided, 'the value the line is decided with is the one compared').toBeGreaterThan(0);
    // `switchDecides`, not `suspectsStaleBook`: since his «1 a» a hidden number is the switch's too.
    // A line the switch would have STORED reads it afresh (`verdict.store` is the force).
    const ask = handle.indexOf('if (switchDecides(verdict) && (await workMode.movedFrom(decidedWith, now, verdict.store))) {');
    expect(ask, 'the stranger path asks the switch').toBeGreaterThan(decided);
    const branch = handle.slice(ask, handle.indexOf('}', ask));
    expect(branch).toContain('verdict = decideIncoming(peer, msg, book.clients, rules, workMode.work);');
    // Ahead of the refresh that resets the book's clock — never only inside it.
    expect(ask).toBeLessThan(handle.indexOf('shouldRefreshOnMiss(book, now)'));
    const miss = handle.slice(handle.indexOf('shouldRefreshOnMiss(book, now)'), handle.indexOf('applySiteTag('));
    expect(miss).not.toContain('isWorkAccount(');
  });

  it('the stale book still reads it too, and every decision passes the one value the clock keeps', () => {
    const stale = handle.slice(handle.indexOf('if (bookIsStale(book, now)) {'), handle.indexOf('let verdict ='));
    expect(stale).toContain('await workMode.refresh(now, true);');
    expect(src).not.toMatch(/\bworkAccount\b/);
    const decisions = [...src.matchAll(/decideIncoming\(peer, msg(?: as never)?, book\.clients, rules, ([\w.]+)\)/g)].map((m) => m[1]);
    expect(decisions.length, 'live, catch-up and the backfill').toBeGreaterThanOrEqual(5);
    expect(new Set(decisions)).toEqual(new Set(['workMode.work', 'decidedWith']));
    expect(decisions.filter((d) => d === 'decidedWith'), 'the live line’s first decision only').toHaveLength(1);
  });

  it('the listener holds ONE switch, over one read — the only database question about it', () => {
    const made = body('const workMode = workModeSwitch({', '`tinglayapman: ');
    expect(made).toContain('read: () => isWorkAccount(account.managerUserId),');
    expect(made).toContain('log: (line) => console.log(line),');
    expect(src.match(/isWorkAccount\(/g), 'the start and the reader').toHaveLength(2);
    expect(src).not.toMatch(/\blet workMode\b/);
  });

  it('the start line names the mode', () => {
    expect(src).toContain('`tinglayapman: ${account.managerName} · ${tgPhone} · ${workModeWord(workMode.work)} · ');
  });
});
