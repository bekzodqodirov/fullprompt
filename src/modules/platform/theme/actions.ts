'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { THEME_COOKIE, type Theme } from './theme';

/** Remember the choice for a year; see theme.ts for why it is a cookie. */
export async function setThemeAction(theme: Theme) {
  const store = await cookies();
  store.set(THEME_COOKIE, theme, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  revalidatePath('/', 'layout');
}
