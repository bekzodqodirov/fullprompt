'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { v4 as uuidv4 } from 'uuid';
import imageCompression from 'browser-image-compression';
import { returnToSenderAction } from './actions';

/**
 * Unclaimed resolution — return to sender (spec 6.7): who took the cargo
 * (name + phone mandatory), note + photo optional.
 */
export function ReturnToSender({ receiptId }: { receiptId: string }) {
  const t = useTranslations('receipts');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [handoverId] = useState(() => uuidv4());
  const [personName, setPersonName] = useState('');
  const [personPhone, setPersonPhone] = useState('');
  const [note, setNote] = useState('');
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addPhoto(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.3,
        maxWidthOrHeight: 1600,
        useWebWorker: true,
      });
      const formData = new FormData();
      formData.set('file', new File([compressed], file.name || 'handover.jpg', { type: compressed.type || 'image/jpeg' }));
      formData.set('entityType', 'handover');
      formData.set('entityId', handoverId);
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
      if (res.ok) setPhotoId(((await res.json()) as { id: string }).id);
      else setError(tc('error'));
    } catch {
      setError(tc('error'));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await returnToSenderAction({ handoverId, receiptId, personName, personPhone, note });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary w-full" onClick={() => setOpen(true)}>
        ↩️ {t('returnToSender')}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3">
      <p className="text-sm font-semibold">{t('returnToSenderHint')}</p>
      <input
        data-testid="handover-name"
        className="input"
        placeholder={t('personName')}
        value={personName}
        onChange={(e) => setPersonName(e.target.value)}
      />
      <input
        data-testid="handover-phone"
        className="input"
        inputMode="tel"
        placeholder={t('personPhone')}
        value={personPhone}
        onChange={(e) => setPersonPhone(e.target.value)}
      />
      <input
        className="input"
        placeholder={`📝 ${t('note')}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <label className={`btn-secondary flex w-full cursor-pointer items-center justify-center gap-2 ${uploading ? 'opacity-60' : ''}`}>
        {uploading ? '…' : photoId ? '✅ 📷' : '📷'} {t('handoverPhoto')}
        <input type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading} onChange={(e) => addPhoto(e.target.files)} />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="handover-confirm"
          className="btn-danger flex-1 disabled:opacity-50"
          disabled={pending || personName.trim().length < 2 || personPhone.trim().length < 5}
          onClick={submit}
        >
          {pending ? tc('loading') : `↩️ ${t('returnToSender')}`}
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-bad">{error}</p>}
    </div>
  );
}
