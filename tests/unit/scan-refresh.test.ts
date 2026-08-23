import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What the two scan screens are allowed to pull over the China link.
 *
 * Source-shape on purpose, and this is the case the idiom exists for: both
 * arrangements WORK, and the difference only shows on a 200-box truck at the
 * end of a slow link — which no fixture here has. Measured before the fix
 * (round 110): four accepts on the unload screen cost four full snapshot
 * downloads, one per scan; after it, zero. The loading screen has had the
 * split since round 9 (#248-250) and unload never got it.
 */

const SCREENS = {
  load: readFileSync('src/app/(protected)/batches/[id]/load/loading-screen.tsx', 'utf8'),
  unload: readFileSync('src/app/(protected)/batches/[id]/unload/unload-screen.tsx', 'utf8'),
};

/** The file with block comments removed — a rule must not be satisfied by prose (#725). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe.each(Object.entries(SCREENS))('%s screen', (_name, src) => {
  const body = code(src);

  it('re-reads the truck only behind `sync`, never on the scan path', () => {
    // The snapshot GET must sit inside the `if (sync)` branch of flush().
    const guard = body.indexOf('if (sync)');
    const fetchAt = body.indexOf('/planned`, {');
    expect(guard, 'flush() must take a `sync` flag').toBeGreaterThan(-1);
    expect(fetchAt, 'the refresh must send If-None-Match').toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(guard);
  });

  it('a scan coalesces through flushSoon, so a burst is one request', () => {
    expect(body).toMatch(/flushSoon\(\);\s*}\s*(?:async )?function onCode|flushSoon\(\);/);
    expect(body).toContain('const flushSoon = useCallback');
    // `accept()` must not call the snapshot-refreshing flush directly.
    const accept = body.slice(body.indexOf('async function accept'));
    const acceptBody = accept.slice(0, accept.indexOf('\n  function onCode'));
    expect(acceptBody).toContain('flushSoon()');
    expect(acceptBody).not.toMatch(/void flush\(/);
  });

  it('mounts with ONE snapshot read, not two', () => {
    // The mount effect reads it; the flush effect must not ask again.
    expect(body).toMatch(/void flush\(\);\s*const tick = \(\) => \{/);
    expect(body).toContain('setInterval(tick, 15_000)');
    // …and a pocketed phone does not poll at all.
    expect(body).toContain("document.visibilityState === 'visible'");
  });

  it('asks the server whether anything changed', () => {
    expect(body).toContain("'If-None-Match'");
    expect(body).toContain("res.headers.get('etag')");
  });
});
