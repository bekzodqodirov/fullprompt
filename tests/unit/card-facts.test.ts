import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A fact on a card is READ there, never edited there (owner, 2026-08-07:
 * «contactlarni ustiga bosib o'zgartirish featureni … hammasini olib
 * tashla»).
 *
 * Tap-to-edit came out of the Frappe study and shipped across three cards in
 * rounds 61-63. The owner removed it in two steps — the lead's NAME first
 * (2026-08-06), then all of it — for a reason the second removal makes plain:
 * a card is read far more often than it is corrected, and a value that turns
 * into an input under a thumb is a value nobody can read safely. Every one of
 * these fields is still correctable in the ✏️ form below it.
 *
 * A source-shape test, like the chat-controls and style-cascade tripwires,
 * and for the same reason: the removed feature WORKED. Nothing about
 * behaviour can state «this must not come back», so the file shapes do.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/**
 * The two cards that still HAVE a facts block. The client card lost its own
 * in the same change: its ✏️ form is always open and prints the same three
 * fields, so once they stopped being editable in place the block above was
 * printing every value twice.
 */
const FACTS = [
  'src/app/(protected)/crm/leads/[id]/facts.tsx',
  'src/app/(protected)/bitimlar/[id]/facts.tsx',
];

/**
 * …and the ROW they both render, extracted in round 76. It was the same
 * component written out twice, so the fence has to cover the shared file too:
 * an editor creeping back into `CardFacts` would reach both cards at once and
 * neither entry above would see it.
 */
const READ_ONLY = [...FACTS, 'src/components/card-fact.tsx'];

describe('card facts are read-only', () => {
  it('no facts block imports an inline editor or a patch action', () => {
    for (const file of READ_ONLY) {
      const source = read(file);
      expect(source, file).not.toContain('InlineField');
      expect(source, file).not.toMatch(/patch\w*FieldAction/);
      // A read-only block needs no client bundle at all; a 'use client'
      // header here is the first symptom of an editor creeping back.
      expect(source, file).not.toContain("'use client'");
    }
  });

  it('the inline editor component is gone, not merely unused', () => {
    // Kept as a file, it is one import away from returning — and the second
    // removal is the one that has to stick.
    expect(existsSync('src/components/inline-field.tsx')).toBe(false);
  });

  it('and no server action accepts a single card field any more', () => {
    // Round 70's rule: a control removed from a screen while its action still
    // accepts the field is HIDDEN, not removed — the post still works.
    for (const file of [
      'src/app/(protected)/crm/actions.ts',
      'src/app/(protected)/bitimlar/actions.ts',
      'src/app/(protected)/admin/clients/actions.ts',
    ]) {
      expect(read(file), file).not.toMatch(/patch\w*FieldAction/);
    }
    for (const service of [
      'src/modules/wms/crm/inline.ts',
      'src/modules/wms/deals/inline.ts',
      'src/modules/platform/clients/inline.ts',
    ]) {
      expect(existsSync(service), service).toBe(false);
    }
  });

  it('the facts themselves stay on the cards — removing the control kept the value', () => {
    for (const file of FACTS) {
      expect(read(file), file).toMatch(/data-testid="(lead|deal)-facts"/);
    }
    // The client card reads its values off the form itself.
    const clientCard = read('src/app/(protected)/admin/clients/[id]/page.tsx');
    expect(clientCard).toContain('<ClientForm');
    expect(clientCard).not.toContain('ClientFacts');
    // The lead card's phone is the one this began with: a salesperson reading
    // it should never have to open an editor (round 61's whole point). Round
    // 76 made it `always`, so it is printed even when it is empty — a lead
    // nobody can ring is the thing to notice — and dialable.
    expect(read(FACTS[0]!)).toContain('fact-phone');
    expect(read(FACTS[0]!)).toMatch(/testId: 'fact-phone', always: true, tel: true/);
  });

  it('prints no row the screen already carries (round 76)', () => {
    // The height that made the owner ask came partly from rows repeating
    // something a hundred pixels above: the lead's NAME is the page's h1, and
    // its STAGE is the chip on the fold — which is drawn whether the fold is
    // open or shut, so removing the row hides nothing.
    const lead = read(FACTS[0]!);
    expect(lead).not.toContain('fact-name');
    expect(lead).not.toContain('fact-stage');
    expect(read('src/app/(protected)/crm/leads/[id]/page.tsx')).toContain('<h1');
    expect(read('src/app/(protected)/crm/leads/[id]/stage-mover.tsx')).toContain('stage-current');
  });

  it('names the empty facts instead of giving each one a row', () => {
    // Nine rows where five said «—» taught the eye to skip the block. One
    // line names them; only the phone is exempt.
    const shared = read('src/components/card-fact.tsx');
    expect(shared).toContain('facts-missing');
    expect(shared).toContain('fact.value || fact.always');
    // #400: one unbroken 60-character token in a note pushed the card past
    // 360 px, and mobile Chrome rescales the WHOLE page when that happens.
    expect(shared).toContain('[overflow-wrap:anywhere]');
  });
});
