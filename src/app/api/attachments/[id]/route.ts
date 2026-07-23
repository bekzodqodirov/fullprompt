import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { getLocalDriver, getStorage } from '@/modules/platform/files/storage';
import { AttachmentDeleteError, deleteAttachment } from '@/modules/platform/files/service';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';

const variantSchema = z.enum(['original', 'thumb200', 'thumb800']).default('original');

/**
 * Serve an attachment (original or thumbnail). Local driver streams the bytes
 * directly — a redirect to an absolute URL breaks when the app is opened via a
 * LAN IP from a phone (the redirect host may not match the one the client
 * used). S3 deployments redirect to a presigned object-storage URL.
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

  const local = getLocalDriver();
  if (local) {
    try {
      const body = await local.get(key);
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

  const url = await getStorage().signedUrl(key);
  return Response.redirect(new URL(url, request.url), 302);
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
