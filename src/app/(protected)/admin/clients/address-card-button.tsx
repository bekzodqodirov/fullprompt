'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { resendAddressCardAction } from './address-card-actions';

/**
 * The client card's «📨 Manzil xabarini menga yuborish» (0151). The answer is
 * a sentence under the button in every case — the person pressed to get a
 * message in Telegram, and «it went nowhere» must not look like «it went».
 *
 * `flash` is where the full client form's mint sent the card (the form
 * redirects here, so its own state is gone): said once, above the button.
 */
export function AddressCardButton({
  clientId,
  flash,
}: {
  clientId: string;
  flash: 'presser' | 'nobody' | null;
}) {
  const t = useTranslations('clients');
  const tq = useTranslations('quick');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  // A literal map — the i18n fence cannot see a key built at runtime (#163).
  const words: Record<string, string> = {
    queued: t('addressResent'),
    no_chat: t('addressNoChat'),
    failed: t('addressFailed'),
    forbidden: t('addressFailed'),
  };

  async function press() {
    setBusy(true);
    setSaid(null);
    try {
      const res = await resendAddressCardAction(clientId);
      setSaid(words[res.outcome] ?? words.failed!);
    } catch {
      setSaid(words.failed!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-2" data-testid="address-card">
      <h2 className="text-lg font-bold">📨 {t('addressTitle')}</h2>
      <p className="text-xs text-ink-500">{t('addressHint')}</p>
      {flash === 'presser' && (
        <p className="text-sm text-ink-700" data-testid="address-card-flash">
          {tq('addressPresser')}
        </p>
      )}
      {flash === 'nobody' && (
        <p className="text-sm text-warn" data-testid="address-card-flash">
          ⚠ {tq('addressNobody')}
        </p>
      )}
      <button
        type="button"
        data-testid="address-card-resend"
        disabled={busy}
        onClick={() => void press()}
        className="btn-secondary w-full disabled:opacity-60"
      >
        {busy ? '…' : t('addressResend')}
      </button>
      {said && (
        <p role="status" className="text-sm" data-testid="address-card-said">
          {said}
        </p>
      )}
    </section>
  );
}
