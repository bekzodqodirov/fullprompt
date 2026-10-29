import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDIT_ATTEMPT_BASE, isFirstAsk, nextRedraftAttempt, REDRAFT_ATTEMPT_BASE } from '@/modules/wms/agent/queues';

/**
 * The attempt numbers of one inbound line (queues.ts): the first look and
 * its retry, his press's own band with a retry after each ask, the edits'
 * band. A press-made redraft once took attempt 1 — the sweep's retry slot —
 * so one that errored was never tried again (review of `redraftNewest`).
 */
describe('one line’s attempts: no kind of asking takes another’s slot', () => {
  it('a press asks past everything its band holds, on an even number — never 1, never an edit’s', () => {
    expect(nextRedraftAttempt([])).toBe(REDRAFT_ATTEMPT_BASE);
    // The first look stood down for his ✏️, and the sweep's retry slot stays the sweep's.
    expect(nextRedraftAttempt([0])).toBe(50);
    expect(nextRedraftAttempt([0, 1])).toBe(50);
    // An edit of the line does not move the press's band, nor the band the edit's.
    expect(nextRedraftAttempt([0, 100, 101])).toBe(50);
    // A second press over a first one — and over that one's retry.
    expect(nextRedraftAttempt([0, 50])).toBe(52);
    expect(nextRedraftAttempt([0, 50, 51])).toBe(52);
    expect(nextRedraftAttempt([0, 50, 51, 52])).toBe(54);
  });

  it('a spent band asks nothing rather than spill into the edits’ numbers', () => {
    expect(nextRedraftAttempt([98])).toBeNull();
    expect(nextRedraftAttempt([99])).toBeNull();
    expect(nextRedraftAttempt([96])).toBe(98);
  });

  it('the sweep retries an ASK — the first look or a press — once, and never a retry or an edit', () => {
    expect(isFirstAsk(0)).toBe(true);
    expect(isFirstAsk(1)).toBe(false);
    expect(isFirstAsk(50)).toBe(true);
    expect(isFirstAsk(51)).toBe(false);
    expect(isFirstAsk(52)).toBe(true);
    expect(isFirstAsk(EDIT_ATTEMPT_BASE)).toBe(false);
    // Every attempt a press can be given is an ask the sweep will retry.
    for (let a = nextRedraftAttempt([]); a !== null; a = nextRedraftAttempt([a])) expect(isFirstAsk(a), String(a)).toBe(true);
  });

  it('the sweep’s retry pass asks the same thing in SQL, and retries at the attempt after the ask', () => {
    const jobs = readFileSync('src/modules/wms/agent/jobs.ts', 'utf8');
    const pass = jobs.slice(jobs.indexOf('// 4. An errored ASK'), jobs.indexOf('// 5. Strangers'));
    expect(pass).toContain('${agentRuns.attempt} = 0 OR (${agentRuns.attempt} >= ${REDRAFT_ATTEMPT_BASE} AND ${agentRuns.attempt} < ${EDIT_ATTEMPT_BASE} AND ${agentRuns.attempt} % 2 = 0)');
    expect(pass).toContain('isFirstAsk(e.attempt)');
    expect(pass).toContain('attempt: e.attempt + 1');
    expect(pass).not.toMatch(/attempt: 1,/u);
  });

  it('an edit counts its own band from the same constant the press stops below', () => {
    const run = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    const fn = run.slice(run.indexOf('async function attemptFor('), run.indexOf('const lastOutAsked'));
    expect(fn).toContain('gte(agentRuns.attempt, EDIT_ATTEMPT_BASE)');
    expect(fn).toContain('return EDIT_ATTEMPT_BASE + ');
  });
});
