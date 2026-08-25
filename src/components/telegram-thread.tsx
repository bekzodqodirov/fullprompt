import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { pendingFor } from '@/modules/wms/crm/outbox';
import {
  canReadTg,
  conversationClient,
  conversationFor,
  conversationForLead,
  tgViewerFor,
  threadClientFor,
  threadManagers,
} from '@/modules/wms/crm/conversations';
import { chatPulseForClient, chatPulseForLead } from '@/modules/wms/crm/pulse';
import { ChatPulse } from './chat-pulse';
import { OutboxBubble } from './outbox-bubble';
import { TelegramBubble } from './telegram-bubble';
import { ThreadManagers } from './thread-managers';
import { TelegramReply } from './telegram-reply';
import { ThreadCalc } from './thread-calc';

/**
 * The Telegram conversation with this client, as a panel on a card.
 *
 * Owner: "bitim va crm bo'limida telefon raqamli kartochkalar bor u yerda ham
 * tursin chat." It goes on the client card, the deal card and the lead card —
 * anywhere the person is the subject of the screen.
 *
 * It CARRIES ITS OWN PERMISSION CHECK, and that is the design rather than a
 * detail. The deal card is open to `ved.docs` as well as sales
 * (`DEAL_WRITE_PERMISSIONS`), so an ungated panel dropped onto it would quietly
 * hand the customs manager every private sales conversation in the company.
 * A component meant to sit on any card has to be safe on any card, so the
 * check travels with it instead of living in whichever page remembers.
 *
 * It can also be answered from, since phase 4 — the owner asked for the send
 * box on the client, deal and lead cards, not only on the «Suhbatlar» screen,
 * and he is right: somebody reading a client's chat here wants to reply here.
 * `TelegramReply` carries its own checks, so the panel does not have to know
 * when a reply is allowed.
 *
 * Read in the order it happened, and opening on the LAST message. The first
 * cut showed it newest-first, on the theory that a card is a reference rather
 * than a conversation; the owner read it as simply upside-down, and he is
 * right — nobody reads a chat backwards. `flex-col-reverse` over a
 * newest-first list gives both: reading order on screen, and a scroll box
 * whose first painted frame is already at the bottom, with no jump.
 */
export async function TelegramThread({
  clientId,
  leadId,
  limit = 200,
  hodim,
  hrefFor,
  calcTarget,
}: {
  clientId: string | null;
  /**
   * Round 100: a chat that OPENED a lead (0064 gave `tg_messages` a
   * `lead_id`) was invisible on the very card it minted. When no client
   * resolves, the panel shows the lead's own rows instead — read-only,
   * because the outbox is keyed to the client book and the conversation
   * lives on the manager's own phone.
   */
  leadId?: string;
  limit?: number;
  /**
   * Whose conversation to read (owner, 2026-08-07). The card PAGE takes it off
   * its own URL and passes it here, so picking a colleague filters this panel
   * in place instead of throwing the reader onto another screen — which is
   * what the chips used to do, and why «qaysi biri qanday gaplashgan» could
   * not be answered where the work happens.
   */
  hodim?: string;
  /** How this card's URL carries the choice; absent ⇒ names, no selector. */
  hrefFor?: (managerId: string | null) => string;
  /**
   * Where «Hisoblatishga yuborish» lands. The DEAL card passes its own deal
   * so the request opens on the job on screen and not on the client's newest
   * one; without it the service falls back to the bot's own landing rule.
   * Re-proved server-side — a posted entity is a forged post (#514).
   */
  calcTarget?: { kind: 'deal'; id: string };
}) {
  const actor = await getActor();
  // The CRM grants, or the supervision view (round 33: vedchi and admin read
  // every chat — the calc files arrive in whichever manager's chat the
  // client uses).
  if (!actor || !canReadTg(actor)) return null;

  const t = await getTranslations('crm');
  // The same read the «Suhbatlar» screen makes — own account only, or the
  // whole company for the owner's supervision view (#383, round 21).
  const viewer = tgViewerFor(actor);

  if (!clientId) {
    // Nobody's client yet — but a lead born from a chat HAS a conversation,
    // keyed to the lead itself (round 82). Without this branch the card that
    // exists BECAUSE somebody wrote showed no trace of what they wrote.
    if (!leadId) return null;
    const rows = await conversationForLead(leadId, viewer, limit);
    if (rows.length === 0) return null;
    const pulse = await chatPulseForLead(actor, leadId);
    return (
      <section className="card space-y-2" data-testid="tg-thread">
        <h2 className="text-lg font-bold">✈️ {t('telegramThread')}</h2>
        {/* Refresh only when the thread MOVED — the blind 10 s full-page
            loop was round 108's headline load (the token is computed in
            THIS render, so nothing between render and first poll is
            swallowed). */}
        {pulse && <ChatPulse query={`lead=${leadId}`} initial={pulse.t} fast={pulse.fast} />}
        <div className="flex max-h-96 flex-col-reverse gap-1.5 overflow-y-auto">
          {rows.map((row) => (
            <TelegramBubble
              key={row.id}
              message={row}
              clientLabel={t('telegramClient')}
              mediaLabel={t('telegramMedia')}
            />
          ))}
        </div>
        {/* The third calc door (owner, 2026-08-25) — OUTSIDE the scroll box,
            or the bar scrolls away with the history. */}
        <ThreadCalc entity={{ kind: 'lead', id: leadId }} />
      </section>
    );
  }
  // The thread may live under a phone-sibling GS code (one person, several
  // codes; the import pinned the chat to whichever code the phone matched) —
  // the card must find it there too, or a deal on the sibling code shows an
  // empty card while «Suhbatlar» holds the conversation.
  const threadClientId = await threadClientFor(clientId, viewer);
  // Nothing imported for this person — say nothing rather than show an empty
  // box on every card in the system.
  if (!threadClientId) return null;
  const rows = await conversationFor(threadClientId, viewer, limit, hodim);
  // Nothing at all → the panel stays away. But a filter that matches nothing
  // must NOT make the panel disappear: vanishing on a click reads as a broken
  // screen, and the way back is the fold that is no longer on screen.
  if (rows.length === 0 && !hodim) return null;
  const siblingCode =
    threadClientId === clientId ? null : (await conversationClient(threadClientId))?.clientCode;
  // WHO has talked with this person (owner: the card must list the staff so
  // the reader can pick whose conversation to open). Names are shared
  // knowledge; a supervision viewer's chips LINK to that manager's thread,
  // everyone else reads the names and their own thread below.
  const managers = await threadManagers(threadClientId);

  // Replies that have not gone yet. Shown here too, because a manager who
  // answered from this very panel must see that the answer is still waiting —
  // otherwise the panel looks exactly as it did before they typed.
  const queued = await pendingFor(threadClientId, viewer);

  // The baseline for the pulse, computed in the SAME render that drew the
  // rows above — the poller compares against what this screen shows, never
  // against a token it invented after mounting.
  const pulse = await chatPulseForClient(actor, clientId, { sibling: true });

  return (
    <section className="card space-y-2" data-testid="tg-thread">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">
          ✈️ {t('telegramThread')}
          {/* The chat lives under the person's OTHER code — say which. */}
          {siblingCode && (
            <span className="ml-2 font-mono text-sm font-semibold text-ink-500">{siblingCode}</span>
          )}
        </h2>
        {/* The panel is a glance; the whole conversation is one tap away. */}
        <Link href={`/suhbatlar/${threadClientId}`} className="text-sm text-ink-500 underline">
          {t('conversations')} →
        </Link>
      </div>
      <div data-testid="card-managers">
        <ThreadManagers
          managers={managers}
          active={hodim ?? null}
          // Only where the page can carry the choice, and only for the eyes
          // `conversationFor` will actually honour it for.
          hrefFor={viewer.all && hrefFor ? hrefFor : undefined}
          labels={{ who: t('whoTalked'), all: t('allManagers') }}
        />
      </div>
      {/* The queue moves while this card is open — the listener sends within
          seconds — so the panel refreshes itself. Without it the «navbatda»
          line sat there until somebody reloaded the page, which is the
          owner's report twice over (round 25). HOW it refreshes changed in
          round 108: the old loop re-rendered this whole page blind — every
          2 s while pendingFor returned rows, and pendingFor includes
          `failed`, which only a human's ✕ clears, so ONE bad reply pinned
          an open card at half a heavy render per second for ever. The pulse
          asks a cheap token instead and refreshes only when the thread
          actually moved; the fast beat survives inside it, priced at a few
          indexed counts instead of a full page. */}
      {pulse && (
        <ChatPulse
          query={`client=${clientId}&sibling=1`}
          initial={pulse.t}
          fast={pulse.fast}
        />
      )}
      <div className="flex max-h-96 flex-col-reverse gap-1.5 overflow-y-auto">
        {[...queued].reverse().map((row) => (
          <OutboxBubble
            key={row.id}
            row={row}
            labels={{ queued: t('replyQueued'), stuck: t('replyStuck'), failed: t('replyFailed') }}
          />
        ))}
        {rows.map((row) => (
          <TelegramBubble
            key={row.id}
            message={row}
            clientLabel={t('telegramClient')}
            mediaLabel={t('telegramMedia')}
          />
        ))}
      </div>

      {/* The third calc door (owner, 2026-08-25) — a sibling of the scroll
          box, never inside it. */}
      <ThreadCalc entity={calcTarget ?? { kind: 'client', id: clientId }} />

      {/* Owner: the send box must be here too, not only on «Suhbatlar» —
          replying onto the code that actually HOLDS the chat. */}
      <TelegramReply clientId={threadClientId} compact />
    </section>
  );
}
