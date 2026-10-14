/**
 * The freight refusals' PLACEHOLDERS, and the held reasons' words — pure
 * literals (docs/YOLKIRA-TAQSIMOT.md §5, §6.2), so the panel can import them
 * and `tests/unit/freight-errors.test.ts` can hold three things equal: each
 * bundle message's `{placeholders}`, each literal `new CostError('<code>', {…})`
 * site's keys, and this list. A missing ICU value is otherwise a silent
 * fallback on a person's screen (#925).
 */
export const FREIGHT_ERROR_PARAMS = {
  freight_batch_only: [],
  freight_on_customs: [],
  freight_no_column: ['warehouse'],
  freight_zone_unpriced: ['warehouse', 'column', 'date'],
  freight_tariff_gap: ['column', 'from', 'to'],
  freight_tariff_top: ['column', 'from'],
  freight_tariff_overlap: ['column', 'at'],
  freight_tariff_invalid: ['column'],
  freight_changed: ['column', 'from'],
} as const satisfies Record<string, readonly string[]>;

/**
 * A held bill's reason → its sentence (`costing.*`). A LITERAL record, never a
 * template string: a key built at runtime is invisible to the i18n fence
 * (#163). The two copy reasons share one sentence.
 */
export const HELD_KEY = {
  copy_missing: 'freightHeldCopy',
  copy_invalid: 'freightHeldCopy',
  on_customs: 'freightHeldCustoms',
} as const satisfies Record<'copy_missing' | 'copy_invalid' | 'on_customs', string>;
