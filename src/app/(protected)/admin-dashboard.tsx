import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { seesAllMoney } from '@/modules/wms/finance/scope';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { cashFlow, companyBalance } from '@/modules/wms/accounting/reports';
import { moneySnapshot, todaySnapshot } from '@/modules/wms/reports/overview';
import { inTransitBatches, stockByWarehouse } from '@/modules/wms/reports/queries';
import { decidedLeadCounts } from '@/modules/wms/crm/analytics';
import { openDealsSummary } from '@/modules/wms/deals/service';
import { taskPulse } from '@/modules/platform/tasks/analytics';
import { notificationProblemCount } from '@/modules/platform/notifications/service';
import { backupStatus, type BackupStatus } from '@/modules/platform/backup/objects';

/**
 * The owner's own morning screen (round 107, item 4: «admin uchun glavnida
 * dashboard kerak … firmani holatini bilish uchun kerak bo'lgan hamma
 * narsa», his «ha yetarli» on this exact block list). Every working role
 * wakes to its day; the admin's day is the company.
 *
 * Rendered ONLY when `buildHomeFlow` returned null and the actor carries the
 * admin/super_admin ROLE — an admin who also holds a working role keeps that
 * working home (narrowest job wins, round 15's rule; stated to the owner).
 * Every number is an existing screen's own exported function, so the cell
 * and the screen it links can never argue (#513) — and each block asks its
 * destination's PERMISSION too, because role grants are editable data and a
 * home cell must never show money behind a link that bounces (round 91).
 *
 * Reads no searchParams and exposes no action — #514 satisfied by
 * construction. The whole fetch lives inside this component, so nobody but
 * the admin pays a millisecond for it (~30 grouped statements, the
 * round-45 discipline).
 */

const round2 = (value: number) => Math.round(value * 100) / 100;
const usd = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;

export async function AdminDashboard({ actor }: { actor: Actor }) {
  const t = await getTranslations('adminHome');
  const perms = actor.permissions;
  const money = perms.has('finance.reports') && seesAllMoney(actor);
  const cargo = mayReadBatches(perms);
  const sales = perms.has('crm.manage');
  const today = new Date().toISOString().slice(0, 10);

  const [balance, flowToday, moneySnap, cargoToday, stock, transit, deals, decided, tasks, unsent, backup] =
    await Promise.all([
      money ? companyBalance() : null,
      money ? cashFlow(today, today) : null,
      money ? moneySnapshot() : null,
      cargo ? todaySnapshot() : null,
      cargo ? stockByWarehouse() : null,
      cargo ? inTransitBatches() : null,
      sales ? openDealsSummary() : null,
      sales
        ? decidedLeadCounts(
            new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
          )
        : null,
      perms.has('reports.all_warehouses') ? taskPulse(new Date()) : null,
      perms.has('admin.audit.browse') ? notificationProblemCount(7) : null,
      perms.has('admin.settings.manage')
        ? backupStatus().catch((): BackupStatus | null => null)
        : null,
    ]);

  // The kassa figure drops any till whose currency has no entered rate —
  // the balance screen flags those per row, a lone number cannot, so the ⚠
  // travels with it.
  const unratedTill = Boolean(balance?.cashRows.some((row) => row.balanceUsd === null));

  const stockTotals = (stock ?? []).reduce(
    (acc, row) => ({
      boxes: acc.boxes + Number(row.boxCount),
      kg: acc.kg + Number(row.kg),
      m3: acc.m3 + Number(row.m3),
    }),
    { boxes: 0, kg: 0, m3: 0 },
  );
  const transitBoxes = (transit ?? []).reduce((acc, row) => acc + Number(row.boxCount), 0);

  // The zaxira signal has THREE states, and day one is the third: with no
  // off-site destination configured the honest word is «sozlanmagan», not a
  // permanent red about a backup that was never switched on (the compose
  // dump still runs nightly; the panel on /admin says all of it).
  const backupState: 'off' | 'ok' | 'stale' | null = backup
    ? backup.destination === null
      ? 'off'
      : backup.lastDump && new Date().getTime() - backup.lastDump.at.getTime() < 26 * 3600_000
        ? 'ok'
        : 'stale'
    : null;

  const blocks = [money, cargo, sales].filter(Boolean).length;
  if (blocks === 0 && !tasks && unsent === null && !backupState) return null;

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="admin-dash">
      {money && balance && flowToday && moneySnap && (
        <section className="card space-y-1 text-sm" data-testid="adm-pul">
          <h2 className="text-xs font-bold uppercase text-ink-500">💰 {t('money')}</h2>
          <Row href="/accounting/balance" label={t('cash')}>
            {usd(balance.cashUsd)}
            {unratedTill && <span className="text-warn"> ⚠</span>}
          </Row>
          <Row href="/accounting" label={t('todayFlow')}>
            +{usd(flowToday.inflow)} · −{usd(flowToday.outflow)}
          </Row>
          <Row href="/finance" label={t('debtors')}>
            {usd(moneySnap.receivable)} · {moneySnap.debtors} {t('clientsShort')}
          </Row>
          <Row href="/kontragentlar" label={t('partnerDebt')}>
            −{usd(balance.payableUsd)} · +{usd(balance.partnerReceivableUsd)}
          </Row>
          <Row href="/accounting" label={t('monthMoney')}>
            {usd(moneySnap.revenueMonth)} / {usd(moneySnap.paidMonth)}
          </Row>
        </section>
      )}

      {cargo && cargoToday && (
        <section className="card space-y-1 text-sm" data-testid="adm-yuk">
          <h2 className="text-xs font-bold uppercase text-ink-500">📦 {t('cargo')}</h2>
          <Row href="/stock" label={t('stock')}>
            {stockTotals.boxes} 📦 · {round2(stockTotals.m3)} m³ · {Math.round(stockTotals.kg)} kg
          </Row>
          <Row href="/transit" label={t('onRoad')}>
            {(transit ?? []).length} {t('trucksShort')} · {transitBoxes} 📦
          </Row>
          <Row href="/receipts" label={t('todayReceipts')}>
            {cargoToday.receipts}
          </Row>
        </section>
      )}

      {sales && deals && decided && (
        <section className="card space-y-1 text-sm" data-testid="adm-savdo">
          <h2 className="text-xs font-bold uppercase text-ink-500">🤝 {t('sales')}</h2>
          <Row href="/bitimlar" label={t('openDeals')}>
            {deals.count} · {usd(deals.usdSum)}
            {deals.otherCurrency > 0 && (
              <span className="text-ink-500"> +{deals.otherCurrency} {t('otherCurrency')}</span>
            )}
          </Row>
          <Row href="/crm/tahlil" label={t('monthDecided')}>
            <span className="text-good">{decided.won} ✓</span> ·{' '}
            <span className="text-bad">{decided.lost} ✗</span> · {usd(decided.wonUsd)}
          </Row>
        </section>
      )}

      {(tasks || unsent !== null || backupState) && (
        <section className="card space-y-1 text-sm" data-testid="adm-signal">
          <h2 className="text-xs font-bold uppercase text-ink-500">🔔 {t('signals')}</h2>
          {backupState && (
            <Row href="/admin" label={t('backup')}>
              {backupState === 'ok' ? (
                <span className="text-good">✓ {t('backupOk')}</span>
              ) : backupState === 'off' ? (
                <span className="text-warn">{t('backupOff')}</span>
              ) : (
                <span className="font-bold text-bad">⚠ {t('backupStale')}</span>
              )}
            </Row>
          )}
          {unsent !== null && (
            <Row href="/admin/notifications" label={t('unsent')}>
              <span className={unsent > 0 ? 'font-bold text-warn' : 'text-good'}>{unsent}</span>
            </Row>
          )}
          {tasks && (
            <Row href="/reports/vazifalar" label={t('overdueTasks')}>
              <span className={tasks.overdue > 0 ? 'font-bold text-warn' : 'text-good'}>
                {tasks.overdue}
              </span>{' '}
              · {tasks.dueToday} {t('dueTodayShort')}
            </Row>
          )}
        </section>
      )}
    </div>
  );
}

function Row({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-ink-500">{label}</span>
      <span className="text-right font-mono font-semibold tabular-nums">{children}</span>
    </Link>
  );
}
