import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    // ctx.reply would need the middleware still running; sendMessage does not.
    expect(source).toMatch(/ctx\.api\.sendMessage\(/);
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
 */
describe('the hisoblatish analysis never holds the poller either', () => {
  const source = readFileSync('src/modules/platform/telegram/staff-handlers.ts', 'utf8');
  // The helper sits ABOVE its own call site in this file, so «everything
  // before the helper» is the wrong slice — it excludes the very line under
  // test and the assertion passes on nothing. Anchor on POSITIONS instead:
  // the one legitimate await lives inside the helper's body and nowhere else.
  const helperStart = source.indexOf('async function analyseIntakeAndReply');
  const helperEnd = source.indexOf('\n}\n', helperStart);

  it('dispatches the analysis off the middleware chain', () => {
    expect(helperStart, 'the helper exists').toBeGreaterThan(0);
    expect(source, 'fire-and-deliver, not await').toContain('void analyseIntakeAndReply(');
    const awaits = [...source.matchAll(/await\s+analyzeCollected\(/g)].map((m) => m.index ?? -1);
    expect(awaits.length, 'somebody still calls it').toBeGreaterThan(0);
    for (const at of awaits) {
      expect(at, 'awaited only inside the off-chain helper').toBeGreaterThan(helperStart);
      expect(at, 'and inside its body, not after it').toBeLessThan(helperEnd);
    }
  });

  it('the model call carries a deadline of its own', () => {
    // Without one the SDK waits about ten minutes, and the loop's own wall
    // clock is only consulted between rounds — so the socket outlives it.
    const ai = readFileSync('src/modules/wms/calc/intake-ai.ts', 'utf8');
    expect(ai).toMatch(/new Anthropic\(\{[^}]*timeout:/);
  });

  it('cannot leave the person on «⏳» with no answer', () => {
    expect(source.slice(helperStart, helperEnd), 'catches and says so').toContain('catch');
  });
});

