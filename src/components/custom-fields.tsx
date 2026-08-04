'use client';

import { useState } from 'react';
import { AttachmentsPanel, type AttachmentItem } from '@/components/attachments-panel';

/**
 * Whatever the owner defined, rendered as the widget its type asks for.
 *
 * Inputs are named `cf_<fieldId>` so a form can carry the built-in fields and
 * the custom ones together and the action tells them apart without knowing
 * anything about what was configured. Money posts TWO inputs under that one
 * name — amount then currency — which is what `getAll` returns in order.
 */

export interface FieldView {
  id: string;
  label: string;
  type: string;
  options: string[];
  help: string | null;
  required: boolean;
  rules: { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string };
  showIf: { fieldId: string; values: string[] } | null;
}

export interface CustomFieldsProps {
  fields: FieldView[];
  values: Record<string, unknown>;
  /** Rows a lookup field may point at, per field id. */
  choices?: Record<string, { id: string; label: string }[]>;
  /** Currency codes a money field offers. */
  currencies?: string[];
  /** For file fields: the attachment group id and what is in it already. */
  files?: Record<string, { groupId: string; items: AttachmentItem[] }>;
  editable?: boolean;
}

export function CustomFieldInputs({
  fields,
  values,
  choices = {},
  currencies = ['USD'],
  files = {},
  editable = true,
}: CustomFieldsProps) {
  // Only the answers a visibility rule can depend on are tracked, so typing in
  // a text box does not re-render the whole card.
  const parents = new Set(fields.map((field) => field.showIf?.fieldId).filter(Boolean) as string[]);
  const [live, setLive] = useState<Record<string, unknown>>(() =>
    Object.fromEntries([...parents].map((id) => [id, values[id]])),
  );

  const visible = (field: FieldView) => {
    if (!field.showIf) return true;
    const answer = live[field.showIf.fieldId];
    if (answer === null || answer === undefined) return false;
    const have = Array.isArray(answer) ? answer.map(String) : [String(answer)];
    return have.some((value) => field.showIf!.values.includes(value));
  };

  if (fields.length === 0) return null;

  return (
    <>
      {fields.map((field) => {
        if (!visible(field)) return null;
        const name = `cf_${field.id}`;
        const value = values[field.id];
        const track = parents.has(field.id)
          ? (next: unknown) => setLive((prev) => ({ ...prev, [field.id]: next }))
          : undefined;

        return (
          <label key={field.id} className="block text-sm" data-testid={`field-${field.id}`}>
            <span className="mb-0.5 block text-xs font-semibold text-ink-500">
              {field.label}
              {field.required && <span className="text-bad"> *</span>}
            </span>

            {field.type === 'textarea' ? (
              <textarea
                name={name}
                defaultValue={typeof value === 'string' ? value : ''}
                rows={3}
                className="input"
                required={field.required}
                minLength={field.rules.minLength}
                maxLength={field.rules.maxLength}
                disabled={!editable}
              />
            ) : field.type === 'select' ? (
              <select
                name={name}
                defaultValue={typeof value === 'string' ? value : ''}
                className="input"
                required={field.required}
                disabled={!editable}
                onChange={track ? (e) => track(e.target.value) : undefined}
              >
                <option value="">—</option>
                {field.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === 'multiselect' ? (
              <select
                name={name}
                multiple
                defaultValue={Array.isArray(value) ? (value as string[]) : []}
                className="input h-28"
                disabled={!editable}
                onChange={
                  track
                    ? (e) => track([...e.target.selectedOptions].map((option) => option.value))
                    : undefined
                }
              >
                {field.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === 'checkbox' ? (
              <span className="flex items-center gap-2">
                {/* Paired hidden input: a browser sends nothing when unticked.
                    Disabled together with the checkbox — a read-only render
                    inside a submitting form must not post a lone "off" (#171). */}
                <input type="hidden" name={name} value="off" disabled={!editable} />
                <input
                  type="checkbox"
                  name={name}
                  value="on"
                  defaultChecked={value === true}
                  className="h-5 w-5"
                  disabled={!editable}
                  onChange={track ? (e) => track(e.target.checked) : undefined}
                />
              </span>
            ) : field.type === 'money' ? (
              <span className="flex gap-2">
                <input
                  name={name}
                  inputMode="decimal"
                  defaultValue={moneyAmount(value)}
                  className="input flex-1"
                  required={field.required}
                  disabled={!editable}
                />
                <select
                  name={name}
                  defaultValue={moneyCurrency(value) || currencies[0]}
                  className="input !w-24"
                  disabled={!editable}
                  aria-label={`${field.label} — currency`}
                >
                  {currencies.map((code) => (
                    <option key={code}>{code}</option>
                  ))}
                </select>
              </span>
            ) : field.type === 'lookup' ? (
              <select
                name={name}
                defaultValue={typeof value === 'string' ? value : ''}
                className="input"
                required={field.required}
                disabled={!editable}
              >
                <option value="">—</option>
                {(choices[field.id] ?? []).map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'file' ? (
              <span className="block">
                {/* The group id is minted by the server and travels with the
                    form, so files uploaded before the first save still belong
                    to this answer once it exists. */}
                <input type="hidden" name={name} value={files[field.id]?.groupId ?? ''} />
                <AttachmentsPanel
                  entityType="custom_field"
                  entityId={files[field.id]?.groupId ?? ''}
                  initial={files[field.id]?.items ?? []}
                  editable={editable}
                />
              </span>
            ) : (
              <input
                name={name}
                type={field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}
                inputMode={
                  field.type === 'number' ? 'decimal' : field.type === 'phone' ? 'tel' : undefined
                }
                defaultValue={
                  typeof value === 'string' || typeof value === 'number' ? String(value) : ''
                }
                className="input"
                required={field.required}
                minLength={field.type === 'number' ? undefined : field.rules.minLength}
                maxLength={field.type === 'number' ? undefined : field.rules.maxLength}
                pattern={field.type === 'number' ? undefined : field.rules.pattern}
                disabled={!editable}
              />
            )}

            {field.help && <span className="mt-0.5 block text-xs text-ink-400">{field.help}</span>}
          </label>
        );
      })}
    </>
  );
}

function moneyAmount(value: unknown): string {
  const money = value as { amount?: number } | null;
  return typeof money?.amount === 'number' ? String(money.amount) : '';
}

function moneyCurrency(value: unknown): string {
  const money = value as { currency?: string } | null;
  return typeof money?.currency === 'string' ? money.currency : '';
}
