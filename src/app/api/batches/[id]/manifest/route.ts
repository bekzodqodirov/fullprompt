import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { buildManifestXlsx } from '@/modules/wms/documents/manifest-xlsx';

/** Actual manifest XLSX — what really departed (fact, not plan). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return new Response('Unauthorized', { status: 401 });
    throw err;
  }
  const { id } = await params;
  const buffer = await buildManifestXlsx(id);
  if (!buffer) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="manifest.xlsx"',
    },
  });
}
