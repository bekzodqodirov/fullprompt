'use client';

import imageCompression from 'browser-image-compression';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { LightboxImg } from '@/components/lightbox-img';

export interface AttachmentItem {
  id: string;
  fileName: string;
  contentType: string;
  kind: string;
}

/**
 * General file/photo attachments for an entity (spec 4.8) — used for
 * receipt-level documents (invoice, packing list, any file) as opposed to
 * the per-lot box-appearance photos, which use PhotoGallery instead.
 */
export function AttachmentsPanel({
  entityType,
  entityId,
  initial,
  editable,
  onAdd,
}: {
  entityType: string;
  entityId: string;
  initial: AttachmentItem[];
  editable: boolean;
  /** Called after each successful upload so a caller can persist the list (e.g. into a draft). */
  onAdd?: (item: AttachmentItem) => void;
}) {
  const t = useTranslations('receipts');
  const tr = useTranslations('receive');
  const [items, setItems] = useState(initial ?? []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadErrorText(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'unsupported_type') return tr('fileTypeUnsupported');
      if (body.error === 'too_large') return tr('fileTooLarge');
    } catch {
      /* non-JSON reply — fall through to the generic message */
    }
    return t('attachFailed');
  }

  async function remove(id: string) {
    const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const isImage = file.type.startsWith('image/');
        const body = isImage
          ? await imageCompression(file, { maxSizeMB: 0.3, maxWidthOrHeight: 1600, useWebWorker: true })
          : file;
        const formData = new FormData();
        formData.set('file', new File([body], file.name, { type: body.type || file.type }));
        formData.set('entityType', entityType);
        formData.set('entityId', entityId);
        const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
        if (res.ok) {
          const { id } = (await res.json()) as { id: string };
          const item: AttachmentItem = {
            id,
            fileName: file.name,
            contentType: file.type,
            kind: isImage ? 'photo' : 'file',
          };
          setItems((prev) => [...prev, item]);
          onAdd?.(item);
        } else {
          setError(await uploadErrorText(res));
        }
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {items.map((item) =>
          item.kind === 'photo' ? (
            <LightboxImg
              key={item.id}
              attachmentId={item.id}
              alt={item.fileName}
              className="h-16 w-16 rounded object-cover"
              onDelete={editable ? () => remove(item.id) : undefined}
            />
          ) : (
            <span key={item.id} className="relative inline-block">
              <a
                href={`/api/attachments/${item.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex h-16 w-16 flex-col items-center justify-center rounded-lg bg-gray-100 p-1 text-center text-2xl"
                title={item.fileName}
              >
                📄
                <span className="max-w-full truncate text-[10px] text-gray-600">{item.fileName}</span>
              </a>
              {editable && (
                <button
                  type="button"
                  aria-label="✕"
                  className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-xs font-bold leading-none text-white shadow"
                  onClick={() => remove(item.id)}
                >
                  ✕
                </button>
              )}
            </span>
          ),
        )}
        {editable && (
          <label className="btn-secondary flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-0.5 !p-1 text-xs">
            {uploading ? '…' : '📎'}
            <span>{t('attach')}</span>
            <input
              type="file"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={(e) => addFiles(e.target.files)}
            />
          </label>
        )}
      </div>
      {error && <p className="text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}
