import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';

/**
 * The client conversation's wiring (round C) — the rules a grammy shell cannot
 * be driven to prove, because this container has no Telegram. Each one's
 * breach is SILENT: every screen renders and every other test stays green
 * while a button spins for fifteen seconds, a customer's words are eaten by a
 * catch-all that ran too early, or one message with a stray `<` is refused
 * whole by Telegram.
 *
 * Comments are stripped first (#725), and every anchor is proven present
 * before anything is asserted about its position (#494).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const cabinet = read('src/modules/platform/telegram/client-cabinet.ts');
const bot = read('src/modules/platform/telegram/bot.ts');

describe('the order of the cabinet’s handlers', () => {
  it('the customer’s-own-words handlers are registered LAST', () => {
    // Registered before a label's `bot.hears`, the catch-all would forward
    // «📦 Yuklarim» to a manager instead of answering it; before a callback, a
    // photo tap would be somebody's «fayl». Last is the only safe place.
    const text = cabinet.indexOf("bot.on('message:text'");
    const media = cabinet.indexOf("'message:photo'");
    expect(text, 're-anchor: the text forward moved').toBeGreaterThan(-1);
    expect(media, 're-anchor: the media forward moved').toBeGreaterThan(-1);
    for (const earlier of ['bot.hears(', 'bot.callbackQuery(', "bot.on('message:contact'", 'bot.use(']) {
      const last = cabinet.lastIndexOf(earlier);
      expect(last, earlier).toBeGreaterThan(-1);
      expect(last, earlier).toBeLessThan(text);
      expect(last, earlier).toBeLessThan(media);
    }
  });

  it('a label or a command is never forwarded as words', () => {
    const at = cabinet.indexOf("bot.on('message:text'");
    const body = cabinet.slice(at, at + 700);
    expect(body).toContain("text.trim().startsWith('/') || isCabinetText(text)");
    expect(body).toContain("if (ctx.chat.type !== 'private') return next();");
  });
});

describe('the manager door under every push (contract 1)', () => {
  it('is the cabinet’s, not the staff parser’s — `mg` must fall through to it', () => {
    expect(parseCallback('mg')).toBeNull();
    expect(cabinet).toContain("bot.callbackQuery('mg', async (ctx) => {");
  });

  it('is ALWAYS answered, before anything that can fail or wait', () => {
    const at = cabinet.indexOf("bot.callbackQuery('mg'");
    const body = cabinet.slice(at, at + 400);
    const answer = body.indexOf('await ctx.answerCallbackQuery();');
    expect(answer, 'the mg handler never answers — the button would spin').toBeGreaterThan(-1);
    // The FIRST await in the handler is the answer: a read that throws first
    // would leave the button spinning with no error anywhere.
    expect(body.indexOf('await ')).toBe(answer);
    // The codes come from the CHAT, never from the button (#273).
    expect(body).toContain('clientsForChat(BigInt(chatId))');
  });
});

describe('the one sender', () => {
  it('no reply in the client conversation carries a parse mode — HTML goes through sendText', () => {
    // `ctx.reply(html, { parse_mode })` has no plain fallback: one unescaped
    // `<` in a goods name and Telegram refuses the WHOLE answer (HTML-1).
    for (const [name, src] of [['client-cabinet.ts', cabinet], ['bot.ts', bot]] as const) {
      expect(src, name).not.toContain('parse_mode');
    }
  });

  it('the cabinet makes no raw Bot-API call of its own', () => {
    // The code-added notice and the staff warnings were raw fetches with no
    // deadline, awaited on the poller; everything goes through send.ts now.
    expect(cabinet).not.toMatch(/\bfetch\(/);
    expect(cabinet).not.toContain('api.telegram.org');
    expect(cabinet).not.toContain('replyWithMediaGroup');
    expect(cabinet).not.toContain('replyWithPhoto');
  });

  it('the 📷 answer is dispatched off the poller, and a second tap starts nothing', () => {
    const at = cabinet.indexOf('bot.callbackQuery(/^ph:(.+)$/');
    expect(at, 're-anchor: the photo handler moved').toBeGreaterThan(-1);
    const body = cabinet.slice(at, at + 1000);
    const answer = body.indexOf('await ctx.answerCallbackQuery({ text: clientLabels(locale).photoSending });');
    const guard = body.indexOf('photoInFlight.has(chatId)');
    const claim = body.indexOf('photoInFlight.add(chatId)');
    const send = body.indexOf("dispatch('photos'");
    expect(answer).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(answer);
    expect(claim).toBeGreaterThan(guard);
    expect(send).toBeGreaterThan(claim);
    expect(body).toContain('.finally(() => photoInFlight.delete(chatId))');
  });
});

describe('the stragglers', () => {
  it('no staff warning or link reply is left in Russian, and the unknown chat is asked in its own language', () => {
    for (const [name, src] of [['client-cabinet.ts', cabinet], ['bot.ts', bot]] as const) {
      for (const phrase of ['Кабинет:', 'подключён', 'Уведомления будут', 'Кто вы']) {
        expect(src.includes(phrase), `${name}: ${phrase}`).toBe(false);
      }
    }
    expect(bot).toContain('entryKeyboard(tg)');
    expect(bot).toContain('t.entryQuestion');
    expect(cabinet).toContain("type: 'CabinetLinkAlert'");
  });

  it('every raw Telegram language tag is normalised before it picks a dictionary', () => {
    // `clientLabels('en-GB')` falls back to Russian; `localeFromTelegram`
    // reads the primary subtag.
    for (const [name, src] of [['client-cabinet.ts', cabinet], ['bot.ts', bot]] as const) {
      const raw = [...src.matchAll(/language_code/g)].length;
      const normalised = [...src.matchAll(/localeFromTelegram\(ctx\.from\?\.language_code\)/g)].length;
      expect(normalised, name).toBe(raw);
    }
  });
});
