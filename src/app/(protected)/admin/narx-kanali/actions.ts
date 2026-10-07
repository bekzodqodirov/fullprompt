'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import { writeAudit } from '@/modules/platform/audit/service';
import { logger } from '@/modules/platform/logger';
import { SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import {
  channelChatId,
  connectChannel,
  createJoinLink,
  disconnectChannel,
  recheckChannel,
} from '@/modules/platform/telegram/price-channel';
import { kickPriceChannel } from '@/modules/wms/calc/channel-queue';
import { retryPriceChannelPost } from '@/modules/wms/calc/channel-send';
import { CHANNEL_ERRORS, type ChannelError } from './errors';

/**
 * The price channel panel's five doors (his F, 2026-10-07). Each asks
 * `admin.settings.manage` itself (the page's gate is not the action's), each
 * is audited, and each answers a CODE the panel turns into words — never a
 * white page (#472).
 */
export type ChannelActionResult = { ok: true } | { ok: false; error: ChannelError; detail?: string };

function refused(error: ChannelError, detail?: string): ChannelActionResult {
  return { ok: false, error: CHANNEL_ERRORS.includes(error) ? error : 'telegram', ...(detail ? { detail } : {}) };
}

export async function connectChannelAction(chatId: string): Promise<ChannelActionResult> {
  const actor = await authorize('admin.settings.manage');
  if (!/^-?\d{1,20}$/.test(chatId)) return refused('not_found');
  if (!process.env.TELEGRAM_BOT_TOKEN) return refused('no_bot');
  const meta = await requestMeta();
  try {
    const done = await connectChannel(chatId, { actorId: actor.id, ...meta });
    revalidatePath('/admin/narx-kanali');
    return done.ok ? { ok: true } : refused(done.error, done.detail);
  } catch (err) {
    logger.error({ err, chatId }, '[price-channel] connect failed');
    return refused('telegram');
  }
}

export async function disconnectChannelAction(): Promise<ChannelActionResult> {
  const actor = await authorize('admin.settings.manage');
  const meta = await requestMeta();
  await disconnectChannel({ actorId: actor.id, ...meta });
  revalidatePath('/admin/narx-kanali');
  return { ok: true };
}

export async function newInviteLinkAction(): Promise<ChannelActionResult> {
  const actor = await authorize('admin.settings.manage');
  if (!process.env.TELEGRAM_BOT_TOKEN) return refused('no_bot');
  const chatId = await channelChatId();
  if (!chatId) return refused('not_found');
  const done = await createJoinLink(chatId);
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      after: { priceChannelLink: done.ok ? 'new' : 'refused' },
    },
  );
  revalidatePath('/admin/narx-kanali');
  return done.ok ? { ok: true } : refused(done.error, done.detail);
}

/**
 * «Qayta yuborish» — only a `failed` row, and only by a person who has looked
 * at the channel (the panel's «yuborilgan bo‘lishi mumkin» sentence): the
 * machine never re-sends an ambiguous post by itself (#48).
 */
export async function retryPostAction(postId: string): Promise<ChannelActionResult> {
  const actor = await authorize('admin.settings.manage');
  if (!/^[0-9a-f-]{36}$/i.test(postId)) return refused('not_failed');
  if (!(await retryPriceChannelPost(postId))) return refused('not_failed');
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    { entityType: 'price_channel_post', entityId: postId, action: 'update', after: { status: 'pending', retried: true } },
  );
  kickPriceChannel();
  revalidatePath('/admin/narx-kanali');
  return { ok: true };
}

/**
 * «Qayta tekshirish» — the connected channel vetted on the press, so the
 * person who just fixed it (made it private, unlinked the discussion group,
 * removed a stranger) hears the answer now instead of at the drain's next
 * ten-minute re-vet. Audited like the other configuration doors.
 */
export async function recheckChannelAction(): Promise<ChannelActionResult> {
  const actor = await authorize('admin.settings.manage');
  if (!process.env.TELEGRAM_BOT_TOKEN) return refused('no_bot');
  const meta = await requestMeta();
  try {
    const vet = await recheckChannel();
    if (!vet) return refused('not_found');
    await writeAudit(
      db,
      { actorId: actor.id, ...meta },
      {
        entityType: 'settings',
        entityId: SETTINGS_AUDIT_ID,
        action: 'update',
        after: { priceChannelVet: vet.ok ? 'ok' : vet.verdict },
      },
    );
    if (vet.ok) kickPriceChannel();
    revalidatePath('/admin/narx-kanali');
    return vet.ok ? { ok: true } : refused(vet.verdict, vet.detail);
  } catch (err) {
    logger.error({ err }, '[price-channel] recheck failed');
    return refused('telegram');
  }
}
