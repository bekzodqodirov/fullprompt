import type {
  CustomsRefusal,
  FeeRefusal,
  FreightRefusal,
  TotalsRefusal,
} from './pricing';
import type { SealBlocker } from './workspace';

/**
 * What the AI VED hodimi says back into the staff chat.
 *
 * PURE, and separate from the work it reports on, for the reason every
 * sentence in this module is: the numbers come from the engine and the
 * words come from here, so a wording change can never move a figure and a
 * pricing change can never quietly change what the seller is told.
 *
 * Two laws it exists to keep. Law 6: never a $0 and never a silence — a
 * calculation that could not be made says WHY, in the office's own words.
 * And the owner's own answer 6, «sen aytgandek bo'lsin»: the number is
 * TAHMINIY. The official price is the seal (or the typed «Готово»), so
 * every reply that carries a figure carries that sentence beside it — the
 * seller reads this on a phone and repeats it to a customer, and the
 * difference between an estimate and a quote has to survive the retelling.
 */

/**
 * The engine's refusal codes, in the words the office uses.
 *
 * A literal map (#163): a runtime `t(\`refusal.\${reason}\`)` is invisible to
 * the i18n fence and throws at RENDER in all four locales. These are the
 * BOT's strings, so they are Uzbek here rather than in a bundle — the staff
 * bot speaks Uzbek and nothing else (staff-bot.ts's convention).
 */
/**
 * KEYED ON THE ENGINE'S OWN UNIONS, not on `string`.
 *
 * The first version was a `Record<string, string>` full of plausible words —
 * `freight_zone_required`, `weight_missing`, `tariff_missing` — and NOT ONE
 * of them is a `FreightRefusal`. `SealBlocker.reason` is typed `string`, so
 * nothing failed; the seller simply read «yo'lkira: zone_required» in
 * Telegram, on the commonest case there is, because a bot-landed request
 * carries no zone. Law 6 says a refusal is a sentence, and a code in Latin
 * letters is not one.
 *
 * `Record<Union, string>` makes the drift a COMPILE error in both
 * directions: a refusal the engine gains has no sentence until somebody
 * writes one, and a key nobody emits cannot be added.
 */
const CUSTOMS_REASON: Record<CustomsRefusal, string> = {
  baza_missing: 'baza yo‘q',
  measure_missing: 'o‘lchov (dona/m²/juft/litr) yo‘q',
  rates_missing: 'bu kodga stavka topilmadi',
  group_empty: 'guruh bo‘sh',
  not_a_number: 'raqam noto‘g‘ri',
};

const FREIGHT_REASON: Record<FreightRefusal, string> = {
  zone_required: 'yo‘nalish (zona) tanlanmagan',
  measure_missing: 'og‘irlik yoki hajm yo‘q',
  band_missing: 'bu zichlikka tarif yo‘q',
  band_ambiguous: 'tarif bandlari bir-birini bosgan',
  not_a_number: 'raqam noto‘g‘ri',
};

const FEE_REASON: Record<FeeRefusal, string> = {
  fee_fx_missing: 'so‘m kursi yo‘q',
  not_a_number: 'raqam noto‘g‘ri',
};

const TOTALS_REASON: Record<TotalsRefusal, string> = {
  discount_exceeds_total: 'chegirma jamidan katta',
  not_a_number: 'raqam noto‘g‘ri',
};

/** One blocker, as a sentence a person can act on. */
export function blockerText(b: SealBlocker): string {
  switch (b.kind) {
    case 'section_missing':
      return 'bo‘lim tanlanmagan';
    case 'no_groups':
      return 'hali birorta guruh yo‘q';
    case 'ungrouped_items':
      return `${b.count} ta tovarga TNVED kod qo‘yilmagan`;
    case 'groups_unconfirmed':
      return `${b.count} ta guruh tasdiqlanmagan (VED ✅ qiladi)`;
    // `SealBlocker.reason` is a `string`, so the lookups still fall back —
    // but the fallback is now only reachable by a value no union member
    // spells, which is a bug in the caller rather than a hole in this map.
    case 'customs':
      return (
        `${b.groupLabel}: ${CUSTOMS_REASON[b.reason as CustomsRefusal] ?? b.reason}` +
        (b.itemLabel ? ` — ${b.itemLabel}` : '')
      );
    case 'freight':
      return `yo‘lkira: ${FREIGHT_REASON[b.reason as FreightRefusal] ?? b.reason}`;
    case 'fee':
      return `bojxona yig‘imi: ${FEE_REASON[b.reason as FeeRefusal] ?? b.reason}`;
    case 'totals':
      return `jami: ${TOTALS_REASON[b.reason as TotalsRefusal] ?? b.reason}`;
    case 'customs_on_yolkira':
      return 'bu bo‘limda rastamojka hisoblanmaydi';
    default:
      return 'noma’lum';
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;

export interface PrefillReplyInput {
  /** What the engine could price, or null where it refused. */
  customsUsd: number | null;
  freightUsd: number | null;
  /** Does this section even have a freight half? */
  hasFreight: boolean;
  blockers: SealBlocker[];
  /** How much the machine did, so the VED knows what to check. */
  codesStamped: number;
  ratesPulled: number;
  importFilled: number;
  /** The card, so the seller can open it. */
  link: string | null;
  /** No key configured — the honest word, not a silent half-answer. */
  aiConfigured: boolean;
  /**
   * Rows the pass did NOT answer a baza for, and why — law 6 applied to the
   * pass's own decisions and not only to the engine's.
   *
   * `capped` are the rows past `MAX_PICK_ROWS`, never shown to the model at
   * all; `refused` are picks the model made in the wrong unit, which the
   * basis fence dropped. Both used to vanish into a log line, so a 60-line
   * invoice came back reading like a complete answer with twenty rows
   * silently baza-less.
   */
  pickCapped?: number;
  pickRefused?: number;
}

/**
 * The message itself.
 *
 * The figure comes first when there is one, because that is what the person
 * pressed the button for; the caveat travels WITH it on the same line, so a
 * screenshot of the number cannot lose the word «tahminiy». What the machine
 * did is a quiet second line, and what is still missing is named — never a
 * count, always the words, because «3 ta muammo» is not something a seller
 * can do anything about.
 */
export function prefillReplyText(input: PrefillReplyInput): string {
  const lines: string[] = [];
  const priced = input.customsUsd !== null || input.freightUsd !== null;

  if (priced) {
    const parts: string[] = [];
    if (input.customsUsd !== null) parts.push(`rastamojka ~${money(input.customsUsd)}`);
    if (input.freightUsd !== null) parts.push(`yo‘lkira ~${money(input.freightUsd)}`);
    lines.push(`🧮 Tahminiy: ${parts.join(' · ')}`);
    lines.push('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
  } else {
    lines.push('🧮 Hozircha hisoblab bo‘lmadi.');
  }

  // Freight the section HAS but the engine could not price is named as a
  // gap rather than left out: «rastamojka ~$248» alone reads as the whole
  // price on a podklyuch quote.
  if (input.hasFreight && input.freightUsd === null && priced) {
    lines.push('Yo‘lkira hali hisoblanmadi.');
  }

  const did: string[] = [];
  if (input.codesStamped) did.push(`${input.codesStamped} ta kod`);
  if (input.ratesPulled) did.push(`${input.ratesPulled} ta stavka`);
  if (input.importFilled) did.push(`${input.importFilled} ta baza (import)`);
  if (did.length) lines.push(`AI qo‘ydi: ${did.join(' · ')}`);

  if (!input.aiConfigured) lines.push('AI sozlanmagan — faqat yozilganidan o‘qildi.');

  // What the pass did not reach, named. A count is enough here — the rows
  // themselves are on the screen, and the seller's action either way is the
  // same: the VED finishes it.
  const left: string[] = [];
  if (input.pickCapped) left.push(`${input.pickCapped} ta qator ko‘rilmadi (juda ko‘p)`);
  if (input.pickRefused) left.push(`${input.pickRefused} ta taklif o‘lchovi mos kelmadi`);
  if (left.length) lines.push(`Bazasi qo‘yilmadi: ${left.join(' · ')}`);

  const missing = input.blockers.map(blockerText);
  if (missing.length) {
    lines.push(`Yetishmayapti: ${missing.slice(0, 6).join('; ')}${missing.length > 6 ? '; …' : ''}`);
  }

  if (input.link) lines.push(input.link);
  return lines.join('\n');
}
