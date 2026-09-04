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
      {/* A CODE is not a sentence on the one screen whose whole purpose is to
          say what went wrong in words — «in_use» is what the admin read when
          a calculation had already taken a price from the quarter. The
          sibling upload form has always mapped it this way; an unknown code
          still prints itself rather than vanishing. */}
      {error ? (
        <span className="chip chip-warn">
          {t.has(`errors.${error}`) ? t(`errors.${error}`) : error}
        </span>
      ) : null}
    </span>
  );
}
