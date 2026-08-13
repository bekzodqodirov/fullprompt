import { staffForChat, startMenuFor } from './staff-bot';
import { bothKeyboard, staffKeyboard } from './staff-handlers';
import { cabinetKeyboard } from './client-cabinet';

/**
 * The reply keyboard a chat is OWED right now — re-derived, never remembered
 * (round 100, 13A).
 *
 * Telegram reply keyboards are exclusive: any reply that carries one REPLACES
 * whatever is on the phone. /start learned to merge the staff and cabinet
 * keyboards for a chat that is both — but the language switch, the calc-save
 * reply and the staff-link success each re-sent their own single-role
 * keyboard, silently taking the other half away one button-press later.
 * Every keyboard-bearing reply asks THIS instead of naming a keyboard.
 *
 * The client book is wms and this module is platform, so the crossing is a
 * dynamic import — the `lookupFromBot` pattern.
 */
export async function replyKeyboardFor(chatId: bigint, locale?: string | null) {
  const staff = await staffForChat(chatId);
  const { clientsForChat } = await import('../../wms/client-cabinet/service');
  const linked = await clientsForChat(chatId).catch(() => []);
  const menu = startMenuFor(staff, linked.length);
  const loc = locale ?? linked.find((c) => c.locale)?.locale ?? null;
  if (menu === 'both') return bothKeyboard(loc);
  if (menu === 'staff') return staffKeyboard();
  if (menu === 'cabinet') return cabinetKeyboard(loc);
  return undefined;
}
