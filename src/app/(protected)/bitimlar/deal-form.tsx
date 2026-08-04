'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createDealAction, updateDealAction, type DealFormState } from './actions';

export interface DealStageOption {
  id: string;
  name: string;
}

export interface DealInitial {
  clientId: string;
  stageId?: string | null;
  ownerId: string | null;
  title: string | null;
  quotedVolumeM3: string | null;
  quotedWeightKg: string | null;
  quotedAmount: string | null;
  quotedCurrency: string | null;
  note: string | null;
}

/**
 * The quote, typed in by a person.
 *
 * The reality half of the card has no form on purpose: it is summed from the
 * receipts, and giving anyone a box to type it into would make the comparison
 * meaningless the first time somebody "corrected" it.
 *
 * Sizes are optional. A deal often starts as "price this for me" with nothing
 * but a client and a note, and forcing a cubic metre out of a salesperson who
 * does not have one yet produces a made-up number that the alert then compares
 * against.
 */
export function DealForm({
  dealId,
  stages,
  managers,
  initial,
}: {
  dealId?: string;
  stages: DealStageOption[];
  managers: { id: string; fullName: string }[];
  initial: DealInitial;
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const action = dealId ? updateDealAction.bind(null, dealId) : createDealAction;
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-3" data-testid="deal-form">
      <input type="hidden" name="clientId" value={initial.clientId} />

      <label className="block">
        <span className="label">{t('dealTitle')}</span>
        <input
          name="title"
          defaultValue={initial.title ?? ''}
          data-testid="deal-title"
          className="input"
          placeholder={t('dealTitle')}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">{t('volume')}</span>
          <input
            name="quotedVolumeM3"
            data-testid="deal-volume"
            inputMode="decimal"
            defaultValue={initial.quotedVolumeM3 ?? ''}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">{t('weight')}</span>
          <input
            name="quotedWeightKg"
            data-testid="deal-weight"
            inputMode="decimal"
            defaultValue={initial.quotedWeightKg ?? ''}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">{t('amount')}</span>
          <input
            name="quotedAmount"
            data-testid="deal-amount"
            inputMode="decimal"
            defaultValue={initial.quotedAmount ?? ''}
            className="input"
          />
        </label>
        <label className="block">
          <span className="label">{t('currency')}</span>
          <select
            name="quotedCurrency"
            defaultValue={initial.quotedCurrency ?? 'USD'}
            className="input"
          >
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
            <option value="UZS">UZS</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {dealId && (
          <label className="block">
            <span className="label">{t('stage')}</span>
            <select name="stageId" defaultValue={initial.stageId ?? ''} className="input">
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="label">{t('owner')}</span>
          <select name="ownerId" defaultValue={initial.ownerId ?? ''} className="input">
            <option value="">—</option>
            {managers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="label">{t('note')}</span>
        <textarea name="note" defaultValue={initial.note ?? ''} rows={2} className="input" />
      </label>

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}

      <button type="submit" disabled={pending} data-testid="save-deal" className="btn-primary w-full">
        {pending ? tc('loading') : state.ok ? '✅' : t('save')}
      </button>
    </form>
  );
}
