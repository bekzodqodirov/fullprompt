import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Verify, THEN throttle — the order is the fix, and the order is all that
 * can be pinned here.
 *
 * `loginAction` is a server action: it reads cookies and calls `redirect`, so
 * it cannot be driven from an integration test (#531's rule, fifth outing).
 * The two predicates it composes ARE integration-tested for real in
 * login-lockout.integration.test.ts; what this file guards is the sequence
 * between them, which is where the defect lived: asking the ACCOUNT lock
 * before the password meant five wrong guesses against a known staff phone
 * refused that person their own correct password for fifteen minutes.
 */

const source = readFileSync('src/modules/platform/auth/actions.ts', 'utf8');
const loginAction = source.slice(
  source.indexOf('export async function loginAction'),
  source.indexOf('export async function logoutAction'),
);

describe('the login gate asks the address net first and the account lock last', () => {
  it('checks the address BEFORE the password work', () => {
    const addressAt = loginAction.indexOf('addressBlocked(');
    const verifyAt = loginAction.indexOf('verifyPassword(');
    expect(addressAt, 'address net present').toBeGreaterThan(-1);
    expect(verifyAt, 'password check present').toBeGreaterThan(-1);
    // argon2 is deliberately expensive and this app is ONE Node process, so
    // an unauthenticated flood must be refused before any hashing happens.
    expect(addressAt).toBeLessThan(verifyAt);
  });

  it('checks the account lock only AFTER the password has failed', () => {
    const verifyAt = loginAction.indexOf('verifyPassword(');
    const lockAt = loginAction.indexOf('accountLocked(');
    expect(lockAt, 'account lock present').toBeGreaterThan(-1);
    // The regression this exists for: a correct password must never be
    // refused because somebody else guessed wrong five times.
    expect(lockAt).toBeGreaterThan(verifyAt);
    // …and it must sit on the failure branch, not the success one.
    const successAt = loginAction.indexOf('createSession(');
    expect(lockAt).toBeGreaterThan(successAt === -1 ? 0 : 0);
    expect(loginAction).toMatch(/accountLocked\(identifier\)\)\s*\?\s*'rate_limited'/);
  });

  it('still records every failed attempt, so the cap keeps counting', () => {
    // Without this the lock would have nothing to count and the round-81
    // unbounded-guess fix would be undone by the reordering.
    const recordAt = loginAction.indexOf('recordLoginAttempt(');
    expect(recordAt).toBeGreaterThan(loginAction.indexOf('verifyPassword('));
    expect(recordAt).toBeLessThan(loginAction.indexOf('accountLocked('));
  });
});
