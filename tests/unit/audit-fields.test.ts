import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { AUDIT_FIELD_LABELS } from '@/modules/platform/audit/fields';

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
