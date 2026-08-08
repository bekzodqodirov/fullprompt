import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The board card's rules, in the only form that can see them.
 *
 * Round 78 rebuilt the funnel and deal cards because the owner could not read
 * them: «malumotlar tartibli … odam adashmaydigan tartibli qilib ber». Every
 * rule below is a thing that WORKED before and was still wrong — a stage name
 * on a card that is not in that stage, one slot holding two kinds of fact, the
 * same fact said twice in two colours. No behavioural assertion can catch any
 * of them, because the markup was always exactly what was intended, which is
 * what makes this a source-shape test (`kanban-pointer.test.ts`'s idiom).
 */

const KANBAN = readFileSync('src/components/kanban.tsx', 'utf8');
const LEAD_CARD = readFileSync('src/app/(protected)/crm/leads/kanban.tsx', 'utf8');
const DEAL_CARD = readFileSync('src/app/(protected)/bitimlar/board.tsx', 'utf8');

describe('the one-tap move never offers a stage that needs a reason', () => {
  it('suppresses the button when the next stage is lost', () => {
    // The next stage is simply the one after this in sort order, and every
    // seeded funnel puts LOST immediately after WON — so without this guard
    // every card in the won column carries a big button reading «Yo'qotildi».
    // A lost move demands a typed reason, so it was never one-tap anyway.
    expect(KANBAN).toContain("nextStage.kind !== 'lost'");
  });

  it('says what the control DOES, and draws the destination as a stage', () => {
    // The stage name is already printed twice above the card (the chip strip
    // and the column header). As a bare button label it was a third printing,
    // and the only one naming a stage the card is NOT in.
    expect(KANBAN).toContain('aria-label={labels.nextStage}');
    expect(KANBAN).toMatch(/stageClass\(\s*nextStage\.color,?\s*\)/);
  });
});

describe('the two boards keep one vocabulary', () => {
  it('spends colour on urgency only — never on identity', () => {
    // `text-good` used to paint the client code on both cards: on the funnel
    // it discriminated (only some leads have a code) and on the deal board
    // every card had one, so the same green meant a signal on one board and
    // decoration on the other. Green/amber/red belong to the STAGE here.
    expect(LEAD_CARD).not.toContain('text-good');
    expect(DEAL_CARD).not.toContain('text-good');
  });

  it('draws money the same way on both cards', () => {
    for (const source of [LEAD_CARD, DEAL_CARD]) {
      expect(source).toContain('font-mono text-xs font-bold tabular-nums');
      // `.num` forces text-right, which is wrong for a full-width card row.
      expect(source).not.toMatch(/className="[^"]*\bnum\b[^"]*"/);
    }
  });

  it('never truncates the line that says which record this is', () => {
    // #571 measured and refused exactly this trade on the card rail: two long
    // names clamp to an identical two lines and become the same card.
    expect(LEAD_CARD).not.toContain('line-clamp');
    expect(DEAL_CARD).not.toContain('line-clamp');
  });

  it('lets a break-less token break, on every text row that carries user input', () => {
    // A 45-character company name with no hyphen takes the card past the
    // viewport and mobile Chrome rescales the whole page (#400). m8-crm seeds
    // exactly such a company on this board on purpose.
    expect((LEAD_CARD.match(/\[overflow-wrap:anywhere\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((DEAL_CARD.match(/\[overflow-wrap:anywhere\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the deal card says one thing per slot', () => {
  it('always names the client, and never lets the title stand in for it', () => {
    // `{deal.title || deal.clientName}` put a job description on some cards
    // and a person on others, in the same slot, in the same column.
    expect(DEAL_CARD).not.toContain('deal.title || deal.clientName');
    expect(DEAL_CARD).toContain('{deal.clientName}');
  });

  it('states «no price» once, in the alarm row, not twice in two colours', () => {
    // `notQuoted` (warn) and the `unpriced` alarm (bad) always co-occurred:
    // the flag is set exactly when the quote is null. The money slot now
    // carries a dash so the column still scans as a column of numbers, and
    // the words belong to the alarm.
    const moneySlot = DEAL_CARD.slice(
      DEAL_CARD.indexOf("fields.has('amount')"),
      DEAL_CARD.indexOf('<MetaLine'),
    );
    expect(moneySlot).toContain('—');
    expect(moneySlot).not.toMatch(/text-warn|text-bad/);
  });
});

describe('the follow-up date is coloured by lateness', () => {
  it('compares against a today the SERVER decided', () => {
    // A permanently amber date on every scheduled lead teaches the eye to skip
    // the one colour the card uses for «act now». `today` arrives as a prop so
    // the server's HTML and the browser's first render agree.
    expect(LEAD_CARD).toContain('lead.nextActionAt < today');
    expect(LEAD_CARD).toContain('lead.nextActionAt === today');
    expect(LEAD_CARD).not.toMatch(/nextActionAt && \(\s*<div className="mt-1 text-\[11px\] font-semibold text-warn"/);
  });
});
