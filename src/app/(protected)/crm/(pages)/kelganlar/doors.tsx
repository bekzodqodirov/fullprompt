'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setSourceWebhookAction } from './actions';

/**
 * Every address an advert can be pointed at, on one screen (round 86b).
 *
 * The owner cannot set up a campaign without the exact URL, and telling him in
 * chat means he loses it the next time he scrolls. Three doors per source, and
 * the first two need no setup at all:
 *
 *  1. the public form — works the day it deploys, for TikTok, YouTube, a bio
 *     link, a printed QR, anything;
 *  2. the bot deep link — Telegram proves the number itself, which is a
 *     stronger identity than anything typed;
 *  3. the webhook — only for a platform's OWN in-feed form, and only when the
 *     owner has switched it on.
 *
 * The key is behind a fold and only for whoever may change settings: it is a
 * password for writing into the funnel, and a screenshot of this page taken
 * for any other reason must not carry it.
 */

export interface DoorView {
  key: string;
  name: string;
  formUrl: string;
  botUrl: string | null;
  webhookUrl: string;
  secret: string | null;
}

export function InboundDoors({
  doors,
  canManage,
}: {
  doors: DoorView[];
  canManage: boolean;
}) {
  const t = useTranslations('crm');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const toggle = (key: string, on: boolean) => {
    setBusy(key);
    startTransition(async () => {
      await setSourceWebhookAction(key, on);
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <ul className="space-y-2" data-testid="inbound-doors">
      {doors.map((door) => (
        <li key={door.key} className="card space-y-1.5 p-3">
          <p className="font-semibold">{door.name}</p>
          <Copyable label={t('doorForm')} value={door.formUrl} />
          {door.botUrl && <Copyable label={t('doorBot')} value={door.botUrl} />}

          {canManage && (
            <details className="rounded-xl border border-line p-2">
              <summary className="cursor-pointer text-xs font-semibold text-ink-500">
                {t('doorWebhook')} · {door.secret ? t('doorOn') : t('doorOff')}
              </summary>
              <div className="mt-1.5 space-y-1.5">
                <p className="text-xs text-ink-500">{t('doorWebhookHint')}</p>
                {door.secret && (
                  <>
                    <Copyable label="URL" value={door.webhookUrl} />
                    <Copyable label={t('doorKey')} value={door.secret} secret />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => toggle(door.key, !door.secret)}
                  disabled={busy === door.key}
                  data-testid="door-toggle"
                  className="btn w-full"
                >
                  {door.secret ? t('doorTurnOff') : t('doorTurnOn')}
                </button>
              </div>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A value that exists to be pasted somewhere else.
 *
 * `readOnly`, not disabled and not a `<p>`: the owner is copying this into
 * Google's settings on a phone, where selecting text inside a paragraph is
 * a fight and a long-press on an input is not. `select()` on focus so one tap
 * takes the whole thing.
 */
function Copyable({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      <div className="flex items-center gap-1">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          data-testid={secret ? 'door-secret' : 'door-url'}
          className="input font-mono !text-xs"
        />
        <button
          type="button"
          className="btn shrink-0"
          aria-label={t('copy')}
          onClick={() => {
            // `navigator.clipboard` is absent on http, and this page is opened
            // over https in production and over http in a test — so a failure
            // must leave the value on screen rather than throwing under it.
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            );
          }}
        >
          {copied ? '✅' : '⧉'}
        </button>
      </div>
    </div>
  );
}
