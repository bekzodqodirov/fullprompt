import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import { panelPause, type ConnectedChannel } from '@/modules/platform/telegram/price-channel';
import { missingRights, type ChannelRight, type PauseReason, type RemoveReason } from '@/modules/platform/telegram/price-channel-rules';
import { priceChannelChats } from '@/modules/platform/db/schema';
import type { ChannelPostView, PostKind, PostStatus, SkipReason } from './channel-post';

/**
 * What /admin/narx-kanali shows (his F) — every read the panel makes, in one
 * place, each bounded. The pause reason is the drain's OWN static rule plus
 * the last vet's verdict (`panelPause`), so the panel and the sender cannot
 * disagree about why nothing is being posted.
 */

export interface PanelChat {
  chatId: string;
  title: string;
  username: string | null;
  status: string;
  connected: boolean;
  admins: string[];
  rights: Record<string, boolean>;
  missing: ChannelRight[];
  memberCount: number | null;
  inviteLink: string | null;
  lastError: string | null;
  vetted: boolean;
}

export interface PanelPost {
  id: string;
  kind: PostKind;
  section: string | null;
  quoteNo: number | null;
  createdAt: Date;
  status: PostStatus;
  skipReason: SkipReason | null;
  lastError: string | null;
}

export interface PanelRemoval {
  name: string;
  reason: RemoveReason;
  at: Date;
}

export interface ChannelPanelData {
  connected: PanelChat | null;
  others: PanelChat[];
  pause: PauseReason | null;
  posts: PanelPost[];
  staleCount: number;
  unmarkedCount: number;
  members: number;
  removals: PanelRemoval[];
}

function toChat(r: ConnectedChannel): PanelChat {
  const rights = (r.rights ?? {}) as Record<string, boolean>;
  return {
    chatId: r.chatId.toString(),
    title: r.title,
    username: r.username,
    status: r.status,
    connected: r.connectedAt !== null,
    admins: Array.isArray(r.admins) ? (r.admins as unknown[]).map(String) : [],
    rights,
    missing: missingRights(rights),
    memberCount: r.memberCount,
    inviteLink: r.inviteLink,
    lastError: r.lastError,
    vetted: r.vettedAt !== null,
  };
}

export async function channelPanel(): Promise<ChannelPanelData> {
  const chats = await db.select().from(priceChannelChats).orderBy(priceChannelChats.updatedAt);
  const connectedRow = chats.find((c) => c.connectedAt !== null) ?? null;
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  // No token is said even with no channel connected: nothing could be posted.
  const pause = !hasToken
    ? 'no_bot'
    : connectedRow
    ? panelPause({
        hasToken,
        row: connectedRow,
        settingsAdminIds: await usersWithPermission('admin.settings.manage'),
      })
    : null;

  const posts = await db.execute<{
    id: string;
    kind: PostKind;
    section: string | null;
    view: ChannelPostView | null;
    created_ms: string;
    status: PostStatus;
    skip_reason: SkipReason | null;
    last_error: string | null;
  }>(sql`
    SELECT p.id::text AS id, p.kind, r.section, p.view,
           (extract(epoch FROM p.created_at) * 1000)::bigint::text AS created_ms,
           p.status, p.skip_reason, p.last_error
      FROM price_channel_posts p
      JOIN calc_requests r ON r.id = p.request_id
     ORDER BY p.created_at DESC
     LIMIT 20`);
  const [counts] = await db.execute<{ stale: number; unmarked: number }>(sql`
    SELECT count(*) FILTER (WHERE status = 'skipped' AND skip_reason = 'stale')::int AS stale,
           count(*) FILTER (WHERE mark_error IS NOT NULL)::int AS unmarked
      FROM price_channel_posts`);

  let members = 0;
  if (connectedRow) {
    const [m] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM price_channel_members
       WHERE chat_id = ${connectedRow.chatId.toString()}::bigint AND removed_at IS NULL`);
    members = Number(m?.n ?? 0);
  }
  const removals = await db.execute<{ name: string; reason: RemoveReason; at_ms: string }>(sql`
    SELECT u.full_name AS name, m.remove_reason AS reason,
           (extract(epoch FROM m.removed_at) * 1000)::bigint::text AS at_ms
      FROM price_channel_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.removed_at IS NOT NULL
     ORDER BY m.removed_at DESC
     LIMIT 10`);

  return {
    connected: connectedRow ? toChat(connectedRow) : null,
    // Only channels the bot can still post in: one it was removed from would
    // sit here for ever behind a «Shu kanalni ulash» that always refuses
    // (connectChannel's own status test). It comes back by itself when the bot
    // is made admin again.
    others: chats
      .filter((c) => c.connectedAt === null && (c.status === 'administrator' || c.status === 'creator'))
      .map(toChat),
    pause,
    posts: posts.map((p) => ({
      id: p.id,
      kind: p.kind,
      section: p.section,
      quoteNo: p.view?.quoteNo ?? null,
      createdAt: new Date(Number(p.created_ms)),
      status: p.status,
      skipReason: p.skip_reason,
      lastError: p.last_error,
    })),
    staleCount: Number(counts?.stale ?? 0),
    unmarkedCount: Number(counts?.unmarked ?? 0),
    members,
    removals: removals.map((r) => ({ name: r.name, reason: r.reason, at: new Date(Number(r.at_ms)) })),
  };
}
