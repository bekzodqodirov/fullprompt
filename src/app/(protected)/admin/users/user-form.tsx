'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { UserFormState } from './actions';
import type { RoleOption } from './role-options';

export interface UserFormValues {
  fullName: string;
  phone: string;
  username: string;
  locale: string;
  roleCodes: string[];
  warehouseIds: string[];
}

export function UserForm({
  action,
  initial,
  warehouses,
  roles,
  isNew,
}: {
  action: (prev: UserFormState, formData: FormData) => Promise<UserFormState>;
  initial?: UserFormValues;
  warehouses: { id: string; code: string; name: string }[];
  /** Every role that exists right now, the owner's own ones included. */
  roles: RoleOption[];
  isNew: boolean;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<UserFormState, FormData>(action, {});

  return (
    <form action={formAction} className="card max-w-lg space-y-4">
      <div>
        <label className="label" htmlFor="fullName">
          {t('fullName')}
        </label>
        <input id="fullName" name="fullName" className="input" defaultValue={initial?.fullName} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="phone">
            {t('phone')}
          </label>
          <input
            id="phone"
            name="phone"
            className="input"
            defaultValue={initial?.phone}
            inputMode="tel"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="username">
            {t('username')}
          </label>
          <input id="username" name="username" className="input" defaultValue={initial?.username} />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="password">
          {t('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          required={isNew}
          placeholder={isNew ? '' : t('passwordHint')}
          autoComplete="new-password"
        />
      </div>
      <div>
        <label className="label" htmlFor="locale">
          {t('language')}
        </label>
        <select id="locale" name="locale" className="input" defaultValue={initial?.locale ?? 'ru'}>
          <option value="ru">Русский</option>
          <option value="uz">O&apos;zbekcha</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <fieldset>
        <legend className="label">{t('roles')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {roles.map((role) => (
            <label key={role.code} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="roleCodes"
                value={role.code}
                defaultChecked={initial?.roleCodes.includes(role.code)}
                className="h-5 w-5"
              />
              {role.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="label">{t('warehouses')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {warehouses.map((wh) => (
            <label key={wh.id} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="warehouseIds"
                value={wh.id}
                defaultChecked={initial?.warehouseIds.includes(wh.id)}
                className="h-5 w-5"
              />
              <span className="font-mono font-bold">{wh.code}</span> {wh.name}
            </label>
          ))}
        </div>
      </fieldset>
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {state.error === 'phone_exists'
            ? t('phoneExists')
            : state.error === 'super_admin_locked'
              ? t('superAdminLocked')
              : tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {tc('save')}
      </button>
    </form>
  );
}
