import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { offerableMatches } from '@/modules/wms/crm/peer-index';
import { Panel } from '@/components/panel';
import { LookbackAttach } from './telegram-lookback-attach';

/**
 * «Bu raqam bilan gaplashilganmi?» — the owner's reverse lookup.
 *
 * His ask, in his words: when a lead, a deal or a client is opened, look back
 * into the connected Telegram accounts for that number and offer the
 * conversation that already exists. Until now the loop only ran the other
 * way — a chat could find its card, a card could not find its chat.
 *
 * Three rules make it safe to show, and all three are visible in the markup:
 *
 *  - it names the MANAGER and never the peer. `tg_peer_index` holds a hash
 *    and no name (#588), so there is nothing else it could print even if
 *    somebody wanted it to.
 *  - a COLLEAGUE's match is a sentence, not a button. Knowing a conversation
 *    exists is not permission to open it (round 20), so the only thing on
 *    offer is who to ask.
 *  - it renders NOTHING when there is no match, and nothing once the chat has
 *    been answered either way. A panel that says «topilmadi» on every card
 *    would be a row of noise on hundreds of screens to be useful on three.
 *
 * Coverage is partial by construction and the owner was told so: Telegram
 * reveals a number only to contacts, so a client the manager never saved is
 * invisible to this. The absence of a line means «not found», never «we have
 * never spoken to them».
 */
export async function TelegramLookback({
  phone,
  clientId,
  leadId,
}: {
  phone: string | null | undefined;
  clientId?: string | null;
  leadId?: string | null;
}) {
  const actor = await getActor();
  if (!actor) return null;
  if (!clientId && !leadId) return null;

  const matches = await offerableMatches(phone, actor.id);
  if (matches.length === 0) return null;

  const t = await getTranslations('crm');
  return (
    // Open by default and NOT folded: it renders only when it has something
    // to say, and a fold over one line is a tap standing between somebody and
    // the answer they did not know to look for.
    <Panel title={`✈️ ${t('lookbackTitle')}`} open badge={matches.length} testId="tg-lookback">
      <ul className="space-y-2">
        {matches.map((match) => (
          <li
            key={`${match.managerUserId}:${match.peerId}`}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="min-w-0 flex-1 text-sm">
              {match.own ? t('lookbackMine') : match.managerName}
            </span>
            {match.own ? (
              <LookbackAttach
                peerId={match.peerId.toString()}
                phone={phone ?? ''}
                clientId={clientId ?? null}
                leadId={leadId ?? null}
                label={t('lookbackAttach')}
              />
            ) : (
              // Named, not opened. The person creating the card now knows who
              // to ask, which is the whole of what this may tell them.
              <span className="text-xs text-ink-500">{t('lookbackAsk')}</span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
