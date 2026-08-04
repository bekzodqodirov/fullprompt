'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { loginAction, type LoginState } from '@/modules/platform/auth/actions';

export function LoginForm() {
  const t = useTranslations('login');
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="identifier" className="label">
          {t('identifier')}
        </label>
        <input
          id="identifier"
          name="identifier"
          className="input"
          autoComplete="username"
          inputMode="tel"
          required
        />
      </div>
      <div>
        <label htmlFor="password" className="label">
          {t('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 p-3 text-sm font-semibold text-bad">
          {state.error === 'invalid' && t('invalid')}
          {state.error === 'rate_limited' && t('rateLimited')}
          {state.error === 'validation' && t('validation')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {t('submit')}
      </button>
    </form>
  );
}
