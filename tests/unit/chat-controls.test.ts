import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Rules about the chat surfaces that no test of behaviour can see.
 *
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

/**
 * One resolver for «which client holds this chat» (round 51).
 *
 * A person routinely holds several GS codes on one phone number, and the
 * import pinned each conversation to whichever code the phone matched — so a
 * deal on the sibling code has its chat filed elsewhere. Round 32 taught the
 * card panel to look there (`threadClientFor`). The dock was never taught,
 * and the result was one card telling a manager two different stories: the
 * panel showing the conversation, the dock saying «no chat» and refusing to
 * let them answer it. Found by an adversarial sweep of the send path, not by
 * a report — nothing about it is loud enough to be reported.
 *
 * Source-shape again, for the same reason as above: both surfaces worked.
 * What was wrong is that they disagreed.
 */
describe('every chat surface asks the same question about which client', () => {
  it('the card panel and the dock route both resolve the phone sibling', () => {
    for (const file of [
      'src/components/telegram-thread.tsx',
      'src/app/api/dock/thread/route.ts',
    ]) {
      expect(read(file), file).toContain('threadClientFor');
    }
  });

  it('and the dock composes against the id the server resolved', () => {
    const dock = read('src/components/dock.tsx');
    // Not the raw `data-dock-client` marker the card put on the page: that is
    // the code the CARD is about, which may not be the code the chat is on.
    expect(dock).toContain('thread?.client.id');
    expect(dock).not.toMatch(/form\.set\('clientId', threadFor\)/);
  });
});
