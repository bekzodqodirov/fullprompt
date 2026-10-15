import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_OFFERS, mergeLineAnswers } from '@/modules/platform/telegram/calc-intake';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';
import { lineOfferKeyboard } from '@/modules/platform/telegram/staff-handlers';

/**
 * The bot's per-line follow-up (P1.3, judge UX4) — the parts a shell can
 * prove without a Telegram: the buttons a bare number is offered with, and
 * the answers that must survive «➕ Yana ma'lumot».
 */
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const HANDLERS = code('src/modules/platform/telegram/staff-handlers.ts');

describe('a bare number is answered by a tap (UX4)', () => {
  it('each button carries only its POSITION, and the parser answers every one', () => {
    // The figure is read back from the state, so a stale or forged press can
    // only pick among what this question offered; an unparsed callback spins
    // on the phone for fifteen seconds with no error anywhere (#937).
    const kb = lineOfferKeyboard(['50 dona', '50 kg', '50 m²']);
    const offered = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(offered).toEqual(['c:pick_0', 'c:pick_1', 'c:pick_2', 'c:skip']);
    for (const data of offered) expect(parseCallback(data), data).not.toBeNull();
  });

  it('never more buttons than the parser has positions for', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `${i} kg`);
    const picks = lineOfferKeyboard(labels)
      .inline_keyboard.flat()
      .map((b) => b.callback_data)
      .filter((d) => d.startsWith('c:pick_'));
    expect(picks).toHaveLength(MAX_OFFERS);
    for (const data of picks) expect(parseCallback(data), data).toEqual({ kind: 'calc', step: data.slice(2) });
    // One past the last is refused — the vocabulary is closed.
    expect(parseCallback(`c:pick_${MAX_OFFERS}`)).toBeNull();
  });

  it('DERIVED: every c: button the calc handlers build is one the parser accepts', () => {
    const literals = [...HANDLERS.matchAll(/callback_data:\s*(['"`])(c:[^'"`]*)\1/g)].map((m) => m[2]!);
    expect(literals.length, 'no c: buttons found — re-anchor this fence').toBeGreaterThanOrEqual(3);
    for (const raw of literals) {
      // A template hole is a position or a zone, filled before it is sent.
      const filled = raw.includes('${i}')
        ? Array.from({ length: MAX_OFFERS }, (_, i) => raw.replace('${i}', String(i)))
        : raw.includes('${')
          ? []
          : [raw];
      for (const data of filled) expect(parseCallback(data), data).not.toBeNull();
    }
  });
});

describe('«➕ Yana ma’lumot» keeps the per-line answers (P1.3)', () => {
  const answers = [
    { index: 1, name: 'Kurtka', patch: { quantity: 300 } },
    { index: 0, name: 'Kafel', patch: { measureUnit: 'm2' as const, measureQty: 120 } },
  ];

  it('an answer goes back onto its line by index when the name still matches', () => {
    const merged = mergeLineAnswers([{ name: 'Kafel' }, { name: 'Kurtka', weightKg: 150 }], answers);
    expect(merged).toEqual([
      { name: 'Kafel', measureUnit: 'm2', measureQty: 120 },
      { name: 'Kurtka', weightKg: 150, quantity: 300 },
    ]);
  });

  it('a re-read that REORDERS the lines does not hand one line’s answer to another', () => {
    const merged = mergeLineAnswers([{ name: 'Kurtka' }, { name: 'Kafel' }], answers);
    expect(merged).toEqual([
      { name: 'Kurtka', quantity: 300 },
      { name: 'Kafel', measureUnit: 'm2', measureQty: 120 },
    ]);
  });

  it('a line the re-read no longer has keeps its answer in the material, nowhere else', () => {
    expect(mergeLineAnswers([{ name: 'Choynak' }], answers)).toEqual([{ name: 'Choynak' }]);
  });

  it('the re-analysis puts them back — the merge is on the analysis path', () => {
    const intake = code('src/modules/platform/telegram/calc-intake.ts');
    const analyse = intake.slice(intake.indexOf('export async function analyzeCollected'));
    expect(analyse).toContain('mergeLineAnswers(');
    expect(analyse).toContain('state.lineAnswers');
  });
});
