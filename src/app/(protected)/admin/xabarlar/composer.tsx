'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { compressPhoto } from '@/components/compress-photo';
import type { Audience } from '@/modules/platform/broadcast/service';
import { sendBroadcastAction } from './actions';

/** Past this many rows the list stops drawing — the count still covers all. */
const LIST_CAP = 300;

/**
 * The message itself: words and up to ten files, sent to the audience the
 * page drew above — minus whoever the office un-ticks in the list (his item
 * 4: find the clients, then write to the ones that fit). Files are uploaded as they are picked, pre-bound to the
 * broadcast's own id minted here (#180's pattern), so «Yuborish» only
 * freezes the rows. The press asks once, naming the count — a message to
 * three hundred customers cannot be taken back.
 */
export function BroadcastComposer({
  audience,
  recipients,
}: {
  audience: Audience;
  recipients: { code: string; name: string }[];
}) {
  const t = useTranslations('broadcast');
  // Un-ticked codes. Empty = the whole audience, sent as the audience itself
  // so a list longer than the codes cap still goes to everybody.
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const count = recipients.length - recipients.filter((r) => off.has(r.code)).length;
  const toggle = (code: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  const [id, setId] = useState(() => crypto.randomUUID());
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(0);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // A literal map — a key built at runtime is one no bundle test can see (#163).
  const errorText: Record<NonNullable<Awaited<ReturnType<typeof sendBroadcastAction>>['error']>, string> = {
    forbidden: t('error.forbidden'),
    validation: t('error.validation'),
    empty: t('error.empty'),
    no_recipients: t('error.no_recipients'),
    too_long: t('error.too_long'),
    too_many_files: t('error.too_many_files'),
    exists: t('error.exists'),
  };

  async function upload(list: FileList | null) {
    if (!list) return;
    for (const raw of Array.from(list).slice(0, 10 - files.length)) {
      setBusy((n) => n + 1);
      try {
        const file = raw.type.startsWith('image/') ? await compressPhoto(raw, { maxSizeMB: 1 }).catch(() => raw) : raw;
        const form = new FormData();
        form.append('file', file, raw.name);
        form.append('entityType', 'broadcast');
        form.append('entityId', id);
        const res = await fetch('/api/files/upload', { method: 'POST', body: form });
        if (res.ok) {
          const saved = (await res.json()) as { id: string };
          setFiles((prev) => [...prev, { id: saved.id, name: raw.name }]);
        } else setResult(t('uploadFailed', { name: raw.name }));
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (input.current) input.current.value = '';
  }

  async function send() {
    const picked = recipients.filter((r) => !off.has(r.code)).map((r) => r.code);
    // Some un-ticked: the message goes to exactly the ticked codes — which
    // the schema caps, so a huge list with a few removed is said, not cut.
    if (off.size > 0 && picked.length > 500) {
      setResult(t('error.too_many_picked'));
      return;
    }
    if (!window.confirm(t('confirm', { n: count }))) return;
    setPending(true);
    try {
      const target: Audience =
        off.size === 0 ? audience : { sectors: [], cargoKinds: [], locales: [], codes: picked };
      const res = await sendBroadcastAction({ id, body, audience: target });
      if (res.ok) {
        setResult(t('queued', { n: res.total ?? count }));
        setBody('');
        setFiles([]);
        setId(crypto.randomUUID());
        setOff(new Set());
      } else {
        setResult(errorText[res.error ?? 'validation']);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-2 !p-3" data-testid="broadcast-composer">
      {recipients.length > 0 && (
        <div className="space-y-1" data-testid="broadcast-picker">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold">{t('picked', { n: count, total: recipients.length })}</span>
            <button type="button" className="text-xs text-brand-700 underline" onClick={() => setOff(new Set())}>
              {t('pickAll')}
            </button>
            <button
              type="button"
              className="text-xs text-brand-700 underline"
              onClick={() => setOff(new Set(recipients.slice(0, LIST_CAP).map((r) => r.code)))}
            >
              {t('pickNone')}
            </button>
          </div>
          <ul className="max-h-64 overflow-y-auto rounded-lg border border-line text-sm">
            {recipients.slice(0, LIST_CAP).map((r) => (
              <li key={r.code} className="border-b border-line last:border-0">
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={!off.has(r.code)}
                    onChange={() => toggle(r.code)}
                    data-testid="broadcast-pick"
                  />
                  <span className="font-mono font-bold">{r.code}</span>
                  <span className="min-w-0 truncate text-ink-600">{r.name}</span>
                </label>
              </li>
            ))}
          </ul>
          {recipients.length > LIST_CAP && (
            <p className="text-2xs text-ink-500">{t('listCapped', { n: recipients.length - LIST_CAP })}</p>
          )}
        </div>
      )}
      <p className="font-semibold">✍️ {t('compose')}</p>
      <textarea
        className="input h-36 py-2"
        value={body}
        maxLength={4096}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t('bodyPlaceholder')}
        data-testid="broadcast-body"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-secondary cursor-pointer px-3 text-sm">
          📎 {t('attach')}
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
            data-testid="broadcast-file"
          />
        </label>
        {busy > 0 && <span className="text-xs text-ink-500">⏳ {t('uploading')}</span>}
        {files.map((f) => (
          <span key={f.id} className="chip chip-neutral max-w-[12rem] truncate">
            {f.name}
          </span>
        ))}
      </div>
      <p className="text-2xs text-ink-500">{t('stickerNote')}</p>
      <button
        type="button"
        className="btn-primary w-full"
        disabled={pending || busy > 0 || count === 0 || (!body.trim() && files.length === 0)}
        onClick={() => void send()}
        data-testid="broadcast-send"
      >
        {pending ? '…' : `📣 ${t('send', { n: count })}`}
      </button>
      {result && (
        <p role="status" className="text-sm font-semibold" data-testid="broadcast-result">
          {result}
        </p>
      )}
    </section>
  );
}
