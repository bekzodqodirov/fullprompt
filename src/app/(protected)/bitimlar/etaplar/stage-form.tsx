'use client';

import { useActionState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteDealStageAction,
  reorderDealStagesAction,
  saveDealStageAction,
  type DealFormState,
} from '../actions';
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
 * Reorder and remove (round 30) — the lead editor's StageTools, on the deal
 * funnel. Order is load-bearing twice here: the board's columns AND the
 * cargo engine's forward-only rule both read `sort_order`.
 */
export function DealStageTools({
  stages,
  usage,
}: {
  stages: DealStageRow[];
  usage: Record<string, number>;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();

  const move = (index: number, delta: number) => {
    const next = [...stages];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    start(async () => {
      await reorderDealStagesAction(next.map((stage) => stage.id));
    });
  };

  return (
    <div className="space-y-1">
      {stages.map((stage, index) => (
        <div
          key={stage.id}
          className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${stageClass(
            stage.color,
          )}`}
        >
          <span className="min-w-0 flex-1 truncate font-semibold">{stage.name}</span>
          <span className="text-xs opacity-70">{usage[stage.id] ?? 0}</span>
          <button
            type="button"
            aria-label={t('up')}
            disabled={pending || index === 0}
            onClick={() => move(index, -1)}
            className="px-1.5 disabled:opacity-30"
          >
            ▲
          </button>
          <button
            type="button"
            aria-label={t('down')}
            disabled={pending || index === stages.length - 1}
            onClick={() => move(index, 1)}
            className="px-1.5 disabled:opacity-30"
          >
            ▼
          </button>
          <button
            type="button"
            data-testid="delete-deal-stage"
            disabled={pending || stages.length < 2}
            onClick={() => {
              // Deals in the stage have to go somewhere; the operator picks.
              const others = stages.filter((other) => other.id !== stage.id);
              const target = window.prompt(
                `${t('moveTo')}:\n${others.map((other, i) => `${i + 1}. ${other.name}`).join('\n')}`,
                '1',
              );
              const picked = Number(target) - 1;
              if (!others[picked]) return;
              start(async () => {
                await deleteDealStageAction(stage.id, others[picked]!.id);
              });
            }}
            className="px-1.5 text-bad disabled:opacity-30"
            title={tc('delete')}
          >
            ✖
          </button>
        </div>
      ))}
    </div>
  );
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
          <option value="handed_partial">{td('triggerHandedPartial')}</option>
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
