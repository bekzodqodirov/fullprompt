'use client';

import { useTranslations } from 'next-intl';

/**
 * «Narx qaysi bitimga yoziladi» — the owner's Q8 «c» (2026-10-27: «logist
 * o'zi tanlaydi»), asked only when two or more of the client's deals ride the
 * truck (`DealCandidates.ambiguous`). ONE component for both doors that write
 * a truck price — the truck's «Narx» tab and the client's ledger — so the
 * question, its options and its words cannot drift (#513).
 *
 * - `required`, with a placeholder that is NOT disabled: a controlled select
 *   whose value matches no option is shown and posted as its first enabled
 *   option, and with a disabled placeholder that is the first DEAL (review).
 * - never `disabled` itself: a disabled select posts nothing, which the door
 *   reads as «derive» (#171).
 * - «Bitimsiz» only when some of the client's cargo aboard has no deal of
 *   his: on a truck carrying only his deals it would be option (a), which he
 *   turned down.
 * - Each option names the deal the way every deal picker does (code, title,
 *   cargo — `dealOptionLabel`), «⏳» when it carries a live «muddat», and its
 *   share of the client's cargo here when the page knows it. No money: both
 *   sights see it (law 4).
 */
export interface TruckDealOption {
  id: string;
  code: string;
  label: string;
  /** This deal's share of the client's cargo on the truck, by m³ (else kg). */
  pct: number | null;
  deferred: boolean;
}

export interface TruckDealQuestion {
  none: boolean;
  options: TruckDealOption[];
}

/** The values a question can come back with — the deals, then «bitimsiz». */
export function questionValues(question: TruckDealQuestion): string[] {
  return [...question.options.map((option) => option.id), ...(question.none ? ['none'] : [])];
}

export function TruckDealSelect({
  question,
  value,
  stale,
  onChange,
}: {
  question: TruckDealQuestion;
  /** What `shownDealChoice` says the select shows — '' when nothing stands. */
  value: string;
  /** A choice was made under a question the page no longer asks. */
  stale: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('finance');
  const chosen = question.options.find((option) => option.id === value) ?? null;
  return (
    <div className="w-full space-y-1" data-testid="truck-deal">
      <label className="block text-xs font-semibold text-ink-700">
        {t('truckDealLabel')}
        <select
          name="dealId"
          required
          className="input mt-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid="truck-deal-select"
        >
          <option value="">— {t('truckDealPick')} —</option>
          {question.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.deferred ? '⏳ ' : ''}
              {option.label}
              {option.pct !== null ? ` · ${option.pct} %` : ''}
            </option>
          ))}
          {question.none && <option value="none">{t('truckDealNone')}</option>}
        </select>
      </label>
      {stale && (
        <p className="text-xs font-semibold text-warn" data-testid="truck-deal-stale">
          {t('truckDealStale')}
        </p>
      )}
      <p className="text-xs text-ink-500" data-testid="truck-deal-line">
        {value === 'none'
          ? `→ ${t('truckDealLineNone')}`
          : chosen
            ? `→ ${chosen.pct !== null ? t('truckDealLine', { code: chosen.code, pct: chosen.pct }) : t('truckDealLineNoShare', { code: chosen.code })}`
            : t('truckDealHint')}
      </p>
      {chosen?.deferred && (
        <p className="text-xs font-semibold text-warn" data-testid="truck-deal-deferred">
          ⏳ {t('truckDealDeferred', { code: chosen.code })}
        </p>
      )}
    </div>
  );
}
