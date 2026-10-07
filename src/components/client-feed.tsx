import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientFeed, type FeedItem, type FeedKind } from '@/modules/wms/crm/feed';
import { mentionablePeople } from '@/modules/wms/crm/internal-chat';
import { lentaAdmission } from '@/modules/wms/crm/thread-door';
import { threadHrefsFor } from '@/modules/wms/crm/thread';
import { OFFICE_TZ } from '@/modules/platform/time/tashkent';
import Link from 'next/link';
import { FeedNoteBox } from './client-feed-note';
import { feedNoteTarget } from './feed-note-target';
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
  refund: '↩️',
  compensation: '🤝',
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
  refund: 'bg-warn/10',
  compensation: 'bg-good/10',
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
  refund: 'feedRefund',
  compensation: 'feedCompensation',
};

function money(meta: Record<string, unknown>): string {
  const amount = Number(meta.amount ?? 0);
  const currency = String(meta.currency ?? '');
  return `${amount.toLocaleString('ru-RU')} ${currency}`;
}

export async function ClientFeed({
  clientId,
  // Bound under another name: `money()` above is this file's amount formatter.
  money: showMoney,
  leadId = null,
  dealId = null,
  noteOn = null,
  limit = 60,
  /** On a card the box is short; on a dedicated screen it fills the height. */
  tall = false,
}: {
  clientId: string | null;
  /**
   * May this reader see this client's money rows? REQUIRED, never defaulted —
   * every card passes the ledger's own door for the card's client,
   * `mayOpenClientLedger(actor, client)`, and false where no client resolves.
   * The panel's own gate below decides who reads the lenta at all; this
   * decides whose MONEY is in it, which the lenta never asked until the
   * client's ledger became the card's «Pul» tab (docs/CARD-TABS.md).
   */
  money: boolean;
  /** Set on a lead card: the lenta then lives even before there is a client. */
  leadId?: string | null;
  /** Set on a deal card: notes written here belong to THIS job, and the deal's
      own chat shows alongside the client's history. */
  dealId?: string | null;
  /**
   * Where a note written in this box lands, whatever the reader's grants —
   * the karta passes its lead (review access-4). The karta is the CALC card:
   * a both-hats reader reaches it because the CRM card bounces him, and the
   * CRM default («the client, then the lead») would post his note on the
   * client's whole thread from a screen that is about this one job.
   */
  noteOn?: { entityType: 'lead' | 'deal'; entityId: string } | null;
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
  if (!actor) return null;
  // The VED on a calc card (docs/VED-TARIX.md §10, 15a): «ved hodimi
  // hsoblashdan kartaga otib aniqlashtirib oladi» — he reads the lenta of a
  // lead or deal that carries a calculation. The gate is the THREAD door's
  // own (thread-door.ts `lentaAdmission`): the lenta and the thread written on
  // it ask one sentence, so the two cannot drift apart (#513).
  const calcCard = dealId
    ? { entityType: 'deal' as const, entityId: dealId }
    : leadId
      ? { entityType: 'lead' as const, entityId: leadId }
      : null;
  const admitted = await lentaAdmission(actor, calcCard);
  if (!admitted) return null;
  const { viaCalc } = admitted;

  const t = await getTranslations('crm');
  const tth = await getTranslations('threads');
  const threadMarks = { calc: tth('feedCalcThread'), telegram: tth('feedViaTelegram') };
  const items = await clientFeed(clientId, { money: showMoney, limit, leadId, dealId });
  // A note that is a calculation's question or answer carries «🧮 Hisob savoli
  // · ↩️ javob» — a link to WHERE that calculation's Q&A lives now (the ONE
  // href rule, `threadHrefsFor`): a won lead keeps its tagged notes while the
  // request and its fold moved to the deal, so a local anchor would be dead.
  // One batch for the distinct calculations on screen. A read that fails
  // draws the chip as text — the lenta never falls over a chip.
  const calcIds = [
    ...new Set(
      items
        .map((item) => (item.kind === 'note' && typeof item.meta.calcRequestId === 'string' ? item.meta.calcRequestId : null))
        .filter((id): id is string => id !== null),
    ),
  ];
  const calcHrefs = calcIds.length
    ? await threadHrefsFor(
        actor,
        calcIds.map((id) => ({ kind: 'calc' as const, id })),
      ).catch(() => new Map<string, string | null>())
    : new Map<string, string | null>();

  return (
    <section id="ichki" className="card scroll-mt-20 space-y-2" data-testid="client-feed">
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
            <FeedRow
              key={item.id}
              item={item}
              t={t}
              viewerId={actor.id}
              marks={threadMarks}
              calcHref={
                typeof item.meta.calcRequestId === 'string'
                  ? (calcHrefs.get(`calc:${item.meta.calcRequestId.toLowerCase()}`) ?? null)
                  : null
              }
            />
          ))}
        </div>
      )}

      {/* The lenta's composer is the INTERNAL note — a word to colleagues.
          The word to the CLIENT lives in the chat panel beside this one,
          because the two are different acts with different audiences
          (owner, round 21: «lenta va chatlar alohida tursin»). */}
      <div className="space-y-2 border-t border-line pt-2">
        <FeedNoteBox
          // `feedNoteTarget` says where, and why.
          {...feedNoteTarget({ viaCalc, calcCard, noteOn, dealId, clientId, leadId })}
          // Text only for the VED in v1 (§10): the upload route is not
          // widened, and the action refuses a pre-bound file id from him.
          files={!viaCalc}
          // The lead or deal this box sits on — the action's hint asks
          // whether an open calculation here has a question waiting.
          hintOn={calcCard ? `${calcCard.entityType}:${calcCard.entityId}` : null}
          hintText={tth('feedCalcHint')}
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
  calcHref,
  marks,
}: {
  item: FeedItem;
  t: Awaited<ReturnType<typeof getTranslations<'crm'>>>;
  viewerId: string;
  /** The two thread marks' words (the `threads` namespace). */
  marks: { calc: string; telegram: string };
  /** Where this note's calculation Q&A lives for this reader — null draws the chip as text. */
  calcHref: string | null;
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
          {/* A staff thread's marks (0127): the calculation this note is
              about, and «it came from Telegram». */}
          {item.kind === 'note' && typeof item.meta.calcRequestId === 'string' ? (
            calcHref ? (
              <Link href={calcHref} className="ml-1.5 font-semibold text-brand-700" data-testid="feed-calc-thread">
                {marks.calc}
              </Link>
            ) : (
              <span className="ml-1.5" data-testid="feed-calc-thread">
                {marks.calc}
              </span>
            )
          ) : null}
          {item.kind === 'note' && item.meta.viaTelegram === true ? (
            <span className="ml-1.5" data-testid="feed-via-telegram">
              {marks.telegram}
            </span>
          ) : null}
        </span>
        <span className="whitespace-nowrap">
          {/* The office's clock, never the server's (a container runs in UTC):
              the same message sits in the calc fold beside this lenta, printed
              by next-intl in Asia/Tashkent, and the two read 5 hours apart. */}
          {item.at.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: OFFICE_TZ })}
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
          {/* The cargo went out while the client owed — a tick, an approval or
              a deal «muddat» (the register's rule, debt/releases.ts). Only a
              reader of this client's money is sent the flag at all. */}
          {item.meta.debtOverride === true && ` · ⚠ ${t('feedDebtOverride')}`}
        </p>
      )}
      {/* WHY it went out on debt (0126) — sent only to a reader of this
          client's money, like the mark above. Wraps and breaks like the body
          line below: a pasted unbroken token must not widen the card (#400). */}
      {item.kind === 'handover' && typeof item.meta.debtNote === 'string' && item.meta.debtNote.trim() !== '' && (
        <p className="whitespace-pre-wrap break-words text-xs" data-testid="feed-debt-note">
          💬 {item.meta.debtNote}
        </p>
      )}
      {(item.kind === 'charge' || item.kind === 'payment' || item.kind === 'refund' || item.kind === 'compensation') && (
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
