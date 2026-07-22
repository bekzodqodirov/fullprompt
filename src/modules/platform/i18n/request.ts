import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { getSessionUser } from '../auth/session';

export const LOCALES = ['ru', 'uz', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ru';

/**
 * Locale resolution (no locale URLs — the app lives behind a login):
 * logged-in user's stored locale → `gsr_locale` cookie (login screen) → ru.
 */
export default getRequestConfig(async () => {
  let locale: string = DEFAULT_LOCALE;
  try {
    const user = await getSessionUser();
    if (user && (LOCALES as readonly string[]).includes(user.locale)) {
      locale = user.locale;
    } else {
      const cookieLocale = (await cookies()).get('gsr_locale')?.value;
      if (cookieLocale && (LOCALES as readonly string[]).includes(cookieLocale)) {
        locale = cookieLocale;
      }
    }
  } catch {
    // During static rendering there is no request context; fall back.
  }

  return {
    locale,
    messages: (await import(`../../../../messages/${locale}.json`)).default,
  };
});
