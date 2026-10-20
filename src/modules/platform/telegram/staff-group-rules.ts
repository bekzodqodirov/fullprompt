/**
 * The staff group's pure decisions (0134, the owner, 2026-10-20) — each a
 * table in `tests/unit/staff-group-rules.test.ts`, so the grammy shell and the
 * drain only carry out what is decided here.
 */

export const GROUP_TYPES = new Set(['group', 'supergroup']);

/** The bot is IN the chat (a restricted member is still in it). */
const PRESENT = new Set(['creator', 'administrator', 'member', 'restricted']);

export type GroupAdoption = 'adopt' | 'record' | 'update' | 'ignore';

/**
 * A `my_chat_member` update for a GROUP — the bot's own status changed.
 *   - not a group or supergroup → ignore (channels are the price channel's);
 *   - the bot put IN by a settings admin while no group is active → adopt
 *     (the owner adds the bot and the group simply starts working);
 *   - a group we already know → update, whoever did it (a kick must be heard
 *     whoever made it);
 *   - a new group a COLLEAGUE added → record: offered on the panel as «Shu
 *     guruhni ulash», never active by itself;
 *   - anybody else, or the bot leaving a group we never knew → ignore, write
 *     nothing. Anybody in the world can add a bot to their own group, and the
 *     panel must never offer a stranger's room for the staff's names and kub.
 */
export function decideGroupAdoption(o: {
  chatType: string;
  newStatus: string;
  rowExists: boolean;
  rowActive: boolean;
  hasActive: boolean;
  adderIsColleague: boolean;
  adderIsSettingsAdmin: boolean;
}): GroupAdoption {
  if (!GROUP_TYPES.has(o.chatType)) return 'ignore';
  const present = PRESENT.has(o.newStatus);
  if (present && o.adderIsSettingsAdmin && !o.hasActive) return 'adopt';
  if (o.rowExists) return 'update';
  if (!present) return 'ignore';
  return o.adderIsColleague ? 'record' : 'ignore';
}

/** May the bot write into the group, by its member record? */
export function botCanPost(member: { status: string; can_send_messages?: boolean } | null): boolean {
  if (!member) return false;
  if (member.status === 'creator' || member.status === 'administrator' || member.status === 'member') return true;
  return member.status === 'restricted' && member.can_send_messages === true;
}

/** A connect-phase fault: nothing left the machine, so a retry cannot double-post. */
const CONNECT_PHASE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b/;
/** A refusal about the GROUP, not the post — the bot was removed or silenced. */
const GROUP_REFUSAL =
  /chat not found|not enough rights|have no rights|not a member|CHAT_WRITE_FORBIDDEN|bot was kicked|CHAT_RESTRICTED|group chat was deactivated/i;

export type GroupVerdict =
  | { next: 'sent' }
  | { next: 'migrated'; chatId: string }
  | { next: 'retry'; notBeforeSec: number }
  | { next: 'pause'; lastError: string; groupRefused: boolean }
  | { next: 'failed'; lastError: string };

/**
 * What a send's answer means for the row. The price channel's rule, for the
 * same reason: a «tabriklaymiz» posted TWICE in a room everybody reads is
 * worse than one the admin re-sends with a press (#48), so an answer that may
 * already have reached Telegram (our deadline, a reset socket, a 502/504) is
 * never retried by the machine — only a fault where nothing left the machine.
 *
 * A group that became a supergroup refuses with the NEW id — the row follows
 * it and the post goes again at once (nothing was published).
 */
export function groupVerdict(
  result: {
    ok: boolean;
    status: number;
    description: string;
    retryAfter: number | null;
    botDown: boolean;
    migrateToChatId?: string | null;
  },
  attempts: number,
): GroupVerdict {
  if (result.ok) return { next: 'sent' };
  if (result.migrateToChatId) return { next: 'migrated', chatId: result.migrateToChatId };
  if (result.status === 429 || result.retryAfter !== null) {
    return { next: 'retry', notBeforeSec: result.retryAfter ?? 60 };
  }
  if (result.botDown || (result.status === 0 && result.description === 'no_bot_token')) {
    return { next: 'pause', lastError: result.description, groupRefused: false };
  }
  if (result.status === 403 || (result.status === 400 && GROUP_REFUSAL.test(result.description))) {
    return { next: 'pause', lastError: result.description, groupRefused: true };
  }
  if (result.status === 0) {
    if (CONNECT_PHASE.test(result.description)) {
      return attempts >= 8
        ? { next: 'failed', lastError: result.description }
        : { next: 'retry', notBeforeSec: 60 };
    }
    return { next: 'failed', lastError: 'ambiguous_send' };
  }
  if (result.status === 502 || result.status === 504) return { next: 'failed', lastError: 'ambiguous_send' };
  if (result.status >= 500) return { next: 'retry', notBeforeSec: 60 };
  return { next: 'failed', lastError: result.description };
}

/**
 * How long a waiting post is still worth posting. A celebration is news for a
 * day; the rating keeps three, so a bot down over a weekend still says who
 * won the week rather than nothing — never a flood of yesterday's praise the
 * moment a paused group comes back.
 */
export function staleAfterHours(kind: string): number {
  return kind === 'rating' || kind === 'champion' ? 72 : 24;
}
