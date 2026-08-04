'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  savePartnerTypeAction,
  setPartnerTypeActiveAction,
  type PartnerTypeFormState,
} from './actions';

/** Counterparty types the owner manages himself. Same shape as cost types. */
export function PartnerTypeList({
  types,
}: {
  types: { id: string; name: string; active: boolean }[];
}) {
  const t = useTranslations('partners');
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {/* Add FIRST, list after: at the list's end the button slides under the
          fixed tab bar the moment a dictionary grows past a screenful (#m9p). */}
      {adding ? (
        <TypeForm onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          data-testid="add-partner-type"
          className="btn-primary w-full"
          onClick={() => setAdding(true)}
        >
          ＋ {t('addType')}
        </button>
      )}

      {types.map((type) => (
        <div
          key={type.id}
          className={`card scroll-mb-28 !p-3 ${type.active ? '' : 'opacity-60'}`}
        >
          {/* flex-wrap is load-bearing: a long name plus a button overflowed
              360px and mobile Chrome zoomed the whole page out (round 29). */}
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{type.name}</span>
            <form action={setPartnerTypeActiveAction} className="ml-auto">
              <input type="hidden" name="id" value={type.id} />
              <input type="hidden" name="active" value={type.active ? '0' : '1'} />
              <button type="submit" className="btn-secondary !py-1 px-2 text-xs">
                {type.active ? t('hide') : t('show')}
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}

function TypeForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('partners');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<PartnerTypeFormState, FormData>(
    savePartnerTypeAction,
    {},
  );
  if (state.ok) onDone();

  return (
    <form action={formAction} className="card space-y-2 !p-3">
      <input
        name="name"
        className="input"
        placeholder={t('typeName')}
        aria-label={t('typeName')}
        data-testid="partner-type-name"
        required
      />
      <div className="flex gap-2">
        <button type="submit" className="btn-primary flex-1" disabled={pending}>
          {pending ? tc('loading') : tc('save')}
        </button>
        <button type="button" className="btn-secondary flex-1" onClick={onDone}>
          {tc('cancel')}
        </button>
      </div>
      {state.error && <p className="text-sm font-semibold text-bad">{tc('error')}</p>}
    </form>
  );
}
