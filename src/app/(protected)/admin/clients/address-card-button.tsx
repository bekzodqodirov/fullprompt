'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { resendAddressCardAction } from './address-card-actions';
import type { AddressFlash } from './address-flash';

/**
 * The client card's «📨 Manzil xabarini menga yuborish» (0151). The answer is
 * a sentence under the button in every case — the person pressed to get a
 * message in Telegram, and «it went nowhere» must not look like «it went».
 *
 * `flash` is where the full client form's mint sent the card (the form
 * redirects here, so its own state is gone): said above the button until the
 * button itself answers — after a resend the old «went nowhere» would stand
 * over «✅ Yuborildi» and contradict it (review CUST-7).
 */
export function AddressCardButton({ clientId, flash }: { clientId: string; flash: AddressFlash | null }) {
  const t = useTranslations('clients');
  const tq = useTranslations('quick');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  // Literal maps — the i18n fence cannot see a key built at runtime (#163).
  const words: Record<string, string> = {
    queued: t('addressResent'),
    no_chat: t('addressNoChat'),
    failed: t('addressFailed'),
    inactive: t('addressInactive'),
    forbidden: t('addressFailed'),
  };
  // The full form names the SELLER (the presser picked somebody, or is an
  // admin minting for one) — the won dialog's words, one vocabulary.
  const flashes: Record<AddressFlash, string> = {
    presser: `📨 ${tq('addressPresser')}`,
    muted: `⚠ ${tq('addressMuted')}`,
    nobody: `⚠ ${tq('addressNobody')}`,
    failed: `⚠ ${tq('addressFailed')}`,
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
      {flash && said === null && (
        <p className={`text-sm ${flash === 'presser' ? 'text-ink-700' : 'text-warn'}`} data-testid="address-card-flash">
          {flashes[flash]}
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
