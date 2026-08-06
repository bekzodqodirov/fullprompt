'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The upload, posted straight to a route handler (#291 — an APK is
 * megabytes), naming WHICH refusal it hit: "not an APK" sends the owner to
 * a different place than "too big".
 */
const MESSAGES: Record<string, string> = {
  not_apk: 'Bu fayl APK emas. GitHub Actions’dan olingan .apk faylni tanlang.',
  too_large: 'Fayl juda katta (150 MB dan oshdi).',
  empty: 'Fayl bo‘sh.',
  no_file: 'Fayl tanlanmagan.',
  forbidden: 'Sizda bu amal uchun ruxsat yo‘q.',
};

export function PublishForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/calls-app', { method: 'POST', body: form });
      const body = (await res.json()) as { ok?: boolean; version?: string; error?: string };
      if (res.ok && body.ok) {
        setDone(body.version ?? '');
        router.refresh();
      } else {
        setError(body.error ?? 'error');
      }
    } catch {
      setError('network');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h2 className="font-semibold">Yangi versiya chiqarish</h2>
      <p className="text-xs text-ink-500">
        APK GitHub Actions → <b>calls-apk</b> ishidan yuklab olinadi, so&apos;ng shu yerga
        qo&apos;yiladi. Chiqarilgan zahoti hodimlar profilida yangi fayl turadi.
      </p>
      <div>
        <label className="label" htmlFor="calls-version">
          Versiya nomi
        </label>
        <input
          id="calls-version"
          name="version"
          className="input"
          placeholder="1.0"
          required
          maxLength={40}
        />
      </div>
      <div>
        <label className="label" htmlFor="calls-apk-file">
          APK fayl
        </label>
        <input
          id="calls-apk-file"
          name="apk"
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="input"
          required
        />
      </div>
      <button type="submit" className="btn-primary disabled:opacity-50" disabled={pending}>
        {pending ? 'Yuklanmoqda…' : 'Chiqarish'}
      </button>
      {done !== null && (
        <p className="rounded-lg bg-brand-50 p-2 text-sm font-semibold" data-testid="publish-done">
          ✅ Chiqarildi: {done}
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad" data-testid="publish-error">
          {MESSAGES[error] ?? `Xatolik: ${error}`}
        </p>
      )}
    </form>
  );
}
