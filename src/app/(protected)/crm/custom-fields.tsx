import type { crmFields } from '@/modules/platform/db/schema';

type Field = typeof crmFields.$inferSelect;

/**
 * Renders whatever the owner defined, as the widget its type asks for.
 *
 * Inputs are named `cf_<fieldId>` so a form can carry the built-in fields and
 * the custom ones together and the action can tell them apart without knowing
 * anything about what was configured.
 */
export function CustomFieldInputs({
  fields,
  values,
}: {
  fields: Field[];
  values: Record<string, unknown>;
}) {
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field) => {
        const name = `cf_${field.id}`;
        const value = values[field.id];
        const options = Array.isArray(field.options) ? (field.options as string[]) : [];

        return (
          <label key={field.id} className="block text-sm">
            <span className="mb-0.5 block text-xs font-semibold text-gray-500">
              {field.label}
              {field.required && <span className="text-red-600"> *</span>}
            </span>

            {field.type === 'textarea' ? (
              <textarea
                name={name}
                defaultValue={typeof value === 'string' ? value : ''}
                rows={3}
                className="input"
                required={field.required}
              />
            ) : field.type === 'select' ? (
              <select
                name={name}
                defaultValue={typeof value === 'string' ? value : ''}
                className="input"
                required={field.required}
              >
                <option value="">—</option>
                {options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === 'multiselect' ? (
              <select
                name={name}
                multiple
                defaultValue={Array.isArray(value) ? (value as string[]) : []}
                className="input h-28"
              >
                {options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.type === 'checkbox' ? (
              <span className="flex items-center gap-2">
                {/* Paired hidden input: a browser sends nothing when unticked. */}
                <input type="hidden" name={name} value="off" />
                <input
                  type="checkbox"
                  name={name}
                  value="on"
                  defaultChecked={value === true}
                  className="h-5 w-5"
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
              />
            )}
          </label>
        );
      })}
    </>
  );
}
