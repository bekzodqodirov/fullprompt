import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { buildInvoiceXlsx } from '@/modules/wms/documents/ved-xlsx';

/** Invoice draft XLSX (W6). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  if (!actor.permissions.has('ved.docs') && !actor.permissions.has('plans.manage')) {
    return new Response('Forbidden', { status: 403 });
  }
  const { id } = await params;
  const buffer = await buildInvoiceXlsx(id);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="invoice-draft.xlsx"',
    },
  });
}
