import { getTranslations } from 'next-intl/server';
import { taskPulse } from '@/modules/platform/tasks/analytics';
import { pendingApprovals } from '@/modules/wms/issue/approvals';
import { calcQueueCounts } from '@/modules/wms/calc/service';
import {
  loadAging,
  loadBalance,
  loadCostMissing,
  loadGaps,
  loadRisk,
  loadTransit,
  loadTrips,
  loadUnbatched,
  loadUnbilled,
  loadUnclaimed,
  loadWindows,
} from '@/modules/wms/reports/dashboard';
import {
  approvalCounts,
  daysSince,
  rankAttention,
  tripKind,
  type AttentionItem,
} from '@/modules/wms/reports/dashboard-math';
import { AttentionList, type AttentionRow } from '@/components/charts/attention-list';
import { m3, num, usd } from '@/components/charts/format';

type Kind =
  | 'missing'
  | 'phantom'
  | 'lost'
  | 'negativeTills'
  | 'old90'
  | 'unbilled'
  | 'stuck'
  | 'unpriced'
  | 'unallocated'
  | 'costMissing'
  | 'unconverted'
  | 'manualCharges'
  | 'unplacedPayments'
  | 'unplacedCosts'
  | 'unratedTills'
  | 'undocumented'
  | 'unclaimed'
  | 'overdueTasks'
  | 'recurringDue'
  | 'approvals'
  | 'priceApprovals'
  | 'calcLate';

/**
 * «E'tibor kerak» (spec «B»): ONE ranked list of what a person must do today,
 * and of the gaps that would make the P&L, the cash flow or the Balans read
 * wrong — bad before warn, then by the money at stake. Each row is a sentence
 * with its numbers in it and a link to the screen where it is fixed, and each
 * is built only for a viewer who may open that screen (a row that bounces is
 * worse than no row). Every count is the destination's own (#513).
 */
export async function AttentionSection({
  money,
  cargo,
  scopeKey,
  perms,
  seesCostMissing,
}: {
  money: boolean;
  cargo: boolean;
  scopeKey: string;
  perms: Set<string>;
  /** The cargo section's own condition for drawing the list this row jumps to. */
  seesCostMissing: boolean;
}) {
  const t = await getTranslations('dashboard');
  const w = loadWindows();
  const allWh = perms.has('reports.all_warehouses');
  const canExpenses = perms.has('finance.expenses');
  const canApprove = perms.has('finance.debt_override');
  const canCalc = perms.has('ved.docs');

  const [balance, aging, trips, gaps, unbilled, risk, transit, unclaimed, costMissing, tasks, approvals, calc] =
    await Promise.all([
      money ? loadBalance() : null,
      money ? loadAging() : null,
      money ? loadTrips() : null,
      money ? loadGaps() : null,
      money ? loadUnbilled(scopeKey) : null,
      cargo ? loadRisk(scopeKey) : null,
      cargo ? loadTransit(scopeKey) : null,
      loadUnclaimed(scopeKey),
      seesCostMissing ? loadCostMissing(scopeKey) : null,
      allWh ? taskPulse(new Date()) : null,
      canApprove ? pendingApprovals() : null,
      canCalc ? calcQueueCounts() : null,
    ]);

  const items: (AttentionItem<Kind> & { text: string; value?: string; href: string })[] = [];
  const push = (item: AttentionItem<Kind> & { text: string; value?: string; href: string }) => items.push(item);

  if (risk) {
    push({
      kind: 'missing',
      level: 'bad',
      count: risk.missing.boxes,
      usd: money ? risk.missing.usd : null,
      text: money
        ? t('att.missing', { n: risk.missing.boxes, m3: m3(risk.missing.m3), usd: usd(risk.missing.usd) })
        : t('att.missingNoMoney', { n: risk.missing.boxes, m3: m3(risk.missing.m3) }),
      href: '/transit',
    });
    push({
      kind: 'phantom',
      level: 'bad',
      count: risk.phantom.boxes,
      usd: money ? risk.phantom.usd : null,
      text: money
        ? t('att.phantom', { n: risk.phantom.boxes, usd: usd(risk.phantom.usd) })
        : t('att.phantomNoMoney', { n: risk.phantom.boxes }),
      href: '/reports/yuk-xavfi#phantom',
    });
    push({
      kind: 'lost',
      level: 'bad',
      count: risk.lost.boxes,
      usd: money ? risk.lost.usd : null,
      text: money
        ? t('att.lost', { n: risk.lost.boxes, usd: usd(risk.lost.usd) })
        : t('att.lostNoMoney', { n: risk.lost.boxes }),
      href: '/reports/yuk-xavfi#lost',
    });
    push({
      kind: 'undocumented',
      level: 'warn',
      count: risk.undocumented.boxes,
      text: t('att.undocumented', { n: risk.undocumented.boxes }),
      href: '/reports/yuk-xavfi#undocumented',
    });
  }
  if (transit) {
    // The transit card's own chip rule: standing at the gate 2+ days.
    const stuck = transit.filter((row) => row.status === 'arrived' && daysSince(row.arrivedAt, w.today) >= 2);
    push({ kind: 'stuck', level: 'warn', count: stuck.length, text: t('att.stuck', { n: stuck.length }), href: '/transit' });
  }
  if (balance) {
    // The Balans's own list (U14): one predicate for both screens.
    const negative = balance.negativeTills.length;
    push({
      kind: 'negativeTills',
      level: 'bad',
      count: negative,
      text: t('att.negativeTills', { n: negative }),
      href: canExpenses ? '/accounting/accounts' : '/accounting/balance',
    });
    // The Balans's own list (U14): an EMPTY till with no rate hides nothing.
    const unrated = balance.unratedTills.reduce((sum, row) => sum + row.count, 0);
    push({
      kind: 'unratedTills',
      level: 'warn',
      count: unrated,
      text: t('att.unratedTills', { n: unrated }),
      href: perms.has('costs.fx.manage') ? '/admin/fx' : '/accounting/balance',
    });
    push({
      kind: 'unplacedPayments',
      level: 'warn',
      count: balance.unplacedCount,
      usd: balance.unplacedUsd,
      text: t('att.unplacedPayments', { n: balance.unplacedCount, usd: usd(balance.unplacedUsd) }),
      href: '/finance/reestr?joylanmagan=1',
    });
    if (canExpenses) {
      push({
        kind: 'unplacedCosts',
        level: 'warn',
        count: balance.unplacedCostCount,
        usd: balance.unplacedCostUsd,
        text: t('att.unplacedCosts', { n: balance.unplacedCostCount, usd: usd(balance.unplacedCostUsd) }),
        href: '/accounting/xarajat-kassa',
      });
    }
  }
  if (aging) {
    const old = aging.filter((row) => (row.buckets[3] ?? 0) > 0.009);
    const oldUsd = old.reduce((sum, row) => sum + (row.buckets[3] ?? 0), 0);
    push({
      kind: 'old90',
      level: 'bad',
      count: old.length,
      usd: oldUsd,
      text: t('att.old90', { usd: usd(oldUsd), n: old.length }),
      href: '/accounting/receivables',
    });
  }
  if (unbilled) {
    const boxes = unbilled.reduce((sum, row) => sum + row.boxes, 0);
    const volume = unbilled.reduce((sum, row) => sum + row.m3, 0);
    push({
      kind: 'unbilled',
      level: 'bad',
      count: unbilled.length,
      text: t('att.unbilled', { n: unbilled.length, boxes: num(boxes), m3: m3(volume) }),
      href: '#narxsiz',
    });
  }
  if (trips) {
    const rows = trips.filter(
      (row) => tripKind(row) === 'unpriced' && ['arrived', 'unloaded', 'closed'].includes(row.status),
    );
    const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    let unpricedText = t('att.unpriced', { n: rows.length, usd: usd(cost) });
    if (rows.length > 0) {
      const unbatched = await loadUnbatched();
      if (unbatched > 0.009) {
        unpricedText += ` — ${t('att.unpricedUnbatched', { usd: usd(unbatched) })}`;
      }
    }
    push({
      kind: 'unpriced',
      level: 'warn',
      count: rows.length,
      usd: cost,
      text: unpricedText,
      href: `/accounting/profit?view=batch&from=${w.m12Start}&to=${w.today}`,
    });
    const unallocated = trips.filter((row) => row.unallocatedUsd > 0.009);
    const unallocatedUsd = unallocated.reduce((sum, row) => sum + row.unallocatedUsd, 0);
    push({
      kind: 'unallocated',
      level: 'warn',
      count: unallocated.length,
      usd: unallocatedUsd,
      text: t('att.unallocated', { n: unallocated.length, usd: usd(unallocatedUsd) }),
      href: `/accounting/profit?view=batch&from=${w.m12Start}&to=${w.today}`,
    });
  }
  if (gaps) {
    const sums = gaps.unconverted.byCurrency.map((row) => `${row.currency} ${num(row.amount)}`).join(', ');
    push({
      kind: 'unconverted',
      level: 'warn',
      count: gaps.unconverted.count,
      text: t('att.unconverted', { n: gaps.unconverted.count, sums }),
      href: perms.has('costs.fx.manage') ? '/admin/fx' : `/accounting/pnl?from=${w.m12Start}&to=${w.today}`,
    });
    push({
      kind: 'manualCharges',
      level: 'warn',
      count: gaps.manualCharges.count,
      usd: gaps.manualCharges.usd,
      text: t('att.manualCharges', { n: gaps.manualCharges.count, usd: usd(gaps.manualCharges.usd) }),
      href: '/kontragentlar',
    });
  }
  if (costMissing) {
    push({
      kind: 'costMissing',
      level: 'warn',
      count: costMissing.count,
      text: t('att.costMissing', { n: costMissing.count }),
      href: '#xarajatsiz',
    });
  }
  push({
    kind: 'unclaimed',
    level: 'warn',
    count: unclaimed.receipts,
    text: t('att.unclaimed', { receipts: unclaimed.receipts, boxes: unclaimed.boxes }),
    href: '/unclaimed',
  });
  if (tasks) {
    push({
      kind: 'overdueTasks',
      level: 'warn',
      count: tasks.overdue,
      text: t('att.overdueTasks', { n: tasks.overdue }),
      href: '/reports/vazifalar',
    });
  }
  // Rent and salaries whose day has come and nobody has paid (owner's Q6):
  // the Balans line's own figures, so this row, the home counter and the
  // subtracted line are one count (#513). Book entries count here and carry
  // no money — hence the total beside the Balans line's dollars.
  if (money && canExpenses && balance) {
    push({
      kind: 'recurringDue',
      level: 'warn',
      count: balance.recurringArrearsTotal,
      usd: balance.recurringArrearsUsd,
      text: t('att.recurringDue', { n: balance.recurringArrearsTotal, usd: usd(balance.recurringArrearsUsd) }),
      href: '/accounting/expenses#recurring',
    });
  }
  if (approvals) {
    // 0104: a request may ask about a debt, about cargo with no price, or
    // both — each sentence counts only the rows that ask its question, so a
    // price-only request never reads as «qarz bilan berishga ruxsat».
    const counts = approvalCounts(approvals);
    if (counts.debt.n > 0) {
      push({
        kind: 'approvals',
        level: 'warn',
        count: counts.debt.n,
        usd: money ? counts.debt.usd : null,
        text: money
          ? t('att.approvals', { n: counts.debt.n, usd: usd(counts.debt.usd) })
          : t('att.approvalsNoMoney', { n: counts.debt.n }),
        href: '/approvals',
      });
    }
    if (counts.price.n > 0) {
      push({
        kind: 'priceApprovals',
        level: 'warn',
        count: counts.price.n,
        text: t('att.priceApprovals', { n: counts.price.n }),
        href: '/approvals',
      });
    }
  }
  if (calc) {
    push({ kind: 'calcLate', level: 'warn', count: calc.late, text: t('att.calcLate', { n: calc.late }), href: '/hisoblash' });
  }

  const ranked = rankAttention(items, 7);
  const toRow = (item: (typeof items)[number]): AttentionRow => ({
    kind: item.kind,
    level: item.level,
    text: item.text,
    href: item.href,
  });

  return (
    <section id="diqqat" data-testid="section-attention" className="space-y-2">
      <div className="flex items-baseline gap-2">
        <p className="section-title">⚠️ {t('attentionTitle')}</p>
        {ranked.visibleCount > 0 && (
          <span className={ranked.worst === 'bad' ? 'chip-bad' : 'chip-warn'} data-testid="attention-chip">
            {t('attentionChip', { n: ranked.visibleCount })}
          </span>
        )}
      </div>
      <div className="card">
        <AttentionList
          visible={ranked.visible.map(toRow)}
          hidden={ranked.hidden.map(toRow)}
          moreLabel={t('moreRows', { n: ranked.hidden.length })}
          emptyLabel={t('allClear')}
        />
      </div>
    </section>
  );
}
