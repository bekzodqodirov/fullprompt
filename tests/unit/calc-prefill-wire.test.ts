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

  it('the worker asks whether a person got there first', () => {
    // pg-boss drains when it drains and re-delivers up to five times, while
    // `applyProposal` DELETES every group and the import fill clears the ✅
    // of every group it touches. Without this the machine could destroy an
    // evening of the VED's typing — and no behavioural test can reach the
    // worker body, so the wiring is asserted here (#531).
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('prefillStanding(');
    expect(jobs.indexOf('prefillStanding(')).toBeLessThan(jobs.indexOf('aiPrefill(requestId'));
    // …and the revision it compares against travels ON the job, stamped by
    // the sender: read at drain time it would always agree with itself.
    expect(jobs).toContain('job.data.rev');
    const bot = read('src/modules/platform/telegram/staff-handlers.ts');
    expect(bot).toContain('prefillTicket(');
    expect(bot).toMatch(/enqueue\(JOB_CALC_PREFILL, \{[^}]*rev[^}]*\}\)/);
  });

  it('the machine writes as NOBODY, and the seller is only told', () => {
    // The pass ran under the seller's id, so every code, rate and baza the
    // machine wrote landed in `audit_log` under the name of a person who
    // never saw them — and this company reads that log to answer «who put
    // this number here». `actorId: null` is the module's own idiom for a
    // machine acting. Who ASKED is not lost: it is the notification's
    // recipient, and `calc_requests.requested_by` on the row.
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('aiPrefill(requestId, { actorId: null })');
    expect(jobs).not.toContain('actorId: staffId');
    // …and `staffId` still names who hears about it.
    expect(jobs).toContain('userIds: [staffId]');
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
