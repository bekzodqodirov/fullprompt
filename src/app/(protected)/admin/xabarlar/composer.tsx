'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { compressPhoto } from '@/components/compress-photo';
import type { Audience } from '@/modules/platform/broadcast/service';
import { sendBroadcastAction } from './actions';

/**
 * The message itself: words and up to ten files, sent to the audience the
 * page drew above. Files are uploaded as they are picked, pre-bound to the
 * broadcast's own id minted here (#180's pattern), so «Yuborish» only
 * freezes the rows. The press asks once, naming the count — a message to
 * three hundred customers cannot be taken back.
 */
export function BroadcastComposer({ audience, count }: { audience: Audience; count: number }) {
  const t = useTranslations('broadcast');
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
    if (!window.confirm(t('confirm', { n: count }))) return;
    setPending(true);
    try {
      const res = await sendBroadcastAction({ id, body, audience });
      if (res.ok) {
        setResult(t('queued', { n: res.total ?? count }));
        setBody('');
        setFiles([]);
        setId(crypto.randomUUID());
      } else {
        setResult(errorText[res.error ?? 'validation']);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-2 !p-3" data-testid="broadcast-composer">
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
