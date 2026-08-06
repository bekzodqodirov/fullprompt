'use client';

import { useActionState, useTransition } from 'react';
import {
  createCallDeviceAction,
  revokeCallDeviceAction,
  type CallDeviceState,
} from './actions';

export interface CallDeviceRow {
  id: string;
  label: string | null;
  pairCode: string | null;
  paired: boolean;
  lastSeenAt: string | null;
  calls: number;
}

/**
 * «Qo'ng'iroq yozg'ich» — the hodim's own section: mint a code, read it into
 * the app on their phone, done. Own account only by construction (the action
 * takes no user id), because the code signs THIS person's name onto whatever
 * the phone later sends.
 */
export function CallRecorderSection({
  devices,
  labels,
  apkVersion,
}: {
  devices: CallDeviceRow[];
  labels: {
    title: string;
    hint: string;
    add: string;
    codeHint: string;
    lastSeen: string;
    callCount: string;
    remove: string;
    notPaired: string;
    downloadApk: string;
  };
  /** Published build, or null — the link only renders when there is a file. */
  apkVersion: string | null;
}) {
  const [state, formAction, pending] = useActionState<CallDeviceState, FormData>(
    createCallDeviceAction,
    {},
  );
  const [revoking, startRevoke] = useTransition();

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">📞 {labels.title}</h2>
      <p className="text-sm text-ink-500">{labels.hint}</p>
      {/* Opened on the phone being set up, so a plain authed link is the
          whole distribution — no QR, no public page (the driver app needs
          those because the DRIVER has no login). */}
      {apkVersion && (
        <a href="/api/calls/apk" className="inline-block text-sm font-semibold underline" download>
          ⬇ {labels.downloadApk} · v{apkVersion}
        </a>
      )}

      {devices.map((device) => (
        <div key={device.id} className="card flex flex-wrap items-center gap-2 !p-3 text-sm">
          {device.pairCode ? (
            <>
              <span
                className="font-mono text-2xl font-extrabold tracking-widest text-brand-700"
                data-testid="call-pair-code"
              >
                {device.pairCode}
              </span>
              <span className="text-xs text-ink-500">{labels.codeHint}</span>
            </>
          ) : (
            <span className="min-w-0 font-semibold text-good">
              ✅ {device.label || labels.title}
              {device.lastSeenAt
                ? ` · ${labels.lastSeen}: ${device.lastSeenAt}`
                : ` · ${labels.notPaired}`}
              {device.calls > 0 && ` · ${device.calls} ${labels.callCount}`}
            </span>
          )}
          <button
            type="button"
            disabled={revoking}
            data-testid="call-device-revoke"
            className="ml-auto text-xs font-semibold text-bad underline disabled:opacity-50"
            onClick={() =>
              startRevoke(async () => {
                await revokeCallDeviceAction(device.id);
              })
            }
          >
            ✖ {labels.remove}
          </button>
        </div>
      ))}

      <form action={formAction} className="flex flex-wrap gap-2">
        <input name="label" className="input min-w-40 flex-1" placeholder={labels.title} maxLength={100} />
        <button
          type="submit"
          disabled={pending}
          data-testid="call-device-add"
          className="btn-secondary whitespace-nowrap px-3 disabled:opacity-60"
        >
          📲 {labels.add}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {state.error}
        </p>
      )}
    </section>
  );
}
