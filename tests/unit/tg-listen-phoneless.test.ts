import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A hidden number on a work account opens a lead (his «1 a», 2026-10-29) —
 * the listener's half. The decision and the minting are proven against a real
 * database in chat-lead-phoneless.integration; the listener is a gramjs
 * closure no test can import, so its wiring is pinned by source shape, in the
 * tg-listen-agent-wire tradition: each assertion names the defect it stops.
 */

const src = readFileSync('scripts/tg-listen.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const body = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe('the listener files a kept line through ONE door', () => {
  const handle = body('const handleMessage = async', 'const rethinkOnEdit = async');
  const catchUp = body('const catchUp = async', 'const CATCHUP_RETRY_MS');

  it('the live line and the catch-up both ask `ownerOfVerdict` — no second copy of the three owners to forget the hidden number in', () => {
    expect(handle).toContain('const owner = await ownerOfVerdict(verdict, account.managerUserId, {');
    expect(catchUp).toContain('const owner = await ownerOfVerdict(verdict, account.managerUserId, {');
    // The old hand-written branches minted through `leadForChat` with a phone they assumed.
    expect(src).not.toContain('leadForChat(');
    for (const path of [handle, catchUp]) {
      expect(path).toContain('clientId: owner.clientId,');
      expect(path).toContain('leadId: owner.leadId,');
    }
  });

  it('a chat a person answered meanwhile is stored nowhere, and the fresh rules decide the next line', () => {
    const refused = handle.slice(handle.indexOf('if (!owner) {'), handle.indexOf('const written = await storeIncoming('));
    expect(refused, 'the refusal sits before the store').not.toBe('');
    expect(refused).toContain('rules = await rulesFor(account.managerUserId);');
    expect(refused).toContain('return null;');
    expect(catchUp.indexOf('if (!owner) continue;')).toBeLessThan(catchUp.indexOf('const written = await storeIncoming('));
  });

  it('the «📵» card is still noted only for a line the verdict did NOT keep — so a work number’s hidden-number lead gets none', () => {
    const notKept = handle.slice(handle.indexOf('if (!verdict.store) {'), handle.indexOf('const owner = await ownerOfVerdict('));
    expect(notKept).toContain("if (verdict.reason === 'no_phone') await strangerSeen(peer, msg.out === true, 'no_phone');");
    expect(handle.slice(handle.indexOf('const owner = await ownerOfVerdict('))).not.toContain('strangerSeen(');
  });
});
