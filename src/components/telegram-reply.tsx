import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { conversationManagers, replyAccountFor, sendContextFor } from '@/modules/wms/crm/outbox';
import { canQueue } from '@/modules/wms/crm/telegram-send';
import { TelegramReplyBox } from './telegram-reply-box';
import { TelegramStopTaking } from './telegram-stop-taking';

/**
 * The compose box, wherever a conversation is shown.
 *
 * Owner: "crm kartochkalarda, bitim kartochkalarda va chatda sms jo'natish
 * ko'rinmayapti." It was on the «Suhbatlar» thread and nowhere else — my
 * omission. A person reading a client's chat on the client card wants to
 * answer it there, not navigate to another screen first.
 *
 * It carries its own checks rather than trusting whichever page renders it,
 * for the same reason the thread panel does (#299): a component that appears
 * on any card has to be safe on any card. Everything it asks is the same
 * thing the action re-asks, so the screen can never offer what the door would
 * refuse.
 *
 * When a reply CANNOT go, it says which — never a disabled box with no
 * explanation. "Why can't I type" is a question somebody answers by
 * restarting a server.
 */
export async function TelegramReply({
  clientId,
  /** Cards are cramped; the full thread has room for the reason in full. */
  compact = false,
}: {
  clientId: string | null;
  compact?: boolean;
}) {
  if (!clientId) return null;
  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads') && !actor?.permissions.has('clients.manage')) {
    return null;
  }

  const t = await getTranslations('crm');
  const account = await replyAccountFor(clientId, actor.id);

  // No conversation with ANYBODY is a different fact from "somebody else's
  // conversation", and the card was stating the second when the truth was
  // the first (owner: "crm kartalarda eng asosiysi telegram yo'q") — a line
  // about another manager, where the honest answer is "not linked yet, and
  // here is how it links".
  if (!account) {
    const managers = await conversationManagers(clientId);
    if (managers.length === 0) {
      return (
        <div className="shrink-0 text-center" data-testid="reply-blocked">
          <p className="text-xs font-semibold text-ink-700">💬 {t('replyNoChat')}</p>
          <p className="text-xs text-ink-500">{t('replyNoChatHint')}</p>
        </div>
      );
    }
    return (
      <p className="shrink-0 text-center text-xs text-ink-500" data-testid="reply-blocked">
        {t('replyNotYours')} · {managers.join(', ')}
      </p>
    );
  }

  const verdict = account
    ? canQueue(
        // A single character, only to get past the empty check: this asks
        // "could a reply go at all", not "is this particular text allowed".
        'x',
        await sendContextFor({
          clientId,
          managerUserId: account.managerUserId,
          peerId: account.peerId,
        }),
      )
    : ({ ok: false, reason: 'not_your_conversation' } as const);

  const reasons: Record<string, string> = {
    sending_disabled: t('replyDisabled'),
    never_wrote_first: t('replyNeverWrote'),
    bridge_down: t('replyBridgeDown'),
    rate_minute: t('replyRateLimited'),
    rate_day: t('replyRateLimited'),
    rate_chat: t('replyRateLimited'),
    flood_wait: t('replyRateLimited'),
    not_your_conversation: t('replyNotYours'),
    too_long: t('replyTooLong'),
    empty: t('replyEmpty'),
    no_actor: t('replyNotYours'),
  };

  if (!verdict.ok) {
    // On a card this is one quiet line; nobody needs a red box on a client
    // card because the company switch is off.
    return (
      <p className="shrink-0 text-center text-xs text-ink-500" data-testid="reply-blocked">
        {reasons[verdict.reason] ?? verdict.reason}
      </p>
    );
  }

  return (
    <div className="shrink-0 space-y-1">
      <TelegramReplyBox
        clientId={clientId}
        compact={compact}
        labels={{
          placeholder: t('replyPlaceholder'),
          send: t('replySend'),
          sending: t('replySending'),
          errors: reasons,
        }}
      />
      {/* The other half of "which chats": stop taking one the phone rule
          matches. Only offered where a conversation is actually visible, and
          only on your own account — the same rule as replying. */}
      <div className="text-center">
        <TelegramStopTaking
          clientId={clientId}
          labels={{
            stop: t('chatStopTaking'),
            hint: t('chatStopTakingHint'),
            cancel: t('chatCancel'),
          }}
        />
      </div>
    </div>
  );
}
