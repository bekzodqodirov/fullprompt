import { cookies } from 'next/headers';

export type Theme = 'light' | 'dark';
export const THEME_COOKIE = 'gsr_theme';

/**
 * The theme lives in a cookie, not in localStorage.
 *
 * A cookie is readable on the server, so the very first HTML already carries
 * `data-theme` — no white flash on a dark phone while JavaScript boots. With
 * no cookie set the CSS follows the system preference, so most people never
 * have to choose at all.
 */
export async function readTheme(): Promise<Theme | null> {
  const value = (await cookies()).get(THEME_COOKIE)?.value;
  return value === 'dark' || value === 'light' ? value : null;
}
