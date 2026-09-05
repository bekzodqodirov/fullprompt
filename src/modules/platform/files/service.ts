import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { writeAudit } from '../audit/service';
import { enqueue, JOB_THUMBNAILS } from '../jobs/boss';
import { logger } from '../logger';
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
// The calls round: what a phone's own call recorder writes, per vendor —
// Xiaomi mp3/aac, Samsung m4a/amr, others ogg/wav. The card renders these
// with an <audio> player instead of a download tile.
export const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/amr',
  'audio/3gpp',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
]);

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
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
};

/**
 * Would `saveAttachment` accept this content type at all?
 *
 * Exported because the Telegram planner has to answer «is this document
 * worth downloading» BEFORE any bytes move, and the only honest answer is
 * the one storage will give. Two lists that must agree is the shape this
 * codebase keeps paying for — the planner asks THIS one, so a mime that
 * storage refuses is never fetched and never logged as a failure.
 */
export function isStorableType(contentType: string): boolean {
  return (
    PHOTO_TYPES.has(contentType) ||
    DOC_TYPES.has(contentType) ||
    VIDEO_TYPES.has(contentType) ||
    AUDIO_TYPES.has(contentType)
  );
}

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
  if (
    !isPhoto &&
    !DOC_TYPES.has(contentType) &&
    !VIDEO_TYPES.has(contentType) &&
    !AUDIO_TYPES.has(contentType)
  ) {
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
    // The bytes are in storage and the row is committed: the upload HAS
    // succeeded. Letting a pg-boss hiccup throw here answered the browser 500
    // for a photograph that is already saved — so the operator sees «the photo
    // did not upload», takes it again, and the receipt ends up with two
    // (round 97). A missing thumbnail is a slower list, not a lost photo, and
    // the full-size image serves either way.
    try {
      await enqueue(JOB_THUMBNAILS, { attachmentId: row.id });
    } catch (err) {
      logger.warn({ err, attachmentId: row.id }, 'thumbnail job not queued; the photo is saved');
    }
  }
  return { id: row!.id };
}

/**
 * Remove an attachment whose owner has ALREADY decided it may go.
 *
 * `deleteAttachment` below answers a different question — «may this person
 * delete this file» — with a rule minted for receipt photographs (the uploader
 * or `receipts.edit`). A note's parts are governed by the NOTE's ownership, so
 * the notes service asks its own question and then calls this, which knows the
 * one thing worth having in a single place: a row and three storage keys go
 * together. No permission check, no audit: both belong to the caller that
 * decided.
 *
 * Never inside a transaction — every call here is on the pool and two of them
 * are network I/O to the object store (#714).
 */
export async function purgeAttachment(id: string): Promise<void> {
  const attachment = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!attachment) return;
  await db.delete(attachments).where(eq(attachments.id, id));
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
