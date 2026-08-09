/**
 * `{ism}` in a rule's task title and message text (round 85).
 *
 * The owner's third missing piece: a rule's words were fixed, so every task it
 * opened read «Mijozga qo'ng'iroq qil» and told the person nothing about WHICH
 * customer until they opened the card.
 *
 * The vocabulary is deliberately the SAME as the canned Telegram replies'
 * (`crm/templates.ts`): `{ism}` and `{kod}` mean there exactly what they mean
 * here, because two placeholder languages in one app is one too many for
 * somebody who writes both. This adds the four a rule can also answer.
 *
 * The unknown-placeholder rule is copied verbatim and matters for the same
 * reason: a placeholder nobody defined is LEFT ALONE rather than blanked,
 * since a title that happens to contain braces is somebody's text and quietly
 * deleting part of it is worse than printing it. An empty VALUE does blank its
 * own placeholder — «{ism} bilan bog'laning» about a lead with no name would
 * otherwise send the braces to a colleague.
 */

export const RULE_PLACEHOLDERS = ['ism', 'kod', 'narx', 'kub', 'kg', 'etap'] as const;
export type RulePlaceholder = (typeof RULE_PLACEHOLDERS)[number];

export type PlaceholderValues = Partial<Record<RulePlaceholder, string>>;

const PATTERN = new RegExp(`\\{(${RULE_PLACEHOLDERS.join('|')})\\}`, 'g');

/**
 * Is it worth loading the card for this text?
 *
 * The engine asks before it queries: a rule whose words carry no placeholder
 * and whose conditions are empty is answered from the event's own payload, so
 * the common case still costs no extra round trip (#432).
 */
export function hasPlaceholder(text: string): boolean {
  // A fresh regex per call: `PATTERN` carries /g and therefore `lastIndex`,
  // and a shared one would answer differently on alternate calls.
  return new RegExp(PATTERN.source).test(text);
}

export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(PATTERN, (whole, key: RulePlaceholder) => {
    const value = values[key];
    return value === undefined ? whole : value;
  });
}

/**
 * What a lead or a deal can answer.
 *
 * Numbers are printed the way the cards print them rather than as raw
 * postgres numerics: `200.00` in a task title reads as a typo, and `2.500`
 * kub reads as two and a half thousand.
 */
export function valuesFromRecord(record: {
  name?: string | null;
  clientCode?: string | null;
  amount?: string | number | null;
  volumeM3?: string | number | null;
  weightKg?: string | number | null;
  stageName?: string | null;
}): PlaceholderValues {
  return {
    ism: record.name ?? '',
    kod: record.clientCode ?? '',
    narx: num(record.amount),
    kub: num(record.volumeM3),
    kg: num(record.weightKg),
    etap: record.stageName ?? '',
  };
}

function num(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  // Trailing zeros off: postgres hands back `200.00` and `2.500`, and neither
  // is what anybody would write down.
  return String(n);
}
