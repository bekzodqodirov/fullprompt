import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «/hodim» — the way into the staff side, from any chat.
 *
 * The owner: «telegram botda hodim /hodim komandini qosh, shunday buyruq
 * berganda hodim akkountiga otsin». What is genuinely new is the chat that is
 * already a linked CLIENT: `startMenuFor` answers 'cabinet', /start RETURNS
 * inside that branch, and the «👨‍💼 Hodim» door is unreachable — that person
 * has no route into the staff side at all.
 *
 * Nothing here can be exercised without a Telegram, so what is proven is the
 * SHAPE — and the shape IS the guarantee, because the failures are all silent:
 * a branch one line lower is eaten by a collection, by a capture, by the task
 * capture (which deletes on read and would close a colleague's task with the
 * text «/hodim»), or by the `if (!staff) return next()` fence that makes
 * everything under it staff-only.
 *
 * Comments are stripped first (#725), and the scan is proven non-empty before
 * anything is asserted about it (#494).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const bot = read('src/modules/platform/telegram/bot.ts');
const handlers = read('src/modules/platform/telegram/staff-handlers.ts');

describe('the /hodim command', () => {
  it('is a real grammy command, not a label in the text ladder', () => {
    // A label would be swallowed by a live collection, by a zametka capture
    // and by `takeTaskPending`; a command is reached before all three.
    expect(bot).toContain("bot.command('hodim'");
    expect(handlers).not.toContain("'/hodim'");
  });

  it('is registered BEFORE the staff handlers — that ordering is the whole guarantee', () => {
    const cmd = bot.indexOf("bot.command('hodim'");
    const staff = bot.indexOf('registerStaffBot(bot);');
    expect(cmd, 're-anchor: the /hodim command moved').toBeGreaterThan(-1);
    expect(staff, 're-anchor: registerStaffBot moved').toBeGreaterThan(-1);
    expect(cmd).toBeLessThan(staff);
  });

  it('answers only a PRIVATE chat', () => {
    // In a group it would bind one person's notifications to a room.
    expect(bot).toContain("if (ctx.chat.type !== 'private')");
  });

  it('re-derives the keyboard and never names staffKeyboard()', () => {
    // Reply keyboards are EXCLUSIVE: naming one takes a both-chat's cabinet
    // rows off the phone, which is round 100's 13A regression.
    const at = bot.indexOf("bot.command('hodim'");
    const body = bot.slice(at, at + 1400);
    expect(body).toContain('replyKeyboardFor(chatId)');
    expect(body).not.toContain('staffKeyboard()');
  });

  it('uses the SAME door the inline «Hodim» button uses', () => {
    // One wording, one intent, one place (#513) — the button and the command
    // cannot drift apart.
    expect(bot).toContain('askStaffPhone(ctx, chatId)');
    expect(handlers).toContain('await askStaffPhone(ctx, chatId);');
    expect(handlers).toContain('export async function askStaffPhone(');
    // …and the intent the contact handler reads is minted inside it.
    const at = handlers.indexOf('export async function askStaffPhone(');
    expect(handlers.slice(at, at + 500)).toContain('noteStaffEntry(chatId)');
  });
});

describe('the contact refusals', () => {
  it('restore the keyboard the phone request wiped', () => {
    // The contact request is a ONE-TIME reply keyboard, so asking has already
    // taken the buttons away. A customer who tries /hodim out of curiosity
    // would otherwise be left with no keyboard and a sentence.
    expect(handlers).toContain('const restore = async (text: string) => {');
    const at = handlers.indexOf("bot.on('message:contact'");
    const body = handlers.slice(at, at + 2600);
    expect(body).toContain("await restore('Faqat o‘zingizning raqamingizni yuboring.');");
    expect(body).toContain("await restore('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');");
  });
});

describe('the profile re-connect', () => {
  const actions = read('src/modules/platform/telegram/staff-bot.ts');

  it('mints a code WITHOUT touching a live link', () => {
    // Flipping a linked row to 'pending' is a notification outage: every
    // reader demands status='linked', the drain settles queued rows terminally
    // `muted`, and `muted` is excluded from notificationProblemCount — so
    // nothing on any screen would ever say it happened.
    expect(actions).toContain("if (existing?.status === 'linked') {");
    const at = actions.indexOf("if (existing?.status === 'linked') {");
    // The live-link branch alone, which returns early: the insert below it
    // legitimately writes a 'pending' row for somebody who has never linked.
    const end = actions.indexOf('return code;', at);
    expect(end, 're-anchor: the live-link branch no longer returns early').toBeGreaterThan(at);
    const body = actions.slice(at, end);
    expect(body).toContain('.set({ linkCode: code })');
    expect(body).not.toContain("status: 'pending'");
    expect(body).not.toContain('telegramChatId');
  });

  it('the action goes through the one writer, so the rule cannot be re-implemented', () => {
    const door = read('src/modules/platform/telegram/actions.ts');
    expect(door).toContain('await mintTelegramLinkCode(actor.id)');
    expect(door).not.toContain('randomBytes');
  });

  it('is offered on the screen when the link is already live', () => {
    const page = read('src/app/(protected)/profile/page.tsx');
    expect(page).toContain('data-testid="profile-telegram-reconnect"');
    expect(page).toContain("t('telegramReconnectHint')");
  });
});
