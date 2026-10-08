import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/platform/telegram/redelivery-ready', () => ({ redeliveryReady: async () => true }));

import { messageKey, onceKey, pressKey, type OnceEffect } from '@/modules/platform/telegram/once';

/**
 * The claim keys (0130, Q5 a): the Telegram identity of the MESSAGE — never
 * of the update, never of the callback query — so a redelivery and every
 * repeat tap share one key. The table's own CHECK is read out of the
 * migration, so a constructor and the database cannot drift apart.
 */
const EFFECTS: OnceEffect[] = [
  'ask',
  'answer',
  'reschedule',
  'sources',
  'search',
  'client_forward',
  'link_alert',
  'wait',
  'staff_link',
];

const MIGRATION = readFileSync('src/modules/platform/db/migrations/0130_bot_redelivery.sql', 'utf8');
const CHECK = /"key" ~ '([^']+)'/.exec(MIGRATION)?.[1];

describe('once keys', () => {
  it('a message key and a press key, spelled as the table expects', () => {
    expect(onceKey.message(-100123, 7, 'ask')).toBe('m:-100123:7:ask');
    expect(onceKey.press(-100123, 9, 'search')).toBe('q:-100123:9:search');
  });

  it('every effect, both ways, passes the CHECK read out of 0130', () => {
    expect(CHECK, 're-anchor: the key CHECK moved').toBeDefined();
    const pattern = new RegExp(CHECK!);
    for (const effect of EFFECTS) {
      expect(onceKey.message(97_123_456_701, 12, effect)).toMatch(pattern);
      expect(onceKey.press(-1001234567890, 34, effect)).toMatch(pattern);
    }
  });

  it('a ctx with no message mints no key — never one keyed on a 0 id', async () => {
    expect(await messageKey({ chat: { id: 5 } }, 'ask')).toBeNull();
    expect(await pressKey({ chat: { id: 5 }, callbackQuery: { from: { id: 5 } } }, 'search')).toBeNull();
    expect(await messageKey({ chat: { id: 5 }, message: { message_id: 3 } }, 'wait')).toBe('m:5:3:wait');
    expect(await pressKey({ callbackQuery: { from: { id: 6 }, message: { message_id: 4 } } }, 'sources')).toBe('q:6:4:sources');
  });
});
