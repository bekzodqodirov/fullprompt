'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { changeLocaleAction } from '@/modules/platform/auth/actions';

const LOCALE_LABELS: Record<string, string> = {
  ru: 'РУ',
  uz: "O'Z",
  'zh-CN': '中文',
  en: 'EN',
};

export function LocaleSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onChange(locale: string) {
    const formData = new FormData();
    formData.set('locale', locale);
    startTransition(async () => {
      await changeLocaleAction(formData);
      router.refresh();
    });
  }

  // Borderless in the app bar: a full-height bordered field made the language
  // picker the loudest thing on every screen. It is still a native select, so
  // the phone opens its own wheel.
  return (
    <select
      aria-label="Language"
      className="h-11 cursor-pointer rounded-xl bg-transparent px-1.5 text-sm font-semibold text-ink-700 hover:bg-surface-sunken focus:outline-none disabled:opacity-50"
      value={current}
      disabled={pending}
      onChange={(e) => onChange(e.target.value)}
    >
      {Object.entries(LOCALE_LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
