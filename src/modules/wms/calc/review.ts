import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { settings } from '@/modules/platform/db/schema';
import { notifyStaffTelegram } from '@/modules/platform/notifications/staff';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import { logger } from '@/modules/platform/logger';
import { BAZA_STALE_DAYS, staleDictionaryCounts } from './dictionaries';

/** `YYYY-MM` in the office's zone — the month a reminder belongs to. */
export function reviewMonth(now: Date, timeZone = 'Asia/Tashkent'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

const CLAIM_KEY = 'calc_review_notified_month';

/**
 * Claim this month for the review reminder — atomically, in one statement.
 *
 * The sweep runs every morning and must speak once a month, so «read the
 * setting, compare, write it» is a race between two boss processes on the
 * same minute: both read last month, both send. The `WHERE` on the conflict
 * clause makes the UPDATE itself the claim (0082's rule), and `RETURNING`
 * says who won — a loser gets no row and stays silent.
 *
 * `settings.value` is jsonb, so the month is compared as a JSON string on
 * both sides or a `text = jsonb` comparison refuses outright.
 */
export async function claimReviewMonth(month: string): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key: CLAIM_KEY, value: month, updatedBy: null })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: month, updatedAt: new Date() },
      setWhere: sql`${settings.value} IS DISTINCT FROM ${JSON.stringify(month)}::jsonb`,
    })
    .returning({ key: settings.key });
  return rows.length > 0;
}

/**
 * Once a month: «the dictionaries hold rows nobody has revisited».
 *
 * Sent ONLY when there is something to revisit. A reminder that arrives every
 * month whether or not anything is stale is a reminder people stop reading,
 * and the counts are the whole content of this message — so a zero count is
 * silence, and the month is not claimed either (nothing was announced, so
 * next week's sweep may still find something and speak).
 *
 * It goes to `ved.docs` holders: the dictionaries are theirs, and the
 * `/hisoblash/lugatlar` screen is the only place they can be edited.
 */
export async function notifyDictionaryReview(now = new Date()): Promise<number> {
  const counts = await staleDictionaryCounts();
  if (counts.total === 0) return 0;

  const month = reviewMonth(now);
  if (!(await claimReviewMonth(month))) return 0;

  const recipients = await usersWithPermission('ved.docs');
  if (recipients.length === 0) return 0;

  const text =
    `🧮 Lug'atlarni ko'rib chiqish vaqti keldi.\n` +
    `Baza: ${counts.bazas} · Stavka: ${counts.rates} · Narx: ${counts.prices}\n` +
    `Jami ${counts.total} ta yozuv ${BAZA_STALE_DAYS} kundan beri yangilanmagan.`;

  await notifyStaffTelegram({
    userIds: recipients,
    type: 'CalcDictReview',
    text,
  }).catch((err) => logger.error({ err }, '[calc] dictionary review notify failed'));

  return recipients.length;
}
