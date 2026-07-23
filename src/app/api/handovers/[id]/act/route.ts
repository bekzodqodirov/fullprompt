import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { buildHandoverAct } from '@/modules/wms/documents/handover-act';

/** Handover act PDF (optional per issue, spec 6.7). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  const { id } = await params;
  const pdf = await buildHandoverAct(id);
  if (!pdf) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="handover-act.pdf"',
    },
  });
}
