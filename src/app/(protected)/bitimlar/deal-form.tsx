'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { LoadModeField } from '@/components/load-mode-field';
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
  quoteLocked,
  quoteCalcHref,
  load,
}: {
  dealId?: string;
  stages: DealStageOption[];
  managers: { id: string; fullName: string }[];
  initial: DealInitial;
  /** A sealed VED calculation stands on this deal — the quote is not editable. */
  quoteLocked?: boolean;
  /** The job that wrote the locked number, for the VED (null for everyone else). */
  quoteCalcHref?: string | null;
  /** LTL / FTL (0135): the stored mode and whether the viewer is the office; null = server behind. */
  load?: { initial: 'ltl' | 'ftl'; office: boolean; creating?: boolean } | null;
  /**
   * The row's own `updated_at`, keying ONLY the inputs the card can also
   * write. Keying the whole form would remount it after every save and take
   * `useActionState` — and with it the ✅ — along with the stale values.
   */
}) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const tf = useTranslations('ftl');
  const tcalc = useTranslations('calc');
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

      {/* A sealed VED price is what the client was told, so this form does
          not get a box for it (docs/VED.md law 2). The values are RE-POSTED
          as hidden inputs rather than left out: this is a replace-all form,
          and a field that renders nothing and posts nothing reads as «clear
          it» (#171). `updateDeal` refuses a changed quote in any case. */}
      {quoteLocked ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="deal-quote-locked">
          <span className="label">{t('amount')}</span>
          <span className="font-mono tabular-nums font-semibold">
            {initial.quotedAmount} {initial.quotedCurrency ?? 'USD'}
          </span>
          <span className="chip chip-neutral">🔒</span>
          {quoteCalcHref ? (
            <a href={quoteCalcHref} className="font-semibold text-brand-700" data-testid="deal-quote-locked-calc">
              {tcalc('openCalc')}
            </a>
          ) : null}
          <input type="hidden" name="quotedAmount" value={initial.quotedAmount ?? ''} />
          <input type="hidden" name="quotedCurrency" value={initial.quotedCurrency ?? 'USD'} />
          <input type="hidden" name="quotedVolumeM3" value={initial.quotedVolumeM3 ?? ''} />
          <input type="hidden" name="quotedWeightKg" value={initial.quotedWeightKg ?? ''} />
        </div>
      ) : (
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
      )}

      {/* LTL / FTL (0135) — outside the lock above: a sealed price does not lock the mode. */}
      <LoadModeField key={`load-${load?.initial ?? 'none'}`} load={load ?? null} />

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
        <textarea
          name="note"
          defaultValue={initial.note ?? ''}
          rows={2}
          className="input"
        />
      </label>

      {state.ok && state.ftlChanged !== undefined ? (
        <div className="text-2xs text-ink-600" data-testid="deal-ftl-cascade">
          {state.ftlChanged > 0 ? <p>{tf('cascadeChanged', { n: state.ftlChanged })}</p> : null}
          {(state.ftlSkipped ?? []).map((skip, index) => (
            <p key={`${skip.number}-${index}`} className="text-warn">
              {tf('cascadeSkipped', { number: skip.number ?? '—', why: tf(`skip.${skip.why}` as 'skip.hand') })}
            </p>
          ))}
        </div>
      ) : null}
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
