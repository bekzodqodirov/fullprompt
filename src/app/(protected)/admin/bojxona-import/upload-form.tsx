'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * The upload, posting to a ROUTE HANDLER (#291 — his file is far past a
 * server action's 1 MB body). The answer is a batch id and a queued job;
 * the row below turns into a live counter as the parser works.
 */
export function ImportUploadForm() {
  const t = useTranslations('customsImport');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        setDone(false);
        void (async () => {
          try {
            const res = await fetch('/api/admin/customs-import', { method: 'POST', body: form });
            const data = (await res.json()) as { ok?: boolean; error?: string };
            if (!res.ok || data.error) {
              setError(data.error ?? 'failed');
            } else {
              setDone(true);
              router.refresh();
            }
          } catch {
            setError('network');
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <label className="text-2xs">
        <span className="label">{t('file')}</span>
        <input
          className="input input-sm"
          type="file"
          name="file"
          accept=".xlsx,.csv"
          required
          data-testid="import-file"
        />
      </label>
      <button type="submit" className="btn-primary" disabled={pending} data-testid="import-upload">
        {pending ? t('uploading') : t('upload')}
      </button>
      {done ? (
        <span className="chip chip-good" data-testid="import-queued">
          {t('queued')}
        </span>
      ) : null}
      {error ? (
        <span className="chip chip-warn" data-testid="import-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_xlsx') : error}
        </span>
      ) : null}
    </form>
  );
}
