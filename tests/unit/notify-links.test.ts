import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardLink, entityHref, taskLink } from '@/modules/platform/notifications/links';

/**
 * The deep links Telegram messages carry.
 *
 * A wrong link here is worse than none: a notification that opens the wrong
 * screen teaches people the links are decorative, and then the right ones go
 * unclicked too.
 */

const OLD = process.env.APP_URL;
beforeEach(() => {
  process.env.APP_URL = 'https://gsrwms.uz/';
});
afterEach(() => {
  process.env.APP_URL = OLD;
});

describe('where a card lives', () => {
  it('knows every entity a task can point at', () => {
    expect(entityHref('client', 'abc')).toBe('/admin/clients/abc');
    expect(entityHref('lead', 'abc')).toBe('/crm/leads/abc');
    expect(entityHref('deal', 'abc')).toBe('/bitimlar/abc');
    expect(entityHref('receipt', 'abc')).toBe('/receipts/abc');
    expect(entityHref('batch', 'abc')).toBe('/batches/abc');
  });

  it('answers null for what it does not know, never a guessed path', () => {
    expect(entityHref('unicorn', 'abc')).toBeNull();
    expect(entityHref(null, 'abc')).toBeNull();
    expect(entityHref('client', null)).toBeNull();
  });
});

describe('the links messages carry', () => {
  it('is absolute and does not double the slash', () => {
    // APP_URL is typed by a person into .env; a trailing slash is the normal
    // way to type it, and //bitimlar is the normal way links then break.
    expect(cardLink('deal', 'x')).toBe('https://gsrwms.uz/bitimlar/x');
  });

  it('falls back to «Mening kunim» for a task about nothing in particular', () => {
    expect(taskLink(null, null)).toBe('https://gsrwms.uz/bugun');
    expect(taskLink('deal', 'x')).toBe('https://gsrwms.uz/bitimlar/x');
  });
});
