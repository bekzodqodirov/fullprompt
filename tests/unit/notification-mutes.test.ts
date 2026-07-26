import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  groupsFromList,
  isTelegramMuted,
  listFromGroups,
  MUTE_GROUPS,
} from '@/modules/platform/notifications/mutes';

describe('notification mutes (spec §11 per-user mute)', () => {
  it('mutes nothing by default', () => {
    expect(isTelegramMuted([], 'ReceiptConfirmed')).toBe(false);
    expect(isTelegramMuted(undefined, 'DailyDigest')).toBe(false);
    expect(isTelegramMuted(null, 'DailyDigest')).toBe(false);
  });

  it("'all' mutes every type", () => {
    expect(isTelegramMuted(['all'], 'ReceiptConfirmed')).toBe(true);
    expect(isTelegramMuted(['all'], 'RestoreTestFailed')).toBe(true);
  });

  it('mutes exactly the listed types', () => {
    const muted = ['DailyDigest'];
    expect(isTelegramMuted(muted, 'DailyDigest')).toBe(true);
    expect(isTelegramMuted(muted, 'ReceiptConfirmed')).toBe(false);
  });

  it('round-trips group selections through the stored list', () => {
    const list = listFromGroups(false, { digest: true, tasks: false, alerts: false, operations: true });
    expect(list).toEqual([...MUTE_GROUPS.digest, ...MUTE_GROUPS.operations]);
    const back = groupsFromList(list);
    expect(back.all).toBe(false);
    expect(back.groups).toEqual({ digest: true, tasks: false, alerts: false, operations: true });
  });

  it("'all' wins over group detail and reads back as everything checked", () => {
    const list = listFromGroups(true, { digest: false, tasks: false, alerts: false, operations: false });
    expect(list).toEqual(['all']);
    const back = groupsFromList(list);
    expect(back.all).toBe(true);
    expect(back.groups).toEqual({ digest: true, tasks: true, alerts: true, operations: true });
  });

  it('every fan-out event type belongs to a group (nothing unmutable)', () => {
    /**
     * The list used to be typed out here with a "keep in sync" comment, which
     * is a promise no test can keep: three new routed types were added and the
     * test went on passing while they were unmutable. It now reads the
     * ROUTING ITSELF — every `case 'X'` inside `buildRecipients` — so a type
     * that gains a recipient and no mute group fails here on the first run.
     * Same reasoning as the locale test (DECISIONS #163): compare against a
     * source of truth, never against a second copy of the same list.
     */
    const source = readFileSync(
      resolve(__dirname, '../../src/modules/platform/notifications/service.ts'),
      'utf8',
    );
    const routing = source.slice(
      source.indexOf('async function buildRecipients'),
      source.indexOf('export function renderTelegramText'),
    );
    const routed = [...routing.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1]!);
    // The digests are composed elsewhere and never pass through buildRecipients.
    const digests = ['DailyDigest', 'CrmFollowUps', 'CrmDormant', 'TasksDue'];

    expect(routed.length).toBeGreaterThan(8);
    const covered = new Set<string>(Object.values(MUTE_GROUPS).flat());
    for (const type of [...routed, ...digests]) expect(covered.has(type), type).toBe(true);
  });
});
