'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { CrmFormState } from '../actions';

interface Option {
  id: string;
  label: string;
}

/**
 * The lead card's own fields, plus whatever the owner added.
 *
 * `children` is where the custom inputs land — they are rendered on the
 * server (the field definitions come from the database) and slotted in here,
 * so one submit carries both halves of the card.
 */
export function LeadForm({
  action,
  sources,
  stages,
  owners,
  initial,
  revision,
  children,
}: {
  action: (state: CrmFormState, formData: FormData) => Promise<CrmFormState>;
  sources: Option[];
  stages: Option[];
  owners: Option[];
  /**
   * The row's own `updated_at`, keying ONLY the four inputs the card's facts
   * block can also write. Keying the whole form would remount it after every
   * save and take `useActionState` — and with it the ✅ — along with it.
   */
  revision?: string;
  initial?: {
    name: string;
    phone: string;
    company: string;
    sourceId: string;
    stageId: string;
    ownerId: string;
    note: string;
    quotedAmount: string;
    quotedCurrency: string;
    quotedVolumeM3: string;
    quotedWeightKg: string;
    nextActionAt: string;
    nextActionNote: string;
  };
  children?: React.ReactNode;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(action, {});

  return (
    <form action={formAction} className="card space-y-2">
      <input
        key={`name-${revision ?? ''}`}
        name="name"
        defaultValue={initial?.name}
        placeholder={t('name')}
        aria-label={t('name')}
        data-testid="lead-name"
        className="input text-lg font-semibold"
        required
      />
      <div className="flex flex-wrap gap-2">
        <input
          key={`phone-${revision ?? ''}`}
        name="phone"
          type="tel"
          defaultValue={initial?.phone}
          placeholder={t('phone')}
          aria-label={t('phone')}
          className="input min-w-40 flex-1"
        />
        <input
          key={`company-${revision ?? ''}`}
        name="company"
          defaultValue={initial?.company}
          placeholder={t('company')}
          aria-label={t('company')}
          className="input min-w-40 flex-1"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="min-w-36 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('source')}</span>
          <select name="sourceId" defaultValue={initial?.sourceId ?? ''} className="input">
            <option value="">—</option>
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-36 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('stage')}</span>
          <select name="stageId" defaultValue={initial?.stageId ?? ''} className="input">
            {stages.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-36 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('owner')}</span>
          <select name="ownerId" defaultValue={initial?.ownerId ?? ''} className="input">
            <option value="">—</option>
            {owners.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <textarea
        key={`note-${revision ?? ''}`}
        name="note"
        defaultValue={initial?.note}
        placeholder={t('note')}
        aria-label={t('note')}
        rows={2}
        className="input"
      />

      {/* The service price, written after hisoblatish (round 71) — the number
          that rides with the lead into won/lost and, on «Bitim ochish», into
          the deal's quote. Sizes ride with it; all three are what the AI
          intake extracts, so the seller mostly confirms rather than types. */}
      <div className="flex flex-wrap gap-2">
        <label className="min-w-28 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('quotedAmount')}</span>
          <input
            type="text"
            inputMode="decimal"
            name="quotedAmount"
            defaultValue={initial?.quotedAmount}
            data-testid="lead-quote-amount"
            aria-label={t('quotedAmount')}
            className="input"
          />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('quotedCurrency')}</span>
          <select
            name="quotedCurrency"
            defaultValue={initial?.quotedCurrency || 'USD'}
            aria-label={t('quotedCurrency')}
            className="input !w-24"
          >
            {['USD', 'UZS', 'CNY'].map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-24 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('quotedVolume')}</span>
          <input
            type="text"
            inputMode="decimal"
            name="quotedVolumeM3"
            defaultValue={initial?.quotedVolumeM3}
            aria-label={t('quotedVolume')}
            className="input"
          />
        </label>
        <label className="min-w-24 flex-1 text-sm">
          <span className="block text-xs text-ink-500">{t('quotedWeight')}</span>
          <input
            type="text"
            inputMode="decimal"
            name="quotedWeightKg"
            defaultValue={initial?.quotedWeightKg}
            aria-label={t('quotedWeight')}
            className="input"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          <span className="block text-xs text-ink-500">{t('nextAction')}</span>
          <input
            type="date"
            name="nextActionAt"
            defaultValue={initial?.nextActionAt}
            className="input !w-40"
          />
        </label>
        <input
          name="nextActionNote"
          defaultValue={initial?.nextActionNote}
          placeholder={t('nextActionNote')}
          aria-label={t('nextActionNote')}
          className="input min-w-40 flex-1 self-end"
        />
      </div>

      {children}

      <button type="submit" data-testid="save-lead" className="btn-primary w-full" disabled={pending}>
        {pending ? tc('loading') : tc('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'bad_number'
            ? t('badNumber')
            : state.error === 'bad_date'
              ? t('badDate')
              : state.error === 'bad_option'
                ? t('badOption')
                : tc('error')}
        </p>
      )}
    </form>
  );
}
