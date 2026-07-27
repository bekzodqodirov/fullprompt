import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanNeedsConfirm, scanWasRecorded } from '@/offline/scan-outbox';

/**
 * What the loading screen must do with each answer the server can give.
 *
 * The owner's report — "scanner ishlamayabti, scann qilganda sanayabti lekin
 * mashinaga qoshmayabti" — was this classification being incomplete. The
 * screen handled `unknown_code` and `rejected` and had NO branch for
 * `not_on_plan`, so a crate the server refused kept its green tick and its
 * place in the counter, the outbox dropped it, and a re-scan answered
 * "already scanned". Boxes went on the truck that the manifest, the customs
 * invoice and the cost allocation knew nothing about.
 */
describe('what each scan verdict means', () => {
  it('treats only the three that write as recorded', () => {
    expect(scanWasRecorded('ok')).toBe(true);
    // A replay of a scan that already landed — the box IS on the truck.
    expect(scanWasRecorded('duplicate')).toBe(true);
    // Unload: the box arrived and was transferred to this warehouse.
    expect(scanWasRecorded('auto_transfer')).toBe(true);
  });

  it('treats every refusal as recorded NOTHING', () => {
    // This is the assertion that would have caught the live bug.
    expect(scanWasRecorded('not_on_plan')).toBe(false);
    expect(scanWasRecorded('unknown_code')).toBe(false);
    expect(scanWasRecorded('rejected')).toBe(false);
  });

  it('re-opens the confirm dialog only for a box that is simply off the plan', () => {
    // "Off the plan" is a decision for the loader to make; an unknown code or
    // a box in the wrong state is not something a reason box can fix.
    expect(scanNeedsConfirm('not_on_plan')).toBe(true);
    expect(scanNeedsConfirm('unknown_code')).toBe(false);
    expect(scanNeedsConfirm('rejected')).toBe(false);
    expect(scanNeedsConfirm('ok')).toBe(false);
  });

  it('classifies EVERY verdict the type allows — none may be forgotten', () => {
    /**
     * The bug was a missing case, so the test reads the union itself rather
     * than a list typed out here: a verdict added later and left unclassified
     * fails on the first run instead of losing cargo in a warehouse
     * (DECISIONS #163).
     */
    const source = readFileSync(resolve(__dirname, '../../src/offline/scan-outbox.ts'), 'utf8');
    const union = source.slice(source.indexOf('result:'), source.indexOf('detail?:'));
    const verdicts = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

    expect(verdicts).toContain('not_on_plan');
    expect(verdicts.length).toBeGreaterThanOrEqual(6);
    for (const verdict of verdicts) {
      const answer = scanWasRecorded(verdict as Parameters<typeof scanWasRecorded>[0]);
      expect(typeof answer, verdict).toBe('boolean');
    }
  });
});
