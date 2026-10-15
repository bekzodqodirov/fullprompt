import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import { costSightFor } from '@/modules/wms/costing/cost-sight';
import { maySeeStaffMoney } from '@/modules/wms/partners/staff';
import { readSpendFilters, sarflarPeriod, type SpendPayer } from '@/modules/wms/accounting/sarflar';
import { buildSpendXlsx } from '@/modules/wms/accounting/sarflar-xlsx';

const PAYER_LABEL: Record<SpendPayer, string> = {
  kassa: 'payer.kassa',
  own: 'payer.own',
  firm: 'payer.firm',
  book: 'payer.book',
  queue: 'payer.queue',
  history: 'payer.history',
  noKassa: 'payer.noKassa',
};

/**
 * «Pul qayerga ketdi»'s register as XLSX (docs/SARFLAR.md §8.4) — its own
 * route, behind the page's own door (`companyMoneySight`, else 403), over
 * the page's own validated filters. Every download is an audit row.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return new Response('Forbidden', { status: 403 });
  const sight = companyMoneySight(actor);
  if (!sight) return new Response('Forbidden', { status: 403 });
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const period = sarflarPeriod(params);
  const seesStaff = maySeeStaffMoney(actor.permissions);
  const expenseRows = seesStaff;
  const filters = readSpendFilters(params, { seesStaff, expenseRows });
  const t = await getTranslations({ locale: actor.locale, namespace: 'sarflar' });
  const xlsx = await buildSpendXlsx(
    sight,
    period,
    filters,
    { id: actor.id, seesStaff, expenseRows, costs: costSightFor(actor), permissions: actor.permissions },
    {
      title: t('title'),
      date: t('xDate'),
      book: t('fBook'),
      type: t('fType'),
      amount: t('xAmount'),
      currency: t('xCurrency'),
      where: t('xWhere'),
      warehouse: t('fWarehouse'),
      payer: t('fPayer'),
      author: t('xAuthor'),
      bookCost: t('bookCost'),
      bookExpense: t('bookExpense'),
      kassa: t('payer.kassa'),
      sliced: (shown, total) => t('registerCount', { shown, total }),
      payerWord: (row) => t(PAYER_LABEL[row.payer]),
    },
  );
  const meta = await requestMeta();
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'report',
    entityId: actor.id,
    action: 'export',
    after: { report: 'accounting:sarflar', from: period.from, to: period.to, filters },
  });
  return new Response(new Uint8Array(xlsx), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="sarflar-${period.from}-${period.to}.xlsx"`,
    },
  });
}
