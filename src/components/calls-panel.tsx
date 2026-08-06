import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, tgViewerFor } from '@/modules/wms/crm/conversations';
import { callsForCard } from '@/modules/wms/calls/service';

/**
 * This client's recorded phone calls, beside the Telegram thread on the
 * client / deal / lead cards. Same doorman as the chat panel — the owner's
 * answer was «xuddi telegram kabi»: the taker reads their own calls, the
 * supervision set reads everything, and the check TRAVELS WITH the panel
 * because a deal card is open to `ved.docs` too (#299's lesson).
 *
 * The audio element points at the ordinary attachment route, whose
 * `call_log` branch enforces the same rule per file — so a copied URL
 * cannot out-read the panel.
 */
export async function CallsPanel({ clientId }: { clientId: string | null }) {
  if (!clientId) return null;
  const actor = await getActor();
  if (!actor || !canReadTg(actor)) return null;

  const viewer = tgViewerFor(actor);
  // Widened to phone-siblings: a call lands on the person's OLDEST code, and
  // the card in front of the reader may be a newer one (round 32's shape).
  const rows = await callsForCard(clientId, viewer);
  // No calls this viewer may see — say nothing rather than put an empty box
  // on every card in the system (the thread panel's rule).
  if (rows.length === 0) return null;

  const t = await getTranslations('crm');
  const format = await getFormatter();
  const dur = (sec: number) =>
    sec >= 3600
      ? `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
      : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  return (
    <section className="card space-y-2" data-testid="calls-panel">
      <h2 className="text-lg font-bold">📞 {t('callsTitle')}</h2>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg border border-line px-3 py-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={row.direction === 'in' ? 'text-good' : 'text-brand-700'}>
                {row.direction === 'in' ? `↙ ${t('callIn')}` : `↗ ${t('callOut')}`}
              </span>
              <span className="font-semibold">{row.takerName}</span>
              {/* The call sits on the person's OTHER code — say which. */}
              {row.clientId !== clientId && (
                <span className="font-mono text-xs font-semibold text-ink-500">{row.clientCode}</span>
              )}
              <span className="text-ink-500">
                {format.dateTime(row.startedAt, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              {/* 0:00 is a real answer: the call was not picked up. */}
              <span className="ml-auto font-mono text-xs text-ink-500">{dur(row.durationSec)}</span>
            </div>
            {row.attachmentId && (
              // preload=none: a card with thirty calls must not download
              // thirty recordings to draw itself.
              <audio
                controls
                preload="none"
                src={`/api/attachments/${row.attachmentId}`}
                className="mt-1.5 h-9 w-full"
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
