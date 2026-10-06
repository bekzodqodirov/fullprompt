import { describe, expect, it } from 'vitest';
import type { RegistryAnswerRow } from '@/modules/wms/calc/chain';

/**
 * A Готово ANSWER on the history (the owner's 8a, docs/VED-TARIX.md §4) is
 * one typed figure in its own currency. It must never grow a V number, a
 * per-unit price or a recomputed customs sum — each would be a number nobody
 * sealed, printed as if somebody had (#780).
 *
 * The key list is pinned by the TYPE: `satisfies Record<keyof …, true>`
 * refuses a missing key and the object literal refuses an extra one, so a new
 * field on the row is a compile error here until somebody decides it.
 */
const KEYS = {
  kind: true,
  entityType: true,
  entityId: true,
  cardLabel: true,
  dealCode: true,
  leadOwnerId: true,
  requestId: true,
  answeredAt: true,
  answeredByName: true,
  section: true,
  amount: true,
  currency: true,
  sellerNote: true,
  internalNote: true,
  superseded: true,
  supersededByNo: true,
  recalcOpen: true,
  childState: true,
} satisfies Record<keyof RegistryAnswerRow, true>;

describe('an answer row on the history', () => {
  it('carries no version, no per-unit money and no customs sum', () => {
    const keys = Object.keys(KEYS);
    for (const banned of ['quoteNo', 'versionNo', 'totalUsd', 'perM3Usd', 'perKgUsd', 'customsUsd', 'discountUsd']) {
      expect(keys, banned).not.toContain(banned);
    }
  });
});
