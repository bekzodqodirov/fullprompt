import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canReadTg, tgViewerFor } from '@/modules/wms/crm/conversations';
import { callsForCard, callsForLeadCard } from '@/modules/wms/calls/service';
import { ThreadManagers } from './thread-managers';

/**
 * This client's recorded phone calls, beside the Telegram thread on the
 * client / deal / lead cards. Same doorman as the chat panel — the owner's
 * answer was «xuddi telegram kabi»: the taker reads their own calls, the
 * supervision set reads everything, and the check TRAVELS WITH the panel
 * because a deal card is open to `ved.docs` too (#299's lesson).
 *
 * The per-manager selector (round 93, «telefonda gaplashgani ham userlar aro
 * tanlash imkoniyati telegramga o'xshab») is the thread's own fold, reused.
 * It filters over rows the viewer ALREADY holds — the fetch is viewer-scoped
 * first and the chips narrow it afterwards — so a hand-typed `chodim` in the
 * URL can only ever shrink what a person was going to see, never widen it.
 * A single conversation is one voice; a call log has no interleaving problem,
 * so «Hammasi» stays the honest default here.
 *
 * The audio element points at the ordinary attachment route, whose
 * `call_log` branch enforces the same rule per file — so a copied URL
 * cannot out-read the panel.
 */
export async function CallsPanel({
  clientId,
  lead,
  hodim,
  hrefFor,
}: {
  clientId: string | null;
  /** The LEAD card passes itself: its calls key on its own phone (0063) —
   * the chat resolver's one-target refusal must not blank a read-only log. */
  lead?: { id: string; phone: string | null } | null;
  /** `chodim` from the URL: whose calls to show. Absent = everyone's. */
  hodim?: string | null;
  /** The card owns its own URL shape, exactly as the thread panel does. */
  hrefFor?: (managerId: string | null) => string;
}) {
  if (!clientId && !lead) return null;
  const actor = await getActor();
  if (!actor || !canReadTg(actor)) return null;

  const viewer = tgViewerFor(actor);
  // Widened to phone-siblings: a call lands on the person's OLDEST code, and
  // the card in front of the reader may be a newer one (round 32's shape).
  const rows = lead
    ? await callsForLeadCard(lead, viewer)
    : await callsForCard(clientId!, viewer);
  // No calls this viewer may see — say nothing rather than put an empty box
  // on every card in the system (the thread panel's rule).
  if (rows.length === 0) return null;

  // Who took them, for the chips; the count is calls, not messages.
  const managers = [...new Map(rows.map((r) => [r.takerId, r.takerName ?? '?'])).entries()].map(
    ([id, name]) => ({ id, name, messages: rows.filter((r) => r.takerId === id).length }),
  );
  const active = hodim && managers.some((m) => m.id === hodim) ? hodim : null;
  const shown = active ? rows.filter((r) => r.takerId === active) : rows;

  const t = await getTranslations('crm');
  const format = await getFormatter();
  const dur = (sec: number) =>
    sec >= 3600
      ? `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
      : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  return (
    <section className="card space-y-2" data-testid="calls-panel">
      <h2 className="text-lg font-bold">📞 {t('callsTitle')}</h2>
      {/* Offered like the thread's selector: to the supervision view, when
          there is more than one voice to choose between. For everyone else
          the rows are their own calls already and a picker would be a row of
          buttons that change nothing. */}
      {viewer.all && managers.length > 1 && (
        <ThreadManagers
          managers={managers}
          active={active}
          hrefFor={hrefFor}
          labels={{ who: t('whoTalked'), all: t('allManagers') }}
        />
      )}
      <ul className="space-y-1.5">
        {shown.map((row) => (
          <li key={row.id} className="rounded-lg border border-line px-3 py-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={row.direction === 'in' ? 'text-good' : 'text-brand-700'}>
                {row.direction === 'in' ? `↙ ${t('callIn')}` : `↗ ${t('callOut')}`}
              </span>
              <span className="font-semibold">{row.takerName}</span>
              {/* The call sits on the person's OTHER code — say which. */}
              {row.clientCode && row.clientId !== clientId && (
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
