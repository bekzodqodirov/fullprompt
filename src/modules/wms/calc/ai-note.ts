import {
  AI_CODE_MARK,
  fitTelegram,
  MAX_REPLY_LINES,
  NO_GOODS_CUSTOMS,
  TELEGRAM_LIMIT,
  lawParts,
  pickLeftLine,
  roadRefusalLine,
  vedGapsLine,
  type AiVedFreight,
  type PickLeft,
} from './ai-reply';
import type { LawAsk } from './law-asks';
import type { BazaSource } from './pricing';
import { RERUN_WORD, AI_NOTE_HEAD } from './reply-heads';
import { CUSTOMS_TAIL_WORDS, tailWords, type FreightTail } from './tail-words';

/**
 * «🤖 AI izohi (VED uchun)» — the plain door's pass, written for the VED and
 * for nobody else (docs/IKKI-ESHIK.md §2.4, his 3a: «AI faqat VED uchun kartani
 * tayyorlaydi — kodlar, stavkalar, izoh»).
 *
 * The pass on a «🧮 Hisoblatish» request still codes, groups, pulls the rates
 * and fills the bazas — the VED opens a workspace that is half done — but its
 * estimate does not reach the seller. The seller reads the card's lenta, so
 * this note carries NO MONEY at all: no customs figure, no «Aniq»/«Taxminiy»,
 * no road and no JAMI. What it carries is what the machine did and what is
 * left: each row's code and WHERE it came from, each group's law and where its
 * rates came from, how many bazas were filled and from what, the figures the
 * law still wants, and every refusal in words. The VED reads the exact figure
 * on his own screen and the 📊 statistics in its 📥 dialog, so he loses
 * nothing (§2.4); `noAsk`'s lenta tails, because nobody asks the seller.
 *
 * PURE, like the reply it stands beside (`ai-reply.ts`): the facts come from
 * the pass, the words from here.
 */

/**
 * Where a row's code came from. The first three are the INSERT's own order
 * (§3.1: the row's own code, the sealed memory, the exact-key book) as the
 * pass re-reads it; `reading` is the model's proposal while the bot READ the
 * material (`AI_CODE_NOTE` on the row); `model` is this pass's own grouping.
 */
export type CodeSource = 'row' | 'memory' | 'book' | 'reading' | 'model';

export const CODE_SOURCE_WORDS: Record<CodeSource, string> = {
  row: '📄 so‘rovning o‘zida yozilgan',
  memory: '🧠 avvalgi muhrdan',
  book: '📖 kod lug‘atidan',
  reading: '🤖 AI o‘qishda taklif qildi — tekshiring',
  model: '🤖 AI hisobda taklif qildi — tekshiring',
};

const BAZA_WORDS: Record<Exclude<BazaSource, null>, string> = {
  memory: '🧠 avvalgi muhrdan',
  import: '📥 bojxona faylidan (taxmin)',
  dictionary: '📖 lug‘atdan',
  typed: 'qo‘lda',
};

const RATE_WORDS: Record<'dictionary' | 'typed', string> = {
  dictionary: 'stavka 📖 lug‘atdan',
  typed: 'stavka qo‘lda',
};

export interface AiNoteRow {
  seq: number;
  name: string;
  code: string | null;
  /** Null: coded, but where from could not be read — the code alone is said. */
  source: CodeSource | null;
}

export interface AiNoteGroup {
  label: string;
  code: string | null;
  /** The code carries `AI_CODE_NOTE` on one of its rows. */
  aiCode: boolean;
  dutyText: string;
  addDutyPct: number;
  exciseText: string | null;
  vatPct: number | null;
  /** Where its rates came from — the group's `rate_source`, read. */
  rates: 'dictionary' | 'typed' | null;
  /** How many of its rows carry a baza, by where it came from. */
  bazas: Partial<Record<Exclude<BazaSource, null>, number>>;
  /** Rows of the group with no baza at all. */
  bazaless: number;
  /** The engine's refusal, already in words (`blockerText`) — null when it priced. */
  refusal: string | null;
  refusalTail: FreightTail;
}

export interface AiNoteInput {
  clientLabel: string | null;
  cardLabel: string | null;
  pass: 'landing' | 'amend';
  rows: AiNoteRow[];
  groups: AiNoteGroup[];
  /** Rows nobody coded, by name. */
  ungrouped: string[];
  /** The figures the LAW still wants (`lawAsksOf`) — the VED's to get. */
  asks: LawAsk[];
  /**
   * The road, for its REFUSAL only. Typed so (review ADV-4): the money-free
   * note must not rest on how its input is used — a priced road, with its
   * list price on it, cannot reach this renderer at all (#790's idiom).
   */
  freight: Extract<AiVedFreight, { ok: false }> | null;
  feeRefusal: string | null;
  pickLeft: PickLeft | null;
  hasCertificate: boolean;
  aiConfigured: boolean;
  budgetSpent: boolean;
}

const NAME_CAP = 60;
const shortName = (raw: string) => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_CAP ? flat : `${flat.slice(0, NAME_CAP - 1)}…`;
};

function rowLine(r: AiNoteRow): string {
  const head = `· ${r.seq}-qator «${shortName(r.name)}»`;
  if (!r.code) return `${head} — kod yo‘q`;
  const mark = r.source === 'reading' ? ` ${AI_CODE_MARK}` : '';
  return `${head} — ${r.code}${mark}${r.source ? ` · ${CODE_SOURCE_WORDS[r.source]}` : ''}`;
}

function bazaWords(g: AiNoteGroup): string {
  const filled = (Object.keys(BAZA_WORDS) as Exclude<BazaSource, null>[])
    .filter((k) => (g.bazas[k] ?? 0) > 0)
    .map((k) => `${g.bazas[k]} ta ${BAZA_WORDS[k]}`);
  const parts = [...filled, ...(g.bazaless > 0 ? [`${g.bazaless} ta bazasiz — VED to‘ldiradi`] : [])];
  return parts.length === 0 ? '' : ` · baza: ${parts.join(', ')}`;
}

function groupLine(g: AiNoteGroup, index: number): string {
  const head =
    `${index + 1}. ${shortName(g.label)}` +
    (g.code ? ` · ${g.code}${g.aiCode ? ` ${AI_CODE_MARK}` : ''}` : '') +
    ` · ${lawParts(g)}` +
    (g.rates ? ` · ${RATE_WORDS[g.rates]}` : ' · stavka yo‘q') +
    bazaWords(g);
  // Words, never a figure: the line says what blocks, and whose it is.
  return g.refusal ? `${head}\n   ⚠️ ${g.refusal} ${tailWords(CUSTOMS_TAIL_WORDS, g.refusalTail, 'lenta', true)}` : head;
}

export function aiNoteText(input: AiNoteInput): string {
  const title = [AI_NOTE_HEAD]
    .concat(input.pass === 'amend' ? [RERUN_WORD] : [])
    .concat(input.clientLabel ? [input.clientLabel] : [])
    .concat(input.cardLabel ? [input.cardLabel] : [])
    .join(' · ');
  const head = [title];
  // What is the VED's to get goes where he reads first — the plain door asks
  // the seller nothing (§2.1, §2.7).
  const gaps = vedGapsLine(input.asks, input.freight);
  if (gaps) head.push(gaps);

  const fixed: string[] = [];
  // No goods on the request (docs/FAYL-OQISH.md §1.3 c, zero-03): said to the
  // VED in words — a note of no groups and no rows said nothing at all.
  if (input.groups.length === 0 && input.rows.length === 0 && input.ungrouped.length === 0) fixed.push(NO_GOODS_CUSTOMS);
  if (input.ungrouped.length > 0) {
    const names = input.ungrouped.slice(0, 5).map(shortName).join(', ');
    const more = input.ungrouped.length > 5 ? ` … (+${input.ungrouped.length - 5})` : '';
    fixed.push(`⚠️ Kod topilmadi: ${names}${more} — VED xodimi qo‘yadi`);
  }
  // The road's refusal in words when it is the VED's own (a zone, a tariff
  // hole, a stale total); the customer's facts are already in the gaps line.
  const f = input.freight;
  if (f && (f.stale || f.tail === 'ved')) fixed.push(roadRefusalLine({ ...f, also: undefined }, 'lenta', true));
  if (input.feeRefusal) fixed.push(`⚠️ Bojxona yig‘imi: ${input.feeRefusal}`);
  const left = pickLeftLine(input.pickLeft);
  if (left) fixed.push(left);

  const tail = [`📄 Sertifikat: ${input.hasCertificate ? 'bor' : 'yo‘q'} (deb hisoblandi)`];
  if (!input.aiConfigured) tail.push('AI sozlanmagan — faqat yozilganidan o‘qildi.');
  else if (input.budgetSpent) tail.push('AI kunlik limiti tugadi — muhrlangan xotira va bojxona faylidan to‘ldirildi.');
  return fitNote(head, input.groups, input.rows, fixed, tail);
}

/**
 * The note's own fit (review PP-SPEC-1). The AI door's answer is one line
 * per GROUP; this note carries two lists, and in fitTelegram's ONE capped
 * list the rows came first — so an invoice of 24 rows or more printed no
 * group line at all, and with it every law, rate source, baza count and
 * refusal the VED reads the note for. The GROUPS get their cap first and the
 * rows' codes their own after them, each list collapsing with its own count
 * («… va yana N ta guruh», «… va yana N ta qator kodi» — never a header
 * counted as a «qator»), and a hidden group's refusal is counted, never
 * dropped in silence. To fit Telegram the rows shrink first, then the groups;
 * the head, the fixed lines and the tail are never cut (fitTelegram's rule).
 */
function fitNote(head: string[], groups: AiNoteGroup[], rows: AiNoteRow[], fixed: string[], tail: string[]): string {
  const groupLines = groups.map(groupLine);
  const rowLines = rows.map(rowLine);
  const body = (g: number, r: number): string[] => {
    const out: string[] = [];
    if (groups.length > 0) {
      out.push('Guruhlar:', ...groupLines.slice(0, g));
      const hidden = groups.slice(g);
      if (hidden.length > 0) {
        const refused = hidden.filter((x) => x.refusal !== null).length;
        out.push(
          `… va yana ${hidden.length} ta guruh` +
            (refused > 0 ? `, ${refused} tasi hisoblanmadi — ro‘yxati VED ekranida` : ''),
        );
      }
    }
    if (rows.length > 0) {
      out.push('Kodlar:', ...rowLines.slice(0, r));
      if (rows.length > r) out.push(`… va yana ${rows.length - r} ta qator kodi`);
    }
    return out;
  };
  for (let g = Math.min(groups.length, MAX_REPLY_LINES); g >= 0; g -= 1) {
    for (let r = Math.min(rows.length, MAX_REPLY_LINES); r >= 0; r -= 1) {
      const text = [...head, ...body(g, r), ...fixed, ...tail].join('\n');
      if (text.length <= TELEGRAM_LIMIT) return text;
    }
  }
  // A head longer than the cap by itself: fitTelegram's last resort.
  return fitTelegram(head, [], fixed, tail);
}
