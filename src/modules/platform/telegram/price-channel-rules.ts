/**
 * The price channel's DECISIONS (the owner's F, 2026-10-07) — pure, so each
 * is a table in a unit test and the handlers are thin shells over them.
 *
 *   - adoption: which channel the bot may remember (only one a settings admin
 *     made it administrator of — anybody in the world can add a bot to their
 *     own channel, and a lookalike title must never be offered);
 *   - vetting: a public channel, or one that already has subscribers the bot
 *     cannot account for, is refused — every VED floor and seller name would
 *     go to that audience (law 4, F4 a);
 *   - membership: a join request or a member update is approved for an active
 *     colleague with a linked Telegram and refused for everybody else (F8 a).
 */

/** Why a member row was closed. The 0128 CHECK lists exactly these. */
export const REMOVE_REASONS = ['inactive', 'unlinked', 'relinked', 'left'] as const;
export type RemoveReason = (typeof REMOVE_REASONS)[number];

/** The four rights the bot needs as a channel administrator. */
export const CHANNEL_RIGHTS = ['post', 'edit', 'invite', 'restrict'] as const;
export type ChannelRight = (typeof CHANNEL_RIGHTS)[number];

/** A vetting refusal. */
export const VET_VERDICTS = ['public', 'has_discussion', 'has_members', 'bot_not_admin', 'vet_failed'] as const;
export type VetVerdict = (typeof VET_VERDICTS)[number];

/** Why the drain is not sending — printed on the panel in words. */
export const PAUSE_REASONS = ['no_bot', 'bot_removed', 'not_vetted', 'public', 'channel_refused', 'connector_gone'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** The Bot API flag behind each right. */
export const RIGHT_FLAGS: Record<ChannelRight, string> = {
  post: 'can_post_messages',
  edit: 'can_edit_messages',
  invite: 'can_invite_users',
  restrict: 'can_restrict_members',
};

export function missingRights(rights: Record<string, unknown>): ChannelRight[] {
  return CHANNEL_RIGHTS.filter((r) => rights[RIGHT_FLAGS[r]] !== true);
}

const PROMOTED = new Set(['administrator', 'creator']);

export type AdoptionVerdict = 'adopt' | 'record' | 'update' | 'ignore';

/**
 * A `my_chat_member` update — the bot's own status in a chat changed.
 *   - not a channel → ignore (a customer blocking the bot changes nothing that
 *     exists; a supergroup is refused on purpose — join requests and protected
 *     content are the channel's semantics);
 *   - promoted by a settings admin → adopt (nothing connected) or record (a
 *     channel already is: offered on the panel as «Shu kanalni ulash»);
 *   - a channel we already know → update, whoever did it (a demotion must be
 *     heard whoever made it);
 *   - otherwise (a stranger, a seller, an unlinked person) → ignore, write nothing.
 */
export function decideAdoption(o: {
  chatType: string;
  newStatus: string;
  rowExists: boolean;
  hasConnected: boolean;
  adderIsSettingsAdmin: boolean;
}): AdoptionVerdict {
  if (o.chatType !== 'channel') return 'ignore';
  if (PROMOTED.has(o.newStatus) && o.adderIsSettingsAdmin) return o.hasConnected ? 'record' : 'adopt';
  if (o.rowExists) return 'update';
  return 'ignore';
}

export type VetDecision =
  | { verdict: 'ok' }
  | { verdict: 'public' }
  | { verdict: 'has_discussion' }
  | { verdict: 'has_members'; count: number }
  | { verdict: 'bot_not_admin' };

/**
 * Is this channel safe to post prices into?
 *   - `public` — it has an @username (a public channel ALSO has a -100… id; the
 *     id's shape proves nothing);
 *   - `has_discussion` — a discussion group is linked: Telegram copies every
 *     post into it automatically, to members the bot never checked and cannot
 *     see (the channel's own count does not include them). A group linked
 *     LATER is caught by the drain's ten-minute re-vet;
 *   - `bot_not_admin` — the bot cannot post there;
 *   - `has_members` — more non-admin subscribers than the bot has admitted. On
 *     a first connect the bot has admitted nobody, so ANY subscriber refuses:
 *     an old channel with ex-employees, agents or customers in it cannot be
 *     told apart by the bot. Admins are the owner's own choice and are listed
 *     by name on the panel instead.
 */
export function decideVet(o: {
  username: string | null;
  linkedChatId: number | null;
  memberCount: number;
  adminCount: number;
  botCanPost: boolean;
  liveMembers: number;
}): VetDecision {
  if (o.username && o.username.trim() !== '') return { verdict: 'public' };
  if (o.linkedChatId != null) return { verdict: 'has_discussion' };
  if (!o.botCanPost) return { verdict: 'bot_not_admin' };
  const subscribers = Math.max(0, o.memberCount - o.adminCount);
  if (subscribers > o.liveMembers) return { verdict: 'has_members', count: subscribers };
  return { verdict: 'ok' };
}

export type JoinVerdict = { act: 'ignore' } | { act: 'approve'; userId: string } | { act: 'decline' };

/** A `chat_join_request`: our channel + an eligible colleague → approve; our channel + anybody else → decline. */
export function decideJoin(o: {
  chatId: string;
  configuredChatId: string | null;
  eligible: { userId: string } | null;
}): JoinVerdict {
  if (o.configuredChatId === null || o.chatId !== o.configuredChatId) return { act: 'ignore' };
  if (o.eligible) return { act: 'approve', userId: o.eligible.userId };
  return { act: 'decline' };
}

export type MemberVerdict = 'ignore' | 'admit' | 'evict' | 'left';

/**
 * A `chat_member` update — the route in a join request does not cover (an
 * admin adding someone from contacts, a request approved by hand in Telegram,
 * a link the revocation missed).
 *   - not our channel, or the bot itself → ignore;
 *   - promoted to administrator → ignore (the owner's choice; listed by name);
 *   - became a member: a colleague → admit (the same upsert as an approval,
 *     idempotent with our own approval's echo); anybody else → evict;
 *   - left / kicked → left.
 */
export function decideMemberUpdate(o: {
  chatId: string;
  configuredChatId: string | null;
  targetIsBot: boolean;
  targetIsSelf: boolean;
  oldStatus: string;
  newStatus: string;
  isMember?: boolean;
  eligible: { userId: string } | null;
}): MemberVerdict {
  if (o.configuredChatId === null || o.chatId !== o.configuredChatId || o.targetIsSelf) return 'ignore';
  if (PROMOTED.has(o.newStatus)) return 'ignore';
  const inChannel = o.newStatus === 'member' || (o.newStatus === 'restricted' && o.isMember !== false);
  if (inChannel) return o.eligible && !o.targetIsBot ? 'admit' : 'evict';
  if (o.newStatus === 'left' || o.newStatus === 'kicked' || o.newStatus === 'restricted') return 'left';
  return 'ignore';
}
