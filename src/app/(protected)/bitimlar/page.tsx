import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import {
  canWriteDeal,
  dealsNeedingAttention,
  listDeals,
  listStages,
} from '@/modules/wms/deals/service';
import { DealBoard, type BoardDeal } from './board';

/**
 * The deal board — "which of my jobs is stuck".
 *
 * A lead is somebody who is not yet a client and is worked once; a deal is an
 * existing client's job and repeats. With 1442 clients shipping again and
 * again, a funnel filled with the same names stops being a funnel, which is
 * why this board exists beside the lead board rather than instead of it
 * (docs/DEALS.md, "The board").
 */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!canWriteDeal(actor.permissions)) redirect('/');
  const t = await getTranslations('deals');
  const tc = await getTranslations('crm');
  const params = await searchParams;

  const seesAll = actor.permissions.has('crm.leads.view_all');
  // Somebody who may see everything still starts on their own jobs; "all" is
  // one tap away and is what the owner uses.
  const mine = !seesAll || params.scope !== 'all';
  const scope = mine ? actor.id : undefined;

  const [stages, rows, attention] = await Promise.all([
    listStages(),
    listDeals({ ownerId: scope }),
    dealsNeedingAttention(scope),
  ]);

  const flags = new Map(attention.map((row) => [row.id, row]));
  const deals: BoardDeal[] = rows.map((row) => {
    const flag = flags.get(row.id);
    return {
      id: row.id,
      stageId: row.stageId,
      code: row.code,
      title: row.title,
      clientCode: row.clientCode,
      clientName: row.clientName,
      ownerName: row.ownerName,
      quotedAmount: row.quotedAmount,
      quotedCurrency: row.quotedCurrency,
      deferred: row.deferred,
      flag: (flag?.reason as 'deviation' | 'unpriced' | undefined) ?? null,
      flagPct: flag?.pct ?? null,
    };
  });

  return (
    <div className="space-y-3">
      <PageHeader
        icon="handshake"
        title={t('title')}
        actions={
          <>
            {/* The other half of the sales story — see /crm's header. Only
                for somebody the lead funnel would actually let in. */}
            {actor.permissions.has('crm.leads') && (
              <Link href="/crm" className="btn-secondary px-3" data-testid="to-leads">
                <Icon name="target" className="h-4 w-4" />
                {tc('funnel')}
              </Link>
            )}
            <Link href="/bitimlar/new" className="btn-primary" data-testid="new-deal">
              <Icon name="plus" className="h-4 w-4" />
              {t('newDeal')}
            </Link>
          </>
        }
      />

      {seesAll && (
        <div className="flex gap-2">
          <Link
            href="/bitimlar"
            className={mine ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
          >
            {t('mine')}
          </Link>
          <Link
            href="/bitimlar?scope=all"
            className={mine ? 'btn-secondary flex-1' : 'btn-primary flex-1'}
          >
            {t('all')}
          </Link>
        </div>
      )}

      {/* Above the board on purpose. A board answers "where is everything";
          this answers "what is on fire", and that is the reason to open it. */}
      {attention.length > 0 && (
        <section className="space-y-1" data-testid="deal-attention">
          <h2 className="section-title text-bad">
            ⚠️ {t('attention')} · {attention.length}
          </h2>
          {attention.slice(0, 8).map((row) => (
            <Link
              key={row.id}
              href={`/bitimlar/${row.id}`}
              className="card block !p-2.5 hover:bg-surface-sunken"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="num text-xs font-bold text-ink-500">{row.code}</span>
                <span className="num font-bold text-good">{row.clientCode}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{row.clientName}</span>
                <span className="text-xs font-bold text-bad">
                  {row.reason === 'unpriced'
                    ? t('unpriced')
                    : `${row.pct !== null && row.pct > 0 ? '+' : ''}${row.pct?.toFixed(0)} % · ${t('deviation')}`}
                </span>
              </div>
            </Link>
          ))}
        </section>
      )}

      <DealBoard stages={stages} deals={deals} />
    </div>
  );
}
