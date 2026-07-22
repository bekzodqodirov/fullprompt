import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';

const variantSchema = z.enum(['original', 'thumb200', 'thumb800']).default('original');

/** Redirect to a signed URL for an attachment (original or thumbnail). */
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

  const url = await getStorage().signedUrl(key);
  return Response.redirect(new URL(url, request.url), 302);
}
