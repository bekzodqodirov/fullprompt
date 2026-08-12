import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { attachments } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { AttachmentDeleteError, deleteAttachment } from '@/modules/platform/files/service';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';

const variantSchema = z.enum(['original', 'thumb200', 'thumb800']).default('original');

/**
 * Which types a browser can render itself, so the tab OPENS the file instead
 * of downloading it (round 98, owner: «fayllarni skachat qilib ochib
 * ko'rmasdan ustiga bosganda o'zidan ochilsin»). A PDF, an image, plain text,
 * audio and video all render inline; a Word or Excel document cannot be shown
 * by the browser and stays a download, which is the honest limit — showing it
 * would need a heavy viewer this does not carry.
 *
 * The disposition also matters for SAFETY: `inline` is only ever sent for
 * types that render as data, never for anything a browser might execute
 * (html/svg/xml), so a stored file cannot become a script running on our
 * origin — those fall through to `attachment`.
 */
function inlineDisposition(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t === 'application/pdf' ||
    t.startsWith('image/') ||
    t.startsWith('audio/') ||
    t.startsWith('video/') ||
    t === 'text/plain'
  );
}

/** RFC 5987 filename, so a Cyrillic or Chinese name survives the header. */
function contentDisposition(fileName: string | null, inline: boolean): string {
  const kind = inline ? 'inline' : 'attachment';
  const name = (fileName ?? 'file').replace(/["\r\n]/g, '');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Serve an attachment (original or thumbnail) by streaming the bytes through
 * the app — never a redirect to the storage host (minio:9000 / a LAN IP is
 * often unreachable from the viewer's browser).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireActor();
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

  // LOG-ONLY for most types: the decision is computed and a would-deny is
  // written to stdout ([attachment-authz] — greppable in docker logs), but
  // the bytes are still served. The general flip to enforcing 404 comes only
  // after the logs have been read on real traffic — a wrong mapping here
  // would blank screens people use daily. The exception is the TELEGRAM
  // branches, which set `enforce` and are refused for real: the owner's
  // direct instruction (2026-07-29) that one manager's chats are not
  // another's to read, and a photo URL must not out-read the thread.
  // Deliberately not writeAudit: one card view can fetch thirty photos, and
  // the audit log is the immutable business record.
  const decision = await decideAttachmentRead(actor, attachment);
  if (!decision.allow) {
    console.warn(
      `[attachment-authz] ${decision.enforce ? 'DENY' : 'WOULD DENY'} user=${actor.id} attachment=${attachment.id} entity=${attachment.entityType}/${attachment.entityId} rule=${decision.rule}`,
    );
    if (decision.enforce) return new Response('Not found', { status: 404 });
  }

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
  // A thumbnail always renders inline; an original opens inline when the
  // browser can show it, and downloads otherwise.
  const inline = variant !== 'original' || inlineDisposition(contentType);

  try {
    const body = await getStorage().get(key);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': contentType,
        'content-disposition': contentDisposition(attachment.fileName, inline),
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
