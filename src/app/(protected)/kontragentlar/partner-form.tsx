'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { savePartnerAction, type PartnerFormState } from './actions';

/**
 * A new counterparty, folded away until asked for — the list is what people
 * come to this screen to read.
 *
 * The client link is optional and deliberately prominent: one of the owner's
 * counterparties IS a client (he takes their money in advance and buys
 * services from them), and picking them here is what makes the two ledgers
 * meet on one card instead of drifting apart on two.
 */
export function PartnerForm({
  types,
  clients,
}: {
  types: { id: string; name: string }[];
  clients: { id: string; clientCode: string; name: string }[];
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<PartnerFormState, FormData>(
    savePartnerAction,
    {},
  );

  // Fold away once it has landed: leaving the form open over a saved row is
  // how a second, identical entry gets typed. Adjusted during render rather
  // than in an effect — React's own pattern for reacting to a changed value,
  // and the one the lint rule here insists on.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.ok) setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary w-full"
        data-testid="partner-new"
        onClick={() => setOpen(true)}
      >
        ➕ {t('newPartner')}
      </button>
    );
  }

  return (
    <form action={formAction} className="card space-y-2">
      <p className="section-title">{t('newPartner')}</p>
      <input
        name="name"
        className="input"
        placeholder={t('name')}
        aria-label={t('name')}
        data-testid="partner-name"
        required
        minLength={2}
      />
      <select name="typeId" className="input" aria-label={t('type')} data-testid="partner-type" required>
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </select>
      <label className="label" htmlFor="partner-client">
        {t('alsoClient')}
      </label>
      <select id="partner-client" name="clientId" className="input" data-testid="partner-client">
        <option value="">— {t('notAClient')}</option>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.clientCode} — {client.name}
          </option>
        ))}
      </select>
      <input name="phone" className="input" placeholder={t('phone')} aria-label={t('phone')} />
      <textarea
        name="note"
        className="input"
        rows={2}
        placeholder={t('note')}
        aria-label={t('note')}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn-primary flex-1"
          data-testid="partner-save"
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={() => setOpen(false)}>
          {tc('cancel')}
        </button>
      </div>
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'client_taken' ? t('clientTaken') : tc('error')}
        </p>
      )}
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('save')}</p>}
    </form>
  );
}
