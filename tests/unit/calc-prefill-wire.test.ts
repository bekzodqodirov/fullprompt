import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Round 2's routing (§6.8) IS reachable on a stand-in `enqueue`, so it is
 * asserted behaviourally below.
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const sent = vi.hoisted(() => vi.fn());
vi.mock('@/modules/platform/jobs/boss', () => ({ enqueue: sent }));
// The real module, with the revision read stood in: the sender stamps it.
vi.mock('@/modules/wms/calc/prefill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill')>()),
  prefillTicket: async () => 7,
}));

import { queueCalcPrefill } from '@/modules/wms/calc/prefill-queue';
import {
  JOB_CALC_PREFILL,
  JOB_CALC_TARIFF_REPLY,
  PASS_EXPIRE_S,
  TARIFF_EXPIRE_S,
  registerCalcPrefillWorker,
} from '@/modules/wms/calc/jobs';
import { PASS_DEADLINE_MS } from '@/modules/wms/calc/prefill';

describe('every door hands the job to the machine', () => {
  // DERIVED, not a list of today's three (#789's idiom): every file that
  // opens a calculation outside the service itself must also queue the pass,
  // so a FOURTH door turns this red the day it is added. Until this round
  // only the bot queued, and the seller's card form and the thread door
  // landed identical requests and got nothing — which of three buttons a
  // seller happened to press decided whether the machine looked at their
  // cargo at all.
  const doors = execSync(
    "grep -rl 'openCalcRequest(' src --include=*.ts --include=*.tsx || true",
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.endsWith('calc/service.ts'));

  it('finds the doors at all', () => {
    // A grep that matches nothing passes every assertion below it (#494).
    expect(doors.length).toBeGreaterThanOrEqual(3);
  });

  for (const door of doors) {
    it(`${door} queues the prefill`, () => {
      const text = read(door);
      expect(text).toMatch(/queueCalcPrefill\(|queuePrefill\(/);
    });
  }
});

describe('the section picks the queue (§6.8)', () => {
  beforeEach(() => sent.mockReset());

  // Re-anchored for round 2: this pinned «the sender refuses a freight-only
  // job» (decision 8), which the owner overturned on 2026-09-26 and reversed
  // on 2026-10-21 (his 2.5 b: a yolkira request is answered from the tariff
  // at once). The sender now queues EVERY section; that the freight-only
  // pass calls no model is proven by calc-prefill.integration («a
  // freight-only job is left ALONE»), which stays.
  it('a yolkira job goes to the tariff queue — no longer refused', async () => {
    expect(await queueCalcPrefill({ requestId: 'r1', staffId: 's1', section: 'yolkira' })).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(
      JOB_CALC_TARIFF_REPLY,
      { requestId: 'r1', staffId: 's1', rev: 7, section: 'yolkira' },
      { expireInSeconds: TARIFF_EXPIRE_S },
    );
  });

  it('a rastamojka or podklyuch job goes to the customs queue, with an expiry above the pass', async () => {
    for (const section of ['rastamojka', 'podklyuch']) {
      sent.mockReset();
      await queueCalcPrefill({ requestId: 'r1', staffId: 's1', section });
      expect(sent).toHaveBeenCalledWith(
        JOB_CALC_PREFILL,
        { requestId: 'r1', staffId: 's1', rev: 7, section },
        { expireInSeconds: PASS_EXPIRE_S },
      );
    }
    // A request with no section yet reads as customs (the only kind queued
    // before the section existed).
    sent.mockReset();
    await queueCalcPrefill({ requestId: 'r1', staffId: 's1', section: null });
    expect(sent.mock.calls[0]?.[0]).toBe(JOB_CALC_PREFILL);
  });

  it('the customs expiry clears the pass deadline plus one worst step (2 × 60 s)', () => {
    // pg-boss re-delivers a job past its expiry while the first run is still
    // going; the default 15 minutes would have run a second pass beside it.
    expect(PASS_EXPIRE_S * 1000).toBeGreaterThan(PASS_DEADLINE_MS + 2 * 60_000);
  });

  it('registerCalcPrefillWorker creates and works BOTH queues, the customs one first', async () => {
    const boss = { createQueue: vi.fn(async () => {}), work: vi.fn(async () => 'w') };
    await registerCalcPrefillWorker(boss as never);
    expect(boss.createQueue.mock.calls.map((c) => (c as unknown[])[0])).toEqual([JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY]);
    expect(boss.work.mock.calls.map((c) => (c as unknown[])[0])).toEqual([JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY]);
  });
});

describe('the prefill survives a deploy', () => {
  it('the doors SEND and never run it in their own process', () => {
    // The send moved into `prefill-queue.ts` when the card form and the
    // thread door joined the bot (one sender, three doors) — so the
    // assertions follow it there. The bot's own file must still not run the
    // pass: an `aiPrefill` call inside a grammy handler is the unowned
    // promise in the container the owner restarts on every deploy.
    const sender = read('src/modules/wms/calc/prefill-queue.ts');
    expect(sender).toContain('JOB_CALC_PREFILL');
    expect(sender).toContain('enqueue(JOB_CALC_PREFILL');
    const bot = read('src/modules/platform/telegram/staff-handlers.ts');
    expect(bot).not.toContain('void prefillAndReply');
    expect(bot).not.toContain('aiPrefill');
  });

  it('a worker is registered for it, or nothing ever drains the queue', () => {
    const boss = read('src/modules/platform/jobs/boss.ts');
    expect(boss).toContain('registerCalcPrefillWorker');
    // Both queues are created and worked inside the one registration
    // `boss.ts` already calls (asserted behaviourally above).
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('for (const queue of [JOB_CALC_PREFILL, JOB_CALC_TARIFF_REPLY])');
    expect(jobs).toContain('boss.createQueue(queue)');
    expect(jobs).toContain('boss.work<CalcPrefillJob>(queue');
  });

  it('the answer goes through the drain — once per request — which owns the claim and the retries', () => {
    // Re-anchored for round 2: every machine message goes through `sayOnce`
    // (§6.8), which queues on the drain's own rows (`queueStaffTelegram`)
    // and kicks it after the commit.
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('sayOnce(requestId, {');
    expect(jobs).not.toContain('notifyStaffTelegram(');
    const once = read('src/modules/wms/calc/say-once.ts');
    expect(once).toContain('queueStaffTelegram(tx,');
    expect(once).toContain('await kickTelegramDrain()');
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
    expect(jobs).toContain('prefillStanding(requestId, data.rev ?? null)');
    const sender = read('src/modules/wms/calc/prefill-queue.ts');
    expect(sender).toContain('prefillTicket(');
    expect(sender).toMatch(/enqueue\(JOB_CALC_PREFILL, \{[^}]*rev[^}]*\}, \{ expireInSeconds: PASS_EXPIRE_S \}\)/);
  });

  it('the machine writes as NOBODY, and the seller is only told', () => {
    // The pass ran under the seller's id, so every code, rate and baza the
    // machine wrote landed in `audit_log` under the name of a person who
    // never saw them — and this company reads that log to answer «who put
    // this number here». `actorId: null` is the module's own idiom for a
    // machine acting. Who ASKED is not lost: it is the notification's
    // recipient, and `calc_requests.requested_by` on the row.
    const jobs = read('src/modules/wms/calc/jobs.ts');
    // The third argument names who READS the answer — its link is chosen for
    // them (`calcJobHrefFor`); it carries no authorship, the actor stays null.
    // The fourth (round 2) names the queue, so a moved section stands down.
    expect(jobs).toContain('aiPrefill(requestId, { actorId: null }, { replyTo: staffId }, { expectCustoms: writes })');
    expect(jobs).not.toContain('actorId: staffId');
    // …and `staffId` still names who hears about it.
    expect(jobs).toContain('userIds: [staffId]');
  });

  it('a failed pass is logged and NOT rethrown', () => {
    // Retrying a model that refused five times spends money to change
    // nothing; the request is in the VED's queue whatever happens here. What
    // pg-boss is here for is the process dying, which it re-delivers itself.
    const jobs = read('src/modules/wms/calc/jobs.ts');
    const at = jobs.indexOf('async function runPrefillJob');
    expect(at).toBeGreaterThan(-1);
    const body = jobs.slice(at, jobs.indexOf('async function writeReplyToLenta'));
    expect(body).toContain('[calc-prefill] pass failed');
    expect(body).not.toContain('throw err');
  });
});
