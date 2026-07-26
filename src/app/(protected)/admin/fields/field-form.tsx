'use client';

import { useActionState, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteFieldAction, saveFieldAction, type FieldAdminState } from './actions';

export interface FieldRow {
  id: string;
  entityType: string;
  label: string;
  type: string;
  options: string[];
  help: string | null;
  rules: { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string };
  showIf: { fieldId: string; values: string[] } | null;
  required: boolean;
  onList: boolean;
  lookupEntity: string | null;
  sortOrder: number;
  active: boolean;
  answers: number;
}

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
  'money',
  'lookup',
  'file',
] as const;

/** Types that can be the PARENT of a visibility rule — they have finite answers. */
const PARENT_TYPES = ['select', 'multiselect', 'checkbox'];

/**
 * One field definition, add or edit.
 *
 * The two boxes that matter and the twelve that occasionally do are separated:
 * label, object and type are always visible; rules, hints, list behaviour and
 * the visibility predicate live behind "more", because a form with sixteen
 * inputs teaches people not to add fields.
 */
export function FieldForm({
  field,
  entities,
  lookupEntities,
  siblings,
}: {
  field?: FieldRow;
  entities: { code: string; label: string }[];
  lookupEntities: { code: string; label: string }[];
  /** Fields on the same object that a visibility rule may point at. */
  siblings: { id: string; label: string; entityType: string; type: string }[];
}) {
  const t = useTranslations('fields');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<FieldAdminState, FormData>(
    saveFieldAction,
    {},
  );
  const [deleting, startDelete] = useTransition();
  const [entityType, setEntityType] = useState(field?.entityType ?? entities[0]?.code ?? 'client');
  const [type, setType] = useState<string>(field?.type ?? 'text');
  const [more, setMore] = useState(false);

  const parents = siblings.filter(
    (row) => row.entityType === entityType && PARENT_TYPES.includes(row.type) && row.id !== field?.id,
  );

  return (
    <form
      action={formAction}
      className="space-y-2 border-t border-line pt-2 first:border-0"
      data-testid={field ? `field-row-${field.id}` : 'field-new'}
    >
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
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
          aria-label={t('object')}
          data-testid="field-entity"
          className="input !w-40"
          disabled={Boolean(field)}
        >
          {entities.map((entity) => (
            <option key={entity.code} value={entity.code}>
              {entity.label}
            </option>
          ))}
        </select>
        {/* A disabled select sends nothing; the hidden twin keeps the value. */}
        {field && <input type="hidden" name="entityType" value={field.entityType} />}
        <select
          name="type"
          value={type}
          onChange={(event) => setType(event.target.value)}
          aria-label={t('type')}
          data-testid="field-type"
          className="input !w-36"
          disabled={Boolean(field)}
        >
          {TYPES.map((option) => (
            <option key={option} value={option}>
              {t(`types.${option}` as 'types.text')}
            </option>
          ))}
        </select>
        {field && <input type="hidden" name="type" value={field.type} />}
      </div>

      {(type === 'select' || type === 'multiselect') && (
        <input
          name="options"
          defaultValue={field?.options.join(', ')}
          placeholder={t('options')}
          aria-label={t('options')}
          data-testid="field-options"
          className="input"
        />
      )}
      {type === 'lookup' && (
        <select
          name="lookupEntity"
          defaultValue={field?.lookupEntity ?? lookupEntities[0]?.code}
          aria-label={t('lookupEntity')}
          className="input"
        >
          {lookupEntities.map((entity) => (
            <option key={entity.code} value={entity.code}>
              {entity.label}
            </option>
          ))}
        </select>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
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
        <label className="flex items-center gap-1">
          <input type="hidden" name="onList" value="off" />
          <input
            type="checkbox"
            name="onList"
            value="on"
            defaultChecked={field?.onList ?? false}
            data-testid="field-on-list"
            className="h-4 w-4"
          />
          {t('onList')}
        </label>
        <label className="flex items-center gap-1">
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
        <input
          name="sortOrder"
          type="number"
          defaultValue={field?.sortOrder ?? 100}
          aria-label="#"
          className="input !w-20"
        />
        <button
          type="button"
          onClick={() => setMore((value) => !value)}
          className="text-xs font-semibold text-brand-700"
        >
          {more ? '▲' : '▼'} {t('more')}
        </button>
      </div>

      {more && (
        <div className="space-y-2 rounded-lg bg-surface-sunken p-2">
          <input
            name="help"
            defaultValue={field?.help ?? ''}
            placeholder={t('help')}
            aria-label={t('help')}
            className="input"
          />
          <div className="flex flex-wrap gap-2">
            {(type === 'number' || type === 'money') && (
              <>
                <input
                  name="min"
                  type="number"
                  step="any"
                  defaultValue={field?.rules.min ?? ''}
                  placeholder={t('min')}
                  aria-label={t('min')}
                  className="input !w-24"
                />
                <input
                  name="max"
                  type="number"
                  step="any"
                  defaultValue={field?.rules.max ?? ''}
                  placeholder={t('max')}
                  aria-label={t('max')}
                  className="input !w-24"
                />
              </>
            )}
            {['text', 'textarea', 'phone', 'url'].includes(type) && (
              <>
                <input
                  name="minLength"
                  type="number"
                  defaultValue={field?.rules.minLength ?? ''}
                  placeholder={t('minLength')}
                  aria-label={t('minLength')}
                  className="input !w-24"
                />
                <input
                  name="maxLength"
                  type="number"
                  defaultValue={field?.rules.maxLength ?? ''}
                  placeholder={t('maxLength')}
                  aria-label={t('maxLength')}
                  className="input !w-24"
                />
                <input
                  name="pattern"
                  defaultValue={field?.rules.pattern ?? ''}
                  placeholder={t('pattern')}
                  aria-label={t('pattern')}
                  className="input min-w-40 flex-1 font-mono text-xs"
                />
              </>
            )}
          </div>

          <p className="text-xs font-semibold text-ink-500">{t('showIf')}</p>
          <div className="flex flex-wrap gap-2">
            <select
              name="showIfField"
              defaultValue={field?.showIf?.fieldId ?? ''}
              aria-label={t('showIf')}
              className="input min-w-40 flex-1"
            >
              <option value="">{t('always')}</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.label}
                </option>
              ))}
            </select>
            <input
              name="showIfValues"
              defaultValue={field?.showIf?.values.join(', ') ?? ''}
              placeholder={t('showIfValues')}
              aria-label={t('showIfValues')}
              className="input min-w-40 flex-1"
            />
          </div>
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.options_required')}
          {state.detail ? `: ${state.detail}` : ''}
        </p>
      )}
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          data-testid={field ? 'update-field' : 'save-field'}
          className={field ? 'btn-secondary flex-1' : 'btn-primary flex-1'}
          disabled={pending}
        >
          {pending ? tc('loading') : tc('save')}
        </button>
        {field && (
          <button
            type="button"
            data-testid={`delete-field-${field.id}`}
            disabled={deleting}
            onClick={() => {
              // Deleting takes the stored answers with it — say how many.
              if (!window.confirm(t('answersWillGo', { n: field.answers }))) return;
              startDelete(async () => {
                await deleteFieldAction(field.id);
              });
            }}
            className="btn-secondary text-bad"
          >
            🗑
          </button>
        )}
      </div>
    </form>
  );
}
