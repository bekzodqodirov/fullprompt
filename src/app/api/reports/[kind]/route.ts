import { z } from 'zod';
import { AuthError, authorize, getActor } from '@/modules/platform/rbac/authorize';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';
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
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { readJournalWindow, UNCLAIMED_KEY } from '@/modules/wms/reports/queries';

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
  // The landed-cost file IS the tannarx (Q19): the VED holds the report
  // grant and still gets no file — the screen refuses him the same way.
  if (kind.data === 'landed-cost' && moneyHidden('results', actor.permissions)) {
    return new Response('Forbidden', { status: 403 });
  }

  const scope = actor.permissions.has('reports.all_warehouses') ? undefined : actor.warehouseIds;
  const url = new URL(request.url);
  const clientId = z.string().uuid().safeParse(url.searchParams.get('clientId'));
  // The landed-cost report's «Egasiz yuk» row drills in by this key (U19).
  const unclaimed = url.searchParams.get('clientId') === UNCLAIMED_KEY;
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

  // The file is downloaded to be read, so its headers follow the reader.
  const locale = actor.locale;

  let xlsx: Buffer;
  switch (kind.data) {
    case 'landed-cost':
      xlsx = await buildLandedCostXlsx(unclaimed ? null : clientId.success ? clientId.data : undefined, locale);
      break;
    case 'stock-aging':
      xlsx = await buildStockAgingXlsx(scope, locale);
      break;
    case 'batches':
      // Keyed on the VED rule alone, not on the screen's `showCosts`: that one
      // also hides the column from the warehouse manager, and changing his
      // download is a separate decision (stated to the lead).
      xlsx = await buildBatchRegisterXlsx(scope, locale, { costs: !moneyHidden('results', actor.permissions) });
      break;
    case 'receipts-journal':
      xlsx = await buildReceiptsJournalXlsx(
        readJournalWindow({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          days: url.searchParams.get('days'),
        }),
        scope,
        locale,
      );
      break;
    case 'unclaimed':
      xlsx = await buildUnclaimedXlsx(scope, locale);
      break;
    case 'client-history':
      if (!clientId.success) return new Response('clientId required', { status: 400 });
      xlsx = await buildClientHistoryXlsx(clientId.data, locale);
      break;
    case 'staff-activity':
      xlsx = await buildStaffActivityXlsx(days, locale);
      break;
    case 'label-prints':
      xlsx = await buildLabelPrintLogXlsx(days, locale);
      break;
    case 'in-transit':
      xlsx = await buildInTransitXlsx(scope, locale);
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
      'content-disposition': `attachment; filename="${kind.data}-${tashkentDay()}.xlsx"`,
    },
  });
}
