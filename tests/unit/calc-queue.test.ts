import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calcDueMinutes, missingFor } from '@/modules/wms/calc/service';
import { CALC_SECTIONS, REQUIRED_FIELDS } from '@/modules/wms/calc/intake';
import { FIELD_LABELS, SECTION_LABELS, isCalcSection } from '@/modules/wms/calc/labels';

/**
 * VED phase A — the decisions the queue makes without a database.
 *
 * The checklist is deliberately NOT restated here: `missingFor` calls the bot
 * intake's own `missingFields`, so these cases prove the ADAPTER (a stored row
 * with no section has no checklist; a stored row with one asks the section's
 * own question) rather than re-deriving completeness a second way (#166).
 */
describe('the deadline follows the size of the job', () => {
  it('is the owner’s scale: half an hour a line, two hours at the cap', () => {
    expect(calcDueMinutes(1)).toBe(30);
    expect(calcDueMinutes(2)).toBe(60);
    expect(calcDueMinutes(4)).toBe(120);
    expect(calcDueMinutes(400)).toBe(120);
  });

  it('a request whose goods live only in a file is not the FASTEST job in the queue', () => {
    // Zero lines with materials attached is the everyday PDF case, and the
    // floor would hand it the shortest deadline in the system for the job
    // that needs the most reading.
    expect(calcDueMinutes(0, true)).toBe(60);
    expect(calcDueMinutes(0, false)).toBe(30);
  });
});

describe('the checklist over a stored request', () => {
  const facts = { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 300, volumeM3: 2, goods: [] };

  it('asks the section’s own question', () => {
    // Freight wants the road, customs does not — the bot's rule, reached
    // through the stored row rather than restated.
    expect(missingFor('rastamojka', { ...facts, fromCity: null, toCity: null })).toEqual(['goods']);
    expect(missingFor('yolkira', { ...facts, fromCity: null })).toEqual(['fromCity', 'goods']);
    // Sub-round B: customs is calculated per LINE, so a customs section also
    // asks what each line is — a count, and a weight where one cannot be
    // derived. One line and a stated total weight IS that line's weight, so
    // only the count is outstanding here.
    expect(missingFor('podklyuch', { ...facts, goods: [{ name: 'monitor' }] })).toEqual([
      'itemQuantity',
    ]);
    expect(
      missingFor('podklyuch', { ...facts, goods: [{ name: 'monitor', quantity: 4 }] }),
    ).toEqual([]);
  });

  it('a row written before the module existed has no section and no checklist', () => {
    // The column is nullable on purpose: rows from round 28 never said what
    // kind of job they were, and inventing «podklyuch» for them would put a
    // demand on the screen that nobody ever made.
    expect(missingFor(null, facts)).toEqual([]);
  });

  it('a zero is a blank, through the adapter too', () => {
    // With no total weight there is nothing to derive the line's weight
    // FROM, so the per-line question appears beside the total's — which is
    // the derivation being visible rather than assumed.
    expect(missingFor('podklyuch', { ...facts, weightKg: 0, goods: [{ name: 'x' }] })).toEqual([
      'weightKg',
      'itemQuantity',
      'itemWeight',
    ]);
  });
});

describe('the screen names the bot’s vocabulary, and names all of it', () => {
  it('every section and every required field has a bundle key', () => {
    // The maps are what a locale test can walk: `t(`sections.${section}`)` is
    // a runtime key and the i18n tripwire cannot see it (#163).
    for (const section of CALC_SECTIONS) expect(SECTION_LABELS[section]).toBeTruthy();
    const fields = new Set(Object.values(REQUIRED_FIELDS).flat());
    for (const field of fields) expect(FIELD_LABELS[field], field).toBeTruthy();
  });

  it('a section off a form or out of the database is checked, never trusted', () => {
    expect(isCalcSection('podklyuch')).toBe(true);
    expect(isCalcSection('yolkira')).toBe(true);
    expect(isCalcSection('kub')).toBe(false);
    expect(isCalcSection(null)).toBe(false);
  });
});

describe('the wire between the queue and the things that must agree with it', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it('the card form posts the section, and the action refuses an unknown one', () => {
    // #171's shape one more time: a chip that renders as chosen and posts
    // nothing leaves the row taking whatever the column defaults to.
    const form = read('src/components/calc-send-form.tsx');
    expect(form).toContain('setSection(value)');
    expect(form).toContain('section,');
    const action = read('src/app/(protected)/hisoblash/actions.ts');
    expect(action).toContain("if (!isCalcSection(input.section)) return { error: 'bad_section' };");
  });

  it('no door anywhere accepts an assignee — the queue decides who calculates', () => {
    // Round 70's rule: a control removed from a screen while the action still
    // accepts the field is HIDDEN, not removed. There is no picker, so there
    // must be no parse either.
    //
    // Comments are stripped first — #725's lesson, learned when a sentence in
    // a docstring made a fence accuse the code it was describing. This very
    // test caught its own explanatory comment on the first run.
    const code = (path: string) =>
      read(path)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    expect(code('src/app/(protected)/hisoblash/actions.ts')).not.toMatch(/assigneeId/);
    expect(code('src/components/calc-send-form.tsx')).not.toMatch(/assigneeId/);
  });

  it('the take is decided by the UPDATE itself, not by a read before it', () => {
    // Two people pressing «Olaman» in the same second must not both mint a
    // task: the loser's would be an open, timed task no request points at.
    const service = read('src/modules/wms/calc/service.ts');
    const take = service.slice(service.indexOf('export async function takeCalcRequest'));
    const update = take.indexOf('.update(calcRequests)');
    const returning = take.indexOf('.returning(');
    expect(update).toBeGreaterThan(-1);
    expect(returning).toBeGreaterThan(update);
    expect(take.slice(0, returning)).toContain('IS DISTINCT FROM');
  });

  it('the overdue sweep claims its rows before anything leaves', () => {
    // 0082's lesson, three rounds old: a sweep that selects, sends, and only
    // then stamps delivers everything twice the day two drains overlap.
    const service = read('src/modules/wms/calc/service.ts');
    const sweep = service.slice(service.indexOf('export async function notifyOverdueCalcs'));
    const claim = sweep.indexOf('overdueNotifiedAt: now');
    const send = sweep.indexOf('notifyStaffTelegram');
    expect(claim).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(claim);
  });

  it('the clock stops OUTSIDE saveLines’ transaction', () => {
    // Everything in the calc service runs on the pool, and a second
    // connection asked for while a transaction holds one is what freezes
    // every screen in the app (tx-pool.test.ts).
    const deals = readFileSync('src/modules/wms/deals/service.ts', 'utf8');
    const save = deals.slice(deals.indexOf('export async function saveLines'));
    const txEnd = save.indexOf('  });');
    const hook = save.indexOf('completeCalcForDeal');
    expect(hook).toBeGreaterThan(txEnd);
    expect(save.slice(txEnd, hook)).toContain('lines.length > 0');
  });

  it('a cancelled task releases its request instead of parking it', () => {
    const tasks = readFileSync('src/modules/platform/tasks/service.ts', 'utf8');
    const cancel = tasks.slice(tasks.indexOf('export async function cancelTask'));
    expect(cancel.slice(0, cancel.indexOf('export async function reassignTask'))).toContain(
      'releaseCalcForTask',
    );
  });

  it('a won lead’s open request follows the cargo onto the deal', () => {
    const crm = readFileSync('src/modules/wms/crm/service.ts', 'utf8');
    expect(crm).toContain('rekeyLeadCalcRequests');
  });
});
