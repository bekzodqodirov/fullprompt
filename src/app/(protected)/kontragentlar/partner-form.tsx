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
  staffUsers,
  partner,
}: {
  types: { id: string; name: string }[];
  clients: { id: string; clientCode: string; name: string }[];
  /**
   * The «Hodim» login picker (0101) — present ONLY for whoever may see staff
   * money (owner M3a, `maySeeStaffMoney`); null draws no select, and a form
   * with no select posts no `userId`, which the service reads as «unchanged»
   * rather than «nobody» (#171). Required, so no page can forget to decide.
   */
  staffUsers: { id: string; name: string }[] | null;
  /**
   * Present on the card, absent on the register. `savePartner` has had a full
   * update branch with before/after audit since the day it shipped — nothing
   * ever posted an `id` to it, so a name typed wrong, a wrong type or a wrong
   * client link was permanent and the only recourse was to retire the account
   * and start a second one, splitting its history in two.
   */
  partner?: {
    id: string;
    name: string;
    typeId: string;
    clientId: string | null;
    phone: string | null;
    note: string | null;
    userId: string | null;
  };
}) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  // Controlled, every one: a refusal (a login or a client already taken)
  // must hand back what was typed, not the defaults (#463).
  const [name, setName] = useState(partner?.name ?? '');
  const [typeId, setTypeId] = useState(partner?.typeId ?? types[0]?.id ?? '');
  const [clientId, setClientId] = useState(partner?.clientId ?? '');
  const [userId, setUserId] = useState(partner?.userId ?? '');
  const [phone, setPhone] = useState(partner?.phone ?? '');
  const [note, setNote] = useState(partner?.note ?? '');
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
    if (state.ok) {
      setOpen(false);
      // A NEW account that landed must not reopen pre-filled with itself —
      // that is the second, identical entry again. The card's edit form keeps
      // its values: they are what the account now says.
      if (!partner) {
        setName('');
        setClientId('');
        setUserId('');
        setPhone('');
        setNote('');
      }
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary w-full"
        data-testid={partner ? 'partner-edit' : 'partner-new'}
        onClick={() => setOpen(true)}
      >
        {partner ? `✏️ ${tc('edit')}` : `➕ ${t('newPartner')}`}
      </button>
    );
  }

  return (
    <form action={formAction} className="card space-y-2">
      {partner && <input type="hidden" name="id" value={partner.id} />}
      <p className="section-title">{partner ? tc('edit') : t('newPartner')}</p>
      <input
        name="name"
        className="input"
        placeholder={t('name')}
        aria-label={t('name')}
        data-testid="partner-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        minLength={2}
      />
      <select
        name="typeId"
        className="input"
        aria-label={t('type')}
        data-testid="partner-type"
        value={typeId}
        onChange={(event) => setTypeId(event.target.value)}
        required
      >
        {types.map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </select>
      <label className="label" htmlFor="partner-client">
        {t('alsoClient')}
      </label>
      {/* The empty option stays in edit mode on purpose: a link to the wrong
          client is the one mistake here that cannot be worked around. */}
      <select
        id="partner-client"
        name="clientId"
        className="input"
        data-testid="partner-client"
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
      >
        <option value="">— {t('notAClient')}</option>
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.clientCode} — {client.name}
          </option>
        ))}
      </select>
      {staffUsers && (
        <>
          <label className="label" htmlFor="partner-user">
            {t('login')}
          </label>
          {/* Linking a login is what makes this a staff account: its balance
              then shows on that person's own /profile and leaves every
              screen the VED and the logist can open. */}
          <select
            id="partner-user"
            name="userId"
            className="input"
            data-testid="partner-user"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">— {t('noLogin')}</option>
            {staffUsers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-ink-500">{t('loginHint')}</p>
        </>
      )}
      <input
        name="phone"
        className="input"
        placeholder={t('phone')}
        aria-label={t('phone')}
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      <textarea
        name="note"
        className="input"
        rows={2}
        placeholder={t('note')}
        aria-label={t('note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
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
          {state.error === 'client_taken'
            ? t('clientTaken')
            : state.error === 'user_taken'
              ? t('userTaken')
              : state.error === 'forbidden'
                ? t('staffForbidden')
                : tc('error')}
        </p>
      )}
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('save')}</p>}
    </form>
  );
}
