import { z } from 'zod';
import { AuthError, authorize, getActor } from '@/modules/platform/rbac/authorize';
import { writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  buildBatchRegisterXlsx,
  buildLandedCostXlsx,
  buildStockAgingXlsx,
} from '@/modules/wms/reports/xlsx';

const kindSchema = z.enum(['landed-cost', 'stock-aging', 'batches']);

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
    if (kind.data === 'landed-cost') {
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

  const xlsx =
    kind.data === 'landed-cost'
      ? await buildLandedCostXlsx(clientId.success ? clientId.data : undefined)
      : kind.data === 'stock-aging'
        ? await buildStockAgingXlsx(scope)
        : await buildBatchRegisterXlsx(scope);

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
