'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { openStaffPartnerAction } from '../actions';

/**
 * «Hodim kontragentini ochish» — one press on an own-pocket report whose
 * reporter has no staff account yet (owner M1a). The account is what the
 * expense's payer must name for «Kiritish» to book a debt to the person
 * instead of cash out of a kassa; after the press the page re-renders the same
 * report with that account already chosen. A refusal is said in words, never
 * a silent grey button.
 */
export function OpenStaffPartnerButton({ requestId }: { requestId: string }) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Literal map — the i18n tripwire cannot see a key built at runtime.
  const errors: Record<string, string> = {
    user_linked_elsewhere: t('staffPartnerLinkedElsewhere'),
    forbidden: tc('error'),
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 p-2 text-xs">
      <span className="font-semibold">{t('staffPartnerMissing')}</span>
      <button
        type="button"
        data-testid="open-staff-partner"
        className="btn-secondary !min-h-9"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await openStaffPartnerAction(requestId);
            if (result.error) {
              setError(errors[result.error] ?? tc('error'));
              return;
            }
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        👤 {t('staffPartnerOpen')}
      </button>
      {error && <span className="w-full font-semibold text-bad">{error}</span>}
    </div>
  );
}
