import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientFeed, type FeedItem, type FeedKind } from '@/modules/wms/crm/feed';
import { TelegramReply } from './telegram-reply';
import { FeedNoteBox } from './client-feed-note';

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
  cargo: '📦',
  charge: '🧾',
  payment: '💵',
};

const TONE: Record<FeedKind, string> = {
  tg_in: 'bg-surface-sunken',
  tg_out: 'ml-auto bg-brand-50',
  tg_pending: 'ml-auto border border-dashed border-line-strong text-ink-500',
  note: 'bg-warn/10',
  cargo: 'bg-good/10',
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
  limit = 60,
  /** On a card the box is short; on a dedicated screen it fills the height. */
  tall = false,
}: {
  clientId: string | null;
  limit?: number;
  tall?: boolean;
}) {
  if (!clientId) return null;
  const actor = await getActor();
  if (!actor?.permissions.has('crm.leads') && !actor?.permissions.has('clients.manage')) {
    return null;
  }

  const t = await getTranslations('crm');
  const items = await clientFeed(clientId, { limit });

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
        <TelegramReply clientId={clientId} compact />
        <FeedNoteBox
          clientId={clientId}
          labels={{
            placeholder: t('feedNotePlaceholder'),
            save: t('feedNoteSave'),
            saving: t('feedNoteSaving'),
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

  return (
    <div
      className={`max-w-[90%] rounded-xl px-3 py-2 text-sm ${TONE[item.kind]} ${
        voided ? 'opacity-60' : ''
      }`}
      data-testid={`feed-${item.kind}`}
    >
      <div className="mb-0.5 flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-ink-500">
        <span className="font-semibold">
          {MARK[item.kind]} {label}
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
      {(item.kind === 'charge' || item.kind === 'payment') && (
        <p className="font-semibold">{money(item.meta)}</p>
      )}
      {item.body ? (
        <p className="whitespace-pre-wrap break-words">{item.body}</p>
      ) : item.meta.hasMedia === true ? (
        <p className="text-ink-500">📎 {t('telegramMedia')}</p>
      ) : null}
      {item.kind === 'tg_pending' && item.meta.error ? (
        <p className="mt-1 text-xs text-bad">{String(item.meta.error)}</p>
      ) : null}
    </div>
  );
}
