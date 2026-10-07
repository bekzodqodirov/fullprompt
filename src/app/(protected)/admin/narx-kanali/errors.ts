/**
 * The panel's refusal codes — the actions' `error` union and the i18n anchor
 * (`priceChannel.error.<code>`, pinned by price-channel-i18n.test.ts). Its own
 * file because a 'use server' module may export only async functions.
 */
export const CHANNEL_ERRORS = [
  'not_found',
  'bot_not_admin',
  'no_invite_right',
  'not_failed',
  'no_bot',
  'telegram',
  'public',
  'has_members',
  'vet_failed',
  'already_connected',
] as const;
export type ChannelError = (typeof CHANNEL_ERRORS)[number];
