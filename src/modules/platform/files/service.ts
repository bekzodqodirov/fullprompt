import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { enqueue, JOB_THUMBNAILS } from '../jobs/boss';
import { getStorage } from './storage';

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_TYPES = new Set([
  ...PHOTO_TYPES,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/msword',
]);
const MAX_SIZE_BYTES = 15 * 1024 * 1024;

export class FileValidationError extends Error {}

export async function saveAttachment(input: {
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  body: Buffer;
  uploadedBy: string;
}): Promise<{ id: string }> {
  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw new FileValidationError(`Unsupported content type: ${input.contentType}`);
  }
  if (input.body.length > MAX_SIZE_BYTES) {
    throw new FileValidationError('File too large');
  }

  const isPhoto = PHOTO_TYPES.has(input.contentType);
  const storageKey = `${input.entityType}/${input.entityId}/${randomUUID()}`;

  await getStorage().put(storageKey, input.body, input.contentType);

  const [row] = await db
    .insert(attachments)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      kind: isPhoto ? 'photo' : 'file',
      storageKey,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.body.length,
      uploadedBy: input.uploadedBy,
    })
    .returning({ id: attachments.id });

  if (isPhoto && row) {
    await enqueue(JOB_THUMBNAILS, { attachmentId: row.id });
  }
  return { id: row!.id };
}
