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
