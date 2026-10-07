'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  connectChannelAction,
  disconnectChannelAction,
  newInviteLinkAction,
  retryPostAction,
  type ChannelActionResult,
} from './actions';

/**
 * The panel's buttons — client only for their pending state and the refusal
 * sentence (a refused press must SAY why, never sit silent, #472). Every
 * refusal code is a key under `priceChannel.error.*`, anchored on
 * `CHANNEL_ERRORS` by price-channel-i18n.test.ts.
 */
export function ChannelButton({
  kind,
  arg,
  label,
  confirm,
  testId,
  primary,
}: {
  kind: 'connect' | 'disconnect' | 'newLink' | 'retry';
  arg?: string;
  label: string;
  confirm?: string;
  testId: string;
  primary?: boolean;
}) {
  const t = useTranslations('priceChannel');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (confirm && !window.confirm(confirm)) return;
    setError(null);
    start(async () => {
      let res: ChannelActionResult;
      try {
        res =
          kind === 'connect'
            ? await connectChannelAction(arg ?? '')
            : kind === 'disconnect'
              ? await disconnectChannelAction()
              : kind === 'newLink'
                ? await newInviteLinkAction()
                : await retryPostAction(arg ?? '');
      } catch {
        res = { ok: false, error: 'telegram' };
      }
      if (!res.ok) {
        setError(
          res.error === 'telegram'
            ? t('error.telegram', { error: res.detail ?? '—' })
            : t(`error.${res.error}` as 'error.not_found'),
        );
      }
    });
  };
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className={primary ? 'btn btn-primary' : 'btn'}
        disabled={pending}
        onClick={run}
        data-testid={testId}
      >
        {label}
      </button>
      {error ? (
        <span className="text-xs text-bad [overflow-wrap:anywhere]" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** The invite link — `readOnly` and selected on focus, the /crm/kelganlar idiom: he copies it on a phone. */
export function InviteLink({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      data-testid="price-channel-link"
      className="input font-mono !text-xs"
    />
  );
}
