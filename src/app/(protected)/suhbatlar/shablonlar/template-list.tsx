'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteTemplateAction,
  saveTemplateAction,
  type TemplateFormState,
} from './actions';

export interface TemplateRow {
  id: string;
  title: string;
  body: string;
  sortOrder: number;
  shared: boolean;
}

/** The company's canned replies plus this person's own, in composer order. */
export function TemplateList({
  templates,
  canShare,
}: {
  templates: TemplateRow[];
  canShare: boolean;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-3">
      {/* Add FIRST, list after — the cost-types shape, and load-bearing on a
          phone: at the list's end the button slides under the fixed tab bar
          as soon as the list grows past a screenful. */}
      {adding ? (
        <TemplateForm canShare={canShare} onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          data-testid="add-template"
          className="btn-primary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('templateAdd')}
        </button>
      )}

      {templates.length === 0 && !adding && (
        <p className="card text-center text-sm text-ink-500" data-testid="templates-empty">
          {t('templateNone')}
        </p>
      )}

      {templates.map((template) => (
        <div key={template.id} className="card scroll-mb-28 space-y-2 !p-3">
          {/* flex-wrap, no shrink-0: a long title beside two buttons is exactly
              the row that overflows 360 px and makes mobile Chrome zoom the
              whole page out (#400). */}
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="min-w-0 font-bold [overflow-wrap:anywhere]">
              {template.shared && <span title={t('templateShared')}>🏢 </span>}
              {template.title}
            </span>
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                data-testid="edit-template"
                className="btn-secondary !min-h-9 px-2 text-sm"
                onClick={() => setEditingId(editingId === template.id ? null : template.id)}
              >
                ✏️ {tc('edit')}
              </button>
              <button
                type="button"
                data-testid="delete-template"
                disabled={pending}
                className="btn-secondary !min-h-9 px-2 text-sm disabled:opacity-60"
                onClick={() => {
                  if (!window.confirm(tc('confirm'))) return;
                  start(async () => {
                    await deleteTemplateAction(template.id);
                  });
                }}
              >
                🗑️
              </button>
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-500 [overflow-wrap:anywhere]">
            {template.body}
          </p>
          {editingId === template.id && (
            <TemplateForm
              template={template}
              canShare={canShare}
              onDone={() => setEditingId(null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function TemplateForm({
  template,
  canShare,
  onDone,
}: {
  template?: TemplateRow;
  canShare: boolean;
  onDone?: () => void;
}) {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<TemplateFormState, FormData>(
    saveTemplateAction,
    {},
  );

  useEffect(() => {
    if (state.ok) onDone?.();
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-2 rounded-lg bg-surface-sunken p-3">
      {template && <input type="hidden" name="id" value={template.id} />}
      <input
        name="title"
        className="input"
        defaultValue={template?.title ?? ''}
        placeholder={t('templateTitle')}
        aria-label={t('templateTitle')}
        maxLength={80}
        required
      />
      {/* `h-28`, never `min-h-28`: `.input` already sets `min-h-12` and wins on
          source order, so the taller box is asked for with a HEIGHT (the house
          idiom, custom-fields.tsx) — the fourth costume of #419. */}
      <textarea
        name="body"
        className="input h-28 py-2"
        defaultValue={template?.body ?? ''}
        placeholder={t('templateBody')}
        aria-label={t('templateBody')}
        maxLength={1000}
        required
      />
      <label className="flex items-center gap-2 text-sm">
        <span className="shrink-0">{t('templateOrder')}</span>
        <input
          name="sortOrder"
          type="number"
          min={0}
          max={10000}
          className="input"
          defaultValue={template?.sortOrder ?? 100}
          aria-label={t('templateOrder')}
        />
      </label>
      {/* Publishing to the company is a larger power than keeping a note, so
          it is offered only to whoever holds it — and the service refuses it
          again, because a checkbox is a request, not a permission. */}
      {canShare && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="shared"
            data-testid="template-shared"
            defaultChecked={template?.shared ?? false}
            className="size-5"
          />
          <span>{t('templateShared')}</span>
        </label>
      )}
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {tc('error')}
        </p>
      )}
      <button
        type="submit"
        data-testid="save-template"
        disabled={pending}
        className="btn-primary w-full disabled:opacity-60"
      >
        {pending ? '…' : tc('save')}
      </button>
    </form>
  );
}
