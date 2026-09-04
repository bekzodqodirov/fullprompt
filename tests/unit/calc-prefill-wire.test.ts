import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTE_GROUPS } from '@/modules/platform/notifications/mutes';

/**
 * The AI VED hodimi's pass belongs to pg-boss, not to the app process.
 *
 * It shipped dispatched with `void` from the staff bot — an unowned promise
 * in the container the owner restarts on every deploy. A restart mid-pass
 * left a request carrying AI groups `applyProposal` had already committed,
 * no bazas, no retry, no row anywhere saying a pass was owed, and a seller
 * who had been promised an answer and got silence. The precedent was in the
 * same sub-round one directory over: the customs parse is a job for exactly
 * this reason.
 *
 * Four halves, none of which any behavioural test can reach — the bot needs
 * a Telegram and the worker needs a running boss (#531's rule: a
 * service-level test of a queued path proves the service, not the wiring).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the prefill survives a deploy', () => {
  it('the bot SENDS and never runs it in its own process', () => {
    const bot = read('src/modules/platform/telegram/staff-handlers.ts');
    expect(bot).toContain('JOB_CALC_PREFILL');
    expect(bot).toContain('enqueue(JOB_CALC_PREFILL');
    // The unowned promise, by every spelling it had.
    expect(bot).not.toContain('void prefillAndReply');
    expect(bot).not.toContain('aiPrefill');
  });

  it('a worker is registered for it, or nothing ever drains the queue', () => {
    const boss = read('src/modules/platform/jobs/boss.ts');
    expect(boss).toContain('registerCalcPrefillWorker');
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('boss.createQueue(JOB_CALC_PREFILL)');
    expect(jobs).toContain('boss.work<CalcPrefillJob>(JOB_CALC_PREFILL');
  });

  it('the answer goes through the drain, which owns the claim and the retries', () => {
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('notifyStaffTelegram');
    // …and the type it sends under is one a person can actually silence.
    expect(jobs).toContain("type: 'CalcPrefilled'");
    expect(Object.values(MUTE_GROUPS).flat()).toContain('CalcPrefilled');
  });

  it('a failed pass is logged and NOT rethrown', () => {
    // Retrying a model that refused five times spends money to change
    // nothing; the request is in the VED's queue whatever happens here. What
    // pg-boss is here for is the process dying, which it re-delivers itself.
    const jobs = read('src/modules/wms/calc/jobs.ts');
    const at = jobs.indexOf('JOB_CALC_PREFILL,');
    expect(at).toBeGreaterThan(-1);
    const body = jobs.slice(at);
    expect(body).toContain('[calc-prefill] pass failed');
    expect(body).not.toContain('throw err');
  });
});
