import { clipText } from '../../platform/telegram/format';
import { prettyPhone } from '../client-cabinet/bot-text';

/**
 * The words of the two advert-lead pushes (0113) — written up front in the
 * sellers' Uzbek like every other staff message (#164), stored whole as the
 * notification's plain text, and turned into Telegram HTML only by the drain
 * (which escapes it: the name and the note come off a PUBLIC form).
 *
 * Pure, so every variant is provable without a database or a Telegram.
 */

/** How much of what the person wrote rides in the push — the card has it all. */
export const NOTE_CLIP = 160;
/** Leads one owner reminder names before «…va yana N ta». */
export const UNTOUCHED_LINES = 8;

export type ArrivalKind = 'created' | 'joined' | 'client' | 'reassigned';

/**
 * Why the push went to the OFFICE instead of a seller — said in the message,
 * because the owner reading it is the only person who can fix the cause.
 */
export type Orphan = 'unowned' | 'inactive' | 'no_manager';

export interface ArrivalText {
  kind: ArrivalKind;
  sourceName: string;
  name: string | null;
  /** As the person typed it — the ledger keeps only the last nine digits. */
  phone: string | null;
  /** The MAPPED kub only: a volume guessed from free text routes a lead and is never printed as a fact (inbound.ts). */
  volumeM3: number | null;
  note: string | null;
  clientCode?: string | null;
  orphan?: Orphan | null;
  /** The departed owner's name, for `inactive`. */
  ownerName?: string | null;
  /** The card — last, so the drain lifts it into «↗️ Ochish». */
  link: string | null;
}

function kub(value: number): string {
  // 12.500 → «12.5», 3 → «3»: a person writes a volume without trailing zeros.
  return String(Math.round(value * 1000) / 1000);
}

function who(name: string | null, phone: string | null): string {
  const parts = [name?.trim() || null, phone?.trim() ? prettyPhone(phone) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

const ORPHAN_LINE: Record<Orphan, (ownerName: string | null) => string> = {
  unowned: () => '⚠️ Egasiz — taqsimotni tekshiring',
  inactive: (ownerName) => `⚠️ Egasi${ownerName ? ` (${ownerName})` : ''} ishlamaydi — boshqa sotuvchiga bering`,
  no_manager: () => '⚠️ Mijozning menejeri yo‘q',
};

/** The instant push: the seller's, or the office's when there is no seller. */
export function inboundLeadText(t: ArrivalText): string {
  const title: Record<ArrivalKind, string> = {
    created: `🆕 Yangi lid · ${t.sourceName}`,
    joined: `🔁 Qayta yozdi · ${t.sourceName}`,
    reassigned: `🆕 Lid sizga berildi · ${t.sourceName}`,
    client: t.clientCode
      ? `📣 Mijoz ${t.clientCode} reklamadan yozdi · ${t.sourceName}`
      : `📣 Mijoz reklamadan yozdi · ${t.sourceName}`,
  };
  const lines = [title[t.kind], who(t.name, t.phone)];
  if (t.volumeM3 !== null && Number.isFinite(t.volumeM3) && t.volumeM3 > 0) {
    lines.push(`📦 ${kub(t.volumeM3)} kub`);
  }
  const note = t.note?.trim();
  if (note) lines.push(`«${clipText(note, NOTE_CLIP)}»`);
  if (t.orphan) lines.push(ORPHAN_LINE[t.orphan](t.ownerName ?? null));
  if (t.link) lines.push(t.link);
  return lines.join('\n');
}

/**
 * Whether the seller's instant push reached them — the owner's reminder says
 * it, because «nobody called» and «nobody was told» want different answers.
 */
export type Delivery = 'sent' | 'queued' | 'failed' | 'not_linked' | 'muted' | 'inactive' | 'none';

const DELIVERY_WORDS: Record<Delivery, string> = {
  sent: '📨 xabar yetgan',
  queued: '⏳ xabar navbatda',
  failed: '⚠️ xabar yetmadi',
  not_linked: '📵 Telegrami ulanmagan',
  muted: '🔕 bu xabarlarni o‘chirib qo‘ygan',
  inactive: '⛔ ishlamaydi',
  none: 'xabar bormagan',
};

/** A notification row's settlement as a `Delivery` — its drain's own words. */
export function deliveryOf(status: string | null, error: string | null): Delivery {
  if (status === null) return 'none';
  if (status === 'sent') return 'sent';
  if (status === 'pending' || status === 'sending') return 'queued';
  if (status === 'failed') return 'failed';
  if (status === 'muted') {
    if (error === 'telegram not linked') return 'not_linked';
    if (error === 'user deactivated') return 'inactive';
    return 'muted';
  }
  return 'none';
}

export interface UntouchedLine {
  name: string | null;
  phone: string | null;
  sourceName: string;
  /** The lead's CURRENT owner — the person who should act now. */
  ownerName: string | null;
  delivery: Delivery;
  link: string | null;
}

/**
 * ONE reminder for a whole sweep (design judge, 9): every overnight lead falls
 * due at the same morning minute, and ten separate messages at 09:15 are a
 * phone the owner learns to put face down.
 *
 * «tizimda qayd yo'q», never «nobody called»: a call from a phone without the
 * calls app is invisible here, and the sentence must not accuse somebody the
 * system simply could not see.
 */
export function untouchedText(
  lines: UntouchedLine[],
  opts: { minutes: number; ledgerLink: string | null },
): string {
  const head =
    lines.length === 1
      ? `⏰ Reklama lidi ${opts.minutes} daqiqadan beri tegilmagan — tizimda qayd yo‘q`
      : `⏰ ${lines.length} ta reklama lidi ${opts.minutes} daqiqadan beri tegilmagan — tizimda qayd yo‘q`;
  const owner = (l: UntouchedLine) =>
    l.ownerName ? `Egasi: ${l.ownerName} — ${DELIVERY_WORDS[l.delivery]}` : 'Egasi yo‘q — taqsimotni tekshiring';

  if (lines.length === 1) {
    const l = lines[0]!;
    return [head, `${who(l.name, l.phone)} · ${l.sourceName}`, owner(l), ...(l.link ? [l.link] : [])].join('\n');
  }
  const shown = lines.slice(0, UNTOUCHED_LINES);
  const out = [head];
  for (const l of shown) {
    out.push(`• ${who(l.name, l.phone)} · ${l.sourceName}`, `  ${owner(l)}`);
    if (l.link) out.push(`  ${l.link}`);
  }
  if (lines.length > shown.length) out.push(`…va yana ${lines.length - shown.length} ta`);
  if (opts.ledgerLink) out.push(opts.ledgerLink);
  return out.join('\n');
}
