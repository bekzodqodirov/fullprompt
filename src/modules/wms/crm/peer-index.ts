import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tgAccounts, tgChatRules, tgPeerIndex, users } from '../../platform/db/schema';
import { phoneDigits } from '../../platform/clients/phone';

/**
 * «Have any of our connected Telegram accounts talked to this number?»
 *
 * The owner asked for this in the direction the system did not have: opening
 * a lead, a deal or a client should look BACK into Telegram and offer the
 * conversation that already exists, instead of waiting for the number to
 * appear in the client book first.
 *
 * Answering it needs a list of every chat each account holds — and stored the
 * obvious way, that list is a copy of an employee's private address book
 * living in the company database. So it is stored as a HASH and nothing else:
 * no name, no number, no title (owner: «hash bilan qil»). The only question
 * this index can answer is the only one worth asking.
 *
 * What it is NOT: an authorisation. A match says «this manager has a chat
 * with this number»; reading that chat still goes through the same
 * per-manager fence as every other Telegram read (round 20).
 */

/**
 * The pepper, derived rather than configured.
 *
 * A bare sha256 of a phone number is not a secret — nine digits is a keyspace
 * a laptop exhausts in seconds — so the hash is only worth anything with a
 * secret in it. It comes from `SESSION_SECRET` rather than a new variable
 * because a variable nobody sets is a pepper that is the empty string on the
 * one machine that matters. Rotating that secret makes every row unmatchable,
 * which is safe rather than broken: the refresh rebuilds the index from the
 * accounts themselves.
 */
function pepper(): string {
  const secret = process.env.SESSION_SECRET ?? '';
  return createHash('sha256').update(`tg-peer-index:${secret}`).digest('hex');
}

/**
 * The fingerprint of a phone number, or null when it is not one.
 *
 * The LAST NINE DIGITS, which is the rule every phone comparison in this
 * system already uses (#111): an Uzbek number is nine digits after the
 * country code and the office writes it eight different ways. Hashing the
 * raw string instead would make `+998 90 175-78-00` and `901757800` two
 * different people.
 */
export function phoneFingerprint(raw: string | null | undefined): string | null {
  const digits = phoneDigits(raw ?? '');
  if (digits.length < 9) return null;
  return createHash('sha256').update(`${pepper()}:${digits.slice(-9)}`).digest('hex');
}

export interface PeerSeen {
  peerId: bigint;
  phone: string | null;
  lastMessageAt: Date | null;
}

/**
 * Record that these peers exist on this account, as fingerprints.
 *
 * A peer whose number Telegram does not show us is simply not indexed —
 * there is nothing to match on, and inventing a row would only make the
 * table bigger and no more useful. That is also why coverage is partial and
 * why the screen says «topilmadi» rather than «yo'q».
 */
export async function indexPeers(managerUserId: string, seen: PeerSeen[]): Promise<number> {
  const rows = seen
    .map((peer) => ({ peer, hash: phoneFingerprint(peer.phone) }))
    .filter((row): row is { peer: PeerSeen; hash: string } => row.hash !== null)
    .map((row) => ({
      managerUserId,
      peerId: row.peer.peerId,
      phoneHash: row.hash,
      lastMessageAt: row.peer.lastMessageAt,
    }));
  // The empty guard round 31 made a rule: `values([])` is a SQL error, and
  // this list is the tail of a filter that legitimately removes everything.
  if (rows.length === 0) return 0;
  await db
    .insert(tgPeerIndex)
    .values(rows)
    .onConflictDoUpdate({
      target: [tgPeerIndex.managerUserId, tgPeerIndex.peerId],
      set: {
        phoneHash: sql`excluded.phone_hash`,
        lastMessageAt: sql`excluded.last_message_at`,
        updatedAt: new Date(),
      },
    });
  return rows.length;
}

export interface PeerMatch {
  managerUserId: string;
  managerName: string;
  peerId: bigint;
  lastMessageAt: Date | null;
  /** Is this the person asking, or a colleague? */
  own: boolean;
}

/**
 * Which connected accounts have a chat with this number.
 *
 * Names the MANAGER, never the peer: the index holds no name to give, and
 * that is deliberate. A colleague's match is reported so the person creating
 * the card knows the conversation exists and who to ask — round 20's line
 * between who talks and what was said, which this feature must not cross.
 *
 * A signed-out account still counts: the chat is on it, and its manager can
 * reconnect. What is excluded is nothing — a row can only exist for an
 * account somebody connected.
 */
export async function managersWhoTalkedTo(
  phone: string | null | undefined,
  viewerId: string,
): Promise<PeerMatch[]> {
  const hash = phoneFingerprint(phone);
  if (!hash) return [];
  const rows = await db
    .select({
      managerUserId: tgPeerIndex.managerUserId,
      managerName: users.fullName,
      peerId: tgPeerIndex.peerId,
      lastMessageAt: tgPeerIndex.lastMessageAt,
    })
    .from(tgPeerIndex)
    .innerJoin(users, eq(users.id, tgPeerIndex.managerUserId))
    .where(eq(tgPeerIndex.phoneHash, hash))
    .orderBy(desc(tgPeerIndex.lastMessageAt));
  return rows.map((row) => ({ ...row, own: row.managerUserId === viewerId }));
}

/**
 * The matches worth OFFERING on a card — the ones nobody has answered yet.
 *
 * A chat already `include`d is being kept; a chat `exclude`d is somebody
 * having said no, and re-offering it on every card that carries the number
 * would turn a decision into a question that keeps coming back. Both are
 * dropped, so the panel appears exactly when there is something to press.
 *
 * The rule is read per (manager, peer) — the same pair the table is unique
 * on — because the answer is one manager's about one chat, never the
 * company's about a number.
 */
export async function offerableMatches(
  phone: string | null | undefined,
  viewerId: string,
): Promise<PeerMatch[]> {
  const hits = await managersWhoTalkedTo(phone, viewerId);
  if (hits.length === 0) return [];
  const answered = await db
    .select({ managerUserId: tgChatRules.managerUserId, peerId: tgChatRules.peerId })
    .from(tgChatRules)
    .where(
      and(
        inArray(
          tgChatRules.managerUserId,
          hits.map((hit) => hit.managerUserId),
        ),
        inArray(
          tgChatRules.peerId,
          hits.map((hit) => hit.peerId),
        ),
        inArray(tgChatRules.decision, ['include', 'exclude']),
      ),
    );
  // The two `inArray`s are a cross product and deliberately looser than the
  // question — it is the SET that decides, keyed on the exact pair, so a row
  // the wider query drags in matches no hit and changes nothing. That
  // matters in the normal case, not an edge one: a Telegram peer id is
  // global, so two colleagues with the same customer share it, and one of
  // them saying «hech qachon» must not answer for the other.
  const decided = new Set(answered.map((row) => `${row.managerUserId}:${row.peerId}`));
  return hits.filter((hit) => !decided.has(`${hit.managerUserId}:${hit.peerId}`));
}

/**
 * When this account's index was last written, or null if never.
 *
 * The listener restarts on every deploy, and walking a manager's whole dialog
 * list on each start is a burst Telegram has no reason to like. This is what
 * lets the pass at startup be skipped when a recent one already covered it —
 * the schedule is «not more often than», not «every time we boot».
 */
export async function lastIndexedAt(managerUserId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${tgPeerIndex.updatedAt})` })
    .from(tgPeerIndex)
    .where(eq(tgPeerIndex.managerUserId, managerUserId));
  return row?.at ? new Date(row.at) : null;
}

/** Every account whose index is worth refreshing — connected and not signed out. */
export async function accountsToIndex(): Promise<{ managerUserId: string; tgPhone: string }[]> {
  return db
    .select({ managerUserId: tgAccounts.managerUserId, tgPhone: tgAccounts.tgPhone })
    .from(tgAccounts)
    .where(and(inArray(tgAccounts.status, ['active']), sql`${tgAccounts.sessionEnc} IS NOT NULL`));
}
