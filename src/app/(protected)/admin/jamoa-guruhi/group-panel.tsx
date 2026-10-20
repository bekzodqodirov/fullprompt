'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  connectGroupAction,
  deleteGroupMediaAction,
  disconnectGroupAction,
  retryGroupPostAction,
  saveGoalAction,
  sendChampionNowAction,
  sendRatingNowAction,
  testPostAction,
  type GroupActionResult,
} from './actions';
import { STAFF_GROUP_MEDIA_ENTITY, STAFF_GROUP_MEDIA_TYPE } from '@/modules/platform/telegram/staff-group-media';

type Kind = 'connect' | 'disconnect' | 'test' | 'rating' | 'champion' | 'retry' | 'deleteMedia';

/**
 * The panel's buttons — client only for their pending state and the refusal
 * sentence (a refused press must SAY why, never sit silent, #472). Every
 * refusal code is a key under `staffGroup.error.*`, anchored on GROUP_ERRORS.
 */
export function GroupButton({
  kind,
  arg,
  label,
  confirm,
  testId,
  primary,
  okText,
}: {
  kind: Kind;
  arg?: string;
  label: string;
  confirm?: string;
  testId: string;
  primary?: boolean;
  okText?: string;
}) {
  const t = useTranslations('staffGroup');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = () => {
    if (confirm && !window.confirm(confirm)) return;
    setError(null);
    setDone(null);
    start(async () => {
      let res: GroupActionResult;
      try {
        res =
          kind === 'connect'
            ? await connectGroupAction(arg ?? '')
            : kind === 'disconnect'
              ? await disconnectGroupAction()
              : kind === 'test'
                ? await testPostAction()
                : kind === 'rating'
                  ? await sendRatingNowAction()
                  : kind === 'champion'
                    ? await sendChampionNowAction()
                    : kind === 'retry'
                      ? await retryGroupPostAction(arg ?? '')
                      : await deleteGroupMediaAction(arg ?? '');
      } catch {
        res = { ok: false, error: 'failed' };
      }
      if (res.ok) setDone(res.note === 'requeued' ? t('requeued') : (okText ?? null));
      else setError(t(`error.${res.error}` as 'error.failed'));
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
      {done ? (
        <span className="text-xs text-good" role="status" data-testid={`${testId}-ok`}>
          {done}
        </span>
      ) : null}
      {error ? (
        <span className="text-xs text-bad [overflow-wrap:anywhere]" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** One or more GIFs/photos into the rotation, through the ordinary upload route. */
export function MediaUpload() {
  const t = useTranslations('staffGroup');
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const data = new FormData();
        data.append('file', file);
        data.append('entityType', STAFF_GROUP_MEDIA_TYPE);
        data.append('entityId', STAFF_GROUP_MEDIA_ENTITY);
        const res = await fetch('/api/files/upload', { method: 'POST', body: data });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error === 'too_large' ? t('uploadTooLarge') : t('uploadRefused'));
          break;
        }
      }
    } catch {
      setError(t('uploadRefused'));
    } finally {
      setBusy(false);
      // Reset AFTER the handler: re-picking the same file must fire again (#760).
      if (input.current) input.current.value = '';
      router.refresh();
    }
  };
  return (
    <div className="space-y-1">
      <label className="btn inline-flex cursor-pointer" data-testid="staff-group-upload-label">
        {busy ? t('uploading') : t('upload')}
        <input
          ref={input}
          type="file"
          multiple
          accept="image/gif,video/mp4,image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={busy}
          onChange={(e) => void onPick(e.currentTarget.files)}
          data-testid="staff-group-upload"
        />
      </label>
      {error ? (
        <p className="text-xs text-bad" role="alert" data-testid="staff-group-upload-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The weekly team goal in kub — one box, held while a refusal is shown (#463). */
export function GoalForm({ initial }: { initial: number }) {
  const t = useTranslations('staffGroup');
  const [value, setValue] = useState(initial > 0 ? String(initial) : '');
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        start(async () => {
          const res = await saveGoalAction(value).catch(() => ({ ok: false as const, error: 'failed' as const }));
          setNote(res.ok ? { ok: true, text: t('goalSaved') } : { ok: false, text: t(`error.${res.error}` as 'error.failed') });
        });
      }}
    >
      <label className="block">
        <span className="label">{t('goal')}</span>
        <input
          className="input max-w-40"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0"
          data-testid="staff-group-goal"
        />
      </label>
      <button type="submit" className="btn" disabled={pending} data-testid="staff-group-goal-save">
        {t('save')}
      </button>
      {note ? (
        <span className={note.ok ? 'text-xs text-good' : 'text-xs text-bad'} role="status">
          {note.text}
        </span>
      ) : null}
    </form>
  );
}
