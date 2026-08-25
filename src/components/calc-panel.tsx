import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { lastCalcAnswerFor, openCalcFor } from '@/modules/wms/calc/service';
import { currentSealFor, offersFor } from '@/modules/wms/calc/workspace';
import { offerLocaleFor } from '@/modules/wms/calc/offer';
import { mayApproveBelowFloor, upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcSection } from '@/modules/wms/calc/intake';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { Panel } from './panel';
import { CalcSendForm } from './calc-send-form';
import { CalcOfferForm } from './calc-offer';

/**
 * «Hisoblatishga yuborish» on a lead or deal card, and what came back.
 *
 * Gates itself like every panel that can appear on any card (#299): the deal
 * card is open to the customs manager, so the permission travels with the
 * panel, not with the page.
 *
 * It also CATCHES: this panel renders inside two screens that already work,
 * and its columns landed in migration 0085 — on deploy morning, with the app
 * a release ahead of the database, an uncaught read here would take the deal
 * card down with it (#472-475).
 */
export async function CalcPanel({
  entityType,
  entityId,
  revalidate,
  clientName,
  clientLocale,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
  /** Printed at the top of the offer. The card already has it; asking again
      would be a query on every card that has no sealed price at all. */
  clientName?: string | null;
  clientLocale?: string | null;
}) {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) return null;
  if (entityType === 'lead' && !actor.permissions.has('crm.leads')) return null;

  // Law 4 splits this panel. The VED reads the sealed price — it is their own
  // work — and never what the customer was charged for it.
  const scope = upsaleScopeFor(actor);

  let open: Awaited<ReturnType<typeof openCalcFor>> = [];
  let last: Awaited<ReturnType<typeof lastCalcAnswerFor>> = null;
  let seal: Awaited<ReturnType<typeof currentSealFor>> = null;
  let offers: Awaited<ReturnType<typeof offersFor>> = [];
  try {
    [open, last, seal] = await Promise.all([
      openCalcFor(entityType, entityId),
      lastCalcAnswerFor(entityType, entityId),
      currentSealFor(entityType, entityId),
    ]);
    // Only a card that HAS a price can have been offered one, so the second
    // read is paid by the cards that use it and by nobody else.
    if (seal && scope !== 'none') offers = await offersFor(entityType, entityId);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, entityType, entityId }, '[calc] panel: server behind');
    return null;
  }

  const t = await getTranslations('calc');
  const format = await getFormatter();

  return (
    <Panel
      title={`🧮 ${t('panelTitle')}`}
      badge={open.length || undefined}
      testId="calc-panel"
      // A sealed price is what the seller opens this card to read, so it is
      // never behind a fold.
      open={open.length > 0 || Boolean(seal)}
    >
      {open.length > 0 ? (
        <ul className="space-y-1" data-testid="calc-open">
          {open.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              {/* The VED person reads the request from the card too — and the
                  seller, who may not, sees the same line without a door. */}
              {actor.permissions.has('ved.docs') ? (
                <Link
                  href={`/hisoblash/${row.id}`}
                  data-testid="calc-open-link"
                  className="font-semibold text-brand-700"
                >
                  #
                </Link>
              ) : null}
              {row.section ? (
                <span className="chip chip-brand">
                  {t(SECTION_LABELS[row.section as CalcSection] as 'sections.podklyuch')}
                </span>
              ) : null}
              <span className="text-ink-600">
                {row.assigneeId ? `${t('takenBy')}: ${row.assigneeName ?? '—'}` : t('unassigned')}
              </span>
              {row.late ? <span className="chip chip-warn">{t('late')}</span> : null}
              <span className="text-2xs text-ink-500">
                {t('dueBy')}: {format.dateTime(row.dueAt, { hour: '2-digit', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The sealed price — the one fact on this card that is not a draft.
          It is stated with its version, its clock and the discount that made
          it, because a number a customer was told needs to be re-findable
          exactly, and an expired one must not be quoted again as if it stood. */}
      {seal ? (
        <div className="space-y-2 border-t border-line pt-2" data-testid="calc-seal">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-lg font-bold tabular-nums" data-testid="calc-seal-total">
              ${seal.totalUsd.toFixed(2)}
            </span>
            <span className="chip chip-brand">v{seal.versionNo}</span>
            <span className="chip chip-brand">
              {t(SECTION_LABELS[seal.section] as 'sections.podklyuch')}
            </span>
            {seal.expired ? (
              <span className="chip chip-warn" data-testid="calc-seal-expired">
                {t('sealExpired')}
              </span>
            ) : (
              <span className="text-2xs text-ink-500">
                {t('validUntil')}: {format.dateTime(seal.validUntil, { dateStyle: 'short' })}
              </span>
            )}
          </div>
          <p className="text-2xs text-ink-500">
            {seal.sealedByName ?? '—'} ·{' '}
            {format.dateTime(seal.sealedAt, { dateStyle: 'short' })}
            {seal.discountUsd > 0 ? ` · ${t('discount')} $${seal.discountUsd.toFixed(2)}` : ''}
          </p>

          {/* An expired price is not a price. The seller gets the words and no
              box: re-quoting needs a new calculation, which is the same door a
              correction takes (there is no re-open, by design). */}
          {seal.expired ? (
            <p className="text-2xs text-warn">{t('sealExpiredHint')}</p>
          ) : scope === 'none' ? null : (
            <CalcOfferForm
              versionId={seal.id}
              sealedTotal={seal.totalUsd}
              defaultLocale={offerLocaleFor(clientLocale)}
              clientName={clientName ?? null}
              entityType={entityType}
              entityId={entityId}
              mayApprove={mayApproveBelowFloor(actor)}
              revalidate={revalidate}
            />
          )}

          {offers.length > 0 ? (
            <ul className="space-y-0.5 text-2xs text-ink-600" data-testid="calc-offers">
              {offers
                // A seller reprints their own promise, never a colleague's.
                .filter((o) => scope === 'all' || o.offeredBy === actor.id)
                .map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-1">
                  <span className="font-mono tabular-nums">${Number(o.clientPriceUsd).toFixed(2)}</span>
                  <span className="uppercase">{o.locale}</span>
                  <span>{format.dateTime(o.offeredAt, { dateStyle: 'short' })}</span>
                  {o.belowFloor ? <span className="chip chip-warn">{t('belowFloorChip')}</span> : null}
                  {o.belowFloor && !o.approvedAt ? (
                    <span className="chip chip-warn" data-testid="calc-offer-pending">
                      {t('offerPending')}
                    </span>
                  ) : null}
                  {/* The sheet outlives the press: after a refresh the form's
                      own link is gone, and this is the only way back to it. */}
                  {/* A pending promise has no sheet: the customer has not been
                      told this price and must not be handed a document saying
                      they have. */}
                  {o.belowFloor && !o.approvedAt ? null : (
                  <a
                    className="text-brand-700"
                    href={`/api/calc/${o.versionId}/offer.pdf?til=${o.locale}`}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="calc-offer-pdf"
                  >
                    PDF
                  </a>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {last ? (
        <p className="border-t border-line pt-2 text-sm" data-testid="calc-last-answer">
          <span className="text-ink-500">{t('answered')}:</span>{' '}
          <span className="num font-semibold">
            {last.amount ?? '—'} {last.currency ?? ''}
          </span>{' '}
          <span className="text-2xs text-ink-500">
            {format.dateTime(last.at, { dateStyle: 'short' })}
          </span>
          {last.note ? <span className="block text-xs text-ink-600">{last.note}</span> : null}
        </p>
      ) : null}

      {/* The phone path is the BOT: the seller's material lives in Telegram,
          and a browser form cannot reach it — forwarding three photos to the
          bot is six taps, saving them out and re-uploading them is thirty.
          The form below is for the desk, so on a phone this panel is a status
          banner with a door to the bot instead. */}
      <div className="border-t border-line pt-2">
        <p className="text-2xs text-ink-500 sm:hidden">{t('sendOnPhone')}</p>
        <div className="hidden sm:block">
          <CalcSendForm entityType={entityType} entityId={entityId} revalidate={revalidate} />
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {/* The history is open to the SELLER too — «what did we charge for
            this last time» is asked far more often at the moment of quoting
            than at the moment of calculating (law 10). */}
        <Link href="/hisoblash/narxlar" className="text-2xs text-brand-700" data-testid="calc-panel-history">
          {t('historyTitle')} →
        </Link>
        {actor.permissions.has('ved.docs') ? (
          <Link href="/hisoblash" className="text-2xs text-brand-700">
            {t('queueTitle')} →
          </Link>
        ) : null}
      </div>
    </Panel>
  );
}
