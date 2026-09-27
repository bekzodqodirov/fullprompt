import { describe, expect, it } from 'vitest';
import {
  boldsTitle,
  capStaffText,
  composeStaffHtml,
  CUT_MARK,
  keyboardOf,
  STAFF_TEXT_CAP,
  staffTextHtml,
  takeOwnLink,
  urlRowsOf,
  withoutCallback,
} from '@/modules/platform/notifications/staff-html';
import { htmlToPlain, visibleLength } from '@/modules/platform/telegram/format';

/**
 * A staff message as it reaches Telegram (round C): the stored plain text,
 * dressed at the moment of sending. Pure, so every rule is proven here and
 * the drain's own test only has to show it is wired.
 */

const APP = 'https://gsrwms.uz';

describe('the title', () => {
  it('bolds a short first line that has a body under it', () => {
    expect(boldsTitle('TaskAssigned', '🆕 Yangi vazifa: X\n📅 01.01')).toBe(true);
    expect(staffTextHtml('🆕 Yangi vazifa: X\n📅 01.01', 'TaskAssigned')).toBe(
      '<b>🆕 Yangi vazifa: X</b>\n📅 01.01',
    );
  });

  it('never a one-line message, a sentence-long first line, or an empty body', () => {
    expect(boldsTitle('X', 'Just one line')).toBe(false);
    expect(boldsTitle('X', `${'a'.repeat(81)}\nbody`)).toBe(false);
    expect(boldsTitle('X', 'Title\n   \n')).toBe(false);
  });

  it('never on an offer — its first line is the CUSTOMER, forwarded to the customer', () => {
    expect(boldsTitle('CalcOffer', 'Aziz aka\nNarx: $100')).toBe(false);
    expect(composeStaffHtml('CalcOffer', 'Aziz aka\nNarx: $100', { openLabel: 'o' }).html).toBe(
      'Aziz aka\nNarx: $100',
    );
  });

  it('escapes everything that was typed — the only markup is the one pair it adds', () => {
    const html = staffTextHtml('Ruxsat: <a href="x">A & B</a>\nIzoh: 5 < 7', 'X');
    expect(html).toBe('<b>Ruxsat: &lt;a href="x"&gt;A &amp; B&lt;/a&gt;</b>\nIzoh: 5 &lt; 7');
    expect(htmlToPlain(html)).toBe('Ruxsat: <a href="x">A & B</a>\nIzoh: 5 < 7');
  });
});

describe('the cap', () => {
  it('cuts past the cap and SAYS so, instead of Telegram refusing the whole message', () => {
    const long = 'x'.repeat(5000);
    const capped = capStaffText(long);
    expect(capped.endsWith(`\n${CUT_MARK}`)).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(STAFF_TEXT_CAP + CUT_MARK.length + 1);
    expect(visibleLength(staffTextHtml(long))).toBeLessThan(4096);
  });

  it('leaves a text under the cap alone', () => {
    expect(capStaffText('short')).toBe('short');
  });

  it('never cuts an emoji in half', () => {
    const text = `${'a'.repeat(STAFF_TEXT_CAP - 1)}📦 and more after it`;
    const capped = capStaffText(text);
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('our own link becomes a button', () => {
  it('lifts the last line when it is this app, in each shape the texts write it', () => {
    for (const line of [
      `${APP}/bitimlar/1`,
      `🔗 ${APP}/bitimlar/1`,
      `Karta: ${APP}/bitimlar/1`,
    ]) {
      expect(takeOwnLink(`Title\nbody\n\n${line}`, APP), line).toEqual({
        text: 'Title\nbody',
        url: `${APP}/bitimlar/1`,
      });
    }
  });

  it('keeps a FOREIGN link in the sentence — it is content somebody typed', () => {
    const text = 'Title\nhttps://example.com/x';
    expect(takeOwnLink(text, APP)).toEqual({ text, url: null });
  });

  it('moves nothing when APP_URL is not https (CI) — Telegram refuses such a button', () => {
    const text = 'Title\nhttp://localhost:3000/bitimlar/1';
    expect(takeOwnLink(text, 'http://localhost:3000')).toEqual({ text, url: null });
    expect(takeOwnLink('Title\nhttps://gsrwms.uz/x', '')).toEqual({ text: 'Title\nhttps://gsrwms.uz/x', url: null });
  });

  it('only the LAST line, and only a line that is the link and nothing else', () => {
    expect(takeOwnLink(`Title\n${APP}/x\ntail`, APP).url).toBeNull();
    expect(takeOwnLink(`Title\nsee ${APP}/x`, APP).url).toBeNull();
  });

  it('a message that is ONLY the link keeps it — an empty text is refused', () => {
    expect(takeOwnLink(`${APP}/x`, APP)).toEqual({ text: `${APP}/x`, url: null });
  });

  it('composes the button in the given words, after the rest of the message', () => {
    const msg = composeStaffHtml('X', `Title\nbody\n${APP}/approvals`, { appUrl: APP, openLabel: '↗️ Ochish' });
    expect(msg.html).toBe('<b>Title</b>\nbody');
    expect(msg.urlRow).toEqual([{ text: '↗️ Ochish', url: `${APP}/approvals` }]);
  });
});

describe('the keyboard an edit keeps', () => {
  const markup = {
    inline_keyboard: [
      [{ text: '✅ Bajarildi', callback_data: 't:1' }],
      [{ text: '✅ A', callback_data: 'tb:a' }],
      [{ text: '↗️ Ochish', url: `${APP}/x` }],
    ],
  };

  it('keeps the link rows and only them — an edit never leaves less to open', () => {
    expect(urlRowsOf(markup)).toEqual([[{ text: '↗️ Ochish', url: `${APP}/x` }]]);
    expect(urlRowsOf(undefined)).toEqual([]);
  });

  it('a list loses exactly the pressed row', () => {
    expect(withoutCallback(markup, 'tb:a')).toEqual([markup.inline_keyboard[0], markup.inline_keyboard[2]]);
  });

  it('an empty keyboard is no keyboard (Telegram refuses one)', () => {
    expect(keyboardOf([])).toBeUndefined();
    expect(keyboardOf(null)).toBeUndefined();
    expect(keyboardOf([[{ text: 'a', url: 'https://x' }]])).toEqual({ inline_keyboard: [[{ text: 'a', url: 'https://x' }]] });
  });
});
