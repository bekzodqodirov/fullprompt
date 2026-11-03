import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * The agent feeds' door while its database is down (docs/AGENT-FEED.md §3).
 *
 * The key lookup itself fails, so nothing has been checked yet. A caller that
 * SENT a key is told 503 — the agent backs off instead of tripping its
 * breaker and telling the owner his key is wrong. A caller with no key at all
 * is told the same 404 as every other refusal: a 503 there says «this feed
 * exists, and its database is down right now» to anybody (review, sec lens).
 */
vi.mock('@/modules/wms/crm/inbound', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/crm/inbound')>();
  return {
    ...real,
    sourceWebhookSecret: vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    }),
  };
});

const { agentFeedResponse } = await import('@/modules/wms/crm/agent-feed-door');

const ask = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:3000/api/agent/outcomes', { headers });

describe('the agent feeds while the database is down', () => {
  it('a caller with a key is told to come back later', async () => {
    for (const feed of ['suppression', 'outcomes'] as const) {
      const res = await agentFeedResponse(ask({ 'x-gsr-key': 'anything' }), feed);
      expect(res.status, feed).toBe(503);
      expect(await res.json()).toEqual({ error: 'unavailable' });
    }
  });

  it('a caller with no key learns nothing — the same 404 as a door that is off', async () => {
    for (const feed of ['suppression', 'outcomes'] as const) {
      const res = await agentFeedResponse(ask(), feed);
      expect(res.status, feed).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });
});

describe('the doors screen', () => {
  // Comments stripped first, so a sentence about the rule cannot satisfy it (#725).
  const page = readFileSync('src/app/(protected)/crm/(pages)/kelganlar/page.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('builds its rows through `doorViews` and never hands a key to the client component itself', () => {
    expect(page).toMatch(/doorViews\(doorRows,\s*\{[^}]*canManage[^}]*\}\)/);
    expect(page).not.toMatch(/secret\s*:/);
    expect(page).not.toMatch(/door\.secret/);
  });
});
