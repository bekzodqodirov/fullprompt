import { describe, expect, it } from 'vitest';
import { FORCED_OFF_REASONS } from '@/modules/wms/agent/forced-off';
import { offReminderSlot, offReminderText } from '@/modules/wms/agent/off-reminder';

/**
 * His 18 a's grid, pure: 08:40 Tashkent (the morning line's minute) and every two hours after it while the office day
 * lasts (`isOfficeTime` — the house's one clock for a push a person acts on), never at night. Literal clocks only.
 */

const T = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:00`);

describe('the reminder’s slots', () => {
  it('a day holds exactly seven: 08:40, 10:40, … 20:40', () => {
    const keys = new Set<string>();
    for (let at = T('2026-11-17', '00:00').getTime(); at < T('2026-11-18', '00:00').getTime(); at += 60_000) {
      const slot = offReminderSlot(new Date(at));
      if (slot) keys.add(slot.key);
    }
    expect([...keys]).toEqual(
      ['0840', '1040', '1240', '1440', '1640', '1840', '2040'].map((hm) => `agent:forced_off:2026-11-17:${hm}`),
    );
  });

  it('a slot begins at its minute and stays current until the next one', () => {
    expect(offReminderSlot(T('2026-11-17', '08:39'))).toBeNull();
    expect(offReminderSlot(T('2026-11-17', '08:40'))).toEqual({ key: 'agent:forced_off:2026-11-17:0840', startsAt: T('2026-11-17', '08:40') });
    expect(offReminderSlot(T('2026-11-17', '10:39'))?.key).toBe('agent:forced_off:2026-11-17:0840');
    expect(offReminderSlot(T('2026-11-17', '10:40'))?.startsAt).toEqual(T('2026-11-17', '10:40'));
    expect(offReminderSlot(T('2026-11-17', '21:59'))?.key).toBe('agent:forced_off:2026-11-17:2040');
  });

  it('nothing at night: from 22:00 to the next 08:40', () => {
    for (const hm of ['22:00', '23:59', '00:00', '05:30', '07:59', '08:00']) expect(offReminderSlot(T('2026-11-17', hm)), hm).toBeNull();
  });

  it('the day is Tashkent’s: 23:00 UTC is already the next morning’s night, 03:40 UTC its 08:40', () => {
    expect(offReminderSlot(new Date('2026-11-17T23:00:00Z'))).toBeNull();
    expect(offReminderSlot(new Date('2026-11-18T03:40:00Z'))?.key).toBe('agent:forced_off:2026-11-18:0840');
  });
});

describe('the reminder’s words', () => {
  const at = T('2026-11-19', '12:16');

  it('his sentence, the reason in the alarm’s own words, since when, and the count', () => {
    expect(offReminderText({ reason: 'telegram_notice', at, waiting: 3 }, false)).toBe(
      '⚠️ AI sotuvchi o‘chiq turibdi — sabab: Telegramning o‘z xizmat akkaunti (777000) bu akkauntga xabar yubordi — uni Telegram ilovasida o‘qing, 19.11 12:16 dan beri.\nJavobsiz mijozlar: 3.',
    );
  });

  it('«Qayta yoqish» and the page only for a reader the page admits', () => {
    const lines = offReminderText({ reason: 'flood_repeat', at, waiting: 0 }, true).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('Qayta yoqish: «Suhbatlar → AI sotuvchi».');
    expect(lines[3]).toMatch(/\/suhbatlar\/ai$/u);
  });

  it('every forced reason is worded — never a code', () => {
    for (const reason of FORCED_OFF_REASONS) {
      const text = offReminderText({ reason, at, waiting: 0 }, false);
      expect(text, reason).not.toContain(reason);
      expect(text, reason).toMatch(/sabab: \S.{10,}, 19\.11 12:16 dan beri\./u);
    }
  });
});
