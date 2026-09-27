import { getTranslations } from 'next-intl/server';

/**
 * Short month names from the bundles, never from `Intl`: Chromium ships no
 * Uzbek month names and prints «M08» (#678). The twelve calls are LITERAL so
 * the i18n-keys tripwire can see every one of them (#163).
 */
export async function monthNames(): Promise<string[]> {
  const t = await getTranslations('dashboard');
  return [
    t('months.m01'),
    t('months.m02'),
    t('months.m03'),
    t('months.m04'),
    t('months.m05'),
    t('months.m06'),
    t('months.m07'),
    t('months.m08'),
    t('months.m09'),
    t('months.m10'),
    t('months.m11'),
    t('months.m12'),
  ];
}

/** «Sen 26» for 2026-09; the year only where it helps (January, or asked). */
export function monthLabel(names: string[], month: string, withYear = false): string {
  const name = names[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear || month.endsWith('-01') ? `${name} ${month.slice(2, 4)}` : name;
}

/**
 * «27 Sen» for 2026-09-27 — a day on a chart's axis and in its tip, from the
 * same bundle names as the months and for the same reason (#678). The day is
 * written without its leading zero, as a person writes it. A string that is
 * not a date comes back unchanged rather than as «NaN undefined».
 */
export function dayLabel(names: string[], day: string): string {
  const name = /^\d{4}-\d{2}-\d{2}$/.test(day) ? names[Number(day.slice(5, 7)) - 1] : undefined;
  return name ? `${Number(day.slice(8, 10))} ${name}` : day;
}
