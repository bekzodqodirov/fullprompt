import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { replyAccountFor } from '@/modules/wms/crm/outbox';
import { TelegramStopTaking } from './telegram-stop-taking';

/**
 * The rare, considered things you can do to a conversation — kept away from
 * the ones you do every minute.
 *
 * Round 51, the owner: «chatni qo'shmaslik feature … hozir input fieldni
 * pastida turibti, uni boshqa yozishga halaqit qilmaydigan, oson bosilib
 * ketmaydigan joyga olish kerak». «Stop taking this chat» sat directly under
 * the compose box — a thumb's width from «Yuborish», on the one part of the
 * screen a phone keyboard pushes around, and since round 25 the action also
 * DELETES everything stored from that chat. Proximity to the send button is
 * the wrong place for the most destructive control in the feature.
 *
 * So it moved to the header, behind a fold, at the opposite end of the screen
 * from the keyboard. A native `<details>` for the same reasons the panels use
 * one: it works in a server component, ships no JavaScript, and closes with
 * the page. The popover is positioned rather than in flow, so the closed menu
 * costs the thread no height at all.
 *
 * Only where a conversation is genuinely the actor's own — the same rule as
 * replying. On somebody else's chat there is nothing here to offer, and the
 * menu does not render.
 */
export async function ChatMenu({ clientId }: { clientId: string }) {
  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads') && !actor?.permissions.has('clients.manage')) {
    return null;
  }
  if (!(await replyAccountFor(clientId, actor!.id))) return null;
  const t = await getTranslations('crm');

  return (
    <details className="shrink-0" data-testid="chat-menu">
      <summary
        className="btn-secondary !py-1 cursor-pointer list-none text-sm marker:content-none"
        aria-label={t('chatMenu')}
      >
        ⋯
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1 w-64 max-w-full space-y-2 rounded-xl border border-line bg-surface-raised p-3 text-left shadow-card">
        <p className="text-xs font-semibold text-ink-700">{t('chatMenu')}</p>
        <TelegramStopTaking
          clientId={clientId}
          labels={{
            stop: t('chatStopTaking'),
            hint: t('chatStopTakingHint'),
            cancel: t('chatCancel'),
          }}
        />
      </div>
    </details>
  );
}
