import { describe, expect, it } from 'vitest';
import { reaskLineDrawn } from '@/modules/wms/receipts/reask-line';

/**
 * The system's own question on the prixod card (his «1 b»): held — always;
 * sent or failed — only while it is the newest thing the client was asked
 * (the as-built review, DLV-1: a failure a person has since acted on kept
 * telling them to act, for good).
 */
const at = (iso: string) => new Date(iso);

describe('the card draws the system’s question while it is the newest thing asked', () => {
  it('nothing to draw without one', () => {
    expect(reaskLineDrawn(null, null)).toBe(false);
  });

  it('held: always — it is about to go', () => {
    expect(reaskLineDrawn({ state: 'waiting', at: at('2026-11-13T10:00:00Z') }, at('2026-11-13T11:00:00Z'))).toBe(true);
  });

  it('sent or failed, with no person’s question delivered: drawn', () => {
    expect(reaskLineDrawn({ state: 'sent', at: at('2026-11-13T10:00:00Z') }, null)).toBe(true);
    expect(reaskLineDrawn({ state: 'failed', at: at('2026-11-13T10:00:00Z') }, null)).toBe(true);
  });

  it('a FAILURE a person’s later question overtook is history — the person has acted', () => {
    expect(reaskLineDrawn({ state: 'failed', at: at('2026-11-13T10:00:00Z') }, at('2026-11-13T10:30:00Z'))).toBe(false);
    expect(reaskLineDrawn({ state: 'failed', at: at('2026-11-13T11:00:00Z') }, at('2026-11-13T10:30:00Z'))).toBe(true);
  });

  it('a SENT question older than the person’s delivery is history; a newer one is the line', () => {
    expect(reaskLineDrawn({ state: 'sent', at: at('2026-11-13T10:00:00Z') }, at('2026-11-13T10:30:00Z'))).toBe(false);
    expect(reaskLineDrawn({ state: 'sent', at: at('2026-11-13T11:00:00Z') }, at('2026-11-13T10:30:00Z'))).toBe(true);
  });
});
