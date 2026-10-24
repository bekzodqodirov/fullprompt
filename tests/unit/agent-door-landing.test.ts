import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The POST door when the landing fails (docs/AGENT-FEED.md §1, review
 * 2026-10-24). Every advert door keeps its constant 200 — a platform reads a
 * 500 as «send it again», for hours — but the agent's own door is told 503:
 * the agent believed the 200, so a push lost to a bad minute was never
 * re-sent and never flagged.
 */
const landInboundLead = vi.fn();
const sourceWebhookSecret = vi.fn();

vi.mock('@/modules/wms/crm/inbound', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/crm/inbound')>();
  return {
    ...real,
    landInboundLead: (...args: unknown[]) => landInboundLead(...args),
    sourceWebhookSecret: (...args: unknown[]) => sourceWebhookSecret(...args),
  };
});

const { POST } = await import('@/app/api/leads/in/[source]/route');

const KEY = 'k-agent-door-test';
const post = (source: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://localhost:3000/api/leads/in/${source}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        name: 'Namuna',
        phone: '+998 90 123 45 67',
        external_id: 'cs:x:202610',
      }),
    }),
    { params: Promise.resolve({ source }) },
  );

beforeEach(() => {
  landInboundLead.mockReset();
  sourceWebhookSecret.mockReset();
});

describe('a landing that throws', () => {
  beforeEach(() => {
    sourceWebhookSecret.mockResolvedValue(KEY);
    landInboundLead.mockRejectedValue(
      new Error('22P02 Unicode low surrogate must follow a high surrogate'),
    );
  });

  it('is a 503 on the agent’s door — retry, nothing was recorded', async () => {
    const res = await post('agent', { 'x-gsr-key': KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is the constant 200 on every other door, as before', async () => {
    for (const source of ['tiktok', 'sayt', 'other']) {
      const res = await post(source, { 'x-gsr-key': KEY });
      expect(res.status, source).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });

  it('a landing that worked is the 200 on the agent’s door too', async () => {
    landInboundLead.mockResolvedValue({ outcome: 'dropped', reason: 'replay' });
    const res = await post('agent', { 'x-gsr-key': KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('a key lookup that throws (the database is down before anything is checked)', () => {
  beforeEach(() => {
    sourceWebhookSecret.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
  });

  it('is a 503 to the agent, which sends its key in the header', async () => {
    const res = await post('agent', { 'x-gsr-key': KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('fails as it always did for a caller with no header, and on every other door', async () => {
    await expect(post('agent')).rejects.toThrow(/ECONNREFUSED/);
    await expect(post('tiktok', { 'x-gsr-key': KEY })).rejects.toThrow(/ECONNREFUSED/);
  });
});
