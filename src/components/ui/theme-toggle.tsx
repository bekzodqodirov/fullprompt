'use client';

import { useTransition } from 'react';
import { setThemeAction } from '@/modules/platform/theme/actions';
import type { Theme } from '@/modules/platform/theme/theme';

/**
 * Sun / moon.
 *
 * Two states, not three: "follow the system" is what you get before you ever
 * press it, and once you have an opinion the app should keep it rather than
 * change under you when the phone flips at sunset.
 */
export function ThemeToggle({ current }: { current: Theme | null }) {
  const [pending, start] = useTransition();
  const next: Theme = current === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label="theme"
      data-testid="theme-toggle"
      disabled={pending}
      onClick={() => start(async () => void (await setThemeAction(next)))}
      className="btn-ghost btn-icon text-ink-700"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        {current === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
          </>
        ) : (
          <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />
        )}
      </svg>
    </button>
  );
}
