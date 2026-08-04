import { describe, expect, it } from 'vitest';
import type { KeyboardEvent } from 'react';
import { sendOnEnter } from '@/components/composer';

/**
 * One keyboard contract for every box that talks to a customer: a physical
 * keyboard sends on Enter (Shift+Enter breaks the line), a finger gets a
 * newline and only the button sends — on a phone there IS no Shift+Enter,
 * so Enter-send fires half-typed messages at real clients.
 */

const key = (over: Partial<{ key: string; shiftKey: boolean }> = {}) => {
  let prevented = false;
  return {
    event: {
      key: 'Enter',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
      ...over,
    } as unknown as KeyboardEvent<HTMLTextAreaElement>,
    wasPrevented: () => prevented,
  };
};

describe('sendOnEnter', () => {
  it('sends on Enter from a keyboard', () => {
    let sent = 0;
    const { event, wasPrevented } = key();
    sendOnEnter(event, false, () => (sent += 1));
    expect(sent).toBe(1);
    expect(wasPrevented()).toBe(true);
  });

  it('Shift+Enter breaks the line instead', () => {
    let sent = 0;
    const { event, wasPrevented } = key({ shiftKey: true });
    sendOnEnter(event, false, () => (sent += 1));
    expect(sent).toBe(0);
    expect(wasPrevented()).toBe(false);
  });

  it('a finger never sends from the return key', () => {
    let sent = 0;
    const { event, wasPrevented } = key();
    sendOnEnter(event, true, () => (sent += 1));
    expect(sent).toBe(0);
    expect(wasPrevented()).toBe(false);
  });

  it('other keys pass through untouched', () => {
    let sent = 0;
    const { event, wasPrevented } = key({ key: 'a' });
    sendOnEnter(event, false, () => (sent += 1));
    expect(sent).toBe(0);
    expect(wasPrevented()).toBe(false);
  });
});
