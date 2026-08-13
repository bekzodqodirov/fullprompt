import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import {
  AUDIT_FIELD_LABELS,
  AUDIT_FIELD_REFS,
  collectAuditRefs,
  isUuidShaped,
} from '@/modules/platform/audit/fields';

/**
 * The History tab builds its key at runtime (`t(\`fields.${label}\`)`), which
 * `i18n-keys.test.ts` says outright it cannot see. So the map is the source of
 * truth and this is its anchor — the fourth of these after the bridge, feed and
 * settings labels, all of which shipped a missing key first (#163).
 *
 * A key missing from all four bundles matches the parity test perfectly and
 * would throw at RENDER time, on seven card screens, in every language.
 */

const BUNDLES = { ru, uz, 'zh-CN': zh, en } as Record<string, { audit: { fields: Record<string, string> } }>;

describe('every audit field label the tab can ask for', () => {
  it('exists in all four bundles', () => {
    const missing: string[] = [];
    for (const label of new Set(Object.values(AUDIT_FIELD_LABELS))) {
      for (const [locale, bundle] of Object.entries(BUNDLES)) {
        if (typeof bundle.audit.fields?.[label] !== 'string') missing.push(`${locale}: ${label}`);
      }
    }
    expect(missing, 'named by AUDIT_FIELD_LABELS, absent from a bundle').toEqual([]);
  });

  it('carries no label no column points at', () => {
    // A bundle entry nobody asks for is dead weight that outlives the column
    // it was written for; the map is what the screen reads.
    const used = new Set(Object.values(AUDIT_FIELD_LABELS));
    const spare = Object.keys(ru.audit.fields).filter((key) => !used.has(key));
    expect(spare).toEqual([]);
  });

  it('names the columns the two card forms actually record', () => {
    // These are the payloads of updateLead and updateDeal — the two writers
    // this round rebuilt. If one grows a column, its label is due with it.
    for (const key of [
      'name',
      'phone',
      'company',
      'note',
      'sourceId',
      'stageId',
      'ownerId',
      'nextActionAt',
      'nextActionNote',
      'title',
      'amount',
      'volumeM3',
      'weightKg',
      'currency',
    ]) {
      expect(AUDIT_FIELD_LABELS[key], `no label for ${key}`).toBeTruthy();
    }
  });
});

describe('the reference columns (round 100, item 4)', () => {
  it('every ref column also carries a human label', () => {
    // A looked-up NAME under a raw column heading is half a fix: `stageId:
    // Yangi → Yutildi` still starts with «stageId» unless the label map knows
    // the column too.
    for (const key of Object.keys(AUDIT_FIELD_REFS)) {
      expect(AUDIT_FIELD_LABELS[key], `ref column ${key} has no label`).toBeTruthy();
    }
  });

  it('only a uuid is ever looked up — codes and names pass through', () => {
    // The stored vocabulary is mixed: older writers put `warehouse: 'YW'` and
    // `stage: 'Yangi'` in the same columns the pickers now fill with ids. A
    // lookup keyed on those would print a wrong name over a right value.
    expect(isUuidShaped('a3f1c2d4-0000-4abc-8def-123456789abc')).toBe(true);
    expect(isUuidShaped('YW')).toBe(false);
    expect(isUuidShaped('GS777')).toBe(false);
    expect(isUuidShaped(null)).toBe(false);
    expect(isUuidShaped(42)).toBe(false);
    // Close but not a uuid — a truncated id must not be looked up either.
    expect(isUuidShaped('a3f1c2d4-0000-4abc-8def-123456789ab')).toBe(false);
  });

  it('collects both sides of a change, per domain, uuids only', () => {
    const stageA = '11111111-1111-4111-8111-111111111111';
    const stageB = '22222222-2222-4222-8222-222222222222';
    const owner = '33333333-3333-4333-8333-333333333333';
    const wanted = collectAuditRefs([
      { key: 'stageId', before: stageA, after: stageB },
      { key: 'ownerId', before: null, after: owner },
      // A code in a ref column stays uncollected…
      { key: 'warehouse', before: 'YW', after: 'KA' },
      // …and a non-ref column is never collected, uuid or not.
      { key: 'note', before: stageA, after: 'text' },
    ]);
    expect([...(wanted.get('stage') ?? [])].sort()).toEqual([stageA, stageB]);
    expect([...(wanted.get('user') ?? [])]).toEqual([owner]);
    expect(wanted.has('warehouse')).toBe(false);
  });
});
