import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { loadPlans } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { buildAgentXlsx } from '@/modules/wms/documents/agent-xlsx';

/** Agent approval Excel for a plan version (default: current version). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, id) });
  if (!plan) return new Response('Not found', { status: 404 });
  try {
    await authorize('plans.manage', { warehouseId: plan.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return new Response('Forbidden', { status: 403 });
    throw err;
  }
  const versionNo = Number(new URL(request.url).searchParams.get('v')) || plan.currentVersionNo;
  const buffer = await buildAgentXlsx(id, versionNo);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="plan-v${versionNo}.xlsx"`,
    },
  });
}
