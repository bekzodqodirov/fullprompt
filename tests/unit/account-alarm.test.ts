import { Api, helpers } from 'telegram';
import { describe, expect, it } from 'vitest';
import { agentOffAlarmText, pausedAlarmText, sessionDeadOthersText } from '@/modules/wms/crm/account-alarm';
import { wasAutoSent } from '@/modules/wms/crm/message-flags';

/**
 * The words the listener's alarms carry, and how it tells a customer's own
 * robot from the customer — both decided without a network.
 */

describe('the customer’s own robot (ban-4)', () => {
  const base = { id: 9, peerId: new Api.PeerUser({ userId: helpers.returnBigInt('5') }), date: 1, message: 'Hozir band' };

  it('a Business away / greeting message is flagged by `offline`', () => {
    expect(wasAutoSent(new Api.Message({ ...base, offline: true }))).toBe(true);
  });

  it('an answer from the customer’s business bot is flagged by `viaBusinessBotId`', () => {
    expect(wasAutoSent(new Api.Message({ ...base, viaBusinessBotId: helpers.returnBigInt('77') }))).toBe(true);
  });

  it('a person’s ordinary message is not — gramjs fills the unset flag fields with null or false', () => {
    expect(wasAutoSent(new Api.Message(base))).toBe(false);
    // As read off the wire, an unset optional field is null and an unset `true` flag is false.
    expect(wasAutoSent({ offline: false, viaBusinessBotId: null })).toBe(false);
    expect(wasAutoSent(null)).toBe(false);
  });
});

describe('the alarms', () => {
  it('a restriction names whose account, what Telegram said, and the button to press', () => {
    const text = pausedAlarmText({ managerName: 'Siroj', pause: 'peer_flood', code: 'PEER_FLOOD', agentOff: true });
    expect(text).toContain('Siroj');
    expect(text).toContain('PEER_FLOOD');
    expect(text).toContain('«Suhbatlar»');
    expect(text).toContain('«Tekshirdim»');
    expect(text).toContain('AI sotuvchi ham o‘chirildi');
    expect(pausedAlarmText({ managerName: 'Siroj', pause: 'frozen', code: 'FROZEN_', agentOff: false })).not.toContain('AI');
  });

  it('the machine’s own «off» says why and where it is switched back on', () => {
    for (const reason of ['flood_repeat', 'blocks'] as const) {
      const text = agentOffAlarmText({ managerName: 'Bekzod', reason });
      expect(text).toContain('Bekzod');
      expect(text).toContain('«Suhbatlar → AI»');
    }
  });

  it('a colleague’s copy of the session alarm names the manager, not «you»', () => {
    const text = sessionDeadOthersText({ managerName: 'Siroj', reason: 'SESSION_REVOKED' });
    expect(text).toContain('Siroj');
    expect(text).toContain('SESSION_REVOKED');
    expect(text).not.toContain('seansingiz');
  });
});
