import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A file the browser can render OPENS; one it cannot DOWNLOADS (round 98).
 *
 * The route's helpers are module-private, so this reads the two rules as
 * source: a PDF/image/audio/video/plain-text is served `inline`, and — the
 * safety half — nothing a browser might EXECUTE (html/svg/xml) is ever inline,
 * so a stored attachment cannot become a script on our own origin.
 */
const route = readFileSync('src/app/api/attachments/[id]/route.ts', 'utf8');

describe('the inline set', () => {
  it('lists exactly the render-safe types and nothing executable', () => {
    const fn = route.slice(
      route.indexOf('function inlineDisposition'),
      route.indexOf('function contentDisposition'),
    );
    for (const t of ['application/pdf', "'image/", "'audio/", "'video/", 'text/plain']) {
      expect(fn).toContain(t);
    }
    // The dangerous ones must NOT be granted inline — they stay downloads.
    expect(fn).not.toContain('text/html');
    expect(fn).not.toContain('image/svg');
    expect(fn).not.toContain('application/xml');
  });

  it('sends a UTF-8 filename so a Cyrillic or Chinese name survives the header', () => {
    const fn = route.slice(route.indexOf('function contentDisposition'));
    expect(fn).toContain("filename*=UTF-8''");
    expect(fn).toContain('encodeURIComponent');
  });
});
