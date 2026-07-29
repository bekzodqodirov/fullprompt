import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientFeed, type FeedItem, type FeedKind } from '@/modules/wms/crm/feed';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { TelegramReply } from './telegram-reply';
import { FeedNoteBox } from './client-feed-note';
import { LightboxImg } from './lightbox-img';

/**
 * The «lenta» — one client, everything that happened, in one column.
 *
 * Owner: "amocrm bitrixlardek katta polyada ketma-ketlikda ko'rinib tursa
 * yaxshi edi ... chatga o'xshab qachon nima bo'lgani 1 joyda ko'rinar edi."
 *
 * The shape of this screen is the whole point, so it is worth saying what it
 * is NOT: not eight panels you scroll between looking for the thing you half
 * remember. A Telegram message, a consignment arriving, a payment landing and
 * a note somebody left are the same kind of thing — something that happened,
 * at a time, done by a person — and the moment you draw them that way the
 * question "what is going on with this client" has one answer instead of
 * five places to look.
 *
 * Read like a chat: oldest above, newest at the bottom, composer under it.
 * `flex-col-reverse` over a newest-first list gives reading order AND a first
 * painted frame already at the bottom, with no scrolling after paint (#302).
 *
 * It gates itself, like every other panel that can appear on any card (#299).
 */

/** Each kind owns a mark and a tone. Lookup maps — Tailwind cannot see a built class. */
const MARK: Record<FeedKind, string> = {
  tg_in: '💬',
  tg_out: '↩️',
  tg_pending: '◷',
  note: '📝',
  cargo: '📥',
  crate: '🧰',
  departed: '🚚',
  arrived: '📍',
  cancelled: '↩️',
  lost: '⚠️',
  handover: '✅',
  charge: '🧾',
  payment: '💵',
};

const TONE: Record<FeedKind, string> = {
  tg_in: 'bg-surface-sunken',
  tg_out: 'ml-auto bg-brand-50',
  tg_pending: 'ml-auto border border-dashed border-line-strong text-ink-500',
  note: 'bg-warn/10',
  cargo: 'bg-good/10',
  crate: 'bg-surface-sunken',
  departed: 'bg-brand-50',
  arrived: 'bg-good/10',
  cancelled: 'bg-warn/10',
  lost: 'bg-bad/10 text-bad',
  handover: 'bg-good/10',
  charge: 'bg-surface-sunken',
  payment: 'bg-good/10',
};

/**
 * The one line a person reads. A map rather than a key built from `kind`,
 * because a missing i18n key throws at RENDER time in every locale and one
 * assembled at runtime is invisible to the locale test (#163, #310).
 */
export const FEED_LABELS: Record<FeedKind, string> = {
  tg_in: 'feedClientWrote',
  tg_out: 'feedWeAnswered',
  tg_pending: 'feedQueued',
  note: 'feedNote',
  cargo: 'feedCargo',
  crate: 'feedCrate',
  departed: 'feedDeparted',
  arrived: 'feedArrived',
  cancelled: 'feedCancelled',
  lost: 'feedLost',
  handover: 'feedHandover',
  charge: 'feedCharge',
  payment: 'feedPayment',
};

function money(meta: Record<string, unknown>): string {
  const amount = Number(meta.amount ?? 0);
  const currency = String(meta.currency ?? '');
  return `${amount.toLocaleString('ru-RU')} ${currency}`;
}

export async function ClientFeed({
  clientId,
  leadId = null,
  dealId = null,
  limit = 60,
  /** On a card the box is short; on a dedicated screen it fills the height. */
  tall = false,
}: {
  clientId: string | null;
  /** Set on a lead card: the lenta then lives even before there is a client. */
  leadId?: string | null;
  /** Set on a deal card: notes written here belong to THIS job, and the deal's
      own chat shows alongside the client's history. */
  dealId?: string | null;
  limit?: number;
  tall?: boolean;
}) {
  // The first cut returned null here whenever the client was unresolved —
  // which on the CRM card meant no timeline AND no internal chat for most
  // leads, since a lead usually is not a client yet. The owner read that as
  // "it was never added", and from where he sat it hadn't been: a panel that
  // renders nothing did not ship in any sense that matters.
  if (!clientId && !leadId && !dealId) return null;
  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads') && !actor?.permissions.has('clients.manage')) {
    return null;
  }

  const t = await getTranslations('crm');
  // The actor's eyes: shared record in full, Telegram lines own-account only.
  const items = await clientFeed(clientId, actor.id, { limit, leadId, dealId });

  return (
    <section className="card space-y-2" data-testid="client-feed">
      <h2 className="text-lg font-bold">🕘 {t('feedTitle')}</h2>

      {items.length === 0 ? (
        <p className="text-center text-sm text-ink-500">{t('feedEmpty')}</p>
      ) : (
        <div
          className={`flex flex-col-reverse gap-2 overflow-y-auto ${
            tall ? 'max-h-[60dvh]' : 'max-h-[28rem]'
          }`}
          data-testid="feed-list"
        >
          {items.map((item) => (
            <FeedRow key={item.id} item={item} t={t} />
          ))}
        </div>
      )}

      {/* Two ways to say something, the way every CRM does it: a word to the
          client, or a word to your colleagues. */}
      <div className="space-y-2 border-t border-line pt-2">
        {/* Telegram needs a real client conversation; the internal chat does
            not, and must not vanish with it — it is the staff's half. */}
        <TelegramReply clientId={clientId} compact />
        <FeedNoteBox
          // On a deal card the note belongs to THIS job: two deals with one
          // client are two conversations, and a price argument about one must
          // not surface on the other. Elsewhere: the client, then the lead.
          entityType={dealId ? 'deal' : clientId ? 'client' : 'lead'}
          entityId={dealId ?? clientId ?? leadId!}
          people={await mentionablePeople()}
          labels={{
            placeholder: t('feedNotePlaceholder'),
            save: t('feedNoteSave'),
            saving: t('feedNoteSaving'),
            attach: t('feedNoteAttach'),
          }}
        />
      </div>
    </section>
  );
}

function FeedRow({
  item,
  t,
}: {
  item: FeedItem;
  t: Awaited<ReturnType<typeof getTranslations<'crm'>>>;
}) {
  const label = t(FEED_LABELS[item.kind] as 'feedNote');
  const voided = item.meta.voided === true;
  // An activity is not always a note: the lead form records calls, meetings
  // and messages too, and each kept its icon on the old panel. The label
  // stays one word; the mark says which kind it was.
  const ACTIVITY_MARK: Record<string, string> = { call: '📞', meeting: '🤝', message: '💬' };
  const mark =
    item.kind === 'note' ? (ACTIVITY_MARK[String(item.meta.kind)] ?? MARK.note) : MARK[item.kind];

  return (
    <div
      className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${TONE[item.kind]} ${
        voided ? 'opacity-60' : ''
      }`}
      data-testid={`feed-${item.kind}`}
    >
      <div className="mb-0.5 flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-500">
        <span className="font-semibold">
          {mark} {label}
          {/* A voided entry stays on the timeline: it happened, and then
              somebody undid it, and both are part of the story. */}
          {voided && ` · ${t('feedVoided')}`}
        </span>
        <span className="whitespace-nowrap">
          {item.at.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
          {item.actor ? ` · ${item.actor}` : ''}
        </span>
      </div>

      {item.kind === 'cargo' && (
        <p className="font-semibold">
          {String(item.meta.number ?? '')} · {String(item.meta.warehouse ?? '')} ·{' '}
          {String(item.meta.boxes ?? 0)} {t('feedBoxes')}
        </p>
      )}
      {(item.kind === 'departed' ||
        item.kind === 'arrived' ||
        item.kind === 'cancelled' ||
        item.kind === 'lost') && (
        <p className="font-semibold">
          {[
            item.meta.batch ? String(item.meta.batch) : null,
            item.meta.plate ? String(item.meta.plate) : null,
            item.meta.warehouse ? String(item.meta.warehouse) : null,
            `${String(item.meta.boxes ?? 0)} ${t('feedBoxes')}`,
            // Only the arrival distinguishes "ready to collect" from "here":
            // `unload.ts` decides that per warehouse, so it is read, not assumed.
            item.kind === 'arrived' && item.meta.ready === true ? t('feedReady') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {item.kind === 'crate' && (
        <p className="font-semibold">
          {String(item.meta.code ?? '')} · {String(item.meta.warehouse ?? '')}
        </p>
      )}
      {item.kind === 'handover' && (
        <p className="font-semibold">
          {String(item.meta.person ?? '')} {String(item.meta.phone ?? '')} ·{' '}
          {String(item.meta.warehouse ?? '')}
          {/* A manager overrode the debt gate to let this cargo go. Exactly the
              kind of thing the owner wants visible in one place. */}
          {item.meta.debtOverride === true && ` · ⚠ ${t('feedDebtOverride')}`}
        </p>
      )}
      {(item.kind === 'charge' || item.kind === 'payment') && (
        <p className="font-semibold">{money(item.meta)}</p>
      )}
      {item.body ? (
        <p className="whitespace-pre-wrap break-words">{item.body}</p>
      ) : item.meta.hasMedia === true &&
        !(Array.isArray(item.meta.files) && item.meta.files.length > 0) ? (
        // Media we did NOT download — the paperclip stays honest about it.
        <p className="text-ink-500">📎 {t('telegramMedia')}</p>
      ) : null}
      {/* Files pinned to a note: pictures open in the lightbox, the rest
          download by name. */}
      {Array.isArray(item.meta.files) && item.meta.files.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(item.meta.files as { id: string; name: string; image: boolean }[]).map((file) =>
            file.image ? (
              <LightboxImg
                key={file.id}
                attachmentId={file.id}
                className="h-16 w-16 rounded-lg object-cover"
              />
            ) : (
              <a
                key={file.id}
                href={`/api/attachments/${file.id}`}
                target="_blank"
                rel="noreferrer"
                className="max-w-48 truncate rounded-lg bg-surface-raised px-2 py-1 text-xs font-semibold hover:underline"
              >
                📎 {file.name}
              </a>
            ),
          )}
        </div>
      )}
      {item.kind === 'tg_pending' && item.meta.error ? (
        <p className="mt-1 text-xs text-bad">{String(item.meta.error)}</p>
      ) : null}
    </div>
  );
}
