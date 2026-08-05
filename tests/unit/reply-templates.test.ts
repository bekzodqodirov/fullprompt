import { describe, expect, it } from 'vitest';
import { fillTemplate, templateSchema } from '@/modules/wms/crm/templates';

/**
 * The placeholders, on their own.
 *
 * Everything the composer shows a manager passes through this function, and
 * the one thing it must never do is quietly delete part of a sentence on its
 * way to a customer.
 */
describe('fillTemplate', () => {
  it('fills the two placeholders it knows', () => {
    expect(fillTemplate('Hurmatli {ism}, {kod} yukingiz keldi', { ism: 'Aziz', kod: 'GS007' })).toBe(
      'Hurmatli Aziz, GS007 yukingiz keldi',
    );
  });

  it('fills every occurrence, not just the first', () => {
    expect(fillTemplate('{kod} — {kod}', { kod: 'GS1' })).toBe('GS1 — GS1');
  });

  it('leaves braces it was never taught alone', () => {
    // Somebody's braces are somebody's text. Blanking `{summa}` would hand the
    // customer a sentence with a hole in it and nothing to say why.
    expect(fillTemplate('{summa} so‘m, {ism}', { ism: 'Aziz' })).toBe('{summa} so‘m, Aziz');
  });

  it('leaves a placeholder the caller said nothing about alone', () => {
    // Not the same as an empty value: «I have no name for this client» is an
    // answer, «I was not asked about names» is silence, and silence must not
    // quietly delete a word out of the middle of a message.
    expect(fillTemplate('Salom {ism}, {kod}', { kod: 'GS1' })).toBe('Salom {ism}, GS1');
  });

  it('blanks a placeholder whose value is empty', () => {
    // A client with no name on file: better a short greeting than «{ism}»
    // arriving in the customer's Telegram.
    expect(fillTemplate('Salom {ism}!', { ism: '', kod: '' })).toBe('Salom !');
  });

  it('touches nothing when there is no placeholder', () => {
    expect(fillTemplate('Rahmat!', { ism: 'Aziz', kod: 'GS1' })).toBe('Rahmat!');
  });
});

describe('templateSchema', () => {
  it('refuses an empty title or body', () => {
    expect(templateSchema.safeParse({ title: '  ', body: 'x' }).success).toBe(false);
    expect(templateSchema.safeParse({ title: 'x', body: '   ' }).success).toBe(false);
  });

  it('refuses a body longer than a screen', () => {
    expect(templateSchema.safeParse({ title: 'x', body: 'a'.repeat(1001) }).success).toBe(false);
  });

  it('defaults to a personal template', () => {
    // The safe half of the pair: an unticked box must never publish to the
    // whole company by omission (#171 — a control that posts nothing).
    const parsed = templateSchema.parse({ title: 'x', body: 'y' });
    expect(parsed.shared).toBe(false);
    expect(parsed.sortOrder).toBe(100);
  });
});
