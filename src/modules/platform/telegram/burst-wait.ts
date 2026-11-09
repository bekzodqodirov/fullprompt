import type { PartKind } from './task-draft';
import { armWait, readWait, type WaitEntry } from './waits';

/**
 * A burst — files or forwards sent in a row while no collection, draft or
 * capture is open (docs/IKKI-ESHIK.md §4.1, his 6a: «ketma-ket yuborilgan
 * fayllarga BITTA savol»). Ten photos of one album, then three forwarded
 * customer messages, used to draw ten «➕ Bu faylni …» and three «📌
 * Topshiriq qilamizmi?», each asked about ONE message; the press took that
 * one, and the rest needed a forward again.
 *
 * Kept as a durable one-message wait (0141's 'burst' kind, waits.ts): one per
 * chat (the PK), its parts and the ids of the ONE message that answers for it,
 * so a deploy between the album and the press loses nothing. This file is the
 * wait and its pure words — no grammy, no collector — because the doors that
 * END a burst (a collection, a draft, a capture opening) import it, and those
 * are below the burst door in the import graph. The door itself is burst.ts.
 */

/** Each part within this long of the previous one joins the burst; the row expires this long after the last. */
export const BURST_WINDOW_MS = 2 * 60_000;
/**
 * The parts one burst keeps — two albums. A part past it is COUNTED and said
 * as a line of the burst's ONE message (`BURST_FULL`), never kept and never a
 * reason to replace the burst: the row is one per chat, and a 21st part
 * opening the next burst overwrote the twenty before they were ever offered
 * (review PB-ADV-1).
 */
export const BURST_MAX_PARTS = 20;
/** A part's text, as kept: Telegram's own ceiling for one message. */
const TEXT_KEPT = 4096;

export interface BurstPart {
  messageId: number;
  forwarded: boolean;
  /** What the part carries — null for a text. Decides «fayl» (photo / document) in the words. */
  kind: PartKind | null;
  fileId: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
  /**
   * The message's own text or caption — a FORWARD's included: «➕» takes a
   * forwarded customer message as the request's material (§4.1); only the
   * task draft keeps a forward's words out of its note (access-money-12).
   */
  text: string | null;
  /** A contact card or a place, as the one line the task draft keeps. */
  fact?: string | null;
}

export interface BurstPayload {
  /** The first part's message id — which burst a draw, a take or a press is about. */
  id: number;
  /** In message order. */
  parts: BurstPart[];
  /**
   * The copies of the burst's ONE message a press may come from: the current
   * one LAST, and any older copy that could not be deleted (it stays
   * answerable, kept-last.ts `kept`).
   */
  offerIds: number[];
  /**
   * Messages that speak for this burst without being its kept-last copy: the
   * add door's «Sizda tugallanmagan yig‘ish bor…» question asked about it, so
   * its «🗑 Ha» takes the whole burst too.
   */
  aliasIds: number[];
  /** Still joinable — closed by the first update that is neither a file nor a forward, or a collector opening. */
  open: boolean;
  /** Taken by ➕, 📌 or ▶️ — no longer waiting (§4.2's clause). */
  taken: boolean;
  /** The PARKED collection its pause line was drawn beside (§4.2); null while its ONE message is the offer. */
  parkedNote: string | null;
  /**
   * Parts sent past `BURST_MAX_PARTS` while it was full — counted, said on
   * its message, not kept (absent on a row written before the cap was said).
   */
  overflow?: number;
  /**
   * The newest message the burst concerns, its parts' or an overflow's —
   * what its ONE message sits below, and what a redelivered overflow part is
   * told apart by (ids only grow).
   */
  lastSeen?: number;
  /**
   * The collection that took it (➕ or ▶️) — set BEFORE the take, so a draw
   * owed by the album never speaks for parts being taken (review PB-ADV-5).
   */
  intoNote?: string | null;
  /** 📌 took it into a task draft. */
  intoTask?: boolean;
  /**
   * What the burst this one REPLACED spoke for (one generation): its
   * message still answers a press — how many parts it offered, and where
   * they went — after its row is another burst's.
   */
  previous?: GoneBurst | null;
}

/** A replaced burst, as much of it as a press on its message needs (`BurstPayload.previous`). */
export interface GoneBurst {
  /** Its message's copies and the questions asked about it. */
  ids: number[];
  parts: number;
  intoNote: string | null;
  intoTask: boolean;
  parkedNote: string | null;
}

// ---------------------------------------------------------------------------
// Pure.
// ---------------------------------------------------------------------------

/**
 * Does a part sent at `atSec` join the stored burst? Within two minutes of the
 * previous part (the row's expiry IS the last part plus the window), still
 * open, not yet taken, and not full.
 */
export function burstJoins(entry: Pick<WaitEntry<BurstPayload>, 'payload' | 'expiresAt'> | null, atSec: number): boolean {
  return inRow(entry, atSec) && entry!.payload.parts.length < BURST_MAX_PARTS;
}

/** Would a part sent at `atSec` join the stored burst, but it is full? Then the part is its overflow. */
export function burstFull(entry: Pick<WaitEntry<BurstPayload>, 'payload' | 'expiresAt'> | null, atSec: number): boolean {
  return inRow(entry, atSec) && entry!.payload.parts.length >= BURST_MAX_PARTS;
}

function inRow(entry: Pick<WaitEntry<BurstPayload>, 'payload' | 'expiresAt'> | null, atSec: number): boolean {
  if (!entry) return false;
  const p = entry.payload;
  return p.open && !p.taken && atSec < entry.expiresAt;
}

/** The newest message the burst concerns — its last part, or a newer overflow part. */
export function burstLastSeen(p: Pick<BurstPayload, 'parts' | 'lastSeen'>): number {
  return Math.max(p.parts[p.parts.length - 1]?.messageId ?? 0, p.lastSeen ?? 0);
}

/** A part as stored: its text cut to one message. */
export function keptPart(part: BurstPart): BurstPart {
  return { ...part, text: part.text === null ? null : part.text.slice(0, TEXT_KEPT) };
}

/**
 * The burst a part opens — remembering what the one it replaces spoke for,
 * when that one drew or was asked about anything (`goneBurst`).
 */
export function freshBurst(part: BurstPart, replaced: BurstPayload | null = null): BurstPayload {
  const ids = replaced ? [...replaced.offerIds, ...replaced.aliasIds] : [];
  return {
    id: part.messageId,
    parts: [keptPart(part)],
    offerIds: [],
    aliasIds: [],
    open: true,
    taken: false,
    parkedNote: null,
    previous:
      replaced && ids.length > 0
        ? {
            ids,
            parts: replaced.parts.length,
            intoNote: replaced.intoNote ?? null,
            intoTask: replaced.intoTask ?? false,
            parkedNote: replaced.parkedNote,
          }
        : null,
  };
}

/** A part joined, in message order — a redelivered one counted once. */
export function withBurstPart(payload: BurstPayload, part: BurstPart): BurstPayload {
  if (payload.parts.some((p) => p.messageId === part.messageId)) return payload;
  return { ...payload, parts: [...payload.parts, keptPart(part)].sort((a, b) => a.messageId - b.messageId) };
}

/** A part carries a file the bot can read — what «fayl» counts in the words. */
export function isFilePart(part: Pick<BurstPart, 'kind' | 'fileId'>): boolean {
  return part.fileId !== null && (part.kind === 'photo' || part.kind === 'document');
}

export function burstCounts(parts: readonly BurstPart[]): { all: number; files: number; forwards: number } {
  return {
    all: parts.length,
    files: parts.filter(isFilePart).length,
    forwards: parts.filter((p) => p.forwarded).length,
  };
}

/** The ONE text «🔍 Qidirish» would search — only when the burst holds exactly one (§4.1). */
export function burstOneText(parts: readonly BurstPart[]): string | null {
  const texts = parts.map((p) => (p.text ?? '').trim()).filter((t) => t.length > 0);
  return texts.length === 1 ? texts[0]! : null;
}

/**
 * The offer's words (§4.1). Plain files: «➕ Bu faylni …» / «➕ 3 ta faylni …».
 * With a forward the offer is Door B's too: «📌 5 ta xabar (3 tasi fayl) —
 * topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?» — «yoki so‘rovga…» only
 * when a request is offered beside it, and one forward alone keeps Door B's
 * own question, «📌 Topshiriq qilamizmi?».
 */
export function burstOfferText(parts: readonly BurstPart[], withRequests: boolean): string {
  const { all, files, forwards } = burstCounts(parts);
  if (forwards === 0) return all === 1 ? '➕ Bu faylni so‘rovga qo‘shamizmi?' : `➕ ${all} ta faylni so‘rovga qo‘shamizmi?`;
  const ask = withRequests ? 'topshiriq qilamizmi yoki so‘rovga qo‘shamizmi?' : 'topshiriq qilamizmi?';
  if (all === 1) return `📌 ${ask.charAt(0).toUpperCase()}${ask.slice(1)}`;
  return `📌 ${all} ta xabar${files > 0 ? ` (${files} tasi fayl)` : ''} — ${ask}`;
}

/**
 * How many parts a pressed message spoke for, read off its own words — what a
 * press whose wait is gone says it could not take. One for a single-part
 * offer and for any message these words did not draw.
 */
export function offeredCount(text: string | null | undefined): number {
  const said = text ?? '';
  const n = /^➕ (\d+) ta faylni\b/u.exec(said) ?? /^📌 (\d+) ta xabar\b/u.exec(said) ?? /Hozirgi (\d+) ta xabar\b/u.exec(said);
  return n ? Number(n[1]) : 1;
}

/** What a press whose burst is gone took — said, never silent (task-handlers.ts's album words, for a burst). */
export const BURST_GONE = '⚠ Faqat 1 ta xabar qo‘shildi — qolganlarini qaytadan yo‘naltiring.';

/**
 * A «▶️» whose burst is gone on a line that replies to NOTHING — the pause
 * line a typed table answer drew beside a waiting burst is sent with no reply
 * (it speaks for the burst by alias, review PB-SPEC-4): nothing can be taken,
 * and that is said, never a silent resume (as-built review BURST-3).
 * `BURST_GONE`'s «Faqat 1 ta xabar qo‘shildi» would be false: none was.
 */
export const BURST_NONE_TAKEN = '⚠ Bu xabarlar endi olinmaydi — qaytadan yuboring.';

/** The line a full burst's message carries for the parts past the cap — said, never dropped in silence. */
export const BURST_FULL = (over: number) =>
  `⚠ Bir martada ko‘pi bilan ${BURST_MAX_PARTS} ta xabar olinadi — qolgan ${over} tasini tugmani bosgandan keyin qaytadan yuboring.`;

/**
 * A FULL burst whose ONE message has only «📌» (no request to join, no parked
 * collection — as-built review BURST-2): its draft takes the first `cap` and
 * a resent part reaches nobody, so it says what «📌» takes — never
 * `BURST_FULL`'s «qaytadan yuboring», which is true only of a door that takes
 * the resend (a ➕ row, the pause line's ▶️).
 */
export const BURST_FULL_TASK = (cap: number) =>
  `⚠ Bir martada ko‘pi bilan ${BURST_MAX_PARTS} ta xabar olinadi — topshiriqqa birinchi ${cap} tasi qo‘shiladi.`;

/**
 * Is this burst's ONE message owed — parts no message of it was drawn below?
 * Its message sits below its newest part, so a part newer than the last copy
 * drawn is one nobody was asked about: the draw the process owed when it died
 * (as-built review BURST-8, DURABILITY-2). Only inside its window (`now`
 * before the row's expiry): a burst a day old is not asked about at boot.
 * Never a taken or an empty one. Pure.
 */
export function burstOwed(entry: Pick<WaitEntry<BurstPayload>, 'payload' | 'expiresAt'>, nowS: number): boolean {
  const p = entry.payload;
  if (p.taken || p.parts.length === 0 || nowS >= entry.expiresAt) return false;
  return burstLastSeen(p) > (p.offerIds.at(-1) ?? 0);
}

/**
 * A press on a burst a collection already filed (saved, landed), or that is
 * held by a task draft: taken once into each — a second ➕ after the save, or
 * a second 📌, would file the same parts twice (review PB-ADV-3).
 */
export const BURST_IN_REQUEST = 'Bu xabarlar allaqachon so‘rovga qo‘shilgan.';
export const BURST_IN_TASK = 'Bu xabarlar allaqachon topshiriqqa olingan.';

/** The 📌 press over the topshiriq's source cap (§4.1). */
export const BURST_TASK_CAP = (cap: number) => `⚠ Topshiriqqa birinchi ${cap} tasi qo‘shiladi.`;

/** «3 ta fayl va 2 ta xabar» — the parts a take TOOK (never the goods it added); null when it took none. */
export function takenWords(files: number, texts: number): string | null {
  if (files > 0 && texts > 0) return `${files} ta fayl va ${texts} ta xabar`;
  if (files > 0) return `${files} ta fayl`;
  if (texts > 0) return `${texts} ta xabar`;
  return null;
}

/**
 * The ids a burst answers presses from after a kept-last draw: the old copy
 * leaves unless it could not be deleted (`kept`), the new one goes LAST.
 */
export function nextOfferIds(
  ids: readonly number[],
  prior: number | null,
  drawn: { messageId: number; moved: boolean; kept: number | null },
): number[] {
  if (!drawn.moved) return ids.includes(drawn.messageId) ? [...ids] : [...ids, drawn.messageId];
  const stay = ids.filter((id) => id !== drawn.messageId && (id !== prior || drawn.kept === prior));
  return [...stay, drawn.messageId];
}

/**
 * Does this update END the burst (§4.1's one point)? Anything in the chat
 * that is neither a media message nor a forward: a typed text, a press, a
 * contact, a place. An edit or a service update is no new action.
 */
export function endsBurst(update: { message?: unknown; callbackQuery?: unknown }): boolean {
  if (update.callbackQuery) return true;
  const m = update.message as Record<string, unknown> | undefined;
  if (!m) return false;
  if (m.forward_origin) return false;
  return !(m.photo || m.document || m.voice || m.audio || m.video || m.video_note || m.animation || m.sticker);
}

// ---------------------------------------------------------------------------
// The wait.
// ---------------------------------------------------------------------------

export function readBurst(chatId: bigint | number): WaitEntry<BurstPayload> | null {
  return readWait<BurstPayload>(chatId, 'burst');
}

/**
 * A part into the chat's burst — joined, or the first of a new one. The row's
 * expiry slides to this part plus the window (armWait's merge keeps the first
 * part's time); a new burst replaces the old row, whose message then answers
 * a press with `BURST_GONE` (the press is older than the row).
 */
export function noteBurstPart(chatId: bigint, part: BurstPart, atSec: number): BurstPayload {
  const entry = readBurst(chatId);
  if (entry && entry.payload.parts.some((p) => p.messageId === part.messageId)) return entry.payload;
  if (burstJoins(entry, atSec)) {
    const payload = withBurstPart(entry!.payload, part);
    armWait(chatId, 'burst', payload, BURST_WINDOW_MS, atSec, () => true);
    return payload;
  }
  const payload = freshBurst(part, entry?.payload ?? null);
  armWait(chatId, 'burst', payload, BURST_WINDOW_MS, atSec);
  return payload;
}

/**
 * A part past a FULL burst's cap (`burstFull`): counted once (a redelivered
 * one is no newer than what was seen), and the expiry slides with it — it was
 * sent in a row with the burst. The burst itself stands.
 */
export function noteOverflow(chatId: bigint, part: Pick<BurstPart, 'messageId'>, atSec: number): BurstPayload | null {
  const entry = readBurst(chatId);
  if (!entry) return null;
  const p = entry.payload;
  if (part.messageId <= burstLastSeen(p)) return p;
  const payload = { ...p, overflow: (p.overflow ?? 0) + 1, lastSeen: part.messageId };
  armWait(chatId, 'burst', payload, BURST_WINDOW_MS, atSec, () => true);
  return payload;
}

/**
 * Rewrite THIS burst's payload, its times kept (a merge with a one-second
 * life cannot move the expiry). Null when the row is gone or is another
 * burst's by now.
 */
export function rewriteBurst(chatId: bigint, id: number, change: (p: BurstPayload) => BurstPayload): BurstPayload | null {
  const entry = readBurst(chatId);
  if (!entry || entry.payload.id !== id) return null;
  const payload = change(entry.payload);
  armWait(chatId, 'burst', payload, 1_000, entry.armedAt, () => true);
  return payload;
}

/**
 * End the chat's burst: the next part opens a new one. Its parts stay — the
 * message it drew still acts on them, and a redelivered press of it must find
 * them to be the no-op it is. A memory read when there is nothing open, so
 * every update can ask.
 */
export function endBurst(chatId: bigint): void {
  const entry = readBurst(chatId);
  if (!entry || !entry.payload.open) return;
  rewriteBurst(chatId, entry.payload.id, (p) => ({ ...p, open: false }));
}

/** The burst a press on `pressedId` acts on — its ONE message, an older copy, or a question asked about it. */
export function burstAnswering(chatId: bigint, pressedId: number): BurstPayload | null {
  const entry = readBurst(chatId);
  if (!entry) return null;
  const p = entry.payload;
  return p.offerIds.includes(pressedId) || p.aliasIds.includes(pressedId) ? p : null;
}

/**
 * The burst a newer one REPLACED, when the press is on its message: its
 * parts are gone with its row, so the press takes what the message replies to
 * — and knows how many it spoke for (to say so) and where they went (not to
 * file them twice). Null for any other message.
 */
export function goneBurst(chatId: bigint, pressedId: number): GoneBurst | null {
  const gone = readBurst(chatId)?.payload.previous ?? null;
  return gone && gone.ids.includes(pressedId) ? gone : null;
}

/** A message that speaks for the burst (the add door's question about it). */
export function aliasBurst(chatId: bigint, id: number, messageId: number): void {
  rewriteBurst(chatId, id, (p) => (p.aliasIds.includes(messageId) ? p : { ...p, aliasIds: [...p.aliasIds, messageId] }));
}

/**
 * The burst was taken — into the collection `note` (➕, ▶️) or a task draft:
 * it waits for nothing any more, and remembers where it went (each taker
 * refuses a second take into its own kind, `BURST_IN_REQUEST` /
 * `BURST_IN_TASK`). A collection and a task may both take it, as Door B's
 * single offer always let ➕ and 📌 both act on one forward.
 */
export function markBurstTaken(chatId: bigint, id: number, into: { note: string } | { task: true }): void {
  rewriteBurst(chatId, id, (p) => ({
    ...p,
    taken: true,
    open: false,
    ...('note' in into ? { intoNote: into.note } : { intoTask: true }),
  }));
}

/**
 * Is a burst WAITING beside this parked collection — drawn as its pause line
 * and not yet taken? Then the pause line for a typed text does not invite a
 * reply to the table (§4.2): a reply resumes the collection without the parts.
 */
export function burstWaiting(chatId: bigint, parkedNote: string): boolean {
  return waitingBurst(chatId, parkedNote) !== null;
}

/** The burst `burstWaiting` answers about — what a second line beside it must speak for (review PB-SPEC-4). */
export function waitingBurst(chatId: bigint, parkedNote: string): BurstPayload | null {
  const entry = readBurst(chatId);
  if (!entry) return null;
  const p = entry.payload;
  return !p.taken && p.parts.length > 0 && p.parkedNote === parkedNote ? p : null;
}
