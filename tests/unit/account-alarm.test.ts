import { Api, helpers } from 'telegram';
import { describe, expect, it } from 'vitest';
import { agentOffAlarmText, pausedAlarmText, sessionDeadOthersText } from '@/modules/wms/crm/account-alarm';
import { isTelegramServiceNotice, TELEGRAM_SERVICE_PEER, telegramNoticeKind } from '@/modules/wms/agent/listener-hooks';
import { wasAutoSent } from '@/modules/wms/crm/message-flags';

/**
 * The words the listener's alarms carry, and how it tells a customer's own
 * robot from the customer — both decided without a network.
 */

describe('the customer’s own robot (ban-4)', () => {
  const base = { id: 9, peerId: new Api.PeerUser({ userId: helpers.returnBigInt('5') }), date: 1, message: 'Hozir band' };
  // gramjs's TL constructor takes both fields (layer 198) though its typings name neither.
  const withFlags = (extra: Record<string, unknown>) =>
    new Api.Message({ ...base, ...extra } as ConstructorParameters<typeof Api.Message>[0]);

  it('a Business away / greeting message is flagged by `offline`', () => {
    const msg = withFlags({ offline: true });
    expect((msg as unknown as { offline: unknown }).offline, 'the TL object keeps the field').toBe(true);
    expect(wasAutoSent(msg)).toBe(true);
  });

  it('an answer from the customer’s business bot is flagged by `viaBusinessBotId`', () => {
    expect(wasAutoSent(withFlags({ viaBusinessBotId: helpers.returnBigInt('77') }))).toBe(true);
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
    for (const reason of ['flood_repeat', 'blocks', 'telegram_notice'] as const) {
      const text = agentOffAlarmText({ managerName: 'Bekzod', reason });
      expect(text).toContain('Bekzod');
      expect(text).toContain('«Suhbatlar → AI»');
    }
  });

  it('Telegram’s own notice is named by whose it is and where to read it — never quoted (K33)', () => {
    const text = agentOffAlarmText({ managerName: 'Bekzod', reason: 'telegram_notice' });
    expect(text).toContain('777000');
    // Where to read it — the alarm itself carries none of the notice, which may be a login code.
    expect(text).toContain('Telegram ilovasida');
  });

  it('a colleague’s copy of the session alarm names the manager, not «you»', () => {
    const text = sessionDeadOthersText({ managerName: 'Siroj', reason: 'SESSION_REVOKED' });
    expect(text).toContain('Siroj');
    expect(text).toContain('SESSION_REVOKED');
    expect(text).not.toContain('seansingiz');
  });
});

describe('Telegram’s own service account (his ⭐2, final review K33)', () => {
  const service = { id: TELEGRAM_SERVICE_PEER, isPrivate: true, isSelf: false };

  it('is its own inbound line in its private chat', () => {
    expect(TELEGRAM_SERVICE_PEER).toBe(777000n);
    expect(isTelegramServiceNotice(service, false)).toBe(true);
  });

  it('is never a line of his, his Saved Messages, a group or channel with the same id, or a customer', () => {
    expect(isTelegramServiceNotice(service, true)).toBe(false);
    expect(isTelegramServiceNotice({ ...service, isSelf: true }, false)).toBe(false);
    expect(isTelegramServiceNotice({ ...service, isPrivate: false }, false)).toBe(false);
    expect(isTelegramServiceNotice({ ...service, id: 777001n }, false)).toBe(false);
  });
});

describe('what a line from 777000 is (K33’s follow-up)', () => {
  // Telegram's own wording, as its apps show it (en, ru). The digits and the address are made up.
  const LOGIN_EN =
    'Login code: 52814. Do not give this code to anyone, even if they say they are from Telegram!\n\n' +
    '❗️This code can be used to log in to your Telegram account. We never ask it for anything else.\n\n' +
    "If you didn't request this code by trying to log in on another device, simply ignore this message.";
  const LOGIN_RU =
    'Код для входа в Telegram: 52814. Не давайте код никому, даже если его требуют от имени Telegram!\n\n' +
    '❗️Этот код используется для входа в Ваш аккаунт в Telegram. Он никогда не нужен для чего-то ещё.';
  const NEW_LOGIN_EN =
    'New login. Dear Bekzod, we detected a login into your account from a new device on 24/10/2026 at 03:10:12 UTC.\n\n' +
    'Device: Telegram Desktop, 5.6.3, Windows 10\nLocation: Tashkent, Uzbekistan (IP = 213.230.80.11)\n\n' +
    'If this wasn\'t you, you can terminate that session in Settings > Devices.';
  const NEW_LOGIN_RU =
    'Новый вход в аккаунт. Bekzod, мы обнаружили вход в Ваш аккаунт с нового устройства 24/10/2026 в 03:10:12 UTC.\n\n' +
    'Устройство: Telegram Desktop, 5.6.3, Windows 10\nМестоположение: Ташкент, Узбекистан (IP = 2a03:2880:f12c::1)';

  it('his own login traffic is login: the code, in any language, and the «new login» alert', () => {
    for (const text of [LOGIN_EN, LOGIN_RU, NEW_LOGIN_EN, NEW_LOGIN_RU]) expect(telegramNoticeKind(text), text).toBe('login');
  });

  it('anything else is a notice — the shape guesses toward «off», never toward «keep talking»', () => {
    for (const text of [
      '',
      'Your account was limited for violating the Telegram Terms of Service (section 1.5). Until 25.10.2026 you can only…',
      'Hisobingiz cheklandi. Murojaat raqami: 2026\nBatafsil: telegram.org/faq_spam',
      // A number of a code's size, but not the first line's: a notice quoting one is still a notice.
      'Important: your account was used in an unofficial app.\nTicket: 52814.',
      // Seven digits are no login code, an IP without Telegram's «(IP = …)» is no login alert.
      'Appeal number: 1234567.',
      'We detected suspicious activity from IP 213.230.80.11 using a third-party app.',
    ]) {
      expect(telegramNoticeKind(text), text).toBe('notice');
    }
  });
});
