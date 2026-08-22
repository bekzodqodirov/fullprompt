import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader, Section } from '@/components/ui/page';
import { Panel } from '@/components/panel';
import { CardCols } from '@/components/card-cols';
import { HistoryTab } from '@/components/history-tab';
import { CustomFieldsPanel } from '@/components/custom-fields-panel';
import { TasksPanel } from '@/components/tasks-panel';
import { CalcPanel } from '@/components/calc-panel';
import { ClientFeed } from '@/components/client-feed';
import { TelegramThread } from '@/components/telegram-thread';
import { TelegramLookback } from '@/components/telegram-lookback';
import { CallsPanel } from '@/components/calls-panel';
import { stageClass } from '../../crm/stage-color';
import {
  canWriteDeal,
  dealById,
  dealDeviation,
  dealProfit,
  deviationThreshold,
  listStages,
  unlinkedReceipts,
} from '@/modules/wms/deals/service';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { formStages } from '@/modules/wms/crm/stage-law';
import { DealForm } from '../deal-form';
import { DealFacts } from './facts';
import { LinesForm } from '../lines-form';
import { ImportLines } from '../import-lines';
import { LinkReceipt } from '../link-receipt';
import { DeferForm } from '../defer-form';
import { DiscountForm } from '../discount-form';

/**
 * The deal card: the quote and the reality, side by side.
 *
 * That layout IS the feature. Everything else on this screen — lines,
 * receipts, tasks — exists to explain the two columns at the top, because the
 * business problem is not "we have no record of the job", it is that nobody
 * sees the gap between what the client was told and what turned up until the
 * client is standing in Tashkent arguing about it.
 */
export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `hodim` = whose Telegram conversation to read in the panel (2026-08-07). */
  searchParams: Promise<{ hodim?: string; chodim?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!canWriteDeal(actor.permissions)) redirect('/');

  const { id } = await params;
  const { hodim, chodim } = await searchParams;
  const row = await dealById(id);

  if (!row) notFound();
  // The thread's filter and the calls' filter live on the same URL; a link
  // that changes one must carry the other (#514 — a literal string drops it).
  const cardHref = (patch: { hodim?: string | null; chodim?: string | null }) => {
    const q = new URLSearchParams();
    const h = 'hodim' in patch ? patch.hodim : hodim;
    const c = 'chodim' in patch ? patch.chodim : chodim;
    if (h) q.set('hodim', h);
    if (c) q.set('chodim', c);
    const qs = q.toString();
    return `/bitimlar/${row.deal.id}${qs ? `?${qs}` : ''}`;
  };

  const t = await getTranslations('deals');
  const tc = await getTranslations('common');
  const [{ reality, deviation }, stages, managers, threshold, unlinked] = await Promise.all([
    dealDeviation(id),
    listStages(),
    salesManagerOptions(row.deal.ownerId),
    deviationThreshold(),
    unlinkedReceipts(row.deal.clientId),
  ]);

  const quotedAmount = row.deal.quotedAmount === null ? null : Number(row.deal.quotedAmount);
  const discount = Number(row.deal.discountAmount);
  const deferred = Boolean(row.deal.deferredAt) && !row.deal.deferralEndedAt;
  // Profit is tannarx territory: same gate as the accounting reports.
  const profit = actor.permissions.has('finance.reports') ? await dealProfit(id) : null;

  // Three states, and the wording has to be honest about which one it is:
  // nothing arrived yet, nothing to compare against, or a real gap.
  const verdict =
    reality.receiptCount === 0
      ? { text: t('noCargoYet'), tone: 'text-ink-500' }
      : deviation.incomparable
        ? { text: t('notQuoted'), tone: 'text-warn' }
        : !deviation.exceeds
          ? { text: t('withinQuote'), tone: 'text-good' }
          : deviation.worstPct! > 0
            ? { text: t('overQuote'), tone: 'text-bad' }
            : { text: t('underQuote'), tone: 'text-bad' };

  return (
    <div className="space-y-4">
      {/* The dock reads this: opening it on THIS card lands in THIS client's
          conversation, not a list to search (owner: "chat butun sistemadan
          kirsa bo'ladigan joyda"). */}
      <span data-dock-client={row.deal.clientId} hidden />
      <PageHeader
        icon="handshake"
        back={{ href: '/bitimlar', label: t('title') }}
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="num text-ink-500">{row.deal.code}</span>
            <span>{row.deal.title || row.clientName}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/clients/${row.deal.clientId}`}
              className="num font-bold text-good hover:underline"
            >
              {row.clientCode}
            </Link>
            <span className={`rounded-lg border px-2 py-0.5 text-xs font-bold ${stageClass(row.stageColor)}`}>
              {row.stageName}
            </span>
            {row.ownerName && <span className="text-sm text-ink-500">{row.ownerName}</span>}
          </span>
        }
      />

      <CardCols
        main={
          /* The working surface: what was said and what happened, full height
             (owner: the amoCRM shape — the card IS its timeline). Gates
             itself: this card is open to the VED manager too, and a client's
             conversation is not his to read. */
          <>
            <ClientFeed clientId={row.deal.clientId} dealId={row.deal.id} limit={60} tall />
            {/* The chat stands BESIDE the lenta, never inside it (round 21). */}
            <TelegramThread
              clientId={row.deal.clientId}
              hodim={hodim}
              hrefFor={(who) => cardHref({ hodim: who })}
            />
            <CallsPanel
              clientId={row.deal.clientId}
              hodim={chodim}
              hrefFor={(who) => cardHref({ chodim: who })}
            />
          </>
        }
        rail={
          <>
      {/* The title was only in the heading and the note was nowhere — both
          meant unfolding the ✏️ form to READ them. */}
      <DealFacts title={row.deal.title ?? ''} note={row.deal.note ?? ''} />

      {/* Round 82: «somebody here already has a chat with this number». About
          the deal's CLIENT — a deal has no phone of its own — so attaching
          lands on the client, which is where the conversation belongs. */}
      <TelegramLookback
        phone={(row.clientPhones as string[] | null)?.[0]}
        clientId={row.deal.clientId}
      />

      {/* ---- the two columns the whole feature exists for ---- */}
      <section className="card space-y-3" data-testid="deal-compare">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="section-title">{t('quote')}</p>
            <dl className="mt-1 space-y-0.5 text-sm">
              <Row label={t('volume')} value={row.deal.quotedVolumeM3} />
              <Row label={t('weight')} value={row.deal.quotedWeightKg} />
              <Row
                label={t('amount')}
                value={
                  quotedAmount === null ? null : `${quotedAmount} ${row.deal.quotedCurrency ?? ''}`
                }
                strong
              />
            </dl>
          </div>
          <div>
            <p className="section-title">{t('actual')}</p>
            <dl className="mt-1 space-y-0.5 text-sm">
              <Row label={t('volume')} value={reality.volumeM3 || null} />
              <Row label={t('weight')} value={reality.weightKg || null} />
              <Row
                label={t('boxes')}
                value={
                  reality.boxCount
                    ? `${reality.boxCount} (${reality.arrivedBoxes} ${t('arrived')}, ${reality.pendingBoxes} ${t('pending')})`
                    : null
                }
              />
            </dl>
          </div>
        </div>

        <div className={`border-t border-line pt-2 text-sm font-bold ${verdict.tone}`}>
          {verdict.text}
          {deviation.worstPct !== null && reality.receiptCount > 0 && (
            <span className="num ml-2">
              {deviation.worstPct > 0 ? '+' : ''}
              {deviation.worstPct.toFixed(1)} %
            </span>
          )}
          <span className="ml-2 text-xs font-normal text-ink-500">
            ({t('threshold')}: {threshold} %)
          </span>
        </div>

        {/* The re-priced figure is deliberately NOT shown. It was labelled a
            suggestion and it never wrote anything, but it sat beside the charge
            box holding the same number — which is how it came to be read as the
            system's own answer. The warning above says the cargo does not match
            the quote and by how much; the price stays the one that was agreed
            until a person changes it. */}

        {discount > 0 && (
          <p className="text-sm">
            <span className="font-bold text-warn">
              {t('discount')}: −{discount} {row.deal.quotedCurrency ?? ''}
            </span>
            {row.deal.discountReason && (
              <span className="text-ink-700"> — {row.deal.discountReason}</span>
            )}
          </p>
        )}

        {deferred && (
          <p className="rounded-xl border border-warn/30 bg-warn/10 p-2 text-sm font-semibold text-warn">
            ⏳ {t('deferred')} — {row.deal.deferralReason}
            {row.deal.deferUntilAllArrived
              ? ` (${t('deferUntilAll')}: ${reality.pendingBoxes})`
              : row.deal.deferUntilDate
                ? ` (${row.deal.deferUntilDate})`
                : ''}
          </p>
        )}
      </section>

      <Panel title={`✏️ ${tc('edit')}`} testId="deal-edit-panel">
        <DealForm
          dealId={row.deal.id}
          stages={formStages(stages, row.deal.stageId)}
          managers={managers}
          initial={{
            clientId: row.deal.clientId,
            stageId: row.deal.stageId,
            ownerId: row.deal.ownerId,
            title: row.deal.title,
            quotedVolumeM3: row.deal.quotedVolumeM3,
            quotedWeightKg: row.deal.quotedWeightKg,
            quotedAmount: row.deal.quotedAmount,
            quotedCurrency: row.deal.quotedCurrency,
            note: row.deal.note,
          }}
        />
      </Panel>

      <Panel
        title={`📋 ${t('lines')}`}
        badge={row.lines.length || undefined}
        testId="deal-lines-panel"
      >
        <ImportLines dealId={row.deal.id} existingCount={row.lines.length} />
        {/* Keyed by content: an import replaces the lines server-side, and the
            form's local row state must follow rather than show the old set. */}
        <LinesForm
          key={row.lines.map((l) => l.id).join(',')}
          dealId={row.deal.id}
          lines={row.lines}
        />
      </Panel>

      {/* The «Hisoblash» panel stood here from round 28 and is gone at the
          owner's word — «ikkala voronkada ham kerak emas». A calculation is
          asked for in the bot now (round 37), not by a button on a card. */}

      <Panel
        title={`🏷 ${t('discountTitle')}`}
        badge={discount > 0 ? `−${discount}` : undefined}
        testId="deal-discount-panel"
      >
        {quotedAmount !== null && discount > 0 && (
          <p className="mb-2 text-sm">
            {t('discountNet')}:{' '}
            <span className="num font-bold">
              {Math.round((quotedAmount - discount) * 100) / 100} {row.deal.quotedCurrency ?? ''}
            </span>
          </p>
        )}
        <DiscountForm
          dealId={row.deal.id}
          amount={row.deal.discountAmount}
          reason={row.deal.discountReason}
        />
      </Panel>

      <Section title={t('receipts')}>
        {row.receipts.length === 0 && (
          <p className="card text-center text-sm text-ink-500">{t('noReceipts')}</p>
        )}
        {row.receipts.map((receipt) => (
          <Link
            key={receipt.id}
            href={`/receipts/${receipt.id}`}
            className="card block !p-2.5 hover:bg-surface-sunken"
          >
            <span className="num font-semibold">{receipt.number}</span>
            <span className="ml-2 text-xs text-ink-500">
              {receipt.receivedAt.toISOString().slice(0, 10)}
            </span>
            {receipt.voidedAt && <span className="ml-2 text-xs font-bold text-bad">✕</span>}
            {/* The picker's exact words (round 79) survive the link: a prixod
                must not lose its goods/kg/m³ the moment it is attached —
                that asymmetry is what the owner reported (round 100 item 2). */}
            {(receipt.goods || receipt.volumeM3 || receipt.weightKg) && (
              <span className="block truncate text-xs text-ink-700">
                {[
                  receipt.goods,
                  receipt.volumeM3 ? `${receipt.volumeM3.toFixed(2)} m³` : '',
                  receipt.weightKg ? `${receipt.weightKg.toFixed(1)} kg` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </Link>
        ))}
        {unlinked.length > 0 && <LinkReceipt dealId={row.deal.id} receipts={unlinked} />}
      </Section>

      {/* The charge panel stood here from phase 5 to round 100. The owner
          closed it — pricing a client is the admin's call, made on the ledger
          («sotuvchi narx qoyib qoyadi … yop bitimdan yop buni») — and the
          ledger's own form carries the deal picker, so a deferral-covered
          charge is still one screen away. */}

      {/* Per deal, never per line (DEALS.md answer 7). Revenue is what was
          CHARGED — the discount already flowed into the lower charge, so
          subtracting it here would count it twice. */}
      {profit && (
        <section className="card space-y-1 text-sm" data-testid="deal-profit-panel">
          <p className="section-title">💰 {t('profitTitle')}</p>
          <div className="flex justify-between">
            <span className="text-ink-500">{t('profitRevenue')}</span>
            <span className="num">{profit.revenueUsd.toFixed(2)} $</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-500">{t('profitCost')}</span>
            <span className="num">{profit.costUsd.toFixed(2)} $</span>
          </div>
          <div className="flex justify-between border-t border-line pt-1 font-bold">
            <span>{t('profitNet')}</span>
            <span className={`num ${profit.profitUsd >= 0 ? 'text-good' : 'text-bad'}`}>
              {profit.profitUsd.toFixed(2)} $
              {profit.marginPct !== null && (
                <span className="ml-1 text-xs font-normal text-ink-500">
                  ({profit.marginPct} %)
                </span>
              )}
            </span>
          </div>
          {profit.unlinkedBatchUsd > 0 && (
            <p className="rounded-xl border border-warn/30 bg-warn/10 p-2 text-xs">
              {t('profitUnlinked', { amount: profit.unlinkedBatchUsd.toFixed(2) })}
            </p>
          )}
        </section>
      )}

      {actor.permissions.has('finance.debt_override') && (
        <Panel title={`⏳ ${t('defer')}`} testId="deal-defer-panel">
          <DeferForm dealId={row.deal.id} />
        </Panel>
      )}

      <CalcPanel
        entityType="deal"
        entityId={row.deal.id}
        revalidate={`/bitimlar/${row.deal.id}`}
      />
      <TasksPanel entityType="deal" entityId={row.deal.id} revalidate={`/bitimlar/${row.deal.id}`} />

      <CustomFieldsPanel
        entityType="deal"
        entityId={row.deal.id}
        revalidate={`/bitimlar/${row.deal.id}`}
      />

          </>
        }
        tail={
          /* Last on a phone: the audit trail is what you consult, never what
             you came for (owner: «istoriya tarix mobileda eng pastda»). */
          <Section title={tc('history')}>
            <HistoryTab entityType="deal" entityId={row.deal.id} />
          </Section>
        }
      />
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string | number | null;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`num ${strong ? 'font-bold' : ''} ${value === null ? 'text-ink-400' : ''}`}>
        {value ?? '—'}
      </dd>
    </div>
  );
}
