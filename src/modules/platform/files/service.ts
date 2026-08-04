import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { writeAudit } from '../audit/service';
import { enqueue, JOB_THUMBNAILS } from '../jobs/boss';
import { getStorage } from './storage';

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOC_TYPES = new Set([
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/msword',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
]);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/**
 * Browsers (especially on Windows) send an empty or generic content type for
 * extensions they don't know — fall back to the file extension so a plain
 * .xlsx/.zip from the operator's desktop is not rejected.
 */
const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function resolveContentType(fileName: string, contentType: string): string {
  if (contentType && contentType !== 'application/octet-stream') return contentType;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? contentType;
}

export class FileValidationError extends Error {
  constructor(
    message: string,
    public readonly code: 'unsupported_type' | 'too_large',
  ) {
    super(message);
  }
}

export async function saveAttachment(
  input: {
    entityType: string;
    entityId: string;
    fileName: string;
    contentType: string;
    body: Buffer;
    uploadedBy: string;
  },
  opts: {
    /**
     * 'skip' for callers OUTSIDE the app process (the tg listener): enqueue()
     * starts the FULL pg-boss worker fleet in the calling process — nine
     * groups including the nightly backup — which is exactly the
     * two-backup-systems bug of #253-261. Such a caller makes its own
     * thumbnails inline.
     */
    thumbnails?: 'enqueue' | 'skip';
  } = {},
): Promise<{ id: string }> {
  const contentType = resolveContentType(input.fileName, input.contentType);
  const isPhoto = PHOTO_TYPES.has(contentType);
  if (!isPhoto && !DOC_TYPES.has(contentType) && !VIDEO_TYPES.has(contentType)) {
    throw new FileValidationError(`Unsupported content type: ${contentType || '?'}`, 'unsupported_type');
  }
  const maxBytes = isPhoto
    ? MAX_PHOTO_BYTES
    : VIDEO_TYPES.has(contentType)
      ? MAX_VIDEO_BYTES
      : MAX_DOC_BYTES;
  if (input.body.length > maxBytes) {
    throw new FileValidationError('File too large', 'too_large');
  }

  const storageKey = `${input.entityType}/${input.entityId}/${randomUUID()}`;

  await getStorage().put(storageKey, input.body, contentType);

  const [row] = await db
    .insert(attachments)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      kind: isPhoto ? 'photo' : 'file',
      storageKey,
      fileName: input.fileName,
      contentType,
      sizeBytes: input.body.length,
      uploadedBy: input.uploadedBy,
    })
    .returning({ id: attachments.id });

  if (isPhoto && row && opts.thumbnails !== 'skip') {
    await enqueue(JOB_THUMBNAILS, { attachmentId: row.id });
  }
  return { id: row!.id };
}

export class AttachmentDeleteError extends Error {
  constructor(public readonly code: 'not_found' | 'forbidden' | 'in_use') {
    super(code);
  }
}

/**
 * Remove a wrongly-added photo/file (owner's request). Allowed for the
 * uploader themselves and for anyone who can edit receipts; bytes and
 * thumbnails are removed best-effort after the row is gone.
 */
export async function deleteAttachment(
  id: string,
  actor: { id: string; permissions: Set<string> },
): Promise<void> {
  const attachment = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!attachment) throw new AttachmentDeleteError('not_found');
  if (attachment.uploadedBy !== actor.id && !actor.permissions.has('receipts.edit')) {
    throw new AttachmentDeleteError('forbidden');
  }

  try {
    await db.delete(attachments).where(eq(attachments.id, id));
  } catch (err) {
    // A row something still points at (a queued Telegram reply's photo, via
    // its FK) must refuse politely, not 500 — the record wins over the tidy-up.
    const pg = err as { code?: string; cause?: { code?: string } };
    if (pg?.code === '23503' || pg?.cause?.code === '23503') {
      throw new AttachmentDeleteError('in_use');
    }
    throw err;
  }
  await writeAudit(db, { actorId: actor.id }, {
    entityType: attachment.entityType,
    entityId: attachment.entityId,
    action: 'delete',
    before: { attachmentId: id, fileName: attachment.fileName },
  });

  const storage = getStorage();
  for (const key of [attachment.storageKey, attachment.thumb200Key, attachment.thumb800Key]) {
    if (!key) continue;
    try {
      await storage.delete(key);
    } catch {
      /* bytes may already be gone — the row removal is what matters */
    }
  }
}
