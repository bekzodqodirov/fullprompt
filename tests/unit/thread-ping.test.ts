import { describe, expect, it } from 'vitest';
import { threadPingText } from '@/modules/wms/crm/internal-chat';
import { takeOwnLink } from '@/modules/platform/notifications/staff-html';

/**
 * The thread ping's line order (0127). The drain lifts the LAST line into the
 * «↗️ Ochish» URL button only when that whole line is our own link
 * (`takeOwnLink`), so the new «↩️ reply» line must sit ABOVE it — one line in
 * the wrong place and every thread ping loses its button.
 */
const APP = 'https://gsrwms.uz';
const LINK = `${APP}/crm/leads/00000000-0000-4000-8000-000000000001#calc-thread-x`;

describe('the ping says it can be answered, and keeps its button', () => {
  for (const type of ['InternalNote', 'MentionedInNote', 'CalcThread'] as const) {
    it(`${type}: the «↩️» line, then the link LAST — and the drain lifts it`, () => {
      const text = threadPingText({ type, author: 'Aziz', label: 'Lid', note: 'Necha kub?', link: LINK });
      const lines = text.split('\n');
      expect(lines.at(-1)).toBe(`🔗 ${LINK}`);
      expect(lines.at(-2)).toMatch(/^↩️ Javob uchun shu xabarga reply qiling/);
      const lifted = takeOwnLink(text, APP);
      expect(lifted.url).toBe(LINK);
      expect(lifted.text.split('\n').at(-1)).toMatch(/^↩️/);
    });
  }

  it('the calculation’s ping names WHERE to answer on the web — not the lenta box', () => {
    const text = threadPingText({ type: 'CalcThread', author: 'VED', label: '🧮 Lid', note: 'x', link: null });
    expect(text).toContain('(yoki kartadagi «❓ Savol-javob»da yozing)');
    expect(text.split('\n')[0]).toBe('❓ VED · 🧮 Lid');
    // No link for a standing-only recipient: the «↩️» line is the last one.
    expect(text.split('\n').at(-1)).toMatch(/^↩️/);
  });

  it('the head marks the kind, and the body is cut at 400 with an ellipsis', () => {
    const long = 'a'.repeat(450);
    expect(threadPingText({ type: 'InternalNote', author: 'A', label: 'L', note: long, link: null })).toContain(
      `📝 A · L\n${'a'.repeat(400)}…\n`,
    );
    expect(threadPingText({ type: 'MentionedInNote', author: 'A', label: 'L', note: 'x', link: null })).toMatch(/^📣 /);
  });
});
