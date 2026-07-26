'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  saveCustomFieldsAction,
  type FieldsFormState,
} from '@/modules/platform/fields/actions';
import { CustomFieldInputs, type CustomFieldsProps } from './custom-fields';

/**
 * The standalone form the cards use.
 *
 * Most cards in this app are a mosaic of small independent forms rather than
 * one big one, so custom answers post on their own. The exception is the lead
 * card, whose form already carries `children`; there the inputs travel with
 * the built-in fields and this component is not used.
 */
export function CustomFieldsForm({
  entityType,
  entityId,
  revalidate,
  editable = true,
  ...inputs
}: CustomFieldsProps & {
  entityType: string;
  entityId: string;
  revalidate: string;
}) {
  const t = useTranslations('fields');
  const tc = useTranslations('common');
  const action = saveCustomFieldsAction.bind(null, entityType, entityId, revalidate);
  const [state, formAction, pending] = useActionState<FieldsFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-2">
      <CustomFieldInputs {...inputs} editable={editable} />
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.field_required')}
          {state.field ? `: ${state.field}` : ''}
        </p>
      )}
      {editable && (
        <button
          type="submit"
          data-testid="save-custom-fields"
          disabled={pending}
          className="btn-primary w-full disabled:opacity-60"
        >
          {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
        </button>
      )}
    </form>
  );
}
