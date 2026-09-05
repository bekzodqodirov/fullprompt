import { dutyText } from './duty-text';
import type { BazaSource } from './pricing';

/**
 * The AI-VED's answer in the seller's own chat — RASTAMOJKA and nothing else.
 *
 * The owner, 2026-09-05: «telegramda AI ning o'zi tahminiy hisoblab bersin
 * rastamojka qancha bo'lishini. AI-VED faqat rastamojka hisoblaydi.»
 *
 * PURE, and separate from the work it reports on, for the reason every
 * sentence in this family is: the numbers come from the engine and the words
 * come from here, so a wording change cannot move a figure and a pricing
 * change cannot quietly change what the seller is told.
 *
 * Three laws it exists to keep.
 *
 *  - **Law 6**: never a `$0`, never a silence. A line the engine refused
 *    prints WHY, in the office's words, and the total says how many lines it
 *    covers and how many it could not.
 *  - **The owner's decision 8**: no freight, ever. A podklyuch job gets one
 *    sentence saying the VED will price the road — not a number, not a
 *    dash, and never the tariff's list price dressed as an estimate.
 *  - **The number is TAHMINIY.** The official price is the seal (or the typed
 *    «Готово»), and the caveat travels on its own line right under the total,
 *    because the seller reads this on a phone and repeats it to a customer.
 */

/** Telegram refuses a message past this; the caller never sends a longer one. */
export const TELEGRAM_LIMIT = 4096;
/** Past this many lines the list collapses — with a count, never in silence. */
export const MAX_REPLY_LINES = 25;

export interface AiVedLine {
  /** What the group is, in the seller's words — its items, joined. */
  label: string;
  code: string | null;
  /**
   * «100 dona × $20/dona» — the group's own measure and baza, when every
   * member states the same one. Null where the group is priced from mixed
   * measures: the figure is still exact, the shorthand is not.
   */
  measureText: string | null;
  /** Which of the machine's three sources answered the baza, if any. */
  bazaSource: BazaSource;
  /** The law's shape in words: «10%», «20% / min 3 $/juft». */
  dutyText: string;
  /** The band the additional duty fell in — 0 when a certificate stands. */
  addDutyPct: number;
  excisePct: number | null;
  vatPct: number | null;
  /** What this group's customs came to, or null with a reason beside it. */
  customsUsd: number | null;
  /** Already in words (`blockerText`'s vocabulary) — never a raw code. */
  refusal: string | null;
}

export interface AiVedReplyInput {
  clientLabel: string | null;
  /** The card's own code — «B-000067» — so the seller can find it. */
  cardLabel: string | null;
  lines: AiVedLine[];
  /** Items nobody has coded: named, because a total that silently drops them
   * is the defect the partial label exists to prevent. */
  ungrouped: string[];
  /** The per-DECLARATION fee (VMQ-55's BHM scale), once for the whole job. */
  fee: { bhm: number; usd: number } | null;
  /** The customs total, or null when the engine refused to make one. */
  totalUsd: number | null;
  hasCertificate: boolean;
  /** Does this job also carry a road? Then say who prices it — never price it. */
  hasFreight: boolean;
  link: string | null;
  /** No key on this server: the honest word, not a silent half-answer. */
  aiConfigured: boolean;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** The chip beside a baza — the legend below spells each one out. */
const SOURCE_MARK: Record<Exclude<BazaSource, null>, string> = {
  memory: '🧠',
  import: '📥',
  dictionary: '📖',
  typed: '',
};

const SOURCE_LEGEND: Record<Exclude<BazaSource, null>, string> = {
  memory: '🧠 avvalgi muhrdan',
  import: '📥 bojxona faylidan',
  dictionary: '📖 lug‘atdan',
  typed: '',
};

/**
 * A product name as a PHONE can read it.
 *
 * Measured on the round's own integration fixture: a real invoice
 * description is 300 characters and carries its own newlines, so the reply
 * printed «1. Нетканый материал…\n…2516 кг» and the NEXT line's number
 * appeared to belong to it. The list stopped being a list. A name is
 * collapsed to one line and cut at 60 characters with an ellipsis — the full
 * text is on the card, which the link goes to.
 */
const NAME_CAP = 60;
function shortName(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_CAP ? flat : `${flat.slice(0, NAME_CAP - 1)}…`;
}

/** One priced group, as two lines: what it is, and what the law makes of it. */
function lineText(line: AiVedLine, index: number): string {
  const head =
    `${index + 1}. ${shortName(line.label)}` +
    (line.code ? ` · ${line.code}` : '') +
    (line.measureText ? ` · ${line.measureText}` : '') +
    (line.bazaSource && SOURCE_MARK[line.bazaSource]
      ? ` ${SOURCE_MARK[line.bazaSource]}`
      : '');

  if (line.customsUsd === null) {
    // Law 6: a refusal is a sentence, and the line still exists — a seller
    // who cannot see the row cannot tell the customer what is missing.
    return `${head}\n   ⚠️ ${line.refusal ?? 'hisoblanmadi'} — VED xodimi qo‘yadi`;
  }

  const parts = [`boj ${line.dutyText}`];
  if (line.addDutyPct > 0) {
    parts.push(`qo‘shimcha boj ${line.addDutyPct}% (sertifikat yo‘q)`);
  }
  if (line.excisePct) parts.push(`aksiz ${line.excisePct}%`);
  if (line.vatPct !== null) parts.push(`QQS ${line.vatPct}%`);
  return `${head}\n   ${parts.join(' · ')} → ${money(line.customsUsd)}`;
}

export function aiVedReplyText(input: AiVedReplyInput): string {
  const head = ['🤖 AI-VED · tahminiy rastamojka']
    .concat(input.clientLabel ? [input.clientLabel] : [])
    .concat(input.cardLabel ? [input.cardLabel] : [])
    .join(' · ');
  const out: string[] = [head];

  const shown = input.lines.slice(0, MAX_REPLY_LINES);
  for (const [i, line] of shown.entries()) out.push(lineText(line, i));
  if (input.lines.length > shown.length) {
    out.push(`… va yana ${input.lines.length - shown.length} ta qator`);
  }

  if (input.ungrouped.length > 0) {
    // Named, not counted: the seller can often supply the missing code or
    // say which of the three «sumka» rows this is.
    const names = input.ungrouped.slice(0, 5).map(shortName).join(', ');
    const more = input.ungrouped.length > 5 ? ` … (+${input.ungrouped.length - 5})` : '';
    out.push(`⚠️ Kod topilmadi: ${names}${more} — VED xodimi qo‘yadi`);
  }

  if (input.fee) {
    out.push(`Deklaratsiya yig‘imi (VMQ-55): ${input.fee.bhm} BHM ≈ ${money(input.fee.usd)}`);
  }

  out.push('━━━━━━━━━━━━');
  const priced = input.lines.filter((l) => l.customsUsd !== null).length;
  const blocked = input.lines.length - priced + input.ungrouped.length;
  if (input.totalUsd === null) {
    // Never a $0 and never a silence: the total is absent BECAUSE something
    // is, and the lines above already say which.
    out.push('Rastamojka jami: hozircha hisoblab bo‘lmadi.');
  } else {
    const cover =
      blocked > 0 ? ` (${priced} ta qatordan, ${blocked} tasi hisoblanmadi)` : '';
    out.push(`Rastamojka jami${cover}: ≈ ${money(input.totalUsd)}`);
  }
  out.push('⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.');

  out.push(`📄 Sertifikat: ${input.hasCertificate ? 'bor' : 'yo‘q'} (deb hisoblandi)`);
  // Decision 8, said out loud rather than by omission: a podklyuch quote with
  // no road line reads as a complete price to somebody in a hurry.
  if (input.hasFreight) out.push('Yo‘lkirani VED xodimi hisoblaydi.');
  if (!input.aiConfigured) out.push('AI sozlanmagan — faqat yozilganidan o‘qildi.');

  // The legend names only what was actually used — a key to marks nobody can
  // see is noise on a phone.
  const used = [...new Set(input.lines.map((l) => l.bazaSource))]
    .filter((s): s is Exclude<BazaSource, null> => s !== null && SOURCE_LEGEND[s] !== '')
    .map((s) => SOURCE_LEGEND[s]);
  if (used.length > 0) out.push(used.join(' · '));

  if (input.link) out.push(`Karta: ${input.link}`);

  const text = out.join('\n');
  return text.length <= TELEGRAM_LIMIT ? text : `${text.slice(0, TELEGRAM_LIMIT - 20)}\n… (qisqartirildi)`;
}

/** Re-exported so a caller need not reach into the screen's own module. */
export { dutyText };
