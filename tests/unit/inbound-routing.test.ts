import { describe, expect, it } from 'vitest';
import { matchRoute, type RouteRow } from '@/modules/wms/crm/routing';

/**
 * Taqsimot's one pure decision: which rule claims an arrival. Everything else
 * (fairness inside the pool, the fallback) is the rota's own query and is
 * proven against a real database in `inbound-routing.integration.test.ts`.
 */

let seq = 0;
const route = (over: Partial<RouteRow>): RouteRow => ({
  id: `r${seq++}`,
  sortOrder: seq,
  sourceKey: null,
  keyword: null,
  userIds: ['u1'],
  active: true,
  ...over,
});

describe('which rule claims an arrival', () => {
  it('reads top-down and the FIRST match wins, not the most specific', () => {
    const broad = route({ sourceKey: 'instagram' });
    const narrow = route({ sourceKey: 'instagram', keyword: 'konteyner' });
    // Order is the owner's to arrange — the screen has the arrows for exactly
    // this. A hidden "best match" rule would make the list lie about itself.
    expect(
      matchRoute([broad, narrow], { sourceKey: 'instagram', text: ['konteyner kerak'] }),
    ).toBe(broad);
    expect(
      matchRoute([narrow, broad], { sourceKey: 'instagram', text: ['konteyner kerak'] }),
    ).toBe(narrow);
  });

  it('a source rule claims only its source', () => {
    const r = route({ sourceKey: 'instagram' });
    expect(matchRoute([r], { sourceKey: 'instagram', text: [] })).toBe(r);
    expect(matchRoute([r], { sourceKey: 'telegram', text: [] })).toBeNull();
  });

  it('the keyword is a case-insensitive contains over name AND note together', () => {
    const r = route({ keyword: 'Katta' });
    // The telling word may be in either box the form filled.
    expect(matchRoute([r], { sourceKey: 'sayt', text: ['Aziz', 'KATTA yuk bor'] })).toBe(r);
    expect(matchRoute([r], { sourceKey: 'sayt', text: ['katta mijoz', null] })).toBe(r);
    expect(matchRoute([r], { sourceKey: 'sayt', text: ['kichik yuk'] })).toBeNull();
  });

  it('both conditions must hold when both are set', () => {
    const r = route({ sourceKey: 'instagram', keyword: 'kub' });
    expect(matchRoute([r], { sourceKey: 'instagram', text: ['5 kub'] })).toBe(r);
    expect(matchRoute([r], { sourceKey: 'instagram', text: ['og`ir yuk'] })).toBeNull();
    expect(matchRoute([r], { sourceKey: 'sayt', text: ['5 kub'] })).toBeNull();
  });

  it('a rule with no condition is a catch-all — an explicit «everything else»', () => {
    const specific = route({ sourceKey: 'google' });
    const rest = route({});
    expect(matchRoute([specific, rest], { sourceKey: 'tiktok', text: [] })).toBe(rest);
  });

  it('skips a switched-off rule and a rule with nobody in it', () => {
    const off = route({ sourceKey: 'instagram', active: false });
    const empty = route({ sourceKey: 'instagram', userIds: [] });
    const live = route({ sourceKey: 'instagram' });
    expect(matchRoute([off, empty, live], { sourceKey: 'instagram', text: [] })).toBe(live);
    expect(matchRoute([off, empty], { sourceKey: 'instagram', text: [] })).toBeNull();
  });

  it('answers null over an empty list — the general rotation is the fallback, not a rule', () => {
    expect(matchRoute([], { sourceKey: 'instagram', text: ['hech narsa'] })).toBeNull();
  });
});
