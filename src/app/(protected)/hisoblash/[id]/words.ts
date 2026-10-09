import type { useTranslations } from 'next-intl';
import { unitWordKey } from '@/modules/wms/calc/units';

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

/** The engine's refusal with its detail (2026-10-09) — the shape both
 * `CustomsRefusalDetail` and the seal panel's customs blocker carry. */
export interface RefusalDetail {
  reason: string;
  itemSeq?: number;
  itemLabel?: string;
  unit?: string;
  half?: 'baza' | 'duty' | 'excise';
  rate?: number | null;
}

const rateText = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(4)));

/**
 * «3-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona» — WHICH
 * row, WHICH figure and WHY, or null when the refusal is not a missing
 * figure. The owner's kg-and-dona rows (2026-10-09) used to read «o‘lchov
 * yo‘q» with nothing to say whether the count or the weight was wanted; the
 * engine now names both, and this is the screen's one sentence for it (the
 * bot's twin is `needPhraseUz`, built from the same three facts).
 */
export function measureNeedText(t: CalcT, d: RefusalDetail): string | null {
  if (d.reason !== 'measure_missing' || !d.unit || !d.half) return null;
  const key = unitWordKey(d.unit);
  if (key === null) return null;
  const unit = t(`units.${key}` as 'units.dona');
  const why =
    d.half === 'baza'
      ? t('needs.why.baza', { unit })
      : t(`needs.why.${d.half}` as 'needs.why.duty', { rate: rateText(d.rate), unit });
  return t('needs.sentence', {
    row: d.itemSeq === undefined ? '—' : String(d.itemSeq),
    label: d.itemLabel ?? '',
    what: t(`needs.what.${key}` as 'needs.what.dona'),
    why,
  });
}

/** A customs refusal as one line: the detailed sentence when the engine named
 * a missing figure, else the reason's own word. */
export function customsRefusalText(t: CalcT, d: RefusalDetail): string {
  return measureNeedText(t, d) ?? refusalWord(t, d.reason);
}
