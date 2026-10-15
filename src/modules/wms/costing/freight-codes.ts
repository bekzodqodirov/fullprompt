/**
 * Which cost types the truck's cost form PRESELECTS the freight basis for —
 * the parse of `freight_tariff_cost_type_codes` (0132, his 4a), the
 * `customs-codes.ts` shape. Zero imports.
 *
 * Both shapes are read: the shipped default (no row) is the JSON TEXT and a
 * saved row arrives as an ARRAY (the row stores a JSON text in jsonb and
 * drizzle parses jsonb a second time) — the customs list's own trap.
 */
export const FREIGHT_CODES_SETTING = 'freight_tariff_cost_type_codes' as const;

export function parseFreightCodes(raw: unknown): string[] {
  try {
    const parsed = (Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '["freight"]'))) as unknown;
    if (!Array.isArray(parsed)) return ['freight'];
    return parsed.map((c) => String(c).trim()).filter(Boolean);
  } catch {
    return ['freight'];
  }
}
