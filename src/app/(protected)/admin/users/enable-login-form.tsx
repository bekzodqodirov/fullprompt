'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { enableLoginAction, type UserFormState } from './actions';
import type { RoleOption } from './role-options';

/**
 * «Tizimga kirish ochish» — a person paid on /hodimlar becomes a login (0120).
 *
 * CONTROLLED, and the action is called from the click, never a `<form
 * action>`: a refused press (a phone somebody else holds, a taken username)
 * keeps every typed value — the reset-on-refusal the ordinary UserForm still
 * has is the #377/#463 shape.
 *
 * The phone starts EMPTY and is never prefilled from the payroll row: the
 * accountant's number may be a shared warehouse phone, and a login's phone is
 * what the staff bot recognises a colleague by. The payroll phone is shown
 * above as text, for reference.
 */
export function EnableLoginForm({
  id,
  payrollPhone,
  locale: initialLocale,
  roles,
  warehouses,
}: {
  id: string;
  payrollPhone: string | null;
  locale: string;
  roles: RoleOption[];
  warehouses: { id: string; code: string; name: string }[];
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [locale, setLocale] = useState(initialLocale);
  const [roleCodes, setRoleCodes] = useState<Set<string>>(() => new Set());
  const [warehouseIds, setWarehouseIds] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<UserFormState>({});

  const toggle = (set: Set<string>, value: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  const ready = phone.trim() !== '' && password !== '' && roleCodes.size > 0;

  return (
    <div className="card max-w-lg space-y-4" data-testid="enable-login-form">
      <p className="text-sm text-ink-600" data-testid="enable-login-payroll-phone">
        {payrollPhone ? t('payrollPhone', { phone: payrollPhone }) : t('payrollPhoneNone')}
      </p>
      <div>
        <label className="label" htmlFor="enable-login-phone">
          {t('phone')}
        </label>
        <input
          id="enable-login-phone"
          className="input"
          inputMode="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          data-testid="enable-login-phone"
        />
        <p className="mt-1 text-2xs text-ink-500">{t('loginPhoneHint')}</p>
      </div>
      <div>
        <label className="label" htmlFor="enable-login-username">
          {t('username')}
        </label>
        <input
          id="enable-login-username"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="enable-login-username"
        />
      </div>
      <div>
        <label className="label" htmlFor="enable-login-password">
          {t('password')}
        </label>
        <input
          id="enable-login-password"
          type="password"
          className="input"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="enable-login-password"
        />
      </div>
      <div>
        <label className="label" htmlFor="enable-login-locale">
          {t('language')}
        </label>
        <select
          id="enable-login-locale"
          className="input"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
        >
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
                className="h-5 w-5"
                checked={roleCodes.has(role.code)}
                onChange={(e) => setRoleCodes((s) => toggle(s, role.code, e.target.checked))}
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
                className="h-5 w-5"
                checked={warehouseIds.has(wh.id)}
                onChange={(e) => setWarehouseIds((s) => toggle(s, wh.id, e.target.checked))}
              />
              <span className="font-mono font-bold">{wh.code}</span> {wh.name}
            </label>
          ))}
        </div>
      </fieldset>
      {result.error ? (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad" data-testid="enable-login-error">
          {result.error === 'phone_exists'
            ? t('phoneExists')
            : result.error === 'username_exists'
              ? t('usernameExists')
              : result.error === 'super_admin_locked'
                ? t('superAdminLocked')
                : result.error === 'already_login'
                  ? t('alreadyLogin')
                  : result.error === 'inactive_person'
                    ? t('inactivePerson')
                    : result.error === 'bad_phone'
                      ? t('badPhone')
                      : result.error === 'no_login_row'
                        ? t('noLoginRow')
                        : tc('error')}
        </p>
      ) : null}
      {result.ok ? (
        <p className="text-sm font-semibold text-good" data-testid="enable-login-done">
          {t('enableLoginDone')}
        </p>
      ) : null}
      <button
        type="button"
        className="btn-primary w-full disabled:opacity-60"
        data-testid="enable-login-save"
        disabled={pending || !ready}
        onClick={() =>
          startTransition(async () => {
            const res = await enableLoginAction(id, {
              phone,
              username,
              password,
              locale,
              roleCodes: [...roleCodes],
              warehouseIds: [...warehouseIds],
            });
            setResult(res);
            if (res.ok) router.refresh();
          })
        }
      >
        {t('enableLoginSave')}
      </button>
    </div>
  );
}
