'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteImportBatchAction } from './actions';

/** The service decides whether it may go; a refusal is printed, not hidden. */
export function DeleteBatchButton({ batchId }: { batchId: string }) {
  const t = useTranslations('customsImport');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className="btn-secondary !min-h-8 text-bad"
        disabled={pending}
        data-testid="import-delete"
        onClick={() => {
          if (!window.confirm(t('deleteConfirm'))) return;
          startTransition(async () => {
            const res = await deleteImportBatchAction(batchId);
            setError(res.error ?? null);
          });
        }}
      >
        🗑 {tc('delete')}
      </button>
      {error ? <span className="chip chip-warn">{error}</span> : null}
    </span>
  );
}
