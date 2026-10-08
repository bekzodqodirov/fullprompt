import { describe, expect, it } from 'vitest';
import { srcFiles } from '../fixtures/source-shape';

/**
 * The bot keeps the backlog (Q5 a, the owner 2026-10-07: «O'rnatish paytida
 * botga Telegramda yozilgan javoblar — bot qayta yoqilganda qayta
 * ishlansin»). Every poller start says so, and caps what a crash mid-backlog
 * can redeliver. Comments stripped (#725), and the scan must find a start at
 * all (#720: a fence that finds nothing proves nothing).
 */
const SRC = srcFiles();

describe('every poller start keeps the backlog', () => {
  it('each `.start({` carries `drop_pending_updates: false` and `limit: 20`', () => {
    let starts = 0;
    for (const f of SRC) {
      for (const m of f.text.matchAll(/\.start\(\{/g)) {
        starts += 1;
        const options = f.text.slice(m.index!, f.text.indexOf('})', m.index!));
        expect(options, f.path).toContain('drop_pending_updates: false');
        expect(options, f.path).toContain('limit: 20');
      }
    }
    expect(starts, 're-anchor: no bot.start({ found').toBeGreaterThan(0);
  });

  it('nothing in src drops what Telegram held', () => {
    const dropping = SRC.filter((f) => /drop_pending_updates:\s*true/.test(f.text)).map((f) => f.path);
    expect(dropping).toEqual([]);
  });
});
