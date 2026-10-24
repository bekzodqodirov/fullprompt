import { describe, expect, it } from 'vitest';
import { agentStats, type StatsDraftRow } from '@/modules/wms/agent/stats';

/**
 * The approval rate the phase-2 gate reads (review fit-10). Each case is a
 * way the number could flatter the machine: a ✏️ rewrite counted as approval,
 * an untouched draft counted as a decision, his own reply left out, a reply
 * that never left counted as sent, his typed price counted as the model's.
 */

const row = (over: Partial<StatsDraftRow>): StatsDraftRow => ({
  status: 'approved',
  kind: 'reply',
  edited: false,
  outboxStatus: 'sent',
  category: 'faq',
  ...over,
});

describe('agentStats', () => {
  it('is sentUnchanged ÷ (sentUnchanged + sentEdited + rejected + answeredHimself)', () => {
    const s = agentStats([
      row({}),
      row({}),
      row({ edited: true }),
      row({ status: 'rejected', outboxStatus: null }),
      row({ status: 'taken_over', outboxStatus: null }),
    ]);
    expect(s.sentUnchanged).toBe(2);
    expect(s.sentEdited).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.answeredHimself).toBe(1);
    expect(s.decided).toBe(5);
    expect(s.rate).toBeCloseTo(2 / 5, 10);
  });

  it('counts a ✏️ rewrite as NOT approved — it is in the denominator, never the numerator', () => {
    const s = agentStats([row({ edited: true }), row({ edited: true })]);
    expect(s.sentUnchanged).toBe(0);
    expect(s.rate).toBe(0);
  });

  it('prints superseded and expired BESIDE the rate, never in its denominator', () => {
    const s = agentStats([
      row({}),
      row({ status: 'superseded', outboxStatus: null }),
      row({ status: 'superseded', outboxStatus: null }),
      row({ status: 'expired', outboxStatus: null }),
    ]);
    expect(s.decided).toBe(1);
    expect(s.rate).toBe(1);
    expect(s.superseded).toBe(2);
    expect(s.expired).toBe(1);
  });

  it('does not count a reply that never left as sent, nor one still on its way', () => {
    const s = agentStats([
      row({ outboxStatus: 'cancelled' }),
      row({ outboxStatus: 'failed' }),
      row({ outboxStatus: 'unknown' }),
      row({ outboxStatus: 'agent' }),
      row({ outboxStatus: 'sending' }),
      row({ outboxStatus: null }),
    ]);
    expect(s.decided).toBe(0);
    expect(s.rate).toBeNull();
    expect(s.approvedNotSent).toBe(3);
    expect(s.onTheWay).toBe(3);
  });

  it('keeps his typed price out of the rate, and live drafts out of everything', () => {
    const s = agentStats([
      row({ kind: 'price' }),
      row({ kind: 'price', status: 'rejected', outboxStatus: null }),
      row({ status: 'pending', outboxStatus: null }),
      row({ status: 'editing', outboxStatus: null }),
    ]);
    expect(s.decided).toBe(0);
    expect(s.price).toBe(2);
    expect(s.live).toBe(2);
  });

  it('splits by category with the same rule, an unknown category under «other»', () => {
    const s = agentStats([
      row({ category: 'status' }),
      row({ category: 'status', status: 'rejected', outboxStatus: null }),
      row({ category: null }),
    ]);
    expect(s.byCategory.status).toMatchObject({ sentUnchanged: 1, decided: 2, rate: 0.5 });
    expect(s.byCategory.other).toMatchObject({ sentUnchanged: 1, decided: 1, rate: 1 });
  });
});
