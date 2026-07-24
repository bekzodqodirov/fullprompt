import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, clientTelegramLinks } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import {
  cargoOverview,
  clientsForChat,
  debtSummary,
  issuedHistory,
  lotPhotoKeys,
  type CabinetLot,
} from '../../wms/client-cabinet/service';

/**
 * Client cabinet inside the staff bot (Phase 2.2, owner's spec 3.1/3.2):
 * clients are Uzbek-speaking, so all cabinet texts are uz. The chat's linked
 * client set is resolved on EVERY request — a revoked link cuts access
 * immediately.
 */

const BTN_CARGO = '📦 Yuklarim';
const BTN_BALANCE = '💰 Balans';
const BTN_HISTORY = '🗄 Tarix';

export const CABINET_KEYBOARD = new Keyboard()
  .text(BTN_CARGO)
  .text(BTN_BALANCE)
  .row()
  .text(BTN_HISTORY)
  .resized()
  .persistent();

const STATUS_LABELS: Record<string, string> = {
  in_stock: 'skladda',
  planned: 'jo‘natishga rejalashtirilgan',
  loading: 'yuklanmoqda',
  in_transit: 'yo‘lda 🚛',
  ready_for_pickup: 'olib ketishga tayyor ✅',
};

function lotLine(lot: CabinetLot): string {
  const name = lot.productNameZh + (lot.productNameRu ? ` (${lot.productNameRu})` : '');
  const statuses = Object.entries(lot.statuses)
    .map(([s, n]) => `${n} dona ${STATUS_LABELS[s] ?? s}`)
    .join(', ');
  const wh = lot.warehouseCodes.length ? ` · 📍 ${lot.warehouseCodes.join(', ')}` : '';
  return `${lot.letter ?? '·'} — ${name}\n   ${statuses}${wh}`;
}

/** Link a pending client code to this chat. Returns the client, or null. */
export async function linkClientChat(code: string, chatId: number) {
  const link = await db.query.clientTelegramLinks.findFirst({
    where: eq(clientTelegramLinks.linkCode, code),
  });
  if (!link || link.status === 'revoked') return null;
  // A chat may already hold this client via another code — reuse the row.
  const dup = await db.query.clientTelegramLinks.findFirst({
    where: and(
      eq(clientTelegramLinks.clientId, link.clientId),
      eq(clientTelegramLinks.telegramChatId, BigInt(chatId)),
      eq(clientTelegramLinks.status, 'linked'),
    ),
  });
  if (dup) {
    await db
      .update(clientTelegramLinks)
      .set({ status: 'revoked', linkCode: null })
      .where(eq(clientTelegramLinks.id, link.id));
  } else {
    await db
      .update(clientTelegramLinks)
      .set({
        telegramChatId: BigInt(chatId),
        status: 'linked',
        linkedAt: new Date(),
        linkCode: null,
      })
      .where(eq(clientTelegramLinks.id, link.id));
  }
  return db.query.clients.findFirst({ where: eq(clients.id, link.clientId) });
}

export function registerClientCabinet(bot: Bot): void {
  bot.hears(BTN_CARGO, async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    for (const client of linked) {
      const lots = await cargoOverview(client.id);
      if (!lots.length) {
        await ctx.reply(`${client.clientCode} — hozir yo‘lda yoki skladda yukingiz yo‘q.`);
        continue;
      }
      const header = `📦 ${client.clientCode} — ${client.name}\n\n`;
      const text = header + lots.map(lotLine).join('\n\n');
      const kb = new InlineKeyboard();
      let buttons = 0;
      for (const lot of lots) {
        if (lot.hasPhotos && buttons < 12) {
          kb.text(`📷 ${lot.letter ?? '·'}`, `ph:${lot.lotId}`);
          buttons += 1;
          if (buttons % 4 === 0) kb.row();
        }
      }
      await ctx.reply(text.slice(0, 4000), buttons ? { reply_markup: kb } : undefined);
    }
  });

  bot.hears(BTN_BALANCE, async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    for (const client of linked) {
      const debt = await debtSummary(client.id);
      const lines = debt.recent
        .filter((r) => !r.voided)
        .map(
          (r) =>
            `${r.txDate} — ${r.type === 'charge' ? '🧾 hisoblandi' : '➕ to‘lov'}: ${r.amount} ${r.currency}` +
            (r.currency !== 'USD' ? ` (≈ $${r.amountUsd.toFixed(2)})` : ''),
        )
        .join('\n');
      const head =
        debt.balanceUsd > 0.009
          ? `💰 ${client.clientCode} — qarzingiz: $${debt.balanceUsd.toFixed(2)}`
          : `✅ ${client.clientCode} — qarzingiz yo‘q` +
            (debt.balanceUsd < -0.009 ? ` (hisobingizda ortiqcha $${(-debt.balanceUsd).toFixed(2)} bor)` : '');
      await ctx.reply(head + (lines ? `\n\nSo‘nggi amallar:\n${lines}` : ''));
    }
  });

  bot.hears(BTN_HISTORY, async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    for (const client of linked) {
      const rows = await issuedHistory(client.id);
      if (!rows.length) {
        await ctx.reply(`${client.clientCode} — hali berilgan yuklar yo‘q.`);
        continue;
      }
      const text =
        `🗄 ${client.clientCode} — berilgan yuklar:\n\n` +
        rows
          .map(
            (r) =>
              `${r.letter ?? '·'} — ${r.productNameZh}${r.productNameRu ? ` (${r.productNameRu})` : ''}: ${r.n} dona · ${new Date(r.lastAt).toLocaleDateString('uz-UZ')}`,
          )
          .join('\n');
      await ctx.reply(text.slice(0, 4000));
    }
  });

  bot.callbackQuery(/^ph:(.+)$/, async (ctx) => {
    const lotId = ctx.match[1]!;
    const linked = await clientsForChat(BigInt(ctx.chat!.id));
    const photos = await lotPhotoKeys(lotId, linked.map((c) => c.id));
    await ctx.answerCallbackQuery();
    if (!photos.length) {
      await ctx.reply('Bu yuk uchun rasm topilmadi.');
      return;
    }
    const storage = getStorage();
    try {
      const files = await Promise.all(
        photos.map(async (p) => {
          // Thumbnails are ~0.1 MB vs multi-MB originals — plenty for a phone.
          const key = p.thumb800Key ?? p.storageKey;
          return new InputFile(await storage.get(key), key.split('/').pop());
        }),
      );
      if (files.length === 1) {
        await ctx.replyWithPhoto(files[0]!);
      } else {
        await ctx.replyWithMediaGroup(files.map((f) => ({ type: 'photo' as const, media: f })));
      }
    } catch (err) {
      logger.error({ err, lotId }, 'cabinet photo send failed');
      await ctx.reply('Rasm yuborishda xatolik. Birozdan so‘ng qayta urinib ko‘ring.');
    }
  });
}
