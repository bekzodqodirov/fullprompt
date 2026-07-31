import type { Bot } from 'grammy';
import { composeMyDayText } from '../tasks/digest';
import { logger } from '../logger';
import {
  completeTaskFromBot,
  decideApprovalFromBot,
  linkStaffChat,
  noteStaffEntry,
  noteTaskPending,
  parseCallback,
  staffByPhone,
  staffForChat,
  takeStaffEntry,
  takeTaskPending,
} from './staff-bot';
import { phoneKeyboard } from './client-cabinet';

/**
 * The grammy shell of the staff bot — thin on purpose: every decision lives
 * in staff-bot.ts where the tests can reach it. Registered BEFORE the client
 * cabinet, and every handler that is not for this chat calls next(), so a
 * customer's contact or text falls through to the cabinet untouched.
 *
 * Staff texts are Uzbek, like every staff notification the system already
 * sends — the team writes Uzbek, and a bot that answers each person in the
 * office's four locales would be four times the words for the same button.
 */

const BUGUN = '📋 Bugun';

export function staffKeyboard() {
  return {
    keyboard: [[{ text: BUGUN }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function registerStaffBot(bot: Bot): void {
  bot.on('callback_query:data', async (ctx, next) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    if (!parsed) return next();
    const chatId = BigInt(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    if (parsed.kind === 'entry') {
      await ctx.answerCallbackQuery();
      if (parsed.who === 'client') {
        // The client door is the existing cabinet — nothing more (owner's
        // answer 4). Same phone-verified entry as always.
        const { clientLabels } = await import('./client-labels');
        const t = clientLabels(ctx.from?.language_code);
        await ctx.reply(`${t.notLinked}\n\n${t.linkByPhone}`, {
          reply_markup: phoneKeyboard(ctx.from?.language_code),
        });
        return;
      }
      // Staff door: ask for the Telegram-verified own number, and remember
      // WHY we asked — the contact handler must not staff-link a customer
      // who simply shared a phone.
      noteStaffEntry(chatId);
      await ctx.reply('Hodim sifatida ulanish uchun telefon raqamingizni yuboring 👇', {
        reply_markup: phoneKeyboard('uz'),
      });
      return;
    }

    if (parsed.kind === 'task_done') {
      const staff = await staffForChat(chatId);
      if (!staff) {
        await ctx.answerCallbackQuery({ text: 'Ulanmagan' });
        return;
      }
      noteTaskPending(chatId, parsed.taskId);
      await ctx.answerCallbackQuery();
      await ctx.reply('Natijani yozib yuboring (natijasiz yopish uchun «-» yuboring):');
      return;
    }

    // approval
    const outcome = await decideApprovalFromBot(chatId, parsed.approvalId, parsed.verdict);
    const answers: Record<string, string> = {
      decided: parsed.verdict === 'approved' ? '✅ Ruxsat berildi' : '⛔ Rad etildi',
      not_linked: 'Ulanmagan',
      forbidden: 'Bu qaror sizning huquqingizda emas',
      already_decided: 'Allaqachon hal qilingan',
      not_found: 'So‘rov topilmadi',
    };
    await ctx.answerCallbackQuery({ text: answers[outcome] });
    if (outcome === 'decided') {
      await ctx.reply(
        parsed.verdict === 'approved'
          ? '✅ Ruxsat berildi — beruvchiga xabar ketdi.'
          : '⛔ Rad etildi — so‘ragan xodimga xabar ketdi.',
      );
    }
  });

  // Staff phone-linking: ONLY after the «Hodim» button asked for it, so a
  // customer's shared contact falls through to the cabinet flow untouched.
  bot.on('message:contact', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);
    if (!takeStaffEntry(chatId)) return next();
    const contact = ctx.message.contact;
    // The cabinet's spoof-proof rule: only the sender's OWN number counts.
    if (contact.user_id !== ctx.from?.id) {
      await ctx.reply('Faqat o‘zingizning raqamingizni yuboring.');
      return;
    }
    const staff = await staffByPhone(contact.phone_number);
    if (!staff) {
      await ctx.reply(
        'Bu raqam xodimlar ro‘yxatida topilmadi. Sistemaga kirib Profil → Telegram ulash orqali urinib ko‘ring, yoki adminga ayting.',
      );
      return;
    }
    const outcome = await linkStaffChat(staff.id, chatId);
    if (outcome === 'chat_taken') {
      await ctx.reply('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');
      return;
    }
    await ctx.reply(`✅ Ulandi: ${staff.fullName}. Xabarnomalar shu yerga keladi.`, {
      reply_markup: staffKeyboard(),
    });
  });

  bot.on('message:text', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);

    // Step 2 of «Bajarildi»: this text IS the result.
    const pendingTask = takeTaskPending(chatId);
    if (pendingTask) {
      const result = ctx.message.text.trim() === '-' ? '' : ctx.message.text.trim();
      const outcome = await completeTaskFromBot(chatId, pendingTask, result);
      const answers: Record<string, string> = {
        done: '✅ Vazifa yopildi.',
        not_linked: 'Ulanmagan.',
        not_yours: 'Bu vazifa sizniki emas.',
        already_closed: 'Bu vazifa allaqachon yopilgan.',
        not_found: 'Vazifa topilmadi.',
      };
      await ctx.reply(answers[outcome] ?? outcome);
      return;
    }

    if (ctx.message.text === BUGUN || ctx.message.text === '/bugun') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      const text = await composeMyDayText(staff.id).catch((err) => {
        logger.warn({ err }, 'bugun compose failed');
        return null;
      });
      await ctx.reply(text ?? '✅ Bugunga ochiq vazifa yo‘q.');
      return;
    }

    return next();
  });
}

/** The two doors an unknown chat is offered (owner: «hodim yoki mijoz alohida kirish»). */
export function entryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '👨‍💼 Hodim', callback_data: 'e:s' },
        { text: '📦 Mijoz', callback_data: 'e:c' },
      ],
    ],
  };
}
