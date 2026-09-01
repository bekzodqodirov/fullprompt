import { CALC_SECTIONS, type CalcField, type CalcSection } from './intake';

/**
 * The screen's names for the bot's own vocabulary.
 *
 * `SECTION_LABEL` and `FIELD_LABEL` in `intake.ts` are Telegram strings —
 * hard-coded Uzbek with emoji, right for a bot message and wrong for four
 * locales. These maps say WHICH bundle key names each value, so the set stays
 * defined in one place (`CALC_SECTIONS`, `REQUIRED_FIELDS`) and the words stay
 * translatable. Same shape as `BRIDGE_LABELS`/`FEED_LABELS` (#163), and
 * anchored the same way in `tests/unit/locales.test.ts`: a runtime key like
 * `t(\`sections.\${section}\`)` is invisible to the i18n tripwire, so the map
 * is what a test can walk.
 */
export const SECTION_LABELS: Record<CalcSection, string> = {
  yolkira: 'sections.yolkira',
  rastamojka: 'sections.rastamojka',
  podklyuch: 'sections.podklyuch',
};

export const FIELD_LABELS: Record<CalcField, string> = {
  fromCity: 'fields.fromCity',
  toCity: 'fields.toCity',
  weightKg: 'fields.weightKg',
  volumeM3: 'fields.volumeM3',
  goods: 'fields.goods',
};

/** A section string that came off a form or out of the database. */
export function isCalcSection(value: string | null | undefined): value is CalcSection {
  return CALC_SECTIONS.includes(value as CalcSection);
}

/**
 * Phase E1's three vocabularies, each a LITERAL lookup map (#163).
 *
 * A runtime `t(\`warnings.\${kind}\`)` is invisible to the i18n tripwire and
 * throws at RENDER in every one of the four locales, which is how a key
 * missing from all four ships — the bundle-parity test compares the bundles
 * to each other and a hole in all four matches perfectly.
 */
export const WARNING_LABELS: Record<string, string> = {
  rate_off_dictionary: 'warnings.rateOffDictionary',
  baza_off_dictionary: 'warnings.bazaOffDictionary',
  ai_low_confidence: 'warnings.aiLowConfidence',
  ai_rate_taken: 'warnings.aiRateTaken',
  rate_noted: 'warnings.rateNoted',
};

export const REFUSAL_LABELS: Record<string, string> = {
  customs_by_client: 'refusal.customsByClient',
  section_has_no_customs: 'refusal.sectionHasNoCustoms',
  unconverted: 'refusal.unconverted',
  unallocated: 'refusal.unallocated',
  no_actual_yet: 'refusal.noActualYet',
  no_actual_cost: 'refusal.noActualCost',
  cargo_incomplete: 'refusal.cargoIncomplete',
  link_implausible: 'refusal.linkImplausible',
  not_linked: 'refusal.notLinked',
};

/**
 * Why the freight band could not be looked up. A LITERAL map like the three
 * above (#163): both of these are properties of a tariff the owner edits, so
 * they are the one band case that needs words on the screen.
 */
export const BAND_REFUSAL_LABELS: Record<string, string> = {
  band_missing: 'bandRefusal.missing',
  band_ambiguous: 'bandRefusal.ambiguous',
};
