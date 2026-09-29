import { logger } from '../logger';
import { CLIENT_LOCALES, clientLabels, type ClientLocale } from './client-labels';
import { botCall } from './send';
import { holatFor } from './staff-bot';

/**
 * What the bot says about itself — its command menus and its profile.
 */

interface CommandsApi {
  setMyCommands: (
    commands: { command: string; description: string }[],
    other?: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Put «/hodim» in THIS chat's command menu, and only this chat's.
 *
 * A global command list would show a staff command to every customer, and in a
 * cabinet chat the corner button is the Mini App anyway. Fire and forget: the
 * poller is sequential and a command menu is not worth holding it.
 *
 * Moved out of `bot.ts` in round C so the phone-contact staff link can call it
 * too — until then only `/start <code>` and `/hodim` offered the menu, and a
 * person linked by sharing their number never got one.
 */
export function offerStaffCommands(ctx: { api: CommandsApi }, chatId: number): void {
  void (async () => {
    // «/holat» only for the person the evening summary is for — the same
    // door as the «📊 Holat» button (`holatFor`); a failed question offers
    // the ordinary menu rather than none.
    const holat = await holatFor(BigInt(chatId)).catch(() => false);
    await ctx.api.setMyCommands(
      [
        { command: 'hodim', description: 'Hodim rejimi' },
        { command: 'bugun', description: 'Bugungi vazifalar' },
        { command: 'zametka', description: 'Zametkalar' },
        // Both have always WORKED as typed commands (staff-handlers answers
        // «/hisoblatish» and «/ai» beside their buttons); round C puts them
        // where a person can find them.
        { command: 'hisoblatish', description: 'Hisoblatish' },
        { command: 'ai', description: 'AI rastamojka' },
        ...(holat ? [{ command: 'holat', description: 'Kompaniya holati (kechki xulosa)' }] : []),
      ],
      { scope: { type: 'chat', chat_id: chatId } },
    );
  })().catch(() => {});
}

/** Once per process — a deploy restarts it, and that is often enough. */
let profileEnsured = false;

/**
 * The bot's own profile in each language (round C): the text a person reads
 * BEFORE pressing Start («What can this bot do?»), the line under its name,
 * and the one command a customer needs.
 *
 * Until now all three sat in BotFather, typed once by hand, in one language,
 * and describing nothing a customer could do. Set from the dictionary, so the
 * profile says what the cabinet says.
 *
 * Each setting is read first and written only when it differs — a restart
 * costs a handful of reads, not a burst of writes. Every call carries a short
 * deadline and the whole thing is dispatched off the poller by the caller; a
 * failure is a log line, never a bot that does not start.
 *
 * The call with NO language code sets what everyone else sees — Russian,
 * the same fallback as every client sentence (`clientLabels`).
 */
export async function ensureBotProfile(): Promise<void> {
  if (profileEnsured) return;
  profileEnsured = true;
  const targets: (ClientLocale | null)[] = [...CLIENT_LOCALES, null];
  for (const locale of targets) {
    const t = clientLabels(locale ?? undefined);
    const lang: Record<string, string> = locale ? { language_code: locale } : {};
    try {
      await ensure('getMyDescription', 'setMyDescription', 'description', t.botDescription, lang);
      await ensure(
        'getMyShortDescription',
        'setMyShortDescription',
        'short_description',
        t.botShortDescription,
        lang,
      );
      await botCall('setMyCommands', { commands: [{ command: 'start', description: t.cmdStart }], ...lang }, 10_000);
    } catch (err) {
      logger.warn({ err, locale }, 'bot profile not set');
    }
  }
}

async function ensure(
  getMethod: string,
  setMethod: string,
  field: 'description' | 'short_description',
  wanted: string,
  lang: Record<string, string>,
): Promise<void> {
  const current = await botCall(getMethod, { ...lang }, 10_000);
  const have = (current.result as Record<string, string> | null)?.[field] ?? null;
  if (current.ok && have === wanted) return;
  const set = await botCall(setMethod, { [field]: wanted, ...lang }, 10_000);
  if (!set.ok) logger.warn({ method: setMethod, description: set.description }, 'bot profile refused');
}
