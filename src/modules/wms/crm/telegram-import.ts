import { phoneBelongsToClient } from '../client-cabinet/service';

/**
 * Bringing the manager's Telegram into the CRM — the deciding logic.
 *
 * The owner: "biz clientlarimiz bn 95 foiz telegramda gaplashamiz shuni chatni
 * crmga o'tkaza olamizmi." Until now that conversation lived on one person's
 * phone, and when a manager left, every price and promise left with them.
 *
 * This file holds the two decisions that matter and NOTHING that talks to
 * Telegram, so both can be tested without a network, a phone or an account:
 *
 *   1. which conversations are ours to keep, and
 *   2. what one message becomes.
 *
 * The first is the one with teeth. A manager's account holds their family,
 * their friends and their other business, and none of that is the company's
 * to read. A dialog is imported ONLY when its phone number is already in the
 * client book — everything else is passed over without being stored, counted
 * as anything, or written to a log.
 */

/**
 * Which stored rows still owe us their photograph — the `--media` backfill's
 * one decision, pure so it is provable: media-carrying, not yet holding an
 * attachment, newest first, capped. The cap is the point: the owner's MinIO
 * holds ~1.5 GB with no off-site copy yet (photos-to-Drive is his held
 * decision), so a backfill that swallows a year of photos in one run is a
 * storage incident, not a feature.
 */
export function mediaBackfillPlan<T extends { hasMedia: boolean; hasPhoto: boolean; sentAt: Date }>(
  rows: T[],
  capPerChat: number,
): T[] {
  return rows
    .filter((row) => row.hasMedia && !row.hasPhoto)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
    .slice(0, Math.max(0, capPerChat));
}

/** What Telegram gives us about the other side of a private chat. */
export interface DialogPeer {
  /** Telegram's user id for the peer. */
  id: bigint;
  /** Only visible when the peer is a contact or shares their number. */
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  /** True for groups, channels and bots — none of which are a client chat. */
  isPrivate: boolean;
  isBot?: boolean;
  /** The manager's chat with THEMSELVES (Saved Messages). Never a client. */
  isSelf?: boolean;
}

/** The client book, reduced to what the match needs. */
export interface ClientPhones {
  id: string;
  clientCode: string;
  phones: unknown;
}

export type DialogVerdict =
  | { keep: true; clientId: string; clientCode: string }
  | {
      keep: false;
      reason: 'not_private' | 'is_bot' | 'no_phone' | 'not_a_client' | 'excluded' | 'self';
    };

/**
 * A decision a person wrote down about one chat, which outranks the automatic
 * rule. One per peer, per manager. `pending` is a question, not an answer, and
 * decides nothing.
 */
export interface ChatRule {
  peerId: bigint;
  decision: 'pending' | 'include' | 'exclude';
  /** Always set when `include` — the schema refuses the row otherwise. */
  clientId: string | null;
  clientCode: string | null;
}

/**
 * The automatic rule, with a person's answer on top of it.
 *
 * Owner: "qaysi chatlarni qo'shish kerak va qaysini qo'shmaslik." The phone
 * match is right and it is not enough — Telegram reveals a number only to
 * CONTACTS, so a real client the manager never saved is invisible to it (122
 * of them in the first import), and a client writing from a second number is a
 * stranger to it. In the other direction, a chat the rule DOES match may still
 * be one nobody wants in the CRM.
 *
 * So an explicit rule wins BOTH ways, and it is checked first — including
 * before `isPrivate` and `isBot`, because those are refusals the automatic
 * rule makes on a guess about what a peer is, and a person who has looked at
 * the chat knows better. `pending` deliberately decides nothing: a question
 * nobody has answered must not quietly become a yes.
 */
export function classifyWithRules(
  peer: DialogPeer,
  clients: ClientPhones[],
  rules: Map<bigint, ChatRule>,
): DialogVerdict {
  // Ahead of the rule, and deliberately: a chat with yourself is not a
  // conversation with a customer under any decision anybody could write down.
  if (peer.isSelf) return { keep: false, reason: 'self' };
  const rule = rules.get(peer.id);
  if (rule?.decision === 'exclude') return { keep: false, reason: 'excluded' };
  if (rule?.decision === 'include' && rule.clientId) {
    return { keep: true, clientId: rule.clientId, clientCode: rule.clientCode ?? '' };
  }
  return classifyDialog(peer, clients);
}

/**
 * Is this conversation the company's business?
 *
 * Ordered so the cheapest and most private-preserving refusals come first: a
 * group or a bot is never a client chat, and a peer whose number we cannot
 * even see cannot be matched to anybody — in both cases we stop before
 * looking at the client book at all.
 *
 * `no_phone` is called out separately from `not_a_client` on purpose. Telegram
 * only reveals a phone number to contacts, so a manager who never saved a
 * client in their address book will produce a pile of these — and that is a
 * fixable problem ("save your clients as contacts, run it again"), where
 * `not_a_client` is simply somebody else's conversation.
 */
export function classifyDialog(peer: DialogPeer, clients: ClientPhones[]): DialogVerdict {
  if (!peer.isPrivate) return { keep: false, reason: 'not_private' };
  if (peer.isBot) return { keep: false, reason: 'is_bot' };
  // Saved Messages — the manager's chat with themselves. It carries their OWN
  // number, so if that number is anywhere in the client book (and an owner's
  // usually is) their private notes would be filed as a client's conversation
  // and shown to whoever can read that client. Refused before the book is
  // consulted at all, and refused even by an explicit rule: nobody should be
  // able to opt into it by accident.
  if (peer.isSelf) return { keep: false, reason: 'self' };
  const phone = (peer.phone ?? '').trim();
  if (!phone) return { keep: false, reason: 'no_phone' };
  const match = clients.find((c) => phoneBelongsToClient(phone, c.phones));
  if (!match) return { keep: false, reason: 'not_a_client' };
  return { keep: true, clientId: match.id, clientCode: match.clientCode };
}

/**
 * What a scan should do with one dialog.
 *
 * `ask` is the only outcome that writes anything about a chat nobody has
 * approved, and it writes three fields: an id, a display name, a number if
 * Telegram shows one. Never a message.
 *
 * Groups, channels and bots are `skip`, not `ask`, and that is a deliberate
 * limit rather than an oversight: a group holds people who never agreed to
 * anything, so storing one would take in messages from strangers on the say-so
 * of a person who does not speak for them.
 */
export type ScanVerdict = 'auto' | 'ask' | 'answered' | 'skip';

export function scanVerdict(
  peer: DialogPeer,
  clients: ClientPhones[],
  rules: Map<bigint, ChatRule>,
): ScanVerdict {
  const decision = rules.get(peer.id)?.decision;
  if (decision === 'include' || decision === 'exclude') return 'answered';
  if (!peer.isPrivate || peer.isBot || peer.isSelf) return 'skip';
  // Already coming in on its own — asking would be noise on a list whose only
  // job is to be short enough that somebody actually goes through it.
  if (classifyDialog(peer, clients).keep) return 'auto';
  return 'ask';
}

/**
 * The other party of a conversation, from the CHAT rather than from the sender.
 *
 * Which end you read is not a style choice, and getting it wrong is silent.
 * GramJS sets a message's `senderId` only when `post || (!out && peerId
 * instanceof PeerUser)` (`tl/custom/message.js`), so an OUTGOING private
 * message — no `fromId`, `out: true` — has no sender at all. A listener that
 * asks for the sender gets `null`, cannot tell the chat is private, and drops
 * the message. The bridge keeps saying "connected", the client's half of every
 * conversation keeps arriving, and only OUR half quietly stops.
 *
 * `peerId`, which is what `getChat()`/`chatId` resolve, is the other party on
 * an incoming message and the recipient on an outgoing one — the same person
 * either way. It is the dialog, which is exactly what the import iterates, so
 * both paths now reduce a conversation the same way.
 *
 * `telegram-peer.test.ts` pins this against the real library.
 */
export function peerFromChat(
  chat: {
    id?: { toString(): string };
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    bot?: boolean;
    self?: boolean;
    className?: string;
  } | null
  | undefined,
): DialogPeer {
  // `getChat()` can return undefined for a chat Telegram will not resolve.
  // That must be an ordinary refusal, not a throw inside the event handler.
  const isUser = chat?.className === 'User';
  return {
    id: BigInt(chat?.id?.toString() ?? '0'),
    phone: isUser ? (chat?.phone ?? null) : null,
    firstName: chat?.firstName ?? null,
    lastName: chat?.lastName ?? null,
    username: chat?.username ?? null,
    isPrivate: isUser,
    isBot: Boolean(chat?.bot),
    isSelf: Boolean(chat?.self),
  };
}

/** A name for the screen, from the pieces Telegram gives separately. */
export function peerTitle(peer: DialogPeer): string {
  const name = [peer.firstName, peer.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (peer.username) return `@${peer.username}`;
  // No name, no username, no number: the id is all there is, and a blank row
  // is undecidable — better an ugly label than an empty one.
  return `#${peer.id}`;
}

/** What Telegram gives us about one message. */
export interface RawMessage {
  id: number;
  /** True when the manager sent it. */
  out?: boolean;
  message?: string | null;
  /** Telegram stamps seconds, not milliseconds. */
  date: number;
  media?: unknown;
}

export interface MessageRow {
  peerId: bigint;
  tgMessageId: bigint;
  direction: 'in' | 'out';
  body: string | null;
  hasMedia: boolean;
  sentAt: Date;
}

/**
 * One Telegram message as one row.
 *
 * `date` is SECONDS since the epoch — treating it as milliseconds silently
 * files every conversation in January 1970, which sorts correctly against
 * itself and is therefore invisible until somebody looks at a date.
 *
 * An empty body is kept as null rather than '': a photo with no caption is a
 * real message and must still appear in the thread, in its right place.
 */
/**
 * Should this message's media be downloaded, and how big is it?
 *
 * PHOTOS ONLY, and only when Telegram states the size up front. `hasMedia`
 * is true for link previews, stickers, voice notes and arbitrary documents —
 * a naive "download when media" pulls all of it onto an account the business
 * depends on. The size is read from the message object BEFORE any network
 * I/O (Photo.sizes carries it), so an oversized photo is never
 * download-then-refused; unknown size refuses too — pulling blind is how a
 * 2 GB "photo sent as file" ends up in the pipe. Pure and unit-tested;
 * structural rather than instanceof so the test needs no gramjs objects.
 */
export const MAX_TG_PHOTO_BYTES = 10 * 1024 * 1024;

export function tgPhotoPlan(
  media: unknown,
  maxBytes = MAX_TG_PHOTO_BYTES,
): { download: boolean; approxBytes: number } {
  const m = media as { className?: string; photo?: { sizes?: unknown[] } } | null | undefined;
  if (!m || m.className !== 'MessageMediaPhoto') return { download: false, approxBytes: 0 };
  let biggest = 0;
  for (const raw of m.photo?.sizes ?? []) {
    const size = raw as { size?: unknown; sizes?: unknown[] };
    if (typeof size.size === 'number') biggest = Math.max(biggest, size.size);
    if (Array.isArray(size.sizes)) {
      for (const n of size.sizes) if (typeof n === 'number') biggest = Math.max(biggest, n);
    }
  }
  if (biggest <= 0) return { download: false, approxBytes: 0 };
  return { download: biggest <= maxBytes, approxBytes: biggest };
}

export function toMessageRow(peerId: bigint, msg: RawMessage): MessageRow {
  const body = (msg.message ?? '').trim();
  return {
    peerId,
    tgMessageId: BigInt(msg.id),
    direction: msg.out ? 'out' : 'in',
    body: body.length > 0 ? body : null,
    hasMedia: msg.media != null,
    sentAt: new Date(msg.date * 1000),
  };
}

/**
 * Is this message worth a row?
 *
 * Telegram's history is full of service entries — "user joined", "call ended",
 * a pinned-message marker. They carry no text and no media, and a thread
 * padded with blank rows is a thread nobody reads.
 */
export function isWorthKeeping(row: MessageRow): boolean {
  return row.body !== null || row.hasMedia;
}

/** What the operator is told when the run finishes. */
export interface ImportSummary {
  dialogsSeen: number;
  matched: number;
  skippedNoPhone: number;
  skippedNotClient: number;
  /** Refused by a rule somebody wrote, not by the automatic match. */
  skippedExcluded: number;
  skippedOther: number;
  messagesImported: number;
  messagesAlreadyThere: number;
  /** Photographs fetched by `--media` — absent on a text-only run. */
  photosFetched?: number;
}

export function emptySummary(): ImportSummary {
  return {
    dialogsSeen: 0,
    matched: 0,
    skippedNoPhone: 0,
    skippedNotClient: 0,
    skippedExcluded: 0,
    skippedOther: 0,
    messagesImported: 0,
    messagesAlreadyThere: 0,
  };
}

/** Fold one verdict into the running summary. */
export function countVerdict(summary: ImportSummary, verdict: DialogVerdict): void {
  summary.dialogsSeen += 1;
  if (verdict.keep) {
    summary.matched += 1;
    return;
  }
  if (verdict.reason === 'no_phone') summary.skippedNoPhone += 1;
  else if (verdict.reason === 'not_a_client') summary.skippedNotClient += 1;
  else if (verdict.reason === 'excluded') summary.skippedExcluded += 1;
  else summary.skippedOther += 1;
}
