import { describe, expect, it } from 'vitest';
import { diffFields } from '@/modules/platform/audit/service';

describe('diffFields (audit before/after diff, spec 4.3)', () => {
  it('returns only changed fields', () => {
    const diff = diffFields(
      { weight: 25, name: 'box', color: 'red' },
      { weight: 28, name: 'box' },
    );
    expect(diff).toEqual({ before: { weight: 25 }, after: { weight: 28 } });
  });

  it('returns null when nothing changed', () => {
    expect(diffFields({ a: 1 }, { a: 1 })).toBeNull();
  });

  it('ignores undefined fields in after (not part of the update)', () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: undefined })).toBeNull();
  });

  it('treats null and missing as equal, but value changes as diffs', () => {
    expect(diffFields({}, { a: null })).toBeNull();
    expect(diffFields({ a: null }, { a: 'x' })).toEqual({
      before: { a: null },
      after: { a: 'x' },
    });
  });

  it('compares arrays and objects structurally', () => {
    expect(diffFields({ roles: ['a', 'b'] }, { roles: ['a', 'b'] })).toBeNull();
    expect(diffFields({ roles: ['a'] }, { roles: ['a', 'b'] })).toEqual({
      before: { roles: ['a'] },
      after: { roles: ['a', 'b'] },
    });
  });
});
