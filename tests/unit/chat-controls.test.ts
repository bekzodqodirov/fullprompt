import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Where a destructive control may NOT live (round 51).
 *
 * The owner: «chatni qo'shmaslik feature … hozir input fieldni pastida
 * turibti, uni boshqa yozishga halaqit qilmaydigan, oson bosilib ketmaydigan
 * joyga olish kerak». «Stop taking this chat» sat directly under the compose
 * box — a thumb's width from «Send», on the strip of screen a phone keyboard
 * shoves about, and since round 25 the action DELETES every stored message
 * and photo from that conversation.
 *
 * A source-shape test, like the style-cascade and i18n tripwires, and for the
 * same reason: what went wrong here cannot be seen from any assertion about
 * behaviour. Both components work perfectly. The defect was that one was
 * within a thumb of the other, and the only durable way to state that is
 * "these two files must not meet".
 */

const read = (path: string) => readFileSync(path, 'utf8');

describe('the compose box has nothing dangerous beside it', () => {
  it('does not carry the «stop taking this chat» control', () => {
    for (const file of [
      'src/components/telegram-reply.tsx',
      'src/components/telegram-reply-box.tsx',
      'src/components/dock.tsx',
    ]) {
      expect(read(file), file).not.toContain('TelegramStopTaking');
      expect(read(file), file).not.toContain('excludeChatAction');
    }
  });

  it('and the control still exists, folded, somewhere a person has to mean it', () => {
    const menu = read('src/components/chat-menu.tsx');
    expect(menu).toContain('TelegramStopTaking');
    // Behind a fold: reaching it is open-the-menu, press, confirm — three
    // deliberate acts, none of them next to the keyboard.
    expect(menu).toContain('<details');
    // And only on a conversation that is the actor's own, the same rule that
    // decides whether they may speak in it at all.
    expect(menu).toContain('replyAccountFor');
  });

  it('is reached from the thread header, not from the bottom of the screen', () => {
    const thread = read('src/app/(protected)/suhbatlar/[clientId]/page.tsx');
    const menuAt = thread.indexOf('<ChatMenu');
    const composerAt = thread.indexOf('<TelegramReply');
    expect(menuAt, 'the ⋯ menu must be on the page').toBeGreaterThan(-1);
    expect(composerAt, 'the composer must be on the page').toBeGreaterThan(-1);
    // Above the thread in the DOM, which on this screen is the header.
    expect(menuAt).toBeLessThan(composerAt);
  });
});
