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
 *    So: when the cache does not know the peer, fill it with ONE shared page
 *    of the newest dialogs (the line that just arrived is at the top of that
 *    list) and read the cache again; as a last resort ask Telegram for the
 *    user by its peer. Never gramjs's own per-message walk — a burst of
 *    strangers must not become a burst of GetDialogs on a personal account
 *    (the review of this fix: during a flood every line would knock twice).
 *
 * 2. `passedLine` — the words for a line the listener decided not to keep,
 *    printed ONLY for an inbound live line on the account the AI speaks from.
 *    It names the REASON and never the chat: the verdicts a private line gets
 *    (`no_phone`, «olinmasin») carry no identity by contract
 *    (`telegram-live.ts` `LiveVerdict`), and the agent may run on a personal
 *    session. The one number it prints, by its last four digits, is the one
 *    the tray already shows for a stranger with a visible phone.
 */

/** What the live handler needs of a gramjs message to find its chat. */
export interface ChatSource {
  getChat?: () => Promise<unknown>;
  /**
   * gramjs's synchronous getter: the input peer from the entity CACHE, no
   * network (`tl/custom/chatGetter.js` `get inputChat`). Read, never awaited.
   */
  readonly inputChat?: unknown;
  peerId?: unknown;
}

export interface ResolvedChat {
  chat: unknown;
  /** True when every way of asking came back empty — the caller logs it. */
  unresolved: boolean;
  /** How it was found: 'direct' (the cache), 'dialogs' (after the shared warm-up), 'entity' (asked by id). */
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

/** Does the entity cache know this message's chat? The getter only — no request. */
function cached(msg: ChatSource): boolean {
  try {
    return Boolean(msg.inputChat);
  } catch {
    return false;
  }
}

/**
 * The chat a live message belongs to. Never throws: a chat that cannot be
 * found is an answer the caller acts on (`unresolved`), not an exception in
 * an event handler.
 *
 * At most: the message's own lookup, one SHARED warm-up (paced by its owner,
 * `sharedWarmer`), one more lookup, one GetUsers by the bare peer. And a peer
 * the cache already knew whose lookup still failed is a network failure, not
 * a miss — it is answered unresolved at once, so a flood is not knocked on
 * three more times per line.
 */
export async function chatOfMessage(
  msg: ChatSource,
  lookups: {
    /** Fill the entity cache with the newest dialogs — one call shared by every line waiting on it. */
    warm?: () => Promise<unknown>;
    getEntity?: (peer: unknown) => Promise<unknown>;
  } = {},
): Promise<ResolvedChat> {
  const direct = await quietly(msg.getChat?.bind(msg));
  if (direct) return { chat: direct, unresolved: false, via: 'direct' };
  // Only a bare USER needs more. A group's or a channel's message carries its
  // chat in the update, and a group is never a client chat anyway.
  if (!isUserPeer(msg.peerId)) return { chat: undefined, unresolved: false, via: null };
  // Known to the cache and still nothing: Telegram refused the lookup itself.
  if (cached(msg)) return { chat: undefined, unresolved: true, via: null };
  await quietly(lookups.warm);
  if (cached(msg)) {
    // `getChat()` now finds the input peer in the cache and asks for the user.
    const walked = await quietly(msg.getChat?.bind(msg));
    if (walked) return { chat: walked, unresolved: false, via: 'dialogs' };
    return { chat: undefined, unresolved: true, via: null };
  }
  // Not among the newest dialogs either: a bare id still resolves for a
  // contact (gramjs `getInputEntity`, GetUsers with access hash 0).
  const getEntity = lookups.getEntity;
  const asked = getEntity ? await quietly(() => getEntity(msg.peerId)) : undefined;
  if (asked) return { chat: asked, unresolved: false, via: 'entity' };
  return { chat: undefined, unresolved: true, via: null };
}

/**
 * One page of the newest dialogs, shared and paced (the review of this fix):
 *
 *  - every caller that arrives while a warm-up is pending or running awaits
 *    the SAME one;
 *  - the next one starts no sooner than `gapMs` after the last one ended, and
 *    `failGapMs` after a failure (a FLOOD_WAIT over gramjs's sleep threshold
 *    is thrown, and knocking again inside it is what the ban design avoids) —
 *    a caller inside the gap waits for the next one instead of getting none,
 *    so a stranger who writes a moment after a warm-up is still found;
 *  - each one is given up after `deadlineMs`: gramjs `invoke` has no timeout
 *    and sleeps a short flood itself, and catch-up and every new stranger's
 *    line must not hang on one call for the life of the process.
 */
export function sharedWarmer(
  fetch: () => Promise<unknown>,
  opts: {
    gapMs: number;
    failGapMs: number;
    deadlineMs: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): () => Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending: Promise<void> | null = null;
  let readyAt = 0;
  const once = async (): Promise<void> => {
    const delay = readyAt - now();
    if (delay > 0) await wait(delay);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('warm-up deadline')), opts.deadlineMs);
    });
    try {
      await Promise.race([fetch(), deadline]);
      readyAt = now() + opts.gapMs;
    } catch (err) {
      readyAt = now() + opts.failGapMs;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return () => {
    pending ??= once().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/** The user id a bare `PeerUser` names, or 0. */
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

/** Why the live path did not keep an inbound line — the verdict's own reason, plus the one the handler adds. */
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
 *
 * `phone` is read for `not_a_client` alone — the stranger the tray already
 * lists by number. Every other reason prints no identity at all.
 */
export function passedLine(input: { reason: PassReason | string; phone: string | null }): string | null {
  switch (input.reason) {
    case 'unresolved':
      return '  · o‘tkazildi: Telegram yozgan odamni aniqlab bermadi — AI ko‘rmadi';
    case 'no_phone':
      return '  · o‘tkazildi: yozgan odamning raqami yashirin — uni shu Telegram kontaktlariga raqami bilan saqlang';
    case 'not_a_client':
      return `  · o‘tkazildi: ${input.phone ? `…${lastFour(input.phone)}` : 'bu'} raqami mijozlar ro‘yxatida yo‘q — «Qaysi chatlar»da so‘raladi`;
    case 'excluded':
      return '  · o‘tkazildi: chat «olinmasin» deb belgilangan (Suhbatlar → Qaysi chatlar)';
    case 'is_bot':
      return '  · o‘tkazildi: bot yozdi';
    case 'empty':
      return '  · o‘tkazildi: xabarda saqlanadigan narsa yo‘q';
    case 'self':
    case 'service':
    case 'not_private':
      return null;
    default:
      return `  · o‘tkazildi: ${input.reason}`;
  }
}
