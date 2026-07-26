import { describe, expect, it } from 'vitest';
import { renderTelegramText } from '@/modules/platform/notifications/service';

/**
 * The digests shipped broken and nobody noticed for weeks: `renderTelegramText`
 * had a case for `DailyDigest` and none for `CrmFollowUps` or `CrmDormant`, so
 * both CRM digests fell through to `default` and every reader received the
 * literal string "CrmFollowUps" plus a link to `/receipts/undefined`.
 *
 * The fix is a rule, not two more cases: a payload that carries `text` IS the
 * message. These tests hold that rule for the digests that exist and for the
 * ones nobody has written yet.
 */
describe('telegram message rendering', () => {
  const digest = '📞 Bugun bog‘lanish kerak (2)\n\nGS777 · Alisher\nGS102 · Bobur';

  for (const type of ['DailyDigest', 'CrmFollowUps', 'CrmDormant', 'SomeFutureDigest']) {
    it(`${type} sends its own composed text`, () => {
      expect(renderTelegramText(type, { text: digest }, 'uz')).toBe(digest);
    });
  }

  it('never sends a link to a receipt that does not exist', () => {
    // The old default branch built `${appUrl}/receipts/${payload.receiptId}`
    // for EVERY unknown type, whether or not there was a receipt.
    const out = renderTelegramText('SomethingUnknown', {}, 'ru');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('/receipts/');
  });

  it('still renders a known event from its payload when there is no text', () => {
    const out = renderTelegramText(
      'PlanApproved',
      { batchCode: 'YW-001', batchId: 'abc' },
      'uz',
    );
    expect(out).toContain('YW-001');
    expect(out).not.toContain('undefined');
  });

  it('ignores a blank text and falls back to the case', () => {
    // An empty string must not silently become an empty Telegram message —
    // Telegram rejects those, and the row would retry until it went terminal.
    const out = renderTelegramText('PlanApproved', { text: '   ', batchCode: 'YW-002' }, 'uz');
    expect(out).toContain('YW-002');
  });
});
