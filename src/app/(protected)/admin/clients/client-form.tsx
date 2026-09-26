'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { ClientFormState } from './actions';

export interface ClientFormValues {
  clientCode: string;
  name: string;
  phones: string;
  salesManagerId: string;
  messengerNote: string;
  notes: string;
  birthday: string;
  sector: string;
  /** Comma-separated on the form, an array in the database. */
  cargoKinds: string;
}

export function ClientForm({
  action,
  initial,
  managers,
  codePrefix,
  tagOptions = { sectors: [], cargoKinds: [] },
}: {
  action: (prev: ClientFormState, formData: FormData) => Promise<ClientFormState>;
  initial?: ClientFormValues;
  managers: { id: string; fullName: string }[];
  codePrefix: string;
  /** The words already in use, offered back so they converge (0109). */
  tagOptions?: { sectors: string[]; cargoKinds: string[] };
}) {
  const t = useTranslations('clients');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<ClientFormState, FormData>(action, {});

  return (
    <form action={formAction} className="card max-w-lg space-y-4">
      <div>
        <label className="label" htmlFor="clientCode">
          {t('code')}
        </label>
        <input
          id="clientCode"
          name="clientCode"
          className="input font-mono uppercase"
          defaultValue={initial?.clientCode}
          placeholder={initial ? `${codePrefix}777` : t('codeAutoPlaceholder', { prefix: codePrefix })}
          required={Boolean(initial)}
        />
        {!initial && <p className="mt-1 text-xs text-ink-500">{t('codeAutoHint')}</p>}
      </div>
      <div>
        <label className="label" htmlFor="name">
          {t('name')}
        </label>
        <input id="name" name="name" className="input" defaultValue={initial?.name} required />
      </div>
      <div>
        <label className="label" htmlFor="phones">
          {t('phones')}
        </label>
        <input
          id="phones"
          name="phones"
          className="input"
          defaultValue={initial?.phones}
          placeholder={t('phonesHint')}
          inputMode="tel"
        />
      </div>
      <div>
        <label className="label" htmlFor="salesManagerId">
          {t('salesManager')}
        </label>
        <select
          id="salesManagerId"
          name="salesManagerId"
          className="input"
          defaultValue={initial?.salesManagerId ?? ''}
        >
          <option value="">{t('noManager')}</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.fullName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="messengerNote">
          {t('messengerNote')}
        </label>
        <input
          id="messengerNote"
          name="messengerNote"
          className="input"
          defaultValue={initial?.messengerNote}
        />
      </div>
      {/* His item 6 (0109): who to congratulate and who to send which offer.
          The birthday is the contact person's; the two lists are free words,
          suggested from what is already typed so they converge. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="birthday">
            🎂 {t('birthday')}
          </label>
          <input
            id="birthday"
            name="birthday"
            type="date"
            className="input"
            defaultValue={initial?.birthday}
            data-testid="client-birthday"
          />
        </div>
        <div>
          <label className="label" htmlFor="sector">
            {t('sector')}
          </label>
          <input
            id="sector"
            name="sector"
            className="input"
            list="client-sectors"
            defaultValue={initial?.sector}
            placeholder={t('sectorPlaceholder')}
            data-testid="client-sector"
          />
          <datalist id="client-sectors">
            {tagOptions.sectors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="cargoKinds">
          {t('cargoKinds')}
        </label>
        <input
          id="cargoKinds"
          name="cargoKinds"
          className="input"
          defaultValue={initial?.cargoKinds}
          placeholder={t('cargoKindsPlaceholder')}
          data-testid="client-cargo-kinds"
        />
        {tagOptions.cargoKinds.length > 0 && (
          <p className="mt-1 text-xs text-ink-500">
            {t('cargoKindsKnown')}: {tagOptions.cargoKinds.slice(0, 20).join(', ')}
          </p>
        )}
      </div>
      <div>
        <label className="label" htmlFor="notes">
          {t('notes')}
        </label>
        <textarea id="notes" name="notes" className="input py-2" rows={3} defaultValue={initial?.notes} />
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {state.error === 'code_exists' && t('codeExists')}
          {state.error === 'code_format' &&
            t('codeFormat', { prefix: codePrefix, example: `${codePrefix}777` })}
          {state.error === 'validation' && tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {tc('save')}
      </button>
    </form>
  );
}
