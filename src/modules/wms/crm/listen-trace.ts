/**
 * Two things the listener's live path was missing (the owner, 2026-10-29:
 * «AI habarni kormayabti» — a client wrote to his new number and nothing
 * happened, and nothing in the log said why).
 *
 * 1. `chatOfMessage` — gramjs builds a live private text from an
 *    `UpdateShortMessage`, which names the sender by id ALONE and carries no
 *    user. `Message.getChat()` then answers from the entity cache only, and
 *    its own fallback (`getInputChat`, a walk of the newest hundred dialogs)
 *    is short-circuited whenever no chat object exists at all
 *    (`tl/custom/chatGetter.js`: `!this._chat || …` never reaches it). The
 *    cache is in memory and empty at every start, and the daily dialog walk
 *    that fills it runs once a day, so a customer who writes after an
 *    ordinary restart resolved to NOTHING — `peerFromChat(undefined)` is a
 *    peer with id 0, «not private», and the line was dropped with the groups
 *    and channels: not stored, not on the tray, not in the log. A NEW number
 *    (his) has almost nothing cached, which is where it bites first.
 *    So: ask the chat, and when there is none, walk the newest dialogs the
 *    way gramjs itself would (the line that just arrived is at the top of
 *    that list), and as a last resort ask Telegram for the user by its peer.
 *
 * 2. `passedLine` — the words for a line the listener decided not to keep,
 *    printed ONLY for an inbound line on the account the AI speaks from: that
 *    number is the company's (he bought it for clients), and «why did the AI
 *    not see this» has to be answerable from the log. Never a word of the
 *    message, never a name; the chat and the number by their last four
 *    digits, which is enough for him to recognise the customer he asked to
 *    write and nothing a reader of the log could ring.
 */

/** What the live handler needs of a gramjs message to find its chat. */
export interface ChatSource {
  getChat?: () => Promise<unknown>;
  getInputChat?: () => Promise<unknown>;
  peerId?: unknown;
}

export interface ResolvedChat {
  chat: unknown;
  /** True when every way of asking came back empty — the caller logs it. */
  unresolved: boolean;
  /** How it was found: 'direct' (the cache), 'dialogs' (gramjs's walk), 'entity' (asked by id). */
  via: 'direct' | 'dialogs' | 'entity' | null;
}

/** A user peer is the only kind a short update leaves bare; groups and channels arrive with their chat. */
function isUserPeer(peerId: unknown): boolean {
  return (peerId as { className?: unknown } | null | undefined)?.className === 'PeerUser';
}

async function quietly<T>(work: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (!work) return undefined;
  try {
    return await work();
  } catch {
    return undefined;
  }
}

/**
 * The chat a live message belongs to — the cache first, then the newest
 * dialogs, then Telegram itself. Never throws: a chat that cannot be found is
 * an answer the caller acts on (`unresolved`), not an exception in an event
 * handler.
 */
export async function chatOfMessage(
  msg: ChatSource,
  lookups: {
    /**
     * Fill the entity cache with the newest dialogs — ONE call shared by every
     * line that arrives while it runs (the listener single-flights it), so a
     * burst of strangers after a restart costs one GetDialogs, not one each.
     */
    warm?: () => Promise<unknown>;
    getEntity?: (peer: unknown) => Promise<unknown>;
  } = {},
): Promise<ResolvedChat> {
  const direct = await quietly(msg.getChat?.bind(msg));
  if (direct) return { chat: direct, unresolved: false, via: 'direct' };
  // Only a bare USER needs the walk. A group's or a channel's message carries
  // its chat in the update, and a group is never a client chat anyway.
  if (!isUserPeer(msg.peerId)) return { chat: undefined, unresolved: false, via: null };
  // The newest dialogs into the cache first — the line that just arrived makes
  // its chat the newest one there is — and then gramjs's own fallback, which
  // reads the cache before it walks anything itself (`getInputChat`: a cached
  // peer sets the input chat; only a miss walks the newest hundred dialogs).
  await quietly(lookups.warm);
  await quietly(msg.getInputChat?.bind(msg));
  const walked = await quietly(msg.getChat?.bind(msg));
  if (walked) return { chat: walked, unresolved: false, via: 'dialogs' };
  const getEntity = lookups.getEntity;
  const asked = getEntity ? await quietly(() => getEntity(msg.peerId)) : undefined;
  if (asked) return { chat: asked, unresolved: false, via: 'entity' };
  return { chat: undefined, unresolved: true, via: null };
}

/** The user id a bare `PeerUser` names, or 0 — for the log line of a chat nothing else could name. */
export function userIdOf(peerId: unknown): bigint {
  const raw = (peerId as { userId?: { toString(): string } } | null | undefined)?.userId;
  try {
    return raw === undefined || raw === null ? 0n : BigInt(raw.toString());
  } catch {
    return 0n;
  }
}

/** The last four digits of an id or a number, for a log line that must not identify anybody. */
export function lastFour(value: bigint | string | null | undefined): string {
  const digits = (value ?? '').toString().replace(/\D/g, '');
  if (!digits) return '????';
  return digits.slice(-4).padStart(4, '•');
}

/** Why the live path did not keep an inbound line — the verdict's own reason, plus the two the handler adds. */
export type PassReason =
  | 'unresolved'
  | 'not_private'
  | 'is_bot'
  | 'no_phone'
  | 'not_a_client'
  | 'excluded'
  | 'self'
  | 'service'
  | 'empty';

/**
 * The log line for an inbound line the listener passed over, or null for the
 * ones that need no line: Saved Messages, Telegram's own service chat (its
 * 🔑 line is printed already), and a real group or channel — the AI never
 * answers those and a busy group would bury the lines that matter.
 */
export function passedLine(input: {
  reason: PassReason | string;
  peerId: bigint;
  phone: string | null;
}): string | null {
  const chat = `#…${lastFour(input.peerId)}`;
  const phone = input.phone ? `…${lastFour(input.phone)}` : null;
  switch (input.reason) {
    case 'unresolved':
      return `  · o‘tkazildi ${chat}: Telegram bu chatni aniqlab bermadi — AI ko‘rmadi`;
    case 'no_phone':
      return `  · o‘tkazildi ${chat}: yozgan odamning raqami yashirin — uni shu Telegram kontaktlariga raqami bilan saqlang`;
    case 'not_a_client':
      return `  · o‘tkazildi ${chat}: ${phone ?? 'bu'} raqami mijozlar ro‘yxatida yo‘q — «Qaysi chatlar»da so‘raladi`;
    case 'excluded':
      return `  · o‘tkazildi ${chat}: bu chat «olinmasin» deb belgilangan (Suhbatlar → Qaysi chatlar)`;
    case 'is_bot':
      return `  · o‘tkazildi ${chat}: bot yozdi`;
    case 'empty':
      return `  · o‘tkazildi ${chat}: xabarda saqlanadigan narsa yo‘q`;
    case 'self':
    case 'service':
    case 'not_private':
      return null;
    default:
      return `  · o‘tkazildi ${chat}: ${input.reason}`;
  }
}
