import { describe, expect, it } from 'vitest';
import {
  BACKFILL_DAYS,
  backfillCutoff,
  backfillStep,
  withinWindow,
} from '@/modules/wms/crm/history-backfill';
import type { LiveVerdict } from '@/modules/wms/crm/telegram-live';
import type { MessageRow } from '@/modules/wms/crm/telegram-import';

/**
 * «1 haftalik tarixi bilan tushsin yangi ulanganda» — the decisions behind
 * the connect-time pull. The gramjs walk itself runs only against a live
 * Telegram account and is watched in docker logs; these are the rules it
 * follows.
 */

const row = {} as MessageRow;

describe('the window', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  const cutoff = backfillCutoff(now);

  it('is exactly the week he asked for', () => {
    expect(BACKFILL_DAYS).toBe(7);
    expect(cutoff).toEqual(new Date('2026-08-04T12:00:00Z'));
  });

  it('keeps a message from inside it and drops one from before it', () => {
    // Telegram stamps SECONDS — multiplying is the difference between «last
    // Tuesday» and «January 1970», the lesson the peer index already learned.
    expect(withinWindow(new Date('2026-08-10T00:00:00Z').getTime() / 1000, cutoff)).toBe(true);
    expect(withinWindow(new Date('2026-08-01T00:00:00Z').getTime() / 1000, cutoff)).toBe(false);
  });

  it('refuses an undated service row rather than guessing', () => {
    expect(withinWindow(undefined, cutoff)).toBe(false);
  });
});

describe('what one history message means for the walk', () => {
  it('stores a client chat where the live path would', () => {
    const v: LiveVerdict = { store: true, clientId: 'c1', clientCode: 'GS100', row };
    expect(backfillStep(v)).toEqual({ kind: 'store', clientId: 'c1', leadId: null, row });
  });

  it('stores a chat somebody already attached to a lead', () => {
    const v: LiveVerdict = { store: true, leadId: 'l1', row };
    expect(backfillStep(v)).toEqual({ kind: 'store', clientId: null, leadId: 'l1', row });
  });

  it('REFUSES the lead-minting verdict — a week of strangers is not a week of leads', () => {
    // Live, a stranger on a work number becomes one lead, at the moment they
    // write. Replayed over history at connect time it would mint a lead for
    // every stranger of the last seven days in one silent burst.
    const v: LiveVerdict = {
      store: true,
      openLead: true,
      peer: { phone: '+998901112233', title: 'Somebody' },
      row,
    };
    expect(backfillStep(v)).toEqual({ kind: 'stop' });
  });

  it('steps over a client\'s empty service row without ending the chat', () => {
    // "call ended", a pinned marker — worth nothing, but the chat is still a
    // client's and the walk must keep reading past it.
    expect(backfillStep({ store: false, reason: 'empty' })).toEqual({ kind: 'skip' });
  });

  it('stops the chat on every other refusal — one «not ours» answers for the whole chat', () => {
    for (const reason of ['not_a_client', 'excluded', 'self', 'no_phone'] as const) {
      expect(backfillStep({ store: false, reason })).toEqual({ kind: 'stop' });
    }
    expect(
      backfillStep({ store: false, ask: true, peerId: 1n, phone: '+998', title: 'x' }),
    ).toEqual({ kind: 'stop' });
  });
});
