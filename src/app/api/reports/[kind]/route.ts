import { z } from 'zod';
import { AuthError, authorize, getActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  buildBatchRegisterXlsx,
  buildClientHistoryXlsx,
  buildInTransitXlsx,
  buildLabelPrintLogXlsx,
  buildLandedCostXlsx,
  buildReceiptsJournalXlsx,
  buildStaffActivityXlsx,
  buildStockAgingXlsx,
  buildUnclaimedXlsx,
} from '@/modules/wms/reports/xlsx';

const kindSchema = z.enum([
  'landed-cost',
  'stock-aging',
  'batches',
  'receipts-journal',
  'unclaimed',
  'client-history',
  'staff-activity',
  'label-prints',
  'in-transit',
]);
/** Reports only management sees (costs, staff performance, client history). */
const ALL_WH_ONLY = new Set(['landed-cost', 'client-history', 'staff-activity', 'label-prints']);

/**
 * §13 report XLSX exports. Landed cost needs all-warehouse reporting rights;
 * the other two also serve warehouse staff scoped to their own warehouses.
 * Every export is audit-logged (spec: exports leave a trace).
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind: rawKind } = await params;
  const kind = kindSchema.safeParse(rawKind);
  if (!kind.success) return new Response('Not found', { status: 404 });

  let actor;
  try {
    if (ALL_WH_ONLY.has(kind.data)) {
      actor = await authorize('reports.all_warehouses');
    } else {
      actor = await getActor();
      if (!actor) throw new AuthError('Not authenticated', 'unauthenticated');
      if (
        !actor.permissions.has('reports.all_warehouses') &&
        !actor.permissions.has('reports.own_warehouse')
      ) {
        throw new AuthError('Missing reports permission', 'forbidden');
      }
    }
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }

  const scope = actor.permissions.has('reports.all_warehouses') ? undefined : actor.warehouseIds;
  const url = new URL(request.url);
  const clientId = z.string().uuid().safeParse(url.searchParams.get('clientId'));
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

  let xlsx: Buffer;
  switch (kind.data) {
    case 'landed-cost':
      xlsx = await buildLandedCostXlsx(clientId.success ? clientId.data : undefined);
      break;
    case 'stock-aging':
      xlsx = await buildStockAgingXlsx(scope);
      break;
    case 'batches':
      xlsx = await buildBatchRegisterXlsx(scope);
      break;
    case 'receipts-journal':
      xlsx = await buildReceiptsJournalXlsx(days, scope);
      break;
    case 'unclaimed':
      xlsx = await buildUnclaimedXlsx(scope);
      break;
    case 'client-history':
      if (!clientId.success) return new Response('clientId required', { status: 400 });
      xlsx = await buildClientHistoryXlsx(clientId.data);
      break;
    case 'staff-activity':
      xlsx = await buildStaffActivityXlsx(days);
      break;
    case 'label-prints':
      xlsx = await buildLabelPrintLogXlsx(days);
      break;
    case 'in-transit':
      xlsx = await buildInTransitXlsx(scope);
      break;
  }

  const meta = await requestMeta();
  await writeAudit(
    (await import('@/modules/platform/db/client')).db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'report',
      entityId: actor.id,
      action: 'export',
      after: { report: kind.data, clientId: clientId.success ? clientId.data : null },
    },
  );

  return new Response(new Uint8Array(xlsx), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${kind.data}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
