import type {
  BazaBasis,
  CustomsRefusal,
  DutyUnit,
  FeeRefusal,
  FreightRefusal,
  TotalsRefusal,
} from './pricing';
import { needPhraseUz, needUnitOf } from './needs';
import type { SealBlocker } from './workspace';
import {
  SMALL_ROAD_LINE,
  fitTelegram,
  money,
  roadRefusalLine,
  routeWords,
  type AiVedFreight,
} from './ai-reply';
import { TARIFF_REPLY_HEAD, VED_ESTIMATE_MARK } from './reply-heads';

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
  measure_missing: 'o‘lchov (dona/kg/kub/m²/juft/litr) yo‘q',
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

// Each names whose job it is (P2.6): the rate is the accountant's, the BHM
// setting the admin's — «raqam noto‘g‘ri» sent the VED looking through their
// own cells for a number they do not own.
const FEE_REASON: Record<FeeRefusal, string> = {
  fee_fx_missing: 'so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi',
  fee_bhm_bad: 'BHM sozlamasi noto‘g‘ri — admin tuzatadi',
  not_a_number: 'raqam noto‘g‘ri',
};

const TOTALS_REASON: Record<TotalsRefusal, string> = {
  discount_exceeds_total: 'chegirma jamidan katta',
  not_a_number: 'raqam noto‘g‘ri',
};

/** A road the engine refused, in the office's words (the AI reply's line). */
export function freightRefusalText(reason: FreightRefusal): string {
  return FREIGHT_REASON[reason] ?? reason;
}

/** A declaration fee the engine refused — the AI reply's fee line (P2.9). */
export function feeRefusalText(reason: FeeRefusal): string {
  return FEE_REASON[reason] ?? reason;
}

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
      // The engine names WHICH row and WHICH figure (2026-10-09): «o‘lchov
      // yo‘q» alone left the seller guessing between a count and a weight on
      // exactly the kg-and-dona rows the owner asked about.
      if (b.reason === 'measure_missing' && b.unit && b.half) {
        const row = b.itemSeq !== undefined ? ` ${b.itemSeq}-qator` : '';
        const label = b.itemLabel ? ` «${b.itemLabel}»` : '';
        return `${b.groupLabel}:${row}${label}: ${needPhraseUz({
          unit: needUnitOf(b.unit as BazaBasis | DutyUnit),
          why: b.half,
          rate: b.rate ?? null,
        })}`;
      }
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

/**
 * A yolkira job's answer (his 2.5 b, 2026-10-21): «yo'lkira so'rovi bo'lsa,
 * tarif bo'yicha darhol javob bersin» — straight from the tariff table, with
 * no model call at all, on its own queue so it never waits behind a customs
 * pass (docs/SAKKIZ-R2.md §2.4, §6.8).
 *
 * It replaces `prefillReplyText`, the summary a freight-only job used to get
 * («🧮 Tahminiy: yo‘lkira ~$…»), which had no other caller once the customs
 * jobs moved to the AI-VED's per-line reply: one road, one set of words
 * (`ai-reply.ts`'s route and refusal lines), so the yolkira reply and the
 * podklyuch reply cannot say two things about the same truck (#513).
 *
 * Never «rastamojka», never «AI», never a budget: this pass makes no model
 * call and a yolkira job has no customs half.
 */
export interface TariffReplyInput {
  clientLabel: string | null;
  cardLabel: string | null;
  /** `freightAnswerFor`'s answer — a yolkira job always has a road. */
  freight: AiVedFreight;
  link: string | null;
  /** The card's copy carries the VED's line under its heading when the zone was guessed. */
  audience: 'chat' | 'lenta';
}

export function tariffReplyText(input: TariffReplyInput): string {
  const f = input.freight;
  const title = [`${TARIFF_REPLY_HEAD} (tarif bo‘yicha)`]
    .concat(f.ok ? ['taxminiy'] : [])
    .concat(input.clientLabel ? [input.clientLabel] : [])
    .concat(input.cardLabel ? [input.cardLabel] : [])
    .join(' · ');
  const out = [title];
  if (f.ok && f.zoneGuessed && input.audience === 'lenta') {
    // The VED's line (§2.6), worded for the one thing a yolkira guess leaves
    // him to do: choose the zone before he prices it.
    out.push(`${VED_ESTIMATE_MARK} zona «${f.zoneReadFrom ?? ''}»dan taxmin, rasmiy emas — zonani o‘zingiz tanlang.`);
  }
  if (f.ok) {
    out.push(routeWords(f));
    out.push(f.bandText);
    out.push(`Yo‘lkira: ≈ ${money(f.listUsd)}`);
    if (f.small) out.push(SMALL_ROAD_LINE);
    out.push('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');
  } else {
    // Law 6: a refusal is a sentence, and it says who can fix it.
    out.push(roadRefusalLine(f));
  }
  if (input.link) out.push(`Karta: ${input.link}`);
  return fitTelegram(out, [], [], []);
}
