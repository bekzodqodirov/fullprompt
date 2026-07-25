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

  return (
    <select
      aria-label="Language"
      className="input !min-h-10 !w-auto text-sm"
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
