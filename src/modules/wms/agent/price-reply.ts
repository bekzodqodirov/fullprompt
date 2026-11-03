import type { AgentLocale } from './locale';

/**
 * «💵 Narx yozaman» — the sentence his typed price becomes (his 6 b,
 * 2026-10-24: «mijozga faqat narx, bitim kartasiga hech narsa yozilmaydi»).
 *
 * Deterministic and pure: no model sits between his number and the customer,
 * and nothing here reads the deal, the seal or the VED's answer — the ONLY
 * figure in the sentence is the one he typed, printed the way a person in
 * that language writes a price (thousands grouped, «$»), beside the section
 * the customer asked about. No other digit appears in any locale, so the
 * card's «🔢 Raqamlar» and the customer read exactly one number.
 *
 * Six locales — the agent's own (uz Latin, uz Cyrillic, ru, en, fa, zh).
 * A request with no section says «narx» alone rather than guessing one.
 */

export type PriceSection = 'yolkira' | 'rastamojka' | 'podklyuch';

const SECTION_WORDS: Record<AgentLocale, Record<PriceSection, string>> = {
  uz: {
    yolkira: 'yo‘lkira',
    rastamojka: 'rastamojka',
    podklyuch: 'podklyuch (yo‘lkira va rastamojka)',
  },
  uz_cyrl: {
    yolkira: 'йўлкира',
    rastamojka: 'растаможка',
    podklyuch: 'подключ (йўлкира ва растаможка)',
  },
  ru: {
    yolkira: 'доставка',
    rastamojka: 'растаможка',
    podklyuch: 'под ключ (доставка и растаможка)',
  },
  en: {
    yolkira: 'freight',
    rastamojka: 'customs clearance',
    // Podklyuch is the road AND the customs — never «door-to-door», which states door delivery, one of
    // the website's extras his ⭐8 says nobody promises (final review K31; `promiseHits` flags it).
    podklyuch: 'turnkey (freight and customs clearance)',
  },
  fa: {
    yolkira: 'حمل و نقل',
    rastamojka: 'ترخیص گمرکی',
    podklyuch: 'کامل (حمل و نقل و ترخیص گمرکی)',
  },
  zh: {
    yolkira: '运费',
    rastamojka: '清关',
    podklyuch: '全包（运费和清关）',
  },
};

/** The sentence around the figure; `{s}` the section, `{a}` the amount. */
const SENTENCE: Record<AgentLocale, { withSection: string; bare: string }> = {
  uz: { withSection: 'Hisob tayyor: {s} narxi — {a}.', bare: 'Hisob tayyor: narxi — {a}.' },
  uz_cyrl: { withSection: 'Ҳисоб тайёр: {s} нархи — {a}.', bare: 'Ҳисоб тайёр: нархи — {a}.' },
  ru: { withSection: 'Расчёт готов: {s} — {a}.', bare: 'Расчёт готов: стоимость — {a}.' },
  en: { withSection: 'Your quote is ready: {s} — {a}.', bare: 'Your quote is ready: {a}.' },
  fa: { withSection: 'محاسبه آماده است: {s} — {a}.', bare: 'محاسبه آماده است: قیمت — {a}.' },
  zh: { withSection: '报价已出：{s} — {a}。', bare: '报价已出：{a}。' },
};

/**
 * The amount as a person writes it: whole thousands grouped (a no-break space
 * where the language groups by space, a comma where it groups by comma), two
 * decimals only when he typed cents, and the dollar sign where that language
 * puts it.
 */
export function priceAmountText(locale: AgentLocale, amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const bySpace = locale === 'uz' || locale === 'uz_cyrl' || locale === 'ru';
  const group = bySpace ? ' ' : ',';
  const decimal = bySpace ? ',' : '.';
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/gu, group);
  const figure = frac === 0 ? grouped : `${grouped}${decimal}${String(frac).padStart(2, '0')}`;
  return locale === 'en' || locale === 'zh' ? `$${figure}` : `${figure} $`;
}

/** His price, as the customer reads it. */
export function priceReplyText(locale: AgentLocale | null, section: string | null, amount: number): string {
  const l: AgentLocale = locale ?? 'uz';
  const known = section === 'yolkira' || section === 'rastamojka' || section === 'podklyuch' ? section : null;
  const a = priceAmountText(l, amount);
  const s = SENTENCE[l];
  return known ? s.withSection.replace('{s}', SECTION_WORDS[l][known]).replace('{a}', a) : s.bare.replace('{a}', a);
}
