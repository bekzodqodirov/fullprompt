import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { lastCalcAnswerFor, openCalcFor } from '@/modules/wms/calc/service';
import {
  offerPricesFor,
  offersFor,
  standingAnchorsFor,
  type OfferPrice,
  type SealedVersion,
} from '@/modules/wms/calc/workspace';
import { chainVersionsFor, type ChainVersion } from '@/modules/wms/calc/chain';
import { mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import { mayOpenCalcCard } from '@/modules/wms/calc/card-door';
import { ChainStateChip } from './calc-chain-chip';
import { offerLocaleFor } from '@/modules/wms/calc/offer';
import {
  mayApproveBelowFloor,
  offerSightFor,
  upsaleScopeFor,
} from '@/modules/wms/calc/upsale-scope';
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
 * panel, not with the page. On a LEAD it opens for the funnel's people
 * (`crm.leads`) and, since the owner's 14a, for the VED through the calc
 * card door (`mayOpenCalcCard`, the karta) — READ-ONLY for him: no «yuborish»
 * form and no offer form, which are the seller's (review access-money-2).
 *
 * WHAT IT DRAWS is what STANDS (review ved-correctness-4/-6): one door per
 * standing anchor — every current, not-superseded seal and every standing
 * Готово answer — each labelled with its section, from the ONE list
 * `quoteLockedFor` also reads. A seal a correction replaced is printed as
 * history under its chain chip, with no door.
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
  forceOpen = false,
  readOnly = false,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
  /** Printed at the top of the offer. The card already has it; asking again
      would be a query on every card that has no sealed price at all. */
  clientName?: string | null;
  clientLocale?: string | null;
  /** «+ Yangi → Hisoblatish» lands here with the form in view (`?yangi=hisob`). */
  forceOpen?: boolean;
  /** The VED's karta: reads only — no send form, no offer form (14a). */
  readOnly?: boolean;
}) {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) return null;
  const sellerOnLead = actor.permissions.has('crm.leads');
  if (entityType === 'lead' && !sellerOnLead) {
    // The VED's door onto a seller's lead — only a card carrying a request.
    if (!(await mayOpenCalcCard(actor, { entityType, entityId }))) return null;
  }
  // The send form and the offer form are the seller's hands: on a lead they
  // need `crm.leads`, and the karta never draws them. The deal card's own
  // writes are untouched this round (his question 17 is open).
  const writes = !readOnly && (entityType === 'deal' || sellerOnLead);

  // Law 4 splits this panel; 16a adds the seller's price as a sight of its
  // own — two facts, never one ranked value (review access-money-15).
  const scope = upsaleScopeFor(actor);
  const sight = offerSightFor(actor);

  let open: Awaited<ReturnType<typeof openCalcFor>> = [];
  let last: Awaited<ReturnType<typeof lastCalcAnswerFor>> = null;
  let anchors: Awaited<ReturnType<typeof standingAnchorsFor>> = { seals: [], answers: [], deadSeal: null };
  let offers: Awaited<ReturnType<typeof offersFor>> = [];
  let prices: OfferPrice[] = [];
  let chains = new Map<string, ChainVersion[]>();
  try {
    [open, last, anchors] = await Promise.all([
      openCalcFor(entityType, entityId),
      lastCalcAnswerFor(entityType, entityId),
      standingAnchorsFor(entityType, entityId),
    ]);
    const priced = anchors.seals.length > 0 || anchors.answers.length > 0 || anchors.deadSeal !== null || last !== null;
    // Only a card that HAS a price can have been offered one, so the second
    // read is paid by the cards that use it and by nobody else. The seller's
    // own list keeps its PDF links; a 16a reader gets the projection, which
    // cannot carry a payout or the below-floor reason (access-money-8).
    if (priced && sight.mayOffer) offers = await offersFor(entityType, entityId);
    else if (priced && sight.seesOfferPrices) prices = await offerPricesFor(entityType, entityId);
    // Every printed seal's chain, in ONE query (#432): what «V2» counts.
    const sealIds = [...anchors.seals, ...(anchors.deadSeal ? [anchors.deadSeal] : [])].map((s) => s.requestId);
    if (sealIds.length > 0) chains = await chainVersionsFor(sealIds);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, entityType, entityId }, '[calc] panel: server behind');
    return null;
  }

  const t = await getTranslations('calc');
  const format = await getFormatter();
  const readsHistory = mayReadCalcRegistry(actor);
  const vedDoor = actor.permissions.has('ved.docs');
  const hasPrice = anchors.seals.length > 0 || anchors.answers.length > 0;

  // «V2» is the seal's rank in its correction chain, DERIVED (chain.ts): the
  // stored `version_no` counts seals of one request and a correction is a
  // new request, so it read «v1» on every correction ever made. The previous
  // link is named beside it, as a version and a date for everybody who reads
  // the card, and as MONEY only for the registry's audience (2A).
  const sealBlock = (seal: SealedVersion, standing: boolean) => {
    const chain = chains.get(seal.requestId) ?? [];
    const mine = chain.find((v) => v.versionId === seal.id);
    const quoteNo = mine?.quoteNo ?? seal.versionNo;
    const previous = chain
      .filter((v) => v.versionId !== seal.id && v.sealedAt.getTime() < seal.sealedAt.getTime())
      .at(-1);
    return (
      <div
        key={seal.id}
        className="space-y-2 border-t border-line pt-2"
        data-testid={standing ? 'calc-seal' : 'calc-seal-dead'}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`font-mono tabular-nums ${standing ? 'text-lg font-bold' : 'text-sm text-ink-500 line-through'}`}
            data-testid={standing ? 'calc-seal-total' : undefined}
          >
            ${seal.totalUsd.toFixed(2)}
          </span>
          <span className="chip chip-brand" data-testid={standing ? 'calc-seal-version' : undefined}>
            V{quoteNo}
          </span>
          {mine ? <ChainStateChip version={mine} alone={chain.length < 2 && standing} /> : null}
          <span className="chip chip-brand">{t(SECTION_LABELS[seal.section] as 'sections.podklyuch')}</span>
          {!standing ? null : seal.expired ? (
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
          {seal.sealedByName ?? '—'} · {format.dateTime(seal.sealedAt, { dateStyle: 'short' })}
          {seal.discountUsd > 0 ? ` · ${t('discount')} $${seal.discountUsd.toFixed(2)}` : ''}
        </p>
        {standing && previous ? (
          <p className="text-2xs text-ink-500" data-testid="calc-seal-prev">
            {t('chainPrev')}: V{previous.quoteNo}
            {readsHistory ? ` · $${previous.totalUsd.toFixed(2)}` : ''}
            {' · '}
            {format.dateTime(previous.sealedAt, { dateStyle: 'short' })}
            {vedDoor ? (
              <>
                {' '}
                <Link href={`/hisoblash/${previous.requestId}`} className="font-semibold text-brand-700">
                  #
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        {/* An expired price is not a price. The seller gets the words and no
            box: re-quoting needs a new calculation, which is the same door a
            correction takes (there is no re-open, by design). */}
        {!standing ? null : seal.expired ? (
          <p className="text-2xs text-warn">{t('sealExpiredHint')}</p>
        ) : !writes || scope === 'none' ? null : (
          <CalcOfferForm
            anchor={{ versionId: seal.id }}
            floorUsd={seal.totalUsd}
            discountUsd={seal.discountUsd}
            defaultLocale={offerLocaleFor(clientLocale)}
            clientName={clientName ?? null}
            entityType={entityType}
            entityId={entityId}
            mayApprove={mayApproveBelowFloor(actor)}
            revalidate={revalidate}
          />
        )}
      </div>
    );
  };

  return (
    <Panel
      title={`🧮 ${t('panelTitle')}`}
      badge={open.length || undefined}
      testId="calc-panel"
      id="hisoblatish"
      // A price on the card is what the seller opens it to read, so it is
      // never behind a fold — the Готово answer's door included (phase 4).
      open={forceOpen || open.length > 0 || hasPrice || Boolean(last)}
    >
      {open.length > 0 ? (
        <ul className="space-y-1" data-testid="calc-open">
          {open.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              {/* The VED person reads the request from the card too — and the
                  seller, who may not, sees the same line without a door. */}
              {vedDoor ? (
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

      {/* Every STANDING seal — the one fact on this card that is not a draft —
          stated with its version, its clock and the discount that made it,
          because a number a customer was told needs to be re-findable
          exactly, and an expired one must not be quoted again as if it
          stood. */}
      {anchors.seals.map((seal) => sealBlock(seal, true))}
      {/* The newest seal when a correction replaced it: history, no door. */}
      {anchors.deadSeal ? sealBlock(anchors.deadSeal, false) : null}

      {/* The newest Готово answer: who gave it, what, when — and, when a
          correction was opened off it, the chain's own words, because the
          seller's push already said «eski narx endi amal qilmaydi». */}
      {last ? (
        <div className="border-t border-line pt-2 text-sm" data-testid="calc-last-answer">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-ink-500">{t('answered')}:</span>
            <span className="num font-semibold" data-testid="calc-last-answer-amount">
              {last.amount} {last.currency ?? ''}
            </span>
            <span className="text-2xs text-ink-500" data-testid="calc-last-answer-by">
              {last.byName ?? '—'} · {format.dateTime(last.at, { dateStyle: 'short' })}
            </span>
            {last.childState ? (
              <ChainStateChip
                version={{
                  superseded: true,
                  supersededByNo: null,
                  recalcOpen: last.childState === 'open',
                  childState: last.childState,
                }}
              />
            ) : null}
            {vedDoor ? (
              <Link
                href={`/hisoblash/${last.requestId}`}
                className="font-semibold text-brand-700"
                data-testid="calc-last-answer-link"
              >
                #
              </Link>
            ) : null}
          </p>
          {last.note ? <span className="block text-xs text-ink-600">{last.note}</span> : null}
          {writes && scope !== 'none' && last.currency !== 'USD' && !last.childState ? (
            <p className="text-2xs text-ink-500" data-testid="calc-answer-not-usd">
              {t('answerNotUsd')}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Phase 4, the owner's item 5: a STANDING Готово answer opens the same
          offer door a seal does — while the dictionaries are empty it is the
          only price production has. One door per standing answer
          (`answerFloorStandsSql`), and every admission is re-derived in
          `recordOffer`. */}
      {writes && scope !== 'none'
        ? anchors.answers.map((answer) => (
            <div key={answer.requestId} className="space-y-2" data-testid="calc-answer-door">
              {answer.section ? (
                <span className="chip chip-brand">
                  {t(SECTION_LABELS[answer.section as CalcSection] as 'sections.podklyuch')}
                </span>
              ) : null}
              {answer.expired ? (
                <p className="text-2xs text-warn" data-testid="calc-answer-expired">
                  {t('answerExpiredHint')}
                </p>
              ) : (
                <CalcOfferForm
                  anchor={{ requestId: answer.requestId }}
                  floorUsd={answer.amountUsd}
                  discountUsd={0}
                  defaultLocale={offerLocaleFor(clientLocale)}
                  clientName={clientName ?? null}
                  entityType={entityType}
                  entityId={entityId}
                  mayApprove={mayApproveBelowFloor(actor)}
                  revalidate={revalidate}
                />
              )}
            </div>
          ))
        : null}

      {/* Every recorded offer on this card, whichever anchor made it — one
          list, one home, after both doors. */}
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
                    own link is gone, and this is the only way back to it. A
                    pending promise has no sheet: the customer has not been
                    told this price and must not be handed a document saying
                    they have. */}
                {o.belowFloor && !o.approvedAt ? null : (
                  <a
                    className="text-brand-700"
                    href={`/api/calc/offer/${o.id}/pdf?til=${o.locale}`}
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

      {/* 16a — «Sotuvchi mijozga aytgan narx»: the price, its date and the
          seller, from the projection. No PDF link (its door is law 4's), no
          below-floor reason, no upsale figure, no payout. */}
      {prices.length > 0 ? <OfferPriceList prices={prices} /> : null}

      {/* The phone path is the BOT: the seller's material lives in Telegram,
          and a browser form cannot reach it — forwarding three photos to the
          bot is six taps, saving them out and re-uploading them is thirty.
          The form below is for the desk, so on a phone this panel is a status
          banner with a door to the bot instead. */}
      {writes ? (
        <div className="border-t border-line pt-2">
          <p className="text-2xs text-ink-500 sm:hidden">{t('sendOnPhone')}</p>
          <div className="hidden sm:block">
            <CalcSendForm entityType={entityType} entityId={entityId} revalidate={revalidate} />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {/* The history is open to the SELLER too — «what did we charge for
            this last time» is asked far more often at the moment of quoting
            than at the moment of calculating (law 10). */}
        <Link href="/hisoblash/narxlar" className="text-2xs text-brand-700" data-testid="calc-panel-history">
          {t('historyTitle')} →
        </Link>
        {vedDoor ? (
          <Link href="/hisoblash" className="text-2xs text-brand-700">
            {t('queueTitle')} →
          </Link>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * The 16a list — shared by the card panel and `/hisoblash/[id]`, so both
 * print the seller's price the same way from the same projection.
 */
export async function OfferPriceList({ prices }: { prices: OfferPrice[] }) {
  const t = await getTranslations('calc');
  const format = await getFormatter();
  return (
    <div className="border-t border-line pt-2" data-testid="calc-offer-prices">
      <p className="text-2xs font-semibold text-ink-600">{t('sellerPriceTitle')}</p>
      <ul className="mt-1 space-y-0.5 text-2xs text-ink-600">
        {prices.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-1" data-testid="calc-offer-price">
            <span className="font-mono font-semibold tabular-nums">${p.clientPriceUsd.toFixed(2)}</span>
            <span>{format.dateTime(p.offeredAt, { dateStyle: 'short' })}</span>
            <span>{p.offeredByName ?? '—'}</span>
            {p.pendingApproval ? (
              <span className="chip chip-warn" data-testid="calc-offer-price-pending">
                {t('offerPending')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
