import { describe, expect, it } from 'vitest';
import { landedWords } from '@/modules/platform/telegram/staff-handlers';
import type { IntakeTarget } from '@/modules/wms/calc/intake-land';

/**
 * The bot's ✅ says what the landing DID (judge product-16): «yangi» only for
 * a card that was minted. A `Record` over the outcome union, so a new outcome
 * is a compile error here until it has words of its own.
 */
type Outcome = NonNullable<IntakeTarget['outcome']>;

const MINTED: Record<Outcome, boolean> = {
  deal: true,
  adopted: false,
  about: true,
  about_joined: false,
  lead: true,
  lead_joined: false,
  retried: false,
};

describe('landedWords', () => {
  const kindOf = (outcome: Outcome): 'deal' | 'lead' =>
    outcome === 'deal' || outcome === 'adopted' ? 'deal' : 'lead';

  it('every outcome reads apart, and only a minted card is «yangi»', () => {
    const words = (Object.keys(MINTED) as Outcome[]).map((outcome) =>
      landedWords({
        kind: kindOf(outcome),
        label: 'B-00123',
        outcome,
        about: { clientCode: 'GS777', sellerName: 'Aziz' },
      }),
    );
    expect(new Set(words).size).toBe(words.length);
    for (const [i, outcome] of (Object.keys(MINTED) as Outcome[]).entries()) {
      expect(words[i]!.startsWith('yangi '), outcome).toBe(MINTED[outcome]);
    }
  });

  it('a lead about a colleague’s client names that client and its seller', () => {
    expect(landedWords({ kind: 'lead', label: 'L', outcome: 'about', about: { clientCode: 'GS777', sellerName: 'Aziz' } })).toBe(
      'yangi lid: L (GS777 — Azizning mijozi)',
    );
    expect(landedWords({ kind: 'lead', label: 'L', outcome: 'about', about: { clientCode: 'GS777', sellerName: null } })).toBe(
      'yangi lid: L (GS777 — sotuvchisi yo‘q)',
    );
  });
});
