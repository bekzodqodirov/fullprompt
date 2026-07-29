'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveDealStageAction, type DealFormState } from '../actions';
import { STAGE_CLASS, stageClass } from '../../crm/stage-color';

const COLORS = Object.keys(STAGE_CLASS);

export interface DealStageRow {
  id: string;
  name: string;
  kind: string;
  color: string;
  sortOrder: number;
  active: boolean;
  cargoTrigger: string | null;
}

function Feedback({ state }: { state: DealFormState }) {
  const t = useTranslations('crm');
  const td = useTranslations('deals');
  const tc = useTranslations('common');
  if (state.ok) return <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>;
  if (!state.error) return null;
  const message =
    state.error === 'needs_won'
      ? t('needsWon')
      : state.error === 'needs_open'
        ? t('needsOpen')
        : state.error === 'trigger_on_lost'
          ? td('triggerOnLost')
          : tc('error');
  return <p className="text-sm font-semibold text-bad">{message}</p>;
}

/**
 * Add or edit one deal-funnel stage — the lead editor's form plus the one
 * thing a DEAL stage can do that a lead stage cannot: name the cargo state
 * that pulls a deal into it by itself (round 26, owner's item 6).
 */
export function DealStageForm({ stage }: { stage?: DealStageRow }) {
  const t = useTranslations('crm');
  const td = useTranslations('deals');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(
    saveDealStageAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-2 border-t border-line pt-2 first:border-0">
      {stage && <input type="hidden" name="id" value={stage.id} />}
      <div className="flex flex-wrap gap-2">
        <input
          name="name"
          defaultValue={stage?.name}
          placeholder={t('stage')}
          aria-label={t('stage')}
          data-testid="deal-stage-name"
          className="input min-w-40 flex-1"
          required
        />
        <select name="kind" defaultValue={stage?.kind ?? 'open'} aria-label={t('kind')} className="input !w-36">
          <option value="open">{t('kindOpen')}</option>
          <option value="won">{t('kindWon')}</option>
          <option value="lost">{t('kindLost')}</option>
        </select>
        <select
          name="color"
          defaultValue={stage?.color ?? 'gray'}
          aria-label={t('color')}
          className={`input !w-28 ${stageClass(stage?.color ?? 'gray')}`}
        >
          {COLORS.map((color) => (
            <option key={color} value={color}>
              {color}
            </option>
          ))}
        </select>
        <input
          name="sortOrder"
          type="number"
          defaultValue={stage?.sortOrder ?? 100}
          aria-label="#"
          className="input !w-20"
        />
        <label className="flex items-center gap-1 self-center text-sm">
          <input type="hidden" name="active" value="off" />
          <input
            type="checkbox"
            name="active"
            value="on"
            defaultChecked={stage ? stage.active : true}
            className="h-4 w-4"
          />
          {tc('active')}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-semibold text-ink-500" htmlFor={`trigger-${stage?.id ?? 'new'}`}>
          🚚 {td('cargoTrigger')}
        </label>
        <select
          id={`trigger-${stage?.id ?? 'new'}`}
          name="cargoTrigger"
          defaultValue={stage?.cargoTrigger ?? ''}
          data-testid="deal-stage-trigger"
          className="input !w-auto min-w-48 flex-1"
        >
          <option value="">{td('triggerNone')}</option>
          <option value="received">{td('triggerReceived')}</option>
          <option value="departed">{td('triggerDeparted')}</option>
          <option value="arrived">{td('triggerArrived')}</option>
          <option value="ready">{td('triggerReady')}</option>
          <option value="handed">{td('triggerHanded')}</option>
        </select>
        <button
          type="submit"
          data-testid={stage ? 'update-deal-stage' : 'save-deal-stage'}
          className={stage ? 'btn-secondary' : 'btn-primary'}
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
