import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { PageHeader } from '@/components/ui/page';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { QUEUE_PAGE, unplacedCostQueue } from '@/modules/wms/accounting/cost-queue';
import { mergeCandidates, recentMerges, sameMoney } from '@/modules/wms/accounting/cost-merge';
import { tillOptionsFor } from '@/modules/wms/costing/till-props';
import { listPartners } from '@/modules/wms/partners/service';
import { CostQueue, type QueueRow } from './cost-queue';

export const dynamic = 'force-dynamic';

/**
 * «Kassasi ko'rsatilmagan xarajatlar» (0101, owner 3b): the cargo costs the
 * warehouse, the logist or the VED typed — people who hold no kassa grant —
 * waiting for the accountant to say which kassa the money left from, that a
 * colleague paid it out of pocket, or that it is an expense typed a second
 * time. Before this a cost could not say where its money came from, so the
 * accountant typed it AGAIN as an expense with a kassa, and the P&L and the
 * cash flow counted it twice.
 */
export default async function CostKassaPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayPickTill(actor.permissions)) redirect('/accounting');
  const t = await getTranslations('accounting');
  const page = Math.max(0, Math.min(1000, Number((await searchParams).p) || 0));

  const [{ rows, total, since }, tills, partners, merges] = await Promise.all([
    unplacedCostQueue(page),
    tillOptionsFor(actor.permissions),
    listPartners({ includeStaff: true }),
    recentMerges(),
  ]);
  const days = rows.map((row) => row.costDate).sort();
  const candidates = days.length ? await mergeCandidates(days[0]!, days[days.length - 1]!) : [];
  const expenseLabel = (e: (typeof candidates)[number]) =>
    `${e.expenseDate} · ${Number(e.amount)} ${e.currency}${e.note ? ` · ${e.note.slice(0, 50)}` : ''}`;

  const view: QueueRow[] = rows.map((row) => {
    const cost = {
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      amountUsd: row.amountUsd === null ? null : Number(row.amountUsd),
      costDate: row.costDate,
    };
    // The 1:1 shape (A3): one expense, the same money by the owner's M4a
    // rule — offered as a suggestion, merged only when the accountant says.
    const twin = candidates.find(
      (e) =>
        sameMoney([cost], {
          amount: Number(e.amount),
          currency: e.currency,
          amountUsd: Number(e.amountUsd),
          expenseDate: e.expenseDate,
        }) === null,
    );
    return {
      id: row.id,
      typeName: row.typeName,
      amount: cost.amount,
      currency: row.currency,
      amountUsd: cost.amountUsd,
      costDate: row.costDate,
      note: row.note,
      enteredByName: row.enteredByName,
      where: row.batchId
        ? { href: `/batches/${row.batchId}`, label: row.batchCode ?? '' }
        : row.receiptId
          ? { href: `/receipts/${row.receiptId}`, label: row.receiptNumber ?? '' }
          : row.crateId
            ? { href: `/crates/${row.crateId}`, label: row.crateCode ?? '' }
            : row.pickupId
              ? { href: `/zavod/${row.pickupId}`, label: row.pickupCode ?? '' }
              : null,
      suggestion: twin ? { expenseId: twin.id, label: expenseLabel(twin) } : null,
    };
  });

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-3xl">
      <PageHeader icon="exchange" title={t('costKassa')} />
      <p className="text-sm text-ink-700">{t('costKassaHint')}</p>
      <p className="text-xs text-ink-500" data-testid="queue-total">
        {t('queueCount', { count: total })}
        {since && ` · ${t('queueSince', { day: since })}`}
      </p>

      <CostQueue
        rows={view}
        tills={tills}
        staff={partners.filter((p) => p.staff && p.active).map((p) => ({ id: p.id, label: p.name }))}
        expenses={candidates.map((e) => ({ id: e.id, label: expenseLabel(e) }))}
      />

      {total > QUEUE_PAGE && (
        <div className="flex justify-between text-sm">
          {page > 0 ? <Link href={`?p=${page - 1}`}>← {t('queuePrev')}</Link> : <span />}
          {(page + 1) * QUEUE_PAGE < total && <Link href={`?p=${page + 1}`}>{t('queueNext')} →</Link>}
        </div>
      )}

      {merges.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">
            🔗 {t('mergedTitle')} ({merges.length})
          </summary>
          <ul className="mt-2 divide-y divide-line text-sm">
            {merges.map((m) => (
              <li key={m.expenseId} className="py-1.5">
                {m.expenseDate} · {Number(m.amount)} {m.currency} · {t('mergedCosts', { count: m.costs })}
                {m.note && <span className="block text-xs text-ink-500">{m.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
