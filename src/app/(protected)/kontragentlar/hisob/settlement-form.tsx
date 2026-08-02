'use client';

import { useActionState, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AttachmentsPanel } from '@/components/attachments-panel';
import { recordSettlementAction, type PartnerFormState } from '../actions';

/**
 * Uch tomonlama hisob — the client paid our supplier instead of paying us.
 *
 * The two amounts are separate fields, and that is the whole point. The
 * client sends what they send; the firm then says at what rate it counted it
 * and how much of our debt it closed (owner). Averaging those into one number
 * would be inventing a rate, so the form asks for both and prints the gap.
 *
 * Proof is required before saving: a file or a written note. The file is
 * uploaded against a uuid minted here, before the entry exists — the same
 * pre-binding the receiving wizard uses for lot photos (#180) — so the
 * receipt photo is already in storage by the time the row is written.
 */
export function SettlementForm({
  clients,
  partners,
  currencies,
}: {
  clients: { id: string; clientCode: string; name: string }[];
  partners: { id: string; name: string; typeName: string }[];
  currencies: string[];
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  // One id per form instance: a second settlement gets a fresh page.
  const txId = useMemo(() => crypto.randomUUID(), []);
  const [note, setNote] = useState('');
  const [fileCount, setFileCount] = useState(0);
  // Controlled, like the note: React resets an uncontrolled form when its
  // action returns, so a refused save (missing proof, missing rate) used to
  // eat both typed amounts — the two numbers this screen exists to capture.
  const [clientAmount, setClientAmount] = useState('');
  const [partnerAmount, setPartnerAmount] = useState('');
  const [state, formAction, pending] = useActionState<PartnerFormState, FormData>(
    recordSettlementAction,
    {},
  );

  const hasProof = fileCount > 0 || note.trim().length > 0;

  if (state.ok) {
    return (
      <div className="card space-y-2">
        <p className="text-lg font-bold text-good">✅ {t('settlementSaved')}</p>
        <p className="text-sm text-ink-700">
          {t('rateGap')}:{' '}
          <span className="num font-bold">
            {(state.differenceUsd ?? 0) > 0 ? '+' : ''}
            {(state.differenceUsd ?? 0).toFixed(2)} $
          </span>
        </p>
        <p className="text-xs text-ink-500">{t('rateGapHint')}</p>
        {/* A full reload on purpose: the next settlement needs a fresh
            minted id, and router.refresh() would keep this one. */}
        <button
          type="button"
          className="btn-secondary w-full"
          onClick={() => window.location.reload()}
        >
          ➕ {t('settlement')}
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-3">
      <input type="hidden" name="txId" value={txId} />

      <div>
        <label className="label" htmlFor="s-client">
          {t('whoPaid')}
        </label>
        <select
          id="s-client"
          name="clientId"
          className="input"
          data-testid="settle-client"
          required
        >
          <option value="">—</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.clientCode} — {client.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="s-partner">
          {t('paidTo')}
        </label>
        <select
          id="s-partner"
          name="partnerId"
          className="input"
          data-testid="settle-partner"
          required
        >
          <option value="">—</option>
          {partners.map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name} ({partner.typeName})
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-line p-2">
        <p className="label">{t('clientSent')}</p>
        <div className="flex gap-2">
          <input
            name="clientAmount"
            className="input min-w-0 flex-1 !py-3 text-right font-mono text-2xl font-extrabold"
            inputMode="decimal"
            aria-label={t('clientSent')}
            data-testid="settle-client-amount"
            value={clientAmount}
            onChange={(event) => setClientAmount(event.target.value)}
            required
          />
          <select name="clientCurrency" className="input !w-24 shrink-0 font-bold" aria-label={t('currency')}>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-line p-2">
        <p className="label">{t('firmCredited')}</p>
        <div className="flex gap-2">
          <input
            name="partnerAmount"
            className="input min-w-0 flex-1 !py-3 text-right font-mono text-2xl font-extrabold"
            inputMode="decimal"
            aria-label={t('firmCredited')}
            data-testid="settle-partner-amount"
            value={partnerAmount}
            onChange={(event) => setPartnerAmount(event.target.value)}
            required
          />
          <select name="partnerCurrency" className="input !w-24 shrink-0 font-bold" aria-label={t('currency')}>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-ink-500">{t('firmCreditedHint')}</p>
      </div>

      <input
        type="date"
        name="txDate"
        className="input"
        aria-label={t('date')}
        data-testid="settle-date"
        defaultValue={new Date().toISOString().slice(0, 10)}
        required
      />

      <div>
        <p className="label">{t('proof')}</p>
        <AttachmentsPanel
          entityType="partner_transaction"
          entityId={txId}
          initial={[]}
          editable
          onAdd={() => setFileCount((n) => n + 1)}
          // Both halves. Counting uploads only left the gate open after the
          // photo was deleted again, and the server then refused what this
          // screen had just called ready.
          onRemove={() => setFileCount((n) => Math.max(0, n - 1))}
        />
      </div>

      <textarea
        name="note"
        className="input"
        rows={2}
        placeholder={t('proofNote')}
        aria-label={t('proofNote')}
        data-testid="settle-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {!hasProof && <p className="text-xs font-semibold text-warn">⚠️ {t('proofRequired')}</p>}

      <button
        type="submit"
        className="btn-primary w-full disabled:opacity-50"
        data-testid="settle-save"
        disabled={pending || !hasProof}
      >
        {pending ? tc('loading') : `🔁 ${tc('save')}`}
      </button>
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'proof_required'
            ? t('proofRequired')
            : state.error === 'fx_missing'
              ? t('fxMissing')
              : tc('error')}
        </p>
      )}
    </form>
  );
}
