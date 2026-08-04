'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { setCustomsFirmAction } from '../batch-actions-server';

/**
 * Who cleared this truck through customs (owner, round 39).
 *
 * Usually one firm per batch — sometimes ours, sometimes another we use — and
 * its bill lands on that firm's account. The third case is the one worth a
 * checkbox of its own: the CLIENT clears their own cargo through their own
 * firm, and then no cost of ours exists at all. Recording that is not
 * bookkeeping, it is the answer to "why has this truck no customs cost".
 */
export function CustomsFirm({
  batchId,
  partnerId,
  byClient,
  partners,
  canEdit,
}: {
  batchId: string;
  partnerId: string | null;
  byClient: boolean;
  partners: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [value, setValue] = useState(byClient ? 'client' : (partnerId ?? ''));
  const [pending, startTransition] = useTransition();

  const current = partners.find((p) => p.id === partnerId);

  if (!canEdit) {
    return (
      <p className="text-sm">
        <span className="text-ink-500">{t('customsFirm')}: </span>
        {byClient ? t('customsByClient') : (current?.name ?? '—')}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <label className="label" htmlFor="customs-firm">
        {t('customsFirm')}
      </label>
      <select
        id="customs-firm"
        className="input"
        data-testid="batch-customs-firm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">—</option>
        {partners.map((partner) => (
          <option key={partner.id} value={partner.id}>
            {partner.name}
          </option>
        ))}
        <option value="client">{t('customsByClient')}</option>
      </select>
      {/* The button turns up only once the answer has been changed: the whole
          row belongs to the name of the firm, which is what has to be read
          back at a glance on a phone. */}
      {value !== (byClient ? 'client' : (partnerId ?? '')) && (
        <button
          type="button"
          className="btn-primary w-full"
          data-testid="batch-customs-save"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await setCustomsFirmAction(batchId, value);
              router.refresh();
            })
          }
        >
          {pending ? tc('loading') : tc('save')}
        </button>
      )}
      {partnerId && !byClient && (
        <Link
          href={`/kontragentlar/${partnerId}`}
          className="text-xs font-semibold text-brand-700 underline"
        >
          {t('customsFirmAccount')}
        </Link>
      )}
    </div>
  );
}
