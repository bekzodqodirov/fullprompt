import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectorFiles } from '../fixtures/calc-collector-source';

/**
 * The AI answer must never hold the Telegram poller.
 *
 * grammy's built-in poller is SEQUENTIAL — one update at a time, each fully
 * awaited — and this bot serves the CUSTOMERS as well as the staff. Awaiting
 * a model loop inside the handler therefore freezes every cabinet tap, every
 * /start and every arrival flow for as long as one admin's question takes:
 * tens of seconds normally, and up to the SDK's own timeout on a hang. The
 * owner's own words are that 95 % of customer contact is this channel, so
 * that is the primary channel appearing dead.
 *
 * Source-shape, because the freeze is a property of the DISPATCH and not of
 * anything a running test can observe without a live Telegram: both versions
 * answer correctly, and only one of them answers alone.
 */
describe('the AI answer never holds the Telegram poller', () => {
  const source = readFileSync('src/modules/platform/telegram/staff-handlers.ts', 'utf8');

  // The helper legitimately awaits the assistant — that is the point of it.
  // What must never happen is the HANDLER awaiting, so the claim is scoped to
  // the middleware half of the file (everything above the helper).
  const handlerHalf = source.slice(0, source.indexOf('async function answerWithAssistant'));

  it('dispatches the assistant off the middleware chain', () => {
    expect(handlerHalf, 'fire-and-deliver, not await').toContain('void answerWithAssistant(');
    // The exact regression: `await assistantFromBot(...)` inside the handler.
    expect(handlerHalf, 'never awaited in the handler').not.toMatch(/await\s+assistantFromBot\(/);
    expect(handlerHalf.length, 'the helper exists to be sliced off').toBeGreaterThan(0);
  });

  it('delivers by chat id rather than through the held context', () => {
    // ctx.reply would need the middleware still running; the sender does not.
    // Re-anchored ON PURPOSE in round C (it read `ctx.api.sendMessage(`):
    // the answer now goes through the one Bot-API sender as NEW message(s)
    // addressed by chat id, and the helper takes no ctx at all — which is the
    // property this test exists for, stated more strongly than before.
    const fn = source.slice(source.indexOf('async function answerWithAssistant'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/sendTextBriefRetry\(\{\s*chatId/);
    expect(body, 'the helper must not need the middleware context').not.toMatch(/\bctx\b/);
  });

  it('keeps the placeholder and points it at the answer, typing while it waits', () => {
    // Round C (REL-13/STAFF-10): the answer is a NEW message — an edit makes
    // no sound — and the «O‘ylayapman…» it replaces is edited to point down.
    const fn = source.slice(source.indexOf('async function answerWithAssistant'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(handlerHalf).toContain('void answerWithAssistant(chatId, text, thinking.message_id);');
    expect(body).toContain('sendTyping(chatId)');
    expect(body).toContain('clearInterval(typing)');
    expect(body).toContain('splitMessage(answer)');
    expect(body).toContain("html: '🤖 Javob pastda ⬇️'");
  });

  it('cannot leave an unhandled rejection behind', () => {
    // A background promise that rejects is the one way this could take the
    // process down rather than merely fail one answer.
    const fn = source.slice(source.indexOf('async function answerWithAssistant'));
    expect(fn.slice(0, 2000)).toContain('catch');
  });

  it('the model call carries its own deadline', () => {
    // Independent of the loop's wall clock, which is only checked BETWEEN
    // rounds — one stalled connection must not outlive it (round 97's rule:
    // an un-deadlined network call is the failure that looks like a hang).
    const model = readFileSync('src/modules/platform/ai/model.ts', 'utf8');
    expect(model).toContain('timeout');
    expect(model).toMatch(/new Anthropic\(\{[^}]*timeout/);
  });
});

/**
 * The hisoblatish analysis is the same call on the same poller.
 *
 * `analyzeIntake` is an Opus call over up to twenty thousand characters, and
 * the audit found it awaited straight inside the «✅ Bo'ldi» handler — so one
 * staff member pressing analyse froze the customer bot for as long as it
 * took, and on a hung socket for the SDK's default ten minutes, because the
 * client was constructed with no timeout at all.
 *
 * Re-anchored (docs/SAKKIZ-R3.md §7.2.3, §11, P2): «dispatches the analysis
 * off the middleware chain» is now «the press enqueues `JOB_CALC_INTAKE_READ`
 * and calls no model» — the reading is a pg-boss job, so it is not on the
 * poller, nor in a `void` the next deploy kills.
 */
describe('the hisoblatish analysis never holds the poller either', () => {
  const source = readFileSync('src/modules/platform/telegram/calc-read.ts', 'utf8');
  const bodyOf = (head: string) => {
    const at = source.indexOf(head);
    return at < 0 ? '' : source.slice(at, source.indexOf('\n}\n', at));
  };
  const press = bodyOf('export async function pressAnalyse(');
  // The job's own body: the one place the model is awaited.
  const jobStart = source.indexOf('async function readOnce(');
  const jobEnd = source.indexOf('\n}\n', jobStart);

  it('the press enqueues JOB_CALC_INTAKE_READ and calls no model', () => {
    expect(press.length, 'the press exists').toBeGreaterThan(0);
    expect(press).toMatch(/await enqueue<IntakeReadJob>\(\s*JOB_CALC_INTAKE_READ,/);
    expect(press, 'no model in the press').not.toMatch(/analyzeCollected\(|analyzeIntake\(|runIntakeRead\(|readOnce\(/);
    const awaits = [...source.matchAll(/await\s+analyzeCollected\(/g)].map((m) => m.index ?? -1);
    expect(awaits.length, 'somebody still calls it').toBeGreaterThan(0);
    for (const at of awaits) {
      expect(at, 'awaited only inside the job').toBeGreaterThan(jobStart);
      expect(at, 'and inside its body, not after it').toBeLessThan(jobEnd);
    }
    for (const { file, text } of collectorFiles().filter((f) => f.file !== 'calc-read.ts')) {
      expect(text, `${file} awaits the reading`).not.toMatch(/await\s+analyzeCollected\(/);
    }
  });

  it('the model call carries a deadline of its own', () => {
    // Without one the SDK waits about ten minutes, and the loop's own wall
    // clock is only consulted between rounds — so the socket outlives it.
    const ai = readFileSync('src/modules/wms/calc/intake-ai.ts', 'utf8');
    expect(ai).toMatch(/new Anthropic\(\{[^}]*timeout:/);
  });

  it('cannot leave the person on «⏳» with no answer', () => {
    // An enqueue that throws releases the token and says so; a job that fails
    // for the last time says so too (calc-read-press / calc-read-job tests).
    // Re-anchored (P2's review fixes): the words moved into `refuseStart`,
    // which the press calls for BOTH of its refusals — the enqueue that threw
    // and the flush that did not write the collection (review adv-10).
    expect(press, 'the press catches its enqueue').toContain('catch');
    expect([...press.matchAll(/await refuseStart\(ctx, chatId, token\)/g)], 'both refusals are said').toHaveLength(2);
    expect(bodyOf('async function refuseStart('), 'and released').toContain('analysing: null');
    expect(bodyOf('async function refuseStart(')).toContain('READING.queueRefused');
    expect(bodyOf('export async function runIntakeRead('), 'the last attempt answers').toContain('lastAttemptFailed(');
  });
});
