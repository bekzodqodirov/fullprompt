'use client';

import { useTranslations } from 'next-intl';

/**
 * A filter box per custom column, inside the list's own GET form.
 *
 * A dropdown offers its own choices; everything else takes text, and a number
 * or date field says in its placeholder that `>10` and `2026-01-01..2026-03-01`
 * are understood — which is the difference between a filter the owner can use
 * to answer a question and one that only matches what he types exactly.
 */
export function CustomFilters({
  fields,
}: {
  fields: { id: string; label: string; type: string; options: string[]; value: string }[];
}) {
  const t = useTranslations('fields');

  return (
    <div className="flex flex-wrap gap-2" data-testid="custom-filters">
      {fields.map((field) => {
        const name = `cf_${field.id}`;
        if (field.options.length > 0) {
          return (
            <select
              key={field.id}
              name={name}
              defaultValue={field.value}
              aria-label={field.label}
              data-testid={`filter-${field.id}`}
              className="input !w-44"
            >
              <option value="">{field.label}: {t('any')}</option>
              {field.options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          );
        }
        if (field.type === 'checkbox') {
          return (
            <select
              key={field.id}
              name={name}
              defaultValue={field.value}
              aria-label={field.label}
              data-testid={`filter-${field.id}`}
              className="input !w-44"
            >
              <option value="">{field.label}: {t('any')}</option>
              <option value="true">{t('yes')}</option>
              <option value="false">{t('no')}</option>
            </select>
          );
        }
        return (
          <input
            key={field.id}
            name={name}
            defaultValue={field.value}
            placeholder={
              field.type === 'number' || field.type === 'money'
                ? `${field.label} (>10, 5..9)`
                : field.type === 'date'
                  ? `${field.label} (2026-01-01..)`
                  : field.label
            }
            aria-label={field.label}
            data-testid={`filter-${field.id}`}
            className="input !w-44"
          />
        );
      })}
      <button type="submit" className="btn-secondary !min-h-10 px-3">
        🔍
      </button>
    </div>
  );
}
