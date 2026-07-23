'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { recordVerdictAction } from '../actions';

/** The logist relays the agent's answer (agent has no system access). */
export function VerdictForm({ versionId }: { versionId: string }) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(verdict: 'approved' | 'changes_requested') {
    setPending(true);
    setError(null);
    try {
      const res = await recordVerdictAction({ versionId, verdict, comment });
      if (res.ok) {
        if (res.batchId) router.push(`/batches/${res.batchId}`);
        else router.refresh();
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3">
      <p className="text-sm font-semibold">{t('verdictHint')}</p>
      <input
        data-testid="verdict-comment"
        className="input"
        placeholder={`💬 ${t('agentComment')}`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="verdict-approve"
          className="btn-primary flex-1 disabled:opacity-50"
          disabled={pending}
          onClick={() => submit('approved')}
        >
          ✅ {t('agentApproved')}
        </button>
        <button
          type="button"
          data-testid="verdict-changes"
          className="btn-danger flex-1 disabled:opacity-50"
          disabled={pending}
          onClick={() => submit('changes_requested')}
        >
          ✏️ {t('agentChanges')}
        </button>
      </div>
      {pending && <p className="text-sm">{tc('loading')}</p>}
      {error && <p className="text-sm font-semibold text-red-700">{error}</p>}
    </div>
  );
}
