import { compressPhoto } from '@/components/compress-photo';
import type { AttachmentItem } from '@/components/attachments-panel';

/**
 * One file to `/api/files/upload`, as every attachment screen sends it: a
 * photo shrunk on the phone first, anything else — an invoice, a packing
 * list — as it is. Shared by the attachments panel and the lot tarkibi
 * editor, which uploads the client's document onto the prixod it composes
 * (docs/LOT-TARKIBI.md §8) and must answer in the same words.
 */
export type UploadRefusal = 'unsupported_type' | 'too_large' | 'forbidden' | 'failed';

export async function uploadAttachmentFile(
  file: File,
  entityType: string,
  entityId: string,
): Promise<{ ok: true; item: AttachmentItem } | { ok: false; error: UploadRefusal }> {
  const isImage = file.type.startsWith('image/');
  const body = isImage ? await compressPhoto(file) : file;
  const formData = new FormData();
  formData.set('file', body);
  formData.set('entityType', entityType);
  formData.set('entityId', entityId);
  const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
  if (res.ok) {
    const { id } = (await res.json()) as { id: string };
    return { ok: true, item: { id, fileName: file.name, contentType: file.type, kind: isImage ? 'photo' : 'file' } };
  }
  try {
    const answer = (await res.json()) as { error?: string };
    if (answer.error === 'unsupported_type' || answer.error === 'too_large' || answer.error === 'forbidden') {
      return { ok: false, error: answer.error };
    }
  } catch {
    /* non-JSON reply — the generic refusal */
  }
  return { ok: false, error: 'failed' };
}
