/**
 * The staff group's GIFs and photos (0134) — plain constants, imported by the
 * upload route, the access decision, the drain and the panel alike, so the
 * four can never disagree about what counts as one.
 *
 * They are ordinary `attachments` rows of this TYPE under one fixed entity id
 * (the group's files belong to no record), so the off-site copy and the
 * delete path need no new machinery.
 */

export const STAFF_GROUP_MEDIA_TYPE = 'staff_group_media';
export const STAFF_GROUP_MEDIA_ENTITY = '00000000-0000-4000-8000-0000000134a0';

/** What the group can play, and how Telegram is asked to carry it — nothing a browser would run. */
export const STAFF_GROUP_MEDIA_TYPES: Record<string, 'animation' | 'photo'> = {
  'image/gif': 'animation',
  'video/mp4': 'animation',
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
};

/** Telegram uploads by bytes up to 50 MB; a celebration GIF is a few. */
export const STAFF_GROUP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
