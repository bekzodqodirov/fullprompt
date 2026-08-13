import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientFeed, type FeedItem, type FeedKind } from '@/modules/wms/crm/feed';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
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
 * remember. A consignment arriving, a payment landing and a note somebody
 * left are the same kind of thing — something that happened, at a time, done
 * by a person — and the moment you draw them that way the question "what is
 * going on with this client" has one answer instead of five places to look.
 *
 * The TELEGRAM chat is deliberately NOT one of those things since round 21
 * (owner: «lenta va chatlar alohida tursin») — a two-way conversation woven
 * between cargo lines read as neither; it stands beside this panel as
 * `TelegramThread`, private to its account per #383.
 *
 * Read like a chat: oldest above, newest at the bottom, composer under it.
 * `flex-col-reverse` over a newest-first list gives reading order AND a first
 * painted frame already at the bottom, with no scrolling after paint (#302).
 *
 * It gates itself, like every other panel that can appear on any card (#299).
 */

/** Each kind owns a mark and a tone. Lookup maps — Tailwind cannot see a built class. */
const MARK: Record<FeedKind, string> = {
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
  const items = await clientFeed(clientId, { limit, leadId, dealId });

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
            <FeedRow key={item.id} item={item} t={t} viewerId={actor.id} />
          ))}
        </div>
      )}

      {/* The lenta's composer is the INTERNAL note — a word to colleagues.
          The word to the CLIENT lives in the chat panel beside this one,
          because the two are different acts with different audiences
          (owner, round 21: «lenta va chatlar alohida tursin»). */}
      <div className="space-y-2 border-t border-line pt-2">
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
  viewerId,
}: {
  item: FeedItem;
  t: Awaited<ReturnType<typeof getTranslations<'crm'>>>;
  viewerId: string;
}) {
  const label = t(FEED_LABELS[item.kind] as 'feedNote');
  const voided = item.meta.voided === true;
  // An activity is not always a note: the lead form records calls, meetings
  // and messages too, and each kept its icon on the old panel. The label
  // stays one word; the mark says which kind it was.
  const ACTIVITY_MARK: Record<string, string> = { call: '📞', meeting: '🤝', message: '💬' };
  const mark =
    item.kind === 'note' ? (ACTIVITY_MARK[String(item.meta.kind)] ?? MARK.note) : MARK[item.kind];
  // The reader's OWN notes sit on the right, like any messenger (round 100,
  // owner's 1A). Only the note kind aligns — cargo and money are the record,
  // not a conversation — and a machine's note (authorId NULL) is nobody's, so
  // it stays left. The own case REPLACES the tone rather than decorating it:
  // two background utilities on one element are resolved by stylesheet order,
  // not className order, and `bg-warn/10` compiles later than `bg-brand-50` —
  // an appended brand tint would be dead CSS (telegram-bubble's ternary is
  // the idiom).
  const own = item.kind === 'note' && item.meta.authorId === viewerId;

  return (
    <div
      className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${
        own ? 'ml-auto bg-brand-50' : TONE[item.kind]
      } ${voided ? 'opacity-60' : ''}`}
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
        <>
          <p className="font-semibold">
            {String(item.meta.number ?? '')} · {String(item.meta.warehouse ?? '')} ·{' '}
            {String(item.meta.boxes ?? 0)} {t('feedBoxes')}
          </p>
          {/* The goods, the kilos and the cubes (round 100, owner's 1A):
              «YW_IN-… 1 box» told him nothing about WHAT arrived. A second
              muted line, not a wider first — the number stays scannable. */}
          {typeof item.meta.goods === 'string' && item.meta.goods && (
            <p className="truncate text-xs text-ink-700">
              {item.meta.goods} · {Math.round(Number(item.meta.kg ?? 0))} kg ·{' '}
              {Math.round(Number(item.meta.m3 ?? 0) * 100) / 100} m³
            </p>
          )}
        </>
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
      {item.body && <p className="whitespace-pre-wrap break-words">{item.body}</p>}
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
    </div>
  );
}
