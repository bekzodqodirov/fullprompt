'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { CompressOptions } from '@/components/compress-photo';
import { LightboxImg } from '@/components/lightbox-img';
import { uploadAttachmentFile } from '@/components/upload-attachment';

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
  attachable = editable,
  photo,
  removableIds,
  refreshWhenEmpty = false,
  onAdd,
  onRemove,
}: {
  entityType: string;
  entityId: string;
  initial: AttachmentItem[];
  /** ✕ on EVERY file — the editor's power (`receipts.edit` on the prixod card). */
  editable: boolean;
  /**
   * The 📎 tile — who may ADD a file (default: whoever may edit). Its own
   * flag since the owner's «4 b» of 2026-11-12: on the prixod card every
   * reader of a confirmed prixod may attach (`mayAttachReceiptFile`, the
   * bot's own rule) while only an editor may remove somebody else's file.
   */
  attachable?: boolean;
  /**
   * How hard a picture is shrunk before it goes — absent = every screen's
   * default; the prixod card hands `DOCUMENT_PHOTO` to a reader whose
   * pictures the server keeps as papers.
   */
  photo?: CompressOptions;
  /**
   * Files that carry a ✕ even for a reader who may not edit — their OWN
   * uploads (0146). The delete door decides again; this only draws what it
   * will allow. Anything uploaded in this session is the reader's too.
   */
  removableIds?: string[];
  /**
   * The caller draws this panel only while there is something to list or to
   * attach (the prixod card's «Fayllar», docs/PRIXOD-KARTA.md §7.1): when a
   * reader who may not ATTACH removes the last file, ask the page again, so
   * that it takes its heading away instead of leaving it over nothing.
   */
  refreshWhenEmpty?: boolean;
  /** Called after each successful upload so a caller can persist the list (e.g. into a draft). */
  onAdd?: (item: AttachmentItem) => void;
  /**
   * Called after each successful delete. A caller that GATES on "is there a
   * file" has to hear both halves or its gate goes stale: the settlement form
   * counted uploads only, so deleting the receipt photo left the save button
   * lit and the server then refused what the screen had called ready.
   */
  onRemove?: (id: string) => void;
}) {
  const t = useTranslations('receipts');
  const tr = useTranslations('receive');
  const router = useRouter();
  const [items, setItems] = useState(initial ?? []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<string[]>(removableIds ?? []);
  // A delete happened in THIS panel — so an empty list is something a reader
  // did, not the panel's first render.
  const [removedAny, setRemovedAny] = useState(false);
  // Nothing left and nothing to attach with: the card around this panel is a
  // heading over nothing now, so the page decides again (the delete is a plain
  // fetch above, not a server action — nothing has revalidated it). Read from
  // the list the deletes LEFT, not from the render a press closed over: two ✕
  // pressed before the first answer each saw the other file still there
  // (the merged card's review, XF-3).
  useEffect(() => {
    if (refreshWhenEmpty && !attachable && removedAny && items.length === 0) router.refresh();
  }, [refreshWhenEmpty, attachable, removedAny, items.length, router]);
  const removable = (id: string) => editable || mine.includes(id);

  async function remove(id: string) {
    setError(null);
    const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setItems((prev) => prev.filter((item) => item.id !== id));
      setRemovedAny(true);
      onRemove?.(id);
      return;
    }
    // A refusal said in words — it was silently ignored, so a file a lot's
    // composition cites (or a queued Telegram photo) just stayed put with
    // nothing on screen to say why.
    let code: string | undefined;
    try {
      code = ((await res.json()) as { error?: string }).error;
    } catch {
      /* non-JSON reply — the generic sentence */
    }
    setError(code === 'in_use' ? t('attachInUse') : t('attachFailed'));
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const res = await uploadAttachmentFile(file, entityType, entityId, photo);
        if (res.ok) {
          setItems((prev) => [...prev, res.item]);
          setMine((prev) => [...prev, res.item.id]);
          onAdd?.(res.item);
        } else {
          setError(
            res.error === 'unsupported_type'
              ? tr('fileTypeUnsupported')
              : res.error === 'too_large'
                ? tr('fileTooLarge')
                : t('attachFailed'),
          );
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
              onDelete={removable(item.id) ? () => remove(item.id) : undefined}
            />
          ) : (
            <span key={item.id} className="relative inline-block">
              <a
                href={`/api/attachments/${item.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex h-16 w-16 flex-col items-center justify-center rounded-lg bg-surface-sunken p-1 text-center text-2xl"
                title={item.fileName}
              >
                📄
                <span className="max-w-full truncate text-[10px] text-ink-700">{item.fileName}</span>
              </a>
              {removable(item.id) && (
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
        {/* min-w, not w: «Прикрепить» is 11 characters and a fixed 64px tile
            simply let it hang outside the card — over the first photo on the
            receipt screen and off the left edge of the batch panel. The tile
            grows to its own word instead. */}
        {attachable && (
          <label className="btn-secondary flex h-16 min-w-[4rem] cursor-pointer flex-col items-center justify-center gap-0.5 overflow-hidden !px-2 !py-1 text-xs">
            {uploading ? '…' : '📎'}
            <span className="max-w-full truncate">{t('attach')}</span>
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
      {error && <p className="text-xs font-semibold text-bad">{error}</p>}
    </div>
  );
}
