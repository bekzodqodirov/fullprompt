import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { AttachmentDeleteError, deleteAttachment } from '@/modules/platform/files/service';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';

const variantSchema = z.enum(['original', 'thumb200', 'thumb800']).default('original');

/**
 * Serve an attachment (original or thumbnail) by streaming the bytes through
 * the app — never a redirect to the storage host (minio:9000 / a LAN IP is
 * often unreachable from the viewer's browser).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const { id } = await params;
  const variant = variantSchema.parse(
    new URL(request.url).searchParams.get('variant') ?? 'original',
  );

  const attachment = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!attachment) return new Response('Not found', { status: 404 });

  const key =
    variant === 'thumb200'
      ? (attachment.thumb200Key ?? attachment.storageKey)
      : variant === 'thumb800'
        ? (attachment.thumb800Key ?? attachment.storageKey)
        : attachment.storageKey;
  const contentType = key.endsWith('.webp') ? 'image/webp' : attachment.contentType;

  // Always stream through the app, for BOTH drivers. A redirect to a
  // presigned URL breaks whenever the storage host isn't reachable from the
  // browser — http://minio:9000 exists only inside the Docker network, and a
  // LAN-IP phone session has the same problem with any absolute host.
  try {
    const body = await getStorage().get(key);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': contentType,
        'cache-control': 'private, max-age=600',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** Remove a wrongly-added photo/file (uploader or anyone with receipts.edit). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'unauthorized' }, { status: 401 });
    throw err;
  }

  const { id } = await params;
  try {
    await deleteAttachment(id, actor);
  } catch (err) {
    if (err instanceof AttachmentDeleteError) {
      return Response.json(
        { error: err.code },
        { status: err.code === 'not_found' ? 404 : 403 },
      );
    }
    throw err;
  }
  return Response.json({ ok: true });
}
