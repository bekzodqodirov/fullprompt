'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * A fact you can correct where you are reading it.
 *
 * The interaction is the one this codebase already shipped and proved at
 * 360 px (the batch card's per-prixod customs picker): the value is text
 * until you press it, then it is a box, and a SAVE button appears **only
 * once something actually differs**. No autosave on blur — a phone has no
 * Escape key, a focus-out is not a decision, and this app has twice decided
 * against writing on a gesture the person did not mean as one.
 *
 * A refusal keeps what was typed and says why, which is the rule three
 * rounds were spent learning (#377, #419, #466).
 */
export function InlineField({
  label,
  value,
  display,
  placeholder,
  multiline,
  options,
  editable,
  testId,
  onSave,
}: {
  label: string;
  /** What the box holds and what «has it changed?» compares — an id for a picker. */
  value: string;
  /** What the reader sees, when that is not the stored value (a person's name). */
  display?: string;
  placeholder?: string;
  multiline?: boolean;
  /** Present ⇒ the editor is a picker rather than a box. */
  options?: { value: string; label: string }[];
  /** False renders the fact and nothing else — the read-only reader's view. */
  editable: boolean;
  testId: string;
  onSave: (next: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useTranslations('common');
  // Existing keys, in all four bundles already — a refusal must never be the
  // thing that introduces a missing key, because that throws at render.
  const tf = useTranslations('fields.errors');
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const changed = draft.trim() !== value.trim();
  const shown = display ?? value;

  function open() {
    if (!editable) return;
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function commit() {
    setError(null);
    start(async () => {
      const result = await onSave(draft);
      if (!result.ok) {
        // Stay open, keep the words: a refused save that empties the box is
        // how somebody loses a correction they made once and will not retype.
        setError(result.error ?? 'failed');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <div className="border-b border-line/70 py-1.5 last:border-b-0" data-testid={testId}>
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-ink-500">{label}</div>

      {!editing ? (
        <button
          type="button"
          onClick={open}
          disabled={!editable}
          data-testid={`${testId}-open`}
          className={`w-full text-left text-sm ${
            editable ? 'cursor-text hover:text-brand-700' : 'cursor-default'
          } ${shown ? '' : 'text-ink-400'}`}
        >
          {shown || (editable ? (placeholder ?? '—') : '—')}
        </button>
      ) : (
        <div className="space-y-1">
          {options ? (
            <select
              className="input !py-1 text-sm"
              autoFocus
              value={draft}
              aria-label={label}
              data-testid={`${testId}-input`}
              onChange={(event) => setDraft(event.target.value)}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : multiline ? (
            <textarea
              className="input !py-1 text-sm"
              rows={3}
              autoFocus
              value={draft}
              aria-label={label}
              data-testid={`${testId}-input`}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <input
              className="input !py-1 text-sm"
              autoFocus
              value={draft}
              aria-label={label}
              data-testid={`${testId}-input`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // A keyboard gets the shortcuts; a thumb gets the buttons.
                if (event.key === 'Enter' && changed) commit();
                if (event.key === 'Escape') setEditing(false);
              }}
            />
          )}

          {error && (
            <p className="text-xs text-bad" data-testid={`${testId}-error`}>
              {error === 'validation' ? tf('field_required') : t('error')}
            </p>
          )}

          <div className="flex gap-1">
            {/* Only once something differs — a disabled button under every
                fact is a wall of buttons that say nothing. */}
            {changed && (
              <button
                type="button"
                disabled={pending}
                onClick={commit}
                data-testid={`${testId}-save`}
                className="btn-primary !min-h-8 flex-1 !py-1 text-sm"
              >
                {pending ? t('loading') : t('save')}
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => setEditing(false)}
              data-testid={`${testId}-cancel`}
              className="btn-ghost !min-h-8 !py-1 text-sm"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
