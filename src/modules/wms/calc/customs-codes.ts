/**
 * Which cost types are «rastamojka» — the parse of the
 * `calc_customs_cost_type_codes` setting, in ONE place for both its readers:
 * the calc control (`customsCostCodes`, on the pool) and the cost engine
 * (`customsCostTypeIds`, which reads the row on the recompute's OWN
 * transaction, because a pool read inside it is #714's freeze). DATA and not
 * a constant: the owner mints his own cost types.
 *
 * No imports on purpose, so neither reader drags the other's module in.
 */
export const CUSTOMS_CODES_SETTING = 'calc_customs_cost_type_codes' as const;

export function parseCustomsCodes(raw: unknown): string[] {
  try {
    // The stored row is a JSON TEXT inside jsonb, and drizzle parses jsonb a
    // second time — so a row arrives as an ARRAY, while the shipped default
    // (no row) arrives as the TEXT. `String(array)` used to turn
    // ['customs', 'x'] into «customs,x», which JSON refuses, so ANY list the
    // owner saved silently read as the default (found by the yo'lkira round's
    // integration test, docs/YOLKIRA-TAQSIMOT.md). Both shapes are read.
    const parsed = (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '["customs"]'))) as unknown;
    if (!Array.isArray(parsed)) return ['customs'];
    const codes = parsed.map((c) => String(c).trim()).filter(Boolean);
    return codes.length > 0 ? codes : ['customs'];
  } catch {
    // A hand-edited setting must not take the screen down. The default IS the
    // seeded code, so a broken value degrades to the shipped behaviour.
    return ['customs'];
  }
}
