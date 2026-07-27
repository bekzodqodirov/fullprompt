import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxesForScan, scanNeedsConfirm, scanWasRecorded } from '@/offline/scan-outbox';

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

describe('what a scanned code puts on the truck', () => {
  /**
   * The regression that stopped a load: "1 scan qilib ketidan noto'g'ri
   * deyabti va umuman ishlamayabti".
   *
   * The loading snapshot ships a crate's REAL contents, and the plan reserves
   * an exact set. Requiring every box in the crate to be on the plan meant one
   * stray box — fitted in after the plan was approved — made a crate the plan
   * had asked for unscannable, and the red confirm that then covered the
   * screen disabled the scanner under it.
   */
  const CRATES = [
    { code: 'CR-YW26-00001', boxShortCodes: ['YW26-000001', 'YW26-000002', 'YW26-000003'] },
    { code: 'CR-YW26-00099', boxShortCodes: ['YW26-000900', 'YW26-000901'] },
  ];
  const onTruck = new Set(['YW26-000001', 'YW26-000002', 'YW26-000010']);

  it('a loose box is itself', () => {
    expect(boxesForScan('YW26-000010', CRATES, onTruck, false)).toEqual(['YW26-000010']);
    // Even one that is not on the plan — the caller decides, not this.
    expect(boxesForScan('YW26-000777', CRATES, onTruck, false)).toEqual(['YW26-000777']);
  });

  it('a planned crate loads its planned boxes and leaves the stray', () => {
    // 000003 was dropped into the crate after the plan was approved.
    expect(boxesForScan('CR-YW26-00001', CRATES, onTruck, false)).toEqual([
      'YW26-000001',
      'YW26-000002',
    ]);
  });

  it('a crate belonging to another truck comes back empty, not accepted', () => {
    // The trap: `[].every(...)` is true, so an empty answer must be
    // distinguishable — otherwise the wrong crate waves straight through.
    expect(boxesForScan('CR-YW26-00099', CRATES, onTruck, false)).toEqual([]);
  });

  it('a quick batch takes the whole crate — it has no plan to be off', () => {
    expect(boxesForScan('CR-YW26-00099', CRATES, onTruck, true)).toEqual([
      'YW26-000900',
      'YW26-000901',
    ]);
  });
});
