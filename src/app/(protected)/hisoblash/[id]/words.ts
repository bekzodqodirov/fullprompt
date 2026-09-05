import type { useTranslations } from 'next-intl';

/**
 * The engine's refusal codes, in the office's words — ONE home (#513).
 *
 * It lived in `calc-workspace.tsx` and the PHONE card printed a bare ⚠
 * instead (audit A31): the words existed a thousand pixels further down the
 * screen, in the seal panel's blocker list, and nowhere a thumb could reach.
 * A code in Latin letters is not a sentence (law 6), and a triangle is not
 * either.
 *
 * `t.has` first: `refusals.*` is a literal map in the bundles (#163) and a
 * reason nobody wrote a sentence for prints itself rather than throwing at
 * render in all four locales.
 */
export type CalcT = ReturnType<typeof useTranslations<'calc'>>;

export function refusalWord(t: CalcT, reason: string): string {
  return t.has(`refusals.${reason}`) ? t(`refusals.${reason}` as 'refusals.band_missing') : reason;
}
