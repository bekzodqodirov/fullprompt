import { describe, expect, it } from 'vitest';
import ru from '../../messages/ru.json';
import {
  CARD_FIELDS,
  DEAL_CARD_FIELDS,
  LEAD_CARD_FIELDS,
  parseCardFields,
  serializeCardFields,
  visibleCardFields,
} from '@/modules/platform/lists/card-fields';

/**
 * What a person may take off a board card, and what they may not.
 *
 * The load-bearing rule is the boring one: with NO choice made the card is
 * exactly the card that shipped. Half the Playwright suite finds a board card
 * by its text, and a default that differed from today's board would rewrite
 * what every one of those specs sees — so «nobody chose» has to be a set, not
 * an empty one and not everything.
 */

describe('the default is today, not everything and not nothing', () => {
  it('renders the lead card the board already had — plus the quote, deliberately', () => {
    // Round 71 broke the «null = yesterday's card» stillness ONCE, on
    // purpose and stated: the quote IS the feature (the price written after
    // hisoblatish), and a filterable number nobody can see on a card is a
    // filter over invisible ink. Everything else stays exactly as shipped.
    expect([...visibleCardFields(LEAD_CARD_FIELDS, null)].sort()).toEqual([
      'chat',
      'code',
      'company',
      'nextAction',
      'owner',
      'phone',
      'quote',
      'source',
    ]);
  });

  it('leaves the deal card new line OFF until somebody asks for it', () => {
    // Cubic metres is the one thing the board never showed. On by default, it
    // would change the card for everybody who never touched the setting.
    const shown = visibleCardFields(DEAL_CARD_FIELDS, null);
    expect(shown.has('volume')).toBe(false);
    expect(shown.has('amount')).toBe(true);
  });

  it('never offers the card identity as switchable', () => {
    // A lead's NAME and a deal's CODE and TITLE. Not in the specs at all, so
    // there is no state in which a card can render with nothing on it — and no
    // state in which the browser suite stops finding cards by name.
    const keys = [...LEAD_CARD_FIELDS, ...DEAL_CARD_FIELDS].map((spec) => spec.key);
    for (const forbidden of ['name', 'title', 'dealCode']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('a choice that is not the default', () => {
  it('honours an explicit empty list — «all of them off» is a real answer', () => {
    expect([...visibleCardFields(LEAD_CARD_FIELDS, [])]).toEqual([]);
  });

  it('drops a key nobody recognises, because a choice outlives a field', () => {
    expect([...visibleCardFields(LEAD_CARD_FIELDS, ['phone', 'was-removed-in-2027'])]).toEqual([
      'phone',
    ]);
  });
});

describe('the cookie survives a round trip', () => {
  it('carries both boards, and reading gives back what writing took', () => {
    const choice = { lead: ['phone', 'chat'], deal: ['amount', 'volume'] };
    expect(parseCardFields(serializeCardFields(choice))).toEqual(choice);
  });

  it('distinguishes «chose nothing» from «never chose»', () => {
    // The distinction the whole default rests on: an empty list means every
    // switchable line is off; an ABSENT board means the default set.
    const parsed = parseCardFields(serializeCardFields({ lead: [] }));
    expect(parsed.lead).toEqual([]);
    expect('deal' in parsed).toBe(false);
    expect([...visibleCardFields(LEAD_CARD_FIELDS, parsed.lead ?? null)]).toEqual([]);
    expect(visibleCardFields(DEAL_CARD_FIELDS, null).size).toBeGreaterThan(0);
  });

  it('ignores rubbish rather than throwing on it', () => {
    // A cookie is a string a person can edit, and a truncated one is normal.
    for (const raw of ['', 'nonsense', 'lead', '=x', '|||', 'ghost=phone', 'lead=phone|brok']) {
      expect(() => parseCardFields(raw)).not.toThrow();
    }
    expect(parseCardFields('ghost=phone')).toEqual({});
    expect(parseCardFields('lead=phone|brok')).toEqual({ lead: ['phone'] });
  });
});

describe('every label the menu can ask for exists', () => {
  it('resolves in the reference bundle', () => {
    // The key is per FIELD, so `t()` is called with a runtime value and
    // `i18n-keys.test.ts` cannot see it — the map is the source of truth and
    // this is its anchor (#163, the fifth of these).
    const namespaces: Record<string, Record<string, unknown>> = {
      lead: ru.crm as unknown as Record<string, unknown>,
      deal: ru.deals as unknown as Record<string, unknown>,
    };
    const missing: string[] = [];
    for (const [board, specs] of Object.entries(CARD_FIELDS)) {
      for (const spec of specs) {
        if (typeof namespaces[board]![spec.labelKey] !== 'string') {
          missing.push(`${board}: ${spec.labelKey}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
