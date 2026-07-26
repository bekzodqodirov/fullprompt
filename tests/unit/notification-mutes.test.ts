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
    // The types buildRecipients/digest can emit — keep in sync with service.ts.
    const emitted = [
      'ReceiptConfirmed',
      'UnknownCargoReceived',
      'ReadyForPickup',
      'BoxIssued',
      'PlanApproved',
      'PlanChangesRequested',
      'UndocumentedTransfer',
      'MissingInTransit',
      'InventoryCompleted',
      'BoxScannedOnLoad',
      'DailyDigest',
      'CrmFollowUps',
      'CrmDormant',
      'TasksDue',
    ];
    const covered = new Set<string>(Object.values(MUTE_GROUPS).flat());
    for (const type of emitted) expect(covered.has(type), type).toBe(true);
  });
});
