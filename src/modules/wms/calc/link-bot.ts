import { botActorFor } from '@/modules/platform/telegram/staff-bot';
import { calcControlScopeFor } from './control-scope';
import { answerLinkAsk, type LinkAskOutcome } from './link';

/**
 * A ✅/❌ pressed under a «Bu prixodlar hisobingizga tegishlimi?» (0119).
 *
 * The chat id is not a session: the person behind it is re-derived from the
 * chat (`botActorFor`, the same three answers `getActor` gives), and their
 * door is the control screen's (`calcControlScopeFor`) — asked BEFORE any
 * receipt is read, so a chat with no door learns nothing, not even whether
 * the prixod exists. The scope then rides into `answerLinkAsk`, whose
 * `assertMine` keeps a VED to the calculations they sealed themselves: a
 * forwarded message pressed by a colleague answers `not_mine`.
 */
export type LinkBotOutcome = LinkAskOutcome | 'not_linked' | 'forbidden';

export async function decideLinkFromBot(
  chatId: bigint,
  receiptId: string,
  requestPrefix: string,
  verdict: 'confirm' | 'drop',
): Promise<LinkBotOutcome> {
  const actor = await botActorFor(chatId);
  if (!actor) return 'not_linked';
  const scope = calcControlScopeFor(actor);
  if (scope === 'none') return 'forbidden';
  return answerLinkAsk(receiptId, requestPrefix, verdict, scope, { actorId: actor.id });
}
