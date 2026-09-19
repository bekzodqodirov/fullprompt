import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clearsFollowUp } from '@/modules/wms/crm/stage-law';
import { othersLine, STALE_DAYS } from '@/modules/wms/crm/day';

/**
 * «Mening kunim» — the two rules that decide what a person sees in the
 * morning, and the wiring that decides WHERE they see it.
 */

describe('clearsFollowUp', () => {
  it('clears on a board move, which types no date at all', () => {
    expect(clearsFollowUp({ moved: true, storedAt: '2026-09-19' })).toBe(true);
  });

  it('clears on a FORM save that changed the stage and left the date alone', () => {
    // His item 4, first sentence: «agar sotuvchi uni boglanildi etapiga
    // otgazsa moy dendan chiqib ketishi kerak». The form re-posts what it
    // rendered (#171), so «left alone» means «posted the stored value».
    expect(
      clearsFollowUp({ moved: true, typedAt: '2026-09-19', storedAt: '2026-09-19' }),
    ).toBe(true);
  });

  it('keeps a date the person typed in the same save', () => {
    // «ertaga ertalab qayta qo'ng'iroq» — a human being deciding about their
    // own day outranks the rule.
    expect(
      clearsFollowUp({ moved: true, typedAt: '2026-09-25', storedAt: '2026-09-19' }),
    ).toBe(false);
  });

  it('decides nothing when the stage did not change', () => {
    expect(
      clearsFollowUp({ moved: false, typedAt: '2026-09-19', storedAt: '2026-09-19' }),
    ).toBe(false);
  });

  it('treats an emptied box and a null the same way', () => {
    // An empty form field posts '', which is the same fact as «no date».
    expect(clearsFollowUp({ moved: true, typedAt: '', storedAt: null })).toBe(true);
  });
});

describe('othersLine', () => {
  it('is names and counts — his own words', () => {
    expect(
      othersLine([
        { name: 'Alisher', rows: [1, 2, 3, 4] },
        { name: 'Bekzod', rows: [1, 2, 3, 4, 5] },
      ]),
    ).toBe('Alisher 4 ta · Bekzod 5 ta');
  });

  it('says nothing at all when nobody else owes a call', () => {
    expect(othersLine([])).toBe('');
  });
});

/**
 * The wiring, and it is the round's real finding: `/bugun` and `/crm/today`
 * carry the same title, answer the same question and are reached from
 * different menus — the SELLER's home links to the second. Fixing one leaves
 * the complaint alive one tab over, and nothing about behaviour can see that.
 */
describe('both day screens read the one module', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const read = (path: string) => strip(readFileSync(path, 'utf8'));
  const SCREENS = [
    'src/app/(protected)/bugun/page.tsx',
    'src/app/(protected)/crm/(pages)/today/page.tsx',
  ];

  it.each(SCREENS)('%s asks dayCalls and draws DayCallsView', (path) => {
    const src = read(path);
    expect(src, `${path} must ask the shared module`).toMatch(/dayCalls\(\{/);
    expect(src, `${path} must draw the shared view`).toMatch(/<DayCallsView/);
    // The old unscoped read is what put every seller's calls on one screen.
    expect(src, `${path} still calls followUps directly`).not.toMatch(/\bfollowUps\(/);
  });

  it('the view offers the «everybody» door only to somebody who may look', () => {
    const view = read('src/components/day-calls-view.tsx');
    expect(view).toMatch(/calls\.seesAll && calls\.othersCount > 0/);
    // The count on the door comes off the same object as the rows behind it.
    expect(view).toContain('calls.othersCount');
  });

  it('a week is the line between today and the backlog', () => {
    expect(STALE_DAYS).toBe(7);
  });
});
