'use client';

import { useActionState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteFieldAction,
  deleteStageAction,
  reorderStagesAction,
  saveFieldAction,
  saveSourceAction,
  saveStageAction,
  type CrmFormState,
} from '../actions';
import { STAGE_CLASS, stageClass } from '../stage-color';

const COLORS = Object.keys(STAGE_CLASS);
const TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'phone',
  'url',
] as const;

function Feedback({ state }: { state: CrmFormState }) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  if (state.ok) return <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>;
  if (!state.error) return null;
  const message =
    state.error === 'options_required'
      ? t('optionsRequired')
      : state.error === 'type_locked'
        ? t('typeLocked')
        : state.error === 'needs_won'
          ? t('needsWon')
          : state.error === 'needs_open'
            ? t('needsOpen')
            : tc('error');
  return <p className="text-sm font-semibold text-bad">{message}</p>;
}

export interface StageRow {
  id: string;
  name: string;
  kind: string;
  color: string;
  sortOrder: number;
  active: boolean;
}

/** Add or edit one funnel stage. */
export function StageForm({ stage }: { stage?: StageRow }) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(saveStageAction, {});

  return (
    <form action={formAction} className="space-y-2 border-t border-line pt-2 first:border-0">
      {stage && <input type="hidden" name="id" value={stage.id} />}
      <div className="flex flex-wrap gap-2">
        <input
          name="name"
          defaultValue={stage?.name}
          placeholder={t('stage')}
          aria-label={t('stage')}
          data-testid="stage-name"
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
        <button
          type="submit"
          data-testid={stage ? 'update-stage' : 'save-stage'}
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

/** Reorder and remove — the two things a fixed funnel cannot do. */
export function StageTools({ stages, usage }: { stages: StageRow[]; usage: Record<string, number> }) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [pending, start] = useTransition();

  const move = (index: number, delta: number) => {
    const next = [...stages];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    start(async () => {
      await reorderStagesAction(next.map((stage) => stage.id));
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
            data-testid="delete-stage"
            disabled={pending || stages.length < 2}
            onClick={() => {
              // Leads in the stage have to go somewhere; the operator picks.
              const others = stages.filter((other) => other.id !== stage.id);
              const target = window.prompt(
                `${t('moveTo')}:\n${others.map((other, i) => `${i + 1}. ${other.name}`).join('\n')}`,
                '1',
              );
              const index = Number(target) - 1;
              if (!others[index]) return;
              start(async () => {
                await deleteStageAction(stage.id, others[index]!.id);
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

export function SourceForm({
  source,
}: {
  source?: { id: string; name: string; sortOrder: number; active: boolean };
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(saveSourceAction, {});

  return (
    <form action={formAction} className="space-y-2 border-t border-line pt-2 first:border-0">
      {source && <input type="hidden" name="id" value={source.id} />}
      <div className="flex flex-wrap gap-2">
        <input
          name="name"
          defaultValue={source?.name}
          placeholder={t('source')}
          aria-label={t('source')}
          data-testid="source-name"
          className="input min-w-40 flex-1"
          required
        />
        <input
          name="sortOrder"
          type="number"
          defaultValue={source?.sortOrder ?? 100}
          aria-label="#"
          className="input !w-20"
        />
        <label className="flex items-center gap-1 self-center text-sm">
          <input type="hidden" name="active" value="off" />
          <input
            type="checkbox"
            name="active"
            value="on"
            defaultChecked={source ? source.active : true}
            className="h-4 w-4"
          />
          {tc('active')}
        </label>
        <button
          type="submit"
          data-testid={source ? 'update-source' : 'save-source'}
          className={source ? 'btn-secondary' : 'btn-primary'}
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export interface FieldRow {
  id: string;
  entityType: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  sortOrder: number;
  active: boolean;
  answers: number;
}

export function FieldForm({ field }: { field?: FieldRow }) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(saveFieldAction, {});
  const [deleting, startDelete] = useTransition();

  return (
    <form action={formAction} className="space-y-2 border-t border-line pt-2 first:border-0">
      {field && <input type="hidden" name="id" value={field.id} />}
      <div className="flex flex-wrap gap-2">
        <input
          name="label"
          defaultValue={field?.label}
          placeholder={t('label')}
          aria-label={t('label')}
          data-testid="field-label"
          className="input min-w-40 flex-1"
          required
        />
        <select
          name="entityType"
          defaultValue={field?.entityType ?? 'lead'}
          aria-label={t('forLead')}
          className="input !w-32"
          disabled={Boolean(field)}
        >
          <option value="lead">{t('forLead')}</option>
          <option value="client">{t('forClient')}</option>
        </select>
        {/* A disabled select sends nothing; the hidden twin keeps the value. */}
        {field && <input type="hidden" name="entityType" value={field.entityType} />}
        <select
          name="type"
          defaultValue={field?.type ?? 'text'}
          aria-label={t('fieldType')}
          className="input !w-36"
          disabled={Boolean(field)}
        >
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        {field && <input type="hidden" name="type" value={field.type} />}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          name="options"
          defaultValue={field?.options.join(', ')}
          placeholder={t('options')}
          aria-label={t('options')}
          className="input min-w-40 flex-1"
        />
        <input
          name="sortOrder"
          type="number"
          defaultValue={field?.sortOrder ?? 100}
          aria-label="#"
          className="input !w-20"
        />
        <label className="flex items-center gap-1 self-center text-sm">
          <input type="hidden" name="required" value="off" />
          <input
            type="checkbox"
            name="required"
            value="on"
            defaultChecked={field?.required ?? false}
            className="h-4 w-4"
          />
          {t('required')}
        </label>
        <label className="flex items-center gap-1 self-center text-sm">
          <input type="hidden" name="active" value="off" />
          <input
            type="checkbox"
            name="active"
            value="on"
            defaultChecked={field ? field.active : true}
            className="h-4 w-4"
          />
          {tc('active')}
        </label>
        <button
          type="submit"
          data-testid={field ? 'update-field' : 'save-field'}
          className={field ? 'btn-secondary' : 'btn-primary'}
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
        {field && (
          <button
            type="button"
            disabled={deleting}
            onClick={() => {
              // Deleting takes the stored answers with it — say how many.
              if (!window.confirm(t('answersWillGo', { n: field.answers }))) return;
              startDelete(async () => {
                await deleteFieldAction(field.id);
              });
            }}
            className="btn-danger"
          >
            {tc('delete')}
          </button>
        )}
      </div>
      <Feedback state={state} />
    </form>
  );
}
