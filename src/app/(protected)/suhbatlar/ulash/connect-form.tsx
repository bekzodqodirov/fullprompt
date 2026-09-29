'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  beginConnectAction,
  completeConnectAction,
  type ConnectState,
} from './actions';

/**
 * Three fields at most, one at a time — the same three steps Telegram itself
 * walks: phone → code → (password, only when the account has one).
 *
 * Controlled inputs, because a refused code must not eat what was typed
 * (the round-17 discount-form lesson: React resets an uncontrolled form
 * when its action returns). This comment said so for a year while the three
 * inputs were uncontrolled: every refusal emptied the box, and on a two-step
 * account the first press — the one that makes Telegram ask for the
 * password — emptied the CODE, so the password press posted no code at all.
 * The server no longer needs the code a second time (`finishLogin`), and the
 * boxes now keep what was typed.
 */
export function ConnectForm() {
  const t = useTranslations('crm');
  const tc = useTranslations('common');
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [state, formAction, pending] = useActionState<ConnectState, FormData>(
    async (prev, form) => {
      const next =
        prev.stage === 'phone'
          ? await beginConnectAction(prev, form)
          : await completeConnectAction(prev, form);
      // A new attempt starts from a clean code and password; the number stays.
      if (next.stage === 'phone') {
        setCode('');
        setPassword('');
      }
      if (next.stage === 'done') router.refresh();
      return next;
    },
    { stage: 'phone' },
  );

  if (state.stage === 'done') {
    return (
      <div className="card space-y-1 text-center" data-testid="connect-done">
        <p className="text-2xl">✅</p>
        <p className="font-bold">{t('connectDone')}</p>
        <p className="text-sm text-ink-500">{t('connectDoneHint')}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card space-y-2" data-testid="connect-form">
      {state.stage === 'phone' ? (
        <>
          <label className="block text-sm font-semibold" htmlFor="tg-phone">
            {t('connectPhone')}
          </label>
          <input
            id="tg-phone"
            name="phone"
            type="tel"
            placeholder="+998 90 123 45 67"
            autoComplete="tel"
            data-testid="connect-phone"
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <p className="text-xs text-ink-500">{t('connectPhoneHint')}</p>
        </>
      ) : state.needPassword ? (
        <>
          {/* Telegram has taken the code; only the password is left. */}
          <p className="text-sm font-semibold text-good" data-testid="connect-code-accepted">
            ✓ {t('connectCodeAccepted')}
          </p>
          <label className="block text-sm font-semibold" htmlFor="tg-password">
            {t('connectPassword')}
          </label>
          <input
            id="tg-password"
            name="password"
            type="password"
            autoComplete="current-password"
            data-testid="connect-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-ink-500">{t('connectPasswordHint')}</p>
        </>
      ) : (
        <>
          <label className="block text-sm font-semibold" htmlFor="tg-code">
            {t('connectCode')}
          </label>
          <input
            id="tg-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="12345"
            data-testid="connect-code"
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="text-xs text-ink-500">{t('connectCodeHint')}</p>
        </>
      )}

      <button
        type="submit"
        disabled={pending}
        data-testid="connect-submit"
        className="btn-primary w-full"
      >
        {pending
          ? tc('loading')
          : state.stage === 'phone'
            ? t('connectSendCode')
            : t('connectFinish')}
      </button>

      {state.error && (
        <p role="alert" data-testid="connect-error" className="text-sm font-semibold text-bad">
          {t(`connectErrors.${state.error}` as 'connectErrors.failed', { name: state.holder ?? '' })}
        </p>
      )}
    </form>
  );
}
