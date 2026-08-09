import { describe, expect, it } from 'vitest';
import {
  RULE_PLACEHOLDERS,
  fillPlaceholders,
  hasPlaceholder,
  valuesFromRecord,
} from '@/modules/platform/automation/placeholders';

/**
 * Round 86's «{ism} bilan bog'laning». The vocabulary is deliberately the
 * canned Telegram replies' — same braces, same unknown-placeholder rule — so
 * somebody who writes both is not writing two languages.
 */

describe('fillPlaceholders', () => {
  it('fills what it knows', () => {
    expect(fillPlaceholders('{ism} bilan bog‘laning', { ism: 'Aziz' })).toBe(
      'Aziz bilan bog‘laning',
    );
    expect(
      fillPlaceholders('{kod}: {narx}$ · {kub} kub', { kod: 'GS777', narx: '900', kub: '5' }),
    ).toBe('GS777: 900$ · 5 kub');
  });

  it('a placeholder nobody defined is LEFT ALONE — braces in somebody’s text are their text', () => {
    expect(fillPlaceholders('{ism} — {familiya}', { ism: 'Aziz' })).toBe('Aziz — {familiya}');
    expect(fillPlaceholders('{ism}', {})).toBe('{ism}');
  });

  it('an empty VALUE blanks its own placeholder — an unnamed lead must not send braces to a colleague', () => {
    expect(fillPlaceholders('{ism} bilan bog‘laning', { ism: '' })).toBe(' bilan bog‘laning');
  });

  it('fills every occurrence, not only the first', () => {
    expect(fillPlaceholders('{kod} {kod}', { kod: 'GS777' })).toBe('GS777 GS777');
  });
});

describe('hasPlaceholder', () => {
  it('says whether the engine has to load the card at all', () => {
    expect(hasPlaceholder('Mijozga qo‘ng‘iroq qiling')).toBe(false);
    expect(hasPlaceholder('{ism} ga qo‘ng‘iroq qiling')).toBe(true);
    expect(hasPlaceholder('{familiya}')).toBe(false);
  });

  it('answers the same on the second call — the shared /g regex would not', () => {
    const text = '{ism} va {kod}';
    expect(hasPlaceholder(text)).toBe(true);
    expect(hasPlaceholder(text)).toBe(true);
    expect(hasPlaceholder(text)).toBe(true);
  });

  it('knows every placeholder the form advertises', () => {
    for (const key of RULE_PLACEHOLDERS) {
      expect(hasPlaceholder(`x {${key}} y`), key).toBe(true);
    }
  });
});

describe('valuesFromRecord', () => {
  it('prints numbers the way a person writes them, not the way postgres stores them', () => {
    const values = valuesFromRecord({
      name: 'Aziz',
      clientCode: 'GS777',
      amount: '200.00',
      volumeM3: '2.500',
      weightKg: '120.000',
      stageName: 'Hisoblash',
    });
    expect(values.narx).toBe('200');
    expect(values.kub).toBe('2.5');
    expect(values.kg).toBe('120');
    expect(values.ism).toBe('Aziz');
    expect(values.kod).toBe('GS777');
    expect(values.etap).toBe('Hisoblash');
  });

  it('an absent number is an empty string, never «null» in a task title', () => {
    const values = valuesFromRecord({ name: 'Aziz', amount: null, volumeM3: null });
    expect(values.narx).toBe('');
    expect(values.kub).toBe('');
    expect(fillPlaceholders('{ism}: {narx}', values)).toBe('Aziz: ');
  });
});
