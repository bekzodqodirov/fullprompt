/**
 * The languages the app speaks — and nothing else.
 *
 * A leaf on purpose. These three constants live apart from `request.ts`
 * because that file imports `next/headers`, and anything that reaches it —
 * even for a single `DEFAULT_LOCALE` — drags a server-only module into the
 * client bundle. The Mini App's dictionary did exactly that: it typechecked,
 * it ran in dev, and the production build refused it. Import locales from
 * here; import the request config only from server code.
 */
export const LOCALES = ['ru', 'uz', 'zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ru';
