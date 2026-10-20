/**
 * The staff group panel's refusal codes — the actions' `error` union and the
 * i18n anchor (`staffGroup.error.<code>`, pinned by staff-group-wire.test.ts).
 * Its own file because a 'use server' module may export only async functions.
 */
export const GROUP_ERRORS = [
  'not_found',
  'not_present',
  'telegram',
  'not_group',
  'cannot_post',
  'no_group',
  'already_posted',
  'bad_goal',
  'failed',
] as const;
export type GroupError = (typeof GROUP_ERRORS)[number];
