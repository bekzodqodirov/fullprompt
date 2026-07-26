'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { WarehouseFormState } from './actions';

export interface WarehouseFormValues {
  code: string;
  name: string;
  country: string;
  type: string;
  timezone: string;
  batchPrefix: string;
  address: string;
  capacityM3: string;
}

const TYPES = ['origin', 'hub', 'customs', 'distribution'] as const;
const TIMEZONES = ['Asia/Shanghai', 'Asia/Kashgar', 'Asia/Tashkent', 'Asia/Urumqi'];

export function WarehouseForm({
  action,
  initial,
}: {
  action: (prev: WarehouseFormState, formData: FormData) => Promise<WarehouseFormState>;
  initial?: WarehouseFormValues;
}) {
  const t = useTranslations('warehouses');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<WarehouseFormState, FormData>(action, {});

  return (
    <form action={formAction} className="card max-w-lg space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="code">
            {t('code')}
          </label>
          <input
            id="code"
            name="code"
            className="input font-mono uppercase"
            defaultValue={initial?.code}
            required
            maxLength={10}
          />
        </div>
        <div>
          <label className="label" htmlFor="batchPrefix">
            {t('batchPrefix')}
          </label>
          <input
            id="batchPrefix"
            name="batchPrefix"
            className="input font-mono uppercase"
            defaultValue={initial?.batchPrefix}
            required
            maxLength={10}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="name">
          {t('name')}
        </label>
        <input id="name" name="name" className="input" defaultValue={initial?.name} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="country">
            {t('country')}
          </label>
          <select id="country" name="country" className="input" defaultValue={initial?.country ?? 'CN'}>
            <option value="CN">CN</option>
            <option value="UZ">UZ</option>
            <option value="KG">KG</option>
            <option value="KZ">KZ</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="type">
            {t('type')}
          </label>
          <select id="type" name="type" className="input" defaultValue={initial?.type ?? 'origin'}>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="timezone">
          {t('timezone')}
        </label>
        <select
          id="timezone"
          name="timezone"
          className="input"
          defaultValue={initial?.timezone ?? 'Asia/Shanghai'}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="address">
          {t('address')}
        </label>
        <input id="address" name="address" className="input" defaultValue={initial?.address} />
      </div>
      <div>
        <label className="label" htmlFor="capacityM3">
          {t('capacityM3')}
        </label>
        <input
          id="capacityM3"
          name="capacityM3"
          className="input"
          inputMode="decimal"
          placeholder="500"
          defaultValue={initial?.capacityM3}
        />
        <p className="mt-1 text-xs text-ink-500">{t('capacityHint')}</p>
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {state.error === 'code_exists' ? t('codeExists') : tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {tc('save')}
      </button>
    </form>
  );
}
