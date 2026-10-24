/**
 * What every Telegram session this system opens says it is (review ban-12).
 *
 * gramjs fills the three fields from the machine when they are left out —
 * `os.type()` and `os.release()` — so the same person's session announced
 * itself as «Linux 6.18.44-fc-v153 · 1.0» from one container and as a
 * different kernel after the next VPS move: a device that changes its name
 * on every deploy, in the «Active sessions» list the manager reads and in
 * whatever Telegram itself keeps about the authorisation. One honest,
 * constant name instead, the same from the listener, the «ulash» screen and
 * the one-off scripts.
 *
 * Zero imports, so a script can take it without pulling anything else in.
 * `tests/unit/telegram-device.test.ts` finds every `new TelegramClient(` in
 * src/ and scripts/ and refuses one that does not spread it.
 */
export const TELEGRAM_DEVICE = {
  deviceModel: 'GSR CRM',
  systemVersion: 'Linux',
  appVersion: '1.0',
} as const;
