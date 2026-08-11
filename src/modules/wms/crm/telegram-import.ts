import { phoneBelongsToClient } from '../client-cabinet/service';
import { isStorableType, resolveContentType } from '../../platform/files/service';

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
  /** One of `clientId`/`leadId` is set when `include` — the schema refuses it otherwise. */
  clientId: string | null;
  clientCode: string | null;
  /**
   * The open lead this chat was attached to (0065). Deliberately NOT read by
   * `classifyWithRules`: that function answers «whose CLIENT chat is this»,
   * which is the only question the history import can act on. The live path
   * reads it one level up, in `decideIncoming`, where a lead-owned message
   * already has somewhere to go.
   */
  leadId: string | null;
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
/**
 * The peer id inside an `UpdateReadHistoryInbox` (round 88).
 *
 * That update does not carry a chat object the way a message does — it
 * carries a bare `Peer`, so the id has to be read from whichever variant it
 * is. Only `PeerUser` is answered: our stored conversations are private chats
 * with customers (`peerFromChat` sets `isPrivate` from `className === 'User'`),
 * and a read in a group we never kept has nothing to mark.
 *
 * Pure, because the listener cannot be exercised in this container and this
 * is the one part of the read signal that can be.
 */
export function peerIdFromUpdate(
  peer: { className?: string; userId?: { toString(): string } } | null | undefined,
): bigint | null {
  if (peer?.className !== 'PeerUser') return null;
  const raw = peer.userId?.toString();
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > 0n ? id : null;
}

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
  /** Set when this message answers another one in the same chat. */
  replyTo?: { replyToMsgId?: unknown } | null;
  /** Set when it arrived from somewhere else. */
  fwdFrom?: { fromName?: unknown; postAuthor?: unknown } | null;
  /**
   * gramjs's resolved view of `fwdFrom`, filled from the entity cache the
   * connection already holds — no network call. Absent on the history
   * importer's raw rows, which is why the header is read as well.
   */
  forward?: { sender?: unknown; chat?: unknown } | null;
}

export interface MessageRow {
  peerId: bigint;
  tgMessageId: bigint;
  direction: 'in' | 'out';
  body: string | null;
  hasMedia: boolean;
  sentAt: Date;
  /** Which message this answers, in Telegram's numbering (0072). */
  replyToTgMessageId: bigint | null;
  /** Who it came from originally, in words a manager can read (0072). */
  fwdFrom: string | null;
}

/**
 * The name to print above a forwarded message (owner: «telegram ilovasida
 * forvarded deb accountusername turadi»).
 *
 * Four shapes, in the order Telegram fills them: the resolved sender or
 * channel gramjs already has in its entity cache; the `fromName` header,
 * which is what a chat with hidden forwards sends INSTEAD of an id; and
 * `postAuthor` for a channel post signed by a person. When the message is a
 * forward and none of them says who, the answer is the empty string — NOT
 * null, because «forwarded, source hidden» is a different fact from «not a
 * forward», and the bubble has to be able to tell them apart.
 *
 * Never a network call. Resolving an unknown peer would mean one round trip
 * per forwarded message on a personal account, which is exactly the traffic
 * pattern that gets an account limited.
 */
export function fwdFromName(msg: {
  fwdFrom?: { fromName?: unknown; postAuthor?: unknown } | null;
  forward?: { sender?: unknown; chat?: unknown } | null;
}): string | null {
  if (!msg.fwdFrom) return null;
  const named = (from: unknown): string => {
    const e = from as
      | { firstName?: unknown; lastName?: unknown; title?: unknown; username?: unknown }
      | null
      | undefined;
    if (!e) return '';
    if (typeof e.title === 'string' && e.title.trim()) return e.title.trim();
    const parts = [e.firstName, e.lastName].filter((n): n is string => typeof n === 'string');
    const full = parts.join(' ').trim();
    if (full) return full;
    return typeof e.username === 'string' && e.username.trim() ? `@${e.username.trim()}` : '';
  };
  const resolved = named(msg.forward?.sender) || named(msg.forward?.chat);
  if (resolved) return resolved;
  const raw = msg.fwdFrom;
  if (typeof raw.fromName === 'string' && raw.fromName.trim()) return raw.fromName.trim();
  if (typeof raw.postAuthor === 'string' && raw.postAuthor.trim()) return raw.postAuthor.trim();
  return '';
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

/**
 * A voice note is bigger than a photo and smaller than a film. Twenty is far
 * above any real «ovozli xabar» (a minute of Opus is ~0.5 MB) and inside the
 * 25 MB the files service allows a non-photo, so a refusal here is never a
 * surprise 500 two layers down.
 */
export const MAX_TG_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * A document — the owner's «faqat rasim emas fillar ham» (2026-08-11).
 *
 * Twenty megabytes is the files service's own non-photo ceiling minus room
 * for the wrapper, and it is deliberately the same number as a voice note:
 * a client sending an invoice, a packing list or a short video of the cargo
 * is inside it, and a film is not. A document past the cap keeps its
 * paperclip and its filename — the manager can still fetch it in Telegram,
 * which is more honest than a half-download.
 */
export const MAX_TG_FILE_BYTES = 20 * 1024 * 1024;

export type TgMediaKind = 'photo' | 'voice' | 'audio' | 'file';

export interface TgMediaPlan {
  /** Null = leave it a paperclip; we do not fetch it. */
  kind: TgMediaKind | null;
  download: boolean;
  approxBytes: number;
  /** What to STORE it as; '' for a photo, whose branch already knows. */
  contentType: string;
  fileName: string;
  durationSec: number | null;
}

const NONE: TgMediaPlan = {
  kind: null,
  download: false,
  approxBytes: 0,
  contentType: '',
  fileName: '',
  durationSec: null,
};

/**
 * Telegram sizes arrive in three shapes across gramjs versions: a JS number,
 * a JS bigint, or the `big-integer` object (which `Number()` turns into NaN —
 * and NaN <= cap is FALSE, so a silent refusal of every voice note). Through
 * the string, always.
 */
function sizeOf(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'bigint') return Number(raw);
  if (raw && typeof raw === 'object') {
    const asNumber = Number(String(raw));
    return Number.isFinite(asNumber) ? asNumber : 0;
  }
  return 0;
}

/** Audio mimes we can store and a browser can play; anything else stays a clip. */
const PLAYABLE_AUDIO = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

const EXT_FOR_AUDIO: Record<string, string> = {
  'audio/ogg': 'oga',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
};

/**
 * What to fetch from a message, and what to call it (owner, 2026-08-07:
 * «audio habarlar bizni sistemada korinmayabti»).
 *
 * The listener downloaded `MessageMediaPhoto` and nothing else since round 13,
 * so a client's voice note reached the manager's Telegram and the CRM showed
 * «📎» — the record of a conversation with a hole in it exactly where the
 * client explained what they wanted.
 *
 * Voice notes and audio files now count, on the photo branch's own terms: the
 * size is read from the message BEFORE any network I/O, an unknown size
 * refuses (pulling blind is how a 2 GB «audio» reaches the account the
 * business runs on), and the decision is pure and structural — no gramjs
 * objects in the tests.
 *
 * DOCUMENTS joined them on 2026-08-11 («faqat rasim emas fillar ham … klientlar
 * ham bizga fillar jonatishadi»): an invoice, a packing list, a spreadsheet or
 * a clip of the pallet is the conversation, and «📎» in its place is the same
 * hole the voice notes left. What still stays a paperclip is deliberate —
 * stickers (a wall of them is not a record), round video notes (nothing here
 * plays one), link previews, and anything past the cap or of a type storage
 * would refuse, which is asked of STORAGE rather than restated here.
 */
export function tgMediaPlan(
  media: unknown,
  msgId: number,
  limits: { photo?: number; audio?: number; file?: number } = {},
): TgMediaPlan {
  const photoCap = limits.photo ?? MAX_TG_PHOTO_BYTES;
  const audioCap = limits.audio ?? MAX_TG_AUDIO_BYTES;
  const fileCap = limits.file ?? MAX_TG_FILE_BYTES;
  const m = media as
    | {
        className?: string;
        document?: { mimeType?: string; size?: unknown; attributes?: unknown[] };
      }
    | null
    | undefined;
  if (!m) return NONE;

  if (m.className === 'MessageMediaPhoto') {
    const photo = tgPhotoPlan(media, photoCap);
    if (photo.approxBytes <= 0) return NONE;
    return {
      kind: 'photo',
      download: photo.download,
      approxBytes: photo.approxBytes,
      contentType: 'image/jpeg',
      fileName: `photo_${msgId}.jpg`,
      durationSec: null,
    };
  }

  if (m.className !== 'MessageMediaDocument' || !m.document) return NONE;
  const doc = m.document;
  const attributes = (doc.attributes ?? []) as {
    className?: string;
    voice?: boolean;
    roundMessage?: boolean;
    duration?: unknown;
    fileName?: unknown;
  }[];
  const audioAttr = attributes.find((a) => a.className === 'DocumentAttributeAudio');
  const videoAttr = attributes.find((a) => a.className === 'DocumentAttributeVideo');
  const declared = (doc.mimeType ?? '').toLowerCase();
  const named = attributes.find((a) => a.className === 'DocumentAttributeFilename');
  const givenName = typeof named?.fileName === 'string' ? named.fileName : '';
  const bytes = sizeOf(doc.size);

  // A STICKER is a document with an image mime and nobody wants a wall of
  // them in a cargo conversation. Its own attribute names it; excluded before
  // anything else because it would otherwise pass the file branch below.
  if (attributes.some((a) => a.className === 'DocumentAttributeSticker')) return NONE;

  // Audio first, and by ATTRIBUTE: Telegram sends a voice note as a document
  // and some clients label an .m4a `application/octet-stream`.
  if (audioAttr || declared.startsWith('audio/')) {
    // A video note («круглое видео») also carries a duration but is not audio;
    // its own attribute is what excludes it from THIS branch.
    if (!videoAttr) {
      const contentType = PLAYABLE_AUDIO.has(declared)
        ? declared
        : // A voice note with an odd mime is still Opus in an Ogg container.
          audioAttr?.voice
          ? 'audio/ogg'
          : '';
      if (!contentType) return NONE;
      if (bytes <= 0) return NONE;
      const kind: TgMediaKind = audioAttr?.voice ? 'voice' : 'audio';
      const ext = EXT_FOR_AUDIO[contentType] ?? 'oga';
      const duration = sizeOf(audioAttr?.duration);
      return {
        kind,
        download: bytes <= audioCap,
        approxBytes: bytes,
        contentType,
        // The sender's own filename when they sent a FILE; a voice note has
        // none, and «Ovozli xabar» in a file list means nothing to anybody.
        fileName: givenName || `${kind}_${msgId}.${ext}`,
        durationSec: duration > 0 ? Math.round(duration) : null,
      };
    }
  }

  // A ROUND video note stays a paperclip: it is a face talking, it has no
  // filename, and no screen here plays one.
  if (videoAttr?.roundMessage) return NONE;

  // Everything else a client can send — invoice, packing list, spreadsheet,
  // archive, a clip of the pallet (owner: «klientlar ham bizga fillar
  // jonatishadi»). The size is read from the message BEFORE any I/O and an
  // unknown size refuses, exactly as the photo branch has always done.
  if (bytes <= 0) return NONE;
  const fileName = givenName || `file_${msgId}`;
  // resolveContentType, so a document Telegram labels octet-stream is judged
  // by its extension the way an operator's own upload is — and isStorableType
  // is the STORAGE's answer, not a second list beside it: a mime the files
  // service would refuse is never fetched.
  const contentType = resolveContentType(fileName, declared);
  if (!isStorableType(contentType)) return NONE;
  return {
    kind: 'file',
    download: bytes <= fileCap,
    approxBytes: bytes,
    contentType,
    fileName,
    durationSec: null,
  };
}

export function toMessageRow(peerId: bigint, msg: RawMessage): MessageRow {
  const body = (msg.message ?? '').trim();
  // Through the string, like every other Telegram number here: the id arrives
  // as a JS number, a bigint or the library's big-integer object depending on
  // the version, and `Number()` on the last one is NaN (#574's trap).
  const repliedRaw = msg.replyTo?.replyToMsgId;
  const replied =
    repliedRaw == null || repliedRaw === ''
      ? null
      : /^[0-9]+$/.test(String(repliedRaw))
        ? BigInt(String(repliedRaw))
        : null;
  return {
    peerId,
    tgMessageId: BigInt(msg.id),
    direction: msg.out ? 'out' : 'in',
    body: body.length > 0 ? body : null,
    hasMedia: msg.media != null,
    sentAt: new Date(msg.date * 1000),
    replyToTgMessageId: replied && replied > 0n ? replied : null,
    fwdFrom: fwdFromName(msg),
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
