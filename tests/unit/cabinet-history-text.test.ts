import { describe, expect, it } from 'vitest';
import { formatDay } from '@/modules/platform/telegram/client-labels';
import { chunkBlocks } from '@/modules/platform/telegram/client-cabinet';

/**
 * The bot's «Tarix» answer (F): three months of handovers can exceed one
 * Telegram message. Cutting at 4000 characters used to drop the oldest ones
 * without a word; the blocks are now packed into as many messages as needed,
 * and none is ever split in the middle.
 */
describe('the bot history answer', () => {
  it('packs blocks into messages under the limit, never splitting one', () => {
    const blocks = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)];
    const out = chunkBlocks(blocks, 70);
    expect(out).toEqual([`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 'c'.repeat(30)]);
    expect(out.every((m) => m.length <= 70)).toBe(true);
    expect(out.join('\n\n')).toBe(blocks.join('\n\n'));
  });

  it('dates carry the year and are Tashkent days — a history crosses New Year', () => {
    expect(formatDay('2026-12-31T20:30:00Z')).toBe('01.01.2027');
    expect(formatDay('2030-08-20T06:00:00Z')).toBe('20.08.2030');
  });
});
