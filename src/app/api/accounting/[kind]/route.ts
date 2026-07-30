import { z } from 'zod';
import { AuthError, getActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { db } from '@/modules/platform/db/client';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import {
  buildCashFlowXlsx,
  buildExpensesXlsx,
  buildPaymentsXlsx,
  buildPnlXlsx,
  buildProfitXlsx,
  buildReceivablesXlsx,
} from '@/modules/wms/accounting/xlsx';

const kindSchema = z.enum(['pnl', 'cashflow', 'receivables', 'profit', 'expenses', 'payments']);

/**
 * Accounting XLSX exports.
 *
 * Gated exactly like the screens: the reports need `finance.reports`, the
 * expense register needs `finance.expenses`. A sales manager holds
 * `finance.view` for client balances and must not be able to pull the
 * company's margin out through a download link.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind: rawKind } = await params;
  const kind = kindSchema.safeParse(rawKind);
  if (!kind.success) return new Response('Not found', { status: 404 });

  try {
    const actor = await getActor();
    if (!actor) throw new AuthError('Not authenticated', 'unauthenticated');
    // The payments register shows who paid, not the company's margin — the
    // same facts the /finance screens already show to finance.view.
    if (kind.data === 'payments') {
      if (!actor.permissions.has('finance.view') && !actor.permissions.has('finance.manage')) {
        throw new AuthError('Missing permission', 'forbidden');
      }
    } else {
      const needed = kind.data === 'expenses' ? 'finance.expenses' : 'finance.reports';
      if (!actor.permissions.has(needed)) throw new AuthError('Missing permission', 'forbidden');
    }

    const url = new URL(request.url);
    const { from, to } = resolvePeriod({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    });
    const asOfRaw = url.searchParams.get('asOf') ?? '';
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : to;
    const viewRaw = url.searchParams.get('view');
    const view = viewRaw === 'client' || viewRaw === 'route' ? viewRaw : 'batch';
    const categoryRaw = url.searchParams.get('categoryId') ?? '';
    const categoryId = z.string().uuid().safeParse(categoryRaw);
    const locale = actor.locale;

    let xlsx: Buffer;
    switch (kind.data) {
      case 'pnl':
        xlsx = await buildPnlXlsx(from, to, locale);
        break;
      case 'cashflow':
        xlsx = await buildCashFlowXlsx(from, to, locale);
        break;
      case 'receivables':
        xlsx = await buildReceivablesXlsx(asOf, locale);
        break;
      case 'profit':
        xlsx = await buildProfitXlsx(view, from, to, locale);
        break;
      case 'payments':
        xlsx = await buildPaymentsXlsx(from, to, locale);
        break;
      case 'expenses':
        xlsx = await buildExpensesXlsx(
          from,
          to,
          categoryId.success ? categoryId.data : undefined,
          locale,
        );
        break;
    }

    const meta = await requestMeta();
    await writeAudit(db, { actorId: actor.id, ...meta }, {
      entityType: 'report',
      entityId: actor.id,
      action: 'export',
      after: { report: `accounting:${kind.data}`, from, to, view: kind.data === 'profit' ? view : null },
    });

    const name = kind.data === 'profit' ? `profit-${view}` : kind.data;
    return new Response(new Uint8Array(xlsx), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${name}-${kind.data === 'receivables' ? asOf : to}.xlsx"`,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }
}
